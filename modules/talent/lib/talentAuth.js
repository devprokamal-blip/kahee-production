// modules/talent/lib/talentAuth.js
// Authorization for the Talent & Worker V1 bounded context.
//
//   existing login / session  →  existing loadUserContext (who, active, role codes)
//                             →  Talent grants (talent.role_permission) + Talent scope (talent.user_scope)
//
// There is no second authentication system. Talent grants live in the Talent schema so that
// (a) re-running database/seed.js never wipes them, and (b) no role — the Operations Director
// included — inherits Talent rights implicitly. Hiding a menu item is UX; these guards are the control.
const { getDb } = require('../../../database/db');
const { loadUserContext } = require('../../../middleware/permissions');
const { recordEvent } = require('./talentAudit');

const ACTIONS = Object.freeze(['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT', 'ADMIN']);

async function loadTalentGrants(db, roleCodes) {
  if (!roleCodes.length) return {};
  const rows = await db.prepare(`SELECT permission_code, action FROM talent.role_permission
    WHERE role_code = ANY(?::text[]) ORDER BY permission_code, action`).all(roleCodes);
  const grants = {};
  for (const r of rows) {
    if (!grants[r.permission_code]) grants[r.permission_code] = [];
    if (!grants[r.permission_code].includes(r.action)) grants[r.permission_code].push(r.action);
  }
  return grants;
}

async function loadScopeRows(db, userId) {
  return db.prepare('SELECT scope_type, scope_value FROM talent.user_scope WHERE user_id = ? ORDER BY id').all(userId);
}

/** Full Talent context for a logged-in user id, or null if the account is inactive/unknown. */
async function loadTalentContext(userId) {
  const user = await loadUserContext(userId);
  if (!user) return null;
  const db = getDb();
  try {
    const grants = await loadTalentGrants(db, user.roles);
    const scopeRows = await loadScopeRows(db, user.id);
    return { userId: user.id, displayName: user.displayName, roles: user.roles, roleNames: user.roleNames, grants, scopeRows };
  } finally { db.close(); }
}

function can(ctx, permissionCode, action = 'VIEW') {
  if (!ctx || !ACTIONS.includes(action)) return false;
  const a = ctx.grants[permissionCode];
  return Array.isArray(a) && a.includes(action);
}

function routeOf(req) { return String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300); }

async function auditDenied(req, ctx, permissionCode, action) {
  try {
    const db = getDb();
    try {
      await recordEvent(db, { eventType: 'PERMISSION_DENIED', outcome: 'DENIED', actorUserId: ctx ? ctx.userId : null,
        actorRoles: ctx ? ctx.roles : [], permissionCode, action, route: routeOf(req), ip: req.ip,
        payload: { method: req.method, reason: 'MISSING_TALENT_GRANT' } });
    } finally { db.close(); }
  } catch (err) {
    // The request is denied either way; a failed denial record is reported, never swallowed silently.
    console.error('[talent] PERMISSION_DENIED audit failed:', err.code || err.message);
  }
}

/**
 * Guard factory.
 *   kind 'api'  → 401 JSON / 403 JSON
 *   kind 'page' → redirect to the existing login page / 403 page
 * permissionCode null = authentication only (used by /api/tw/me to render the navigation).
 */
function requireTalent(permissionCode, action = 'VIEW', kind = 'api') {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      if (kind === 'page') return res.redirect('/login.html');
      return res.status(401).json({ error: 'UNAUTHENTICATED', detail: {} });
    }
    let ctx;
    try { ctx = await loadTalentContext(req.session.userId); } catch (err) {
      console.error('[talent] context load failed:', err.code || err.message);
      return kind === 'page' ? res.status(500).send('Internal error') : res.status(500).json({ error: 'INTERNAL_ERROR', detail: {} });
    }
    if (!ctx) {
      req.session.destroy(() => {});
      if (kind === 'page') return res.redirect('/login.html');
      return res.status(401).json({ error: 'UNAUTHENTICATED', detail: {} });
    }
    req.talent = ctx;
    if (permissionCode === null || can(ctx, permissionCode, action)) return next();
    await auditDenied(req, ctx, permissionCode, action);
    if (kind === 'page') return res.status(403).type('html').send(forbiddenPage());
    return res.status(403).json({ error: 'FORBIDDEN', detail: { permission: permissionCode, action } });
  };
}

function forbiddenPage() {
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Akses ditolak — KAHE Talent</title><link rel="stylesheet" href="/tw-assets/tw-shell.css"></head>'
    + '<body class="tw-plain"><main class="tw-denied"><h1>Akses ditolak</h1>'
    + '<p>Akun Anda tidak memiliki izin untuk halaman ini. Hubungi administrator bila Anda memerlukan akses.</p>'
    + '<p><a href="/tw/app/">Kembali ke beranda Talent</a> · <a href="/index.html">Portal KAHE 360</a></p></main></body></html>';
}

module.exports = { ACTIONS, loadTalentContext, loadTalentGrants, can, requireTalent };
