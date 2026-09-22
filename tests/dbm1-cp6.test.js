// tests/dbm1-cp6.test.js — DB-M1 CP6. Transaction-failure injection and connection loss, through the REAL server and the
// real business routes. A failure is injected INSIDE PostgreSQL (a trigger armed by the schema owner) at a late step of each
// multi-step operation; the assertion is always the same: NOTHING of the operation survives, and the identical request
// succeeds once the fault is removed. Real PostgreSQL, runtime role, no mocks.
const path = require('path'); const { spawn, execFileSync } = require('child_process'); const { Client } = require('pg');
const { createTestDatabase } = require('./helpers/pgTestDb'); const core = require('../database/db'); const { withTransaction, withRetry } = core;
let passed = 0; let failed = 0; const failures = [];
async function check(name, fn) { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); } }
const eq = (a, e, l = '') => { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${l}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const ok = (v, l) => { if (!v) throw new Error(l || 'expected truthy'); }; const section = (t) => console.log(`\n${t}`); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..'); const PORT = 43000 + Math.floor(Math.random() * 3000); const BASE = `http://127.0.0.1:${PORT}`; const PASSWORD = 'Kahe360Demo!2026';

(async () => {
  const t = await createTestDatabase('cp6'); const db = t.db; const owner = t.openOwner();
  const admin = new Client({ connectionString: (() => { const u = new URL(process.env.TEST_DATABASE_ADMIN_URL); u.pathname = `/${t.name}`; return u.toString(); })() }); await admin.connect();
  execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: t.appUrl }, stdio: 'pipe' });
  // fixtures (same shape as the A3 suite): entity, pattern, calendar, group, schedule, one employee, scope for every user
  await db.exec(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active') ON CONFLICT DO NOTHING;
    INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2019-01-01') ON CONFLICT DO NOTHING;
    INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by) SELECT id, 'KAHE360', 'cp6' FROM users ON CONFLICT DO NOTHING;`);
  const one = async (sql, ...p) => db.prepare(sql).get(...p);
  const wp = (await one(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('6H-CP6',6,'sunday','2019-01-01') RETURNING id`)).id;
  const cal = (await one(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('CP6CAL','CP6',NULL,NULL,'2019-01-01') RETURNING id`)).id;
  const grp = (await one(`INSERT INTO payroll_groups (code,name,legal_entity_id,work_calendar_id,effective_from) VALUES ('CP6G','CP6','KAHE360',?,'2019-01-01') RETURNING id`, cal)).id;
  await db.exec(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES ('CP6-1','Pekerja CP6','internal','active','2019-01-01','PPB')`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES ('CP6-1','KAHE360',?,?,?,'TK',0,'2019-01-01')`).run(wp, cal, grp);
  const sched = (await one(`INSERT INTO work_schedules (code,name,legal_entity_id,schedule_type,clock_in,clock_out,standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by)
    VALUES ('CP6-DAY','CP6 day','KAHE360','CUSTOM','07:00','16:00',480,0,'AFTER_SHIFT_END','2019-01-01','cp6') RETURNING id`)).id;
  await db.prepare(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,work_schedule_id,effective_from,created_by) VALUES ('CP6-1','KAHE360',?,'2019-01-01','cp6')`).run(sched);
  // fault injector: armed/disarmed by the OWNER; the application cannot see or disable it
  await owner.exec(`CREATE TABLE _inject (target text PRIMARY KEY); GRANT SELECT ON _inject TO kahe360_test_app;
    CREATE FUNCTION _inject_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF EXISTS (SELECT 1 FROM _inject WHERE target = TG_TABLE_NAME) THEN RAISE EXCEPTION 'INJECTED_FAILURE on %', TG_TABLE_NAME; END IF; RETURN NEW; END $f$;`);
  for (const tb of ['attendance_events', 'attendance_entry_versions', 'attendance_correction_actions']) await owner.exec(`CREATE TRIGGER zz_inject_${tb} BEFORE INSERT ON ${tb} FOR EACH ROW EXECUTE FUNCTION _inject_fn()`);
  const arm = (tb) => owner.exec(`INSERT INTO _inject VALUES ('${tb}') ON CONFLICT DO NOTHING`); const disarm = () => owner.exec('DELETE FROM _inject');
  const counts = async () => one(`SELECT (SELECT COUNT(*) FROM timesheet_entries) AS entries, (SELECT COUNT(*) FROM attendance_events) AS events, (SELECT COUNT(*) FROM attendance_entry_versions) AS versions,
    (SELECT COUNT(*) FROM attendance_correction_actions) AS actions, (SELECT COUNT(*) FROM attendance_corrections) AS corrections, (SELECT COUNT(*) FROM attendance_payroll_adjustments) AS queue`);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: t.appUrl, PORT: String(PORT), NODE_ENV: 'development' }, stdio: 'pipe' });
  let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; }); let serverExited = false; server.on('exit', () => { serverExited = true; });
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/api/system/health`); break; } catch (_) { await sleep(200); } }
  const login = async (email) => { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`); const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body) => { const x = await fetch(BASE + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await x.json(); } catch (_) { /* empty */ } return { status: x.status, body: j }; };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) }; };
  const wf = await login('workforce@kahe360.local'); const dir = await login('director@kahe360.local');
  // the most recent Mon–Sat that is not after "business today" (Asia/Jakarta)
  const day = (() => { const d = new Date(Date.now() + 7 * 3600000 - 86400000); while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const ENTRY = { employee_id: 'CP6-1', work_date: day, attendance_status: 'present', shift: 'day', clock_in: '07:00', clock_out: '16:00' };

  section('FAILURE INJECTION — ATTENDANCE CREATE (record + immutable audit event)');
  let entryId;
  await check('audit insert fails → the request fails and NO attendance row exists', async () => {
    const before = await counts(); await arm('attendance_events'); const r = await wf.post('/api/timesheet/entries', ENTRY); await disarm();
    ok(r.status >= 500, `expected 5xx, got ${r.status} ${JSON.stringify(r.body)}`); eq(await counts(), before, 'partial state survived: '); });
  await check('the identical request succeeds once the fault is gone: exactly one row and one audit event', async () => {
    const before = await counts(); const r = await wf.post('/api/timesheet/entries', ENTRY); eq(r.status, 201, JSON.stringify(r.body)); entryId = r.body.id || (await one(`SELECT id FROM timesheet_entries WHERE employee_id = 'CP6-1'`)).id;
    const after = await counts(); eq([after.entries - before.entries, after.events - before.events], [1, 1]); });

  section('FAILURE INJECTION — OVERTIME DECISION');
  await check('decision audit fails → overtime stays PENDING, nothing approved, no event', async () => {
    const rq = await wf.post(`/api/timesheet/entries/${entryId}/overtime-request`, { hours: 1.5 }); ok(rq.status < 300, JSON.stringify(rq.body));
    const OT = 'SELECT overtime_status, overtime_minutes_requested, overtime_minutes_approved, overtime_decided_by_user_id, overtime_decided_at FROM timesheet_entries WHERE id = ?';
    const before = await counts(); const otBefore = await one(OT, entryId); eq([otBefore.overtime_status, otBefore.overtime_minutes_requested], ['pending', 90]);
    await arm('attendance_events'); const r = await dir.post(`/api/timesheet/entries/${entryId}/overtime-decide`, { decision: 'approved' }); await disarm();
    ok(r.status >= 500, `expected 5xx, got ${r.status} ${JSON.stringify(r.body)}`); eq(await one(OT, entryId), otBefore, 'overtime state changed: '); eq(await counts(), before); });
  await check('the same decision then succeeds exactly once', async () => {
    const r = await dir.post(`/api/timesheet/entries/${entryId}/overtime-decide`, { decision: 'approved' }); eq(r.status, 200, JSON.stringify(r.body));
    eq((await one('SELECT overtime_status, overtime_minutes_approved FROM timesheet_entries WHERE id = ?', entryId)), { overtime_status: 'approved', overtime_minutes_approved: 90 });
    eq((await dir.post(`/api/timesheet/entries/${entryId}/overtime-decide`, { decision: 'rejected' })).status, 409, 'an approved decision must stay immutable: '); });

  section('FAILURE INJECTION — ATTENDANCE CORRECTION: APPROVE → VERSION → APPLY → AUDIT');
  let corrId;
  await check('fixture: a correction policy and a SUBMITTED correction request exist', async () => {
    const p = await wf.post('/api/attendance-correction/policies', { code: 'CP6POL', name: 'Kebijakan CP6', legal_entity_id: 'KAHE360', correction_window: 30, window_unit: 'DAYS', allow_late_correction: true, late_requires_approval: false, effective_from: '2019-01-01' });
    ok(p.status < 300, `policy: ${p.status} ${JSON.stringify(p.body)}`);
    const c = await wf.post('/api/attendance-correction/requests', { timesheet_entry_id: entryId, reason_code: 'OTHER', reason_text: 'jam pulang salah', proposed_values: { clock_out: '17:00' } });
    ok(c.status < 300, `request: ${c.status} ${JSON.stringify(c.body)}`); corrId = c.body.id; eq((await one('SELECT status FROM attendance_corrections WHERE id = ?', corrId)).status, 'SUBMITTED'); });
  for (const [tb, what] of [['attendance_entry_versions', 'version snapshot insert'], ['attendance_correction_actions', 'approval-history insert'], ['attendance_events', 'audit event insert']]) {
    await check(`${what} fails mid-approval → request still SUBMITTED, attendance unchanged, no version / history / audit / queue row`, async () => {
      const before = await counts(); const entry = await one('SELECT clock_out, work_minutes, current_version, last_correction_id FROM timesheet_entries WHERE id = ?', entryId);
      await arm(tb); const r = await dir.post(`/api/attendance-correction/requests/${corrId}/decide`, { decision: 'approved', reason: 'ok' }); await disarm();
      ok(r.status >= 500, `expected 5xx, got ${r.status} ${JSON.stringify(r.body)}`);
      eq(await one('SELECT status, decided_by_user_id, applied_version_no, applied_to_source FROM attendance_corrections WHERE id = ?', corrId), { status: 'SUBMITTED', decided_by_user_id: null, applied_version_no: null, applied_to_source: 0 });
      eq(await one('SELECT clock_out, work_minutes, current_version, last_correction_id FROM timesheet_entries WHERE id = ?', entryId), entry); eq(await counts(), before); }); }
  await check('with no fault the approval applies atomically: APPLIED, new version chain, attendance updated, history + audit written', async () => {
    const before = await counts(); const r = await dir.post(`/api/attendance-correction/requests/${corrId}/decide`, { decision: 'approved', reason: 'ok' }); eq(r.status, 200, JSON.stringify(r.body));
    eq((await one('SELECT status FROM attendance_corrections WHERE id = ?', corrId)).status, 'APPLIED'); eq((await one('SELECT clock_out FROM timesheet_entries WHERE id = ?', entryId)).clock_out, '17:00');
    const after = await counts(); ok(after.versions - before.versions >= 1 && after.actions > before.actions && after.events > before.events, JSON.stringify([before, after]));
    eq((await db.prepare('SELECT version_no FROM attendance_entry_versions WHERE timesheet_entry_id = ? ORDER BY version_no').all(entryId)).map((v) => v.version_no), [1, 2]); });

  section('POSTGRESQL IS THE ONLY RUNTIME DATABASE');
  await check('no runtime file loads SQLite; only the legacy reference, the migration tool and the DB-M1 tools/tests may', () => {
    const fs = require('fs'); const offenders = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!/node_modules|legacy-sqlite/.test(p)) walk(p); } else if (/\.js$/.test(f.name) && /require\(['"]node:sqlite['"]\)|require\(['"](better-)?sqlite3?['"]\)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p)); } };
    for (const d of ['lib', 'routes', 'middleware', 'scripts']) walk(path.join(ROOT, d)); for (const f of ['server.js', 'database/db.js', 'database/init-db.js', 'database/seed.js', 'database/pg/migrate.js', 'database/pg/bootstrap.js']) if (/require\(['"]node:sqlite['"]\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) offenders.push(f);   // a historical COMMENT may mention it; loading it may not
    eq(offenders, []); const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); eq(Object.keys(pkg.dependencies).filter((k) => /sqlite/i.test(k)), []); ok(pkg.dependencies.pg); });
  await check('the server refuses to start without a PostgreSQL connection — there is no SQLite fallback', () => {
    let out = ''; try { execFileSync(process.execPath, [path.join(ROOT, 'server.js')], { cwd: require('os').tmpdir(), env: { PATH: process.env.PATH, PORT: '1', NODE_ENV: 'development' }, stdio: 'pipe', timeout: 15000 }); out = 'STARTED'; } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
    ok(/DATABASE_URL|DATABASE STARTUP CHECK FAILED/.test(out), out.slice(0, 300)); ok(!/kahe360\.db/.test(out)); });

  section('CONNECTION LOSS');
  await check('backend killed mid-transaction: the error surfaces, NOTHING is committed, the dead connection is never reused, the pool heals', async () => {
    const p = core.createDb({ connectionString: t.appUrl, max: 2 }); let pid; let err = null;
    try { await withTransaction(p, async () => { pid = (await p.prepare('SELECT pg_backend_pid() AS p').get()).p; await p.prepare(`INSERT INTO projects (code, name) VALUES ('LOST-1', 'x')`).run();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]); await sleep(50); await p.prepare(`INSERT INTO projects (code, name) VALUES ('LOST-2', 'y')`).run(); }); } catch (e) { err = e; }
    ok(err, 'the transaction must fail'); eq((await p.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code LIKE 'LOST-%'`).get()).n, 0, 'partial commit: ');
    const pids = new Set(); for (let i = 0; i < 6; i += 1) pids.add((await p.prepare('SELECT pg_backend_pid() AS p').get()).p); ok(!pids.has(pid), 'terminated backend reused'); await p.close(); });
  await check('a lost connection is NOT blindly retried (the outcome of the unit of work is unknown) — only lock/serialisation errors are', async () => {
    const p = core.createDb({ connectionString: t.appUrl, max: 1 }); let attempts = 0; let err = null;
    try { await withRetry(() => withTransaction(p, async () => { attempts += 1; const pid = (await p.prepare('SELECT pg_backend_pid() AS p').get()).p; await admin.query('SELECT pg_terminate_backend($1)', [pid]); await sleep(50); await p.prepare('SELECT 1').get(); })); } catch (e) { err = e; }
    ok(err); eq(attempts, 1); eq((await p.prepare('SELECT 1 AS x').get()).x, 1, 'pool did not heal: '); await p.close(); });
  await check('ALL server connections killed while idle and mid-traffic: the server stays up and serves again without a restart', async () => {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'kahe360' AND pid <> pg_backend_pid()`); await sleep(150);
    let okAfter = 0; for (let i = 0; i < 6; i += 1) { const r = await wf.get(`/api/timesheet/entries?date=${day}`); if (r.status === 200) okAfter += 1; else await sleep(100); }
    ok(okAfter >= 4, `only ${okAfter}/6 requests succeeded after reconnect`); ok(!serverExited, `server process died:\n${serverLog.slice(-400)}`);
    const w = await wf.post('/api/timesheet/entries', { ...ENTRY, work_date: (() => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })() }); eq(w.status, 201, JSON.stringify(w.body)); });
  await check('a connection killed DURING a write request: the client gets an error, no partial row, the write queue is not stuck', async () => {
    const before = await counts(); await owner.exec(`CREATE OR REPLACE FUNCTION _inject_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF EXISTS (SELECT 1 FROM _inject WHERE target = TG_TABLE_NAME) THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $f$`); await arm('attendance_events');
    const d2 = (() => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 3); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    const pending = wf.post('/api/timesheet/entries', { ...ENTRY, work_date: d2 }); await sleep(500);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'kahe360' AND state <> 'idle' AND pid <> pg_backend_pid()`);
    const r = await pending; await disarm(); ok(r.status >= 500, `expected 5xx, got ${r.status}`); eq(await counts(), before, 'partial state after connection loss: ');
    const again = await wf.post('/api/timesheet/entries', { ...ENTRY, work_date: d2 }); eq(again.status, 201, `queue stuck or retry failed: ${JSON.stringify(again.body)}`); ok(!serverExited); });

  server.kill(); await admin.end(); await t.drop();
  console.log(`\n${'='.repeat(60)}\nDB-M1 CP6 TESTS: ${passed} passed, ${failed} failed`); if (failed) for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  console.log('='.repeat(60)); process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED:', err); process.exit(1); });
