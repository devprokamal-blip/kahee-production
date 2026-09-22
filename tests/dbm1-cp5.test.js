// tests/dbm1-cp5.test.js — DB-M1 CP5 correctness suite. Every optimisation and safety net added for scale must leave
// results unchanged and must actually protect what it claims to protect. Real PostgreSQL, runtime role, no mocks.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const http = require('http');
const { execFileSync } = require('child_process'); const { DatabaseSync } = require('node:sqlite'); const { Client } = require('pg'); const express = require('express');
const { createTestDatabase } = require('./helpers/pgTestDb');
const core = require('../database/db'); const { withTransaction } = core; const M = require('../database/pg/migrate-from-sqlite');

let passed = 0; let failed = 0; const failures = [];
async function check(name, fn) { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); } }
const eq = (a, e, l = '') => { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${l}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const ok = (v, l) => { if (!v) throw new Error(l || 'expected truthy'); };
const section = (t) => console.log(`\n${t}`); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

(async () => {
  const t = await createTestDatabase('cp5'); const db = t.db; const owner = t.openOwner();

  section('QUERY STATISTICS ARE DIAGNOSTICS ONLY');
  await check('statistics are OFF unless KAHE_DB_QUERY_STATS=1, and the request middleware is then a pure pass-through', async () => {
    eq(core.STATS_ON, false); let called = 0; const res = { end() {}, setHeader() { throw new Error('must not set headers when off'); } };
    require('../middleware/dbStats')({}, res, () => { called += 1; }); eq(called, 1);
    const r = await core.runWithQueryStats(async () => (await db.prepare('SELECT 41 + 1 AS x').get()).x); eq([r.result, r.stats.queries], [42, 0], 'nothing may be counted when off: '); });
  await check('when switched on it counts statements and repeated statements without changing any result', () => {
    const out = execFileSync(process.execPath, ['-e', `const c=require('./database/db');(async()=>{const db=c.createDb({connectionString:process.env.U,max:2});
      const r=await c.runWithQueryStats(async()=>{let s=0;for(let i=0;i<5;i++)s+=(await db.prepare('SELECT ?::int AS x').get(i)).x;await db.prepare('SELECT 1 AS y').get();return s;});
      console.log(JSON.stringify([r.result,r.stats.queries,r.stats.distinct_statements,r.stats.most_repeated[0].n]));await db.close();})()`],
    { cwd: ROOT, env: { ...process.env, KAHE_DB_QUERY_STATS: '1', U: t.appUrl } }).toString().trim();
    eq(JSON.parse(out), [10, 6, 2, 5]); });

  section('EVIDENCE-BASED INDEX (migration 0005)');
  await check('idx_attendance_events_employee exists once, on (employee_id, id), and no other index duplicates it', async () => {
    const ix = await db.prepare(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'attendance_events' ORDER BY 1`).all();
    eq(ix.filter((i) => /\(employee_id, id\)/.test(i.indexdef)).map((i) => i.indexname), ['idx_attendance_events_employee']);
    eq(ix.filter((i) => /\(employee_id\b/.test(i.indexdef)).length, 1, 'indexes starting with employee_id: '); });
  await check('the Audit-Center-by-employee query uses it and returns exactly the rows of the unindexed plan', async () => {
    await owner.exec(`ALTER TABLE attendance_events DISABLE TRIGGER USER;
      INSERT INTO attendance_events (employee_id, work_date, event_type, legal_entity_id) SELECT 'E-' || (g % 400), DATE '2026-01-01' + (g % 200), 'CREATED', CASE WHEN g % 3 = 0 THEN NULL ELSE 'LE' || (g % 3) END FROM generate_series(1, 60000) g;
      ALTER TABLE attendance_events ENABLE TRIGGER USER; ANALYZE attendance_events;`);
    const sql = `SELECT ev.id FROM attendance_events ev WHERE (ev.legal_entity_id IN ('LE1','LE2') OR ev.legal_entity_id IS NULL) AND ev.employee_id = 'E-7' ORDER BY ev.id DESC LIMIT 200`;
    const plan = (await db.prepare(`EXPLAIN ${sql}`).all()).map((r) => r['QUERY PLAN']).join('\n'); ok(/idx_attendance_events_employee/.test(plan), plan);
    const withIndex = (await db.prepare(sql).all()).map((r) => r.id);
    const without = await withTransaction(db, async () => { await db.exec('SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off'); return (await db.prepare(sql).all()).map((r) => r.id); });
    eq(withIndex.length, 150); eq(withIndex, without); });

  section('CHUNKED RECONCILIATION = WHOLE-TABLE RECONCILIATION');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kahe-cp5-')); const src = path.join(dir, 'big.db'); const N = M.RECONCILE_CHUNK * 2 + 1234;
  { const s = new DatabaseSync(src); require('../database/legacy-sqlite/init-db').initDb(s);
    s.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N}) INSERT INTO holidays (date, name, scope) SELECT date('1900-01-01', '+' || i || ' day'), 'H' || i, 'project' FROM n`); s.close(); }
  const big = await createTestDatabase('cp5_big');
  await check(`a table spanning 3 chunks (${N} rows) migrates; the streamed hash equals a one-pass hash of the whole table`, async () => {
    const r = await M.migrateFromSqlite({ source: src, connectionString: big.ownerUrl, log: () => {} }); eq(r.result, 'MIGRATED');
    const h = r.reconciliation.tables.holidays; eq([h.sqlite_rows, h.postgresql_rows, h.content_match], [N, N, true]);
    const s = new DatabaseSync(src, { readOnly: true }); const cols = s.prepare('PRAGMA table_info(holidays)').all().map((c) => c.name); const one = crypto.createHash('sha256');
    for (const row of s.prepare(`SELECT ${cols.join(',')} FROM holidays ORDER BY id`).iterate()) one.update(JSON.stringify(cols.map((c) => row[c]))); s.close();
    eq(h.sqlite_sha256, one.digest('hex'), 'chunking changed the checksum: '); ok(r.performance.peak_rss_mb > 0 && r.performance.reconcile_chunk_rows === M.RECONCILE_CHUNK); });
  const recon = async () => { const pg = new Client({ connectionString: big.ownerUrl, options: '-c timezone=UTC' }); await pg.connect(); const s = new DatabaseSync(src, { readOnly: true });
    try { return (await M.reconcile(s, pg, await M.loadCatalogue(pg))).tables.holidays; } finally { s.close(); await pg.end(); } };
  const bo = big.openOwner();
  for (const [label, id] of [['FIRST row of the 2nd chunk', M.RECONCILE_CHUNK + 1], ['LAST row of the 2nd chunk', M.RECONCILE_CHUNK * 2], ['last row of the table', N]]) {
    await check(`one changed value on the ${label} is found and located — no sampling, no boundary blind spot`, async () => {
      await bo.exec(`UPDATE holidays SET name = 'tampered' WHERE id = ${id}`); const h = await recon();
      eq([h.content_match, h.difference, h.first_difference.row, h.first_difference.column, h.first_difference.postgresql], [false, 0, `id=${id}`, 'name', 'tampered']);
      await bo.exec(`UPDATE holidays SET name = 'H${id}' WHERE id = ${id}`); eq((await recon()).content_match, true); }); }
  await check('a row missing in the middle of a chunk is reported as a count difference and a content mismatch', async () => {
    await bo.exec(`DELETE FROM holidays WHERE id = ${M.RECONCILE_CHUNK + 777}`); const h = await recon(); eq([h.content_match, h.difference], [false, -1]); });
  await big.drop(); fs.rmSync(dir, { recursive: true, force: true });

  section('LOST-UPDATE / RACE CONTROL');
  await check('concurrent duplicate clock-ins for one worker/day: exactly ONE row, the rest refused by the database', async () => {
    await db.exec(`INSERT INTO employees (id, full_name, worker_type, status) VALUES ('RACE-1', 'Race', 'pkwt', 'active')`);
    const r = await Promise.allSettled(Array.from({ length: 25 }, () => db.prepare(`INSERT INTO timesheet_entries (employee_id, work_date) VALUES ('RACE-1', '2026-09-01') RETURNING id`).run()));
    eq([r.filter((x) => x.status === 'fulfilled').length, r.filter((x) => x.status === 'rejected' && x.reason.code === '23505').length], [1, 24]);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE employee_id = 'RACE-1'`).get()).n, 1); });
  await check('state-guarded transition: of 20 simultaneous decisions on one request exactly one changes the row', async () => {
    await db.exec(`INSERT INTO legal_entities (id, name, entity_type, jkk_risk_class, effective_date) VALUES ('LE', 'LE', 'internal', 'low', '2019-01-01')`);
    const id = (await db.prepare(`INSERT INTO attendance_corrections (request_type, employee_id, legal_entity_id, work_date, status, reason_code) VALUES ('CORRECTION', 'RACE-1', 'LE', '2026-09-01', 'SUBMITTED', 'X') RETURNING id`).run()).lastInsertRowid;
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => withTransaction(db, async () => (await db.prepare(`UPDATE attendance_corrections SET status = ? WHERE id = ? AND status = ?`).run(i % 2 ? 'REJECTED' : 'APPROVED', id, 'SUBMITTED')).changes)));
    eq(r.reduce((a, b) => a + b, 0), 1); });
  await check('every correction status transition in the route is conditional on the validated status (source guard)', () => {
    const s = fs.readFileSync(path.join(ROOT, 'routes', 'attendance-correction.js'), 'utf8');
    const updates = [...s.matchAll(/UPDATE attendance_corrections SET status = \?[\s\S]*?`\)/g)].map((m) => m[0]);
    ok(updates.length >= 4, `found ${updates.length}`); for (const u of updates) ok(/WHERE id = \? AND status = \?/.test(u), `unguarded: ${u.slice(0, 80)}`);
    ok(/CORRECTION_STATE_CONFLICT/.test(s)); });
  await check('write serialisation: mutating requests run one at a time in arrival order; reads are never queued', async () => {
    delete require.cache[require.resolve('../middleware/writeSerializer')]; const ws = require('../middleware/writeSerializer');
    const app = express(); app.use(ws); let active = 0; let maxActive = 0; const order = []; let reads = 0; let maxReads = 0;
    app.post('/api/x/:n', async (req, res) => { active += 1; maxActive = Math.max(maxActive, active); order.push(`s${req.params.n}`); await sleep(25 - Number(req.params.n)); order.push(`e${req.params.n}`); active -= 1; res.json({}); });
    app.get('/api/x', async (req, res) => { reads += 1; maxReads = Math.max(maxReads, reads); await sleep(40); reads -= 1; res.json({}); });
    app.post('/api/auth/login', async (req, res) => { await sleep(5); res.json({ untouched: true }); });
    const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
    const posts = []; for (let i = 0; i < 8; i += 1) { posts.push(fetch(`${base}/api/x/${i}`, { method: 'POST' })); await sleep(2); }
    await Promise.all([...posts, ...Array.from({ length: 8 }, () => fetch(`${base}/api/x`)), fetch(`${base}/api/auth/login`, { method: 'POST' })]); srv.close();
    eq(maxActive, 1, 'writes overlapped: '); eq(order, Array.from({ length: 8 }, (_, i) => [`s${i}`, `e${i}`]).flat(), 'arrival order: '); ok(maxReads > 1, 'reads were serialised'); eq(ws.stats().queued_now, 0); });
  await check('a client that disconnects while queued does not block the queue', async () => {
    delete require.cache[require.resolve('../middleware/writeSerializer')]; const ws = require('../middleware/writeSerializer');
    const app = express(); app.use(ws); let ran = 0; app.post('/api/slow', async (req, res) => { ran += 1; await sleep(120); res.json({}); });
    const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
    const first = fetch(`${base}/api/slow`, { method: 'POST' }); await sleep(10); const ac = new AbortController(); const gone = fetch(`${base}/api/slow`, { method: 'POST', signal: ac.signal }).catch(() => 'aborted');
    await sleep(20); ac.abort(); const third = fetch(`${base}/api/slow`, { method: 'POST' }); await first; eq(await gone, 'aborted'); eq((await third).status, 200); srv.close(); eq([ran, ws.stats().queued_now], [2, 0]); });

  section('CONNECTION POOL');
  await check('300 concurrent queries never open more than PGPOOL_MAX connections, and all connections are returned', async () => {
    const p = core.createDb({ connectionString: t.appUrl, max: 5, application_name: 'cp5-pool-cap' }); let peak = 0; let run = true;
    const watch = (async () => { while (run) { peak = Math.max(peak, (await owner.prepare(`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = 'cp5-pool-cap'`).get()).n); await sleep(5); } })();
    const r = await Promise.all(Array.from({ length: 300 }, (_, i) => p.prepare('SELECT ?::int AS x, pg_sleep(0.002)').get(i))); run = false; await watch;
    eq(r.length, 300); ok(peak >= 2 && peak <= 5, `peak connections ${peak}`); const s = p.poolStats(); eq([s.waiting, s.idle === s.total], [0, true]); await p.close(); });
  await check('pool exhaustion fails fast with a clear error instead of hanging, and recovers when a connection is released', async () => {
    const p = core.createDb({ connectionString: t.appUrl, max: 2, connectionTimeoutMillis: 250 }); let release; const gate = new Promise((r) => { release = r; });
    const holders = [0, 1].map(() => withTransaction(p, async () => { await p.prepare('SELECT 1').get(); await gate; })); await sleep(60);
    const t0 = Date.now(); let err = null; try { await p.prepare('SELECT 1 AS x').get(); } catch (e) { err = e; }
    ok(err && /timeout/i.test(err.message), `expected a pool timeout, got ${err && err.message}`); ok(Date.now() - t0 < 2000, 'did not fail fast');
    release(); await Promise.all(holders); eq((await p.prepare('SELECT 1 AS x').get()).x, 1); await p.close(); });

  await t.drop();
  console.log(`\n${'='.repeat(60)}\nDB-M1 CP5 TESTS: ${passed} passed, ${failed} failed`); if (failed) for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  console.log('='.repeat(60)); process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED:', err); process.exit(1); });
