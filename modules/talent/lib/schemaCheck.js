// modules/talent/lib/schemaCheck.js
// Is the Talent schema present and exactly at the version this code expects?
// The core server must keep working when it is not: only /api/tw/* and /tw/app/* answer 503.
// Checked on every Talent request (one indexed read of a tiny ledger) — nothing is cached, so applying
// or rolling back the Talent stream on a running server takes effect immediately, without a restart.
const { getDb } = require('../../../database/db');
const { listTalentMigrations } = require('../../../database/pg/talent/migrate-talent');

let expectedCache = null;

function expected() {
  if (!expectedCache) expectedCache = listTalentMigrations().map((m) => ({ version: m.version, checksum: m.checksum }));
  return expectedCache;
}

async function checkTalentSchema(db = getDb()) {
  let rows;
  try {
    rows = await db.prepare('SELECT version, checksum FROM talent.schema_migrations ORDER BY version').all();
  } catch (err) {
    return { ready: false, reason: 'TALENT_SCHEMA_MISSING' };
  }
  const have = new Map(rows.map((r) => [r.version, r.checksum]));
  const exp = expected();
  const missing = exp.filter((m) => !have.has(m.version)).map((m) => m.version);
  if (missing.length) return { ready: false, reason: 'TALENT_SCHEMA_BEHIND', pending: missing };
  const drift = exp.filter((m) => have.get(m.version) !== m.checksum).map((m) => m.version);
  if (drift.length) return { ready: false, reason: 'TALENT_SCHEMA_DRIFT', drift };
  const unknown = rows.filter((r) => !exp.some((m) => m.version === r.version)).map((r) => r.version);
  if (unknown.length) return { ready: false, reason: 'TALENT_SCHEMA_AHEAD', unknown };
  return { ready: true, version: exp.length ? exp[exp.length - 1].version : null };
}

async function isTalentReady() { return checkTalentSchema(); }

/** Express middleware for every Talent route. Never touches anything outside schema `talent`. */
function requireTalentSchema(kind = 'api') {
  return async (req, res, next) => {
    const r = await isTalentReady();
    if (r.ready) return next();
    res.set('Retry-After', '30');
    if (kind === 'page') {
      return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>KAHE Talent</title>'
        + '<p style="font-family:sans-serif;padding:2rem">Modul Talent &amp; Worker belum siap: skema database Talent belum dimigrasikan. '
        + 'Jalankan <code>npm run db:migrate-talent</code>.</p>');
    }
    return res.status(503).json({ error: 'TALENT_SCHEMA_NOT_READY', detail: { reason: r.reason } });
  };
}

module.exports = { checkTalentSchema, isTalentReady, requireTalentSchema };
