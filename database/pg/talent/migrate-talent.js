// database/pg/talent/migrate-talent.js
// Talent & Worker V1 — the Talent-owned migration stream.
//
// Deliberately separate from the core runner (database/pg/migrate.js, untouched):
//   * its own files:   database/pg/talent/migrations/TW0001_*.sql, TW0002_*.sql, …
//   * its own ledger:  talent.schema_migrations (never public.schema_migrations)
//   * its own lock:    advisory key 360101 (core uses 360001)
//   * its own grants:  an EXPLICIT manifest for the runtime role — no "ALL TABLES" grant.
// Core migration numbering (0001…) is therefore never consumed by Talent.
//
// Same safety contract as the core runner: one transaction per migration with its ledger row,
// an applied file whose checksum changed is refused, out-of-order and unknown versions are refused.
// *.down.sql files are rollback scripts and are never applied by this runner.
//
// Connection: DATABASE_MIGRATION_URL (schema owner). Runtime role: KAHE_DB_APP_ROLE.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DIR = path.join(__dirname, 'migrations');
const SCHEMA = 'talent';
const LOCK_KEY = 360101;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const FILE_RE = /^TW\d{4}_[a-z0-9_]+\.sql$/;

// ---------------------------------------------------------------------------------------------
// RUNTIME GRANT MANIFEST — least privilege, explicit per object.
// Every table and sequence in schema `talent` MUST appear here; an unlisted object makes the
// runner fail (fail-closed) instead of silently leaving it inaccessible or over-granted.
// Identity-column sequences are internal to their table and are not granted.
// ---------------------------------------------------------------------------------------------
const GRANT_MANIFEST = Object.freeze({
  tables: Object.freeze({
    // operational identity
    worker: ['SELECT', 'INSERT'],
    worker_display_id: ['SELECT', 'INSERT'],
    // security / configuration — read-only for the application in CP1 (written by seed-talent.js as owner)
    permission: ['SELECT'],
    role_permission: ['SELECT'],
    field_catalog: ['SELECT'],
    field_policy: ['SELECT'],
    user_scope: ['SELECT'],
    // security & access audit — append-only
    audit_event: ['SELECT', 'INSERT'],
    // Emergency Registration V0 (TW0002) — insert-only for the application; no UPDATE / DELETE in V0
    registration: ['SELECT', 'INSERT'],
    registration_document: ['SELECT', 'INSERT'],
    // ledger
    schema_migrations: ['SELECT'],
  }),
  sequences: Object.freeze({
    seq_tal: ['USAGE'],
    seq_t: ['USAGE'],
    seq_w: ['USAGE'],
  }),
  // Only the function a CHECK constraint evaluates on behalf of the runtime role.
  functions: Object.freeze({
    'jsonb_has_forbidden_content(jsonb)': ['EXECUTE'],
  }),
});

function listTalentMigrations(dir = DIR) {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f) && !f.endsWith('.down.sql')).sort();
  const seen = new Set();
  return files.map((file) => {
    const version = file.slice(0, 6);
    if (seen.has(version)) throw new Error(`Duplicate Talent migration version ${version}`);
    seen.add(version);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version, name: file.replace(/\.sql$/, ''), file, sql,
      checksum: crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
  });
}

async function preflight(client) {
  const v = (await client.query('SHOW server_version_num')).rows[0].server_version_num;
  if (Number(v) < 130000) throw new Error(`PostgreSQL 13+ required (found ${v})`);   // gen_random_uuid() is built in from 13
}

async function ensureSchemaAndLedger(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (
    version TEXT PRIMARY KEY CHECK (version ~ '^TW[0-9]{4}$'), name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT NOT NULL DEFAULT current_user,
    execution_ms BIGINT NOT NULL)`);
}

async function ledgerExists(client) {
  return Boolean((await client.query(`SELECT to_regclass('${SCHEMA}.schema_migrations') AS t`)).rows[0].t);
}

async function plan(client, dir) {
  const all = listTalentMigrations(dir);
  const applied = new Map((await client.query(`SELECT version, checksum FROM ${SCHEMA}.schema_migrations`)).rows
    .map((r) => [r.version, r.checksum]));
  for (const m of all) {
    if (applied.has(m.version) && applied.get(m.version) !== m.checksum) {
      throw new Error(`Talent migration ${m.file} was modified after it was applied. Never edit an applied migration; add a new one.`);
    }
  }
  const known = new Set(all.map((m) => m.version));
  const unknown = [...applied.keys()].filter((v) => !known.has(v));
  if (unknown.length) throw new Error(`Database has Talent migrations this code does not know: ${unknown.join(', ')}`);
  const pending = all.filter((m) => !applied.has(m.version));
  const lastApplied = [...applied.keys()].sort().pop();
  const outOfOrder = pending.filter((m) => lastApplied && m.version < lastApplied);
  if (outOfOrder.length) throw new Error(`Out-of-order Talent migration(s): ${outOfOrder.map((m) => m.file).join(', ')}`);
  return { all, applied, pending };
}

/** Revoke everything, then grant exactly the manifest. Idempotent; runs in one transaction. */
async function applyRuntimeGrants(client, role) {
  if (!IDENT.test(role)) throw new Error('KAHE_DB_APP_ROLE must be a plain lowercase identifier');
  const exists = (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [role])).rows[0];
  if (!exists) throw new Error(`Runtime role "${role}" does not exist`);
  if (exists.rolsuper) throw new Error(`Runtime role "${role}" is a superuser; refusing to treat it as least-privilege`);

  const tables = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') ORDER BY 1`, [SCHEMA])).rows.map((r) => r.relname);
  const sequences = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'S'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY 1`, [SCHEMA])).rows.map((r) => r.relname);
  const unlistedTables = tables.filter((t) => !GRANT_MANIFEST.tables[t]);
  const unlistedSeqs = sequences.filter((s) => !GRANT_MANIFEST.sequences[s]);
  if (unlistedTables.length || unlistedSeqs.length) {
    throw new Error(`Talent grant manifest is incomplete (fail-closed): ${[...unlistedTables, ...unlistedSeqs].join(', ')}`);
  }
  const missing = [...Object.keys(GRANT_MANIFEST.tables).filter((t) => !tables.includes(t)),
    ...Object.keys(GRANT_MANIFEST.sequences).filter((s) => !sequences.includes(s))];
  if (missing.length) throw new Error(`Talent grant manifest names objects that do not exist: ${missing.join(', ')}`);

  await client.query('BEGIN');
  try {
    // Nobody but the owner creates objects in the Talent schema.
    await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);
    for (const [t, privs] of Object.entries(GRANT_MANIFEST.tables)) {
      await client.query(`GRANT ${privs.join(', ')} ON ${SCHEMA}.${t} TO ${role}`);
    }
    for (const [s, privs] of Object.entries(GRANT_MANIFEST.sequences)) {
      await client.query(`GRANT ${privs.join(', ')} ON SEQUENCE ${SCHEMA}.${s} TO ${role}`);
    }
    for (const [f, privs] of Object.entries(GRANT_MANIFEST.functions)) {
      await client.query(`GRANT ${privs.join(', ')} ON FUNCTION ${SCHEMA}.${f} TO ${role}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function migrateTalent({ connectionString, appRole, dryRun = false, log = console.log, dir = DIR } = {}) {
  const url = connectionString || process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (schema owner) before running Talent migrations.');
  const client = new Client({ connectionString: url, application_name: 'kahe360-migrate-talent' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await preflight(client);
    if (!dryRun) await ensureSchemaAndLedger(client);
    const { all, applied, pending } = (await ledgerExists(client)) ? await plan(client, dir)
      : { all: listTalentMigrations(dir), applied: new Map(), pending: listTalentMigrations(dir) };
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
        await client.query(`INSERT INTO ${SCHEMA}.schema_migrations (version, name, checksum, execution_ms) VALUES ($1,$2,$3,$4)`,
          [m.version, m.name, m.checksum, Date.now() - t0]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Talent migration ${m.file} failed and was rolled back: ${err.message}`;
        throw err;
      }
      ran.push(m.version);
      log(`  applied ${m.file} (${Date.now() - t0} ms)`);
    }
    const role = appRole || process.env.KAHE_DB_APP_ROLE;
    if (role) { await applyRuntimeGrants(client, role); log(`  Talent runtime grants applied for role "${role}" (explicit manifest)`); }
    else log('  WARNING: KAHE_DB_APP_ROLE not set — Talent runtime grants NOT applied');
    if (!ran.length) log('  Talent schema already current — nothing to apply');
    return { applied: [...applied.keys()], pending: [], ran };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* connection gone */ }
    await client.end();
  }
}

module.exports = { migrateTalent, listTalentMigrations, applyRuntimeGrants, GRANT_MANIFEST, SCHEMA, LOCK_KEY, DIR };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') }); } catch (_) { /* optional */ }
  const arg = process.argv[2];
  migrateTalent({ dryRun: arg === 'status' || arg === '--dry-run' })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`TALENT MIGRATION FAILED: ${err.message}`); process.exit(1); });
}
