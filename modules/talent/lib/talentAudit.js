// modules/talent/lib/talentAudit.js
// Talent/Worker security & access events → talent.audit_event (append-only).
// Scope is deliberately narrow: access to worker data and denials. Configuration changes of the
// existing platform stay in public.config_audit_log and are NOT duplicated here.
//
// Payloads are METADATA ONLY. A raw sensitive value (NIK, salary, bank account, medical diagnosis …)
// must never reach this table; the check below mirrors the database CHECK constraint
// talent.jsonb_has_forbidden_content, so an unsafe payload is refused twice.
// EXPORT_CSV added by TW0002 (Emergency Registration Intake V0 CSV export).
const EVENT_TYPES = Object.freeze(['VIEW_PASSPORT', 'VIEW_SENSITIVE_FIELD', 'PRINT_PASSPORT',
  'EXPORT_PDF', 'DOWNLOAD_DOCUMENT', 'PERMISSION_DENIED', 'EXPORT_CSV']);
const OUTCOMES = Object.freeze(['ALLOWED', 'DENIED']);

const FORBIDDEN_EXACT = new Set(['nik', 'noktp', 'ktp', 'ktpno', 'nomorktp', 'npwp', 'bpjs', 'bpjsno', 'bpjskesehatanno',
  'bpjstkno', 'password', 'passwordhash', 'value', 'rawvalue', 'oldvalue', 'newvalue', 'medical', 'mcuresult']);
const FORBIDDEN_PARTS = ['salary', 'gaji', 'wage', 'dailyrate', 'bankaccount', 'accountnumber', 'rekening', 'diagnos'];
const NIK_SHAPE = /[0-9]{16}/;

class TalentAuditError extends Error {
  constructor(code, detail) { super(code); this.name = 'TalentAuditError'; this.code = code; this.detail = detail; }
}

function normaliseKey(k) { return String(k).replace(/[^A-Za-z0-9]/g, '').toLowerCase(); }

/** Returns the JSON path of the first unsafe key/value, or null when the payload is metadata only. */
function findUnsafeContent(value, pathSoFar = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findUnsafeContent(value[i], `${pathSoFar}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const nk = normaliseKey(k);
      if (FORBIDDEN_EXACT.has(nk) || FORBIDDEN_PARTS.some((p) => nk.includes(p))) return `${pathSoFar}.${k}`;
      const hit = findUnsafeContent(v, `${pathSoFar}.${k}`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'string' && NIK_SHAPE.test(value)) return pathSoFar;
  return null;
}

function assertSafePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TalentAuditError('TALENT_AUDIT_INVALID_PAYLOAD', { reason: 'payload must be an object' });
  }
  const hit = findUnsafeContent(payload);
  // Only the location is reported — never the offending value.
  if (hit) throw new TalentAuditError('TALENT_AUDIT_UNSAFE_PAYLOAD', { path: hit });
}

/**
 * Append one event. Throws on an invalid event or unsafe payload, and on a database failure,
 * so a caller that must not proceed without an audit record (e.g. printing a passport) stops.
 */
async function recordEvent(db, { eventType, outcome, actorUserId = null, actorRoles = [], workerUuid = null,
  permissionCode = null, action = null, route = null, ip = null, payload = {} }) {
  if (!EVENT_TYPES.includes(eventType)) throw new TalentAuditError('TALENT_AUDIT_INVALID_EVENT', { eventType });
  if (!OUTCOMES.includes(outcome)) throw new TalentAuditError('TALENT_AUDIT_INVALID_OUTCOME', { outcome });
  assertSafePayload(payload);
  const row = await db.prepare(`INSERT INTO talent.audit_event
      (event_type, outcome, actor_user_id, actor_role_codes, worker_uuid, permission_code, action, route, ip_address, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING id`).get(
    eventType, outcome, actorUserId, actorRoles, workerUuid, permissionCode, action,
    route ? String(route).slice(0, 300) : null, ip ? String(ip).slice(0, 64) : null, JSON.stringify(payload));
  return row.id;
}

module.exports = { EVENT_TYPES, OUTCOMES, recordEvent, assertSafePayload, findUnsafeContent, TalentAuditError };
