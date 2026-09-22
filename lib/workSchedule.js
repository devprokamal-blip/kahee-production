// lib/workSchedule.js
// Attendance A2 — THE resolver for "what was this employee expected to work on
// date X", and the derivation of worked / overtime-eligible MINUTES from an
// actual clock-in and clock-out.
//
// SCOPE LOCK (asserted by test): nothing here holds or computes money. No
// rate, multiplier or rupiah value. Attendance answers TIME; the FROZEN
// Payroll Core turns time into money.
//
// It COMPOSES, never duplicates:
//   day TYPE (holiday / rest / workday)  -> lib/dayClassification.js  [FROZEN]
//   business date + clock arithmetic     -> lib/businessTime.js
//   integer minutes                      -> lib/time.js               [FROZEN]
//
// RESOLUTION PRECEDENCE (documented, deterministic — see
// docs/ATTENDANCE_ARCHITECTURE.md):
//   1. DATE OVERRIDE for the employee            (explicit, audited, with reason)
//   2. DATE OVERRIDE for their pattern
//   3. EMPLOYEE-SPECIFIC DATE ROSTER row
//   4. PATTERN DATE ROSTER row (DATE_BASED_ROSTER)
//   5. ROTATING_CYCLE day, from cycle_start_date (never guessed)
//   6. FIXED_WEEKLY / CUSTOM_WEEKLY weekday row
//   7. LEGACY fallback: the payroll work_pattern's weekly_rest_day
// Layers 1-6 decide WORK/OFF and which shift applies. The day TYPE always
// comes from the canonical classifier, so a public holiday stays a public
// holiday even when an override says someone must work it — an override can
// never silently reduce a holiday multiplier.

const { classifyDay, CLASSIFICATION_STATUS, DAY_TYPE } = require('./dayClassification');
const bt = require('./businessTime');

const DAY_STATUS = { WORK: 'WORK', OFF: 'OFF' };
const PATTERN_TYPES = ['FIXED_WEEKLY', 'CUSTOM_WEEKLY', 'ROTATING_CYCLE', 'DATE_BASED_ROSTER'];
const OT_RULES = ['AFTER_SHIFT_END', 'AFTER_DELAY', 'FIXED_TIME', 'NOT_ELIGIBLE'];

const SOURCE = {
  DATE_OVERRIDE_EMPLOYEE: 'date_override:employee',
  DATE_OVERRIDE_PATTERN: 'date_override:pattern',
  ROSTER_EMPLOYEE: 'roster_date:employee',
  ROSTER_PATTERN: 'roster_date:pattern',
  ROTATING_CYCLE: 'pattern:rotating_cycle',
  WEEKLY: 'pattern:weekly',
  LEGACY_WORK_PATTERN: 'legacy:work_pattern',
  NO_PATTERN: 'none',
};

/** A tiny per-request cache so a 1,500-employee sweep is not 1,500 x N queries. */
function makeCache() { return { schedules: new Map(), patterns: new Map(), patternDays: new Map(), breaks: new Map() }; }

async function getSchedule(db, id, cache) {
  if (id === null || id === undefined) return null;
  if (cache && cache.schedules.has(id)) return cache.schedules.get(id);
  const row = await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(id) || null;
  if (cache) cache.schedules.set(id, row);
  return row;
}
async function getBreaks(db, scheduleId, cache) {
  if (!scheduleId) return [];
  if (cache && cache.breaks.has(scheduleId)) return cache.breaks.get(scheduleId);
  const rows = await db.prepare('SELECT * FROM work_schedule_breaks WHERE work_schedule_id = ? AND is_active = 1 ORDER BY sequence, id')
    .all(scheduleId);
  if (cache) cache.breaks.set(scheduleId, rows);
  return rows;
}
async function getPattern(db, id, cache) {
  if (!id) return null;
  if (cache && cache.patterns.has(id)) return cache.patterns.get(id);
  const row = await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(id) || null;
  if (cache) cache.patterns.set(id, row);
  return row;
}
async function getPatternDays(db, patternId, cache) {
  if (!patternId) return [];
  if (cache && cache.patternDays.has(patternId)) return cache.patternDays.get(patternId);
  const rows = await db.prepare('SELECT * FROM attendance_pattern_days WHERE pattern_id = ? ORDER BY day_index').all(patternId);
  if (cache) cache.patternDays.set(patternId, rows);
  return rows;
}

/**
 * The attendance assignment in force ON the work date. Effective-dated, never
 * "latest row": January's configuration must not re-interpret December.
 * More than one match is AMBIGUOUS and is reported, never silently resolved.
 */
async function getAssignmentOn(db, employeeId, date) {
  const rows = await db.prepare(`
    SELECT * FROM attendance_schedule_assignments
    WHERE employee_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC
  `).all(employeeId, date, date);
  if (rows.length > 1) {
    const top = rows[0].effective_from;
    if (rows.filter((r) => r.effective_from === top).length > 1) return { ambiguous: true, rows };
  }
  return { ambiguous: false, row: rows[0] || null };
}

/** Which slot of a rotating cycle does this date fall on? Requires an anchor. */
function cycleDayIndex(pattern, date) {
  if (!pattern.cycle_start_date || !pattern.cycle_length_days) return null;
  const delta = bt.daysBetween(pattern.cycle_start_date, date);
  if (delta < 0 && !pattern.repeats) return null;
  const len = Number(pattern.cycle_length_days);
  if (!pattern.repeats && delta >= len) return null;
  return ((delta % len) + len) % len + 1;   // 1-based slot, works for dates before the anchor too
}

/** Resolved overtime eligibility time for a schedule (HH:MM or null). */
function overtimeEligibleFrom(schedule) {
  if (!schedule) return null;
  switch (schedule.overtime_eligibility_rule) {
    case 'NOT_ELIGIBLE': return null;
    case 'FIXED_TIME': return schedule.overtime_eligible_from || schedule.clock_out;
    case 'AFTER_DELAY':
      return bt.minutesToTime(bt.timeToMinutes(schedule.clock_out) + Number(schedule.overtime_delay_minutes || 0));
    case 'AFTER_SHIFT_END':
    default: return schedule.clock_out;
  }
}

function breakTotals(breaks) {
  let paid = 0, unpaid = 0;
  for (const b of breaks) {
    const d = Number(b.duration_minutes) || 0;
    if (b.is_paid) paid += d; else unpaid += d;
  }
  return { paid, unpaid };
}

/**
 * Resolve the expected schedule for one employee on one date.
 *
 * @returns {{
 *  date, employeeId, dayStatus, dayType, dayTypeSource, source, assignment,
 *  pattern, schedule, breaks, scheduledMinutes, breakMinutesPaid,
 *  breakMinutesUnpaid, overtimeEligibleFrom, crossMidnight, status, reason,
 *  warnings: string[] }}
 * `status` is OK, or a named problem (NO_ASSIGNMENT, AMBIGUOUS_ASSIGNMENT,
 * MISSING_CYCLE_ANCHOR, MISSING_SCHEDULE, ...). Ambiguity is flagged, never guessed.
 */
async function resolveSchedule(db, employeeId, date, { cache = null, classification = null } = {}) {
  const out = {
    date, employeeId, dayStatus: null, dayType: null, dayTypeSource: null, source: SOURCE.NO_PATTERN,
    assignment: null, pattern: null, schedule: null, breaks: [],
    scheduledMinutes: null, breakMinutesPaid: 0, breakMinutesUnpaid: 0,
    overtimeEligibleFrom: null, crossMidnight: false,
    status: 'OK', reason: null, warnings: [],
  };

  // Day TYPE always comes from the canonical (frozen) classifier.
  const cls = classification || await classifyDay(db, employeeId, date);
  out.dayType = cls.status === CLASSIFICATION_STATUS.OK ? cls.dayType : null;
  out.dayTypeSource = cls.status === CLASSIFICATION_STATUS.OK ? cls.source : cls.status;
  const isHoliday = out.dayType && out.dayType !== DAY_TYPE.WORKDAY && out.dayType !== DAY_TYPE.WEEKLY_REST_DAY;

  const asg = await getAssignmentOn(db, employeeId, date);
  if (asg.ambiguous) {
    out.status = 'AMBIGUOUS_ASSIGNMENT';
    out.reason = 'Lebih dari satu penugasan jadwal berlaku pada tanggal ini.';
    return out;
  }
  out.assignment = asg.row;
  const pattern = asg.row ? await getPattern(db, asg.row.pattern_id, cache) : null;
  out.pattern = pattern;

  let dayStatus = null, scheduleId = null, source = null;

  // 1 & 2 — explicit date override (employee first, then pattern).
  const ovEmp = await db.prepare(`SELECT * FROM attendance_date_overrides
     WHERE employee_id = ? AND work_date = ? AND is_active = 1`).get(employeeId, date);
  const ovPat = (!ovEmp && pattern) ? await db.prepare(`SELECT * FROM attendance_date_overrides
     WHERE employee_id IS NULL AND pattern_id = ? AND work_date = ? AND is_active = 1`).get(pattern.id, date) : null;
  const override = ovEmp || ovPat;
  if (override) {
    dayStatus = override.override_status;
    scheduleId = override.work_schedule_id;
    source = ovEmp ? SOURCE.DATE_OVERRIDE_EMPLOYEE : SOURCE.DATE_OVERRIDE_PATTERN;
    out.overrideReason = override.reason;
  }

  // 3 & 4 — explicit roster date (employee row first, then the pattern's roster).
  if (!dayStatus) {
    const rEmp = await db.prepare('SELECT * FROM attendance_roster_dates WHERE employee_id = ? AND work_date = ?').get(employeeId, date);
    const rPat = (!rEmp && pattern) ? await db.prepare('SELECT * FROM attendance_roster_dates WHERE pattern_id = ? AND work_date = ?').get(pattern.id, date) : null;
    const roster = rEmp || rPat;
    if (roster) {
      dayStatus = roster.day_status;
      scheduleId = roster.work_schedule_id;
      source = rEmp ? SOURCE.ROSTER_EMPLOYEE : SOURCE.ROSTER_PATTERN;
    }
  }

  // 5 & 6 — the pattern itself.
  if (!dayStatus && pattern) {
    if (pattern.pattern_type === 'ROTATING_CYCLE') {
      const idx = cycleDayIndex(pattern, date);
      if (idx === null) {
        out.status = 'MISSING_CYCLE_ANCHOR';
        out.reason = 'Roster berputar tidak memiliki cycle_start_date/cycle_length yang berlaku untuk tanggal ini.';
        return out;
      }
      const day = (await getPatternDays(db, pattern.id, cache)).find((d) => d.day_index === idx);
      if (!day) {
        out.status = 'MISSING_CYCLE_DAY';
        out.reason = `Hari siklus ${idx} belum dikonfigurasi pada pola ${pattern.code}.`;
        return out;
      }
      out.cycleDayIndex = idx;
      dayStatus = day.day_status; scheduleId = day.work_schedule_id; source = SOURCE.ROTATING_CYCLE;
    } else if (pattern.pattern_type === 'DATE_BASED_ROSTER') {
      // No roster row for this date: the roster says nothing, so the day is OFF
      // rather than silently becoming a workday.
      dayStatus = DAY_STATUS.OFF; source = SOURCE.ROSTER_PATTERN;
      out.warnings.push('DATE_BASED_ROSTER tanpa baris untuk tanggal ini — diperlakukan sebagai OFF.');
    } else {
      const idx = bt.isoWeekday(date);
      const day = (await getPatternDays(db, pattern.id, cache)).find((d) => d.day_index === idx);
      if (!day) {
        out.status = 'MISSING_PATTERN_DAY';
        out.reason = `Hari ${bt.weekdayName(date)} belum dikonfigurasi pada pola ${pattern.code}.`;
        return out;
      }
      dayStatus = day.day_status; scheduleId = day.work_schedule_id; source = SOURCE.WEEKLY;
    }
  }

  // 7 — legacy fallback: no A2 assignment, so the payroll work pattern's single
  // weekly rest day is all that is configured. Still deterministic.
  if (!dayStatus) {
    if (cls.status !== CLASSIFICATION_STATUS.OK) {
      out.status = 'NO_ASSIGNMENT';
      out.reason = 'Belum ada penugasan jadwal A2 dan klasifikasi hari kanonik gagal.';
      return out;
    }
    dayStatus = cls.dayType === DAY_TYPE.WORKDAY ? DAY_STATUS.WORK : DAY_STATUS.OFF;
    source = SOURCE.LEGACY_WORK_PATTERN;
  }

  // Which shift applies: the day's own schedule > the assignment default >
  // the pattern default.
  if (!scheduleId && asg.row) scheduleId = asg.row.work_schedule_id;
  if (!scheduleId && pattern) scheduleId = pattern.default_schedule_id;
  const schedule = await getSchedule(db, scheduleId, cache);

  out.dayStatus = dayStatus;
  out.source = source;
  out.schedule = schedule;

  if (dayStatus === DAY_STATUS.WORK && !schedule) {
    out.status = 'MISSING_SCHEDULE';
    out.reason = 'Hari kerja tanpa jadwal/shift yang bisa ditentukan.';
    return out;
  }
  if (schedule) {
    if (schedule.status !== 'ACTIVE') out.warnings.push(`Jadwal ${schedule.code} berstatus ${schedule.status}.`);
    if (schedule.effective_from > date || (schedule.effective_to && schedule.effective_to < date)) {
      out.warnings.push(`Jadwal ${schedule.code} tidak berlaku pada ${date}.`);
    }
    out.breaks = await getBreaks(db, schedule.id, cache);
    const tot = breakTotals(out.breaks);
    out.breakMinutesPaid = tot.paid;
    out.breakMinutesUnpaid = tot.unpaid;
    out.scheduledMinutes = Number(schedule.standard_work_minutes);
    out.crossMidnight = !!schedule.cross_midnight;
    out.overtimeEligibleFrom = overtimeEligibleFrom(schedule);

    // Honest cross-check: the configured standard minutes should equal
    // shift span minus unpaid breaks. A mismatch is reported, never corrected.
    const span = bt.elapsedMinutes(schedule.clock_in, schedule.clock_out, { crossMidnight: !!schedule.cross_midnight });
    if (span !== null && span - tot.unpaid !== out.scheduledMinutes) {
      out.warnings.push(`standard_work_minutes (${out.scheduledMinutes}) != rentang shift ${span} - istirahat tanpa upah ${tot.unpaid}.`);
    }
  } else {
    out.scheduledMinutes = 0;
  }

  // A holiday stays a holiday even when the roster says WORK. The day TYPE
  // (and therefore the payroll band) is never softened by attendance config.
  if (isHoliday) out.warnings.push(`Tanggal ini ${out.dayType}; status roster = ${dayStatus}.`);
  else if (out.dayType) {
    const expected = dayStatus === DAY_STATUS.WORK ? DAY_TYPE.WORKDAY : DAY_TYPE.WEEKLY_REST_DAY;
    out.dayType = expected;
    out.dayTypeSource = `${out.dayTypeSource} + ${source}`;
  }

  // Payroll band cross-check: overtime_multiplier_rules split rest/holiday by
  // the PAYROLL work pattern's days_per_week. A custom A2 pattern whose real
  // working-days-per-week differs is a configuration mismatch worth surfacing.
  if (pattern && ['FIXED_WEEKLY', 'CUSTOM_WEEKLY'].includes(pattern.pattern_type) && cls.daysPerWeek) {
    const workDays = (await getPatternDays(db, pattern.id, cache)).filter((d) => d.day_status === DAY_STATUS.WORK).length;
    if (workDays && workDays !== cls.daysPerWeek) {
      out.warnings.push(`Pola A2 ${workDays} hari kerja/minggu vs work_patterns.days_per_week = ${cls.daysPerWeek} (band lembur payroll memakai yang terakhir).`);
    }
  }
  return out;
}

/**
 * Derive worked minutes from an ACTUAL clock-in/out against a resolved
 * schedule. Integer minutes only.
 *
 * Deliberately does NOT turn a late clock-out into overtime: it reports how
 * many minutes fall past the eligibility boundary
 * (`workedAfterShiftMinutes`), and the A1 request/approval workflow decides
 * what, if anything, becomes payable.
 */
function deriveWorkedMinutes(resolved, { clockIn, clockOut, clockOutDate = null, workDate = null }) {
  const res = {
    elapsedMinutes: null, workedMinutes: null, breakMinutesUnpaid: resolved ? resolved.breakMinutesUnpaid : 0,
    breakMinutesPaid: resolved ? resolved.breakMinutesPaid : 0,
    lateMinutes: null, earlyLeaveMinutes: null, workedAfterShiftMinutes: 0,
    clockOutDate: clockOutDate, crossedMidnight: false, error: null,
  };
  if (!clockIn || !clockOut) return res;
  if (!bt.isValidTime(clockIn) || !bt.isValidTime(clockOut)) { res.error = 'INVALID_CLOCK_TIME'; return res; }

  let dayOffset = null;
  if (clockOutDate && workDate) {
    dayOffset = bt.daysBetween(workDate, clockOutDate);
    if (dayOffset < 0) { res.error = 'CLOCK_OUT_BEFORE_WORK_DATE'; return res; }
    if (dayOffset > 1) { res.error = 'CLOCK_OUT_TOO_FAR'; return res; }
  }
  const crossAllowed = !!(resolved && resolved.crossMidnight);
  const elapsed = bt.elapsedMinutes(clockIn, clockOut, { crossMidnight: crossAllowed, dayOffset });
  if (elapsed === null) { res.error = 'NEGATIVE_DURATION'; return res; }
  res.elapsedMinutes = elapsed;
  res.crossedMidnight = dayOffset === null ? (crossAllowed && bt.timeToMinutes(clockOut) <= bt.timeToMinutes(clockIn)) : dayOffset === 1;
  if (res.crossedMidnight && workDate && !res.clockOutDate) res.clockOutDate = bt.addDays(workDate, 1);

  // Unpaid breaks are deducted; paid breaks are not. Both come from
  // configuration — no break duration is hardcoded anywhere.
  res.workedMinutes = Math.max(elapsed - res.breakMinutesUnpaid, 0);

  if (resolved && resolved.schedule) {
    const s = resolved.schedule;
    const schedStart = bt.timeToMinutes(s.clock_in);
    const actualStart = bt.timeToMinutes(clockIn);
    res.lateMinutes = Math.max(actualStart - schedStart, 0);

    const shiftSpan = bt.elapsedMinutes(s.clock_in, s.clock_out, { crossMidnight: !!s.cross_midnight });
    const actualEndFromStart = actualStart - schedStart + elapsed;   // minutes after scheduled start
    res.earlyLeaveMinutes = Math.max(shiftSpan - actualEndFromStart, 0);

    const otFrom = resolved.overtimeEligibleFrom;
    if (otFrom) {
      const otBoundary = bt.elapsedMinutes(s.clock_in, otFrom, { crossMidnight: true });
      res.workedAfterShiftMinutes = Math.max(actualEndFromStart - otBoundary, 0);
    }
  }
  return res;
}

/** The validated time contract handed to the payroll snapshot. No money. */
function payrollTimeContract(entry) {
  return {
    work_date: entry.work_date,
    day_type: entry.day_type,
    work_schedule_id: entry.work_schedule_id,
    schedule_code: entry.schedule_code,
    scheduled_minutes: entry.scheduled_minutes,
    work_minutes: entry.work_minutes,
    overtime_minutes_approved: entry.overtime_status === 'approved' ? entry.overtime_minutes_approved : 0,
  };
}

/** Snapshot of the resolved expectation, stored on the timesheet row. */
function toScheduleSnapshot(resolved) {
  const s = resolved.schedule;
  return {
    work_schedule_id: s ? s.id : null,
    work_pattern_def_id: resolved.pattern ? resolved.pattern.id : null,
    schedule_code: s ? s.code : null,
    scheduled_clock_in: s ? s.clock_in : null,
    scheduled_clock_out: s ? s.clock_out : null,
    scheduled_minutes: resolved.scheduledMinutes,
    schedule_cross_midnight: resolved.crossMidnight ? 1 : 0,
    break_minutes_unpaid: resolved.breakMinutesUnpaid,
    break_minutes_paid: resolved.breakMinutesPaid,
    day_status: resolved.dayStatus,
    schedule_source: resolved.source,
    overtime_eligible_from: resolved.overtimeEligibleFrom,
    schedule_snapshot: JSON.stringify({
      resolved_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      source: resolved.source,
      status: resolved.status,
      pattern: resolved.pattern ? {
        id: resolved.pattern.id, code: resolved.pattern.code, type: resolved.pattern.pattern_type,
        cycle_length_days: resolved.pattern.cycle_length_days, cycle_start_date: resolved.pattern.cycle_start_date,
        cycle_day_index: resolved.cycleDayIndex ?? null,
      } : null,
      schedule: s ? {
        id: s.id, code: s.code, clock_in: s.clock_in, clock_out: s.clock_out,
        standard_work_minutes: s.standard_work_minutes, cross_midnight: s.cross_midnight,
        overtime_eligibility_rule: s.overtime_eligibility_rule,
        overtime_delay_minutes: s.overtime_delay_minutes,
        effective_from: s.effective_from, effective_to: s.effective_to,
      } : null,
      breaks: resolved.breaks.map((b) => ({ name: b.name, start_time: b.start_time, end_time: b.end_time,
        duration_minutes: b.duration_minutes, is_paid: !!b.is_paid })),
      overtime_eligible_from: resolved.overtimeEligibleFrom,
      override_reason: resolved.overrideReason || null,
      warnings: resolved.warnings,
    }),
  };
}

module.exports = {
  DAY_STATUS, PATTERN_TYPES, OT_RULES, SOURCE,
  makeCache, resolveSchedule, deriveWorkedMinutes, toScheduleSnapshot,
  overtimeEligibleFrom, cycleDayIndex, getAssignmentOn, payrollTimeContract,
};
