// modules/talent/lib/dataScope.js
// Data scope for Talent/Worker records. No scope row = no data.
// CP1 honours scope_type ALL only. ORGANIZATION and PROJECT rows are recognised and reported,
// but grant nothing until the checkpoint that owns organisations/projects enables them —
// in particular the platform's project scope (public.user_project_scope) is NOT reused, because
// Project/Workfront scope enforcement is still PARTIAL in the core platform.
const ENABLED_SCOPE_TYPES = Object.freeze(['ALL']);
const KNOWN_SCOPE_TYPES = Object.freeze(['ALL', 'ORGANIZATION', 'PROJECT']);

function resolveScope(rows) {
  const scope = { all: false, organizations: [], projects: [], pending: [] };
  for (const r of rows || []) {
    if (!KNOWN_SCOPE_TYPES.includes(r.scope_type)) continue;
    if (r.scope_type === 'ALL') scope.all = true;
    else if (r.scope_type === 'ORGANIZATION') scope.organizations.push(r.scope_value);
    else if (r.scope_type === 'PROJECT') scope.projects.push(r.scope_value);
    if (!ENABLED_SCOPE_TYPES.includes(r.scope_type)) scope.pending.push(r.scope_type);
  }
  scope.pending = [...new Set(scope.pending)];
  return scope;
}

/**
 * Decide access to one resource. Returns { allowed, reason }.
 * resource: { organization?: string, project?: string } — the owning context of the record.
 */
function checkScope(scope, resource = {}) {
  if (!scope) return { allowed: false, reason: 'NO_SCOPE' };
  if (scope.all) return { allowed: true, reason: 'SCOPE_ALL' };
  const matches = (resource.organization && scope.organizations.includes(resource.organization))
    || (resource.project && scope.projects.includes(resource.project));
  if (matches) return { allowed: false, reason: 'SCOPE_TYPE_NOT_ENABLED' };
  return { allowed: false, reason: scope.organizations.length || scope.projects.length ? 'OUT_OF_SCOPE' : 'NO_SCOPE' };
}

function summarizeScope(scope) {
  return { all: scope.all, pending_scope_types: scope.pending };
}

module.exports = { ENABLED_SCOPE_TYPES, KNOWN_SCOPE_TYPES, resolveScope, checkScope, summarizeScope };
