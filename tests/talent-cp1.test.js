(async () => {
// tests/talent-cp1.test.js
// Talent & Worker V1 — CP1 foundation. REAL PostgreSQL, REAL server.js over HTTP, REAL seed.js + seed-talent.js.
// SQL probes run as the least-privilege RUNTIME role unless a check needs the owner.
// Usage: npm run test:talent-cp1
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const { createTalentTestDatabase, urlFor, APP } = require('./helpers/talentTestDb');
const { createTestDatabase } = require('./helpers/pgTestDb');

const __t = await createTalentTestDatabase('talent_cp1');
process.env.DATABASE_URL = __t.appUrl;
const { createDb } = require('../database/db');
const { listMigrations, assertSchemaCurrent } = require('../database/pg/migrate');
const talentMig = require('../database/pg/talent/migrate-talent');
const seedTalentMod = require('../database/seed-talent');
const identity = require('../modules/talent/lib/identity');
const audit = require('../modules/talent/lib/talentAudit');
const fsec = require('../modules/talent/lib/fieldSecurity');
const scope = require('../modules/talent/lib/dataScope');
const { NAV } = require('../modules/talent/routes/pages');
const { PENDING_INTEGRATIONS } = require('../modules/talent/routes/api');
const { verifyTalentBackup } = require('../tools/talent/verify-backup-restore');

const PASSWORD = 'Kahe360Demo!2026';
let passed = 0, failed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function ok(c, label) { if (!c) throw new Error(label || 'assertion failed'); }
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function sqlState(fn) { try { await fn(); return 'OK'; } catch (e) { return e.code || e.message; } }
async function errMessage(fn) { try { await fn(); return 'OK'; } catch (e) { return e.message; } }

const db = __t.db;                       // runtime role
const owner = __t.openOwner(2);          // schema owner
const one = (h, sql, ...p) => h.prepare(sql).get(...p);
const all = (h, sql, ...p) => h.prepare(sql).all(...p);

// ---- catalogue snapshots ---------------------------------------------------------------------------------
async function publicCatalog(h) {
  const q = async (sql) => (await h.query(sql)).rows.map((r) => r.x);
  return {
    tables: await q(`SELECT c.relname AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m') ORDER BY 1`),
    columns: await q(`SELECT table_name||'.'||column_name||' '||data_type||' '||is_nullable AS x FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`),
    constraints: await q(`SELECT conrelid::regclass::text||' '||conname||' '||contype::text AS x FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1`),
    indexes: await q(`SELECT indexname AS x FROM pg_indexes WHERE schemaname='public' ORDER BY 1`),
    triggers: await q(`SELECT tgrelid::regclass::text||' '||tgname||' '||tgenabled::text AS x FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT tgisinternal ORDER BY 1`),
    functions: await q(`SELECT proname||'('||pg_get_function_identity_arguments(oid)||')' AS x FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1`),
    sequences: await q(`SELECT sequencename AS x FROM pg_sequences WHERE schemaname='public' ORDER BY 1`),
    views: await q(`SELECT viewname AS x FROM pg_views WHERE schemaname='public' ORDER BY 1`),
  };
}
async function publicRowCounts(h) {
  const tables = (await h.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> 'sessions' ORDER BY 1`)).rows;
  const out = {};
  for (const t of tables) out[t.relname] = (await h.query(`SELECT count(*)::int AS n FROM public.${t.relname}`)).rows[0].n;
  return out;
}
async function talentConfigFingerprint(h) {
  const parts = [];
  for (const t of ['permission', 'role_permission', 'field_catalog', 'field_policy']) {
    parts.push(JSON.stringify((await h.query(`SELECT * FROM talent.${t} ORDER BY 1, 2`)).rows));
  }
  parts.push(JSON.stringify((await h.query('SELECT user_id, scope_type, scope_value FROM talent.user_scope ORDER BY 1, 2')).rows));
  return sha(parts.join('\n'));
}

// A database that has the core schema only: the baseline for "public is unchanged by Talent".
const __core = await createTestDatabase('talent_cp1_core');
const coreOwner = __core.openOwner(2);
const { execFileSync } = require('child_process');
execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: __core.appUrl }, stdio: 'pipe' });
const CORE_PUBLIC_BEFORE = await publicCatalog(coreOwner);

// ---- users ------------------------------------------------------------------------------------------------
const hash = bcrypt.hashSync(PASSWORD, 4);
async function addUser(h, email, roleCode) {
  const u = await one(h, `INSERT INTO users (email, display_name, password_hash, is_active) VALUES (?, ?, ?, 1) RETURNING id`, email, email.split('@')[0], hash);
  await h.prepare(`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?`).run(u.id, roleCode);
  return Number(u.id);
}
const SUP_ID = await addUser(db, 'sup.tw@t.local', 'supervisor');
const MULTI_ID = await addUser(db, 'multi.tw@t.local', 'workforce_manager');
await db.prepare(`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = 'hrd_officer'`).run(MULTI_ID);
const uid = async (email) => Number((await one(db, 'SELECT id FROM users WHERE email = ?', email)).id);
const U = { wf: await uid('workforce@kahe360.local'), hrd: await uid('hrd@kahe360.local'), dir: await uid('director@kahe360.local'),
  pay: await uid('payroll@kahe360.local'), health: await uid('health@kahe360.local'), hse: await uid('hse@kahe360.local') };

// ---- servers ----------------------------------------------------------------------------------------------
const servers = [];
async function startServer(appUrl) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  let out = '';
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: appUrl, PORT: String(port),
    NODE_ENV: 'development', KAHE_WRITE_SERIALIZATION: 'off', KAHE_DB_QUERY_STATS: '', SESSION_SECRET: 'talent_cp1_test_only' }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/login.html`)).status === 200) return { base, proc, out: () => out }; } catch { /* */ } await sleep(100); }
  throw new Error(`server did not start:\n${out}`);
}
function client(base, cookie = null) {
  const call = async (method, url, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(`${base}${url}`, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json, text, location: r.headers.get('location'), headers: r.headers };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
}
async function login(base, email) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`);
  return client(base, res.headers.get('set-cookie').split(';')[0]);
}

const EXPECTED_GRANTS = {
  workforce_manager: { tw_contract_placement: ['CREATE', 'EDIT', 'VIEW'], tw_deployment: ['CREATE', 'EDIT', 'VIEW'], tw_home: ['VIEW'],
    tw_registration: ['CREATE', 'EDIT', 'VIEW'], tw_reports: ['VIEW'], tw_talent_pool: ['CREATE', 'EDIT', 'VIEW'], tw_worker_passport: ['VIEW'],
    tw_emergency_intake: ['EXPORT', 'VIEW'] },   // Emergency Registration V0
  hrd_officer: { tw_home: ['VIEW'], tw_registration: ['VIEW'], tw_talent_pool: ['VIEW'], tw_verification: ['APPROVE', 'EDIT', 'REJECT', 'VIEW'],
    tw_worker_passport: ['VIEW'], tw_emergency_intake: ['EXPORT', 'VIEW'] },   // Emergency Registration V0
  operations_director: { tw_contract_placement: ['VIEW'], tw_deployment: ['VIEW'], tw_home: ['VIEW'], tw_reports: ['VIEW'],
    tw_talent_pool: ['VIEW'], tw_worker_passport: ['VIEW'] },
};
const sortGrants = (g) => Object.fromEntries(Object.keys(g).sort().map((k) => [k, [...g[k]].sort()]));
async function grantsOf(h, role) {
  const rows = await all(h, 'SELECT permission_code, action FROM talent.role_permission WHERE role_code = ? ORDER BY 1, 2', role);
  const g = {}; for (const r of rows) (g[r.permission_code] = g[r.permission_code] || []).push(r.action);
  return g;
}

try {
// =============================================================================================================
section('1. TALENT MIGRATION STREAM');
const files = talentMig.listTalentMigrations();
await check('the Talent stream holds exactly TW0001 + TW0002 (Emergency Registration V0); *.down.sql is never listed as a migration', async () => {
  eq(files.map((f) => f.file), ['TW0001_talent_worker_foundation.sql', 'TW0002_emergency_registration_v0.sql']);
  ok(fs.existsSync(path.join(talentMig.DIR, 'TW0001_talent_worker_foundation.down.sql')), 'rollback file missing');
});
await check('each Talent migration is recorded once in talent.schema_migrations with the file checksum', async () => {
  eq(await all(db, 'SELECT version, checksum FROM talent.schema_migrations ORDER BY version'), files.map((f) => ({ version: f.version, checksum: f.checksum })));
});
await check('re-running the Talent runner applies nothing', async () => {
  const r = await __t.migrateTalent();
  eq([r.ran, r.pending], [[], []]);
});
await check('dry-run reports nothing pending and changes nothing', async () => {
  const before = await all(owner, 'SELECT version, applied_at FROM talent.schema_migrations');
  const r = await __t.migrateTalent({ dryRun: true });
  eq(r.pending, []); eq(await all(owner, 'SELECT version, applied_at FROM talent.schema_migrations'), before);
});
const tmpDir = (name, mutate) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `tw_${name}_`));
  for (const f of fs.readdirSync(talentMig.DIR)) fs.copyFileSync(path.join(talentMig.DIR, f), path.join(d, f));
  mutate(d); return d;
};
await check('an applied Talent migration that was edited afterwards is refused', async () => {
  const d = tmpDir('edited', (dir) => fs.appendFileSync(path.join(dir, 'TW0001_talent_worker_foundation.sql'), '\n-- edited\n'));
  const msg = await sqlState(() => __t.migrateTalent({ dir: d }));
  ok(/modified after it was applied/.test(msg), msg);
});
await check('a failing Talent migration rolls back completely and records no version', async () => {
  const d = tmpDir('broken', (dir) => fs.writeFileSync(path.join(dir, 'TW0003_broken.sql'),
    'CREATE TABLE talent.half_done (id int);\nSELECT this_is_not_sql;'));
  const msg = await errMessage(() => __t.migrateTalent({ dir: d }));
  ok(/failed and was rolled back/.test(msg), msg);
  eq((await one(owner, `SELECT to_regclass('talent.half_done') AS t`)).t, null);
  eq((await all(owner, 'SELECT version FROM talent.schema_migrations ORDER BY version')).map((r) => r.version), ['TW0001', 'TW0002']);
});
await check('an unlisted new Talent table makes the grant step fail closed (explicit manifest)', async () => {
  const d = tmpDir('unlisted', (dir) => fs.writeFileSync(path.join(dir, 'TW0003_unlisted.sql'), 'CREATE TABLE talent.unlisted_probe (id int);'));
  const msg = await sqlState(() => __t.migrateTalent({ dir: d }));
  ok(/manifest is incomplete/.test(msg), msg);
  eq(await sqlState(() => db.query('SELECT * FROM talent.unlisted_probe')), '42501');   // runtime got nothing
  await owner.exec(`DROP TABLE talent.unlisted_probe; DELETE FROM talent.schema_migrations WHERE version = 'TW0003'`);
  await __t.migrateTalent();                                                         // back to the real state
  eq((await all(owner, 'SELECT version FROM talent.schema_migrations ORDER BY version')).map((r) => r.version), ['TW0001', 'TW0002']);
});
await check('the Talent migrations insert no rows (structure only): every Talent table except the ledger is empty after migrating', async () => {
  const fresh = await createTalentTestDatabase('talent_cp1_fresh', { coreSeed: false, talentSeed: false });
  try {
    const o = fresh.openOwner(1);
    const tables = (await o.query(`SELECT relname FROM pg_class WHERE relnamespace='talent'::regnamespace AND relkind='r' AND relname <> 'schema_migrations' ORDER BY 1`)).rows;
    ok(tables.length === 10, `expected 10 Talent tables (8 CP1 + 2 V0), got ${tables.length}`);
    for (const t of tables) eq([t.relname, (await o.query(`SELECT count(*)::int AS n FROM talent.${t.relname}`)).rows[0].n], [t.relname, 0]);
  } finally { await fresh.drop(); }
});
await check('the core ledger is untouched: public.schema_migrations is exactly 0001–0007 with the file checksums', async () => {
  const rows = await all(owner, 'SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  eq(rows, listMigrations().map((m) => ({ version: m.version, checksum: m.checksum })));
  eq(rows.map((r) => r.version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007']);
});
await check('locked core migration files keep their recorded checksums (0006, 0007)', async () => {
  const m = Object.fromEntries(listMigrations().map((x) => [x.version, x.checksum]));
  eq([m['0006'], m['0007']], ['7b5a675d55246ae292843db6fc4b809dd6b2ec2c97b8affd18b2b20fa5c276b4',
    '7a49369f28e4ec93e5a42de3896fa5e8d3665af631bf8561c86a48bf3e4ff5fe']);
});
await check('core schema check still passes with the Talent schema present', async () => { await assertSchemaCurrent(db); });

// =============================================================================================================
section('2. ISOLATION FROM THE CORE PLATFORM');
await check('public schema objects are identical with and without Talent (tables, columns, constraints, indexes, triggers, functions, sequences, views)', async () => {
  const withTalent = await publicCatalog(owner);
  for (const k of Object.keys(CORE_PUBLIC_BEFORE)) eq([k, withTalent[k].length, sha(JSON.stringify(withTalent[k]))], [k, CORE_PUBLIC_BEFORE[k].length, sha(JSON.stringify(CORE_PUBLIC_BEFORE[k]))]);
});
await check('no Talent foreign key points outside schema talent', async () => {
  eq((await one(owner, `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
    WHERE c.connamespace = 'talent'::regnamespace AND c.contype = 'f' AND t.relnamespace <> 'talent'::regnamespace`)).n, 0);
});
await check('no trigger outside schema talent calls a Talent function; no Talent trigger sits on a non-Talent table', async () => {
  eq((await one(owner, `SELECT count(*)::int AS n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
    WHERE NOT tg.tgisinternal AND (c.relnamespace <> 'talent'::regnamespace) = (p.pronamespace = 'talent'::regnamespace)
      AND (c.relnamespace = 'talent'::regnamespace OR p.pronamespace = 'talent'::regnamespace)`)).n, 0);
});
await check('no Talent object depends on an object in schema public (pg_depend)', async () => {
  eq((await one(owner, `SELECT count(*)::int AS n FROM pg_depend d
    JOIN pg_class rc ON d.refclassid = 'pg_class'::regclass AND rc.oid = d.refobjid
    WHERE rc.relnamespace = 'public'::regnamespace AND d.classid IN ('pg_class'::regclass, 'pg_constraint'::regclass, 'pg_trigger'::regclass, 'pg_proc'::regclass, 'pg_rewrite'::regclass)
      AND ((d.classid = 'pg_class'::regclass AND (SELECT relnamespace FROM pg_class WHERE oid = d.objid) = 'talent'::regnamespace)
        OR (d.classid = 'pg_constraint'::regclass AND (SELECT connamespace FROM pg_constraint WHERE oid = d.objid) = 'talent'::regnamespace)
        OR (d.classid = 'pg_proc'::regclass AND (SELECT pronamespace FROM pg_proc WHERE oid = d.objid) = 'talent'::regnamespace))`)).n, 0);
});
await check('Talent function bodies never name schema public', async () => {
  const rows = await all(owner, `SELECT proname FROM pg_proc WHERE pronamespace = 'talent'::regnamespace AND prosrc ~* 'public\\.'`);
  eq(rows, []);
});
await check('Talent code never queries a protected operational table (source scan of modules/talent)', async () => {
  const PROTECTED = /\b(FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(public\.)?(attendance_[a-z_]+|timesheet_entries|payroll_[a-z_]+|employee_[a-z_]+|employees|salary_components|billing_[a-z_]+|worker_service_[a-z_]+|legal_entities|clients|projects|user_project_scope)\b/i;
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|html|sql)$/.test(f)) {
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (!/^\s*(\/\/|--|\*)/.test(line) && PROTECTED.test(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`); }); } } };
  walk(path.join(ROOT, 'modules', 'talent'));
  walk(path.join(ROOT, 'database', 'pg', 'talent'));
  eq(hits, []);
});
await check('seed-talent writes nothing outside schema talent (every public table row count unchanged by a re-run)', async () => {
  const before = await publicRowCounts(owner);
  await __t.seedTalent();
  eq(await publicRowCounts(owner), before);
});

// =============================================================================================================
section('3. LEAST-PRIVILEGE RUNTIME GRANTS');
const grantMap = async () => {
  const rows = await all(owner, `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
    FROM information_schema.role_table_grants WHERE table_schema = 'talent' AND grantee = ? GROUP BY table_name ORDER BY 1`, APP);
  return Object.fromEntries(rows.map((r) => [r.t, r.p]));
};
await check('runtime table privileges are EXACTLY the manifest (no generic DML)', async () => {
  eq(await grantMap(), { audit_event: 'INSERT,SELECT', field_catalog: 'SELECT', field_policy: 'SELECT', permission: 'SELECT',
    registration: 'INSERT,SELECT', registration_document: 'INSERT,SELECT', role_permission: 'SELECT', schema_migrations: 'SELECT', user_scope: 'SELECT',
    worker: 'INSERT,SELECT', worker_display_id: 'INSERT,SELECT' });
});
await check('no column-level privilege widens the table grants', async () => {
  eq(await all(owner, `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
    WHERE table_schema = 'talent' AND grantee = ? AND privilege_type NOT IN ('SELECT', 'INSERT')`, APP), []);
});
await check('sequences seq_tal / seq_t / seq_w: USAGE only (no SELECT, no UPDATE)', async () => {
  const rows = await all(owner, `SELECT c.relname AS s, has_sequence_privilege(?, c.oid, 'USAGE') AS u, has_sequence_privilege(?, c.oid, 'SELECT') AS sel,
    has_sequence_privilege(?, c.oid, 'UPDATE') AS upd FROM pg_class c WHERE c.relnamespace = 'talent'::regnamespace AND c.relkind = 'S'
    AND c.relname IN ('seq_tal','seq_t','seq_w') ORDER BY 1`, APP, APP, APP);
  eq(rows, [{ s: 'seq_t', u: true, sel: false, upd: false }, { s: 'seq_tal', u: true, sel: false, upd: false }, { s: 'seq_w', u: true, sel: false, upd: false }]);
});
await check('runtime role has USAGE but NOT CREATE on schema talent; PUBLIC has neither', async () => {
  eq(await one(owner, `SELECT has_schema_privilege(?, 'talent', 'USAGE') AS u, has_schema_privilege(?, 'talent', 'CREATE') AS c,
    (SELECT count(*)::int FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname='talent' AND a.grantee = 0) AS pub`, APP, APP), { u: true, c: false, pub: 0 });
  eq(await sqlState(() => db.query('CREATE TABLE talent.sneaky (id int)')), '42501');
});
await check('PUBLIC holds no privilege on any Talent table, sequence or function', async () => {
  eq((await one(owner, `SELECT
    (SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace='talent'::regnamespace AND a.grantee = 0)
  + (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.pronamespace='talent'::regnamespace AND a.grantee = 0) AS n`)).n, 0);
});
await check('runtime role cannot write the security/config tables', async () => {
  for (const sql of [
    `INSERT INTO talent.permission (code, description, allowed_actions) VALUES ('tw_x','x','{VIEW}')`,
    `INSERT INTO talent.role_permission (role_code, permission_code, action) VALUES ('supervisor','tw_home','VIEW')`,
    `UPDATE talent.role_permission SET action = action`,
    `INSERT INTO talent.field_policy (role_code, field_code, visibility) VALUES ('supervisor','nik','FULL')`,
    `UPDATE talent.field_catalog SET mask_rule = 'NONE'`,
    `INSERT INTO talent.user_scope (user_id, scope_type) VALUES (${SUP_ID}, 'ALL')`,
    `DELETE FROM talent.user_scope`,
  ]) eq([sql.slice(0, 40), await sqlState(() => db.query(sql))], [sql.slice(0, 40), '42501']);
});
await check('runtime role cannot UPDATE / DELETE / TRUNCATE identity tables', async () => {
  for (const sql of ['UPDATE talent.worker SET lifecycle_status = lifecycle_status', 'DELETE FROM talent.worker', 'TRUNCATE talent.worker',
    'UPDATE talent.worker_display_id SET display_id = display_id', 'DELETE FROM talent.worker_display_id']) {
    eq([sql, await sqlState(() => db.query(sql))], [sql, '42501']);
  }
});
await check('runtime role cannot UPDATE / DELETE / TRUNCATE the audit log or touch the Talent ledger', async () => {
  for (const sql of ['UPDATE talent.audit_event SET outcome = outcome', 'DELETE FROM talent.audit_event', 'TRUNCATE talent.audit_event',
    `INSERT INTO talent.schema_migrations (version, name, checksum, execution_ms) VALUES ('TW9999','x','x',0)`, 'DELETE FROM talent.schema_migrations']) {
    eq([sql, await sqlState(() => db.query(sql))], [sql, '42501']);
  }
});
await check('even the schema owner cannot UPDATE / DELETE / TRUNCATE audit events (database triggers)', async () => {
  await audit.recordEvent(db, { eventType: 'VIEW_PASSPORT', outcome: 'ALLOWED', actorUserId: U.wf, payload: { probe: 'owner-immutability' } });
  for (const sql of ['UPDATE talent.audit_event SET outcome = outcome', 'DELETE FROM talent.audit_event', 'TRUNCATE talent.audit_event']) {
    eq([sql, await sqlState(() => owner.query(sql))], [sql, 'P0001']);
  }
});
await check('core runtime grants did not leak into schema talent (core grant step is public-only)', async () => {
  eq((await one(owner, `SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema='talent' AND grantee = ?
    AND privilege_type IN ('UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`, APP)).n, 0);
});

// =============================================================================================================
section('4. TOLERANT MOUNT — core keeps working without the Talent schema');
const coreSrv = await startServer(__core.appUrl);
const coreWf = await login(coreSrv.base, 'workforce@kahe360.local');
await check('without schema talent: login, Home and a core API work; /api/tw/* answers 503 TALENT_SCHEMA_NOT_READY', async () => {
  const home = await coreWf.get('/index.html');
  eq(home.status, 200);
  eq((await coreWf.get('/api/auth/me')).status, 200);
  const me = await coreWf.get('/api/tw/me');
  eq([me.status, me.body.error, me.body.detail.reason], [503, 'TALENT_SCHEMA_NOT_READY', 'TALENT_SCHEMA_MISSING']);
});
await check('without schema talent: /tw/app/ pages answer 503 (never 500), the dark portal pages still load', async () => {
  eq((await coreWf.get('/tw/app/')).status, 503);
  eq((await coreWf.get('/talenta-kesiapan.html')).status, 200);
});
await check('applying the Talent stream to the RUNNING server takes effect without a restart', async () => {
  await talentMig.migrateTalent({ connectionString: __core.ownerUrl, appRole: APP, log: () => {} });
  const me = await coreWf.get('/api/tw/me');
  eq(me.status, 200);
  ok(me.body.nav.every((n) => n.enabled === false), 'no Talent grant exists before seed-talent');
});
await check('rollback (TW0001.down.sql) removes only schema talent: public is identical, core schema check passes, Talent answers 503 again', async () => {
  await coreOwner.exec(fs.readFileSync(path.join(talentMig.DIR, 'TW0001_talent_worker_foundation.down.sql'), 'utf8'));
  eq((await one(coreOwner, `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'talent'`)).n, 0);
  const after = await publicCatalog(coreOwner);
  for (const k of Object.keys(CORE_PUBLIC_BEFORE)) eq([k, sha(JSON.stringify(after[k]))], [k, sha(JSON.stringify(CORE_PUBLIC_BEFORE[k]))]);
  await assertSchemaCurrent(__core.db);
  eq((await coreWf.get('/api/tw/me')).status, 503);
  eq((await coreWf.get('/api/auth/me')).status, 200);
});
await check('after a rollback the Talent stream re-applies cleanly', async () => {
  const r = await talentMig.migrateTalent({ connectionString: __core.ownerUrl, appRole: APP, log: () => {} });
  eq(r.ran, ['TW0001', 'TW0002']);
  eq((await coreWf.get('/api/tw/me')).status, 200);
});

// =============================================================================================================
section('5. AUTHENTICATION & TALENT RBAC (HTTP)');
const srv = await startServer(__t.appUrl);
const anon = client(srv.base);
const wf = await login(srv.base, 'workforce@kahe360.local');
const hrd = await login(srv.base, 'hrd@kahe360.local');
const dir = await login(srv.base, 'director@kahe360.local');
const pay = await login(srv.base, 'payroll@kahe360.local');
const health = await login(srv.base, 'health@kahe360.local');
const hse = await login(srv.base, 'hse@kahe360.local');
const sup = await login(srv.base, 'sup.tw@t.local');
const multi = await login(srv.base, 'multi.tw@t.local');

await check('unauthenticated: API 401, every Talent page redirects to the existing login page', async () => {
  eq([(await anon.get('/api/tw/me')).status, (await anon.get('/api/tw/integrations')).status], [401, 401]);
  for (const n of NAV) { const r = await anon.get(`/tw/app${n.path}`); eq([n.code, r.status, r.location], [n.code, 302, '/login.html']); }
});
await check('the existing login/session is reused: one cookie serves both the portal and Talent', async () => {
  eq([(await wf.get('/api/auth/me')).status, (await wf.get('/api/tw/me')).status], [200, 200]);
});
await check('Workforce Manager: Talent grants are exactly the approved set', async () => {
  eq(sortGrants((await wf.get('/api/tw/me')).body.permissions), sortGrants(EXPECTED_GRANTS.workforce_manager));
});
await check('HRD Officer: Talent grants are exactly the approved set', async () => {
  eq(sortGrants((await hrd.get('/api/tw/me')).body.permissions), sortGrants(EXPECTED_GRANTS.hrd_officer));
});
await check('Operations Director: VIEW only — no ALL_ACTIONS inheritance, no non-VIEW action anywhere', async () => {
  const p = (await dir.get('/api/tw/me')).body.permissions;
  eq(sortGrants(p), sortGrants(EXPECTED_GRANTS.operations_director));
  ok(Object.values(p).every((a) => a.length === 1 && a[0] === 'VIEW'), 'director holds a non-VIEW action');
});
await check('payroll, occupational health, HSE and supervisor roles hold no Talent permission', async () => {
  for (const c of [pay, health, hse, sup]) {
    const me = (await c.get('/api/tw/me')).body;
    eq([me.permissions, me.nav.filter((n) => n.enabled).length], [{}, 0]);
  }
});
await check('nobody holds print, PDF, document download or Talent security administration in CP1', async () => {
  eq((await one(db, `SELECT count(*)::int AS n FROM talent.role_permission
    WHERE permission_code IN ('tw_passport_print','tw_passport_pdf','tw_document_download','tw_security_admin')`)).n, 0);
});
await check('the navigation is the canonical 9 items in order; enablement follows the grants', async () => {
  const codes = ['home', 'dashboard', 'candidate_registration', 'talent_pool', 'verification_screening', 'deployment_assignment',
    'contract_placement', 'reports_analytics', 'settings'];
  const en = async (c) => (await c.get('/api/tw/me')).body.nav.map((n) => `${n.code}:${n.enabled ? 1 : 0}`);
  eq((await wf.get('/api/tw/me')).body.nav.map((n) => n.code), codes);
  eq(await en(wf), ['home:1', 'dashboard:1', 'candidate_registration:1', 'talent_pool:1', 'verification_screening:0', 'deployment_assignment:1', 'contract_placement:1', 'reports_analytics:1', 'settings:0']);
  eq(await en(hrd), ['home:1', 'dashboard:1', 'candidate_registration:1', 'talent_pool:1', 'verification_screening:1', 'deployment_assignment:0', 'contract_placement:0', 'reports_analytics:0', 'settings:0']);
  eq(await en(dir), ['home:1', 'dashboard:1', 'candidate_registration:0', 'talent_pool:1', 'verification_screening:0', 'deployment_assignment:1', 'contract_placement:1', 'reports_analytics:1', 'settings:0']);
});
await check('page guards match the navigation for every role and every page (server-side, not UX)', async () => {
  for (const [c, name] of [[wf, 'wf'], [hrd, 'hrd'], [dir, 'dir'], [pay, 'pay'], [sup, 'sup']]) {
    const nav = (await c.get('/api/tw/me')).body.nav;
    for (const n of nav) eq([name, n.code, (await c.get(n.href)).status], [name, n.code, n.enabled ? 200 : 403]);
  }
});
await check('a denied request writes PERMISSION_DENIED with actor, roles, permission and route — metadata only', async () => {
  const before = (await one(db, `SELECT count(*)::int AS n FROM talent.audit_event WHERE event_type = 'PERMISSION_DENIED'`)).n;
  eq((await pay.get('/api/tw/integrations')).status, 403);
  eq((await dir.get('/tw/app/verification-screening?nik=3201234567890001')).status, 403);
  const rows = await all(db, `SELECT outcome, actor_user_id, actor_role_codes, permission_code, action, route, payload
    FROM talent.audit_event WHERE event_type = 'PERMISSION_DENIED' ORDER BY id DESC LIMIT 2`);
  eq((await one(db, `SELECT count(*)::int AS n FROM talent.audit_event WHERE event_type = 'PERMISSION_DENIED'`)).n, before + 2);
  eq(rows.map((r) => [r.outcome, Number(r.actor_user_id), r.actor_role_codes, r.permission_code, r.action, r.route]), [
    ['DENIED', U.dir, ['operations_director'], 'tw_verification', 'VIEW', '/tw/app/verification-screening'],
    ['DENIED', U.pay, ['payroll_officer'], 'tw_worker_passport', 'VIEW', '/api/tw/integrations']]);
  ok(!JSON.stringify(rows).includes('3201234567890001'), 'query string with a NIK-shaped value reached the audit log');
});
await check('a 403 response never leaks worker data; a 401 never hits the audit log', async () => {
  const r = await pay.get('/api/tw/integrations');
  eq(Object.keys(r.body).sort(), ['detail', 'error']);
  const before = (await one(db, 'SELECT count(*)::int AS n FROM talent.audit_event')).n;
  await anon.get('/api/tw/integrations');
  eq((await one(db, 'SELECT count(*)::int AS n FROM talent.audit_event')).n, before);
});
await check('re-running the core seed (database/seed.js) leaves every Talent grant, policy and scope intact', async () => {
  const before = await talentConfigFingerprint(owner);
  __t.runCoreSeed();
  eq(await talentConfigFingerprint(owner), before);
  eq(sortGrants((await dir.get('/api/tw/me')).body.permissions), sortGrants(EXPECTED_GRANTS.operations_director));
});
await check('seed-talent is idempotent (identical configuration fingerprint after a second run)', async () => {
  const a = await talentConfigFingerprint(owner); await __t.seedTalent(); eq(await talentConfigFingerprint(owner), a);
});
await check('grants in the database equal seed-talent.js exactly, for the three existing roles only', async () => {
  const roles = (await all(db, 'SELECT DISTINCT role_code FROM talent.role_permission ORDER BY 1')).map((r) => r.role_code);
  eq(roles, ['hrd_officer', 'operations_director', 'workforce_manager']);
  for (const r of roles) eq(sortGrants(await grantsOf(db, r)), sortGrants(EXPECTED_GRANTS[r]));
  eq((await one(db, `SELECT count(*)::int AS n FROM roles WHERE code = ANY(?::text[])`, roles)).n, 3);
});
await check('output permissions are EXPORT-only at the database level (trigger refuses VIEW on tw_passport_print)', async () => {
  const msg = await sqlState(() => owner.query(`INSERT INTO talent.role_permission (role_code, permission_code, action) VALUES ('hrd_officer','tw_passport_print','VIEW')`));
  eq(msg, 'P0001');
});
await check('/api/tw/integrations: 7 domains, all NOT_CONNECTED, nothing else', async () => {
  const r = await wf.get('/api/tw/integrations');
  eq(r.body, { integrations: ['ATTENDANCE', 'OVERTIME', 'PAYROLL', 'BPJS', 'ACCOMMODATION', 'MOBILITY', 'MEALS'].map((code) => ({ code, status: 'NOT_CONNECTED' })) });
  eq(PENDING_INTEGRATIONS.length, 7);
});
await check('unknown /api/tw route: 404 {error, detail}; the A4 catch-all does not capture /api/tw', async () => {
  const r = await wf.get('/api/tw/nope');
  eq([r.status, r.body], [404, { error: 'NOT_FOUND', detail: {} }]);
  eq((await wf.get('/api/tw/health')).body, { ready: true, schema_version: 'TW0002' });
});
await check('Talent does not claim the existing portal namespace: /app/* is not a Talent route', async () => {
  const r = await wf.get('/app/');
  ok(r.status === 404 && !/KAHE Talent Management System/.test(r.text), `unexpected /app/ response ${r.status}`);
});

// =============================================================================================================
section('6. FIELD-LEVEL SECURITY (FULL / MASKED / HIDDEN)');
const RECORD = { worker_uuid: '11111111-1111-4111-8111-111111111111', talent_id: 'KAHE-T-000001', full_name: 'Nama Uji', nik: '3201234567890001',
  birth_date: '1996-08-15', gender: 'L', religion: 'X', marital_status: 'K', phone: '+6281234567890', email: 'nama.uji@contoh.id',
  address: 'Jl. Uji 1', domicile_city: 'Cirebon', bpjs_number: '0001234567890', bank_account_number: '1234567890123', salary: 9000000,
  medical_status: 'FIT', medical_diagnosis: 'X', not_in_catalog: 'secret' };
const FS = async (roles) => fsec.applyFieldSecurity(RECORD, await fsec.loadFieldSecurity(db, roles));
await check('a field that is not catalogued is HIDDEN', async () => { ok(!('not_in_catalog' in (await FS(['workforce_manager'])).data)); });
await check('a role with no policy rows sees nothing at all', async () => { eq((await FS(['payroll_officer'])).data, {}); eq((await FS([])).data, {}); });
await check('social-security, financial and medical fields are HIDDEN for every role in CP1', async () => {
  for (const r of ['workforce_manager', 'hrd_officer', 'operations_director']) {
    const d = (await FS([r])).data;
    for (const f of ['bpjs_number', 'bank_account_number', 'salary', 'medical_status', 'medical_diagnosis']) ok(!(f in d), `${r} sees ${f}`);
  }
});
await check('NIK: MASKED for Workforce Manager and HRD (last 4 only, raw never returned), HIDDEN for the Director', async () => {
  for (const r of ['workforce_manager', 'hrd_officer']) {
    const o = await FS([r]);
    eq([o.visibility.nik, o.data.nik], ['MASKED', '************0001']);
    ok(!JSON.stringify(o.data).includes(RECORD.nik), 'raw NIK present');
  }
  ok(!('nik' in (await FS(['operations_director'])).data), 'director sees nik');
});
await check('masking rules: phone (last 4), email (first letter + domain), birth date (year only), redact', async () => {
  const d = (await FS(['operations_director'])).data;
  eq(d.phone, '**********7890');
  const w = (await FS(['workforce_manager'])).data;
  eq([w.birth_date, w.address], ['1996', fsec.REDACTED]);
  eq([fsec.mask('nama.uji@contoh.id', 'EMAIL'), fsec.mask('abc', 'LAST4'), fsec.mask(null, 'LAST4'), fsec.mask('x', 'NONE')], ['n***@contoh.id', fsec.REDACTED, null, fsec.REDACTED]);
});
await check('different roles see different visibility (address: MASKED for WFM, FULL for HRD)', async () => {
  eq([(await FS(['workforce_manager'])).data.address, (await FS(['hrd_officer'])).data.address], [fsec.REDACTED, 'Jl. Uji 1']);
});
await check('multiple roles: the most permissive visibility applies (WFM + HRD → address FULL, NIK still MASKED)', async () => {
  const o = await FS(['workforce_manager', 'hrd_officer']);
  eq([o.visibility.address, o.visibility.nik], ['FULL', 'MASKED']);
});
await check('MASKED with a NONE mask rule is fully redacted (fail closed)', async () => {
  const cat = new Map([['x_field', { field_code: 'x_field', sensitivity: 'RESTRICTED', mask_rule: 'NONE' }]]);
  eq(fsec.applyFieldSecurity({ x_field: 'raw' }, { catalog: cat, policy: new Map([['x_field', 'MASKED']]) }).data, { x_field: fsec.REDACTED });
});
await check('revealedSensitive lists SENSITIVE/RESTRICTED fields returned FULL (input for VIEW_SENSITIVE_FIELD)', async () => {
  const cat = new Map([['nik', { field_code: 'nik', sensitivity: 'RESTRICTED', mask_rule: 'LAST4' }], ['full_name', { field_code: 'full_name', sensitivity: 'PERSONAL', mask_rule: 'REDACT' }]]);
  eq(fsec.applyFieldSecurity({ nik: RECORD.nik, full_name: 'A' }, { catalog: cat, policy: new Map([['nik', 'FULL'], ['full_name', 'FULL']]) }).revealedSensitive, ['nik']);
});
await check('field_policy only accepts FULL / MASKED / HIDDEN and catalogued fields (database constraints)', async () => {
  eq(await sqlState(() => owner.query(`INSERT INTO talent.field_policy VALUES ('hrd_officer','nik','PARTIAL')`)), '23514');
  eq(await sqlState(() => owner.query(`INSERT INTO talent.field_policy VALUES ('hrd_officer','not_a_field','FULL')`)), '23503');
});

// =============================================================================================================
section('7. DATA SCOPE (fail closed)');
await check('no scope row = no access', async () => {
  const s = scope.resolveScope([]);
  eq([s.all, scope.checkScope(s, { project: 'P1' })], [false, { allowed: false, reason: 'NO_SCOPE' }]);
  eq(scope.checkScope(null), { allowed: false, reason: 'NO_SCOPE' });
});
await check('scope ALL grants access', async () => { eq(scope.checkScope(scope.resolveScope([{ scope_type: 'ALL', scope_value: null }])).allowed, true); });
await check('ORGANIZATION / PROJECT scope is recognised but not enabled in CP1 (fails closed, reported as pending)', async () => {
  const s = scope.resolveScope([{ scope_type: 'PROJECT', scope_value: 'P1' }, { scope_type: 'ORGANIZATION', scope_value: 'O1' }]);
  eq(scope.checkScope(s, { project: 'P1' }), { allowed: false, reason: 'SCOPE_TYPE_NOT_ENABLED' });
  eq(scope.checkScope(s, { project: 'P2' }), { allowed: false, reason: 'OUT_OF_SCOPE' });
  eq(scope.summarizeScope(s).pending_scope_types.sort(), ['ORGANIZATION', 'PROJECT']);
});
await check('user_scope constraints: ALL takes no value, ORGANIZATION/PROJECT require one, duplicates refused', async () => {
  eq(await sqlState(() => owner.query(`INSERT INTO talent.user_scope (user_id, scope_type, scope_value) VALUES (1, 'ALL', 'x')`)), '23514');
  eq(await sqlState(() => owner.query(`INSERT INTO talent.user_scope (user_id, scope_type) VALUES (1, 'PROJECT')`)), '23514');
  eq(await sqlState(() => owner.query(`INSERT INTO talent.user_scope (user_id, scope_type) VALUES (${U.wf}, 'ALL')`)), '23505');
});
await check('seeded scope: ALL for the Workforce Manager, HRD and Director users; none for payroll/health/HSE/supervisor', async () => {
  const rows = await all(db, `SELECT user_id FROM talent.user_scope WHERE scope_type = 'ALL' ORDER BY 1`);
  const ids = rows.map((r) => Number(r.user_id));
  for (const id of [U.wf, U.hrd, U.dir, MULTI_ID]) ok(ids.includes(id), `missing scope for ${id}`);
  for (const id of [U.pay, U.health, U.hse, SUP_ID]) ok(!ids.includes(id), `unexpected scope for ${id}`);
  eq([(await wf.get('/api/tw/me')).body.scope, (await pay.get('/api/tw/me')).body.scope], [{ all: true, pending_scope_types: [] }, { all: false, pending_scope_types: [] }]);
});

// =============================================================================================================
section('8. IDENTITY — worker_uuid + display IDs (as the runtime role)');
const w1 = await identity.createWorker(db, { actorUserId: U.wf });
await check('createWorker returns a v4 UUID in lifecycle CANDIDATE; no employer/project/position column exists', async () => {
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(w1.worker_uuid), w1.worker_uuid);
  eq(w1.lifecycle_status, 'CANDIDATE');
  const cols = (await all(db, `SELECT column_name FROM information_schema.columns WHERE table_schema='talent' AND table_name='worker' ORDER BY ordinal_position`)).map((r) => r.column_name);
  eq(cols, ['worker_uuid', 'lifecycle_status', 'created_at', 'created_by_user_id', 'updated_at']);
});
await check('display IDs: REGISTRATION → KAHE-TAL-YYYY-NNNNNN (WIB year), TALENT → KAHE-T-NNNNNN, WORKER → KAHE-W-NNNNNN', async () => {
  const r = await identity.issueDisplayId(db, w1.worker_uuid, 'REGISTRATION', { actorUserId: U.wf });
  const t = await identity.issueDisplayId(db, w1.worker_uuid, 'TALENT', { actorUserId: U.wf });
  const w = await identity.issueDisplayId(db, w1.worker_uuid, 'WORKER', { actorUserId: U.wf });
  ok(new RegExp(`^KAHE-TAL-${identity.wibYear()}-\\d{6}$`).test(r.display_id), r.display_id);
  ok(/^KAHE-T-\d{6}$/.test(t.display_id) && /^KAHE-W-\d{6}$/.test(w.display_id), `${t.display_id} ${w.display_id}`);
  eq((await identity.getDisplayIds(db, w1.worker_uuid)).map((x) => x.id_type), ['REGISTRATION', 'TALENT', 'WORKER']);
});
await check('one display ID per type per worker: a second REGISTRATION is refused and nothing is written', async () => {
  const before = (await one(db, 'SELECT count(*)::int AS n FROM talent.worker_display_id')).n;
  eq(await sqlState(() => identity.issueDisplayId(db, w1.worker_uuid, 'REGISTRATION')), 'TALENT_DISPLAY_ID_ALREADY_ISSUED');
  eq((await one(db, 'SELECT count(*)::int AS n FROM talent.worker_display_id')).n, before);
});
await check('ambiguous id_type values (TAL / T / W) are refused by the library and by the database', async () => {
  for (const bad of ['TAL', 'T', 'W']) eq(await sqlState(() => identity.issueDisplayId(db, w1.worker_uuid, bad)), 'TALENT_INVALID_ID_TYPE');
  const w2 = await identity.createWorker(db);
  eq(await sqlState(() => db.query(`INSERT INTO talent.worker_display_id (worker_uuid, id_type, display_id) VALUES ($1, 'T', 'KAHE-T-999998')`, [w2.worker_uuid])), '23514');
});
await check('the database refuses a display ID in the wrong format for its type', async () => {
  const w3 = await identity.createWorker(db);
  for (const [type, id] of [['TALENT', 'KAHE-W-000123'], ['REGISTRATION', 'KAHE-TAL-000123'], ['WORKER', 'kahe-w-000123']]) {
    eq([type, await sqlState(() => db.query(`INSERT INTO talent.worker_display_id (worker_uuid, id_type, display_id) VALUES ($1, $2, $3)`, [w3.worker_uuid, type, id]))], [type, '23514']);
  }
});
await check('display IDs are unique across workers and immutable (UPDATE / DELETE refused even for the owner)', async () => {
  const w4 = await identity.createWorker(db);
  const taken = (await one(db, `SELECT display_id FROM talent.worker_display_id WHERE id_type = 'TALENT' LIMIT 1`)).display_id;
  eq(await sqlState(() => db.query(`INSERT INTO talent.worker_display_id (worker_uuid, id_type, display_id) VALUES ($1, 'TALENT', $2)`, [w4.worker_uuid, taken])), '23505');
  eq(await sqlState(() => owner.query(`UPDATE talent.worker_display_id SET display_id = display_id`)), 'P0001');
  eq(await sqlState(() => owner.query(`DELETE FROM talent.worker_display_id`)), 'P0001');
  eq(await sqlState(() => owner.query(`DELETE FROM talent.worker`)), 'P0001');
});
await check('unknown worker / malformed uuid are refused', async () => {
  eq(await sqlState(() => identity.issueDisplayId(db, '22222222-2222-4222-8222-222222222222', 'TALENT')), 'TALENT_WORKER_NOT_FOUND');
  eq(await sqlState(() => identity.issueDisplayId(db, 'not-a-uuid', 'TALENT')), 'TALENT_INVALID_WORKER_UUID');
});
await check('formatDisplayId: padding, bounds and space exhaustion at 999,999', async () => {
  eq([identity.formatDisplayId('REGISTRATION', 1284, 2026), identity.formatDisplayId('TALENT', 512, 0), identity.formatDisplayId('WORKER', 999999)],
    ['KAHE-TAL-2026-001284', 'KAHE-T-000512', 'KAHE-W-999999']);
  eq(await sqlState(() => identity.formatDisplayId('WORKER', 1000000)), 'TALENT_DISPLAY_ID_SPACE_EXHAUSTED');
  eq(await sqlState(() => identity.formatDisplayId('REGISTRATION', 1)), 'TALENT_INVALID_YEAR');
  eq(identity.wibYear(new Date('2026-12-31T17:30:00Z')), 2027);   // 00:30 WIB on 1 Jan 2027
});
await check('the sequence maximum is enforced by the database as well (MAXVALUE 999999, NO CYCLE)', async () => {
  eq((await all(owner, `SELECT sequencename, max_value::text, cycle FROM pg_sequences WHERE schemaname='talent' AND sequencename IN ('seq_t','seq_tal','seq_w') ORDER BY 1`)).map((r) => [r.sequencename, r.max_value, r.cycle]),
    [['seq_t', '999999', false], ['seq_tal', '999999', false], ['seq_w', '999999', false]]);
});

// =============================================================================================================
section('9. SECURITY & ACCESS AUDIT (metadata only)');
await check('all six approved event types can be appended by the runtime role', async () => {
  for (const e of audit.EVENT_TYPES) {
    const id = await audit.recordEvent(db, { eventType: e, outcome: e === 'PERMISSION_DENIED' ? 'DENIED' : 'ALLOWED', actorUserId: U.hrd,
      actorRoles: ['hrd_officer'], workerUuid: w1.worker_uuid, permissionCode: 'tw_worker_passport', action: 'VIEW', route: '/probe', payload: { fields: ['nik'], visibility: 'MASKED' } });
    ok(Number(id) > 0, e);
  }
});
await check('the library refuses raw sensitive content (nik, salary, bank account, diagnosis, nested, NIK-shaped values)', async () => {
  for (const p of [{ nik: 'x' }, { NIK: 'x' }, { meta: { base_salary_sen: 1 } }, { bankAccountNo: 'x' }, { list: [{ medical_diagnosis: 'x' }] },
    { note: 'id 3201234567890001' }, { value: 'x' }, { no_rekening: 'x' }, { gaji_pokok: 1 }]) {
    eq([JSON.stringify(p), await sqlState(() => audit.recordEvent(db, { eventType: 'VIEW_PASSPORT', outcome: 'ALLOWED', payload: p }))], [JSON.stringify(p), 'TALENT_AUDIT_UNSAFE_PAYLOAD']);
  }
});
await check('the refusal reports only the location of the offending key, never its value', async () => {
  try { audit.assertSafePayload({ a: { nik: '3201234567890001' } }); throw new Error('not refused'); }
  catch (e) { eq([e.code, e.detail], ['TALENT_AUDIT_UNSAFE_PAYLOAD', { path: '$.a.nik' }]); }
});
await check('the DATABASE refuses the same payloads even when the library is bypassed', async () => {
  for (const p of ['{"nik":"x"}', '{"a":{"Salary":1}}', '{"a":[{"bank_account":"x"}]}', '{"diagnosis":"x"}', '{"n":"3201234567890001"}', '{"a":["x",{"rekening":1}]}']) {
    eq([p, await sqlState(() => db.query(`INSERT INTO talent.audit_event (event_type, outcome, payload) VALUES ('VIEW_PASSPORT','ALLOWED',$1::jsonb)`, [p]))], [p, '23514']);
  }
});
await check('invalid event types / outcomes are refused; PERMISSION_DENIED must be DENIED', async () => {
  eq(await sqlState(() => audit.recordEvent(db, { eventType: 'EDIT_WORKER', outcome: 'ALLOWED' })), 'TALENT_AUDIT_INVALID_EVENT');
  eq(await sqlState(() => db.query(`INSERT INTO talent.audit_event (event_type, outcome) VALUES ('EDIT_WORKER','ALLOWED')`)), '23514');
  eq(await sqlState(() => db.query(`INSERT INTO talent.audit_event (event_type, outcome) VALUES ('PERMISSION_DENIED','ALLOWED')`)), '23514');
});
await check('no raw sensitive value exists anywhere in the audit log after this suite', async () => {
  const bad = await one(db, `SELECT count(*)::int AS n FROM talent.audit_event WHERE talent.jsonb_has_forbidden_content(payload) OR route ~ '[0-9]{16}'`);
  eq(bad.n, 0);
});

// =============================================================================================================
section('10. LIGHT TALENT SHELL (UI)');
const LOGO_MASTER_SHA = '68bd292b8728c0407f3cd5f8603a1a0beb952c68f4d21922fbe166f948940ed5';
await check('the served logo is byte-identical to the uploaded KAHE GROUP INDONESIA master', async () => {
  const r = await fetch(`${srv.base}/tw-assets/kahe-group-indonesia-logo.png`);
  eq([r.status, sha(Buffer.from(await r.arrayBuffer()))], [200, LOGO_MASTER_SHA]);
});
await check('the shell uses the master logo file with its native aspect ratio (2172 × 724), no CSS/SVG substitute', async () => {
  const html = (await wf.get('/tw/app/')).text;
  ok(/<img src="\/tw-assets\/kahe-group-indonesia-logo\.png"[^>]*width="2172" height="724"/.test(html), 'logo <img> missing or resized');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tw-assets', 'tw-shell.css'), 'utf8');
  ok(!/\.tw-brand img[^}]*[^-]width:\s*\d/.test(css), 'logo width is forced in CSS');
});
await check('Talent views are not reachable through static serving', async () => {
  for (const u of ['/app-shell.html', '/modules/talent/views/app-shell.html', '/views/app-shell.html', '/tw/app-shell.html']) {
    const r = await anon.get(u); ok(r.status === 404 || r.status === 302, `${u} -> ${r.status}`); ok(!/tw-shell\.js/.test(r.text), `${u} served the shell`);
  }
});
await check('page responses are not cached (Cache-Control: no-store)', async () => {
  eq((await wf.get('/tw/app/talent-pool')).headers.get('cache-control'), 'no-store');
});
await check('no demo/mock data in the shell: no names, counts or projects from the mockups', async () => {
  const text = ['modules/talent/views/app-shell.html', 'public/tw-assets/tw-shell.js', 'public/tw-assets/tw-i18n.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  for (const s of ['Ahmad', 'Rizky', 'Asep', 'Zamhaji', 'Siti', 'PPB Balongan', 'Wuhuan', '1,284', '4,892', 'KAHE-T-000512', '3214121508960001']) ok(!text.includes(s), `found "${s}"`);
});
await check('ID and EN dictionaries have exactly the same keys', async () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'tw-assets', 'tw-i18n.js'), 'utf8');
  const sandbox = { window: {} }; new Function('window', code)(sandbox.window);
  const { id, en } = sandbox.window.TwI18n.DICT;
  eq(Object.keys(id).sort(), Object.keys(en).sort());
});
await check('the canonical sidebar labels are present in the shell script, in order', async () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'tw-assets', 'tw-shell.js'), 'utf8');
  const labels = ['HOME', 'DASHBOARD', 'CANDIDATE REGISTRATION', 'TALENT POOL', 'VERIFICATION & SCREENING', 'DEPLOYMENT & ASSIGNMENT CONTROL',
    'CONTRACT & PLACEMENT', 'REPORTS & ANALYTICS', 'SETTINGS'];
  let pos = -1; for (const l of labels) { const i = js.indexOf(`'${l}'`); ok(i > pos, `label ${l} missing or out of order`); pos = i; }
  ok(!/Talent Bank|TALENT BANK|RECRUITMENT|WORKFORCE PLANNING/.test(js), 'historical sidebar label present');
});
await check('front-end API calls are relative (no localhost / hard-coded host)', async () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'tw-assets', 'tw-shell.js'), 'utf8');
  ok(!/https?:\/\//.test(js.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'absolute URL in tw-shell.js');
});
await check('the Talent shell does not load the dark portal stylesheet or scripts', async () => {
  const html = (await wf.get('/tw/app/')).text;
  ok(!/styles\.css|page-shell\.js|app\.js|i18n\.js"/.test(html.replace('tw-i18n.js', '')), 'portal asset referenced');
});

// =============================================================================================================
section('11. TALENT BACKUP / RESTORE (tools/talent/verify-backup-restore.js)');
await check('pg_dump --schema=talent → empty database → pg_restore: structure, privileges, ledger and every row identical; restored alone; runtime protections hold', async () => {
  const target = `kahe360_test_twbk_${process.pid}`;
  const r = await verifyTalentBackup({ sourceUrl: __t.ownerUrl, adminUrl: process.env.TEST_DATABASE_ADMIN_URL, targetDb: target,
    runtimeRole: APP, runtimeUrl: urlFor(APP, target) });
  eq([r.mismatches, r.restored_non_talent_tables, r.runtime_problems, r.ok], [[], 0, [], true]);
  ok(r.rows > 0 && r.tables === 11, `rows ${r.rows}, tables ${r.tables}`);
});

} finally {
  for (const s of servers) s.kill();
  await owner.close(); await coreOwner.close();
  await __core.drop(); await __t.drop();
}

console.log('\n============================================================');
console.log(`TALENT CP1 TESTS: ${passed} passed, ${failed} failed`);
console.log('============================================================');
if (failed) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
