// lib/attendanceClosingPolicy.js — Attendance A4 CP1
// Effective-dated, Legal-Entity-scoped Closing Policy (the rule surface CP2 readiness will read).
//
// Lifecycle (database-enforced, migration 0006):
//   DRAFT (editable, rules editable) -> ACTIVE (immutable) -> ENDED (effective_to set once; terminal)
//   DRAFT -> DISCARDED (terminal). No policy row is ever deleted: its audit references it.
// Every material action writes one append-only attendance_closing_policy_events row (by trigger).
// No default policy is seeded or invented: with no ACTIVE/ENDED version in force the answer is
// NO_CLOSING_POLICY.
const exceptionLib = require('./attendanceException');
const entityScope = require('./entityScope');   // FROZEN — called, never modified
const ap = require('./attendancePeriod');

const { A4Error, assertBody, requireDate, optionalText, positiveId, paging, withActor, mapped } = ap;

const STATUS = { DRAFT: 'DRAFT', ACTIVE: 'ACTIVE', ENDED: 'ENDED', DISCARDED: 'DISCARDED' };
const STATUSES = Object.values(STATUS);
const SEVERITIES = ['BLOCKER', 'WARNING', 'INFORMATIONAL'];
const PERMISSION = {
  CREATE: 'attendance_closing_policy:CREATE',
  EDIT: 'attendance_closing_policy:EDIT',
  ADMIN: 'attendance_closing_policy:ADMIN',
};

// Configurable issue codes — ONLY states that exist today (A1–A3). CP2 wires them into readiness.
const ISSUE_CODES = Object.freeze([
  ...Object.values(exceptionLib.TYPES),          // the 10 real A3 exception types
  'PENDING_OVERTIME_APPROVAL',                   // timesheet_entries.overtime_status = 'pending'
  'PENDING_ATTENDANCE_CORRECTION',               // A3 SUBMITTED / UNDER_REVIEW / APPROVED-not-applied / VOID_*
  'PENDING_PAYROLL_REVIEW',                      // A3 attendance_corrections.status
  'MISSING_ATTENDANCE',
  'UNRESOLVED_SCHEDULE',
  'UNCLASSIFIED_DAY_TYPE',
]);
// Fixed blockers: never configurable, never waivable (CP2 enforces them).
const FIXED_BLOCKERS = Object.freeze(['TIMESHEET_LEGAL_ENTITY_UNRESOLVED']);

const FLAG_FIELDS = ['sod_waiver_blocks_freeze', 'require_waiver_reason', 'require_waiver_evidence'];
function flag(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new A4Error('REQUEST_FIELD_INVALID', { field });
}
const meta = (route, id = null) => ({ resourceType: 'attendance_closing_policy', resourceId: id, route });

async function loadPolicy(db, id) {
  return db.prepare('SELECT * FROM attendance_closing_policies WHERE id = ?').get(positiveId(id));
}
async function rulesOf(db, policyId) {
  return db.prepare(`SELECT issue_code, severity, waivable, evidence_required FROM attendance_closing_policy_rules
    WHERE policy_id = ? ORDER BY issue_code ASC`).all(policyId);
}
async function getPolicy(db, userContext, id, route = null) {
  const row = await loadPolicy(db, id);
  if (!row) throw new A4Error('NOT_FOUND');
  await mapped(() => entityScope.assertEntityAccess(db, userContext, row.legal_entity_id, meta(route, row.id)));
  return row;
}
async function getPolicyWithRules(db, userContext, id, route = null) {
  const p = await getPolicy(db, userContext, id, route);
  return { ...p, rules: await rulesOf(db, p.id) };
}

async function listPolicies(db, userContext, query = {}, route = null) {
  const { limit, offset } = paging(query);
  const scope = await entityScope.scopeClause(db, userContext, 'legal_entity_id', meta(route));
  const where = [scope.sql]; const params = [...scope.params];
  if (query.legal_entity_id !== undefined) { where.push('legal_entity_id = ?'); params.push(String(query.legal_entity_id)); }
  if (query.status !== undefined) {
    if (!STATUSES.includes(query.status)) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'status' });
    where.push('status = ?'); params.push(query.status);
  }
  const w = where.join(' AND ');
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM attendance_closing_policies WHERE ${w}`).get(...params)).n;
  const items = await db.prepare(`SELECT * FROM attendance_closing_policies WHERE ${w}
    ORDER BY legal_entity_id ASC, version_no ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { items, total, limit, offset };
}

async function listPolicyEvents(db, userContext, id, route = null) {
  const p = await getPolicy(db, userContext, id, route);
  return db.prepare('SELECT * FROM attendance_closing_policy_events WHERE policy_id = ? ORDER BY id ASC').all(p.id);
}

/** The version in force for `entity` on `date` (ACTIVE or ENDED), with its rules; null if none. */
async function resolvePolicy(db, legalEntityId, date) {
  const p = await db.prepare(`SELECT * FROM attendance_closing_policies
    WHERE legal_entity_id = ? AND status IN ('ACTIVE','ENDED') AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY version_no DESC LIMIT 1`).get(legalEntityId, date, date);
  if (!p) return null;
  return { ...p, rules: await rulesOf(db, p.id) };
}
async function resolveForUser(db, userContext, query = {}, route = null) {
  if (typeof query.legal_entity_id !== 'string' || !query.legal_entity_id) throw new A4Error('REQUEST_FIELD_REQUIRED', { field: 'legal_entity_id' });
  const date = requireDate(query.date, 'date');
  await mapped(() => entityScope.assertEntityAccess(db, userContext, query.legal_entity_id, meta(route)));
  const p = await resolvePolicy(db, query.legal_entity_id, date);
  if (!p) throw new A4Error('NO_CLOSING_POLICY', { legal_entity_id: query.legal_entity_id, date });
  return p;
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------
async function createPolicy(db, userContext, body, route = null) {
  const b = assertBody(body, ['legal_entity_id', 'effective_from', ...FLAG_FIELDS], ['legal_entity_id', 'effective_from']);
  if (typeof b.legal_entity_id !== 'string') throw new A4Error('REQUEST_FIELD_INVALID', { field: 'legal_entity_id' });
  const from = requireDate(b.effective_from, 'effective_from');
  const flags = FLAG_FIELDS.map((f) => (b[f] === undefined ? null : flag(b[f], f)));
  await mapped(() => entityScope.assertEntityAccess(db, userContext, b.legal_entity_id, meta(route)));
  return mapped(() => withActor(db, userContext, PERMISSION.CREATE, null, async () =>
    db.prepare(`INSERT INTO attendance_closing_policies (legal_entity_id, effective_from, sod_waiver_blocks_freeze,
      require_waiver_reason, require_waiver_evidence)
      VALUES (?, ?, COALESCE(?::bigint, 1), COALESCE(?::bigint, 1), COALESCE(?::bigint, 0)) RETURNING *`)
      .get(b.legal_entity_id, from, ...flags)));
}

async function updatePolicy(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['effective_from', ...FLAG_FIELDS]);
  if (!Object.keys(b).length) throw new A4Error('REQUEST_FIELD_REQUIRED', { field: ['effective_from', ...FLAG_FIELDS].join('|') });
  const p = await getPolicy(db, userContext, id, route);
  const sets = []; const params = [];
  if (b.effective_from !== undefined) { sets.push('effective_from = ?'); params.push(requireDate(b.effective_from, 'effective_from')); }
  for (const f of FLAG_FIELDS) if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(flag(b[f], f)); }
  return mapped(() => withActor(db, userContext, PERMISSION.EDIT, null, async () =>
    db.prepare(`UPDATE attendance_closing_policies SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params, p.id)));
}

function validateRule(issueCode, b) {
  if (FIXED_BLOCKERS.includes(issueCode)) throw new A4Error('CLOSING_POLICY_ISSUE_CODE_NOT_CONFIGURABLE', { issue_code: issueCode });
  if (!ISSUE_CODES.includes(issueCode)) throw new A4Error('CLOSING_POLICY_ISSUE_CODE_UNKNOWN', { issue_code: issueCode });
  if (!SEVERITIES.includes(b.severity)) throw new A4Error('REQUEST_FIELD_INVALID', { field: 'severity' });
  const waivable = b.waivable === undefined ? 0 : flag(b.waivable, 'waivable');
  const evidence = b.evidence_required === undefined ? 0 : flag(b.evidence_required, 'evidence_required');
  if (b.severity !== 'BLOCKER' && (waivable || evidence)) throw new A4Error('CLOSING_POLICY_RULE_INVALID', { reason: 'WAIVER_ONLY_FOR_BLOCKER' });
  if (evidence && !waivable) throw new A4Error('CLOSING_POLICY_RULE_INVALID', { reason: 'EVIDENCE_REQUIRES_WAIVABLE' });
  return { severity: b.severity, waivable, evidence };
}

async function putRule(db, userContext, id, issueCode, body, route = null) {
  const b = assertBody(body, ['severity', 'waivable', 'evidence_required'], ['severity']);
  const r = validateRule(issueCode, b);
  const p = await getPolicy(db, userContext, id, route);
  return mapped(() => withActor(db, userContext, PERMISSION.EDIT, null, async () => {
    const existing = await db.prepare('SELECT id FROM attendance_closing_policy_rules WHERE policy_id = ? AND issue_code = ?').get(p.id, issueCode);
    if (existing) {
      await db.prepare('UPDATE attendance_closing_policy_rules SET severity = ?, waivable = ?, evidence_required = ? WHERE id = ?')
        .run(r.severity, r.waivable, r.evidence, existing.id);
    } else {
      await db.prepare(`INSERT INTO attendance_closing_policy_rules (policy_id, issue_code, severity, waivable, evidence_required)
        VALUES (?,?,?,?,?)`).run(p.id, issueCode, r.severity, r.waivable, r.evidence);
    }
    return { ...(await loadPolicy(db, p.id)), rules: await rulesOf(db, p.id) };
  }));
}

async function deleteRule(db, userContext, id, issueCode, route = null) {
  const p = await getPolicy(db, userContext, id, route);
  return mapped(() => withActor(db, userContext, PERMISSION.EDIT, null, async () => {
    const res = await db.prepare('DELETE FROM attendance_closing_policy_rules WHERE policy_id = ? AND issue_code = ?').run(p.id, issueCode);
    if (!res.changes) throw new A4Error('CLOSING_POLICY_RULE_NOT_FOUND', { issue_code: issueCode });
    return { ...(await loadPolicy(db, p.id)), rules: await rulesOf(db, p.id) };
  }));
}

async function changeStatus(db, userContext, id, to, permission, { effectiveTo = null, reason = null } = {}, route = null) {
  const p = await getPolicy(db, userContext, id, route);
  return mapped(() => withActor(db, userContext, permission, reason, async () => {
    const row = await db.prepare(`UPDATE attendance_closing_policies SET status = ?, effective_to = COALESCE(?::date, effective_to)
      WHERE id = ? RETURNING *`).get(to, effectiveTo, p.id);
    return { ...row, rules: await rulesOf(db, p.id) };
  }));
}
async function activatePolicy(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['reason']);
  return changeStatus(db, userContext, id, STATUS.ACTIVE, PERMISSION.ADMIN, { reason: optionalText(b.reason, 'reason', 1000) }, route);
}
async function endPolicy(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['effective_to', 'reason'], ['effective_to']);
  return changeStatus(db, userContext, id, STATUS.ENDED, PERMISSION.ADMIN,
    { effectiveTo: requireDate(b.effective_to, 'effective_to'), reason: optionalText(b.reason, 'reason', 1000) }, route);
}
async function discardPolicy(db, userContext, id, body, route = null) {
  const b = assertBody(body, ['reason']);
  return changeStatus(db, userContext, id, STATUS.DISCARDED, PERMISSION.EDIT, { reason: optionalText(b.reason, 'reason', 1000) }, route);
}

module.exports = {
  STATUS, STATUSES, SEVERITIES, PERMISSION, ISSUE_CODES, FIXED_BLOCKERS,
  loadPolicy, getPolicy, getPolicyWithRules, listPolicies, listPolicyEvents, resolvePolicy, resolveForUser,
  createPolicy, updatePolicy, putRule, deleteRule, activatePolicy, endPolicy, discardPolicy,
};
