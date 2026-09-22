// modules/talent/lib/fieldSecurity.js
// Field-level security for Talent/Worker records: FULL / MASKED / HIDDEN, decided on the server.
//
// Fail-closed by construction:
//   * a field that is not in talent.field_catalog is HIDDEN (dropped);
//   * a catalogued field with no policy row for any of the user's roles is HIDDEN;
//   * MASKED always returns a derived value — the raw value never leaves this module;
//   * a MASKED field whose catalogue rule is NONE is fully redacted.
// With several roles, the most permissive visibility among them applies (roles are additive grants).
const RANK = Object.freeze({ HIDDEN: 0, MASKED: 1, FULL: 2 });
const REDACTED = '*****';

async function loadCatalog(db) {
  const rows = await db.prepare('SELECT field_code, category, sensitivity, mask_rule FROM talent.field_catalog').all();
  return new Map(rows.map((r) => [r.field_code, r]));
}

async function loadPolicy(db, roleCodes) {
  const policy = new Map();
  if (!roleCodes || !roleCodes.length) return policy;
  const rows = await db.prepare(`SELECT field_code, visibility FROM talent.field_policy WHERE role_code = ANY(?::text[])`).all(roleCodes);
  for (const r of rows) {
    const prev = policy.get(r.field_code);
    if (!prev || RANK[r.visibility] > RANK[prev]) policy.set(r.field_code, r.visibility);
  }
  return policy;
}

function visibilityOf(fieldCode, { catalog, policy }) {
  if (!catalog.has(fieldCode)) return 'HIDDEN';
  return policy.get(fieldCode) || 'HIDDEN';
}

function mask(value, rule) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  switch (rule) {
    case 'LAST4': {
      const digits = s.replace(/\s+/g, '');
      if (digits.length <= 4) return REDACTED;
      return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
    }
    case 'PHONE': {
      const d = s.replace(/[^0-9+]/g, '');
      if (d.length <= 4) return REDACTED;
      return `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
    }
    case 'EMAIL': {
      const at = s.indexOf('@');
      if (at < 1) return REDACTED;
      return `${s[0]}***${s.slice(at)}`;
    }
    case 'YEAR_ONLY': {
      const m = /^(\d{4})-\d{2}-\d{2}/.exec(s);
      return m ? m[1] : REDACTED;
    }
    case 'REDACT':
    case 'NONE':
    default:
      return REDACTED;
  }
}

/**
 * Apply the policy to a flat record. Returns { data, visibility, revealedSensitive }:
 *   data              — only FULL fields (raw) and MASKED fields (derived); HIDDEN fields are absent
 *   visibility        — field_code → FULL | MASKED for every field that was returned
 *   revealedSensitive — SENSITIVE/RESTRICTED field codes returned FULL (for VIEW_SENSITIVE_FIELD audit)
 */
function applyFieldSecurity(record, { catalog, policy }) {
  const data = {};
  const visibility = {};
  const revealedSensitive = [];
  for (const [field, value] of Object.entries(record || {})) {
    const v = visibilityOf(field, { catalog, policy });
    if (v === 'HIDDEN') continue;
    const entry = catalog.get(field);
    if (v === 'FULL') {
      data[field] = value;
      if (entry.sensitivity === 'SENSITIVE' || entry.sensitivity === 'RESTRICTED') revealedSensitive.push(field);
    } else {
      data[field] = mask(value, entry.mask_rule);
    }
    visibility[field] = v;
  }
  return { data, visibility, revealedSensitive };
}

async function loadFieldSecurity(db, roleCodes) {
  const [catalog, policy] = await Promise.all([loadCatalog(db), loadPolicy(db, roleCodes)]);
  return { catalog, policy };
}

module.exports = { RANK, REDACTED, loadCatalog, loadPolicy, loadFieldSecurity, visibilityOf, mask, applyFieldSecurity };
