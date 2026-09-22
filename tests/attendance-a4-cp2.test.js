(async () => {
// tests/attendance-a4-cp2.test.js
// Attendance A4 CP2 — readiness engine, READY_TO_CLOSE gate, withdrawal, batch-attribution equivalence,
// hard performance gates. REAL server.js over HTTP, REAL seed.js RBAC, SQL probes as the RUNTIME role.
// KAHE_WRITE_SERIALIZATION=off for the whole suite: nothing here may depend on the write queue.
// Usage: npm run test:attendance-a4-cp2   (A4_CP2_SKIP_PERF=1 skips the two performance profiles)
process.env.KAHE_DB_QUERY_STATS = '1';   // enables database/db.js runWithQueryStats (diagnostics only)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { createTestDatabase } = require('./helpers/pgTestDb');
const __t = await createTestDatabase('attendance_a4_cp2');
process.env.DATABASE_URL = __t.appUrl;
const bcrypt = require('bcryptjs');
const bt = require('../lib/businessTime');
const { withTransaction, runWithQueryStats } = require('../database/db');
const ap = require('../lib/attendancePeriod');
const rd = require('../lib/attendanceReadiness');
const guard = require('../lib/attendanceGuard');
const eligibility = require('../lib/employeeEligibility');
const exceptionLib = require('../lib/attendanceException');
const { PG_NATIVE_TABLES, PG_NATIVE_TABLES_CP2 } = require('../database/pg/migrate-from-sqlite');

const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Kahe360Demo!2026';
const SKIP_PERF = process.env.A4_CP2_SKIP_PERF === '1';

let passed = 0, failed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function ok(c, label) { if (!c) throw new Error(label || 'assertion failed'); }
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seenHttpErrors = [];

// ---- seed + base fixtures ------------------------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl }, stdio: 'pipe' });
const db = __t.db;
const q = (sql, ...p) => db.prepare(sql).run(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
await q(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active') ON CONFLICT DO NOTHING`);
for (const [id, type] of [['KAHE360', 'internal'], ['MITRA', 'subkontraktor'], ['PERFA', 'internal'], ['PERFB', 'internal']]) {
  await q(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES (?,?,?,'high','2019-01-01') ON CONFLICT DO NOTHING`, id, id, type);
}
const WP6 = Number((await q(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('6H',6,'sunday','2019-01-01') RETURNING id`)).lastInsertRowid);
const CAL = Number((await q(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('CAL','Kalender','2019-01-01') RETURNING id`)).lastInsertRowid);
const CAL2 = Number((await q(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('CAL2','Kalender 2','2019-01-01') RETURNING id`)).lastInsertRowid);
const CALF = Number((await q(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('CALF','Future','2040-01-01') RETURNING id`)).lastInsertRowid);
await q(`INSERT INTO holidays ("date",name,scope,holiday_type,work_calendar_id) VALUES ('2031-03-28','Libur Nasional','national','PUBLIC_HOLIDAY',?)`, CAL);
const SCHED = Number((await q(`INSERT INTO work_schedules (code,name,legal_entity_id,schedule_type,clock_in,clock_out,
  standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by)
  VALUES ('DAY','Day',NULL,'SITE','07:00','16:00',480,0,'AFTER_SHIFT_END','2019-01-01','fixture') RETURNING id`)).lastInsertRowid);
await q(`INSERT INTO work_schedule_breaks (work_schedule_id,name,duration_minutes,is_paid,sequence) VALUES (?, 'Istirahat', 60, 0, 1)`, SCHED);
const PAT = Number((await q(`INSERT INTO attendance_work_patterns (code,name,legal_entity_id,pattern_type,effective_from,created_by)
  VALUES ('W6','W6',NULL,'FIXED_WEEKLY','2019-01-01','fixture') RETURNING id`)).lastInsertRowid);
for (let i = 1; i <= 7; i += 1) {
  await q(`INSERT INTO attendance_pattern_days (pattern_id,day_index,day_status,work_schedule_id) VALUES (?,?,?,?)`, PAT, i, i === 7 ? 'OFF' : 'WORK', i === 7 ? null : SCHED);
}
const group = async (code, entity) => Number((await q(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
  attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
  require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2019-01-01') RETURNING id`, code, code, entity)).lastInsertRowid);
const G = { KAHE360: await group('K', 'KAHE360'), MITRA: await group('M', 'MITRA'), PERFA: await group('PA', 'PERFA'), PERFB: await group('PB', 'PERFB') };
const today = bt.businessToday();
await q(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,period_start,period_end,
  attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status) VALUES (?,?,?,?,?,?,'2099-12-31','2099-12-31','2099-12-31','2099-12-31','OPEN')`,
G.KAHE360, 2099, 1, null, bt.addDays(today, -60), bt.addDays(today, 30));

/** employee + payroll assignment(s) + A2 schedule assignment */
async function emp(id, { entity = 'KAHE360', from = '2031-03-01', to = '2031-03-31', cal = CAL, start = '2019-01-01', a2 = true, assign = true } = {}) {
  await q(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES (?,?,'internal','active',?,'PPB')`, id, `Pekerja ${id}`, start);
  if (assign) {
    await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,
      marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,'TK',0,?,?)`, id, entity, WP6, cal, G[entity], from, to);
  }
  if (a2) await q(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from,effective_to,created_by)
    VALUES (?,?,?,?,?,'fixture')`, id, entity, PAT, from, to);
}
/** a clean, present, scheduled WORK row (overridable); SQL insert as the runtime role */
async function row(e, date, o = {}) {
  const r = { clock_in: '07:00', clock_out: '16:00', clock_out_date: null, attendance_status: 'present', work_minutes: 480,
    legal_entity_id: 'KAHE360', record_status: 'EFFECTIVE', work_schedule_id: SCHED, day_status: 'WORK', day_type: 'WORKDAY',
    scheduled_minutes: 480, worked_after_shift_minutes: 0, overtime_status: 'none', schedule_source: 'pattern:weekly', ...o };
  return Number((await q(`INSERT INTO timesheet_entries (employee_id,work_date,clock_in,clock_out,clock_out_date,attendance_status,work_minutes,
    legal_entity_id,record_status,work_schedule_id,day_status,day_type,scheduled_minutes,worked_after_shift_minutes,overtime_status,schedule_source,
    current_version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'2031-04-15 00:00:00') RETURNING id`,
  e, date, r.clock_in, r.clock_out, r.clock_out_date, r.attendance_status, r.work_minutes, r.legal_entity_id, r.record_status,
  r.work_schedule_id, r.day_status, r.day_type, r.scheduled_minutes, r.worked_after_shift_minutes, r.overtime_status, r.schedule_source)).lastInsertRowid);
}
const MARCH = []; for (let d = '2031-03-01'; d <= '2031-03-31'; d = bt.addDays(d, 1)) MARCH.push(d);
const HOLIDAY = '2031-03-28';
const expectedMarch = MARCH.filter((d) => bt.isoWeekday(d) !== 7 && d !== HOLIDAY);   // 25 expected days
async function fullMonth(e, { except = [], entity = 'KAHE360', days = expectedMarch } = {}) {
  const ids = {}; for (const d of days) if (!except.includes(d)) ids[d] = await row(e, d, { legal_entity_id: entity }); return ids;
}

// ---- users ---------------------------------------------------------------------
const roleId = async (code) => (await one('SELECT id FROM roles WHERE code = ?', code)).id;
const userId = async (email) => (await one('SELECT id FROM users WHERE email = ?', email)).id;
async function makeUser(email, name, role) {
  const id = Number((await q(`INSERT INTO users (email,display_name,password_hash,is_active) VALUES (?,?,?,1) RETURNING id`, email, name, bcrypt.hashSync(PASSWORD, 4))).lastInsertRowid);
  await q('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', id, await roleId(role)); return id;
}
const grant = (uid, e) => q(`INSERT INTO user_legal_entity_scope (user_id,legal_entity_id,granted_by) VALUES (?,?,'test') ON CONFLICT DO NOTHING`, uid, e);
// a probe role holding attendance_period:VIEW but NOT attendance_readiness:VIEW
await q(`INSERT INTO roles (code,name) VALUES ('probe_role','Probe')`);
await q(`INSERT INTO role_permissions (role_id,permission_id,action) SELECT r.id,p.id,'VIEW' FROM roles r, permissions p WHERE r.code='probe_role' AND p.code='attendance_period'`);
const U = {
  director: await userId('director@kahe360.local'), wf: await userId('workforce@kahe360.local'), hrd: await userId('hrd@kahe360.local'),
  payroll: await userId('payroll@kahe360.local'), health: await userId('health@kahe360.local'), hse: await userId('hse@kahe360.local'),
  sup: await makeUser('sup.cp2@t.local', 'Supervisor CP2', 'supervisor'), probe: await makeUser('probe.cp2@t.local', 'Probe', 'probe_role'),
  mitra: await makeUser('mitra.cp2@t.local', 'Mitra WF', 'workforce_manager'),
};
for (const k of Object.keys(U)) await grant(U[k], k === 'mitra' ? 'MITRA' : 'KAHE360');
for (const e of ['MITRA', 'PERFA', 'PERFB']) await grant(U.director, e);

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    if ((url.startsWith('/api/attendance-periods') || url.startsWith('/api/attendance-closing-policies')) && r.status >= 400 && json) seenHttpErrors.push({ url, status: r.status, body: json });
    return { status: r.status, body: json, text };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b) };
}
let server; let serverOut = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl, PORT: String(PORT), NODE_ENV: 'development', KAHE_WRITE_SERIALIZATION: 'off', KAHE_DB_QUERY_STATS: '' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/login.html`)).status === 200) return; } catch { /* */ } await sleep(100); }
  throw new Error(`server did not start:\n${serverOut}`);
}
async function sqlCode(fn) { try { await fn(); return 'OK'; } catch (e) { return e.code === 'KH001' ? e.message : `SQLSTATE:${e.code}`; } }
async function ctx(h, uid, perm, extra = {}) {
  await h.query(`SELECT set_config('kahe.actor_user_id',$1,true), set_config('kahe.actor_name','x',true), set_config('kahe.actor_role','x',true),
    set_config('kahe.permission',$2,true), set_config('kahe.reason',$3,true), set_config('kahe.readiness_evaluation_id',$4,true), set_config('kahe.readiness_action',$5,true)`,
  [String(uid), perm, extra.reason || '', extra.eval ? String(extra.eval) : '', extra.action || '']);
}
const ctxOf = (uidName) => ({ id: U[uidName], displayName: uidName, roleNames: ['x'], roles: ['x'] });
const byEmp = (issues, e) => issues.filter((i) => i.employee_id === e);
const codes = (issues) => issues.map((i) => i.issue_code);
/** evaluate in a REPEATABLE READ snapshot through the library (all issues, with stats) */
async function evalPeriod(id, stats = rd.newStats()) {
  return rd.inSnapshot(db, true, async () => rd.evaluate(db, await one('SELECT * FROM attendance_periods WHERE id = ?', id), stats));
}

(async () => {
  await startServer();
  const dir = await login('director@kahe360.local'); const wf = await login('workforce@kahe360.local');
  const hrd = await login('hrd@kahe360.local'); const pay = await login('payroll@kahe360.local');
  const health = await login('health@kahe360.local'); const hse = await login('hse@kahe360.local');
  const sup = await login('sup.cp2@t.local'); const probe = await login('probe.cp2@t.local'); const mitraU = await login('mitra.cp2@t.local');

  // Closing policies: KAHE360 v1 ACTIVE from 2030-01-01 with two relaxing rules; a DRAFT v2 that must be ignored.
  const pol = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2030-01-01' })).body;
  await dir.put(`/api/attendance-closing-policies/${pol.id}/rules/PENDING_OVERTIME_APPROVAL`, { severity: 'WARNING' });
  await dir.put(`/api/attendance-closing-policies/${pol.id}/rules/ABNORMAL_DURATION`, { severity: 'INFORMATIONAL' });
  await dir.post(`/api/attendance-closing-policies/${pol.id}/activate`, {});
  const draft = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'KAHE360', effective_from: '2031-01-01' })).body;
  for (const e of ['PERFA', 'PERFB']) {
    const p = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: e, effective_from: '2030-01-01' })).body;
    await dir.post(`/api/attendance-closing-policies/${p.id}/activate`, {});
  }
  const period = async (u, entity, s, e) => (await u.post('/api/attendance-periods', { legal_entity_id: entity, start_date: s, end_date: e })).body;
  const toReview = async (u, p) => (await u.post(`/api/attendance-periods/${p.id}/transition`, { to_status: 'REVIEW', expected_status: 'OPEN' })).body;

  // ===========================================================================
  section('1. SCHEMA (migration 0007)');
  await check('exactly 1 new table, 2 FKs, 1 index, 3 row triggers + 1 no-truncate; 0 triggers added to timesheet_entries', async () => {
    const fk = await all(`SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid='attendance_readiness_evaluations'::regclass`);
    const idx = await all(`SELECT indexname FROM pg_indexes WHERE tablename='attendance_readiness_evaluations' AND indexname NOT LIKE '%_pkey'`);
    const trg = await all(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='attendance_readiness_evaluations'::regclass ORDER BY 1`);
    const ts = await all(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='timesheet_entries'::regclass ORDER BY 1`);
    eq([fk.length, idx.map((i) => i.indexname), trg.map((t) => t.tgname), ts.map((t) => t.tgname)],
      [2, ['idx_attendance_readiness_evaluations_period'], ['trg_readiness_evaluations_guard_insert', 'trg_readiness_evaluations_no_delete',
        'trg_readiness_evaluations_no_truncate', 'trg_readiness_evaluations_no_update'],
      ['trg_attendance_frozen_delete', 'trg_attendance_frozen_insert', 'trg_attendance_frozen_update']]);
    eq([[...PG_NATIVE_TABLES].length, [...PG_NATIVE_TABLES_CP2]], [5, ['attendance_readiness_evaluations']]);
  });
  await check('3 new functions exist; the 2 CP1 functions carry only the CP2 branches', async () => {
    const f = await all(`SELECT proname FROM pg_proc WHERE proname LIKE 'kahe_rdy_%' ORDER BY 1`);
    eq(f.map((x) => x.proname), ['kahe_rdy_append_only_fn', 'kahe_rdy_guard_insert_fn', 'kahe_rdy_no_truncate_fn']);
    const g = (await one(`SELECT prosrc FROM pg_proc WHERE proname='trg_attendance_periods_guard_update_fn'`)).prosrc;
    ok(g.includes('readiness_evaluation_id') && g.includes("'WITHDRAW'") && g.includes('ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED'), 'guard body');
  });

  // ===========================================================================
  section('2. RBAC (attendance_readiness)');
  await check('seeded grants equal the approved table exactly', async () => {
    const r = await all(`SELECT r.code AS role, string_agg(rp.action, ',' ORDER BY rp.action) AS a FROM role_permissions rp
      JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE p.code='attendance_readiness' GROUP BY 1 ORDER BY 1`);
    eq(r.map((x) => `${x.role}=${x.a}`), ['hrd_officer=VIEW', 'operations_director=APPROVE,VIEW', 'payroll_officer=VIEW', 'workforce_manager=APPROVE,VIEW']);
  });
  const P_RB = await period(wf, 'KAHE360', '2033-01-01', '2033-01-31');
  await check('VIEW/APPROVE matrix over 7 roles (+ a role with attendance_period:VIEW only)', async () => {
    const users = { director: dir, wf, hrd, payroll: pay, health, hse, supervisor: sup, probe };
    const allow = { V: ['director', 'wf', 'hrd', 'payroll'], A: ['director', 'wf'] };
    const probes = [['V', (u) => u.get(`/api/attendance-periods/${P_RB.id}/readiness`)], ['V', (u) => u.get(`/api/attendance-periods/${P_RB.id}/readiness/issues`)],
      ['A', (u) => u.post(`/api/attendance-periods/${P_RB.id}/ready-to-close`, {})], ['A', (u) => u.post(`/api/attendance-periods/${P_RB.id}/withdraw-ready`, {})]];
    const bad = [];
    for (const [cls, pr] of probes) for (const [n, u] of Object.entries(users)) {
      const r = await pr(u); const allowed = allow[cls].includes(n);
      if (allowed === (r.status === 403) || (!allowed && (r.body.error !== 'FORBIDDEN' || r.body.detail.module !== 'attendance_readiness'))) bad.push(`${cls} ${n} ${r.status}`);
    }
    eq(bad, []);
  });
  await check('attendance_period:VIEW alone reveals no readiness codes or counts', async () => {
    const p = await probe.get(`/api/attendance-periods/${P_RB.id}`);
    eq(p.status, 200);
    ok(!/readiness|blocker|issue_code|fingerprint/i.test(p.text), 'readiness data leaked into a CP1 response');
    eq((await probe.get(`/api/attendance-periods/${P_RB.id}/readiness`)).status, 403);
  });

  // ===========================================================================
  section('3. DAILY COVERAGE (D10 expected days, entity-correct coverage)');
  await emp('S-FULL'); await fullMonth('S-FULL');
  await emp('S-MISS'); await fullMonth('S-MISS', { except: ['2031-03-12'] });
  await emp('S-INEL', { start: '2031-03-15' }); await fullMonth('S-INEL', { days: expectedMarch.filter((d) => d >= '2031-03-15') });
  await emp('S-UNRES'); await q(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from,effective_to,created_by)
    VALUES ('S-UNRES','KAHE360',?, '2031-03-01','2031-03-31','fixture')`, PAT);   // two A2 assignments, same effective_from
  await emp('S-UNCL', { cal: CALF });
  const SYN = await period(wf, 'KAHE360', '2031-03-01', '2031-03-31');
  let R0;
  await check('a worker with 24 of 25 expected rows yields exactly ONE missing employee-day', async () => {
    R0 = await evalPeriod(SYN.id);
    eq(byEmp(R0.issues, 'S-MISS').map((i) => [i.issue_code, i.level, i.work_date]), [['MISSING_ATTENDANCE', 'EMPLOYEE_DAY', '2031-03-12']]);
  });
  await check('full coverage: no issue; Sundays and the public holiday are not expected days', async () => {
    eq(byEmp(R0.issues, 'S-FULL'), []);
  });
  await check('ineligible days (before start_date) are not expected', async () => { eq(byEmp(R0.issues, 'S-INEL'), []); });
  await check('undeterminable schedule -> UNRESOLVED_SCHEDULE per employee-day (fail-safe), never MISSING', async () => {
    const i = byEmp(R0.issues, 'S-UNRES');
    ok(i.length === 31 && i.every((x) => x.issue_code === 'UNRESOLVED_SCHEDULE' && x.detail.schedule_status === 'AMBIGUOUS_ASSIGNMENT'), JSON.stringify(i[0]));
  });
  await check('WORK day with unclassifiable day type -> UNCLASSIFIED_DAY_TYPE per employee-day, never MISSING', async () => {
    const i = byEmp(R0.issues, 'S-UNCL');
    ok(i.length === 26 && i.every((x) => x.issue_code === 'UNCLASSIFIED_DAY_TYPE' && x.level === 'EMPLOYEE_DAY'), `${i.length}`);
  });

  // ===========================================================================
  section('4. ENTITY INTEGRITY (both directions) + NULL rows + privacy');
  await emp('S-FOR'); await fullMonth('S-FOR', { except: ['2031-03-06'] });
  const FOREIGN_ROW = await row('S-FOR', '2031-03-06', { legal_entity_id: 'MITRA' });
  await emp('S-RNULL', { assign: false, a2: false }); const RNULL_ROW = await row('S-RNULL', '2031-03-10', { legal_entity_id: 'MITRA' });
  await emp('S-NULLROW'); const nr = await fullMonth('S-NULLROW');
  await q(`UPDATE timesheet_entries SET legal_entity_id = NULL WHERE id = ?`, nr['2031-03-13']);
  await emp('S-TIEDIV'); await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,
    marital_status,dependents_count,effective_date,end_date) VALUES ('S-TIEDIV','KAHE360',?,?,?,'TK',0,'2031-03-01','2031-03-31')`, WP6, CAL2, G.KAHE360);
  await emp('S-TIESAME'); await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,
    marital_status,dependents_count,effective_date,end_date) VALUES ('S-TIESAME','KAHE360',?,?,?,'K',2,'2031-03-01','2031-03-31')`, WP6, CAL, G.KAHE360);
  await fullMonth('S-TIESAME');
  const MSYN = await period(mitraU, 'MITRA', '2031-03-01', '2031-03-31');
  let RK, RM;
  await check('A-side: a foreign-entity row on an expected day -> TIMESHEET_ENTITY_CONFLICT only (no MISSING)', async () => {
    RK = await evalPeriod(SYN.id); RM = await evalPeriod(MSYN.id);
    eq(byEmp(RK.issues, 'S-FOR').map((i) => [i.issue_code, i.level, i.source_type, i.work_date, i.detail]),
      [['TIMESHEET_ENTITY_CONFLICT', 'EMPLOYEE_DAY', 'employee_day', '2031-03-06', {}]]);
  });
  await check('B-side: the stored-MITRA row attributed to KAHE360 conflicts in MITRA\'s readiness independently', async () => {
    eq(byEmp(RM.issues, 'S-FOR').map((i) => [i.issue_code, i.level, i.source_id]), [['TIMESHEET_ENTITY_CONFLICT', 'ROW', String(FOREIGN_ROW)]]);
  });
  await check('B-side: stored-entity row with R = NULL (no assignment ever) -> TIMESHEET_ENTITY_CONFLICT', async () => {
    eq(byEmp(RM.issues, 'S-RNULL').map((i) => [i.issue_code, i.source_id, i.detail]), [['TIMESHEET_ENTITY_CONFLICT', String(RNULL_ROW), {}]]);
  });
  await check('divergent-K tie -> AMBIGUOUS -> conflict on every day, no MISSING / UNCLASSIFIED', async () => {
    const i = byEmp(RK.issues, 'S-TIEDIV');
    ok(i.length === 31 && i.every((x) => x.issue_code === 'TIMESHEET_ENTITY_CONFLICT'), `${i.length} ${codes(i)}`);
  });
  await check('identical-K tie is harmless: full month, no issue', async () => { eq(byEmp(RK.issues, 'S-TIESAME'), []); });
  await check('attributable NULL row: covers its day, raises TIMESHEET_LEGAL_ENTITY_UNRESOLVED; MITRA unaffected', async () => {
    eq(byEmp(RK.issues, 'S-NULLROW').map((i) => [i.issue_code, i.source_id]), [['TIMESHEET_LEGAL_ENTITY_UNRESOLVED', String(nr['2031-03-13'])]]);
    eq(byEmp(RM.issues, 'S-NULLROW'), []);
  });
  await check('privacy: no other entity id, foreign row id or foreign value in either API response', async () => {
    const k = await dir.get(`/api/attendance-periods/${SYN.id}/readiness/issues?issue_code=TIMESHEET_ENTITY_CONFLICT&limit=200`);
    const m = await dir.get(`/api/attendance-periods/${MSYN.id}/readiness/issues?issue_code=TIMESHEET_ENTITY_CONFLICT&limit=200`);
    ok(!k.text.includes('MITRA') && !k.text.includes(`"${FOREIGN_ROW}"`), 'KAHE360 response leaks MITRA data');
    ok(!m.text.includes('KAHE360'), 'MITRA response leaks KAHE360');
    for (const it of [...k.body.items, ...m.body.items]) eq(Object.keys(it.detail), []);
  });

  // ===========================================================================
  section('5. ACCOUNTED VOID vs UNPROVEN VOID');
  let corrSeq = 0;
  async function voidFixture(e, date, brk = null) {
    const t = await row(e, date, { record_status: 'VOIDED', work_minutes: 0 });
    corrSeq += 1;
    const c = Number((await q(`INSERT INTO attendance_corrections (request_no,request_type,timesheet_entry_id,employee_id,legal_entity_id,work_date,status,reason_code,applied_to_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'DUPLICATE_RECORD', ?) RETURNING id`, `VF-${corrSeq}`, brk === 'c.request_type' ? 'CORRECTION' : 'VOID',
    brk === 'c.timesheet_entry_id' ? nr['2031-03-03'] : t, brk === 'c.employee_id' ? 'S-FULL' : e, brk === 'c.legal_entity_id' ? 'MITRA' : 'KAHE360',
    brk === 'c.work_date' ? '2031-03-05' : date, brk === 'c.status' ? 'VOID_REJECTED' : 'VOIDED', brk === 'c.applied_to_source' ? 0 : 1)).lastInsertRowid);
    await q(`INSERT INTO attendance_entry_versions (timesheet_entry_id,employee_id,work_date,legal_entity_id,version_no,version_type,correction_id,payload,applied_to_source,is_effective)
      VALUES (?,?,?,?,1,'ORIGINAL',NULL,'{}',1,0)`, t, e, date, 'KAHE360');
    if (brk !== 'version.missing') {
      await q(`INSERT INTO attendance_entry_versions (timesheet_entry_id,employee_id,work_date,legal_entity_id,version_no,version_type,correction_id,payload,applied_to_source,is_effective)
        VALUES (?,?,?,?,?,?,?,'{}',?,1)`, t, e, date, 'KAHE360', brk === 'v.version_no' ? 3 : 2, brk === 'v.version_type' ? 'CORRECTION' : 'VOID',
      brk === 'v.correction_id' ? null : c, brk === 'v.applied_to_source' ? 0 : 1);
    }
    await q(`UPDATE timesheet_entries SET void_correction_id = ?, last_correction_id = ?, current_version = 2 WHERE id = ?`,
      brk === 'row.void_correction_id' ? null : brk === 'row.void_correction_dangling' ? 999999 : c, brk === 'row.last_correction_id' ? null : c, t);
    return t;
  }
  await emp('S-VACC'); await fullMonth('S-VACC', { except: ['2031-03-04'] });
  const VACC = await voidFixture('S-VACC', '2031-03-04');
  const BREAKS = ['row.void_correction_id', 'row.void_correction_dangling', 'row.last_correction_id', 'c.request_type', 'c.status', 'c.applied_to_source',
    'c.timesheet_entry_id', 'c.employee_id', 'c.work_date', 'c.legal_entity_id', 'version.missing', 'v.correction_id', 'v.version_type', 'v.version_no', 'v.applied_to_source'];
  const VB = {};
  for (let n = 0; n < BREAKS.length; n += 1) { const e = `S-VB${n}`; await emp(e); await fullMonth(e, { except: ['2031-03-04'] }); VB[e] = await voidFixture(e, '2031-03-04', BREAKS[n]); }
  let RV;
  await check('accounted void (full provenance) covers its day: no MISSING, no VOID_UNPROVEN', async () => {
    RV = await evalPeriod(SYN.id); eq(byEmp(RV.issues, 'S-VACC'), []);
  });
  await check(`each of the ${BREAKS.length} broken provenance variants -> TIMESHEET_VOID_UNPROVEN only (never also MISSING)`, async () => {
    const bad = [];
    for (let n = 0; n < BREAKS.length; n += 1) {
      const got = byEmp(RV.issues, `S-VB${n}`).map((i) => [i.issue_code, i.source_id]);
      if (JSON.stringify(got) !== JSON.stringify([['TIMESHEET_VOID_UNPROVEN', String(VB[`S-VB${n}`])]])) bad.push(`${BREAKS[n]}: ${JSON.stringify(got)}`);
    }
    eq(bad, []);
  });

  // ===========================================================================
  section('6. ROW-LEVEL CHECKS + D5 EXCEPTION RULES');
  await emp('S-ROW'); const sr = await fullMonth('S-ROW');
  await q(`UPDATE timesheet_entries SET overtime_status = 'pending' WHERE id = ?`, sr['2031-03-03']);
  await q(`UPDATE timesheet_entries SET day_status = NULL WHERE id = ?`, sr['2031-03-04']);
  await q(`UPDATE timesheet_entries SET day_type = NULL WHERE id = ?`, sr['2031-03-05']);
  const OFFROW = await row('S-ROW', '2031-03-09', { day_status: 'OFF', work_schedule_id: null, attendance_status: 'leave', day_type: 'WEEKLY_REST_DAY', work_minutes: 0 });
  await emp('S-MCO'); const mco = await fullMonth('S-MCO'); await q(`UPDATE timesheet_entries SET clock_out = NULL WHERE id = ?`, mco['2031-03-03']);
  await emp('S-STALE'); const st = await fullMonth('S-STALE');
  await q(`INSERT INTO attendance_exceptions (timesheet_entry_id,employee_id,legal_entity_id,work_date,exception_type,status) VALUES (?, 'S-STALE','KAHE360','2031-03-03','MISSING_CLOCK_OUT','OPEN')`, st['2031-03-03']);
  await q(`INSERT INTO attendance_exceptions (timesheet_entry_id,employee_id,legal_entity_id,work_date,exception_type,status) VALUES (?, 'S-VACC','KAHE360','2031-03-04','MISSING_CLOCK_IN','OPEN')`, VACC);
  await emp('S-SUP'); const su = await fullMonth('S-SUP');
  for (const d of ['2031-03-03', '2031-03-04']) await q(`UPDATE timesheet_entries SET clock_out = NULL WHERE id = ?`, su[d]);
  await q(`INSERT INTO attendance_exceptions (timesheet_entry_id,employee_id,legal_entity_id,work_date,exception_type,status,resolved_at)
    VALUES (?, 'S-SUP','KAHE360','2031-03-03','MISSING_CLOCK_OUT','RESOLVED','2031-04-15 00:00:01')`, su['2031-03-03']);
  await q(`INSERT INTO attendance_exceptions (timesheet_entry_id,employee_id,legal_entity_id,work_date,exception_type,status,resolved_at)
    VALUES (?, 'S-SUP','KAHE360','2031-03-04','MISSING_CLOCK_OUT','RESOLVED','2031-04-15 00:00:00')`, su['2031-03-04']);   // same second
  let RR;
  await check('row-level: pending OT (policy WARNING), NULL day_status and NULL day_type flagged; OFF-day row not flagged', async () => {
    RR = await evalPeriod(SYN.id);
    const i = byEmp(RR.issues, 'S-ROW');
    eq(i.map((x) => [x.issue_code, x.source_id, x.severity, x.rule_source]).sort(), [
      ['PENDING_OVERTIME_APPROVAL', String(sr['2031-03-03']), 'WARNING', 'POLICY'], ['UNCLASSIFIED_DAY_TYPE', String(sr['2031-03-05']), 'BLOCKER', 'DEFAULT'],
      ['UNRESOLVED_SCHEDULE', String(sr['2031-03-04']), 'BLOCKER', 'DEFAULT']].sort());
    ok(!i.some((x) => x.source_id === String(OFFROW)), 'OFF day flagged');
  });
  await check('never-scanned current condition blocks (MISSING_CLOCK_OUT with no exception row)', async () => {
    eq(byEmp(RR.issues, 'S-MCO').map((x) => [x.issue_code, x.reference_exception_id]), [['MISSING_CLOCK_OUT', null]]);
  });
  await check('stale open exception (row now complete) and open exception on a voided row do not block', async () => {
    eq([byEmp(RR.issues, 'S-STALE'), byEmp(RR.issues, 'S-VACC')], [[], []]);
  });
  await check('RESOLVED suppresses only when resolved_at > row.updated_at (same second does not)', async () => {
    eq(byEmp(RR.issues, 'S-SUP').map((x) => x.source_id), [String(su['2031-03-04'])]);
  });
  await check('a later row change lifts the suppression', async () => {
    await q(`UPDATE timesheet_entries SET note = 'changed', updated_at = '2031-04-16 00:00:00' WHERE id = ?`, su['2031-03-03']);
    const r = await evalPeriod(SYN.id);
    eq(byEmp(r.issues, 'S-SUP').map((x) => x.source_id).sort(), [String(su['2031-03-03']), String(su['2031-03-04'])].sort());
  });
  await emp('S-CORR'); await fullMonth('S-CORR');
  const corr = async (date, status) => Number((await q(`INSERT INTO attendance_corrections (request_type,employee_id,legal_entity_id,work_date,status,reason_code)
    VALUES ('CORRECTION','S-CORR','KAHE360',?,?,'OTHER') RETURNING id`, date, status)).lastInsertRowid);
  const cSub = await corr('2031-03-05', 'SUBMITTED'); await corr('2031-03-06', 'DRAFT'); const cQ = await corr('2031-03-07', 'QUEUED_FOR_PAYROLL');
  const cPpr = await corr('2031-03-08', 'PENDING_PAYROLL_REVIEW'); const cApp = await corr('2031-03-10', 'APPLIED');
  const exc = async (type, date, cid) => Number((await q(`INSERT INTO attendance_exceptions (employee_id,legal_entity_id,work_date,exception_type,status,correction_id)
    VALUES ('S-CORR','KAHE360',?,?,'OPEN',?) RETURNING id`, date, type, cid)).lastInsertRowid);
  const eLateSub = await exc('LATE_CORRECTION', '2031-03-05', cSub); await exc('LATE_CORRECTION', '2031-03-10', cApp);
  await exc('PAYROLL_ADJUSTMENT_REQUIRED', '2031-03-07', cQ); const ePpr = await exc('PAYROLL_ADJUSTMENT_REQUIRED', '2031-03-08', cPpr);
  const eNull = await exc('PAYROLL_ADJUSTMENT_REQUIRED', '2031-03-11', null);
  await check('corrections: SUBMITTED and PENDING_PAYROLL_REVIEW block; DRAFT and QUEUED_FOR_PAYROLL do not', async () => {
    const r = await evalPeriod(SYN.id);
    const req = byEmp(r.issues, 'S-CORR').filter((i) => i.level === 'REQUEST').map((i) => [i.issue_code, i.source_id]);
    eq(req.sort(), [['PENDING_ATTENDANCE_CORRECTION', String(cSub)], ['PENDING_PAYROLL_REVIEW', String(cPpr)]].sort());
    const ex = byEmp(r.issues, 'S-CORR').filter((i) => i.level === 'EXCEPTION').map((i) => [i.issue_code, i.source_id]);
    eq(ex.sort(), [['LATE_CORRECTION', String(eLateSub)], ['PAYROLL_ADJUSTMENT_REQUIRED', String(ePpr)], ['PAYROLL_ADJUSTMENT_REQUIRED', String(eNull)]].sort());
  });

  // ===========================================================================
  section('7. DUPLICATE_ATTENDANCE — the unmodified A3 overlap semantics');
  await emp('S-DUP'); const du = await fullMonth('S-DUP');
  await q(`UPDATE timesheet_entries SET clock_in='22:00', clock_out='08:00', clock_out_date='2031-03-11' WHERE id = ?`, du['2031-03-10']);
  await emp('S-DUPV'); const dv = await fullMonth('S-DUPV');
  await q(`UPDATE timesheet_entries SET clock_in='22:00', clock_out='08:00', clock_out_date='2031-03-11' WHERE id = ?`, dv['2031-03-10']);
  await q(`UPDATE timesheet_entries SET record_status='VOIDED' WHERE id = ?`, dv['2031-03-11']);   // voided next-day row still participates (A3)
  await emp('S-DUPF'); await fullMonth('S-DUPF');
  await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
    VALUES ('S-DUPF','MITRA',?,?,?,'TK',0,'2031-04-01','2031-04-30')`, WP6, CAL, G.MITRA);
  const dfLast = (await one(`SELECT id FROM timesheet_entries WHERE employee_id='S-DUPF' AND work_date='2031-03-31'`)).id;
  await q(`UPDATE timesheet_entries SET clock_in='22:00', clock_out='08:00', clock_out_date='2031-04-01' WHERE id = ?`, dfLast);
  const dfNext = await row('S-DUPF', '2031-04-01', { legal_entity_id: 'MITRA' });
  let RD;
  await check('cross-midnight overlap -> DUPLICATE_ATTENDANCE; a VOIDED next-day row participates exactly as in A3', async () => {
    RD = await evalPeriod(SYN.id);
    eq(byEmp(RD.issues, 'S-DUP').map((i) => [i.issue_code, i.source_id, i.detail.overlaps_entry_id]), [['DUPLICATE_ATTENDANCE', String(du['2031-03-10']), du['2031-03-11']]]);
    eq(byEmp(RD.issues, 'S-DUPV').filter((i) => i.issue_code === 'DUPLICATE_ATTENDANCE').map((i) => i.source_id), [String(dv['2031-03-10'])]);
  });
  await check('overlap with a foreign-entity row: finding kept, identity redacted', async () => {
    const i = byEmp(RD.issues, 'S-DUPF');
    eq(i.map((x) => [x.issue_code, x.detail.overlaps_entry_id, x.detail.overlaps_entry_in_scope]), [['DUPLICATE_ATTENDANCE', undefined, false]]);
    ok(!JSON.stringify(i).includes(String(dfNext)), 'foreign row id leaked');
  });
  await check('optimized call pattern == direct findOverlap for EVERY KAHE360 row (incl. NULL/same/next date, voided)', async () => {
    const rows = await all(`SELECT * FROM timesheet_entries WHERE work_date BETWEEN '2031-03-01' AND '2031-03-31' ORDER BY id`);
    const bad = []; let calls = 0;
    for (const r of rows) {
      const direct = await exceptionLib.findOverlap(db, r);
      let opt = null; if (r.clock_out_date && r.clock_out_date !== r.work_date) { calls += 1; opt = await exceptionLib.findOverlap(db, r); }
      if (direct !== opt) bad.push(r.id);
    }
    eq(bad, []); ok(calls === 3, `cross-midnight candidates ${calls}`);
  });
  await check('findOverlap calls == covered non-voided cross-midnight candidates', async () => {
    const s = rd.newStats(); await evalPeriod(SYN.id, s);
    const n = (await one(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE legal_entity_id='KAHE360' AND work_date BETWEEN '2031-03-01' AND '2031-03-31'
      AND COALESCE(record_status,'EFFECTIVE') <> 'VOIDED' AND clock_out_date IS NOT NULL AND clock_out_date <> work_date`)).n;
    eq([s.find_overlap_calls, s.cross_midnight_candidates, s.attribution_queries], [n, n, 1]);
  });

  // ===========================================================================
  section('8. POLICY RESOLUTION');
  await check('policy as-of end_date: ACTIVE v1 used, DRAFT v2 ignored; fixed codes are FIXED, missing rule is DEFAULT BLOCKER', async () => {
    eq([RD.policy.policy_id, RD.policy.version_no, RD.policy.as_of_date], [pol.id, 1, '2031-03-31']);
    ok(draft.status === 'DRAFT', 'draft');
    ok(RD.issues.filter((i) => rd.FIXED_CODES.includes(i.issue_code)).every((i) => i.rule_source === 'FIXED' && i.severity === 'BLOCKER' && i.waivable === 0));
    ok(RD.issues.filter((i) => i.issue_code === 'MISSING_ATTENDANCE').every((i) => i.rule_source === 'DEFAULT' && i.severity === 'BLOCKER' && i.waivable === 0));
  });
  await check('no ACTIVE/ENDED version covering end_date -> NO_CLOSING_POLICY (MITRA, and KAHE360 before 2030)', async () => {
    ok(RM.issues.some((i) => i.issue_code === 'NO_CLOSING_POLICY' && i.level === 'PERIOD') && RM.policy === null);
    const old = await period(wf, 'KAHE360', '2029-06-01', '2029-06-30');
    const r = await evalPeriod(old.id); ok(r.issues.some((i) => i.issue_code === 'NO_CLOSING_POLICY'));
  });
  await check('determinism: same state -> identical fingerprint and issue list', async () => {
    const a = await evalPeriod(SYN.id); const b = await evalPeriod(SYN.id);
    eq([a.fingerprint, JSON.stringify(a.issues)], [b.fingerprint, JSON.stringify(b.issues)]);
    ok(/^[0-9a-f]{64}$/.test(a.fingerprint));
  });

  // ===========================================================================
  section('9. READY_TO_CLOSE GATE, STALENESS, WITHDRAWAL');
  await emp('C-1', { from: '2031-05-01', to: '2031-05-31' });
  const MAY = []; for (let d = '2031-05-01'; d <= '2031-05-31'; d = bt.addDays(d, 1)) if (bt.isoWeekday(d) !== 7) MAY.push(d);
  const cRows = {}; for (const d of MAY) cRows[d] = await row('C-1', d);
  await q(`UPDATE timesheet_entries SET overtime_status='pending' WHERE id = ?`, cRows['2031-05-05']);   // WARNING only
  const CLEAN = await period(wf, 'KAHE360', '2031-05-01', '2031-05-31');
  let pv;
  await check('clean period: ready=true with a WARNING present; preview works in OPEN', async () => {
    pv = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body;
    eq([pv.ready, pv.summary, pv.period_status, pv.readiness_record, pv.stale], [true, { blockers: 0, warnings: 1, informational: 0 }, 'OPEN', null, null]);
  });
  await check('ready-to-close requires REVIEW; client-supplied counts/policy/actor fields are rejected (400)', async () => {
    const a = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: pv.fingerprint });
    eq([a.status, a.body.error, a.body.detail.current_status], [409, 'ATTENDANCE_PERIOD_STATE_CHANGED', 'OPEN']);
    const b = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: pv.fingerprint,
      blocker_count: 0, warning_count: 0, summary: {}, policy_id: 1, policy_version_no: 1, actor_user_id: 1, txid: 1 });
    eq([b.status, b.body.error, b.body.detail.fields], [400, 'REQUEST_FIELD_NOT_ALLOWED', ['actor_user_id', 'blocker_count', 'policy_id', 'policy_version_no', 'summary', 'txid', 'warning_count']]);
    eq((await one('SELECT COUNT(*) AS n FROM attendance_readiness_evaluations')).n, 0);
  });
  let EV1;
  await check('stale fingerprint -> ATTENDANCE_READINESS_CHANGED; correct fingerprint -> READY_TO_CLOSE with bound evaluation', async () => {
    await toReview(wf, CLEAN);
    const f = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body.fingerprint;
    const bad = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: '0'.repeat(64) });
    eq([bad.status, bad.body.error, bad.body.detail.current_fingerprint], [409, 'ATTENDANCE_READINESS_CHANGED', f]);
    const r = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f });
    eq([r.status, r.body.period.status, r.body.period.last_transition_permission, r.body.evaluation.fingerprint], [200, 'READY_TO_CLOSE', 'attendance_readiness:APPROVE', f]);
    EV1 = r.body.evaluation.evaluation_id;
    const ev = await one(`SELECT * FROM attendance_readiness_evaluations WHERE id = ?`, EV1);
    eq([ev.period_id, ev.policy_id, ev.policy_version_no, ev.policy_as_of_date, ev.blocker_count, ev.warning_count, ev.actor_user_id, ev.permission],
      [CLEAN.id, pol.id, 1, '2031-05-31', 0, 1, U.wf, 'attendance_readiness:APPROVE']);
    const te = await one(`SELECT * FROM attendance_period_events WHERE period_id = ? AND event_type='TRANSITION' ORDER BY id DESC LIMIT 1`, CLEAN.id);
    eq([te.from_status, te.to_status, te.new_values.readiness_evaluation_id], ['REVIEW', 'READY_TO_CLOSE', EV1]);
  });
  await check('READY_TO_CLOSE preview: readiness_record from the latest transition event, stale=false', async () => {
    const r = (await hrd.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body;
    eq([r.period_status, r.readiness_record.evaluation_id, r.stale, r.ready], ['READY_TO_CLOSE', EV1, false, true]);
  });
  let corrC;
  await check('a later correction makes readiness stale and not ready; the period is NOT auto-demoted', async () => {
    corrC = Number((await q(`INSERT INTO attendance_corrections (request_type,employee_id,legal_entity_id,work_date,status,reason_code)
      VALUES ('CORRECTION','C-1','KAHE360','2031-05-06','SUBMITTED','OTHER') RETURNING id`)).lastInsertRowid);
    const r = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body;
    eq([r.ready, r.stale, r.summary.blockers, r.period_status], [false, true, 1, 'READY_TO_CLOSE']);
    eq((await one('SELECT status FROM attendance_periods WHERE id = ?', CLEAN.id)).status, 'READY_TO_CLOSE');
  });
  await check('withdrawal: CP1 generic path NOT_ENABLED; reason mandatory; APPROVE with reason -> REVIEW + audit', async () => {
    const g = await wf.post(`/api/attendance-periods/${CLEAN.id}/transition`, { to_status: 'REVIEW', expected_status: 'READY_TO_CLOSE', reason: 'x' });
    eq([g.status, g.body.error], [409, 'ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED']);
    const n = await wf.post(`/api/attendance-periods/${CLEAN.id}/withdraw-ready`, { expected_status: 'READY_TO_CLOSE' });
    eq([n.status, n.body.error], [400, 'ATTENDANCE_PERIOD_REASON_REQUIRED']);
    const w = await dir.post(`/api/attendance-periods/${CLEAN.id}/withdraw-ready`, { expected_status: 'READY_TO_CLOSE', reason: 'Koreksi masuk' });
    eq([w.status, w.body.status, w.body.last_transition_by_user_id, w.body.last_transition_reason], [200, 'REVIEW', U.director, 'Koreksi masuk']);
    const te = await one(`SELECT * FROM attendance_period_events WHERE period_id = ? ORDER BY id DESC LIMIT 1`, CLEAN.id);
    eq([te.event_type, te.from_status, te.to_status, te.reason, te.permission], ['TRANSITION', 'READY_TO_CLOSE', 'REVIEW', 'Koreksi masuk', 'attendance_readiness:APPROVE']);
  });
  await check('NOT_READY carries summary + blocking codes; nothing persisted', async () => {
    const f = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body.fingerprint;
    const r = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f });
    eq([r.status, r.body.error, r.body.detail.blocking_codes, r.body.detail.summary.blockers], [409, 'ATTENDANCE_READINESS_NOT_READY', ['PENDING_ATTENDANCE_CORRECTION'], 1]);
    eq((await one('SELECT COUNT(*) AS n FROM attendance_readiness_evaluations WHERE period_id = ?', CLEAN.id)).n, 1);
  });
  await check('second ready -> withdraw -> ready cycle binds the SECOND evaluation', async () => {
    await q(`UPDATE attendance_corrections SET status = 'CANCELLED' WHERE id = ?`, corrC);
    const f = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body.fingerprint;
    const r2 = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f });
    const ev2 = r2.body.evaluation.evaluation_id; ok(ev2 !== EV1, 'new evaluation');
    await wf.post(`/api/attendance-periods/${CLEAN.id}/withdraw-ready`, { expected_status: 'READY_TO_CLOSE', reason: 'siklus 2' });
    const f3 = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body.fingerprint;
    const r3 = await wf.post(`/api/attendance-periods/${CLEAN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f3 });
    const pr = (await wf.get(`/api/attendance-periods/${CLEAN.id}/readiness`)).body;
    eq([pr.readiness_record.evaluation_id, pr.stale], [r3.body.evaluation.evaluation_id, false]);
    ok(r3.body.evaluation.evaluation_id > ev2 && (await one('SELECT MAX(id) AS m FROM attendance_readiness_evaluations')).m === pr.readiness_record.evaluation_id);
  });
  await check('parallel ready-to-close on one period: exactly one wins', async () => {
    await emp('C-2', { from: '2031-06-01', to: '2031-06-30' });
    for (let d = '2031-06-01'; d <= '2031-06-30'; d = bt.addDays(d, 1)) if (bt.isoWeekday(d) !== 7) await row('C-2', d);
    const JUN = await period(wf, 'KAHE360', '2031-06-01', '2031-06-30'); await toReview(wf, JUN);
    const f = (await wf.get(`/api/attendance-periods/${JUN.id}/readiness`)).body.fingerprint;
    const rs = await Promise.all([wf.post(`/api/attendance-periods/${JUN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f }),
      dir.post(`/api/attendance-periods/${JUN.id}/ready-to-close`, { expected_status: 'REVIEW', expected_fingerprint: f })]);
    eq(rs.filter((r) => r.status === 200).length, 1);
    const loser = rs.find((r) => r.status !== 200);
    ok(['ATTENDANCE_PERIOD_STATE_CHANGED', 'DB_CONCURRENCY_RETRY'].includes(loser.body.error), JSON.stringify(loser.body));
    eq((await one('SELECT COUNT(*) AS n FROM attendance_readiness_evaluations WHERE period_id = ?', JUN.id)).n, 1);
  });
  await check('database: evidence-less READY_TO_CLOSE stays NOT_ENABLED; forged/foreign evidence -> EVIDENCE_INVALID', async () => {
    const JUL = await period(wf, 'KAHE360', '2031-07-01', '2031-07-31'); await toReview(wf, JUL);
    const a = await sqlCode(() => withTransaction(db, async () => { await ctx(db, U.wf, 'attendance_readiness:APPROVE'); await q(`UPDATE attendance_periods SET status='READY_TO_CLOSE' WHERE id = ?`, JUL.id); }));
    const b = await sqlCode(() => withTransaction(db, async () => { await ctx(db, U.wf, 'attendance_readiness:APPROVE', { eval: EV1 }); await q(`UPDATE attendance_periods SET status='READY_TO_CLOSE' WHERE id = ?`, JUL.id); }));
    const c = await sqlCode(() => withTransaction(db, async () => { await ctx(db, U.wf, 'attendance_readiness:APPROVE', { action: 'WITHDRAW', reason: 'x' }); await q(`UPDATE attendance_periods SET status='READY_TO_CLOSE' WHERE id = ?`, JUL.id); }));
    eq([a, b, c], ['ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED', 'ATTENDANCE_READINESS_EVIDENCE_INVALID', 'ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED']);
  });
  await check('evaluation insert guard: entity / policy entity / version / as-of / coverage / period state verified; blocker_count>0 refused', async () => {
    const JUL = await one(`SELECT * FROM attendance_periods WHERE start_date='2031-07-01' AND legal_entity_id='KAHE360'`);
    const mPol = (await dir.post('/api/attendance-closing-policies', { legal_entity_id: 'MITRA', effective_from: '2030-01-01' })).body;
    const ins = (o) => sqlCode(() => withTransaction(db, async () => {
      await ctx(db, U.wf, 'attendance_readiness:APPROVE');
      const v = { period_id: JUL.id, entity: 'KAHE360', policy: pol.id, ver: 1, asof: '2031-07-31', blockers: 0, ...o };
      await q(`INSERT INTO attendance_readiness_evaluations (period_id,legal_entity_id,policy_id,policy_version_no,policy_as_of_date,blocker_count,
        warning_count,informational_count,summary,fingerprint,engine_version,evaluated_at,actor_user_id,actor_name,actor_role,permission,txid)
        VALUES (?,?,?,?,?,?,0,0,'{}',?, 'x', kahe_now(), 1,'x','x','x',1)`, v.period_id, v.entity, v.policy, v.ver, v.asof, v.blockers, 'a'.repeat(64));
    }));
    const got = [];
    for (const o of [{ entity: 'MITRA' }, { policy: mPol.id }, { ver: 2 }, { asof: '2031-07-30' }, { policy: draft.id, ver: 2 }, { period_id: CLEAN.id }]) {
      await ins(o); got.push(o);
    }
    const reasons = [];
    for (const o of [{ entity: 'MITRA' }, { policy: mPol.id }, { ver: 2 }, { asof: '2031-07-30' }, { policy: draft.id, ver: 2 }, { period_id: CLEAN.id }]) {
      try { await withTransaction(db, async () => { await ctx(db, U.wf, 'attendance_readiness:APPROVE');
        const v = { period_id: JUL.id, entity: 'KAHE360', policy: pol.id, ver: 1, asof: '2031-07-31', ...o };
        await q(`INSERT INTO attendance_readiness_evaluations (period_id,legal_entity_id,policy_id,policy_version_no,policy_as_of_date,blocker_count,
          warning_count,informational_count,summary,fingerprint,engine_version,evaluated_at,actor_user_id,actor_name,actor_role,permission,txid)
          VALUES (?,?,?,?,?,0,0,0,'{}',?, 'x', kahe_now(), 1,'x','x','x',1)`, v.period_id, v.entity, v.policy, v.ver, v.asof, 'a'.repeat(64)); });
        reasons.push('OK');
      } catch (e) { reasons.push(e.code === 'KH001' ? JSON.parse(e.detail).reason : e.code); }
    }
    eq(reasons, ['ENTITY_MISMATCH', 'POLICY_ENTITY_MISMATCH', 'POLICY_VERSION_MISMATCH', 'AS_OF_MISMATCH', 'POLICY_NOT_COVERING', 'PERIOD_NOT_IN_REVIEW']);
    eq(await ins({ blockers: 1 }), 'SQLSTATE:23514');
    ok(got.length === 6);
  });
  await check('evaluations are append-only (UPDATE/DELETE refused; runtime cannot TRUNCATE)', async () => {
    eq([await sqlCode(() => q(`UPDATE attendance_readiness_evaluations SET warning_count = 9 WHERE id = ?`, EV1)),
      await sqlCode(() => q(`DELETE FROM attendance_readiness_evaluations WHERE id = ?`, EV1)),
      await sqlCode(() => db.exec('TRUNCATE attendance_readiness_evaluations'))], ['A4_AUDIT_APPEND_ONLY', 'A4_AUDIT_APPEND_ONLY', 'SQLSTATE:42501']);
  });
  await check('malformed readiness linkage -> ATTENDANCE_READINESS_RECORD_INVALID (fail-safe, never stale=false)', async () => {
    const JUN = await one(`SELECT * FROM attendance_periods WHERE start_date='2031-06-01' AND legal_entity_id='KAHE360'`);
    const o = __t.openOwner(1);
    await withTransaction(o, async () => {
      await o.exec('ALTER TABLE attendance_period_events DISABLE TRIGGER trg_attendance_period_events_no_update');
      await o.query(`UPDATE attendance_period_events SET new_values = new_values - 'readiness_evaluation_id'
        WHERE id = (SELECT max(id) FROM attendance_period_events WHERE period_id = $1)`, [JUN.id]);
      await o.exec('ALTER TABLE attendance_period_events ENABLE TRIGGER trg_attendance_period_events_no_update');
    });
    await o.close();
    const r = await wf.get(`/api/attendance-periods/${JUN.id}/readiness`);
    eq([r.status, r.body.error, r.body.detail.reason], [500, 'ATTENDANCE_READINESS_RECORD_INVALID', 'EVALUATION_REFERENCE_MISSING']);
  });

  // ===========================================================================
  section('10. LIVE A1/A3 WORKFLOW (real void, real stale exception)');
  const LIVE_FROM = bt.addDays(today, -9); const LIVE_TO = bt.addDays(today, -1);
  await emp('L-1', { from: bt.addDays(today, -40), to: bt.addDays(today, 20) });
  const polA3 = await wf.post('/api/attendance-correction/policies', { code: 'CORR-CP2', name: 'CP2', legal_entity_id: 'KAHE360', correction_window: 14,
    window_unit: 'DAYS', allow_late_correction: true, late_requires_approval: true, evidence_requirement: 'OPTIONAL', post_finalized_evidence_required: true,
    abnormal_duration_ratio_pct: 150, ot_grace_minutes: 30, ot_mismatch_tolerance_minutes: 15, effective_from: '2019-01-01' });
  const workdays = []; for (let d = LIVE_TO; d >= LIVE_FROM; d = bt.addDays(d, -1)) if (bt.isoWeekday(d) !== 7) workdays.push(d);
  await check('a void through the real A3 workflow is ACCOUNTED (no VOID_UNPROVEN, no MISSING for that day)', async () => {
    eq(polA3.status, 201);
    const c = await wf.post('/api/timesheet/entries', { employee_id: 'L-1', work_date: workdays[0], clock_in: '07:00', clock_out: '16:00' });
    eq(c.status, 201);
    const v = await sup.post('/api/attendance-correction/requests', { timesheet_entry_id: c.body.id, request_type: 'VOID', reason_code: 'DUPLICATE_RECORD', reason_text: 'dobel' });
    await wf.post(`/api/attendance-correction/requests/${v.body.id}/review`, {});
    const d = await dir.post(`/api/attendance-correction/requests/${v.body.id}/decide`, { decision: 'approved' });
    eq([d.status, d.body.status], [200, 'VOIDED']);
    const LIVE = await period(wf, 'KAHE360', LIVE_FROM, LIVE_TO);
    const r = await evalPeriod(LIVE.id);
    ok(!r.issues.some((i) => i.issue_code === 'TIMESHEET_VOID_UNPROVEN'), 'real void reported unproven');
    ok(!r.issues.some((i) => i.employee_id === 'L-1' && i.work_date === workdays[0]), JSON.stringify(byEmp(r.issues, 'L-1').filter((i) => i.work_date === workdays[0])));
  });
  await check('real stale exception: scanned MISSING_CLOCK_OUT then corrected via A3 -> exception still OPEN, readiness does not block', async () => {
    const c = await wf.post('/api/timesheet/entries', { employee_id: 'L-1', work_date: workdays[1], clock_in: '07:00' });
    eq(c.status, 201);
    await wf.post('/api/attendance-correction/exceptions/scan', { from: workdays[1], to: workdays[1] });
    const ex = await one(`SELECT id, status FROM attendance_exceptions WHERE timesheet_entry_id = ? AND exception_type='MISSING_CLOCK_OUT'`, c.body.id);
    ok(ex && ex.status === 'OPEN', 'exception not created by scan');
    const req = await sup.post('/api/attendance-correction/requests', { timesheet_entry_id: c.body.id, reason_code: 'MISSED_CLOCK_OUT', proposed_values: { clock_out: '16:00' } });
    await wf.post(`/api/attendance-correction/requests/${req.body.id}/review`, {});
    const d = await wf.post(`/api/attendance-correction/requests/${req.body.id}/decide`, { decision: 'approved' });
    eq(d.body.status, 'APPLIED');
    eq((await one('SELECT status FROM attendance_exceptions WHERE id = ?', ex.id)).status, 'OPEN');
    const LIVE = await one(`SELECT * FROM attendance_periods WHERE start_date = ? AND legal_entity_id='KAHE360'`, LIVE_FROM);
    const r = await evalPeriod(LIVE.id);
    ok(!r.issues.some((i) => i.source_id === String(c.body.id) && i.issue_code === 'MISSING_CLOCK_OUT'), 'stale exception blocked');
  });
  await check('DUPLICATE findings == A3 /exceptions/scan findings on the same fixtures', async () => {
    await wf.post('/api/attendance-correction/exceptions/scan', { from: '2031-03-01', to: '2031-03-31' });
    const a3 = (await all(`SELECT DISTINCT x.timesheet_entry_id AS id FROM attendance_exceptions x JOIN timesheet_entries t ON t.id = x.timesheet_entry_id
      WHERE x.exception_type='DUPLICATE_ATTENDANCE' AND t.legal_entity_id='KAHE360' AND x.work_date BETWEEN '2031-03-01' AND '2031-03-31' ORDER BY 1`)).map((r) => String(r.id));
    const r = await evalPeriod(SYN.id);
    const cp2 = r.issues.filter((i) => i.issue_code === 'DUPLICATE_ATTENDANCE').map((i) => i.source_id).sort((a, b) => a - b);
    eq(cp2, a3);
  });

  // ===========================================================================
  section('11. BATCH ATTRIBUTION EQUIVALENCE (vs frozen resolvers)');
  const eqEmp = async (id, hist) => {
    await q(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES (?,?,'internal','active','2019-01-01','PPB')`, id, id);
    for (const h of hist) await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,
      marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,'TK',0,?,?)`, id, h.e, WP6, h.cal === undefined ? CAL : h.cal, G[h.e], h.from, h.to === undefined ? null : h.to);
  };
  const MATRIX = [
    ['EQ-ONE', [{ e: 'KAHE360', from: '2030-01-01' }]],
    ['EQ-NONE', []],
    ['EQ-HIST', [{ e: 'KAHE360', from: '2029-01-01', to: '2029-12-31' }, { e: 'MITRA', from: '2030-01-01', to: '2030-06-30' }, { e: 'KAHE360', from: '2030-07-01' }]],
    ['EQ-GAP', [{ e: 'MITRA', from: '2029-01-01', to: '2029-03-31' }, { e: 'KAHE360', from: '2029-06-01', to: '2029-12-31' }]],
    ['EQ-OVL', [{ e: 'KAHE360', from: '2029-01-01', to: '2029-12-31' }, { e: 'MITRA', from: '2029-06-01', to: '2029-09-30' }]],
    ['EQ-MID', [{ e: 'KAHE360', from: '2031-01-01', to: '2031-03-15' }, { e: 'MITRA', from: '2031-03-16' }]],
    ['EQ-TSAME', [{ e: 'KAHE360', from: '2030-01-01', to: '2030-12-31' }, { e: 'KAHE360', from: '2030-01-01', to: '2030-06-30' }]],
    ['EQ-TDIVC', [{ e: 'KAHE360', from: '2030-01-01', to: '2030-12-31' }, { e: 'KAHE360', from: '2030-01-01', to: '2030-12-31', cal: CAL2 }]],
    ['EQ-TDIVE', [{ e: 'KAHE360', from: '2030-01-01', to: '2030-12-31' }, { e: 'MITRA', from: '2030-01-01', to: '2030-12-31' }]],
    ['EQ-FBTIE', [{ e: 'KAHE360', from: '2030-01-01', to: '2030-01-31' }, { e: 'MITRA', from: '2030-01-01', to: '2030-01-10' }]],
  ];
  for (const [id, h] of MATRIX) await eqEmp(id, h);
  const matrixDates = ['2028-12-31', '2029-01-01', '2029-03-31', '2029-04-01', '2029-05-31', '2029-06-01', '2029-09-30', '2029-10-01', '2029-12-31', '2030-01-01',
    '2030-01-10', '2030-01-11', '2030-01-31', '2030-02-01', '2030-06-30', '2030-07-01', '2030-12-31', '2031-01-01', '2031-03-15', '2031-03-16', '2035-01-01'];
  const pairs = []; for (const [id] of MATRIX) for (const d of matrixDates) pairs.push({ employee_id: id, work_date: d });
  // randomized histories: 200 employees, deterministic PRNG
  let seed = 20260921; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ENT = ['KAHE360', 'MITRA'];
  const addDaysN = (d, n) => bt.addDays(d, n);
  for (let i = 0; i < 200; i += 1) {
    const hist = []; let cur = addDaysN('2029-01-01', Math.floor(rnd() * 200)); const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k += 1) {
      const len = 20 + Math.floor(rnd() * 300); const last = k === n - 1 && rnd() < 0.5;
      const kind = rnd();
      const from = kind < 0.1 && hist.length ? hist[hist.length - 1].from : kind < 0.2 && hist.length ? addDaysN(hist[hist.length - 1].from, 5) : cur;
      hist.push({ e: ENT[Math.floor(rnd() * 2)], from, to: last ? undefined : addDaysN(from, len), cal: rnd() < 0.15 ? CAL2 : CAL });
      cur = addDaysN(from, len + 1 + Math.floor(rnd() * 40));
    }
    await eqEmp(`EQ-R${i}`, hist);
  }
  for (let i = 0; i < 2100; i += 1) pairs.push({ employee_id: `EQ-R${Math.floor(rnd() * 200)}`, work_date: addDaysN('2028-10-01', Math.floor(rnd() * 1400)) });
  await check(`batch R(e,d) == attendanceGuard.entityForEmployeeOn and dated K == frozen getAssignmentOn for every non-AMBIGUOUS pair (${pairs.length} cases, 2,100 randomized)`, async () => {
    const R = await rd.batchAttribution(db, pairs);
    let compared = 0, ambiguous = 0; const bad = [];
    for (const p of pairs) {
      const a = R.get(`${p.employee_id}|${p.work_date}`);
      if (a.status === 'AMBIGUOUS') { ambiguous += 1; continue; }
      compared += 1;
      const frozen = await guard.entityForEmployeeOn(db, p.employee_id, p.work_date);
      const mine = a.status === 'ENTITY' ? a.entity : null;
      if ((frozen || null) !== mine) bad.push(`${p.employee_id} ${p.work_date} frozen=${frozen} batch=${mine}`);
      const asg = await eligibility.getAssignmentOn(db, p.employee_id, p.work_date);
      if (a.step === 'DATED') {
        if (!asg || JSON.stringify(a.k) !== JSON.stringify({ legal_entity_id: asg.legal_entity_id, work_pattern_id: asg.work_pattern_id, work_calendar_id: asg.work_calendar_id })) bad.push(`K ${p.employee_id} ${p.work_date}`);
      } else if (asg) bad.push(`step ${p.employee_id} ${p.work_date}`);
    }
    console.log(`        equivalence: ${pairs.length} cases, ${compared} compared, ${ambiguous} AMBIGUOUS, ${bad.length} mismatches`);
    eq(bad.slice(0, 5), []);
  });
  await check('divergent-K ties (calendar / entity) and fallback entity ties are detected as AMBIGUOUS', async () => {
    const R = await rd.batchAttribution(db, [{ employee_id: 'EQ-TDIVC', work_date: '2030-05-01' }, { employee_id: 'EQ-TDIVE', work_date: '2030-05-01' },
      { employee_id: 'EQ-FBTIE', work_date: '2035-01-01' }, { employee_id: 'EQ-TSAME', work_date: '2030-05-01' }]);
    eq([...R.values()].map((a) => [a.status, a.step]).sort(), [['AMBIGUOUS', 'DATED'], ['AMBIGUOUS', 'DATED'], ['AMBIGUOUS', 'FALLBACK'], ['ENTITY', 'DATED']].sort());
  });
  await check('physical reordering of tied assignment rows does not change readiness', async () => {
    const before = await evalPeriod(SYN.id);
    for (const e of ['S-TIEDIV', 'S-TIESAME']) {
      const rows = await all(`SELECT * FROM employee_payroll_assignments WHERE employee_id = ? ORDER BY id`, e);
      await q(`DELETE FROM employee_payroll_assignments WHERE employee_id = ?`, e);
      for (const a of rows.reverse()) await q(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,
        marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,?,?,?,?)`, a.employee_id, a.legal_entity_id, a.work_pattern_id, a.work_calendar_id,
      a.payroll_group_id, a.marital_status, a.dependents_count, a.effective_date, a.end_date);
    }
    const after = await evalPeriod(SYN.id);
    eq(after.fingerprint, before.fingerprint);
  });

  // ===========================================================================
  section('12. BILINGUAL CONTRACT + CP1 LOCKS');
  await check(`every A4 error response is {error, detail} with a catalogue code (n=${seenHttpErrors.length})`, async () => {
    const bad = seenHttpErrors.filter((e) => JSON.stringify(Object.keys(e.body).sort()) !== '["detail","error"]' || !ap.ERROR_CODES.includes(e.body.error)
      || typeof e.body.detail !== 'object' || ap.ERRORS[e.body.error] !== e.status);
    eq(bad.slice(0, 3), []); ok(seenHttpErrors.length >= 20);
  });
  await check('CP1 generic transition still refuses REVIEW -> READY_TO_CLOSE with NOT_ENABLED', async () => {
    const p = await period(wf, 'KAHE360', '2034-01-01', '2034-01-31'); await toReview(wf, p);
    const r = await wf.post(`/api/attendance-periods/${p.id}/transition`, { to_status: 'READY_TO_CLOSE', expected_status: 'REVIEW' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED']);
  });

  // ===========================================================================
  section('13. ROLLBACK GUARD (documented reverse script)');
  await check('reverse 0007 aborts while any period is READY_TO_CLOSE; schema unchanged', async () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'A4_ATTENDANCE_PERIOD_CONTROL.md'), 'utf8');
    const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.startsWith('-- A4 CP2 REVERSE'));
    eq(blocks.length, 1);
    ok((await one(`SELECT COUNT(*) AS n FROM attendance_periods WHERE status='READY_TO_CLOSE'`)).n > 0);
    const o = __t.openOwner(1);
    let code = 'OK'; try { await o.exec(blocks[0]); } catch (e) { code = e.message; } finally { await o.exec('ROLLBACK').catch(() => {}); await o.close(); }
    eq(code, 'A4_CP2_ROLLBACK_BLOCKED_READY_TO_CLOSE');
    eq((await one(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version='0007'`)).n, 1);
    ok((await one(`SELECT to_regclass('attendance_readiness_evaluations') AS t`)).t);
  });

  // ===========================================================================
  section('14. PERFORMANCE — HARD GATES (1,500 x 31 <= 30 s; 6,000 x 31 <= 60 s)');
  if (SKIP_PERF) { console.log('  (skipped: A4_CP2_SKIP_PERF=1)'); }
  else {
    for (const [entity, n, limit] of [['PERFA', 1500, 30], ['PERFB', 6000, 60]]) {
      const prefix = `${entity}-`;
      const o = __t.openOwner(1);
      await o.query(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
        SELECT $1 || g, 'Perf ' || g, 'internal', 'active', '2019-01-01', 'PPB' FROM generate_series(1, $2) g`, [prefix, n]);
      await o.query(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
        SELECT $1 || g, $3, $4, $5, $6, 'TK', 0, '2032-01-01', '2032-01-31' FROM generate_series(1, $2) g`, [prefix, n, entity, WP6, CAL, G[entity]]);
      await o.query(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from,effective_to,created_by)
        SELECT $1 || g, $3, $4, '2032-01-01', '2032-01-31', 'perf' FROM generate_series(1, $2) g`, [prefix, n, entity, PAT]);
      // every Mon-Sat row present except a 1% gap; 1% of rows cross midnight
      await o.query(`INSERT INTO timesheet_entries (employee_id,work_date,clock_in,clock_out,clock_out_date,attendance_status,work_minutes,legal_entity_id,
          record_status,work_schedule_id,day_status,day_type,scheduled_minutes,worked_after_shift_minutes,overtime_status,schedule_source,current_version,updated_at)
        SELECT $1 || g, d::date,
          CASE WHEN (g + extract(day FROM d)::int) % 100 = 7 THEN '22:00' ELSE '07:00' END,
          CASE WHEN (g + extract(day FROM d)::int) % 100 = 7 THEN '06:00' ELSE '16:00' END,
          CASE WHEN (g + extract(day FROM d)::int) % 100 = 7 THEN (d::date + 1) ELSE NULL END,
          'present', 480, $3, 'EFFECTIVE', $4, 'WORK', 'WORKDAY', 480, 0, 'none', 'pattern:weekly', 1, '2032-02-01 00:00:00'
        FROM generate_series(1, $2) g CROSS JOIN generate_series('2032-01-01'::date, '2032-01-31'::date, interval '1 day') d
        WHERE extract(isodow FROM d) <> 7 AND (g * 31 + extract(day FROM d)::int) % 100 <> 3`, [prefix, n, entity, SCHED]);
      await o.close();
      const P = await period(dir, entity, '2032-01-01', '2032-01-31');
      const stats = rd.newStats();
      const t0 = Date.now();
      const { stats: qs } = await runWithQueryStats(() => evalPeriod(P.id, stats));
      const libMs = Date.now() - t0;
      const t1 = Date.now(); const http = await dir.get(`/api/attendance-periods/${P.id}/readiness`); const httpMs = Date.now() - t1;
      const rowsInEntity = (await one(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE legal_entity_id = ?`, entity)).n;
      const cross = (await one(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE legal_entity_id = ? AND clock_out_date IS NOT NULL AND clock_out_date <> work_date`, entity)).n;
      console.log(`        ${entity}: ${n} workers x 31 days | preview(lib) ${libMs} ms | preview(HTTP) ${httpMs} ms | SQL queries ${qs.queries}`
        + ` | slowest ${qs.slowest.ms} ms: ${qs.slowest.text.slice(0, 110)}`);
      console.log(`        employee-days ${stats.employee_days_evaluated} | rows processed ${stats.attendance_rows_processed} | frozen per-pair calls ${stats.frozen_pair_calls}`
        + ` (isEligibleOn ${stats.is_eligible_calls}, resolveSchedule ${stats.resolve_schedule_calls}) | findOverlap ${stats.find_overlap_calls} | issues ${stats.issues}`
        + ` | attribution queries ${stats.attribution_queries} | http status ${http.status}`);
      const attributionLike = (qs.most_repeated || []).filter((m) => /employee_payroll_assignments/.test(m.text) && /LIMIT 1/.test(m.text) && m.n > 1000);
      await check(`${entity}: ${n} x 31 preview <= ${limit} s (lib ${libMs} ms, HTTP ${httpMs} ms)`, async () => { ok(libMs <= limit * 1000 && httpMs <= limit * 1000, `lib ${libMs} http ${httpMs}`); eq(http.status, 200); });
      await check(`${entity}: one batch attribution query; findOverlap calls == cross-midnight candidates (${cross})`, async () => {
        eq([stats.attribution_queries, stats.find_overlap_calls, stats.employee_days_evaluated, stats.attendance_rows_processed], [1, cross, n * 31, rowsInEntity]);
      });
      if (attributionLike.length) console.log('        note: repeated assignment lookups come from frozen per-pair helpers (isEligibleOn / classification), not attribution');
    }
  }

  console.log(`\n============================================================\nA4 CP2 TESTS: ${passed} passed, ${failed} failed\n============================================================`);
  if (failed) for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
})().catch((e) => { console.error(e); failed += 1; }).finally(async () => {
  if (server) server.kill();
  await __t.drop();
  process.exit(failed ? 1 : 0);
});
})();
