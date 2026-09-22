// database/init-db.js
// DB-M1: this module used to open node:sqlite and create the schema. PostgreSQL
// is now the single authoritative database:
//   * the schema lives in versioned migrations (database/pg/migrations, `npm run db:migrate`);
//   * connections come from the pooled canonical layer (database/db.js).
// The module keeps its historical name and export surface so every caller —
// routes, libraries, scripts and the regression suites — imports exactly what it
// always did. The legacy SQLite schema is preserved, unchanged, in
// database/legacy-sqlite/ as migration source and reference only.
const core = require('./db');
const { assertSchemaCurrent } = require('./pg/migrate');

// Successor of SQLite busy_timeout: how long a writer waits on a row lock before
// failing cleanly (PostgreSQL lock_timeout), then bounded withRetry on top.
const BUSY_TIMEOUT_MS = core.LOCK_TIMEOUT_MS;

/** Credential-free description of the target database, for logs only. */
function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    return `postgresql://${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch (_) { return `postgresql://${process.env.PGHOST || '?'}/${process.env.PGDATABASE || '?'}`; }
}
const DB_PATH = describeTarget();

/**
 * Historically "create the schema if missing". The application must never alter
 * a PostgreSQL schema at start-up, so this VERIFIES that every migration has
 * been applied and throws an actionable error otherwise.
 */
async function initDb(db) { await assertSchemaCurrent(db); }

module.exports = {
  getDb: core.getDb, initDb, withTransaction: core.withTransaction, withRetry: core.withRetry,
  isRetryableLockError: core.isRetryableLockError, closeDb: core.closeDb,
  BUSY_TIMEOUT_MS, MAX_WRITE_ATTEMPTS: core.MAX_WRITE_ATTEMPTS, DB_PATH,
};
