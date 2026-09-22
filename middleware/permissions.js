// middleware/permissions.js
// Loads a user's effective permissions (module -> [actions]) and project scope
// from SQLite, and provides a guard for backend route enforcement.
// RBAC is enforced HERE, server-side — never trust the frontend menu state.

const { getDb } = require('../database/init-db');

async function loadUserContext(userId) {
  const db = getDb();
  try {
    const user = await db
      .prepare('SELECT id, email, display_name, is_active FROM users WHERE id = ?')
      .get(userId);
    if (!user || !user.is_active) return null;

    const roles = await db
      .prepare(
        `SELECT r.code, r.name FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = ?`
      )
      .all(userId);

    const permRows = await db
      .prepare(
        `SELECT DISTINCT p.code AS module_code, rp.action
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         JOIN user_roles ur ON ur.role_id = rp.role_id
         WHERE ur.user_id = ?`
      )
      .all(userId);

    const permissions = {};
    for (const row of permRows) {
      if (!permissions[row.module_code]) permissions[row.module_code] = [];
      permissions[row.module_code].push(row.action);
    }

    const scopeRows = await db
      .prepare('SELECT project_code FROM user_project_scope WHERE user_id = ?')
      .all(userId);
    const projectScope = scopeRows.map((r) => r.project_code);

    // Phase 2I: legal-entity READ scope. Explicit rows only — an empty list
    // means the user can read no entity's payroll, whatever their role.
    // A VIEW permission alone never grants cross-entity visibility.
    const entityScope = (await db
      .prepare('SELECT legal_entity_id FROM user_legal_entity_scope WHERE user_id = ? ORDER BY legal_entity_id')
      .all(userId))
      .map((r) => r.legal_entity_id);

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      roles: roles.map((r) => r.code),
      roleNames: roles.map((r) => r.name),
      permissions,
      projectScope,
      entityScope,
    };
  } finally {
    db.close();
  }
}

function hasPermission(userContext, moduleCode, action = 'VIEW') {
  if (!userContext) return false;
  const actions = userContext.permissions[moduleCode];
  return Array.isArray(actions) && actions.includes(action);
}

/**
 * Express middleware factory: requirePermission('payroll_bpjs', 'EDIT')
 * Populates req.userContext for downstream handlers.
 */
function requirePermission(moduleCode, action = 'VIEW') {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Login required.' });
    }
    let userContext;
    try {
      userContext = await loadUserContext(req.session.userId);
    } catch (err) {
      console.error(`[rbac] loadUserContext failed for user #${req.session.userId} on ${moduleCode}:${action}:`, err.message);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
    if (!userContext) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Account inactive or not found.' });
    }
    req.userContext = userContext;
    if (!hasPermission(userContext, moduleCode, action)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied for ${moduleCode}:${action}.`,
      });
    }
    next();
  };
}

module.exports = { loadUserContext, hasPermission, requirePermission };
