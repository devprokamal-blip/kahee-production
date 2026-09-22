// modules/talent/lib/identity.js
// One worker = one digital identity. worker_uuid is the canonical internal key;
// display IDs are human labels issued at most once per type and never changed:
//   REGISTRATION → KAHE-TAL-YYYY-NNNNNN   (YYYY = issue year in WIB, Asia/Jakarta)
//   TALENT       → KAHE-T-NNNNNN
//   WORKER       → KAHE-W-NNNNNN
// Employer, client, position, project and assignment are NOT part of the identity.
const { withTransaction } = require('../../../database/db');

const ID_TYPES = Object.freeze(['REGISTRATION', 'TALENT', 'WORKER']);
const SEQUENCE = Object.freeze({ REGISTRATION: 'talent.seq_tal', TALENT: 'talent.seq_t', WORKER: 'talent.seq_w' });
const FORMAT = Object.freeze({
  REGISTRATION: /^KAHE-TAL-\d{4}-\d{6}$/,
  TALENT: /^KAHE-T-\d{6}$/,
  WORKER: /^KAHE-W-\d{6}$/,
});
const MAX_SEQ = 999999;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class TalentIdentityError extends Error {
  constructor(code, detail = {}) { super(code); this.name = 'TalentIdentityError'; this.code = code; this.detail = detail; }
}

function wibYear(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(date));
}

function formatDisplayId(idType, n, year) {
  if (!ID_TYPES.includes(idType)) throw new TalentIdentityError('TALENT_INVALID_ID_TYPE', { idType });
  if (!Number.isInteger(n) || n < 1) throw new TalentIdentityError('TALENT_INVALID_SEQUENCE', {});
  if (n > MAX_SEQ) throw new TalentIdentityError('TALENT_DISPLAY_ID_SPACE_EXHAUSTED', { idType });
  const num = String(n).padStart(6, '0');
  if (idType === 'REGISTRATION') {
    if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new TalentIdentityError('TALENT_INVALID_YEAR', {});
    return `KAHE-TAL-${year}-${num}`;
  }
  return idType === 'TALENT' ? `KAHE-T-${num}` : `KAHE-W-${num}`;
}

function isValidDisplayId(idType, displayId) {
  return ID_TYPES.includes(idType) && FORMAT[idType].test(String(displayId));
}

async function createWorker(db, { actorUserId = null } = {}) {
  const row = await db.prepare(`INSERT INTO talent.worker (created_by_user_id) VALUES (?)
    RETURNING worker_uuid, lifecycle_status, created_at`).get(actorUserId);
  return row;
}

/** Issue one display ID of `idType` for a worker. Atomic; a second ID of the same type is refused. */
async function issueDisplayId(db, workerUuid, idType, { actorUserId = null, now = new Date() } = {}) {
  if (!ID_TYPES.includes(idType)) throw new TalentIdentityError('TALENT_INVALID_ID_TYPE', { idType });
  if (!UUID_RE.test(String(workerUuid))) throw new TalentIdentityError('TALENT_INVALID_WORKER_UUID', {});
  return withTransaction(db, async () => {
    const worker = await db.prepare('SELECT worker_uuid FROM talent.worker WHERE worker_uuid = ?::uuid').get(workerUuid);
    if (!worker) throw new TalentIdentityError('TALENT_WORKER_NOT_FOUND', {});
    const existing = await db.prepare('SELECT display_id FROM talent.worker_display_id WHERE worker_uuid = ?::uuid AND id_type = ?')
      .get(workerUuid, idType);
    if (existing) throw new TalentIdentityError('TALENT_DISPLAY_ID_ALREADY_ISSUED', { idType });
    let n;
    try {
      n = Number((await db.prepare(`SELECT nextval('${SEQUENCE[idType]}') AS n`).get()).n);
    } catch (err) {
      if (err.code === '2200H') throw new TalentIdentityError('TALENT_DISPLAY_ID_SPACE_EXHAUSTED', { idType });
      throw err;
    }
    const displayId = formatDisplayId(idType, n, wibYear(now));
    try {
      return await db.prepare(`INSERT INTO talent.worker_display_id (worker_uuid, id_type, display_id, issued_by_user_id)
        VALUES (?::uuid, ?, ?, ?) RETURNING worker_uuid, id_type, display_id, issued_at`).get(workerUuid, idType, displayId, actorUserId);
    } catch (err) {
      if (err.code === '23505') throw new TalentIdentityError('TALENT_DISPLAY_ID_ALREADY_ISSUED', { idType });
      throw err;
    }
  });
}

async function getDisplayIds(db, workerUuid) {
  if (!UUID_RE.test(String(workerUuid))) return [];
  return db.prepare(`SELECT id_type, display_id, issued_at FROM talent.worker_display_id
    WHERE worker_uuid = ?::uuid ORDER BY CASE id_type WHEN 'REGISTRATION' THEN 1 WHEN 'TALENT' THEN 2 ELSE 3 END`).all(workerUuid);
}

module.exports = { ID_TYPES, MAX_SEQ, TalentIdentityError, wibYear, formatDisplayId, isValidDisplayId,
  createWorker, issueDisplayId, getDisplayIds };
