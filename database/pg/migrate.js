// database/pg/migrate.js
// DB-M1 — the authoritative PostgreSQL migration path.
//
//   node database/pg/migrate.js            apply pending migrations
//   node database/pg/migrate.js status     list applied / pending, change nothing
//   node database/pg/migrate.js --dry-run  same as status, exit 0
//
// Guarantees:
//   * ordered by numeric file prefix; every file runs in ITS OWN transaction and
//     its schema_migrations row is written in that SAME transaction — a failed
//     migration leaves no partial schema and no version row;
//   * an applied migration is never re-run; an applied file whose checksum has
//     changed aborts the run (history must not be rewritten — add a new file);
//   * a session advisory lock stops two deployers migrating at once;
//   * the application NEVER migrates at startup; the server only verifies that
//     the schema is current (see assertSchemaCurrent).
// Migrations create STRUCTURE only. They never invent business policy or data.
//
// Connection: DATABASE_MIGRATION_URL (schema owner) — falls back to DATABASE_URL
// for single-role development setups. KAHE_DB_APP_ROLE, when set, receives the
// least-privilege runtime grants after migrating.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 360001;
const IDENT = /^[a-z_][a-z0-9_]*$/;

function listMigrations(dir = DIR) {
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const seen = new Set();
  return files.map((file) => {
    const version = file.slice(0, 4);
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version, name: file.replace(/\.sql$/, ''), file, sql,
      checksum: crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
  });
}

async function ensureLedger(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT NOT NULL DEFAULT current_user,
    execution_ms BIGINT NOT NULL)`);
}

async function plan(client, dir) {
  const all = listMigrations(dir);
  const applied = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows
    .map((r) => [r.version, r.checksum]));
  for (const m of all) {
    if (applied.has(m.version) && applied.get(m.version) !== m.checksum) {
      throw new Error(`Migration ${m.file} was modified after it was applied. Never edit an applied migration; add a new one.`);
    }
  }
  const known = new Set(all.map((m) => m.version));
  const unknown = [...applied.keys()].filter((v) => !known.has(v));
  if (unknown.length) throw new Error(`Database has migrations this code does not know: ${unknown.join(', ')} (older code against a newer database?)`);
  const pending = all.filter((m) => !applied.has(m.version));
  const lastApplied = [...applied.keys()].sort().pop();
  const outOfOrder = pending.filter((m) => lastApplied && m.version < lastApplied);
  if (outOfOrder.length) throw new Error(`Out-of-order migration(s): ${outOfOrder.map((m) => m.file).join(', ')}`);
  return { all, applied, pending };
}

async function preflight(client) {
  const v = (await client.query('SHOW server_version_num')).rows[0].server_version_num;
  if (Number(v) < 130000) throw new Error(`PostgreSQL 13+ required (found ${v})`);
  const c = (await client.query('SELECT datcollate FROM pg_database WHERE datname = current_database()')).rows[0];
  // Text ordering parity with A3 (SQLite BINARY collation) requires byte-order collation.
  if (!['C', 'POSIX'].includes(c.datcollate) && process.env.KAHE_DB_ALLOW_NON_C_COLLATION !== 'true') {
    throw new Error(`Database collation is "${c.datcollate}". KAHE 360 requires LC_COLLATE 'C' so text ordering matches the `
      + `verified baseline. Create the database with: TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' `
      + `(npm run db:bootstrap does this), or set KAHE_DB_ALLOW_NON_C_COLLATION=true to accept different ordering.`);
  }
}

async function grantRuntime(client, role) {
  if (!IDENT.test(role)) throw new Error('KAHE_DB_APP_ROLE must be a plain lowercase identifier');
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
  if (!exists) throw new Error(`Runtime role "${role}" does not exist (create it first; see docs/POSTGRES_MIGRATION_RUNBOOK.md)`);
  // DML only. No TRUNCATE, no DDL, no ownership: the runtime cannot drop or
  // disable the integrity triggers, and cannot touch the migration ledger.
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
}

async function migrate({ connectionString, appRole, dryRun = false, log = console.log, dir = DIR } = {}) {
  const url = connectionString || process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (or DATABASE_URL) before migrating.');
  const client = new Client({ connectionString: url, application_name: 'kahe360-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await preflight(client);
    if (!dryRun) await ensureLedger(client);
    const ledger = (await client.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
    const { all, applied, pending } = ledger ? await plan(client, dir)
      : { all: listMigrations(dir), applied: new Map(), pending: listMigrations(dir) };
    if (dryRun) {
      for (const m of all) log(`  ${applied.has(m.version) ? 'applied ' : 'PENDING '} ${m.file}`);
      return { applied: [...applied.keys()], pending: pending.map((m) => m.version), ran: [] };
    }
    const ran = [];
    for (const m of pending) {
      const t0 = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1,$2,$3,$4)',
          [m.version, m.name, m.checksum, Date.now() - t0]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${m.file} failed and was rolled back: ${err.message}`;
        throw err;
      }
      ran.push(m.version);
      log(`  applied ${m.file} (${Date.now() - t0} ms)`);
    }
    const role = appRole || process.env.KAHE_DB_APP_ROLE;
    if (role) { await grantRuntime(client, role); log(`  runtime grants ensured for role "${role}"`); }
    if (!ran.length) log('  schema already current — nothing to apply');
    return { applied: [...applied.keys()], pending: [], ran };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* connection gone */ }
    await client.end();
  }
}

/** Used by server start-up: verify, never alter. */
async function assertSchemaCurrent(db) {
  const expected = listMigrations();
  let rows;
  try { rows = (await db.query('SELECT version, checksum FROM schema_migrations')).rows; } catch (err) {
    if (err.code === '42P01') throw new Error('Database is not migrated. Run: npm run db:migrate');
    throw err;
  }
  const have = new Map(rows.map((r) => [r.version, r.checksum]));
  const missing = expected.filter((m) => !have.has(m.version)).map((m) => m.file);
  if (missing.length) throw new Error(`Database schema is behind the code. Run: npm run db:migrate  (pending: ${missing.join(', ')})`);
  const drift = expected.filter((m) => have.get(m.version) !== m.checksum).map((m) => m.file);
  if (drift.length) throw new Error(`Applied migration(s) differ from the files on disk: ${drift.join(', ')}`);
  return expected.length;
}

module.exports = { migrate, assertSchemaCurrent, listMigrations };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) { /* optional */ }
  const arg = process.argv[2];
  migrate({ dryRun: arg === 'status' || arg === '--dry-run' })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`MIGRATION FAILED: ${err.message}`); process.exit(1); });
}
