// lib/attendancePeriod.js — Attendance A4 CP1
// Attendance Period: first-class operational object, scoped by LEGAL ENTITY.
//
// The DATABASE (migration 0006) is the authority for every invariant: overlap, lifecycle,
// immutable fields, audit. This module only (a) validates requests, (b) opens a transaction
// carrying the authenticated actor as a TRANSACTION-LOCAL context, (c) issues plain SQL, and
// (d) maps database refusals to language-neutral machine codes.
//
// LOCKS (A4 CP1 contract v3):
//   * Actor identity comes ONLY from the authenticated session (req.userContext). It is never
//     read from a request body; the triggers write every actor column from the context.
//   * Correctness never depends on middleware/writeSerializer.
//   * Responses carry machine codes + parameters, never a human sentence (ID/EN is the UI's job).
//   * Nothing here touches timesheet_entries or any Payroll table except READ-ONLY lookups
//     of payroll_periods / payroll_groups for the derived mapping.
const { withTransaction } = require('../database/db');
const { roleSnapshot } = require('./attendanceAudit');
const entityScope = require('./entityScope');   // FROZEN — called, never modified
const bt = require('./businessTime');

const STATUS = { OPEN: 'OPEN', REVIEW: 'REVIEW', READY_TO_CLOSE: 'READY_TO_CLOSE', CLOSED: 'CLOSED', FROZEN: 'FROZEN' };
const STATUSES = Object.values(STATUS);
const PERMISSION = { CREATE: 'attendance_period:CREATE', EDIT: 'attendance_period:EDIT' };

// Complete A4 error catalogue -> HTTP status. The UI maps each code to ID/EN text.
const ERRORS = {
  // request / access
  UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  REQUEST_FIELD_NOT_ALLOWED: 400, REQUEST_FIELD_REQUIRED: 400, REQUEST_FIELD_INVALID: 400,
  // actor context (database-enforced)
  ACTOR_CONTEXT_REQUIRED: 500, ACTOR_PERMISSION_MISMATCH: 500, ACTOR_NOT_AUTHORIZED: 403,
  // attendance period
  LEGAL_ENTITY_NOT_FOUND: 404,
  ATTENDANCE_PERIOD_ISOLATION_UNSUPPORTED: 500,
  ATTENDANCE_PERIOD_INVALID_RANGE: 400,
  ATTENDANCE_PERIOD_OVERLAP: 409,
  ATTENDANCE_PERIOD_INITIAL_STATUS_INVALID: 400,
  ATTENDANCE_PERIOD_FIELD_IMMUTABLE: 409,
  ATTENDANCE_PERIOD_DETAILS_LOCKED: 409,
  ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED: 409,
  ATTENDANCE_PERIOD_TRANSITION_INVALID: 409,
  ATTENDANCE_PERIOD_REASON_REQUIRED: 400,
  ATTENDANCE_PERIOD_DELETE_FORBIDDEN: 409,
  ATTENDANCE_PERIOD_STATE_CHANGED: 409,
  // audit tables
  A4_AUDIT_APPEND_ONLY: 409, A4_AUDIT_DIRECT_INSERT_FORBIDDEN: 409, A4_AUDIT_EVENT_INCONSISTENT: 409,
  A4_TRUNCATE_FORBIDDEN: 409,
  // closing policy
  CLOSING_POLICY_INITIAL_STATE_INVALID: 400, CLOSING_POLICY_FIELD_IMMUTABLE: 409, CLOSING_POLICY_IMMUTABLE: 409,
  CLOSING_POLICY_OVERLAP: 409, CLOSING_POLICY_INVALID_EFFECTIVE_TO: 400, CLOSING_POLICY_TRANSITION_INVALID: 409,
  CLOSING_POLICY_DELETE_FORBIDDEN: 409, CLOSING_POLICY_NOT_FOUND: 404,
  CLOSING_POLICY_ISSUE_CODE_UNKNOWN: 400, CLOSING_POLICY_ISSUE_CODE_NOT_CONFIGURABLE: 400,
  CLOSING_POLICY_RULE_INVALID: 400, CLOSING_POLICY_RULE_NOT_FOUND: 404, NO_CLOSING_POLICY: 404,
  // readiness (A4 CP2)
  ATTENDANCE_READINESS_NOT_READY: 409, ATTENDANCE_READINESS_CHANGED: 409,
  ATTENDANCE_READINESS_EVIDENCE_INVALID: 409, ATTENDANCE_READINESS_RECORD_INVALID: 500,
  // infrastructure
  DB_CONCURRENCY_RETRY: 503, DB_CONSTRAINT_VIOLATION: 409, INTERNAL_ERROR: 500,
};
const ERROR_CODES = Object.keys(ERRORS);

class A4Error extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'A4Error';
    this.code = code;
    this.status = ERRORS[code] || 500;
    this.detail = detail || {};
  }
}

/** Map a database / scope error to an A4Error, or return null when it is not ours. */
function mapError(err) {
  if (!err) return null;
  if (err instanceof A4Error) return err;
  if (err.name === 'EntityAccessError') return new A4Error('NOT_FOUND');
  if (err.code === 'KH001' && Object.prototype.hasOwnProperty.call(ERRORS, err.message)) {
    let detail = {};
    try { detail = err.detail ? JSON.parse(err.detail) : {}; } catch (_) { detail = {}; }
    return new A4Error(err.message, detail);
  }
  if (['40001', '40P01', '55P03'].includes(err.code)) return new A4Error('DB_CONCURRENCY_RETRY');
  if (['23505', '23514', '23503', '23502'].includes(err.code)) return new A4Error('DB_CONSTRAINT_VIOLATION', { constraint: err.constraint || null });
  return null;
}

/** Reject any body field outside the endpoint's allowlist (actor/metadata fields can never be supplied). */
function assertBody(body, allowed, required = []) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !allowed.includes(k)).sort();
  if (extra.length) throw new A4Error('REQUEST_FIELD_NOT_ALLOWED', { fields: extra });
  for (const f of required) {
    if (b[f] === undefined || b[f] === null || b[f] === '') throw new A4Error('REQUEST_FIELD_REQUIRED', { field: f });
  }
  return b;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function requireDate(value, field) {
  if (!isValidDate(value)) throw new A4Error('REQUEST_FIELD_INVALID', { field });
  return value;
}
function optionalText(value, field, max = 200) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new A4Error('REQUEST_FIELD_INVALID', { field });
  const t = value.trim();
  return t === '' ? null : t;
}
function positiveId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new A4Error('NOT_FOUND', { field });
  return n;
}
function paging(query = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'limit' });
  if (!Number.isInteger(offset) || offset < 0) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'offset' });
  return { limit, offset };
}

/**
 * Run fn inside ONE transaction whose action context is the authenticated session actor.
 * set_config(..., true) is TRANSACTION-LOCAL: it disappears at COMMIT or ROLLBACK, so a pooled
 * connection never carries one request's actor into another.
 */
async function withActor(db, userContext, permission, reason, fn) {
  if (!userContext || !userContext.id) throw new A4Error('UNAUTHENTICATED');
  return withTransaction(db, async () => {
    await db.query(`SELECT set_config('kahe.actor_user_id', $1, true), set_config('kahe.actor_name', $2, true),
      set_config('kahe.actor_role', $3, true), set_config('kahe.permission', $4, true), set_config('kahe.reason', $5, true)`,
    [String(userContext.id), userContext.displayName || '', roleSnapshot(userContext) || '', permission, reason || '']);
    return fn();
  });
}

async function mapped(fn) {
  try { return await fn(); } catch (err) { throw mapError(err) || err; }
}

const meta = (route, id = null) => ({ resourceType: 'attendance_period', resourceId: id, route });

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------
async function loadPeriod(db, id) {
  return db.prepare('SELECT * FROM attendance_periods WHERE id = ?').get(positiveId(id));
}

async function getPeriod(db, userContext, id, route = null) {
  const row = await loadPeriod(db, id);
  if (!row) throw new A4Error('NOT_FOUND');
  await mapped(() => entityScope.assertEntityAccess(db, userContext, row.legal_entity_id, meta(route, row.id)));
  return row;
}

async function listPeriods(db, userContext, query = {}, route = null) {
  const { limit, offset } = paging(query);
  const scope = await entityScope.scopeClause(db, userContext, 'legal_entity_id', meta(route));
  const where = [scope.sql]; const params = [...scope.params];
  if (query.legal_entity_id !== undefined) { where.push('legal_entity_id = ?'); params.push(String(query.legal_entity_id)); }
  if (query.status !== undefined) {
    if (!STATUSES.includes(query.status)) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'status' });
    where.push('status = ?'); params.push(query.status);
  }
  const w = where.join(' AND ');
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM attendance_periods WHERE ${w}`).get(...params)).n;
  const items = await db.prepare(`SELECT * FROM attendance_periods WHERE ${w}
    ORDER BY legal_entity_id ASC, start_date ASC, id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { items, total, limit, offset };
}

async function listEvents(db, userContext, id, route = null) {
  const p = await getPeriod(db, userContext, id, route);
  return db.prepare('SELECT * FROM attendance_period_events WHERE period_id = ? ORDER BY id ASC').all(p.id);
}

// ---------------------------------------------------------------------------
// writes (every one inside withActor; the database decides)
// ---------------------------------------------------------------------------
async function createPeriod(db, userContext, body, route = null) {
  const b = assertBody(body, ['legal_entity_id', 'start_date', 'end_date', 'label'], ['legal_entity_id', 'start_date', 'end_date']);
  if (typeof b.legal_entity_id !== 'string') throw new A4Error('REQUEST_FIELD_INVALID', { field: 'legal_entity_id' });
  const start = requireDate(b.start_date, 'start_date');
  const end = requireDate(b.end_date, 'end_date');
  if (end < start) throw new A4Error('ATTENDANCE_PERIOD_INVALID_RANGE', { start_date: start, end_date: end });
  const label = optionalText(b.label, 'label');
  await mapped(() => entityScope.assertEntityAccess(db, userContext, b.legal_entity_id, meta(route)));
  return mapped(() => withActor(db, userContext, PERMISSION.CREATE, null, async () =>
    db.prepare('INSERT INTO attendance_periods (legal_entity_id, start_date, end_date, label) VALUES (?,?,?,?) RETURNING *')
      .get(b.legal_entity_id, start, end, label)));
}

async function updateDetails(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['start_date', 'end_date', 'label']);
  if (!Object.keys(b).length) throw new A4Error('REQUEST_FIELD_REQUIRED', { field: 'start_date|end_date|label' });
  const current = await getPeriod(db, userContext, id, route);
  const sets = []; const params = [];
  if (b.start_date !== undefined) { sets.push('start_date = ?'); params.push(requireDate(b.start_date, 'start_date')); }
  if (b.end_date !== undefined) { sets.push('end_date = ?'); params.push(requireDate(b.end_date, 'end_date')); }
  if (b.label !== undefined) { sets.push('label = ?'); params.push(optionalText(b.label, 'label')); }
  return mapped(() => withActor(db, userContext, PERMISSION.EDIT, null, async () => {
    const row = await db.prepare(`UPDATE attendance_periods SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params, current.id);
    if (!row) throw new A4Error('NOT_FOUND');
    return row;
  }));
}

/** Compare-and-set transition: succeeds only if the period is still in expected_status. */
async function transition(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['to_status', 'expected_status', 'reason'], ['to_status', 'expected_status']);
  if (!STATUSES.includes(b.to_status)) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'to_status' });
  if (!STATUSES.includes(b.expected_status)) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'expected_status' });
  const reason = optionalText(b.reason, 'reason', 1000);
  if (b.to_status === b.expected_status) {
    throw new A4Error('ATTENDANCE_PERIOD_TRANSITION_INVALID', { from: b.expected_status, to: b.to_status });
  }
  const current = await getPeriod(db, userContext, id, route);
  return mapped(() => withActor(db, userContext, PERMISSION.EDIT, reason, async () => {
    const row = await db.prepare('UPDATE attendance_periods SET status = ? WHERE id = ? AND status = ? RETURNING *')
      .get(b.to_status, current.id, b.expected_status);
    if (row) return row;
    const now = await db.prepare('SELECT status FROM attendance_periods WHERE id = ?').get(current.id);
    throw new A4Error('ATTENDANCE_PERIOD_STATE_CHANGED', { expected_status: b.expected_status, current_status: now ? now.status : null });
  }));
}

// ---------------------------------------------------------------------------
// Attendance Period <-> Payroll Period: DERIVED (N:M), nothing stored in CP1.
// ---------------------------------------------------------------------------
/** Payroll Periods of the same Legal Entity whose dates overlap the Attendance Period. */
async function payrollPeriodsFor(db, attendancePeriod) {
  const rows = await db.prepare(`
    SELECT pp.id AS payroll_period_id, pp.payroll_group_id, pg.code AS payroll_group_code, pg.frequency,
           pp.period_start, pp.period_end, pp.status AS payroll_period_status
    FROM payroll_periods pp JOIN payroll_groups pg ON pg.id = pp.payroll_group_id
    WHERE pg.legal_entity_id = ? AND pp.period_start <= ? AND pp.period_end >= ?
    ORDER BY pp.period_start ASC, pp.id ASC`).all(attendancePeriod.legal_entity_id, attendancePeriod.end_date, attendancePeriod.start_date);
  return rows.map((r) => ({ ...r,
    straddles: r.period_start < attendancePeriod.start_date || r.period_end > attendancePeriod.end_date }));
}

/** Attendance Periods covering a Payroll Period, plus the uncovered gaps (inclusive dates). */
async function coverageFor(db, payrollPeriodId) {
  const pp = await db.prepare(`SELECT pp.id, pp.period_start, pp.period_end, pg.legal_entity_id
    FROM payroll_periods pp JOIN payroll_groups pg ON pg.id = pp.payroll_group_id WHERE pp.id = ?`).get(positiveId(payrollPeriodId));
  if (!pp) throw new A4Error('NOT_FOUND');
  const covering = await db.prepare(`SELECT id, start_date, end_date, status FROM attendance_periods
    WHERE legal_entity_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date ASC, id ASC`)
    .all(pp.legal_entity_id, pp.period_end, pp.period_start);
  const gaps = []; let cursor = pp.period_start;
  for (const c of covering) {
    if (c.start_date > cursor) gaps.push({ start_date: cursor, end_date: bt.addDays(c.start_date, -1) });
    const next = bt.addDays(c.end_date, 1);
    if (next > cursor) cursor = next;
  }
  if (cursor <= pp.period_end) gaps.push({ start_date: cursor, end_date: pp.period_end });
  return { payroll_period_id: pp.id, legal_entity_id: pp.legal_entity_id, period_start: pp.period_start,
    period_end: pp.period_end, covering, gaps, fully_covered: gaps.length === 0 };
}

module.exports = {
  STATUS, STATUSES, PERMISSION, ERRORS, ERROR_CODES, A4Error, mapError, mapped, assertBody,
  isValidDate, requireDate, optionalText, positiveId, paging, withActor,
  loadPeriod, getPeriod, listPeriods, listEvents, createPeriod, updateDetails, transition,
  payrollPeriodsFor, coverageFor,
};
