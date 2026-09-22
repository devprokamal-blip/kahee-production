// lib/attendanceGuard.js
// Attendance Hardening A1 — the write-side rules for Timesheet & Absensi.
//
// This module COMPOSES the canonical authorities; it re-implements none:
//   period / cutoff  -> lib/payrollPeriod.js   (resolvePeriodForDate, isStreamOpen)
//   eligibility      -> lib/employeeEligibility.js (isEligibleOn, getAssignmentOn)
//   entity scope     -> lib/entityScope.js      (scopeClause, assertEntityAccess)
// It never calculates money and never writes a payroll table.

const pp = require('./payrollPeriod');
const eligibility = require('./employeeEligibility');
const entityScope = require('./entityScope');

// Reserved attendance sources. A1 writes MANUAL only. The source is set by the
// SERVER, never accepted from the client: a browser claiming FINGERPRINT would
// be a forged provenance. Device integrations will set their own source.
const ATTENDANCE_SOURCES = ['MANUAL', 'WEB', 'QR', 'RFID', 'FINGERPRINT', 'FACE', 'MOBILE', 'API_IMPORT'];

const EVENT_TYPES = {
  ENTRY_CREATED: 'ENTRY_CREATED',
  ENTRY_UPDATED: 'ENTRY_UPDATED',
  OVERTIME_REQUESTED: 'OVERTIME_REQUESTED',
  OVERTIME_APPROVED: 'OVERTIME_APPROVED',
  OVERTIME_REJECTED: 'OVERTIME_REJECTED',
};

const WORKING_STATUSES = ['present', 'late'];
const TERMINAL_OT = ['approved', 'rejected'];
const MAX_DAY_MINUTES = 24 * 60;

/** Machine-readable failure. Routes turn `status` + `code` into the response. */
class AttendanceError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'AttendanceError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Strict 'YYYY-MM-DD' that is a real calendar date. Blocks cutoff bypass via junk dates. */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Integer minutes in [0, 1440] or null. Minutes stay canonical (lib/time.js). */
function assertMinutes(value, code = 'INVALID_WORK_MINUTES') {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_DAY_MINUTES) {
    throw new AttendanceError(400, code, `Menit harus bilangan bulat 0–${MAX_DAY_MINUTES}.`);
  }
}

/**
 * Which legal entity owns this employee's attendance on this date?
 * The assignment in force THAT DAY; for a date with no assignment, fall back
 * to the canonical entityScope resolver (latest assignment) so the scope check
 * still runs before anything about the employee is disclosed.
 */
async function entityForEmployeeOn(db, employeeId, date) {
  const a = await eligibility.getAssignmentOn(db, employeeId, date);
  if (a) return a.legal_entity_id;
  return await entityScope.resolveResourceEntity(db, 'employee', employeeId);
}

/**
 * Scope guard for an employee + date. Foreign entity -> NOT_FOUND (404),
 * indistinguishable from an absent employee (Phase 2I policy).
 * An employee with no assignment at all belongs to no entity; that is a data
 * problem the caller may see, so it returns null and eligibility reports it.
 */
async function assertEmployeeInScope(db, userContext, employeeId, date, route) {
  const exists = await db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
  if (!exists) throw new entityScope.EntityAccessError(entityScope.ERROR.NOT_FOUND, 'Data tidak ditemukan.');
  const entityId = await entityForEmployeeOn(db, employeeId, date);
  if (entityId === null || entityId === undefined) return null;
  await entityScope.assertEntityAccess(db, userContext, entityId, { resourceType: 'employee', resourceId: employeeId, route });
  return entityId;
}

/** Load an entry and apply the entity guard. Absent or foreign -> NOT_FOUND. */
async function loadEntryInScope(db, userContext, entryId, route) {
  const entry = await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(entryId);
  if (!entry) throw new entityScope.EntityAccessError(entityScope.ERROR.NOT_FOUND, 'Data tidak ditemukan.');
  await entityScope.assertEntityAccess(db, userContext, entry.legal_entity_id,
    { resourceType: 'timesheet_entry', resourceId: entryId, route });
  return entry;
}

/** Canonical eligibility on the WORK DATE (never today's employment state). */
async function assertEligible(db, employeeId, date) {
  const r = await eligibility.isEligibleOn(db, employeeId, date);
  if (!r.eligible) {
    throw new AttendanceError(409, 'EMPLOYEE_NOT_ELIGIBLE',
      `Karyawan tidak memenuhi syarat pada ${date} (${r.reason}).`, { reason: r.reason });
  }
  return r;
}

/** Is any FROZEN payroll snapshot built over this employee/date? */
async function isPayrollSourceFrozen(db, employeeId, date) {
  return !!await db.prepare(`
    SELECT 1 FROM payroll_input_snapshots s
    JOIN payroll_periods p ON p.id = s.payroll_period_id
    WHERE s.employee_id = ? AND s.status = 'FROZEN' AND p.period_start <= ? AND p.period_end >= ?
    LIMIT 1`).get(employeeId, date, date);
}

/**
 * May this stream still be written for this employee/date?
 *
 * Authority: lib/payrollPeriod (resolvePeriodForDate + isStreamOpen).
 * A1 policy on its answers:
 *   PERIOD_CLOSED / PAST_CUTOFF -> refused (409 ATTENDANCE_PERIOD_CLOSED or
 *                                  OVERTIME_PERIOD_CLOSED)
 *   PERIOD_NOT_OPEN (DRAFT)     -> writable: attendance happens daily, before
 *                                  payroll opens the period; nothing has
 *                                  consumed it yet. (Phase 2A materialises a
 *                                  year of DRAFT periods; refusing them would
 *                                  block all normal attendance.)
 *   no period resolvable         -> writable; reported as `period_status`.
 * Independently of the period: a FROZEN snapshot always wins (409
 * ATTENDANCE_SOURCE_FROZEN), because a period may be reopened after freezing.
 */
async function assertStreamWritable(db, employeeId, date, stream) {
  if (await isPayrollSourceFrozen(db, employeeId, date)) {
    throw new AttendanceError(409, 'ATTENDANCE_SOURCE_FROZEN',
      `Absensi ${date} sudah dipakai snapshot payroll yang dibekukan dan tidak dapat diubah.`);
  }
  const r = await pp.resolvePeriodForDate(db, employeeId, date);
  if (!r.period) return { period_status: r.status, period_id: null };
  const s = pp.isStreamOpen(r.period, stream);
  if (!s.open && (s.reason === 'PERIOD_CLOSED' || s.reason === 'PAST_CUTOFF')) {
    const code = stream === pp.STREAMS.OVERTIME ? 'OVERTIME_PERIOD_CLOSED' : 'ATTENDANCE_PERIOD_CLOSED';
    throw new AttendanceError(409, code,
      `Periode payroll untuk ${date} sudah ditutup untuk ${stream} (${s.reason}${s.cutoff ? `, cutoff ${s.cutoff}` : ''}).`,
      { reason: s.reason, cutoff: s.cutoff || null, payroll_period_id: r.period.id });
  }
  return { period_status: r.period.status, period_id: r.period.id };
}

/** Append one audit event. Caller owns the transaction. */
async function recordEvent(db, { entry, eventType, userContext, oldValues = null, newValues = null, reason = null, source = 'MANUAL' }) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) throw new Error(`attendanceGuard: unknown event ${eventType}`);
  await db.prepare(`INSERT INTO attendance_events
    (timesheet_entry_id, employee_id, work_date, legal_entity_id, event_type, actor_user_id, actor_name,
     source, old_values, new_values, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    entry.id ?? null, entry.employee_id, entry.work_date, entry.legal_entity_id ?? null, eventType,
    userContext.id ?? null, userContext.displayName || null, source,
    oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, reason);
}

/** Map a database trigger refusal to the same machine-readable error. */
function mapTriggerError(err) {
  const m = String(err && err.message);
  if (m.includes('ATTENDANCE_SOURCE_FROZEN')) {
    return new AttendanceError(409, 'ATTENDANCE_SOURCE_FROZEN', 'Absensi sudah dipakai snapshot payroll yang dibekukan.');
  }
  return err;
}

module.exports = {
  ATTENDANCE_SOURCES, EVENT_TYPES, WORKING_STATUSES, TERMINAL_OT, MAX_DAY_MINUTES,
  AttendanceError, isValidDate, assertMinutes,
  entityForEmployeeOn, assertEmployeeInScope, loadEntryInScope,
  assertEligible, isPayrollSourceFrozen, assertStreamWritable,
  recordEvent, mapTriggerError,
};
