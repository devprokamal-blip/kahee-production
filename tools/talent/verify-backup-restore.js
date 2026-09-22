// tools/talent/verify-backup-restore.js — Talent & Worker V1: prove schema `talent` can be backed up and restored.
// The DB-M1 verifier (tools/dbm1/verify-backup-restore.js) covers schema `public` and stays untouched.
//
//   SOURCE_URL=<owner url of the database to back up>  RESTORE_ADMIN_URL=<role that may CREATE DATABASE>
//   [RUNTIME_ROLE=kahe360_app]
//   node tools/talent/verify-backup-restore.js <new_database_name> [--keep] [--report out.json]
//
// pg_dump --schema=talent → a FRESH, EMPTY database → pg_restore. Restoring into an empty database also proves the
// Talent schema has no dependency on `public`. Compared source vs restored: tables, columns, constraints (incl.
// CHECK definitions), indexes, triggers (enabled state), functions, sequence positions, runtime-role privileges on
// tables / sequences / functions / schema, the Talent ledger, per-table row counts and a sha256 of every row.
// Then, as the runtime role on the restored database: append-only audit and read-only security tables still hold.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { execFileSync } = require('child_process'); const { Client } = require('pg');

const pgEnv = (url) => { const u = new URL(url); return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }; };
const withDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

const STRUCTURE = (role) => ({
  tables: `SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='talent' AND c.relkind IN ('r','p','v','m') ORDER BY 1`,
  columns: `SELECT table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||COALESCE(column_default,'-')||' '||is_identity AS x FROM information_schema.columns WHERE table_schema='talent' ORDER BY 1`,
  constraints: `SELECT conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) AS x FROM pg_constraint WHERE connamespace='talent'::regnamespace ORDER BY 1`,
  indexes: `SELECT indexdef AS x FROM pg_indexes WHERE schemaname='talent' ORDER BY 1`,
  triggers: `SELECT tgrelid::regclass::text||' '||tgname||' '||tgenabled::text||' '||pg_get_triggerdef(t.oid) AS x FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='talent'::regnamespace AND NOT tgisinternal ORDER BY 1`,
  functions: `SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(p.prosrc) AS x FROM pg_proc p WHERE p.pronamespace='talent'::regnamespace ORDER BY 1`,
  sequences: `SELECT sequencename||' '||COALESCE(last_value::text,'null')||' '||max_value AS x FROM pg_sequences WHERE schemaname='talent' ORDER BY 1`,
  table_privileges: `SELECT table_name||' '||string_agg(privilege_type, ',' ORDER BY privilege_type) AS x FROM information_schema.role_table_grants WHERE table_schema='talent' AND grantee='${role}' GROUP BY table_name ORDER BY 1`,
  sequence_privileges: `SELECT c.relname||' usage='||has_sequence_privilege('${role}', c.oid, 'USAGE')||' select='||has_sequence_privilege('${role}', c.oid, 'SELECT')||' update='||has_sequence_privilege('${role}', c.oid, 'UPDATE') AS x FROM pg_class c WHERE c.relnamespace='talent'::regnamespace AND c.relkind='S' ORDER BY 1`,
  function_privileges: `SELECT p.proname||' '||has_function_privilege('${role}', p.oid, 'EXECUTE') AS x FROM pg_proc p WHERE p.pronamespace='talent'::regnamespace ORDER BY 1`,
  schema_privileges: `SELECT 'usage='||has_schema_privilege('${role}','talent','USAGE')||' create='||has_schema_privilege('${role}','talent','CREATE') AS x`,
  ledger: `SELECT version||' '||checksum AS x FROM talent.schema_migrations ORDER BY 1`,
});

async function snapshot(url, role) {
  const c = new Client({ connectionString: url }); await c.connect();
  try {
    const out = {};
    for (const [k, sql] of Object.entries(STRUCTURE(role))) out[k] = (await c.query(sql)).rows.map((r) => r.x);
    out.data = {};
    for (const t of out.tables) {
      const r = (await c.query(`SELECT count(*)::int AS n, encode(sha256(convert_to(COALESCE(string_agg(x.r, E'\\n' ORDER BY x.r), ''), 'UTF8')), 'hex') AS h
        FROM (SELECT t::text AS r FROM talent.${t} t) x`)).rows[0];
      out.data[t] = `${r.n} ${r.h}`;
    }
    out.foreign_schemas = (await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('talent','pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m')`)).rows[0].n;
    return out;
  } finally { await c.end(); }
}

function diff(a, b) {
  const problems = [];
  for (const k of Object.keys(a)) {
    if (k === 'foreign_schemas') continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(k);
  }
  return problems;
}

async function runtimeChecks(url) {
  const c = new Client({ connectionString: url }); await c.connect();
  const expectFail = async (sql, label) => {
    try { await c.query(sql); return `${label}: NOT BLOCKED`; } catch (e) { return null; }
  };
  try {
    const problems = [];
    for (const [sql, label] of [
      ['UPDATE talent.audit_event SET outcome = outcome', 'audit UPDATE'],
      ['DELETE FROM talent.audit_event', 'audit DELETE'],
      ['TRUNCATE talent.audit_event', 'audit TRUNCATE'],
      ["INSERT INTO talent.role_permission (role_code, permission_code, action) VALUES ('x','tw_home','VIEW')", 'role_permission INSERT'],
      ["INSERT INTO talent.user_scope (user_id, scope_type) VALUES (1,'ALL')", 'user_scope INSERT'],
      ['CREATE TABLE talent.sneaky (id int)', 'CREATE in schema talent'],
      ['UPDATE talent.worker SET lifecycle_status = lifecycle_status', 'worker UPDATE'],
    ]) { const p = await expectFail(sql, label); if (p) problems.push(p); }
    return problems;
  } finally { await c.end(); }
}

async function verifyTalentBackup({ sourceUrl, adminUrl, targetDb, runtimeRole = 'kahe360_app', runtimeUrl = null, keep = false }) {
  if (!/^[a-z_][a-z0-9_]*$/.test(targetDb || '')) throw new Error('target database name must be a plain identifier');
  const report = { target: targetDb };
  const dump = path.join(os.tmpdir(), `talent_${targetDb}_${process.pid}.dump`);
  const owner = decodeURIComponent(new URL(sourceUrl).username);
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  try {
    const t0 = Date.now();
    execFileSync('pg_dump', ['--format=custom', '--schema=talent', '--file', dump], { env: pgEnv(sourceUrl), stdio: ['ignore', 'ignore', 'pipe'] });
    report.backup = { tool: execFileSync('pg_dump', ['--version']).toString().trim(), seconds: (Date.now() - t0) / 1000,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex') };
    await admin.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${targetDb} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    const targetUrl = withDb(sourceUrl, targetDb);
    execFileSync('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname', targetDb, dump], { env: pgEnv(targetUrl), stdio: ['ignore', 'ignore', 'pipe'] });
    const [src, dst] = [await snapshot(sourceUrl, runtimeRole), await snapshot(targetUrl, runtimeRole)];
    report.compared = Object.keys(src).filter((k) => k !== 'foreign_schemas');
    report.tables = src.tables.length;
    report.rows = Object.values(src.data).reduce((s, v) => s + Number(v.split(' ')[0]), 0);
    report.mismatches = diff(src, dst);
    report.restored_non_talent_tables = dst.foreign_schemas;   // must be 0: restored alone, no public dependency
    report.runtime_problems = runtimeUrl ? await runtimeChecks(withDb(runtimeUrl, targetDb)) : ['runtime checks skipped (no RUNTIME_URL)'];
    report.ok = report.mismatches.length === 0 && report.restored_non_talent_tables === 0 && report.runtime_problems.length === 0;
    return report;
  } finally {
    try { fs.unlinkSync(dump); } catch (_) { /* already gone */ }
    if (!keep) { try { await admin.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`); } catch (_) { /* best effort */ } }
    await admin.end();
  }
}

module.exports = { verifyTalentBackup, snapshot };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) { /* optional */ }
  const name = process.argv[2];
  const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
  verifyTalentBackup({ sourceUrl: process.env.SOURCE_URL, adminUrl: process.env.RESTORE_ADMIN_URL, targetDb: name,
    runtimeRole: process.env.RUNTIME_ROLE || 'kahe360_app', runtimeUrl: process.env.RUNTIME_URL || null, keep: process.argv.includes('--keep') })
    .then((r) => {
      if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(r, null, 2));
      console.log(JSON.stringify(r, null, 2));
      console.log(r.ok ? 'TALENT BACKUP/RESTORE: VERIFIED' : 'TALENT BACKUP/RESTORE: FAILED');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => { console.error(`TALENT BACKUP VERIFY FAILED: ${err.message}`); process.exit(1); });
}
