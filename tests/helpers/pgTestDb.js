// tests/helpers/pgTestDb.js
// DB-M1 — isolated, throwaway PostgreSQL databases for the test suites.
//
// Every suite gets ITS OWN database, cloned from a migrated template, and drops
// it afterwards. Tests never touch a developer or production database: the
// harness only ever creates/drops names starting with `kahe360_test_`, and it
// connects through TEST_DATABASE_ADMIN_URL, never DATABASE_URL.
//
//   TEST_DATABASE_ADMIN_URL   role with CREATEDB + CREATEROLE (local dev: postgres)
//   TEST_DATABASE_ROLE_PASSWORD  password given to the two throwaway test roles
//
// Two roles, mirroring production: `kahe360_test_owner` (DDL/migrations) and
// `kahe360_test_app` (runtime, DML only). Suites run as the RUNTIME role so that
// what they prove is what the application can actually do.
const crypto = require('crypto');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) { /* optional */ }
const { Client } = require('pg');
const { migrate, listMigrations } = require('../../database/pg/migrate');
const { createDb } = require('../../database/db');

const PREFIX = 'kahe360_test_';
const OWNER = 'kahe360_test_owner';
const APP = 'kahe360_test_app';
const TEMPLATE_LOCK = 360002;

function adminUrl() {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_ADMIN_URL is not set. Tests need a REAL PostgreSQL server; see README_DEVELOPMENT.md. '
      + 'They never fall back to DATABASE_URL.');
  }
  return url;
}
const rolePassword = () => process.env.TEST_DATABASE_ROLE_PASSWORD || 'kahe360_test_only';
function urlFor(role, database) {
  const u = new URL(adminUrl());
  u.username = role; u.password = rolePassword(); u.pathname = `/${database}`;
  return u.toString();
}
const templateName = () => `${PREFIX}template_${crypto.createHash('sha256')
  .update(listMigrations().map((m) => m.checksum).join('|')).digest('hex').slice(0, 10)}`;

async function withAdmin(fn) {
  const c = new Client({ connectionString: adminUrl(), application_name: 'kahe360-test-admin' });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function ensureTemplate() {
  const name = templateName();
  await withAdmin(async (c) => {
    await c.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK]);
    try {
      const pw = (await c.query('SELECT quote_literal($1) AS q', [rolePassword()])).rows[0].q;
      for (const role of [OWNER, APP]) {
        const has = (await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
        if (!has) await c.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`);
      }
      const ready = (await c.query('SELECT 1 FROM pg_database WHERE datname=$1 AND datistemplate', [name])).rowCount;
      if (ready) return;
      await c.query(`DROP DATABASE IF EXISTS ${name}`);
      await c.query(`CREATE DATABASE ${name} OWNER ${OWNER} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
      await migrate({ connectionString: urlFor(OWNER, name), appRole: APP, log: () => {} });
      await c.query('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [name]);   // marks "fully built"
    } finally { await c.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK]); }
  });
  return name;
}

/**
 * GOLDEN PARITY HARNESS ONLY. A PostgreSQL sequence is not rolled back with a failed
 * transaction; SQLite AUTOINCREMENT is. After any rolled-back insert the surrogate ids of the
 * two engines drift apart, and payroll embeds ids in payloads that are hashed — so a byte-exact
 * comparison would report differences that are not business differences. In the parity database
 * (never in a real one) identity defaults are replaced by a TRANSACTIONAL counter with exactly
 * SQLite's semantics: max(id ever committed, max(id) present) + 1, rolled back with the transaction.
 * Application code is untouched; only the id allocator of the throwaway database changes.
 */
async function makeIdsGapless(ownerUrl) {
  const o = createDb({ connectionString: ownerUrl, max: 1 });
  try {
    await o.exec(`CREATE TABLE _parity_ids (tbl text PRIMARY KEY, last bigint NOT NULL);
      CREATE FUNCTION kahe_parity_next_id(t text) RETURNS bigint LANGUAGE plpgsql AS $f$
      DECLARE present bigint; n bigint;
      BEGIN
        EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM %I', t) INTO present;
        INSERT INTO _parity_ids AS p (tbl, last) VALUES (t, present + 1)
          ON CONFLICT (tbl) DO UPDATE SET last = GREATEST(p.last, present) + 1 RETURNING last INTO n;
        RETURN n;
      END $f$;`);
    const cols = await o.prepare(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND is_identity = 'YES'`).all();
    for (const c of cols) await o.exec(`ALTER TABLE ${c.t} ALTER COLUMN id DROP IDENTITY; ALTER TABLE ${c.t} ALTER COLUMN id SET DEFAULT kahe_parity_next_id('${c.t}')`);
    await o.exec(`GRANT SELECT, INSERT, UPDATE ON _parity_ids TO ${APP}; GRANT EXECUTE ON FUNCTION kahe_parity_next_id(text) TO ${APP}`);
  } finally { await o.close(); }
}

/** Create an isolated database. Returns runtime + owner handles and a drop(). */
async function createTestDatabase(label, { migrated = true } = {}) {
  if (!/^[a-z0-9_]+$/.test(label)) throw new Error('label must be [a-z0-9_]');
  const name = `${PREFIX}${label}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const template = migrated ? await ensureTemplate() : null;
  await withAdmin((c) => c.query(migrated
    ? `CREATE DATABASE ${name} OWNER ${OWNER} TEMPLATE ${template}`
    : `CREATE DATABASE ${name} OWNER ${OWNER} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`));
  const appUrl = urlFor(APP, name); const ownerUrl = urlFor(OWNER, name);
  if (migrated && process.env.KAHE_PARITY_GAPLESS_IDS) await makeIdsGapless(ownerUrl);
  const handles = [];
  const open = (url, max) => { const h = createDb({ connectionString: url, max }); handles.push(h); return h; };
  return {
    name, appUrl, ownerUrl,
    db: open(appUrl, 10),                         // what the application is
    openApp: (max = 10) => open(appUrl, max),
    openOwner: (max = 2) => open(ownerUrl, max),
    /** Scratch DDL a suite needs (probe tables). Runs as the OWNER, then opens the object to the runtime role. */
    async ddl(sql) {
      const o = createDb({ connectionString: ownerUrl, max: 1 });
      try { await o.exec(sql); await o.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP}`); } finally { await o.close(); }
    },
    async drop() {
      for (const h of handles) await h.close();
      // Golden parity harness: keep the finished database so its business state can be dumped; the harness drops it.
      if (process.env.KAHE_TEST_KEEP_DB) { require('fs').appendFileSync(process.env.KAHE_TEST_KEEP_DB, `${name}\n`); return; }
      if (!name.startsWith(PREFIX)) throw new Error('refusing to drop a non-test database');
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Remove leftovers from crashed runs (never the template). */
async function dropStaleTestDatabases() {
  return withAdmin(async (c) => {
    const rows = (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE $1 AND NOT datistemplate`, [`${PREFIX}%`])).rows;
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
    return rows.length;
  });
}

module.exports = { createTestDatabase, ensureTemplate, dropStaleTestDatabases, urlFor, OWNER, APP, PREFIX };
