// lib/attendanceCorrection.js
// Attendance A3 — correction policy resolution, payroll-impact classification,
// TIME deltas, and the controlled application of an approved correction.
//
// SCOPE LOCK (asserted by test): no money. Attendance computes MINUTES and a
// delta; the FROZEN Payroll Core decides what a minute is worth.
//
// It COMPOSES, never duplicates:
//   schedule / worked minutes -> lib/workSchedule.js       (A2)
//   business dates            -> lib/businessTime.js       (A2)
//   cutoff + frozen snapshot  -> lib/attendanceGuard.js    (A1)
//   period + stream state     -> lib/payrollPeriod.js      [FROZEN]

const bt = require('./businessTime');
const ws = require('./workSchedule');
const g = require('./attendanceGuard');

const REQUEST_TYPE = { CORRECTION: 'CORRECTION', VOID: 'VOID' };

const STATUS = {
  DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', APPLIED: 'APPLIED',
  REVERSED: 'REVERSED',
  PENDING_PAYROLL_REVIEW: 'PENDING_PAYROLL_REVIEW', PAYROLL_REJECTED: 'PAYROLL_REJECTED',
  QUEUED_FOR_PAYROLL: 'QUEUED_FOR_PAYROLL',
  VOID_REQUESTED: 'VOID_REQUESTED', VOID_REVIEWED: 'VOID_REVIEWED', VOID_APPROVED: 'VOID_APPROVED',
  VOID_REJECTED: 'VOID_REJECTED', VOIDED: 'VOIDED',
};

const IMPACT = {
  NONE: 'NO_PAYROLL_IMPACT',
  OPEN: 'PAYROLL_IMPACT_OPEN_PERIOD',
  FROZEN: 'PAYROLL_IMPACT_FROZEN_PERIOD',
  ADJUSTMENT: 'PAYROLL_ADJUSTMENT_REQUIRED',
};

const REASON_CODES = [
  'MISSED_CLOCK_IN', 'MISSED_CLOCK_OUT', 'DEVICE_FAILURE', 'WRONG_SHIFT', 'WRONG_WORK_DATE',
  'BREAK_CORRECTION', 'OT_DISCREPANCY', 'DUPLICATE_RECORD', 'SUPERVISOR_CORRECTION',
  'DATA_ENTRY_ERROR', 'OTHER',
];

// Fields a correction request may propose. Derived authoritative values
// (work_minutes, elapsed, late/early, OT) are NEVER accepted from the client —
// they are recomputed from the corrected source values and the row's own A2
// schedule snapshot.
const CORRECTABLE_FIELDS = [
  'clock_in', 'clock_out', 'clock_out_date', 'attendance_status', 'absence_reason',
  'workfront', 'shift', 'entry_source', 'note',
];

// What payroll actually reads. A correction that leaves every one of these
// unchanged has NO financial impact, however much metadata it rewrites.
const PAYROLL_AUTHORITATIVE_FIELDS = ['work_minutes', 'overtime_minutes_approved', 'day_type', 'attendance_status'];

/** The correction policy in force ON a date, for an entity. Never "latest row". */
async function resolvePolicy(db, legalEntityId, date) {
  const rows = await db.prepare(`
    SELECT * FROM attendance_correction_policies
    WHERE (legal_entity_id = ? OR legal_entity_id IS NULL)
      AND status = 'ACTIVE'
      AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY (legal_entity_id IS NULL) ASC, effective_from DESC
  `).all(legalEntityId, date, date);
  if (!rows.length) return { policy: null, status: 'NO_POLICY' };
  const scoped = rows.filter((r) => r.legal_entity_id === legalEntityId);
  const candidates = scoped.length ? scoped : rows;
  // Two policies of the same scope covering the same date is ambiguous, and a
  // correction window is not something to guess at.
  if (candidates.length > 1 && candidates[0].effective_from === candidates[1].effective_from) {
    return { policy: null, status: 'AMBIGUOUS_POLICY' };
  }
  return { policy: candidates[0], status: 'OK' };
}

function windowDays(policy) {
  const n = Number(policy.correction_window);
  if (policy.window_unit === 'WEEKS') return n * 7;
  if (policy.window_unit === 'MONTHS') return n * 30;
  return n;
}

/**
 * Is this request inside the configured correction window?
 * Compared in the BUSINESS timezone — never a raw UTC slice.
 */
function classifyTiming(policy, workDate, today = bt.businessToday()) {
  const days = windowDays(policy);
  const deadline = bt.addDays(workDate, days);
  const late = today > deadline;
  return { isLate: late, deadline, ageDays: bt.daysBetween(workDate, today), windowDays: days };
}

/** Does the corrected result change anything payroll reads? */
function financialImpact(before, after) {
  return PAYROLL_AUTHORITATIVE_FIELDS.some((f) => (before[f] ?? null) !== (after[f] ?? null));
}

/** Integer TIME deltas only. No rate, no amount, no currency. */
function timeDelta(before, after) {
  return {
    delta_work_minutes: Number(after.work_minutes || 0) - Number(before.work_minutes || 0),
    delta_overtime_minutes: Number(after.overtime_minutes_approved || 0) - Number(before.overtime_minutes_approved || 0),
    day_type_before: before.day_type ?? null,
    day_type_after: after.day_type ?? null,
    attendance_status_before: before.attendance_status ?? null,
    attendance_status_after: after.attendance_status ?? null,
  };
}

/** The FINALIZED payroll run, if any, that already consumed this work date. */
async function finalizedRunFor(db, employeeId, workDate, legalEntityId) {
  return await db.prepare(`
    SELECT r.* FROM payroll_runs r
    JOIN payroll_periods p ON p.id = r.payroll_period_id
    WHERE r.status = 'FINALIZED' AND r.legal_entity_id = ?
      AND p.period_start <= ? AND p.period_end >= ?
    ORDER BY r.id DESC LIMIT 1
  `).get(legalEntityId, workDate, workDate) || null;
}

/**
 * Classify what a correction means for payroll.
 *
 * NO_PAYROLL_IMPACT            nothing payroll reads changes
 * PAYROLL_IMPACT_OPEN_PERIOD   payroll has not consumed this day yet
 * PAYROLL_IMPACT_FROZEN_PERIOD a frozen snapshot exists (source must not move)
 * PAYROLL_ADJUSTMENT_REQUIRED  payroll is FINALIZED and the time changed
 *
 * The finalized case NEVER edits, reopens or recalculates payroll: it produces
 * a time delta that a Payroll Officer must approve into the adjustment queue.
 */
async function classifyPayrollImpact(db, { employeeId, workDate, legalEntityId, before, after }) {
  const period = await (async () => {
    try {
      const { resolvePeriodForDate } = require('./payrollPeriod');
      return await resolvePeriodForDate(db, employeeId, workDate);
    } catch (err) { return null; }
  })();
  const periodId = period && period.period ? period.period.id : null;

  if (!financialImpact(before, after)) {
    return { impact: IMPACT.NONE, periodId, runId: null, financial: false };
  }
  const run = await finalizedRunFor(db, employeeId, workDate, legalEntityId);
  if (run) return { impact: IMPACT.ADJUSTMENT, periodId: run.payroll_period_id, runId: run.id, financial: true };
  if (await g.isPayrollSourceFrozen(db, employeeId, workDate)) {
    return { impact: IMPACT.FROZEN, periodId, runId: null, financial: true };
  }
  return { impact: IMPACT.OPEN, periodId, runId: null, financial: true };
}

/** The payroll-visible shape of an attendance row (TIME only). */
function entrySnapshot(entry) {
  const out = {};
  for (const k of ['id', 'employee_id', 'work_date', 'workfront', 'shift', 'clock_in', 'clock_out',
    'clock_out_date', 'work_minutes', 'work_hours', 'elapsed_minutes', 'late_minutes', 'early_leave_minutes',
    'worked_after_shift_minutes', 'attendance_status', 'absence_reason', 'note', 'entry_source',
    'day_type', 'day_status', 'work_schedule_id', 'schedule_code', 'scheduled_clock_in', 'scheduled_clock_out',
    'scheduled_minutes', 'break_minutes_unpaid', 'break_minutes_paid', 'overtime_status',
    'overtime_minutes_requested', 'overtime_minutes_approved', 'overtime_eligible_from',
    'record_status', 'current_version']) out[k] = entry[k] ?? null;
  return out;
}

/** Rebuild the A2 expectation from the row's OWN snapshot (never today's config). */
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
 * What the record WOULD look like if this correction were applied. Derived
 * values are recomputed, never taken from the request.
 * Returns { after, error }.
 */
function projectCorrection(entry, proposed) {
  const after = entrySnapshot(entry);
  for (const f of CORRECTABLE_FIELDS) {
    if (proposed[f] !== undefined) after[f] = proposed[f] === '' ? null : proposed[f];
  }
  const resolved = snapshotResolved(entry);
  if (after.clock_in && after.clock_out) {
    if (!bt.isValidTime(after.clock_in) || !bt.isValidTime(after.clock_out)) return { after: null, error: 'INVALID_TIME' };
    if (resolved) {
      const d = ws.deriveWorkedMinutes(resolved, {
        clockIn: after.clock_in, clockOut: after.clock_out,
        clockOutDate: after.clock_out_date, workDate: entry.work_date,
      });
      if (d.error) return { after: null, error: d.error };
      after.work_minutes = d.workedMinutes;
      after.elapsed_minutes = d.elapsedMinutes;
      after.late_minutes = d.lateMinutes;
      after.early_leave_minutes = d.earlyLeaveMinutes;
      after.worked_after_shift_minutes = d.workedAfterShiftMinutes;
      after.clock_out_date = d.clockOutDate || after.clock_out_date;
    }
  } else if (proposed.work_minutes !== undefined && !resolved) {
    // No schedule to derive from: an explicit figure is allowed, integer only.
    const m = Number(proposed.work_minutes);
    if (!Number.isInteger(m) || m < 0 || m > g.MAX_DAY_MINUTES) return { after: null, error: 'INVALID_MINUTES' };
    after.work_minutes = m;
  }
  after.work_hours = after.work_minutes === null ? null : after.work_minutes / 60;
  // A void removes the day from payroll entirely: zero payable time, no OT.
  return { after, error: null };
}

/** The projection for a VOID: the day stops counting, the row survives. */
function projectVoid(entry) {
  const after = entrySnapshot(entry);
  after.record_status = 'VOIDED';
  after.work_minutes = 0;
  after.work_hours = 0;
  after.overtime_minutes_approved = 0;
  return { after, error: null };
}

module.exports = {
  REQUEST_TYPE, STATUS, IMPACT, REASON_CODES, CORRECTABLE_FIELDS, PAYROLL_AUTHORITATIVE_FIELDS,
  resolvePolicy, windowDays, classifyTiming, financialImpact, timeDelta,
  classifyPayrollImpact, finalizedRunFor, entrySnapshot, snapshotResolved,
  projectCorrection, projectVoid,
};
