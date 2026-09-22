// routes/timesheet.js
// Timesheet & Absensi: daily attendance per employee, linked to employees
// created in HRD & Kontrak. Overtime is requested and approved inline on the
// same row (see timesheet_entries.overtime_* columns).
//
// Attendance Hardening A1 (see docs/ATTENDANCE_ARCHITECTURE.md):
//  - every read and write is legal-entity scoped (Phase 2I authority);
//    foreign or absent records both answer 404;
//  - writes respect the payroll period cutoff and FROZEN payroll snapshots;
//  - the employee must be eligible ON THE WORK DATE (canonical eligibility);
//  - overtime decisions are terminal, require a pending request, and the
//    requester can never decide their own request (SoD, by user id);
//  - every write appends an attendance_events row (who / when / old / new).
// This module supplies validated TIME only. It never prices anything.

const express = require('express');
const { getDb, withTransaction } = require('../database/init-db');
const { requirePermission, hasPermission } = require('../middleware/permissions');
const { classifyDay, toSnapshot, CLASSIFICATION_STATUS } = require('../lib/dayClassification');
const { minutesToHours, resolveMinutes } = require('../lib/time');
const { STREAMS } = require('../lib/payrollPeriod');
const bt = require('../lib/businessTime');
const ws = require('../lib/workSchedule');
const entityScope = require('../lib/entityScope');
const g = require('../lib/attendanceGuard');

const router = express.Router();

// Reference list only (dropdown). Not a schedule; workfront master is a later phase.
const WORKFRONTS = ['Main Civil', 'Piling', 'Mechanical', 'Piping', 'Electrical', 'Instrumentation'];
const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'leave', 'sick', 'no_show'];
const MODULE = 'timesheet_absensi';

// A2: actual attendance may be recorded for today and (for a night shift that
// is entered in advance) tomorrow — never arbitrarily far into the future.
// Future SCHEDULE configuration is unrestricted; future ACTUALS are not.
const MAX_FUTURE_DAYS = 1;

// Schedule-resolution problems that are a CONFIGURATION defect: the roster is
// ambiguous or incomplete, so refusing is safer than recording an entry whose
// expectation nobody can reproduce. NO_ASSIGNMENT / MISSING_SCHEDULE are NOT
// here: an employee with no A2 configuration is still recordable (legacy path).
const BLOCKING_SCHEDULE_STATUS = ['AMBIGUOUS_ASSIGNMENT', 'MISSING_CYCLE_ANCHOR', 'MISSING_CYCLE_DAY', 'MISSING_PATTERN_DAY'];

/** Rebuild the expectation from the row's own SNAPSHOT, never from today's config. */
function snapshotResolved(entry) {
  if (!entry.work_schedule_id && !entry.scheduled_clock_in) return null;
  return {
    schedule: {
      id: entry.work_schedule_id, code: entry.schedule_code,
      clock_in: entry.scheduled_clock_in, clock_out: entry.scheduled_clock_out,
      cross_midnight: entry.schedule_cross_midnight ? 1 : 0,
    },
    breaks: [],
    breakMinutesUnpaid: Number(entry.break_minutes_unpaid || 0),
    breakMinutesPaid: Number(entry.break_minutes_paid || 0),
    crossMidnight: !!entry.schedule_cross_midnight,
    overtimeEligibleFrom: entry.overtime_eligible_from || null,
    scheduledMinutes: entry.scheduled_minutes,
  };
}

/**
 * Worked minutes: DERIVED from the actual clocks whenever a schedule (and so
 * the break rules) is known, because only then can elapsed time be turned into
 * worked time deterministically. Without a schedule the recorded figure is
 * used — there is nothing to derive break deductions from.
 */
function resolveWorkMinutes({ resolved, clockIn, clockOut, clockOutDate, workDate, suppliedMinutes }) {
  if (resolved && resolved.schedule && clockIn && clockOut) {
    const d = ws.deriveWorkedMinutes(resolved, { clockIn, clockOut, clockOutDate, workDate });
    if (d.error) throw new g.AttendanceError(400, d.error, `Jam kerja tidak dapat dihitung (${d.error}).`);
    return { minutes: d.workedMinutes, derived: d, ignoredSupplied: suppliedMinutes !== null && suppliedMinutes !== undefined && suppliedMinutes !== d.workedMinutes ? suppliedMinutes : null };
  }
  return { minutes: suppliedMinutes ?? null, derived: null, ignoredSupplied: null };
}

/** Run a handler with one db handle and uniform error mapping. */
function handle(fn) {
  return async (req, res, next) => {
    const db = getDb();
    try {
      await fn(req, res, db);
    } catch (raw) {
      const err = g.mapTriggerError(raw);
      if (err instanceof g.AttendanceError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      }
      if (err instanceof TypeError) {
        return res.status(400).json({ error: 'VALIDATION', message: err.message });
      }
      next(err); // EntityAccessError -> 404 via the global handler in server.js
    } finally {
      db.close();
    }
  };
}

/** Work minutes from the request: explicit integer minutes win, else hours. */
function minutesFromBody(b) {
  if (b.work_minutes !== undefined && b.work_minutes !== null && b.work_minutes !== '') {
    const n = Number(b.work_minutes);
    if (!Number.isInteger(n)) throw new g.AttendanceError(400, 'INVALID_WORK_MINUTES', 'work_minutes harus bilangan bulat.');
    return n;
  }
  return resolveMinutes(b, 'work_hours');
}

// ---- LIST + FILTER (defaults to today) -------------------------------------
router.get('/entries', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const { date, workfront, shift, status, search } = req.query;
  const workDate = date || bt.businessToday();
  const sc = await entityScope.scopeClause(db, req.userContext, 't.legal_entity_id', { resourceType: 'timesheet_entry', route: 'GET /api/timesheet/entries' });

  let sql = `
    SELECT t.*, e.full_name, e.worker_type, e.project_code
    FROM timesheet_entries t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.work_date = ? AND ${sc.sql}
  `;
  const params = [workDate, ...sc.params];
  if (workfront) { sql += ' AND t.workfront = ?'; params.push(workfront); }
  if (shift)     { sql += ' AND t.shift = ?';     params.push(shift); }
  if (status)    { sql += ' AND t.attendance_status = ?'; params.push(status); }
  if (search)    { sql += ' AND (e.full_name LIKE ? OR e.id LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY e.full_name ASC';
  res.json(await db.prepare(sql).all(...params));
}));

// ---- SUMMARY (KPI cards, for a given date) ---------------------------------
router.get('/entries/summary', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const workDate = req.query.date || bt.businessToday();
  const meta = { resourceType: 'timesheet_entry', route: 'GET /api/timesheet/entries/summary' };
  const scT = await entityScope.scopeClause(db, req.userContext, 't.legal_entity_id', meta);
  const scA = await entityScope.scopeClause(db, req.userContext, 'a.legal_entity_id', meta);

  // Active workforce = active employees whose assignment on that date is in scope.
  const totalActive = (await db.prepare(`
    SELECT COUNT(DISTINCT e.id) AS n FROM employees e
    JOIN employee_payroll_assignments a ON a.employee_id = e.id
     AND a.effective_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)
    WHERE e.status = 'active' AND ${scA.sql}`).get(workDate, workDate, ...scA.params)).n;
  const present = (await db.prepare(
    `SELECT COUNT(*) AS n FROM timesheet_entries t WHERE t.work_date = ? AND t.attendance_status IN ('present','late') AND ${scT.sql}`
  ).get(workDate, ...scT.params)).n;
  const recorded = (await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries t WHERE t.work_date = ? AND ${scT.sql}`)
    .get(workDate, ...scT.params)).n;
  const notRecorded = Math.max(totalActive - recorded, 0);
  // N1: sum integer MINUTES. Summing REAL hours drifts (0.1h x10 = 0.999...).
  const overtimeToday = await db.prepare(
    `SELECT COALESCE(SUM(t.overtime_minutes_approved),0) AS approved_minutes, COUNT(*) AS n
     FROM timesheet_entries t WHERE t.work_date = ? AND t.overtime_minutes_requested > 0 AND ${scT.sql}`
  ).get(workDate, ...scT.params);
  const pendingOvertime = (await db.prepare(
    `SELECT COUNT(*) AS n FROM timesheet_entries t WHERE t.overtime_status = 'pending' AND ${scT.sql}`
  ).get(...scT.params)).n;

  res.json({
    workDate,
    totalActive,
    present,
    notRecorded,
    overtimeCount: overtimeToday.n,
    overtimeApprovedMinutes: overtimeToday.approved_minutes,
    // Derived for display only; never fed back into a calculation.
    overtimeApprovedHours: minutesToHours(overtimeToday.approved_minutes),
    pendingOvertime,
    payrollReadyPct: recorded ? Math.round((present / recorded) * 1000) / 10 : 0,
  });
}));

// ---- OVERTIME: pending queue (for the approval panel) ----------------------
router.get('/overtime/pending', requirePermission(MODULE, 'APPROVE'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 't.legal_entity_id', { resourceType: 'timesheet_entry', route: 'GET /api/timesheet/overtime/pending' });
  const rows = await db.prepare(`
    SELECT t.*, e.full_name, e.position,
           (t.overtime_requested_by_user_id = ?) AS is_own_request
    FROM timesheet_entries t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.overtime_status = 'pending' AND ${sc.sql}
    ORDER BY t.work_date ASC
  `).all(req.userContext.id, ...sc.params);
  res.json(rows);
}));

// ---- CREATE a day's entry (one row per employee per day) ------------------
router.post('/entries', requirePermission(MODULE, 'CREATE'), handle(async (req, res, db) => {
  const b = req.body || {};
  if (!b.employee_id || !b.work_date) {
    return res.status(400).json({ error: 'VALIDATION', message: 'employee_id dan work_date wajib diisi.' });
  }
  if (!g.isValidDate(b.work_date)) {
    return res.status(400).json({ error: 'INVALID_DATE', message: 'work_date harus tanggal valid YYYY-MM-DD.' });
  }
  const attendanceStatus = b.attendance_status || 'present';
  if (!ATTENDANCE_STATUSES.includes(attendanceStatus)) {
    return res.status(400).json({ error: 'INVALID_ATTENDANCE_STATUS', message: 'attendance_status tidak dikenal.' });
  }
  const suppliedMinutes = minutesFromBody(b);
  g.assertMinutes(suppliedMinutes);
  if (b.clock_in && !bt.isValidTime(b.clock_in)) return res.status(400).json({ error: 'INVALID_TIME', message: 'clock_in harus HH:MM.' });
  if (b.clock_out && !bt.isValidTime(b.clock_out)) return res.status(400).json({ error: 'INVALID_TIME', message: 'clock_out harus HH:MM.' });
  if (b.clock_out_date && !g.isValidDate(b.clock_out_date)) return res.status(400).json({ error: 'INVALID_DATE', message: 'clock_out_date harus YYYY-MM-DD.' });
  // A2: actual attendance is not recordable arbitrarily far ahead. Business
  // timezone, not UTC — see lib/businessTime.js.
  const maxDate = bt.addDays(bt.businessToday(), MAX_FUTURE_DAYS);
  if (b.work_date > maxDate) {
    return res.status(409).json({ error: 'ATTENDANCE_DATE_IN_FUTURE',
      message: `Absensi aktual tidak dapat dicatat untuk tanggal setelah ${maxDate}.`, detail: { max_date: maxDate, business_today: bt.businessToday() } });
  }

  // Order matters: scope BEFORE anything that could disclose the employee.
  const route = 'POST /api/timesheet/entries';
  await g.assertEmployeeInScope(db, req.userContext, b.employee_id, b.work_date, route);
  const elig = await g.assertEligible(db, b.employee_id, b.work_date);
  const writable = await g.assertStreamWritable(db, b.employee_id, b.work_date, STREAMS.ATTENDANCE);

  const existing = await db.prepare('SELECT id FROM timesheet_entries WHERE employee_id = ? AND work_date = ?')
    .get(b.employee_id, b.work_date);
  if (existing) {
    return res.status(409).json({ error: 'DUPLICATE', message: 'Sudah ada catatan absensi untuk karyawan & tanggal ini. Gunakan Edit.' });
  }

  // Phase 1B / B2: the day type is DERIVED server-side from the calendar,
  // never accepted from the client. Any day_type / multiplier / source /
  // *_user_id field in req.body is deliberately ignored.
  const classification = await classifyDay(db, b.employee_id, b.work_date);
  const snapshot = toSnapshot(classification);

  // A2: resolve the EXPECTED schedule (pattern -> shift -> breaks -> OT
  // boundary) and snapshot it on the row, so a later configuration change
  // cannot re-interpret this day.
  const resolved = await ws.resolveSchedule(db, b.employee_id, b.work_date, { classification });
  if (BLOCKING_SCHEDULE_STATUS.includes(resolved.status)) {
    throw new g.AttendanceError(409, 'SCHEDULE_NOT_RESOLVED',
      `Jadwal kerja untuk ${b.work_date} tidak dapat ditentukan (${resolved.status}). ${resolved.reason || ''}`.trim(),
      { status: resolved.status });
  }
  const scheduleSnapshot = ws.toScheduleSnapshot(resolved);
  // The A2 pattern decides WORK/OFF; a holiday from the canonical calendar
  // still outranks it, so day_type is only tightened, never softened.
  if (resolved.dayType) {
    snapshot.day_type = resolved.dayType;
    snapshot.day_type_source = resolved.dayTypeSource;
  }
  const wm = resolveWorkMinutes({ resolved, clockIn: b.clock_in, clockOut: b.clock_out,
    clockOutDate: b.clock_out_date || null, workDate: b.work_date, suppliedMinutes });
  const workMinutes = wm.minutes;
  g.assertMinutes(workMinutes);

  const row = {
    ...snapshot,
    ...scheduleSnapshot,
    clock_out_date: (wm.derived && wm.derived.clockOutDate) || b.clock_out_date || null,
    elapsed_minutes: wm.derived ? wm.derived.elapsedMinutes : null,
    late_minutes: wm.derived ? wm.derived.lateMinutes : null,
    early_leave_minutes: wm.derived ? wm.derived.earlyLeaveMinutes : null,
    worked_after_shift_minutes: wm.derived ? wm.derived.workedAfterShiftMinutes : null,
    employee_id: b.employee_id,
    work_date: b.work_date,
    workfront: b.workfront || null,
    shift: b.shift || null,
    clock_in: b.clock_in || null,
    clock_out: b.clock_out || null,
    // N1: minutes are canonical; hours are a human-readable mirror.
    work_minutes: workMinutes,
    work_hours: minutesToHours(workMinutes),
    attendance_status: attendanceStatus,
    absence_reason: b.absence_reason || null,
    note: b.note || null,
    recorded_by: req.userContext.displayName,
    recorded_by_user_id: req.userContext.id,
    legal_entity_id: elig.assignment.legal_entity_id,
    entry_source: 'MANUAL',
  };

  const id = await withTransaction(db, async () => {
    const info = await db.prepare(`
      INSERT INTO timesheet_entries (
        employee_id, work_date, workfront, shift, clock_in, clock_out, work_hours, work_minutes,
        attendance_status, absence_reason, note, recorded_by, recorded_by_user_id, legal_entity_id, entry_source,
        day_type, day_type_source, day_type_calendar_id, day_type_pattern_id, day_classified_at,
        work_schedule_id, work_pattern_def_id, schedule_code, scheduled_clock_in, scheduled_clock_out,
        scheduled_minutes, schedule_cross_midnight, break_minutes_unpaid, break_minutes_paid,
        day_status, schedule_source, overtime_eligible_from, schedule_snapshot,
        clock_out_date, elapsed_minutes, late_minutes, early_leave_minutes, worked_after_shift_minutes
      ) VALUES (
        @employee_id, @work_date, @workfront, @shift, @clock_in, @clock_out, @work_hours, @work_minutes,
        @attendance_status, @absence_reason, @note, @recorded_by, @recorded_by_user_id, @legal_entity_id, @entry_source,
        @day_type, @day_type_source, @day_type_calendar_id, @day_type_pattern_id, @day_classified_at,
        @work_schedule_id, @work_pattern_def_id, @schedule_code, @scheduled_clock_in, @scheduled_clock_out,
        @scheduled_minutes, @schedule_cross_midnight, @break_minutes_unpaid, @break_minutes_paid,
        @day_status, @schedule_source, @overtime_eligible_from, @schedule_snapshot,
        @clock_out_date, @elapsed_minutes, @late_minutes, @early_leave_minutes, @worked_after_shift_minutes
      ) RETURNING id
    `).run(row);
    const newId = Number(info.lastInsertRowid);
    await g.recordEvent(db, { entry: { ...row, id: newId }, eventType: g.EVENT_TYPES.ENTRY_CREATED, userContext: req.userContext, newValues: row });
    return newId;
  });

  res.status(201).json({
    id,
    day_type: snapshot.day_type,
    day_status: resolved.dayStatus,
    schedule_code: scheduleSnapshot.schedule_code,
    scheduled_minutes: scheduleSnapshot.scheduled_minutes,
    work_minutes: workMinutes,
    work_minutes_derived_from_clock: !!wm.derived,
    supplied_work_minutes_ignored: wm.ignoredSupplied,
    overtime_eligible_from: scheduleSnapshot.overtime_eligible_from,
    worked_after_shift_minutes: wm.derived ? wm.derived.workedAfterShiftMinutes : null,
    schedule_status: resolved.status,
    schedule_warnings: resolved.warnings,
    // A null day_type means the calendar configuration needs fixing before
    // overtime can be requested on this row.
    day_classification_status: classification.status,
    day_classification_reason: classification.reason,
    period_status: writable.period_status,
  });
}));

// ---- UPDATE an existing entry ------------------------------------------------
// Payroll-relevant fields (status, clock, shift, minutes) are locked once an
// overtime decision is terminal: a generic edit must never invalidate an
// approval or rejection. Metadata (workfront, note, absence reason) stays
// editable while the period is open. Full correction workflow = later phase.
router.put('/entries/:id', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const b = req.body || {};
  const existing = await g.loadEntryInScope(db, req.userContext, req.params.id, 'PUT /api/timesheet/entries/:id');

  const fields = ['workfront', 'shift', 'clock_in', 'clock_out', 'attendance_status', 'absence_reason', 'note'];
  const next = {};
  fields.forEach((f) => {
    if (b[f] === undefined) next[f] = existing[f];
    else if (b[f] === '') next[f] = null;
    else next[f] = b[f];
  });
  if (!next.attendance_status || !ATTENDANCE_STATUSES.includes(next.attendance_status)) {
    return res.status(400).json({ error: 'INVALID_ATTENDANCE_STATUS', message: 'attendance_status tidak dikenal.' });
  }
  if (next.clock_in && !bt.isValidTime(next.clock_in)) return res.status(400).json({ error: 'INVALID_TIME', message: 'clock_in harus HH:MM.' });
  if (next.clock_out && !bt.isValidTime(next.clock_out)) return res.status(400).json({ error: 'INVALID_TIME', message: 'clock_out harus HH:MM.' });
  if (b.clock_out_date !== undefined && b.clock_out_date && !g.isValidDate(b.clock_out_date)) {
    return res.status(400).json({ error: 'INVALID_DATE', message: 'clock_out_date harus YYYY-MM-DD.' });
  }
  const clockOutDate = b.clock_out_date === undefined ? existing.clock_out_date : (b.clock_out_date || null);
  // A2: re-derive against the row's OWN snapshotted schedule, never against
  // today's configuration — a schedule change must not re-interpret history.
  const snapRes = snapshotResolved(existing);
  const suppliedUpdate = (b.work_hours !== undefined || b.work_minutes !== undefined) ? minutesFromBody(b) : existing.work_minutes;
  const wmUpd = resolveWorkMinutes({ resolved: snapRes, clockIn: next.clock_in, clockOut: next.clock_out,
    clockOutDate, workDate: existing.work_date, suppliedMinutes: suppliedUpdate });
  next.work_minutes = wmUpd.minutes;
  g.assertMinutes(next.work_minutes);
  next.clock_out_date = (wmUpd.derived && wmUpd.derived.clockOutDate) || clockOutDate || null;
  next.elapsed_minutes = wmUpd.derived ? wmUpd.derived.elapsedMinutes : existing.elapsed_minutes;
  next.late_minutes = wmUpd.derived ? wmUpd.derived.lateMinutes : existing.late_minutes;
  next.early_leave_minutes = wmUpd.derived ? wmUpd.derived.earlyLeaveMinutes : existing.early_leave_minutes;
  next.worked_after_shift_minutes = wmUpd.derived ? wmUpd.derived.workedAfterShiftMinutes : existing.worked_after_shift_minutes;

  const payrollFields = ['attendance_status', 'clock_in', 'clock_out', 'shift', 'work_minutes'];
  const changed = [...fields, 'work_minutes', 'clock_out_date'].filter((f) => (next[f] ?? null) !== (existing[f] ?? null));
  if (changed.length === 0) return res.json({ ok: true, changed: [] });

  const changedPayroll = changed.filter((f) => payrollFields.includes(f));
  if (changedPayroll.length && g.TERMINAL_OT.includes(existing.overtime_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_DECISION_LOCKED',
      `Lembur pada entri ini sudah ${existing.overtime_status}; jam/status kehadiran tidak dapat diubah lewat edit biasa.`,
      { locked_fields: changedPayroll });
  }
  if (existing.overtime_status === 'pending' && !g.WORKING_STATUSES.includes(next.attendance_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_PENDING',
      'Ada pengajuan lembur yang menunggu keputusan; status tidak dapat diubah menjadi tidak hadir.');
  }
  await g.assertEligible(db, existing.employee_id, existing.work_date);
  await g.assertStreamWritable(db, existing.employee_id, existing.work_date, STREAMS.ATTENDANCE);

  const oldValues = Object.fromEntries(changed.map((f) => [f, existing[f] ?? null]));
  const newValues = Object.fromEntries(changed.map((f) => [f, next[f] ?? null]));

  await withTransaction(db, async () => {
    await db.prepare(`UPDATE timesheet_entries SET
        workfront = @workfront, shift = @shift, clock_in = @clock_in, clock_out = @clock_out,
        attendance_status = @attendance_status, absence_reason = @absence_reason, note = @note,
        work_minutes = @work_minutes, work_hours = @work_hours, clock_out_date = @clock_out_date,
        elapsed_minutes = @elapsed_minutes, late_minutes = @late_minutes,
        early_leave_minutes = @early_leave_minutes, worked_after_shift_minutes = @worked_after_shift_minutes,
        updated_by_user_id = @uid, updated_at = kahe_now()
      WHERE id = @id`).run({
      ...next, work_hours: minutesToHours(next.work_minutes), uid: req.userContext.id, id: existing.id,
    });
    await g.recordEvent(db, { entry: existing, eventType: g.EVENT_TYPES.ENTRY_UPDATED, userContext: req.userContext, oldValues, newValues });
  });
  res.json({ ok: true, changed, work_minutes: next.work_minutes, work_minutes_derived_from_clock: !!wmUpd.derived });
}));

// ---- OVERTIME: submit a request on an existing entry -----------------------
router.post('/entries/:id/overtime-request', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const existing = await g.loadEntryInScope(db, req.userContext, req.params.id, 'POST /api/timesheet/entries/:id/overtime-request');

  // N1: accept hours (what the UI collects) or minutes, store minutes.
  const minutes = resolveMinutes(req.body || {}, 'hours', 'minutes');
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ error: 'VALIDATION', message: 'Jumlah jam lembur harus lebih dari 0.' });
  }
  g.assertMinutes(minutes, 'INVALID_OVERTIME_MINUTES');

  if (g.TERMINAL_OT.includes(existing.overtime_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_ALREADY_DECIDED',
      `Lembur pada entri ini sudah ${existing.overtime_status}; keputusan tidak dapat ditimpa oleh pengajuan baru.`);
  }
  // A pending request with a verified requester cannot be silently replaced.
  // A LEGACY pending request (no requester id) may be re-submitted so SoD can
  // be verified by id — that is the only way to decide it.
  if (existing.overtime_status === 'pending' && existing.overtime_requested_by_user_id !== null) {
    throw new g.AttendanceError(409, 'OVERTIME_ALREADY_PENDING', 'Pengajuan lembur untuk entri ini sudah menunggu keputusan.');
  }
  if (!g.WORKING_STATUSES.includes(existing.attendance_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_REQUIRES_PRESENCE', 'Lembur hanya dapat diajukan untuk kehadiran hadir/terlambat.');
  }
  // A2: a shift may be configured as never overtime-eligible. Eligibility is
  // still not approval — the A1 request/decision workflow is unchanged.
  if (existing.work_schedule_id && !existing.overtime_eligible_from) {
    throw new g.AttendanceError(409, 'OVERTIME_NOT_ELIGIBLE',
      `Shift ${existing.schedule_code || ''} dikonfigurasi tidak berhak lembur.`.trim());
  }
  await g.assertEligible(db, existing.employee_id, existing.work_date);
  await g.assertStreamWritable(db, existing.employee_id, existing.work_date, STREAMS.OVERTIME);

  // Phase 1B / B2: overtime on an unclassifiable day cannot be priced, so it
  // is refused at source rather than defaulting to the cheapest band.
  let daySnap = null;
  if (!existing.day_type) {
    const recheck = await classifyDay(db, existing.employee_id, existing.work_date);
    if (recheck.status !== CLASSIFICATION_STATUS.OK) {
      return res.status(409).json({
        error: 'DAY_NOT_CLASSIFIED',
        message: `Jenis hari untuk ${existing.work_date} belum bisa ditentukan (${recheck.status}). Perbaiki konfigurasi kalender/pola kerja sebelum mengajukan lembur.`,
      });
    }
    daySnap = toSnapshot(recheck);
  }

  await withTransaction(db, async () => {
    if (daySnap) {
      await db.prepare(`UPDATE timesheet_entries SET day_type = ?, day_type_source = ?, day_type_calendar_id = ?, day_type_pattern_id = ?, day_classified_at = ? WHERE id = ?`)
        .run(daySnap.day_type, daySnap.day_type_source, daySnap.day_type_calendar_id, daySnap.day_type_pattern_id, daySnap.day_classified_at, existing.id);
    }
    const info = await db.prepare(`
      UPDATE timesheet_entries SET
        overtime_minutes_requested = ?, overtime_hours_requested = ?,
        overtime_status = 'pending',
        overtime_requested_by = ?, overtime_requested_by_user_id = ?, overtime_requested_at = kahe_now(),
        overtime_approved_by = NULL, overtime_decided_by_user_id = NULL, overtime_decided_at = NULL,
        updated_by_user_id = ?, updated_at = kahe_now()
      WHERE id = ? AND overtime_status IN ('none','pending')
    `).run(minutes, minutesToHours(minutes), req.userContext.displayName, req.userContext.id, req.userContext.id, existing.id);
    if (Number(info.changes) !== 1) {
      throw new g.AttendanceError(409, 'OVERTIME_ALREADY_DECIDED', 'Status lembur berubah saat diproses. Muat ulang.');
    }
    await g.recordEvent(db, {
      entry: existing, eventType: g.EVENT_TYPES.OVERTIME_REQUESTED, userContext: req.userContext,
      oldValues: { overtime_status: existing.overtime_status, overtime_minutes_requested: existing.overtime_minutes_requested },
      newValues: { overtime_status: 'pending', overtime_minutes_requested: minutes },
    });
  });

  res.status(201).json({
    ok: true, status: 'pending_approval', overtime_minutes_requested: minutes,
    overtime_eligible_from: existing.overtime_eligible_from || null,
    // Reported for review only. Clocking out late NEVER becomes payable time
    // by itself — only an approved request does.
    worked_after_shift_minutes: existing.worked_after_shift_minutes,
  });
}));

// ---- OVERTIME: approve / reject ----------------------------------------------
// approve needs timesheet_absensi:APPROVE, reject needs :REJECT (both held by
// the same roles today; now enforced separately). Requester != decider.
router.post('/entries/:id/overtime-decide', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const { decision } = req.body || {}; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'VALIDATION', message: 'decision harus approved atau rejected.' });
  }
  const action = decision === 'approved' ? 'APPROVE' : 'REJECT';
  if (!hasPermission(req.userContext, MODULE, action)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: `Access denied for ${MODULE}:${action}.` });
  }

  const existing = await g.loadEntryInScope(db, req.userContext, req.params.id, 'POST /api/timesheet/entries/:id/overtime-decide');

  // Segregation of duties, by immutable user id — never by display name.
  if (existing.overtime_requested_by_user_id !== null && existing.overtime_requested_by_user_id === req.userContext.id) {
    return res.status(403).json({ error: 'SOD_VIOLATION', message: 'Pengaju lembur tidak boleh menyetujui/menolak pengajuannya sendiri.' });
  }
  if (existing.overtime_status === decision) {
    // Same decision again: safe no-op. Nothing is rewritten, no event added.
    return res.json({ ok: true, idempotent: true, status: existing.overtime_status });
  }
  if (g.TERMINAL_OT.includes(existing.overtime_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_DECISION_CONFLICT',
      `Lembur sudah ${existing.overtime_status}; keputusan final tidak dapat dibalik.`);
  }
  if (existing.overtime_status !== 'pending') {
    throw new g.AttendanceError(409, 'NO_PENDING_OVERTIME_REQUEST', 'Tidak ada pengajuan lembur yang menunggu keputusan.');
  }
  if (existing.overtime_requested_by_user_id === null) {
    throw new g.AttendanceError(409, 'OVERTIME_REQUESTER_UNVERIFIED',
      'Pengaju lembur ini tidak terverifikasi (data lama). Ajukan ulang agar pemisahan tugas dapat diperiksa.');
  }
  if (decision === 'approved' && !g.WORKING_STATUSES.includes(existing.attendance_status)) {
    throw new g.AttendanceError(409, 'OVERTIME_REQUIRES_PRESENCE', 'Lembur tidak dapat disetujui untuk hari tidak hadir.');
  }
  await g.assertEligible(db, existing.employee_id, existing.work_date);
  await g.assertStreamWritable(db, existing.employee_id, existing.work_date, STREAMS.OVERTIME);

  const approvedMinutes = decision === 'approved' ? existing.overtime_minutes_requested : 0;
  await withTransaction(db, async () => {
    const info = await db.prepare(`
      UPDATE timesheet_entries SET
        overtime_status = ?, overtime_minutes_approved = ?, overtime_hours_approved = ?,
        overtime_approved_by = ?, overtime_decided_by_user_id = ?, overtime_decided_at = kahe_now(),
        updated_at = kahe_now()
      WHERE id = ? AND overtime_status = 'pending'
    `).run(decision, approvedMinutes, minutesToHours(approvedMinutes),
      req.userContext.displayName, req.userContext.id, existing.id);
    if (Number(info.changes) !== 1) {
      throw new g.AttendanceError(409, 'OVERTIME_DECISION_CONFLICT', 'Pengajuan sudah diputuskan oleh pengguna lain.');
    }
    await g.recordEvent(db, {
      entry: existing,
      eventType: decision === 'approved' ? g.EVENT_TYPES.OVERTIME_APPROVED : g.EVENT_TYPES.OVERTIME_REJECTED,
      userContext: req.userContext,
      oldValues: { overtime_status: 'pending', overtime_minutes_approved: existing.overtime_minutes_approved },
      newValues: { overtime_status: decision, overtime_minutes_approved: approvedMinutes },
    });
  });

  res.json({ ok: true, status: decision, overtime_minutes_approved: approvedMinutes });
}));

// ---- AUDIT TRAIL for one entry (read-only, scoped) --------------------------
router.get('/entries/:id/events', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const entry = await g.loadEntryInScope(db, req.userContext, req.params.id, 'GET /api/timesheet/entries/:id/events');
  res.json(await db.prepare('SELECT * FROM attendance_events WHERE timesheet_entry_id = ? ORDER BY id ASC').all(entry.id));
}));

// ---- day classification (read-only; the canonical classifier is the only source) ----
router.get('/day-type/:employeeId/:date', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  if (!g.isValidDate(req.params.date)) {
    return res.status(400).json({ error: 'INVALID_DATE', message: 'Tanggal harus YYYY-MM-DD.' });
  }
  await g.assertEmployeeInScope(db, req.userContext, req.params.employeeId, req.params.date, 'GET /api/timesheet/day-type');
  res.json(await classifyDay(db, req.params.employeeId, req.params.date));
}));

// ---- reference list of workfronts (for the filter/form dropdowns) ---------
router.get('/workfronts', requirePermission(MODULE, 'VIEW'), (req, res) => {
  res.json(WORKFRONTS);
});

module.exports = router;
