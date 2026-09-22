// lib/payrollPeriod.js
// Phase 2A — THE single source of truth for payroll period questions.
//
// SCOPE LOCK: nothing in this file calculates money. No salary, BPJS, tax,
// overtime value, gross or net. It answers WHEN and WHICH PERIOD only.
//
// Mirrors the contract of lib/employeeEligibility.js and
// lib/dayClassification.js: the future Payroll Run, validation checks, and any
// report must call these functions rather than querying payroll_periods
// directly. Three copies of "which period owns this date" would drift.
//
// TIMEZONE SAFETY: every boundary is a date-only 'YYYY-MM-DD' string compared
// lexicographically. No local-timezone Date parsing touches a boundary, so a
// server in WIB, UTC or anywhere else resolves the same period for the same
// date. Date arithmetic (offsets) goes through addDays() below, which is UTC.

const PERIOD_STATUS = { DRAFT: 'DRAFT', OPEN: 'OPEN', CUTOFF: 'CUTOFF', CLOSED: 'CLOSED' };

// Administrative lifecycle. Advanced only by an explicit, audited action —
// a period never closes itself by the clock, because closing is a decision
// (all data is in) not an observation (a date passed).
const ALLOWED_TRANSITIONS = {
  DRAFT: ['OPEN'],
  OPEN: ['CUTOFF', 'CLOSED'],
  CUTOFF: ['OPEN', 'CLOSED'],   // OPEN allows reopening for a late correction
  CLOSED: [],                   // terminal in Phase 2A
};

const STREAMS = { ATTENDANCE: 'attendance', OVERTIME: 'overtime', ADJUSTMENT: 'adjustment' };

/** UTC-safe date arithmetic on 'YYYY-MM-DD'. Never uses local time. */
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/** Last day of a month, UTC-safe. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Derive a period's dates from its group's OFFSET POLICY.
 * Offsets are relative to period_end, so no company-specific date is baked in.
 */
function deriveDates(group, periodStart, periodEnd) {
  return {
    period_start: periodStart,
    period_end: periodEnd,
    attendance_cutoff: addDays(periodEnd, group.attendance_cutoff_offset_days),
    overtime_cutoff: addDays(periodEnd, group.overtime_cutoff_offset_days),
    adjustment_cutoff: addDays(periodEnd, group.adjustment_cutoff_offset_days),
    payment_date: addDays(periodEnd, group.payment_offset_days),
  };
}

/** Monthly convenience: the calendar month window for a year/month. */
function monthlyWindow(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  return { periodStart: start, periodEnd: lastDayOfMonth(year, month) };
}

/**
 * THE question: which payroll period owns this date for this employee?
 *
 * Resolution chain:
 *   employee -> payroll assignment in force ON THAT DATE -> its payroll group
 *   -> the group's period whose [period_start, period_end] contains the date.
 *
 * Because the assignment is effective-dated, an employee who changes group
 * mid-month has each date resolved to the group that owned them THAT DAY.
 *
 * @returns {{period, group, assignment, status, reason}} — period is null
 * whenever status !== 'OK'. Callers must treat that as an exception to
 * surface, never as "probably the current period".
 */
async function resolvePeriodForDate(db, employeeId, date) {
  const base = { period: null, group: null, assignment: null, status: 'OK', reason: null };

  const assignment = await db.prepare(`
    SELECT * FROM employee_payroll_assignments
    WHERE employee_id = ? AND effective_date <= ? AND (end_date IS NULL OR end_date >= ?)
    ORDER BY effective_date DESC LIMIT 1
  `).get(employeeId, date, date);

  if (!assignment) {
    return { ...base, status: 'MISSING_ASSIGNMENT', reason: 'Tidak ada payroll assignment yang berlaku pada tanggal ini.' };
  }
  if (!assignment.payroll_group_id) {
    return { ...base, assignment, status: 'MISSING_PAYROLL_GROUP', reason: 'Assignment belum terhubung ke payroll group.' };
  }

  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(assignment.payroll_group_id);
  if (!group) {
    return { ...base, assignment, status: 'MISSING_PAYROLL_GROUP', reason: 'Payroll group tidak ditemukan.' };
  }

  const periods = await db.prepare(`
    SELECT * FROM payroll_periods
    WHERE payroll_group_id = ? AND period_start <= ? AND period_end >= ?
    ORDER BY period_start DESC
  `).all(group.id, date, date);

  if (periods.length === 0) {
    return { ...base, assignment, group, status: 'NO_PERIOD', reason: `Belum ada payroll period untuk grup ${group.code} yang mencakup ${date}.` };
  }
  if (periods.length > 1) {
    // The overlap guard below should make this unreachable; if it happens the
    // data is corrupt and must be surfaced, never silently resolved.
    return { ...base, assignment, group, status: 'AMBIGUOUS_PERIOD', reason: 'Lebih dari satu payroll period mencakup tanggal ini.' };
  }

  return { ...base, assignment, group, period: periods[0] };
}

/**
 * Is a given data stream still accepting input for this period?
 *
 * DERIVED from the three cutoff dates plus the administrative status, rather
 * than encoded as extra statuses — a single CUTOFF status could not express
 * "attendance closed but adjustments still open", which is the normal state
 * of a period in the days before payment.
 *
 * @param asOf 'YYYY-MM-DD' (defaults to today)
 */
function isStreamOpen(period, stream, asOf = new Date().toISOString().slice(0, 10)) {
  if (!period) return { open: false, reason: 'NO_PERIOD' };
  if (period.status === PERIOD_STATUS.DRAFT) return { open: false, reason: 'PERIOD_NOT_OPEN' };
  if (period.status === PERIOD_STATUS.CLOSED) return { open: false, reason: 'PERIOD_CLOSED' };

  const cutoff = {
    [STREAMS.ATTENDANCE]: period.attendance_cutoff,
    [STREAMS.OVERTIME]: period.overtime_cutoff,
    [STREAMS.ADJUSTMENT]: period.adjustment_cutoff,
  }[stream];
  if (!cutoff) return { open: false, reason: 'UNKNOWN_STREAM' };

  return asOf <= cutoff
    ? { open: true, reason: null, cutoff }
    : { open: false, reason: 'PAST_CUTOFF', cutoff };
}

/** Is this lifecycle transition permitted? */
function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * Does [start, end] overlap an existing period of the same group?
 * SQLite cannot express range exclusion, so this is the compensating control
 * alongside the two unique indexes (same pattern as Phase 1A).
 */
async function findOverlappingPeriod(db, groupId, start, end, excludeId = null) {
  return await db.prepare(`
    SELECT * FROM payroll_periods
    WHERE payroll_group_id = ?
      AND (?::bigint IS NULL OR id != ?)
      AND period_start <= ?
      AND period_end >= ?
    LIMIT 1
  `).get(groupId, excludeId, excludeId, end, start) || null;
}

/**
 * Which employees belong to this group during this period, and for how many
 * days? Membership is effective-dated on the assignment, so an employee who
 * joins, leaves, or switches group mid-period contributes only their days.
 *
 * Returns ONE row per employee — never a row per employee per day — so 2,000
 * workers stay 2,000 rows regardless of period length.
 */
async function getGroupMembership(db, groupId, periodStart, periodEnd) {
  return await db.prepare(`
    SELECT * FROM (
      SELECT DISTINCT ON (a.employee_id)
        a.employee_id,
        e.full_name,
        e.worker_type,
        GREATEST(a.effective_date, ?::date) AS member_from,
        LEAST(COALESCE(a.end_date, ?::date), ?::date) AS member_to
      FROM employee_payroll_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.payroll_group_id = ?
        AND a.effective_date <= ?
        AND (a.end_date IS NULL OR a.end_date >= ?)
      ORDER BY a.employee_id, a.effective_date ASC, a.id ASC
    ) m
    ORDER BY m.full_name ASC
  `).all(periodStart, periodEnd, periodEnd, groupId, periodEnd, periodStart);
}

module.exports = {
  PERIOD_STATUS,
  ALLOWED_TRANSITIONS,
  STREAMS,
  addDays,
  lastDayOfMonth,
  monthlyWindow,
  deriveDates,
  resolvePeriodForDate,
  isStreamOpen,
  canTransition,
  findOverlappingPeriod,
  getGroupMembership,
};
