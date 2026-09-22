// lib/entityScope.js
// Phase 2I — THE single authority for legal-entity read access.
//
// ============================================================
// POLICY (locked)
// ============================================================
// 1. A VIEW permission NEVER grants cross-entity visibility. RBAC answers
//    "may this person read payroll at all"; this module answers "whose".
//    Both must pass.
// 2. Access requires an explicit `user_legal_entity_scope` row — for every
//    role, including Operations Director. There is no implicit
//    "sees everything", because an implicit one is exactly what the
//    end-to-end audit found and flagged.
// 3. The only bypass is the `payroll_entity_override` permission module,
//    granted to no role by default and AUDITED on every use.
// 4. A direct-ID request for another entity's record returns **404, not
//    403**. Answering 403 confirms the id exists, which is itself a
//    disclosure and the basis of id enumeration. Denials are audited either
//    way, so the security team still sees the attempt even though the caller
//    cannot distinguish "not yours" from "not there".
//
// Nothing else in this codebase may re-implement these rules.

const OVERRIDE_MODULE = 'payroll_entity_override';

class EntityAccessError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'EntityAccessError';   // the global handler matches on this
    this.code = code;
    this.detail = detail;
  }
}

const ERROR = {
  // Deliberately named NOT_FOUND: routes surface it as 404 so a caller cannot
  // learn that the id exists in another entity.
  NOT_FOUND: 'NOT_FOUND',
  NO_ENTITY_SCOPE: 'NO_ENTITY_SCOPE',
};

/** Entities this user may read. Explicit rows only. */
async function getUserEntities(db, userId) {
  return (await db.prepare('SELECT legal_entity_id FROM user_legal_entity_scope WHERE user_id = ? ORDER BY legal_entity_id')
    .all(userId)).map((r) => r.legal_entity_id);
}

function hasOverride(userContext) {
  return ((userContext && userContext.permissions && userContext.permissions[OVERRIDE_MODULE]) || []).length > 0;
}

/** The scope in force for this request, from the context loaded at login. */
function scopeOf(userContext) {
  return Array.isArray(userContext && userContext.entityScope) ? userContext.entityScope : [];
}

async function audit(db, userContext, { outcome, resourceType, resourceId, requestedEntity, route }) {
  await db.prepare(`
    INSERT INTO entity_access_audit (user_id, actor, outcome, resource_type, resource_id,
      requested_entity, authorized_scope, route, occurred_at)
    VALUES (?,?,?,?,?,?,?,?, kahe_now())
  `).run(
    userContext.id ?? null,
    userContext.displayName || 'unknown',
    outcome,
    resourceType,
    resourceId === null || resourceId === undefined ? null : String(resourceId),
    requestedEntity ?? null,
    JSON.stringify(scopeOf(userContext)),
    route ?? null
  );
}

/**
 * May this user read a record belonging to `entityId`?
 * Returns true/false and audits anything that is not a plain in-scope read.
 */
async function canAccessEntity(db, userContext, entityId, meta = {}) {
  const scope = scopeOf(userContext);
  if (entityId && scope.includes(entityId)) return true;

  if (hasOverride(userContext)) {
    await audit(db, userContext, { outcome: 'OVERRIDE_ALLOWED', requestedEntity: entityId, ...meta });
    return true;
  }
  await audit(db, userContext, { outcome: 'DENIED', requestedEntity: entityId, ...meta });
  return false;
}

/**
 * Guard a direct-ID read. Throws NOT_FOUND on a cross-entity attempt, so the
 * caller cannot distinguish it from a genuinely absent record.
 */
async function assertEntityAccess(db, userContext, entityId, meta = {}) {
  if (!await canAccessEntity(db, userContext, entityId, meta)) {
    throw new EntityAccessError(ERROR.NOT_FOUND, 'Data tidak ditemukan.', null);
  }
  return true;
}

/**
 * SQL fragment for LIST queries, so enumeration is impossible rather than
 * merely filtered after the fact.
 *
 * Returns `{ sql, params }`. When the user holds the override, the filter is
 * a no-op and the use is audited once for the request.
 * When the user has NO scope at all, the filter matches nothing — a user
 * without an explicit grant sees nothing, which is the whole point.
 */
async function scopeClause(db, userContext, column = 'legal_entity_id', meta = {}) {
  if (hasOverride(userContext)) {
    await audit(db, userContext, { outcome: 'OVERRIDE_ALLOWED', requestedEntity: null, ...meta });
    return { sql: '1=1', params: [] };
  }
  const scope = scopeOf(userContext);
  if (scope.length === 0) {
    await audit(db, userContext, { outcome: 'DENIED', requestedEntity: null, ...meta });
    return { sql: '1=0', params: [] };
  }
  return { sql: `${column} IN (${scope.map(() => '?').join(',')})`, params: [...scope] };
}

/**
 * Resolve the legal entity a payroll resource belongs to, for resources that
 * do not carry the column directly. One lookup table keeps the mapping in a
 * single place rather than scattered through route handlers.
 */
const RESOURCE_ENTITY_SQL = {
  payroll_run: 'SELECT legal_entity_id FROM payroll_runs WHERE id = ?',
  payroll_run_line: 'SELECT legal_entity_id FROM payroll_run_lines WHERE id = ?',
  payslip: 'SELECT legal_entity_id FROM payroll_payslips WHERE id = ?',
  payment_batch: 'SELECT legal_entity_id FROM payroll_payment_batches WHERE id = ?',
  payment_item: 'SELECT legal_entity_id FROM payroll_payment_items WHERE id = ?',
  snapshot: 'SELECT legal_entity_id FROM payroll_input_snapshots WHERE id = ?',
  exception: 'SELECT legal_entity_id FROM payroll_exceptions WHERE id = ?',
  adjustment: 'SELECT legal_entity_id FROM payroll_adjustments WHERE id = ?',
  payroll_period: `SELECT g.legal_entity_id FROM payroll_periods p
                   JOIN payroll_groups g ON g.id = p.payroll_group_id WHERE p.id = ?`,
  payroll_group: 'SELECT legal_entity_id FROM payroll_groups WHERE id = ?',
  employee: `SELECT a.legal_entity_id FROM employee_payroll_assignments a
             WHERE a.employee_id = ? ORDER BY a.effective_date DESC LIMIT 1`,
};

async function resolveResourceEntity(db, resourceType, resourceId) {
  const sql = RESOURCE_ENTITY_SQL[resourceType];
  if (!sql) throw new Error(`entityScope: unknown resource type ${resourceType}`);
  const row = await db.prepare(sql).get(resourceId);
  return row ? row.legal_entity_id : null;
}

/**
 * The guard routes use: look the resource up, and refuse with NOT_FOUND both
 * when it does not exist AND when it belongs to another entity — the caller
 * cannot tell which.
 */
async function assertResourceAccess(db, userContext, resourceType, resourceId, route = null) {
  const entityId = await resolveResourceEntity(db, resourceType, resourceId);
  if (entityId === null) {
    // Genuinely absent. Not audited as a cross-entity attempt, because it is not one.
    throw new EntityAccessError(ERROR.NOT_FOUND, 'Data tidak ditemukan.');
  }
  await assertEntityAccess(db, userContext, entityId, { resourceType, resourceId, route });
  return entityId;
}

/** Grant / revoke, for administration. */
async function grantEntity(db, userId, legalEntityId, grantedBy, note = null) {
  await db.prepare(`INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by, note)
              VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).run(userId, legalEntityId, grantedBy, note);
  return await getUserEntities(db, userId);
}
async function revokeEntity(db, userId, legalEntityId) {
  await db.prepare('DELETE FROM user_legal_entity_scope WHERE user_id = ? AND legal_entity_id = ?')
    .run(userId, legalEntityId);
  return await getUserEntities(db, userId);
}

module.exports = {
  OVERRIDE_MODULE, ERROR, EntityAccessError,
  getUserEntities, hasOverride, scopeOf, canAccessEntity, assertEntityAccess,
  scopeClause, resolveResourceEntity, assertResourceAccess, audit,
  grantEntity, revokeEntity, RESOURCE_ENTITY_SQL,
};
