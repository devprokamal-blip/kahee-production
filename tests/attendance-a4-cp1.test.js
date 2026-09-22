(async () => {
// tests/attendance-a4-cp1.test.js
// Attendance A4 CP1 — Attendance Period + Closing Policy foundation (approved contract v3).
//
// Same discipline as A1–A3: the REAL server.js over HTTP, the REAL seed.js RBAC, real sessions, a
// throwaway PostgreSQL database, and SQL probes as the least-privilege RUNTIME role.
// The server runs with KAHE_WRITE_SERIALIZATION=off for the WHOLE suite: every result below holds
// without the process-global write queue (CP1 correctness must not depend on it).
// Usage: npm run test:attendance-a4

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { createTestDatabase } = require('./helpers/pgTestDb');
const __t = await createTestDatabase('attendance_a4_cp1');
process.env.DATABASE_URL = __t.appUrl;
const bcrypt = require('bcryptjs');
const bt = require('../lib/businessTime');
const { withTransaction } = require('../database/db');
const ap = require('../lib/attendancePeriod');
const cpLib = require('../lib/attendanceClosingPolicy');
const { PG_NATIVE_TABLES } = require('../database/pg/migrate-from-sqlite');

const PORT = 44000 + Math.floor(Math.random() * 15000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Kahe360Demo!2026';

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every A4 error response and every A4 database refusal seen by the suite is recorded, so the
// language-neutral contract is proven over ALL of them, not a sample.
const seenHttpErrors = [];
const seenDbCodes = [];

// ---- seed + fixtures ----------------------------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], {
  cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl }, stdio: 'pipe',
});
const db = __t.db;
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active') ON CONFLICT DO NOTHING`).run();
for (const [id, name, type] of [['KAHE360', 'KAHE', 'internal'], ['MITRA', 'Mitra Jaya', 'subkontraktor']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2019-01-01') ON CONFLICT DO NOTHING`).run(id, name, type);
}
const wp = Number((await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date)
  VALUES ('5H',5,'sunday','2019-01-01') RETURNING id`).run()).lastInsertRowid);
const cal = Number((await db.prepare(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('A4CAL','A4','2019-01-01') RETURNING id`).run()).lastInsertRowid);
async function group(code, entity, frequency) {
  return Number((await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,?,?,0,0,2,5,0,'2019-01-01') RETURNING id`)
    .run(code, code, entity, frequency, frequency === 'weekly' ? 52 : 12)).lastInsertRowid);
}
const G = { kMonthly: await group('K-M', 'KAHE360', 'monthly'), kWeekly: await group('K-W', 'KAHE360', 'weekly'),
  mMonthly: await group('M-M', 'MITRA', 'monthly') };
const FAR = '2099-12-31';
async function payrollPeriod(groupId, seq, start, end) {
  return Number((await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN') RETURNING id`).run(groupId, Number(start.slice(0, 4)), seq, null, start, end, FAR, FAR, FAR, FAR)).lastInsertRowid);
}
// mapping fixtures (2031): monthly Jan + a weekly period straddling Jan/Feb, and a MITRA month
const PP = {
  kJan: await payrollPeriod(G.kMonthly, 1, '2031-01-01', '2031-01-31'),
  kWeekStraddle: await payrollPeriod(G.kWeekly, 5, '2031-01-27', '2031-02-02'),
  kFeb: await payrollPeriod(G.kMonthly, 2, '2031-02-01', '2031-02-28'),
  mJan: await payrollPeriod(G.mMonthly, 1, '2031-01-01', '2031-01-31'),
};
// A1/A3 non-interference fixtures: the payroll period containing "today" is open with far cutoffs
const today = bt.businessToday();
await payrollPeriod(G.kMonthly, 99, bt.addDays(today, -40), bt.addDays(today, 20));
const SCHED = Number((await db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,schedule_type,clock_in,clock_out,
  standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by)
  VALUES ('SITE-DAY','Site Day','KAHE360','SITE','07:00','16:00',480,0,'AFTER_SHIFT_END','2019-01-01','fixture') RETURNING id`).run()).lastInsertRowid);
await db.prepare(`INSERT INTO work_schedule_breaks (work_schedule_id,name,duration_minutes,is_paid,sequence) VALUES (?, 'Istirahat', 60, 0, 1)`).run(SCHED);
const PAT = Number((await db.prepare(`INSERT INTO attendance_work_patterns (code,name,legal_entity_id,pattern_type,effective_from,created_by)
  VALUES ('A4W','A4 weekly','KAHE360','FIXED_WEEKLY','2019-01-01','fixture') RETURNING id`).run()).lastInsertRowid);
for (let i = 1; i <= 7; i += 1) {
  await db.prepare(`INSERT INTO attendance_pattern_days (pattern_id,day_index,day_status,work_schedule_id) VALUES (?,?,?,?)`)
    .run(PAT, i, i === 7 ? 'OFF' : 'WORK', i === 7 ? null : SCHED);
}
for (const e of ['E-A4-1']) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES (?,?,'internal','active','2019-01-01','PPB')`).run(e, `Pekerja ${e}`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2019-01-01')`).run(e, 'KAHE360', wp, cal, G.kMonthly);
  await db.prepare(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from,created_by)
    VALUES (?,'KAHE360',?, '2019-01-01','fixture')`).run(e, PAT);
}

const roleId = async (code) => (await db.prepare('SELECT id FROM roles WHERE code = ?').get(code)).id;
const userId = async (email) => (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
async function makeUser(email, name, role, active = 1) {
  const id = Number((await db.prepare(`INSERT INTO users (email,display_name,password_hash,is_active) VALUES (?,?,?,?) RETURNING id`)
    .run(email, name, bcrypt.hashSync(PASSWORD, 4), active)).lastInsertRowid);
  await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)').run(id, await roleId(role));
  return id;
}
const grant = async (uid, e) => db.prepare(`INSERT INTO user_legal_entity_scope (user_id,legal_entity_id,granted_by)
  VALUES (?,?,'test') ON CONFLICT DO NOTHING`).run(uid, e);
const U = {
  director: await userId('director@kahe360.local'), wf: await userId('workforce@kahe360.local'),
  hrd: await userId('hrd@kahe360.local'), payroll: await userId('payroll@kahe360.local'),
  health: await userId('health@kahe360.local'), hse: await userId('hse@kahe360.local'),
  mitra: await makeUser('mitra.a4@t.local', 'Mitra WF', 'workforce_manager'),
  sup: await makeUser('sup.a4@t.local', 'Supervisor A4', 'supervisor'),
  retired: await makeUser('retired.a4@t.local', 'Retired Director', 'operations_director', 0),
};
for (const k of ['director', 'wf', 'hrd', 'payroll', 'health', 'hse', 'sup']) await grant(U[k], 'KAHE360');
await grant(U.director, 'MITRA');
await grant(U.mitra, 'MITRA');

// ---- HTTP helpers ------------------------------------------------------------
async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
    const isA4 = url.startsWith('/api/attendance-periods') || url.startsWith('/api/attendance-closing-policies');
    if (isA4 && r.status >= 400 && json) seenHttpErrors.push({ url, status: r.status, body: json });
    return { status: r.status, body: json };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u),
  };
}
let server; let serverOut = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl, PORT: String(PORT), NODE_ENV: 'development', KAHE_WRITE_SERIALIZATION: 'off' },
    stdio: 'pipe',
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${BASE}/login.html`); if (r.status === 200) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${serverOut}`);
}

// ---- SQL helpers (RUNTIME role) ------------------------------------------------
const roleName = async (uid) => (await db.prepare(`SELECT string_agg(r.name, ', ') AS n FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`).get(uid)).n;
async function setCtx(h, c) {
  await h.query(`SELECT set_config('kahe.actor_user_id',$1,true), set_config('kahe.actor_name',$2,true),
    set_config('kahe.actor_role',$3,true), set_config('kahe.permission',$4,true), set_config('kahe.reason',$5,true)`,
  [c.uid === undefined ? '' : String(c.uid), c.name || '', c.role || '', c.perm || '', c.reason || '']);
}
async function asActor(h, c, fn) { return withTransaction(h, async () => { if (c) await setCtx(h, c); return fn(); }); }
/** Run and return the KH001 machine code (or other SQLSTATE), recording it. */
async function sqlCode(fn) {
  try { await fn(); return 'OK'; } catch (e) {
    if (e.code === 'KH001') { seenDbCodes.push({ message: e.message, detail: e.detail }); return e.message; }
    return `SQLSTATE:${e.code}`;
  }
}
const ACT = {};   // actor contexts, filled after login lookups
const periodRow = async (id) => db.prepare('SELECT * FROM attendance_periods WHERE id = ?').get(id);
const periodEvents = async (id) => db.prepare('SELECT * FROM attendance_period_events WHERE period_id = ? ORDER BY id').all(id);
const policyEvents = async (id) => db.prepare('SELECT * FROM attendance_closing_policy_events WHERE policy_id = ? ORDER BY id').all(id);

(async () => {
  await startServer();
  const dir = await login('director@kahe360.local');
  const wf = await login('workforce@kahe360.local');
  const hrd = await login('hrd@kahe360.local');
  const pay = await login('payroll@kahe360.local');
  const health = await login('health@kahe360.local');
  const hse = await login('hse@kahe360.local');
  const mitra = await login('mitra.a4@t.local');
  const sup = await login('sup.a4@t.local');
  const WF_ROLE = await roleName(U.wf); const DIR_ROLE = await roleName(U.director);
  ACT.wfCreate = { uid: U.wf, name: 'Workforce', role: WF_ROLE, perm: 'attendance_period:CREATE' };
  ACT.wfEdit = { ...ACT.wfCreate, perm: 'attendance_period:EDIT' };
  const wfName = (await db.prepare('SELECT display_name FROM users WHERE id = ?').get(U.wf)).display_name;
  const dirName = (await db.prepare('SELECT display_name FROM users WHERE id = ?').get(U.director)).display_name;
  ACT.wfCreate.name = wfName; ACT.wfEdit.name = wfName;

  // =========================================================================
  section('1. CREATE -> OPEN, AUDITED, SESSION ACTOR');
  let SEP;
  await check('POST creates an OPEN period; creator and transition metadata are the SESSION user', async () => {
    const r = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2030-09-01', end_date: '2030-09-30', label: 'Sep 2030' });
    eq(r.status, 201); SEP = r.body;
    eq([SEP.status, SEP.reopen_count, SEP.created_by_user_id, SEP.created_by_name, SEP.created_by_role],
      ['OPEN', 0, U.wf, wfName, WF_ROLE]);
    eq([SEP.last_transition_by_user_id, SEP.last_transition_permission, SEP.last_transition_reason, SEP.last_transition_at === SEP.created_at],
      [U.wf, 'attendance_period:CREATE', null, true]);
  });
  await check('creation writes exactly one append-only CREATE event (NULL -> OPEN) with the session actor', async () => {
    const ev = await periodEvents(SEP.id);
    eq(ev.map((e) => [e.event_type, e.from_status, e.to_status, e.actor_user_id, e.actor_name, e.permission]),
      [['CREATE', null, 'OPEN', U.wf, wfName, 'attendance_period:CREATE']]);
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    eq(sorted(ev[0].new_values), sorted({ legal_entity_id: 'KAHE360', start_date: '2030-09-01', end_date: '2030-09-30', label: 'Sep 2030', status: 'OPEN' }));
  });
  await check('client-supplied created_at / last_transition_* in raw SQL are NOT stored (server clock + context own them)', async () => {
    const row = await asActor(db, ACT.wfCreate, async () => db.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date,
      created_at,created_by_name,last_transition_by_user_id,last_transition_by_name,last_transition_at)
      VALUES ('KAHE360','2030-12-01','2030-12-31','2000-01-01','Forged',1,'Forged','2000-01-01') RETURNING *`).get());
    ok(!String(row.created_at).startsWith('2000') && !String(row.last_transition_at).startsWith('2000'), 'timestamps forged');
    eq([row.created_by_name, row.last_transition_by_user_id, row.last_transition_by_name], [wfName, U.wf, wfName]);
  });
  await check('raw SQL insert with reopen_count != 0 or a non-OPEN status is refused', async () => {
    eq(await sqlCode(() => asActor(db, ACT.wfCreate, () => db.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date,reopen_count)
      VALUES ('KAHE360','2031-06-01','2031-06-30',5)`).run())), 'ATTENDANCE_PERIOD_FIELD_IMMUTABLE');
    eq(await sqlCode(() => asActor(db, ACT.wfCreate, () => db.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date,status)
      VALUES ('KAHE360','2031-06-01','2031-06-30','REVIEW')`).run())), 'ATTENDANCE_PERIOD_INITIAL_STATUS_INVALID');
  });

  // =========================================================================
  section('2. LEGAL ENTITY SCOPE + OVERLAP');
  await check('the SAME dates in a different Legal Entity are allowed', async () => {
    const r = await mitra.post('/api/attendance-periods', { legal_entity_id: 'MITRA', start_date: '2030-09-01', end_date: '2030-09-30' });
    eq(r.status, 201);
  });
  const overlapCases = [
    ['identical', '2030-09-01', '2030-09-30'], ['contained', '2030-09-10', '2030-09-20'],
    ['containing', '2030-08-15', '2030-10-15'], ['straddling the start', '2030-08-20', '2030-09-05'],
    ['straddling the end', '2030-09-25', '2030-10-05'], ['touching an edge (inclusive dates)', '2030-09-30', '2030-10-10'],
  ];
  for (const [name, s, e] of overlapCases) {
    await check(`overlap in the same entity is rejected: ${name}`, async () => {
      const r = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: s, end_date: e });
      eq([r.status, r.body.error, r.body.detail.conflicting_period_id], [409, 'ATTENDANCE_PERIOD_OVERLAP', SEP.id]);
    });
  }
  let OCT;
  await check('an adjacent period (starts the day after) is allowed', async () => {
    const r = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2030-10-01', end_date: '2030-10-31' });
    eq(r.status, 201); OCT = r.body;
  });
  await check('an OPEN date edit that would create an overlap is rejected', async () => {
    const r = await wf.patch(`/api/attendance-periods/${OCT.id}`, { start_date: '2030-09-28' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_PERIOD_OVERLAP']);
  });
  await check('invalid range and invalid dates are rejected with machine codes', async () => {
    const a = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2032-02-10', end_date: '2032-02-01' });
    const b = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2032-02-30', end_date: '2032-03-01' });
    eq([a.status, a.body.error, b.status, b.body.error, b.body.detail.field],
      [400, 'ATTENDANCE_PERIOD_INVALID_RANGE', 400, 'REQUEST_FIELD_INVALID', 'start_date']);
  });

  // =========================================================================
  section('3. CONCURRENCY (legal_entities row lock; no writeSerializer)');
  await check('20 parallel overlapping creates on 20 connections: exactly ONE wins', async () => {
    const h = __t.openApp(20);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => sqlCode(() => asActor(h, ACT.wfCreate, () =>
      h.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date,label) VALUES ('KAHE360','2033-01-01','2033-01-31',?)`)
        .run(`race-${i}`)))));
    eq([results.filter((r) => r === 'OK').length, results.filter((r) => r === 'ATTENDANCE_PERIOD_OVERLAP').length], [1, 19]);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_periods WHERE start_date = '2033-01-01'`).get()).n, 1);
  });
  await check('different Legal Entities never wait for each other; the same entity does', async () => {
    const hA = __t.openApp(1); const hB = __t.openApp(1); const hC = __t.openApp(1);
    let releaseA; const gateA = new Promise((r) => { releaseA = r; });
    const txA = asActor(hA, ACT.wfCreate, async () => {
      await hA.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date) VALUES ('KAHE360','2034-01-01','2034-01-31')`).run();
      await gateA;                       // hold the KAHE360 lock, uncommitted
    });
    await sleep(300);
    const mitraCtx = { uid: U.mitra, name: 'Mitra WF', role: WF_ROLE, perm: 'attendance_period:CREATE' };
    const t0 = Date.now();
    eq(await sqlCode(() => asActor(hB, mitraCtx, () => hB.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date)
      VALUES ('MITRA','2034-01-01','2034-01-31')`).run())), 'OK');
    ok(Date.now() - t0 < 2000, `MITRA create waited ${Date.now() - t0} ms behind a KAHE360 lock`);
    const cPid = (await hC.prepare('SELECT pg_backend_pid() AS p').get()).p;
    const txC = sqlCode(() => asActor(hC, ACT.wfCreate, () => hC.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date)
      VALUES ('KAHE360','2034-01-15','2034-02-15')`).run()));
    await sleep(500);
    const waiting = await db.prepare(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ?`).get(cPid);
    eq(waiting && waiting.wait_event_type, 'Lock', 'same-entity writer state: ');
    releaseA(); await txA;
    eq(await txC, 'ATTENDANCE_PERIOD_OVERLAP', 'after A commits, the waiting writer sees A\'s period: ');
  });
  await check('an FK insert referencing the locked legal_entities row is NOT blocked (FOR NO KEY UPDATE vs FOR KEY SHARE)', async () => {
    const hA = __t.openApp(1); const hB = __t.openApp(1);
    let releaseA; const gateA = new Promise((r) => { releaseA = r; });
    const txA = asActor(hA, ACT.wfCreate, async () => {
      await hA.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date) VALUES ('KAHE360','2035-01-01','2035-01-31')`).run();
      await gateA;
    });
    await sleep(300);
    const res = await sqlCode(() => withTransaction(hB, async () => {
      await hB.query(`SET LOCAL lock_timeout = '1000ms'`);
      await hB.prepare(`INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by) VALUES (?, 'KAHE360', 'fk-probe') ON CONFLICT DO NOTHING`).run(U.health);
    }));
    releaseA(); await txA;
    eq(res, 'OK');
  });
  await check('HTTP: 20 parallel overlapping POSTs with the write serializer OFF -> exactly one 201', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2036-03-01', end_date: '2036-03-31' })));
    eq([rs.filter((r) => r.status === 201).length, rs.filter((r) => r.status === 409 && r.body.error === 'ATTENDANCE_PERIOD_OVERLAP').length], [1, 19]);
  });
  await check('REPEATABLE READ is refused (ATTENDANCE_PERIOD_ISOLATION_UNSUPPORTED)', async () => {
    const h = __t.openApp(1);
    const code = await sqlCode(() => withTransaction(h, async () => {
      await h.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await setCtx(h, ACT.wfCreate);
      await h.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date) VALUES ('KAHE360','2037-01-01','2037-01-31')`).run();
    }));
    eq(code, 'ATTENDANCE_PERIOD_ISOLATION_UNSUPPORTED');
  });

  // =========================================================================
  section('4. LIFECYCLE (CP1: OPEN <-> REVIEW only)');
  await check('OPEN -> REVIEW: last_transition_* is the session actor; TRANSITION event written', async () => {
    const r = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN' });
    eq([r.status, r.body.status, r.body.last_transition_by_user_id, r.body.last_transition_permission], [200, 'REVIEW', U.wf, 'attendance_period:EDIT']);
    const ev = (await periodEvents(SEP.id)).pop();
    eq([ev.event_type, ev.from_status, ev.to_status, ev.actor_user_id], ['TRANSITION', 'OPEN', 'REVIEW', U.wf]);
  });
  await check('REVIEW -> OPEN without a reason is rejected', async () => {
    const r = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'OPEN', expected_status: 'REVIEW' });
    eq([r.status, r.body.error], [400, 'ATTENDANCE_PERIOD_REASON_REQUIRED']);
  });
  await check('REVIEW -> OPEN with a reason; the reason is on the row and in the event', async () => {
    const r = await dir.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'OPEN', expected_status: 'REVIEW', reason: 'Data lembur belum lengkap' });
    eq([r.status, r.body.status, r.body.last_transition_by_user_id, r.body.last_transition_reason], [200, 'OPEN', U.director, 'Data lembur belum lengkap']);
    const ev = (await periodEvents(SEP.id)).pop();
    eq([ev.from_status, ev.to_status, ev.actor_name, ev.reason], ['REVIEW', 'OPEN', dirName, 'Data lembur belum lengkap']);
  });
  await check('compare-and-set: a stale expected_status is refused with the current status', async () => {
    const r = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'OPEN', expected_status: 'REVIEW', reason: 'x' });
    eq([r.status, r.body.error, r.body.detail], [409, 'ATTENDANCE_PERIOD_STATE_CHANGED', { expected_status: 'REVIEW', current_status: 'OPEN' }]);
  });
  await check('API: READY_TO_CLOSE is NOT ENABLED in CP1; CLOSED / FROZEN are invalid from OPEN', async () => {
    await wf.post(`/api/attendance-periods/${OCT.id}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN' });
    const a = await wf.post(`/api/attendance-periods/${OCT.id}/transition`, { to_status: 'READY_TO_CLOSE', expected_status: 'REVIEW' });
    const b = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'CLOSED', expected_status: 'OPEN' });
    const c = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'FROZEN', expected_status: 'OPEN' });
    eq([a.status, a.body.error, b.body.error, c.body.error],
      [409, 'ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED', 'ATTENDANCE_PERIOD_TRANSITION_INVALID', 'ATTENDANCE_PERIOD_TRANSITION_INVALID']);
    eq((await periodRow(OCT.id)).status, 'REVIEW');
  });
  await check('raw SQL (runtime role, valid actor): every non-enabled target status is refused', async () => {
    const codes = [];
    for (const to of ['READY_TO_CLOSE', 'CLOSED', 'FROZEN']) {
      codes.push(await sqlCode(() => asActor(db, ACT.wfEdit, () => db.prepare('UPDATE attendance_periods SET status = ? WHERE id = ?').run(to, OCT.id))));
    }
    eq(codes, ['ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED', 'ATTENDANCE_PERIOD_TRANSITION_INVALID', 'ATTENDANCE_PERIOD_TRANSITION_INVALID']);
    eq((await periodRow(OCT.id)).status, 'REVIEW');
  });
  await check('no reopen capability exists in CP1 (no route, no permission module)', async () => {
    const r = await dir.post(`/api/attendance-periods/${SEP.id}/reopen`, {});
    eq(r.status, 404);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM permissions WHERE code LIKE '%reopen%'`).get()).n, 0);
  });

  // =========================================================================
  section('5. TRANSITION METADATA INTEGRITY (database level)');
  await check('each last_transition_* field cannot be edited on its own', async () => {
    const fields = { last_transition_by_user_id: 999999, last_transition_by_name: 'X', last_transition_role: 'X',
      last_transition_permission: 'X', last_transition_reason: 'X', last_transition_at: '2000-01-01' };
    const out = [];
    for (const [f, v] of Object.entries(fields)) {
      await sqlCode(() => asActor(db, ACT.wfEdit, () => db.prepare(`UPDATE attendance_periods SET ${f} = ? WHERE id = ?`).run(v, SEP.id)));
      out.push(seenDbCodes[seenDbCodes.length - 1]);
    }
    eq(out.map((e) => [e.message, JSON.parse(e.detail).field]), Object.keys(fields).map((f) => ['ATTENDANCE_PERIOD_FIELD_IMMUTABLE', f]));
  });
  await check('reopen_count, created_by_* and legal_entity_id cannot be changed', async () => {
    const out = [];
    for (const [f, v] of [['reopen_count', 1], ['created_by_user_id', 1], ['created_by_name', 'X'], ['legal_entity_id', 'MITRA']]) {
      out.push(await sqlCode(() => asActor(db, ACT.wfEdit, () => db.prepare(`UPDATE attendance_periods SET ${f} = ? WHERE id = ?`).run(v, SEP.id))));
    }
    eq(out, Array(4).fill('ATTENDANCE_PERIOD_FIELD_IMMUTABLE'));
  });
  await check('a status change without actor context is refused (ACTOR_CONTEXT_REQUIRED)', async () => {
    eq(await sqlCode(() => withTransaction(db, () => db.prepare(`UPDATE attendance_periods SET status = 'REVIEW' WHERE id = ?`).run(SEP.id))), 'ACTOR_CONTEXT_REQUIRED');
  });
  await check('a context carrying the wrong permission is refused (ACTOR_PERMISSION_MISMATCH)', async () => {
    eq(await sqlCode(() => asActor(db, ACT.wfCreate, () => db.prepare(`UPDATE attendance_periods SET status = 'REVIEW' WHERE id = ?`).run(SEP.id))), 'ACTOR_PERMISSION_MISMATCH');
  });
  await check('a context naming a user WITHOUT the permission, or an INACTIVE user, is refused (ACTOR_NOT_AUTHORIZED)', async () => {
    const hseCtx = { uid: U.hse, name: 'HSE', role: 'HSE Officer', perm: 'attendance_period:EDIT' };
    const retiredCtx = { uid: U.retired, name: 'Retired', role: 'Operations Director', perm: 'attendance_period:EDIT' };
    eq([await sqlCode(() => asActor(db, hseCtx, () => db.prepare(`UPDATE attendance_periods SET status = 'REVIEW' WHERE id = ?`).run(SEP.id))),
      await sqlCode(() => asActor(db, retiredCtx, () => db.prepare(`UPDATE attendance_periods SET status = 'REVIEW' WHERE id = ?`).run(SEP.id)))],
    ['ACTOR_NOT_AUTHORIZED', 'ACTOR_NOT_AUTHORIZED']);
  });
  await check('on a transition, statement-supplied metadata is replaced by the context actor', async () => {
    const row = await asActor(db, ACT.wfEdit, () => db.prepare(`UPDATE attendance_periods SET status = 'REVIEW', last_transition_by_user_id = ?,
      last_transition_by_name = 'Forged', last_transition_permission = 'x' WHERE id = ? RETURNING *`).get(U.director, SEP.id));
    eq([row.status, row.last_transition_by_user_id, row.last_transition_by_name, row.last_transition_permission],
      ['REVIEW', U.wf, wfName, 'attendance_period:EDIT']);
    await asActor(db, { ...ACT.wfEdit, reason: 'kembali' }, () => db.prepare(`UPDATE attendance_periods SET status = 'OPEN' WHERE id = ?`).run(SEP.id));
  });

  // =========================================================================
  section('6. DETAILS EDIT (OPEN only; last_transition_* untouched)');
  await check('an OPEN details edit leaves last_transition_* byte-identical and writes DETAILS_CHANGED', async () => {
    const before = await periodRow(SEP.id);
    const createEvent = (await periodEvents(SEP.id))[0];
    const r = await wf.patch(`/api/attendance-periods/${SEP.id}`, { end_date: '2030-09-29', label: 'Sep 2030 (rev)' });
    eq([r.status, r.body.status, r.body.end_date], [200, 'OPEN', '2030-09-29']);
    const after = await periodRow(SEP.id);
    for (const f of Object.keys(before).filter((k) => k.startsWith('last_transition_') || k.startsWith('created_') || k === 'reopen_count')) {
      eq(after[f], before[f], `${f}: `);
    }
    const ev = (await periodEvents(SEP.id)).pop();
    eq([ev.event_type, ev.from_status, ev.to_status, ev.actor_user_id, ev.old_values.end_date, ev.new_values.end_date, ev.new_values.label],
      ['DETAILS_CHANGED', 'OPEN', 'OPEN', U.wf, '2030-09-30', '2030-09-29', 'Sep 2030 (rev)']);
    eq((await periodEvents(SEP.id))[0], createEvent, 'CREATE event unchanged: ');
  });
  await check('a details edit outside OPEN is refused (ATTENDANCE_PERIOD_DETAILS_LOCKED)', async () => {
    const r = await wf.patch(`/api/attendance-periods/${OCT.id}`, { label: 'x' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_PERIOD_DETAILS_LOCKED']);
  });

  // =========================================================================
  section('7. APPEND-ONLY / NO DELETE');
  await check('period events: direct INSERT, UPDATE, DELETE are refused; runtime role cannot TRUNCATE', async () => {
    eq([
      await sqlCode(() => db.prepare(`INSERT INTO attendance_period_events (period_id,event_type,to_status,actor_user_id,actor_name,actor_role,permission,created_at)
        VALUES (?, 'CREATE', 'OPEN', 1, 'x', 'x', 'x', kahe_now())`).run(SEP.id)),
      await sqlCode(() => db.prepare(`UPDATE attendance_period_events SET reason = 'x' WHERE period_id = ?`).run(SEP.id)),
      await sqlCode(() => db.prepare(`DELETE FROM attendance_period_events WHERE period_id = ?`).run(SEP.id)),
      await sqlCode(() => db.exec('TRUNCATE attendance_period_events')),
    ], ['A4_AUDIT_DIRECT_INSERT_FORBIDDEN', 'A4_AUDIT_APPEND_ONLY', 'A4_AUDIT_APPEND_ONLY', 'SQLSTATE:42501']);
  });
  await check('periods cannot be deleted; even the schema OWNER cannot TRUNCATE A4 tables', async () => {
    const o = __t.openOwner(1);
    const owner = [];
    for (const t of [...PG_NATIVE_TABLES].sort()) owner.push(await sqlCode(() => o.exec(`TRUNCATE ${t} CASCADE`)));
    eq([await sqlCode(() => db.prepare('DELETE FROM attendance_periods WHERE id = ?').run(SEP.id)), owner],
      ['ATTENDANCE_PERIOD_DELETE_FORBIDDEN', Array(5).fill('A4_TRUNCATE_FORBIDDEN')]);
  });

  // =========================================================================
  section('8. ACTOR IDENTITY COMES ONLY FROM THE SESSION');
  await check('a Workforce Manager cannot impersonate the Director through body fields (400, nothing created)', async () => {
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_periods').get()).n;
    const r = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2038-01-01', end_date: '2038-01-31',
      actor_user_id: U.director, created_by_user_id: U.director, permission: 'attendance_period:CREATE', last_transition_by_name: 'Director' });
    eq([r.status, r.body.error, r.body.detail.fields],
      [400, 'REQUEST_FIELD_NOT_ALLOWED', ['actor_user_id', 'created_by_user_id', 'last_transition_by_name', 'permission']]);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM attendance_periods').get()).n, before);
  });
  await check('transition / details / policy bodies reject identity and metadata fields', async () => {
    const a = await wf.post(`/api/attendance-periods/${SEP.id}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN', last_transition_by_user_id: U.director });
    const b = await wf.patch(`/api/attendance-periods/${SEP.id}`, { label: 'y', reopen_count: 3, status: 'CLOSED' });
    const c = await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2030-01-01', created_by_user_id: U.wf, activated_by_user_id: U.wf });
    eq([a.body.error, a.body.detail.fields, b.body.detail.fields, c.body.error, c.body.detail.fields],
      ['REQUEST_FIELD_NOT_ALLOWED', ['last_transition_by_user_id'], ['reopen_count', 'status'], 'REQUEST_FIELD_NOT_ALLOWED', ['activated_by_user_id', 'created_by_user_id']]);
    eq((await periodRow(SEP.id)).status, 'OPEN');
  });
  await check('the persisted actor is always the authenticated user (row + event), for each of two users', async () => {
    const a = await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2039-01-01', end_date: '2039-01-31' });
    const b = await dir.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2039-02-01', end_date: '2039-02-28' });
    const ea = (await periodEvents(a.body.id))[0]; const eb = (await periodEvents(b.body.id))[0];
    eq([a.body.created_by_user_id, ea.actor_user_id, b.body.created_by_user_id, eb.actor_user_id, eb.actor_role],
      [U.wf, U.wf, U.director, U.director, DIR_ROLE]);
  });

  section('9. ACTION CONTEXT IS TRANSACTION-LOCAL');
  await check('no kahe.* value survives COMMIT or ROLLBACK on the same pooled connection', async () => {
    const h = __t.openApp(1);
    const pid1 = await withTransaction(h, async () => { await setCtx(h, ACT.wfCreate); return (await h.prepare('SELECT pg_backend_pid() AS p').get()).p; });
    const afterCommit = await h.prepare(`SELECT pg_backend_pid() AS p, current_setting('kahe.actor_user_id', true) AS u,
      current_setting('kahe.permission', true) AS perm`).get();
    await sqlCode(() => withTransaction(h, async () => { await setCtx(h, ACT.wfCreate); throw new Error('boom'); }));
    const afterRollback = await h.prepare(`SELECT pg_backend_pid() AS p, current_setting('kahe.actor_user_id', true) AS u`).get();
    eq([afterCommit.p === pid1, afterRollback.p === pid1, afterCommit.u || '', afterCommit.perm || '', afterRollback.u || ''], [true, true, '', '', '']);
    eq(await sqlCode(() => withTransaction(h, () => h.prepare(`INSERT INTO attendance_periods (legal_entity_id,start_date,end_date)
      VALUES ('KAHE360','2040-01-01','2040-01-31')`).run())), 'ACTOR_CONTEXT_REQUIRED', 'a later transaction inherits nothing: ');
  });

  // =========================================================================
  section('10. CLOSING POLICY LIFECYCLE + APPEND-ONLY AUDIT');
  let V1; let V2; let V3;
  await check('DRAFT create (Director): version 1, POLICY_CREATED with the session actor', async () => {
    const r = await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2030-01-01', require_waiver_evidence: true });
    eq([r.status, r.body.status, r.body.version_no, r.body.created_by_user_id, r.body.sod_waiver_blocks_freeze, r.body.require_waiver_evidence],
      [201, 'DRAFT', 1, U.director, 1, 1]);
    V1 = r.body;
    eq((await policyEvents(V1.id)).map((e) => [e.event_type, e.actor_user_id, e.permission]),
      [['POLICY_CREATED', U.director, 'attendance_closing_policy:CREATE']]);
  });
  await check('DRAFT header edit writes POLICY_UPDATED with old/new values', async () => {
    const r = await dir.patch(`/api/attendance-closing-policies/${V1.id}`, { sod_waiver_blocks_freeze: false });
    eq([r.status, r.body.sod_waiver_blocks_freeze], [200, 0]);
    const ev = (await policyEvents(V1.id)).pop();
    eq([ev.event_type, ev.old_values.sod_waiver_blocks_freeze, ev.new_values.sod_waiver_blocks_freeze], ['POLICY_UPDATED', 1, 0]);
  });
  await check('rules: add, modify, remove -> one POLICY_RULE_CHANGED each (old NULL on add, new NULL on remove)', async () => {
    await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/MISSING_CLOCK_IN`, { severity: 'BLOCKER', waivable: true, evidence_required: true });
    await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/PENDING_OVERTIME_APPROVAL`, { severity: 'WARNING' });
    await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/PENDING_OVERTIME_APPROVAL`, { severity: 'BLOCKER' });
    await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/NO_SCHEDULE`, { severity: 'INFORMATIONAL' });
    const del = await dir.del(`/api/attendance-closing-policies/${V1.id}/rules/NO_SCHEDULE`);
    eq(del.body.rules.map((x) => [x.issue_code, x.severity, x.waivable, x.evidence_required]),
      [['MISSING_CLOCK_IN', 'BLOCKER', 1, 1], ['PENDING_OVERTIME_APPROVAL', 'BLOCKER', 0, 0]]);
    const ev = (await policyEvents(V1.id)).filter((e) => e.event_type === 'POLICY_RULE_CHANGED');
    eq(ev.map((e) => [e.old_values && e.old_values.severity, e.new_values && e.new_values.severity]),
      [[null, 'BLOCKER'], [null, 'WARNING'], ['WARNING', 'BLOCKER'], [null, 'INFORMATIONAL'], ['INFORMATIONAL', null]]);
  });
  await check('issue codes: unknown refused; TIMESHEET_LEGAL_ENTITY_UNRESOLVED is not configurable (API and database)', async () => {
    const a = await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/INVENTED_CODE`, { severity: 'BLOCKER' });
    const b = await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/TIMESHEET_LEGAL_ENTITY_UNRESOLVED`, { severity: 'WARNING' });
    const ctx = { uid: U.director, name: dirName, role: DIR_ROLE, perm: 'attendance_closing_policy:EDIT' };
    const c = await sqlCode(() => asActor(db, ctx, () => db.prepare(`INSERT INTO attendance_closing_policy_rules (policy_id,issue_code,severity)
      VALUES (?, 'TIMESHEET_LEGAL_ENTITY_UNRESOLVED', 'WARNING')`).run(V1.id)));
    eq([a.body.error, b.body.error, c], ['CLOSING_POLICY_ISSUE_CODE_UNKNOWN', 'CLOSING_POLICY_ISSUE_CODE_NOT_CONFIGURABLE', 'SQLSTATE:23514']);
    const codes = (await dir.get('/api/attendance-closing-policies/issue-codes')).body;
    eq([codes.configurable.length, codes.fixed_blockers], [16, ['TIMESHEET_LEGAL_ENTITY_UNRESOLVED']]);
  });
  await check('a waiver or evidence flag on a non-BLOCKER rule is refused', async () => {
    const r = await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/LATE_CORRECTION`, { severity: 'WARNING', waivable: true });
    eq([r.status, r.body.error, r.body.detail.reason], [400, 'CLOSING_POLICY_RULE_INVALID', 'WAIVER_ONLY_FOR_BLOCKER']);
  });
  await check('DRAFT -> ACTIVE (ADMIN): activated_by is the session user; POLICY_ACTIVATED', async () => {
    const r = await dir.post(`/api/attendance-closing-policies/${V1.id}/activate`, {});
    eq([r.status, r.body.status, r.body.activated_by_user_id], [200, 'ACTIVE', U.director]);
    eq((await policyEvents(V1.id)).pop().event_type, 'POLICY_ACTIVATED');
  });
  await check('ACTIVE content and rules are immutable', async () => {
    const a = await dir.patch(`/api/attendance-closing-policies/${V1.id}`, { effective_from: '2030-02-01' });
    const b = await dir.put(`/api/attendance-closing-policies/${V1.id}/rules/NO_SCHEDULE`, { severity: 'WARNING' });
    const c = await dir.del(`/api/attendance-closing-policies/${V1.id}/rules/MISSING_CLOCK_IN`);
    eq([a.body.error, b.body.error, c.body.error], ['CLOSING_POLICY_IMMUTABLE', 'CLOSING_POLICY_IMMUTABLE', 'CLOSING_POLICY_IMMUTABLE']);
  });
  await check('an overlapping ACTIVE version is refused', async () => {
    V2 = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2031-01-01' })).body;
    const r = await dir.post(`/api/attendance-closing-policies/${V2.id}/activate`, {});
    eq([r.status, r.body.error, r.body.detail.conflicting_policy_id, V2.version_no], [409, 'CLOSING_POLICY_OVERLAP', V1.id, 2]);
  });
  await check('ACTIVE -> ENDED: effective_to must not precede effective_from; POLICY_ENDED; then v2 can activate', async () => {
    const bad = await dir.post(`/api/attendance-closing-policies/${V1.id}/end`, { effective_to: '2029-12-31' });
    const good = await dir.post(`/api/attendance-closing-policies/${V1.id}/end`, { effective_to: '2030-12-31', reason: 'Diganti versi 2' });
    eq([bad.body.error, good.status, good.body.status, good.body.effective_to], ['CLOSING_POLICY_INVALID_EFFECTIVE_TO', 200, 'ENDED', '2030-12-31']);
    const ev = (await policyEvents(V1.id)).pop();
    eq([ev.event_type, ev.reason, ev.new_values.effective_to], ['POLICY_ENDED', 'Diganti versi 2', '2030-12-31']);
    eq((await dir.post(`/api/attendance-closing-policies/${V2.id}/activate`, {})).body.status, 'ACTIVE');
  });
  await check('ENDED is terminal (no end, discard, edit, activate)', async () => {
    const rs = [await dir.post(`/api/attendance-closing-policies/${V1.id}/end`, { effective_to: '2030-06-30' }),
      await dir.post(`/api/attendance-closing-policies/${V1.id}/discard`, {}),
      await dir.patch(`/api/attendance-closing-policies/${V1.id}`, { require_waiver_reason: false }),
      await dir.post(`/api/attendance-closing-policies/${V1.id}/activate`, {})];
    eq(rs.map((r) => [r.status, r.body.error]), Array(4).fill([409, 'CLOSING_POLICY_IMMUTABLE']));
  });
  await check('DRAFT -> DISCARDED (POLICY_DISCARDED); DISCARDED is terminal', async () => {
    V3 = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2032-01-01' })).body;
    const d = await dir.post(`/api/attendance-closing-policies/${V3.id}/discard`, { reason: 'Salah input' });
    eq([d.status, d.body.status], [200, 'DISCARDED']);
    eq((await policyEvents(V3.id)).map((e) => e.event_type), ['POLICY_CREATED', 'POLICY_DISCARDED']);
    const again = await dir.post(`/api/attendance-closing-policies/${V3.id}/activate`, {});
    eq([again.status, again.body.error], [409, 'CLOSING_POLICY_IMMUTABLE']);
  });
  await check('no policy row can be deleted, in any status', async () => {
    const out = [];
    for (const p of [V1, V2, V3]) out.push(await sqlCode(() => db.prepare('DELETE FROM attendance_closing_policies WHERE id = ?').run(p.id)));
    eq(out, Array(3).fill('CLOSING_POLICY_DELETE_FORBIDDEN'));
  });
  await check('policy events: direct INSERT, UPDATE, DELETE refused; runtime cannot TRUNCATE', async () => {
    eq([
      await sqlCode(() => db.prepare(`INSERT INTO attendance_closing_policy_events (policy_id,event_type,actor_user_id,actor_name,actor_role,permission,created_at)
        VALUES (?, 'POLICY_CREATED', 1, 'x', 'x', 'x', kahe_now())`).run(V1.id)),
      await sqlCode(() => db.prepare(`UPDATE attendance_closing_policy_events SET reason = 'x' WHERE policy_id = ?`).run(V1.id)),
      await sqlCode(() => db.prepare(`DELETE FROM attendance_closing_policy_events WHERE policy_id = ?`).run(V1.id)),
      await sqlCode(() => db.exec('TRUNCATE attendance_closing_policy_events')),
    ], ['A4_AUDIT_DIRECT_INSERT_FORBIDDEN', 'A4_AUDIT_APPEND_ONLY', 'A4_AUDIT_APPEND_ONLY', 'SQLSTATE:42501']);
  });
  await check('exactly one audit event per material action on v1', async () => {
    eq((await policyEvents(V1.id)).map((e) => e.event_type), ['POLICY_CREATED', 'POLICY_UPDATED', 'POLICY_RULE_CHANGED', 'POLICY_RULE_CHANGED',
      'POLICY_RULE_CHANGED', 'POLICY_RULE_CHANGED', 'POLICY_RULE_CHANGED', 'POLICY_ACTIVATED', 'POLICY_ENDED']);
  });
  await check('parallel activation of two overlapping DRAFTs (MITRA): exactly one becomes ACTIVE', async () => {
    const a = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'MITRA', effective_from: '2030-01-01' })).body;
    const b = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'MITRA', effective_from: '2030-06-01' })).body;
    const rs = await Promise.all([dir.post(`/api/attendance-closing-policies/${a.id}/activate`, {}),
      dir.post(`/api/attendance-closing-policies/${b.id}/activate`, {})]);
    eq(rs.map((r) => r.status).sort(), [200, 409]);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_closing_policies WHERE legal_entity_id = 'MITRA' AND status = 'ACTIVE'`).get()).n, 1);
  });
  await check('historical as-of resolution: v1 (ENDED) for 2030, v2 for 2031+, NO_CLOSING_POLICY before any version', async () => {
    const r2030 = await wf.get('/api/attendance-closing-policies/resolve?legal_entity_id=KAHE360&date=2030-06-15');
    const r2031 = await wf.get('/api/attendance-closing-policies/resolve?legal_entity_id=KAHE360&date=2031-06-15');
    const r2029 = await wf.get('/api/attendance-closing-policies/resolve?legal_entity_id=KAHE360&date=2029-12-31');
    eq([r2030.body.id, r2030.body.status, r2030.body.rules.length, r2031.body.id, r2029.status, r2029.body.error, r2029.body.detail],
      [V1.id, 'ENDED', 2, V2.id, 404, 'NO_CLOSING_POLICY', { legal_entity_id: 'KAHE360', date: '2029-12-31' }]);
    eq((await cpLib.resolvePolicy(db, 'KAHE360', '2030-12-31')).id, V1.id, 'last day of v1: ');
    eq((await cpLib.resolvePolicy(db, 'KAHE360', '2031-01-01')).id, V2.id, 'first day of v2: ');
  });

  // =========================================================================
  section('11. LEGAL ENTITY ISOLATION');
  const mitraPeriod = (await db.prepare(`SELECT id FROM attendance_periods WHERE legal_entity_id = 'MITRA' AND start_date = '2030-09-01'`).get()).id;
  await check('cross-entity read is 404 NOT_FOUND ({error, detail}), for the period and its events', async () => {
    const a = await wf.get(`/api/attendance-periods/${mitraPeriod}`);
    const b = await wf.get(`/api/attendance-periods/${mitraPeriod}/events`);
    const c = await mitra.get(`/api/attendance-periods/${SEP.id}`);
    eq([a.status, a.body, b.status, c.status], [404, { error: 'NOT_FOUND', detail: {} }, 404, 404]);
  });
  await check('cross-entity writes are refused (create, edit, transition)', async () => {
    const a = await wf.post('/api/attendance-periods', { legal_entity_id: 'MITRA', start_date: '2041-01-01', end_date: '2041-01-31' });
    const b = await wf.patch(`/api/attendance-periods/${mitraPeriod}`, { label: 'x' });
    const c = await wf.post(`/api/attendance-periods/${mitraPeriod}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN' });
    eq([a.status, b.status, c.status], [404, 404, 404]);
    eq((await periodRow(mitraPeriod)).status, 'OPEN');
  });
  await check('lists never include a foreign entity, even when filtered for it', async () => {
    const own = (await wf.get('/api/attendance-periods?limit=200')).body;
    const foreign = (await wf.get('/api/attendance-periods?legal_entity_id=MITRA')).body;
    const mine = (await mitra.get('/api/attendance-periods?limit=200')).body;
    ok(own.items.every((p) => p.legal_entity_id === 'KAHE360') && own.total === own.items.length, 'wf list');
    eq([foreign.total, foreign.items.length], [0, 0]);
    ok(mine.items.length > 0 && mine.items.every((p) => p.legal_entity_id === 'MITRA'), 'mitra list');
    const pol = (await wf.get('/api/attendance-closing-policies?limit=200')).body;
    ok(pol.items.every((p) => p.legal_entity_id === 'KAHE360'), 'policy list');
    eq((await wf.get('/api/attendance-closing-policies/resolve?legal_entity_id=MITRA&date=2030-06-15')).status, 404);
  });

  // =========================================================================
  section('12. RBAC (6 demo roles x every endpoint)');
  await check('permission matrix: exactly the approved grants reach the handlers', async () => {
    const users = { director: dir, wf, hrd, payroll: pay, health, hse };
    const allow = {
      PV: ['director', 'wf', 'hrd', 'payroll'], PC: ['director', 'wf'], PE: ['director', 'wf'],
      CV: ['director', 'wf', 'hrd', 'payroll'], CC: ['director'], CE: ['director'], CA: ['director'],
    };
    const probes = [
      ['PV', (u) => u.get('/api/attendance-periods')], ['PV', (u) => u.get(`/api/attendance-periods/${SEP.id}`)],
      ['PV', (u) => u.get(`/api/attendance-periods/${SEP.id}/events`)], ['PV', (u) => u.get(`/api/attendance-periods/${SEP.id}/payroll-periods`)],
      ['PC', (u) => u.post('/api/attendance-periods', {})], ['PE', (u) => u.patch(`/api/attendance-periods/${SEP.id}`, {})],
      ['PE', (u) => u.post(`/api/attendance-periods/${SEP.id}/transition`, {})],
      ['CV', (u) => u.get('/api/attendance-closing-policies')], ['CV', (u) => u.get('/api/attendance-closing-policies/issue-codes')],
      ['CV', (u) => u.get(`/api/attendance-closing-policies/${V2.id}`)], ['CV', (u) => u.get(`/api/attendance-closing-policies/${V2.id}/events`)],
      ['CV', (u) => u.get('/api/attendance-closing-policies/resolve?legal_entity_id=KAHE360&date=2031-06-01')],
      ['CC', (u) => u.post('/api/attendance-closing-policies', {})], ['CE', (u) => u.patch('/api/attendance-closing-policies/999999', {})],
      ['CE', (u) => u.put('/api/attendance-closing-policies/999999/rules/NO_SCHEDULE', {})],
      ['CE', (u) => u.del('/api/attendance-closing-policies/999999/rules/NO_SCHEDULE')],
      ['CE', (u) => u.post('/api/attendance-closing-policies/999999/discard', {})],
      ['CA', (u) => u.post('/api/attendance-closing-policies/999999/activate', {})],
      ['CA', (u) => u.post('/api/attendance-closing-policies/999999/end', {})],
    ];
    const bad = [];
    for (const [cls, probe] of probes) {
      for (const [name, u] of Object.entries(users)) {
        const r = await probe(u);
        const allowed = allow[cls].includes(name);
        if (allowed === (r.status === 403) || (!allowed && r.body.error !== 'FORBIDDEN')) bad.push(`${cls} ${name} -> ${r.status}`);
      }
    }
    eq(bad, []);
  });
  await check('seeded grants in the database equal the approved table (no EXPORT, no APPROVE/REJECT)', async () => {
    const rows = await db.prepare(`SELECT r.code AS role, p.code AS module, string_agg(rp.action, ',' ORDER BY rp.action) AS actions
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE p.code IN ('attendance_period','attendance_closing_policy') GROUP BY 1, 2 ORDER BY 1, 2`).all();
    eq(rows.map((r) => `${r.role}:${r.module}=${r.actions}`), [
      'hrd_officer:attendance_closing_policy=VIEW', 'hrd_officer:attendance_period=VIEW',
      'operations_director:attendance_closing_policy=ADMIN,CREATE,EDIT,VIEW', 'operations_director:attendance_period=CREATE,EDIT,VIEW',
      'payroll_officer:attendance_closing_policy=VIEW', 'payroll_officer:attendance_period=VIEW',
      'workforce_manager:attendance_closing_policy=VIEW', 'workforce_manager:attendance_period=CREATE,EDIT,VIEW',
    ]);
  });

  // =========================================================================
  section('13. ATTENDANCE PERIOD <-> PAYROLL PERIOD (derived, N:M)');
  let JAN;
  await check('payroll periods of the same entity are found; a straddling weekly period is flagged; foreign entity excluded', async () => {
    JAN = (await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: '2031-01-01', end_date: '2031-01-31' })).body;
    const r = await wf.get(`/api/attendance-periods/${JAN.id}/payroll-periods`);
    eq(r.body.payroll_periods.map((p) => [p.payroll_period_id, p.straddles]), [[PP.kJan, false], [PP.kWeekStraddle, true]]);
    ok(!r.body.payroll_periods.some((p) => p.payroll_period_id === PP.mJan), 'MITRA payroll period leaked');
  });
  await check('coverage: gaps are reported for a straddling payroll period; a covered one is fully covered', async () => {
    const straddle = await ap.coverageFor(db, PP.kWeekStraddle);
    eq([straddle.covering.map((c) => c.id), straddle.gaps, straddle.fully_covered], [[JAN.id], [{ start_date: '2031-02-01', end_date: '2031-02-02' }], false]);
    const month = await ap.coverageFor(db, PP.kJan);
    eq([month.gaps, month.fully_covered], [[], true]);
    const feb = await ap.coverageFor(db, PP.kFeb);
    eq(feb.gaps, [{ start_date: '2031-02-01', end_date: '2031-02-28' }]);
  });

  // =========================================================================
  section('14. NON-INTERFERENCE WITH A1 / A3 (timesheet_entries untouched)');
  await check('timesheet_entries carries exactly its pre-A4 triggers (no A4 trigger on any existing table)', async () => {
    const t = await db.prepare(`SELECT t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'timesheet_entries' ORDER BY 1`).all();
    eq(t.map((x) => x.n), ['trg_attendance_frozen_delete', 'trg_attendance_frozen_insert', 'trg_attendance_frozen_update']);
    const foreign = await db.prepare(`SELECT c.relname AS t, t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal
        AND (p.proname LIKE 'kahe_a4_%' OR p.proname LIKE 'trg_attendance_period%' OR p.proname LIKE 'trg_closing_polic%')
        AND c.relname NOT IN ('attendance_periods','attendance_period_events','attendance_closing_policies',
          'attendance_closing_policy_rules','attendance_closing_policy_events')`).all();
    eq(foreign, []);
  });
  const workdays = [];
  for (let d = bt.addDays(today, -1); workdays.length < 3; d = bt.addDays(d, -1)) if (bt.isoWeekday(d) !== 7) workdays.push(d);
  let ENTRY;
  await check('A1 create + edit behave identically while an A4 period (REVIEW) covers the date', async () => {
    const live = (await wf.post('/api/attendance-periods', { legal_entity_id: 'KAHE360', start_date: bt.addDays(today, -20), end_date: bt.addDays(today, 5) })).body;
    eq((await wf.post(`/api/attendance-periods/${live.id}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN' })).status, 200);
    const c = await wf.post('/api/timesheet/entries', { employee_id: 'E-A4-1', work_date: workdays[0], clock_in: '07:00', clock_out: '16:00' });
    eq(c.status, 201); ENTRY = c.body.id;
    const e = await wf.put(`/api/timesheet/entries/${ENTRY}`, { clock_in: '07:00', clock_out: '17:00' });
    eq(e.status, 200);
  });
  await check('A3 correction: request -> submit -> review -> approve -> APPLIED, unaffected by the A4 period', async () => {
    const pol = await wf.post('/api/attendance-correction/policies', { code: 'CORR-A4', name: 'A4 test', legal_entity_id: 'KAHE360',
      correction_window: 7, window_unit: 'DAYS', allow_late_correction: true, late_requires_approval: true, evidence_requirement: 'OPTIONAL',
      post_finalized_evidence_required: true, abnormal_duration_ratio_pct: 150, ot_grace_minutes: 30, ot_mismatch_tolerance_minutes: 15,
      effective_from: '2019-01-01' });
    eq(pol.status, 201);
    const req = await sup.post('/api/attendance-correction/requests', { timesheet_entry_id: ENTRY, reason_code: 'MISSED_CLOCK_OUT',
      reason_text: 'Lupa tap pulang', proposed_values: { clock_out: '18:00' }, submit: false });
    eq(req.status, 201);
    eq((await sup.post(`/api/attendance-correction/requests/${req.body.id}/submit`)).body.status, 'SUBMITTED');
    eq((await wf.post(`/api/attendance-correction/requests/${req.body.id}/review`, { note: 'ok' })).body.status, 'UNDER_REVIEW');
    const d = await wf.post(`/api/attendance-correction/requests/${req.body.id}/decide`, { decision: 'approved' });
    eq([d.status, d.body.status, d.body.applied], [200, 'APPLIED', true]);
    eq((await db.prepare('SELECT clock_out FROM timesheet_entries WHERE id = ?').get(ENTRY)).clock_out, '18:00');
  });

  // =========================================================================
  section('15. BILINGUAL / LANGUAGE-NEUTRAL CONTRACT');
  await check(`every A4 error response in this suite is exactly {error, detail} with a catalogue code (n=${seenHttpErrors.length})`, async () => {
    ok(seenHttpErrors.length >= 40, `only ${seenHttpErrors.length} error responses observed`);
    const bad = seenHttpErrors.filter((e) => JSON.stringify(Object.keys(e.body).sort()) !== '["detail","error"]'
      || !ap.ERROR_CODES.includes(e.body.error) || typeof e.body.detail !== 'object' || e.body.detail === null || Array.isArray(e.body.detail)
      || 'message' in e.body || ap.ERRORS[e.body.error] !== e.status);
    eq(bad, []);
  });
  await check(`every A4 database refusal is a bare catalogue code with a JSON detail (n=${seenDbCodes.length})`, async () => {
    ok(seenDbCodes.length >= 30, `only ${seenDbCodes.length} refusals observed`);
    const bad = seenDbCodes.filter((e) => !ap.ERROR_CODES.includes(e.message) || !/^[A-Z0-9_]+$/.test(e.message)
      || typeof JSON.parse(e.detail || 'null') !== 'object');
    eq(bad, []);
  });
  await check('statuses and event types are language-neutral identifiers', async () => {
    const vals = await db.prepare(`SELECT DISTINCT status AS v FROM attendance_periods UNION SELECT DISTINCT event_type FROM attendance_period_events
      UNION SELECT DISTINCT status FROM attendance_closing_policies UNION SELECT DISTINCT event_type FROM attendance_closing_policy_events`).all();
    ok(vals.length > 0 && vals.every((x) => /^[A-Z_]+$/.test(x.v)), JSON.stringify(vals));
  });

  // =========================================================================
  section('16. POSTGRESQL-NATIVE ALLOWLIST');
  await check('PG_NATIVE_TABLES equals exactly the 5 A4 tables that exist', async () => {
    const expected = ['attendance_closing_policies', 'attendance_closing_policy_events', 'attendance_closing_policy_rules',
      'attendance_period_events', 'attendance_periods'];
    eq([...PG_NATIVE_TABLES].sort(), expected);
    const present = await db.prepare(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'
      AND (table_name LIKE 'attendance_period%' OR table_name LIKE 'attendance_closing_polic%') ORDER BY 1`).all();
    eq(present.map((r) => r.t), expected);
  });
  await check('A4 trigger inventory: 22 row triggers + 5 no-truncate triggers, all on A4 tables', async () => {
    const t = await db.prepare(`SELECT t.tgname AS n, c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('attendance_periods','attendance_period_events','attendance_closing_policies',
        'attendance_closing_policy_rules','attendance_closing_policy_events')`).all();
    eq([t.filter((x) => !x.n.endsWith('no_truncate')).length, t.filter((x) => x.n.endsWith('no_truncate')).length], [22, 5]);
  });

  console.log(`\n============================================================\nA4 CP1 TESTS: ${passed} passed, ${failed} failed\n============================================================`);
  if (failed) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
})().catch((e) => { console.error(e); failed += 1; }).finally(async () => {
  if (server) server.kill();
  await __t.drop();
  process.exit(failed ? 1 : 0);
});
})();
