// tests/dbm1-foundation.test.js
// DB-M1 checkpoint 1 — PostgreSQL foundation. Runs against a REAL PostgreSQL
// server (no mocks, no SQLite compatibility mode). The legacy SQLite schema in
// database/legacy-sqlite/ is used ONLY as the reference the new schema must match.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTestDatabase } = require('./helpers/pgTestDb');
const { migrate, assertSchemaCurrent, listMigrations } = require('../database/pg/migrate');
const { withTransaction, withRetry, toNumbered } = require('../database/db');

let passed = 0; let failed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) {
    failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function eq(a, e, label = '') { const x = JSON.stringify(a); const y = JSON.stringify(e); if (x !== y) throw new Error(`${label}expected ${y}, got ${x}`); }
function ok(v, label) { if (!v) throw new Error(label || 'expected truthy'); }
async function rejects(fn, pattern, label = 'expected rejection') {
  let err = null; try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error(label);
  if (pattern && !pattern.test(`${err.code || ''} ${err.message}`)) throw new Error(`${label}: wrong error "${err.code} ${err.message}"`);
  return err;
}
const section = (t) => console.log(`\n${t}`);

(async () => {
  const t = await createTestDatabase('dbm1_foundation');
  const db = t.db;                 // RUNTIME role
  const owner = t.openOwner();     // schema-owner role

  // legacy reference
  const lite = new DatabaseSync(':memory:');
  lite.exec('PRAGMA foreign_keys = ON;');
  require('../database/legacy-sqlite/init-db').initDb(lite);
  const liteTables = lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();

  section('REAL POSTGRESQL RUNTIME');
  await check('the suite is connected to a real PostgreSQL server (13+)', async () => {
    const v = await db.prepare('SELECT version() AS v, current_setting(\'server_version_num\')::int AS n').get();
    ok(/^PostgreSQL \d+/.test(v.v), v.v); ok(v.n >= 130000, String(v.n));
    console.log(`        ${v.v.split(' on ')[0]}`);
  });
  await check('suites run as the least-privilege runtime role, not a superuser', async () => {
    const r = await db.prepare('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su').get();
    eq([r.u, r.su], ['kahe360_test_app', false]);
  });
  await check('session time zone is UTC and database collation is C (A3 ordering parity)', async () => {
    eq((await db.prepare('SHOW TIME ZONE').get()).TimeZone, 'UTC');
    eq((await db.prepare('SELECT datcollate AS c FROM pg_database WHERE datname = current_database()').get()).c, 'C');
    const rows = await db.prepare("SELECT x FROM (VALUES ('b'),('B'),('a'),('_'),('A')) v(x) ORDER BY x").all();
    eq(rows.map((r) => r.x), lite.prepare("SELECT x FROM (SELECT 'b' x UNION SELECT 'B' UNION SELECT 'a' UNION SELECT '_' UNION SELECT 'A') ORDER BY x").all().map((r) => r.x));
  });

  await check('migrations create structure only — no business row, policy or user is invented', async () => {
    const nonEmpty = [];
    for (const name of liteTables) {
      if ((await owner.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).n !== 0) nonEmpty.push(name);
    }
    eq(nonEmpty, []);
  });


  section('CANONICAL DB LAYER');
  await check('`?` placeholders are numbered; literals, identifiers and comments are left alone', () => {
    eq(toNumbered("SELECT '?' AS q, \"a?\" FROM t WHERE a = ? AND b = ? -- why?\n AND c = ? /* ? */").text,
      "SELECT '?' AS q, \"a?\" FROM t WHERE a = $1 AND b = $2 -- why?\n AND c = $3 /* ? */");
    eq(toNumbered("SELECT 'it''s ?' , ?").count, 1);
  });
  await check('parameter count mismatch, undefined and boolean parameters are rejected before reaching the server', async () => {
    await rejects(() => db.prepare('SELECT ?::int').get(), /expects 1 parameter/);
    await rejects(() => db.prepare('SELECT ?::int').get(undefined), /undefined/);
    await rejects(() => db.prepare('SELECT ?::int').get(true), /boolean/);
  });
  await check('values render exactly as A3 did: integers as numbers, DATE and TIMESTAMPTZ as canonical strings', async () => {
    const r = await db.prepare(`SELECT 9007199254740991::bigint AS big, 2150000000::bigint AS sen, SUM(x)::numeric AS total,
      DATE '2026-02-28' AS d, TIMESTAMPTZ '2026-03-01 00:30:15.789+07' AS ts, COUNT(*) AS n FROM (VALUES (1::bigint),(2)) v(x)`).get();
    eq(r, { big: 9007199254740991, sen: 2150000000, total: 3, d: '2026-02-28', ts: '2026-02-28 17:30:15', n: 2 });
  });
  await check('an integer beyond the safe JS range throws instead of silently rounding money', async () => {
    await rejects(() => db.prepare('SELECT 9007199254740993::bigint AS x').get(), /safe JavaScript range/);
  });
  await check('kahe_now() matches SQLite datetime(\'now\'): UTC, whole seconds, statement time', async () => {
    const r = await db.prepare('SELECT kahe_now() AS t, extract(microseconds FROM kahe_now())::bigint % 1000000 AS us').get();
    ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r.t), r.t); eq(r.us, 0);
    ok(Math.abs(Date.parse(`${r.t.replace(' ', 'T')}Z`) - Date.now()) < 5000, 'not close to wall clock UTC');
  });
  await check('run() reports changes and the generated id (INSERT … RETURNING id)', async () => {
    const a = await db.prepare("INSERT INTO projects (code, name) VALUES (?, ?) RETURNING id").run('DBM1-A', 'A');
    const b = await db.prepare("INSERT INTO projects (code, name) VALUES (?, ?) RETURNING id").run('DBM1-B', 'B');
    eq([a.changes, typeof a.lastInsertRowid, b.lastInsertRowid - a.lastInsertRowid], [1, 'number', 1]);
    eq((await db.prepare("UPDATE projects SET name = name || '!' WHERE code LIKE ?").run('DBM1-%')).changes, 2);
    eq(await db.prepare('SELECT 1 AS x WHERE false').get(), undefined);
  });

  section('MIGRATION VERSIONING');
  await check('every migration file is recorded once, in order, with its checksum', async () => {
    const rows = await db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    eq(rows, listMigrations().map((m) => ({ version: m.version, checksum: m.checksum })));
  });
  await check('re-running the migrator applies nothing (no accidental double application)', async () => {
    const r = await migrate({ connectionString: t.ownerUrl, log: () => {} });
    eq(r.ran, []);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, listMigrations().length);
  });
  await check('dry-run reports pending work and changes nothing', async () => {
    const fresh = await createTestDatabase('dbm1_dry', { migrated: false });
    try {
      const r = await migrate({ connectionString: fresh.ownerUrl, dryRun: true, log: () => {} });
      eq(r.pending, listMigrations().map((m) => m.version));
      eq((await fresh.db.prepare("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='public'").get()).n, 0);
    } finally { await fresh.drop(); }
  });
  await check('a failing migration rolls back completely and records no version', async () => {
    const fresh = await createTestDatabase('dbm1_fail', { migrated: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kahe-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);');
      fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); INSERT INTO b VALUES (1); SELECT 1/0;');
      await rejects(() => migrate({ connectionString: fresh.ownerUrl, dir, log: () => {} }), /0002_bad\.sql failed and was rolled back/);
      const o = fresh.openOwner();
      eq((await o.prepare('SELECT version FROM schema_migrations').all()).map((r) => r.version), ['0001']);
      eq((await o.prepare("SELECT to_regclass('public.b') AS t").get()).t, null);
      // fixing the file and re-running resumes from 0002 only
      fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int);');
      eq((await migrate({ connectionString: fresh.ownerUrl, dir, log: () => {} })).ran, ['0002']);
      // editing an APPLIED migration is refused
      fs.writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE a (id bigint);');
      await rejects(() => migrate({ connectionString: fresh.ownerUrl, dir, log: () => {} }), /modified after it was applied/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); await fresh.drop(); }
  });
  await check('the server-side schema check verifies but never alters', async () => {
    eq(await assertSchemaCurrent(db), listMigrations().length);
    const fresh = await createTestDatabase('dbm1_empty', { migrated: false });
    try { await rejects(() => assertSchemaCurrent(fresh.db), /not migrated/); } finally { await fresh.drop(); }
  });
  // A4 CP1 (migration 0006) — the ONLY PostgreSQL-native objects outside the A3 parity set. Literal,
  // exhaustive and exact: an unknown table, foreign key or trigger still fails these checks, and every A3
  // object is still compared one-for-one against the SQLite schema. Extend only with an approved migration.
  const A4_PG_NATIVE_TABLES = ['attendance_closing_policies', 'attendance_closing_policy_events',
    'attendance_closing_policy_rules', 'attendance_period_events', 'attendance_periods'];
  const A4_PG_NATIVE_FKS = [
    'attendance_closing_policies(legal_entity_id)->legal_entities(id) NO ACTION',
    'attendance_closing_policy_events(policy_id)->attendance_closing_policies(id) NO ACTION',
    'attendance_closing_policy_rules(policy_id)->attendance_closing_policies(id) NO ACTION',
    'attendance_period_events(period_id)->attendance_periods(id) NO ACTION',
    'attendance_periods(legal_entity_id)->legal_entities(id) NO ACTION',
  ];
  const A4_PG_NATIVE_TRIGGERS = [
    'trg_attendance_period_events_insert_guard|attendance_period_events|INSERT|BEFORE|O',
    'trg_attendance_period_events_no_delete|attendance_period_events|DELETE|BEFORE|O',
    'trg_attendance_period_events_no_update|attendance_period_events|UPDATE|BEFORE|O',
    'trg_attendance_periods_audit_insert|attendance_periods|INSERT|AFTER|O',
    'trg_attendance_periods_audit_update|attendance_periods|UPDATE|AFTER|O',
    'trg_attendance_periods_guard_insert|attendance_periods|INSERT|BEFORE|O',
    'trg_attendance_periods_guard_update|attendance_periods|UPDATE|BEFORE|O',
    'trg_attendance_periods_no_delete|attendance_periods|DELETE|BEFORE|O',
    'trg_closing_policies_audit_insert|attendance_closing_policies|INSERT|AFTER|O',
    'trg_closing_policies_audit_update|attendance_closing_policies|UPDATE|AFTER|O',
    'trg_closing_policies_guard_insert|attendance_closing_policies|INSERT|BEFORE|O',
    'trg_closing_policies_guard_update|attendance_closing_policies|UPDATE|BEFORE|O',
    'trg_closing_policies_no_delete|attendance_closing_policies|DELETE|BEFORE|O',
    'trg_closing_policy_events_insert_guard|attendance_closing_policy_events|INSERT|BEFORE|O',
    'trg_closing_policy_events_no_delete|attendance_closing_policy_events|DELETE|BEFORE|O',
    'trg_closing_policy_events_no_update|attendance_closing_policy_events|UPDATE|BEFORE|O',
    'trg_closing_policy_rules_audit_delete|attendance_closing_policy_rules|DELETE|AFTER|O',
    'trg_closing_policy_rules_audit_insert|attendance_closing_policy_rules|INSERT|AFTER|O',
    'trg_closing_policy_rules_audit_update|attendance_closing_policy_rules|UPDATE|AFTER|O',
    'trg_closing_policy_rules_guard_delete|attendance_closing_policy_rules|DELETE|BEFORE|O',
    'trg_closing_policy_rules_guard_insert|attendance_closing_policy_rules|INSERT|BEFORE|O',
    'trg_closing_policy_rules_guard_update|attendance_closing_policy_rules|UPDATE|BEFORE|O',
  ];
  // A4 CP2 (migration 0007) — same discipline: literal, exhaustive, exact.
  const A4_CP2_PG_NATIVE_TABLES = ['attendance_readiness_evaluations'];
  const A4_CP2_PG_NATIVE_FKS = [
    'attendance_readiness_evaluations(period_id)->attendance_periods(id) NO ACTION',
    'attendance_readiness_evaluations(policy_id)->attendance_closing_policies(id) NO ACTION',
  ];
  const A4_CP2_PG_NATIVE_TRIGGERS = [
    'trg_readiness_evaluations_guard_insert|attendance_readiness_evaluations|INSERT|BEFORE|O',
    'trg_readiness_evaluations_no_delete|attendance_readiness_evaluations|DELETE|BEFORE|O',
    'trg_readiness_evaluations_no_update|attendance_readiness_evaluations|UPDATE|BEFORE|O',
  ];
  section('SCHEMA PARITY WITH THE AUTHORITATIVE A3 SQLITE SCHEMA');
  const pgCols = await db.prepare(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`).all();
  const byTable = {};
  for (const c of pgCols) (byTable[c.table_name] = byTable[c.table_name] || []).push(c);
  await check(`all ${liteTables.length} A3 tables exist (plus sessions, the two migration ledgers and the ${A4_PG_NATIVE_TABLES.length + A4_CP2_PG_NATIVE_TABLES.length} allowlisted A4 tables)`, () => {
    eq(Object.keys(byTable).sort(), [...liteTables, 'data_migrations', 'schema_migrations', 'sessions', ...A4_PG_NATIVE_TABLES, ...A4_CP2_PG_NATIVE_TABLES].sort());
  });
  await check('every column exists in the same order with the same nullability', () => {
    const diffs = [];
    for (const name of liteTables) {
      const a = lite.prepare(`PRAGMA table_info(${name})`).all().map((c) => `${c.name}:${c.notnull || c.pk ? 'NN' : 'null'}`);
      const b = byTable[name].map((c) => `${c.column_name}:${c.is_nullable === 'NO' ? 'NN' : 'null'}`);
      // SQLite quirk: a non-INTEGER PRIMARY KEY is nullable there; PostgreSQL PKs are NOT NULL. Same rule, stricter engine.
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${name}: ${a.filter((x, i) => x !== b[i]).join(',')} vs ${b.filter((x, i) => x !== a[i]).join(',')}`);
    }
    eq(diffs, []);
  });
  await check('types follow the documented policy (INTEGER→bigint, REAL→double, *_at→timestamptz, business dates→date)', () => {
    const bad = []; const tally = {};
    for (const name of liteTables) {
      const src = Object.fromEntries(lite.prepare(`PRAGMA table_info(${name})`).all().map((c) => [c.name, c]));
      for (const c of byTable[name]) {
        const s = src[c.column_name]; const pg = c.data_type;
        tally[pg] = (tally[pg] || 0) + 1;
        const okType = (s.type === 'INTEGER' && pg === 'bigint') || (s.type === 'REAL' && pg === 'double precision')
          || (s.type === 'TEXT' && ['text', 'date', 'timestamp with time zone'].includes(pg));
        if (!okType) bad.push(`${name}.${c.column_name} ${s.type}->${pg}`);
        if (pg === 'timestamp with time zone' && !/(_at|timestamp)$/.test(c.column_name)) bad.push(`${name}.${c.column_name} unexpected timestamptz`);
        if (/_sen$|_bp$|_minutes/.test(c.column_name) && s.type === 'INTEGER' && pg !== 'bigint') bad.push(`${name}.${c.column_name} money/time not bigint`);
      }
    }
    eq(bad, []);
    console.log(`        ${JSON.stringify(tally)}`);
  });
  await check('no money, rate or minute column is floating point', () => {
    const floats = pgCols.filter((c) => ['double precision', 'real', 'numeric'].includes(c.data_type)).map((c) => `${c.table_name}.${c.column_name}`);
    eq(floats.sort(), ['timesheet_entries.overtime_hours_approved', 'timesheet_entries.overtime_hours_requested', 'timesheet_entries.work_hours']);
  });
  await check('every AUTOINCREMENT key became an identity column; datetime(\'now\') defaults became kahe_now()', () => {
    const bad = [];
    for (const name of liteTables) {
      const sql = lite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name).sql;
      const idCol = byTable[name].find((c) => c.column_name === 'id');
      if (/AUTOINCREMENT/i.test(sql) !== Boolean(idCol && idCol.is_identity === 'YES')) bad.push(`${name}: identity mismatch`);
      for (const c of lite.prepare(`PRAGMA table_info(${name})`).all()) {
        const pg = byTable[name].find((x) => x.column_name === c.name);
        if (/datetime\('now'\)/.test(c.dflt_value || '') !== /kahe_now\(\)/.test(pg.column_default || '')) bad.push(`${name}.${c.name}: default mismatch`);
      }
    }
    eq(bad, []);
  });
  await check('primary keys are identical', async () => {
    const rows = await db.prepare(`SELECT c.relname AS t, string_agg(a.attname, ',' ORDER BY k.ord) AS cols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN unnest(con.conkey) WITH ORDINALITY k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'p' AND c.relnamespace = 'public'::regnamespace GROUP BY c.relname`).all();
    const pg = Object.fromEntries(rows.map((r) => [r.t, r.cols]));
    const diffs = liteTables.filter((n) => {
      const pk = lite.prepare(`PRAGMA table_info(${n})`).all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',');
      return pk !== (pg[n] || '');
    });
    eq(diffs, []);
  });
  await check('foreign keys are identical (columns, target, ON DELETE action)', async () => {
    const rows = await db.prepare(`SELECT c.relname AS t, (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols, rc.relname AS rt,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS rcols, con.confdeltype AS del
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class rc ON rc.oid = con.confrelid
      WHERE con.contype = 'f' AND c.relnamespace = 'public'::regnamespace`).all();
    const act = { a: 'NO ACTION', c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT', d: 'SET DEFAULT' };
    const pg = rows.map((r) => `${r.t}(${r.cols})->${r.rt}(${r.rcols}) ${act[r.del]}`).sort();
    const sl = [];
    for (const n of liteTables) {
      const g = {};
      for (const f of lite.prepare(`PRAGMA foreign_key_list(${n})`).all()) (g[f.id] = g[f.id] || []).push(f);
      for (const fk of Object.values(g)) {
        fk.sort((a, b) => a.seq - b.seq);
        const refCols = fk.map((f) => f.to || lite.prepare(`PRAGMA table_info(${fk[0].table})`).all().find((c) => c.pk).name);
        sl.push(`${n}(${fk.map((f) => f.from).join(',')})->${fk[0].table}(${refCols.join(',')}) ${fk[0].on_delete}`);
      }
    }
    eq(pg, [...sl, ...A4_PG_NATIVE_FKS, ...A4_CP2_PG_NATIVE_FKS].sort());
    console.log(`        ${pg.length} foreign keys (${sl.length} A3 + ${A4_PG_NATIVE_FKS.length} A4 CP1 + ${A4_CP2_PG_NATIVE_FKS.length} A4 CP2)`);
  });
  await check('all A3 indexes exist with the same uniqueness, the same columns and the same partial predicate', async () => {
    const pg = Object.fromEntries((await db.prepare(`SELECT i.relname AS name, x.indisunique AS uq, x.indpred IS NOT NULL AS partial,
        pg_get_indexdef(x.indexrelid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relnamespace = 'public'::regnamespace`).all()).map((r) => [r.name, r]));
    const norm = (s) => s.toLowerCase().replace(/ifnull/g, 'coalesce').replace(/::\w+( \w+)*/g, '').replace(/["'()\s]/g, '').replace(/<>/g, '!=');
    const bad = []; let partial = 0; let unique = 0;
    for (const ix of lite.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) {
      const p = pg[ix.name]; if (!p) { bad.push(`${ix.name}: missing`); continue; }
      const isUq = /CREATE UNIQUE/i.test(ix.sql); const where = ix.sql.split(/\bWHERE\b/i)[1];
      if (isUq) unique += 1; if (where) partial += 1;
      if (isUq !== p.uq) bad.push(`${ix.name}: uniqueness`);
      if (Boolean(where) !== p.partial) bad.push(`${ix.name}: partial`);
      const cols = (s) => norm(s.split(/\bWHERE\b/i)[0].replace(/^[^(]*\(/, '').replace(/\)\s*$/, ''));
      const a = cols(ix.sql.replace(/--[^\n]*/g, '')); const b = cols(p.def.replace(/^.*?USING btree /, ''));
      // one deliberate, equivalent simplification: service_date is NOT NULL inside that index's predicate
      if (a !== b && a.replace("coalesceservice_date,-", 'service_date') !== b) bad.push(`${ix.name}: columns ${a} vs ${b}`);
      if (where) {
        const wa = norm(where).replace(/;$/, ''); const wb = norm(p.def.split(/\bWHERE\b/)[1]);
        const canon = (w) => w.replace(/=anyarray\[([^\]]*)\]/g, 'in$1').replace(/!=allarray\[([^\]]*)\]/g, 'notin$1').replace(/,/g, '');
        if (canon(wa) !== canon(wb)) bad.push(`${ix.name}: predicate ${canon(wa)} vs ${canon(wb)}`);
      }
    }
    eq(bad, []);
    console.log(`        ${unique} unique indexes, ${partial} partial`);
  });
  await check('CHECK constraints: the same number on every table', async () => {
    const pg = Object.fromEntries((await db.prepare(`SELECT c.relname AS t, COUNT(*) AS n FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid WHERE con.contype = 'c' AND c.relnamespace = 'public'::regnamespace GROUP BY 1`).all()).map((r) => [r.t, r.n]));
    const bad = []; let total = 0;
    for (const n of liteTables) {
      const sql = lite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(n).sql.replace(/--[^\n]*/g, '');
      const want = (sql.match(/\bCHECK\s*\(/gi) || []).length; total += want;
      if (want !== (pg[n] || 0)) bad.push(`${n}: ${want} vs ${pg[n] || 0}`);
    }
    eq(bad, []); console.log(`        ${total} CHECK constraints`);
  });
  await check(`all 30 A3 integrity triggers exist on the same table, for the same event, enabled (plus the ${A4_PG_NATIVE_TRIGGERS.length + A4_CP2_PG_NATIVE_TRIGGERS.length} allowlisted A4 triggers)`, async () => {
    const pg = (await db.prepare(`SELECT t.tgname AS name, c.relname AS tbl, t.tgenabled AS en,
        CASE WHEN t.tgtype & 4 > 0 THEN 'INSERT' WHEN t.tgtype & 8 > 0 THEN 'DELETE' WHEN t.tgtype & 16 > 0 THEN 'UPDATE' END AS ev,
        (t.tgtype & 2) > 0 AS before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname NOT LIKE '%no_truncate'`).all())
      .map((r) => `${r.name}|${r.tbl}|${r.ev}|${r.before ? 'BEFORE' : 'AFTER'}|${r.en}`).sort();
    const sl = lite.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'").all()
      .map((r) => `${r.name}|${r.tbl_name}|${r.sql.match(/BEFORE (INSERT|UPDATE|DELETE)/i)[1].toUpperCase()}|BEFORE|O`).sort();
    eq(sl.length, 30); eq(pg.length, 30 + A4_PG_NATIVE_TRIGGERS.length + A4_CP2_PG_NATIVE_TRIGGERS.length);
    eq(pg, [...sl, ...A4_PG_NATIVE_TRIGGERS, ...A4_CP2_PG_NATIVE_TRIGGERS].sort());
  });

  section('IMMUTABLE AUDIT — DATABASE LEVEL, AS THE RUNTIME ROLE, RAW SQL');
  const ev = await db.prepare(`INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('E-1', '2026-09-01', 'CREATED') RETURNING id`).run();
  await check('audit events can be appended', () => ok(ev.lastInsertRowid > 0));
  await check('UPDATE of a historical audit event is blocked by the database', async () => {
    await rejects(() => db.exec(`UPDATE attendance_events SET event_type = 'TAMPERED' WHERE id = ${ev.lastInsertRowid}`), /ATTENDANCE_EVENT_IMMUTABLE/);
  });
  await check('DELETE of a historical audit event is blocked by the database', async () => {
    await rejects(() => db.exec(`DELETE FROM attendance_events WHERE id = ${ev.lastInsertRowid}`), /ATTENDANCE_EVENT_IMMUTABLE/);
    eq((await db.prepare('SELECT event_type FROM attendance_events WHERE id = ?').get(ev.lastInsertRowid)).event_type, 'CREATED');
  });
  await check('the error text is byte-identical to the A3 SQLite trigger message', async () => {
    lite.exec("INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('E-1','2026-09-01','CREATED')");
    let liteMsg; try { lite.exec('DELETE FROM attendance_events'); } catch (e) { liteMsg = e.message; }
    const pgErr = await rejects(() => db.exec('DELETE FROM attendance_events'), /./);
    eq(pgErr.message, liteMsg); eq(pgErr.code, 'KH001');
  });
  await check('the runtime role cannot TRUNCATE, disable or drop the protection, nor alter or drop the table', async () => {
    for (const sql of ['TRUNCATE attendance_events', 'ALTER TABLE attendance_events DISABLE TRIGGER ALL',
      'ALTER TABLE attendance_events DISABLE TRIGGER trg_attendance_events_no_update',
      'DROP TRIGGER trg_attendance_events_no_delete ON attendance_events', 'DROP TABLE attendance_events',
      'ALTER TABLE attendance_events ADD COLUMN x int', 'CREATE OR REPLACE FUNCTION trg_attendance_events_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      "SET session_replication_role = 'replica'", 'CREATE TABLE public.sneaky (id int)', 'DELETE FROM schema_migrations']) {
      await rejects(() => db.exec(sql), /^(42501|42P01)/, `runtime role was allowed to: ${sql}`);
    }
  });
  await check('even the schema owner cannot TRUNCATE an append-only table', async () => {
    for (const tbl of ['attendance_events', 'attendance_correction_actions', 'attendance_entry_versions', 'payroll_payslips']) {
      await rejects(() => owner.exec(`TRUNCATE ${tbl} CASCADE`), /AUDIT_APPEND_ONLY/);
    }
  });

  section('UNIQUE / PARTIAL-UNIQUE BEHAVIOUR');
  await check('partial unique index: only ONE national holiday per date, project holidays may share the date', async () => {
    const ins = (scope, name) => db.prepare(`INSERT INTO holidays ("date", name, scope) VALUES ('2026-12-25', ?, ?)`).run(name, scope);
    const insLite = (scope, name) => lite.prepare(`INSERT INTO holidays (date, name, scope) VALUES ('2026-12-25', ?, ?)`).run(name, scope);
    await ins('national', 'Natal'); insLite('national', 'Natal');
    const e = await rejects(() => ins('national', 'dup'), /23505/); eq(e.constraint, 'uq_holiday_national_per_date');
    let liteBlocked = false; try { insLite('national', 'dup'); } catch (_) { liteBlocked = true; } ok(liteBlocked);
    await ins('project', 'P1'); await ins('project', 'P2'); insLite('project', 'P1'); insLite('project', 'P2');
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM holidays WHERE "date" = '2026-12-25'`).get()).n,
      lite.prepare("SELECT COUNT(*) AS n FROM holidays WHERE date = '2026-12-25'").get().n);
  });
  await check('partial unique index: one OPEN version per key, any number of closed versions', async () => {
    const ins = (end) => db.prepare(`INSERT INTO jkk_risk_classes (risk_class, rate_bp, effective_date, end_date) VALUES ('low', 54, '2020-01-01', ?)`).run(end);
    await ins('2021-12-31'); await ins('2022-12-31'); await ins(null);
    await rejects(() => ins(null), /23505/);
  });
  await check('CHECK and FOREIGN KEY constraints are enforced', async () => {
    await rejects(() => db.exec(`INSERT INTO holidays ("date", name, scope) VALUES ('2026-01-01', 'x', 'galactic')`), /23514/);
    await rejects(() => db.exec('INSERT INTO user_roles (user_id, role_id) VALUES (999, 999)'), /23503/);
    await rejects(() => db.exec(`INSERT INTO holidays ("date", name) VALUES ('2026-02-30', 'not a date')`), /22008/);
  });
  await check('historical ids can be inserted explicitly and the identity sequence can be advanced past them', async () => {
    await db.exec(`INSERT INTO roles (id, code, name) VALUES (500, 'LEGACY', 'Legacy role')`);
    await owner.exec(`SELECT setval(pg_get_serial_sequence('roles', 'id'), (SELECT MAX(id) FROM roles))`);
    eq((await db.prepare(`INSERT INTO roles (code, name) VALUES ('NEXT', 'Next') RETURNING id`).run()).lastInsertRowid, 501);
  });

  section('TRANSACTIONS & POOL');
  await check('a throw inside withTransaction rolls back every statement', async () => {
    await rejects(() => withTransaction(db, async () => {
      await db.prepare(`INSERT INTO projects (code, name) VALUES ('TX-1', 'one')`).run();
      await db.prepare(`INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('E-TX', '2026-09-02', 'X')`).run();
      throw new Error('middle step failed');
    }), /middle step failed/);
    eq((await db.prepare(`SELECT (SELECT COUNT(*) FROM projects WHERE code = 'TX-1') AS p, (SELECT COUNT(*) FROM attendance_events WHERE employee_id = 'E-TX') AS e`).get()), { p: 0, e: 0 });
  });
  await check('a database error mid-transaction also rolls back, and the transaction is usable again afterwards', async () => {
    await rejects(() => withTransaction(db, async () => {
      await db.prepare(`INSERT INTO projects (code, name) VALUES ('TX-2', 'two')`).run();
      await db.prepare(`INSERT INTO projects (code, name) VALUES ('TX-2', 'dup')`).run();
    }), /23505/);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code = 'TX-2'`).get()).n, 0);
    eq(await withTransaction(db, async () => (await db.prepare('SELECT 7 AS x').get()).x), 7);
  });
  await check('a nested withTransaction joins the outer one (A3 contract)', async () => {
    await rejects(() => withTransaction(db, async () => {
      await withTransaction(db, async () => { await db.prepare(`INSERT INTO projects (code, name) VALUES ('TX-3', 'inner')`).run(); });
      eq(db.isTransaction, true);
      throw new Error('outer fails after inner "committed"');
    }), /outer fails/);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code = 'TX-3'`).get()).n, 0);
    eq(db.isTransaction, false);
  });
  await check('all statements of a transaction run on ONE connection; uncommitted work is invisible to others', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const tx = withTransaction(db, async () => {
      const a = (await db.prepare('SELECT pg_backend_pid() AS p').get()).p;
      await db.prepare(`INSERT INTO projects (code, name) VALUES ('TX-4', 'hidden')`).run();
      await gate;
      return [a, (await db.prepare('SELECT pg_backend_pid() AS p').get()).p];
    });
    await new Promise((r) => setTimeout(r, 50));
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code = 'TX-4'`).get()).n, 0, 'dirty read: ');
    release(); const [p1, p2] = await tx; eq(p1, p2);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code = 'TX-4'`).get()).n, 1);
  });
  await check('two concurrent transactions on one handle do not share a connection or leak into each other', async () => {
    const run = (code, fail) => withTransaction(db, async () => {
      await db.prepare('INSERT INTO projects (code, name) VALUES (?, ?)').run(code, code);
      await new Promise((r) => setTimeout(r, 30));
      if (fail) throw new Error('b fails');
      return (await db.prepare('SELECT pg_backend_pid() AS p').get()).p;
    });
    const [a, b] = await Promise.allSettled([run('TX-5A', false), run('TX-5B', true)]);
    eq([a.status, b.status], ['fulfilled', 'rejected']);
    eq((await db.prepare(`SELECT code FROM projects WHERE code LIKE 'TX-5%'`).all()).map((r) => r.code), ['TX-5A']);
  });
  await check('a query that escapes its transaction (missing await) is refused, not run on a released client', async () => {
    let late;
    await withTransaction(db, async () => {
      // the timer callback inherits the transaction context but fires after COMMIT
      late = new Promise((resolve) => setTimeout(() => db.prepare('SELECT 1 AS x').get().then(() => resolve('RAN'), (e) => resolve(e.message)), 40));
    });
    ok(/after its transaction ended/.test(await late), 'stray query was not refused');
  });
  await check('connections are returned after commit, rollback and error — 60 failing transactions on a pool of 4', async () => {
    const small = t.openApp(4);
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => withTransaction(small, async () => {
      await small.prepare('INSERT INTO projects (code, name) VALUES (?, ?)').run(`LEAK-${i}`, 'x');
      if (i % 2) throw new Error('boom'); if (i % 3 === 0) await small.prepare('SELECT 1/0').get();
    })));
    ok(results.filter((r) => r.status === 'rejected').length >= 30);
    const s = small.poolStats(); ok(s.total <= 4, `pool grew to ${s.total}`); eq([s.idle, s.waiting], [s.total, 0]);
    eq((await small.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code LIKE 'LEAK-%'`).get()).n,
      Array.from({ length: 60 }, (_, i) => i).filter((i) => i % 2 === 0 && i % 3 !== 0).length);
  });
  await check('withRetry retries a real deadlock a bounded number of times and both writers finish', async () => {
    await db.exec(`INSERT INTO projects (code, name) VALUES ('DL-1', 'a'), ('DL-2', 'b')`);
    let attempts = 0;
    const worker = (first, second) => withRetry(() => withTransaction(db, async () => {
      attempts += 1;
      await db.prepare(`UPDATE projects SET name = name || '.' WHERE code = ?`).run(first);
      await new Promise((r) => setTimeout(r, 80));
      await db.prepare(`UPDATE projects SET name = name || '.' WHERE code = ?`).run(second);
    }), { label: 'deadlock test' });
    await Promise.all([worker('DL-1', 'DL-2'), worker('DL-2', 'DL-1')]);
    ok(attempts >= 3, `expected a retry, saw ${attempts} attempts`);
    eq((await db.prepare(`SELECT name FROM projects WHERE code LIKE 'DL-%' ORDER BY code`).all()).map((r) => r.name), ['a..', 'b..']);
  });
  await check('withRetry fails fast on non-contention errors and reports exhaustion cleanly', async () => {
    let n = 0;
    await rejects(() => withRetry(async () => { n += 1; await db.exec('SELECT 1/0'); }), /22012/); eq(n, 1);
    n = 0;
    const e = await rejects(() => withRetry(async () => { n += 1; const x = new Error('lock'); x.code = '55P03'; throw x; }, { maxAttempts: 3 }), /DB_BUSY_EXHAUSTED/);
    eq([n, e.cause.code], [3, '55P03']);
  });
  await check('a blocked writer gives up after lock_timeout instead of hanging forever', async () => {
    eq((await db.prepare('SHOW lock_timeout').get()).lock_timeout, '5s');
    let release; const gate = new Promise((r) => { release = r; });
    const holder = withTransaction(db, async () => { await db.prepare(`UPDATE projects SET name = 'held' WHERE code = 'DL-1'`).run(); await gate; });
    await new Promise((r) => setTimeout(r, 50));
    const other = t.openApp(1);
    const e = await rejects(() => withTransaction(other, async () => {
      await other.exec('SET LOCAL lock_timeout = 200');
      await other.prepare(`UPDATE projects SET name = 'blocked' WHERE code = 'DL-1'`).run();
    }), /55P03/);
    ok(e); release(); await holder;
  });

  lite.close();
  await t.drop();
  console.log(`\n${'='.repeat(60)}\nDB-M1 FOUNDATION TESTS: ${passed} passed, ${failed} failed`);
  if (failed) for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  console.log('='.repeat(60));
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED:', err); process.exit(1); });
