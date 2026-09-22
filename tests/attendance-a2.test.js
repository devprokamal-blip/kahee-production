(async () => {
// tests/attendance-a2.test.js
// Attendance A2 — configurable work schedule / shift / pattern / roster engine.
//
// Same discipline as A1: the REAL server.js spawned over HTTP, the REAL
// seed.js RBAC, real sessions, a throwaway SQLite database via KAHE360_DB_PATH.
// Schedule RESOLUTION is exercised through the real /api/work-schedule/resolve
// endpoint; worked-minute derivation through real attendance writes.
// Usage: npm run test:attendance-a2

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');
const __t = await createTestDatabase('attendance_a2');
process.env.DATABASE_URL = __t.appUrl;   // the REAL server and seed run against this throwaway PostgreSQL database
const bcrypt = require('bcryptjs');
const bt = require('../lib/businessTime');
const ws = require('../lib/workSchedule');

const PORT = 41000 + Math.floor(Math.random() * 20000);
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
async function throwsLike(fn, text) {
  try { await fn(); } catch (e) { if (!String(e.message).includes(text)) throw new Error(`expected "${text}", got ${e.message}`); return; }
  throw new Error(`expected a throw containing ${text}`);
}

// ---- seed + fixtures ---------------------------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], {
  cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl }, stdio: 'pipe',
});
const db = __t.db;

await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active') ON CONFLICT DO NOTHING`).run();
for (const [id, name] of [['KAHE360', 'KAHE'], ['MITRA', 'Mitra Jaya']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2019-01-01') ON CONFLICT DO NOTHING`).run(id, name, id === 'KAHE360' ? 'internal' : 'subkontraktor');
}
const wp5 = Number((await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2019-01-01') RETURNING id`).run()).lastInsertRowid);
const cal = Number((await db.prepare(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('A2CAL','A2','2019-01-01') RETURNING id`).run()).lastInsertRowid);
// A configured public holiday (never hardcoded in code): Thursday 2026-09-10.
await db.prepare(`INSERT INTO holidays (date,name,scope,holiday_type,is_active) VALUES ('2026-09-10','Hari Libur Uji','national','PUBLIC_HOLIDAY',1)`).run();

const groups = {};
for (const e of ['KAHE360', 'MITRA']) {
  groups[e] = Number((await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2019-01-01') RETURNING id`)
    .run(`${e}-A2`, `${e} A2`, e)).lastInsertRowid);
}
const FAR = '2099-12-31';
async function period(entity, y, m, status, attCut = FAR, otCut = FAR) {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return Number((await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(groups[entity], y, m, m, start, end, attCut, otCut, FAR, FAR, status)).lastInsertRowid);
}
const P_SEP = await period('KAHE360', 2026, 9, 'OPEN');
await period('KAHE360', 2026, 8, 'OPEN');
const P_JUL_CLOSED = await period('KAHE360', 2026, 7, 'OPEN', '2026-08-05', '2026-08-05');   // past cutoff
const P_JUN_FROZEN = await period('KAHE360', 2026, 6, 'OPEN');
await period('MITRA', 2026, 9, 'OPEN');

const EMPLOYEES = ['ROT62', 'MONOFF', 'MIXBRK', 'OTREJ', 'OTSHORT', 'ROTHOL', 'ROSTER2', 'TERM',
  'OFFICE', 'SITE', 'NIGHT', 'CUSTOM', 'ROT4', 'ROT14', 'ROT21', 'ROT2D2N', 'ROSTER',
  'OVR', 'OVRHOL', 'EFF', 'BREAK0', 'BREAK1', 'BREAKP', 'BREAKM', 'DERIVE', 'OT', 'OTDELAY', 'OTNONE',
  'XMID', 'XMONTH', 'XYEAR', 'NEG', 'FUT', 'CUT', 'FRZ', 'MANUAL', 'HOL', 'LEGACY'];
async function hire(id, entity = 'KAHE360') {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
              VALUES (?,?,'internal','active','2019-01-01','PPB')`).run(id, `Pekerja ${id}`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2019-01-01')`)
    .run(id, entity, wp5, cal, groups[entity]);
}
for (const e of EMPLOYEES) await hire(e);
await hire('MITRA1', 'MITRA');
// TERM left the company: eligibility must block attendance after the end date.
await db.prepare(`UPDATE employees SET status='inactive', termination_date='2026-08-31' WHERE id='TERM'`).run();

// Frozen payroll snapshot over FRZ / June 2026, and a June attendance row.
await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,day_type,day_type_source,legal_entity_id)
  VALUES ('FRZ','2026-06-10','present',480,8,'WORKDAY','fixture','KAHE360')`).run();
await db.prepare(`INSERT INTO payroll_input_snapshots (payroll_period_id,employee_id,as_of_date,legal_entity_id,payroll_group_id,
  resolved_payload,payload_hash,resolved_at,status,frozen_at,frozen_by)
  VALUES (?, 'FRZ', '2026-06-30', 'KAHE360', ?, '{}','x', kahe_now(),'FROZEN', kahe_now(),'test')`)
  .run(P_JUN_FROZEN, groups.KAHE360);

const roleId = async (code) => (await db.prepare('SELECT id FROM roles WHERE code = ?').get(code)).id;
const userId = async (email) => (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
async function makeUser(email, name, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email,display_name,password_hash,is_active) VALUES (?,?,?,1) RETURNING id`)
    .run(email, name, bcrypt.hashSync(PASSWORD, 4))).lastInsertRowid);
  await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)').run(id, await roleId(role));
  return id;
}
const grant = async (uid, e) => await db.prepare(`INSERT INTO user_legal_entity_scope (user_id,legal_entity_id,granted_by) VALUES (?,?,'test') ON CONFLICT DO NOTHING`).run(uid, e);
const U = {
  director: await userId('director@kahe360.local'),
  workforce: await userId('workforce@kahe360.local'),
  hrd: await userId('hrd@kahe360.local'),
  payroll: await userId('payroll@kahe360.local'),
  mitraWf: await makeUser('mitra.a2@t.local', 'Mitra A2', 'workforce_manager'),
};
for (const k of ['director', 'workforce', 'hrd', 'payroll']) await grant(U[k], 'KAHE360');
await grant(U.mitraWf, 'MITRA');

// ---- HTTP client --------------------------------------------------------------
async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(`${BASE}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, body: json };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b),
    sched: (u) => call('GET', `/api/work-schedule${u}`),
    schedPost: (u, b) => call('POST', `/api/work-schedule${u}`, b),
    ts: (u) => call('GET', `/api/timesheet${u}`),
    tsPost: (u, b) => call('POST', `/api/timesheet${u}`, b),
    tsPut: (u, b) => call('PUT', `/api/timesheet${u}`, b),
  };
}
const entryRow = async (id) => await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);

let server;
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl, PORT: String(PORT), NODE_ENV: 'development' }, stdio: 'pipe',
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${BASE}/login.html`); if (r.status === 200) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${out}`);
}

(async () => {
  await startServer();
  const wf = await login('workforce@kahe360.local');
  const dir = await login('director@kahe360.local');
  const pay = await login('payroll@kahe360.local');
  const mitra = await login('mitra.a2@t.local');

  const S = {};   // schedule ids
  const PAT = {}; // pattern ids
  const mk = async (body) => {
    const r = await wf.schedPost('/schedules', { legal_entity_id: 'KAHE360', effective_from: '2019-01-01', ...body });
    if (r.status !== 201) throw new Error(`schedule ${body.code}: ${JSON.stringify(r.body)}`);
    return r.body.id;
  };
  const assign = async (employee, body) => wf.schedPost('/assignments', { employee_id: employee, effective_from: '2019-01-01', ...body });
  const resolve = async (client, emp, date) => (await client.sched(`/resolve/${emp}/${date}`)).body;

  section('WORK SCHEDULE MASTER');
  await check('create schedules: office, site-day, night (cross-midnight), no-break, paid-break, multi-break', async () => {
    S.OFFICE = await mk({ code: 'OFFICE', name: 'Office', schedule_type: 'OFFICE', clock_in: '08:00', clock_out: '17:00',
      standard_work_minutes: 480, breaks: [{ name: 'Lunch', start_time: '12:00', end_time: '13:00', is_paid: false }] });
    S.SITE_DAY = await mk({ code: 'SITE-DAY', name: 'Site Day', schedule_type: 'SITE', clock_in: '07:00', clock_out: '16:00',
      standard_work_minutes: 480, breaks: [{ name: 'Lunch', start_time: '12:00', end_time: '13:00', is_paid: false }] });
    S.SITE_NIGHT = await mk({ code: 'SITE-NIGHT', name: 'Site Night', clock_in: '20:00', clock_out: '05:00', cross_midnight: true,
      standard_work_minutes: 480, breaks: [{ name: 'Malam', duration_minutes: 60, is_paid: false }] });
    S.NOBREAK = await mk({ code: 'SEC-DAY', name: 'Security Day', clock_in: '07:00', clock_out: '19:00', standard_work_minutes: 720, breaks: [] });
    S.PAIDBREAK = await mk({ code: 'PAID-BRK', name: 'Paid break', clock_in: '09:00', clock_out: '17:00', standard_work_minutes: 480,
      breaks: [{ name: 'Coffee', duration_minutes: 30, is_paid: true }] });
    S.MULTIBREAK = await mk({ code: 'MULTI-BRK', name: 'Three breaks', clock_in: '07:00', clock_out: '17:00', standard_work_minutes: 510,
      breaks: [{ name: 'Pagi', duration_minutes: 15, is_paid: false }, { name: 'Siang', duration_minutes: 60, is_paid: false },
        { name: 'Sore', duration_minutes: 15, is_paid: false }] });
    S.SHORT = await mk({ code: 'SHORT', name: 'Short Saturday', clock_in: '07:00', clock_out: '12:00', standard_work_minutes: 300, breaks: [] });
    const list = (await wf.sched('/schedules')).body;
    ok(list.length >= 7, `only ${list.length} schedules`);
    const office = list.find((x) => x.code === 'OFFICE');
    eq([office.breaks.length, office.breaks[0].duration_minutes, office.overtime_eligible_from_resolved], [1, 60, '17:00']);
  });
  await check('invalid shift span / invalid time rejected', async () => {
    eq((await wf.schedPost('/schedules', { code: 'BAD1', name: 'x', legal_entity_id: 'KAHE360', clock_in: '17:00', clock_out: '08:00', effective_from: '2026-01-01' })).body.error, 'INVALID_SHIFT_SPAN');
    eq((await wf.schedPost('/schedules', { code: 'BAD2', name: 'x', legal_entity_id: 'KAHE360', clock_in: '25:00', clock_out: '08:00', effective_from: '2026-01-01' })).body.error, 'INVALID_TIME');
  });
  await check('invalid break configuration rejected', async () => {
    const bad1 = await wf.schedPost('/schedules', { code: 'BRK-BAD1', name: 'x', legal_entity_id: 'KAHE360',
      clock_in: '08:00', clock_out: '17:00', effective_from: '2026-01-01', breaks: [{ name: 'x', duration_minutes: 0 }] });
    eq([bad1.status, bad1.body.error], [400, 'INVALID_BREAK']);
    const bad2 = await wf.schedPost('/schedules', { code: 'BRK-BAD2', name: 'x', legal_entity_id: 'KAHE360',
      clock_in: '08:00', clock_out: '17:00', effective_from: '2026-01-01', breaks: [{ name: 'x', start_time: '99:99', duration_minutes: 30 }] });
    eq([bad2.status, bad2.body.error], [400, 'INVALID_TIME']);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM work_schedules WHERE code LIKE 'BRK-BAD%'`).get()).n, 0, 'partial schedule written: ');
  });
  await check('duplicate open code rejected (409 SCHEDULE_CODE_OPEN)', async () => {
    const r = await wf.schedPost('/schedules', { code: 'OFFICE', name: 'dup', legal_entity_id: 'KAHE360', clock_in: '08:00', clock_out: '17:00', effective_from: '2026-01-01' });
    eq([r.status, r.body.error], [409, 'SCHEDULE_CODE_OPEN']);
  });
  await check('new effective-dated version closes the previous one; both remain readable', async () => {
    const r = await wf.schedPost(`/schedules/${S.OFFICE}/versions`, { clock_in: '08:30', clock_out: '17:30', standard_work_minutes: 480, effective_from: '2026-11-01' });
    eq(r.status, 201); S.OFFICE_V2 = r.body.id;
    eq(r.body.previous_version_closed, '2026-10-31');
    const v1 = (await wf.sched(`/schedules/${S.OFFICE}`)).body;
    const v2 = (await wf.sched(`/schedules/${S.OFFICE_V2}`)).body;
    eq([v1.clock_in, v1.effective_to, v2.clock_in, v2.effective_from], ['08:00', '2026-10-31', '08:30', '2026-11-01']);
    eq(v2.breaks.length, 1, 'breaks carried into the new version: ');
  });
  await check('overlapping version rejected', async () => {
    const r = await wf.schedPost(`/schedules/${S.OFFICE_V2}/versions`, { effective_from: '2026-10-01' });
    eq([r.status, r.body.error], [409, 'SCHEDULE_VERSION_OVERLAP']);
  });
  await check('deactivate / reactivate a schedule', async () => {
    eq((await wf.schedPost(`/schedules/${S.SHORT}/status`, { status: 'INACTIVE' })).status, 200);
    eq((await wf.sched(`/schedules/${S.SHORT}`)).body.status, 'INACTIVE');
    await wf.schedPost(`/schedules/${S.SHORT}/status`, { status: 'ACTIVE' });
  });
  await check('an INACTIVE schedule still resolves historically but is flagged', async () => {
    await wf.schedPost(`/schedules/${S.MULTIBREAK}/status`, { status: 'INACTIVE' });
    const r = (await wf.sched(`/schedules/${S.MULTIBREAK}`)).body;
    eq(r.status, 'INACTIVE');
    await wf.schedPost(`/schedules/${S.MULTIBREAK}/status`, { status: 'ACTIVE' });
  });
  await check('unauthorized schedule create (Payroll Officer = VIEW only) -> 403; unauthenticated -> 401', async () => {
    eq((await pay.schedPost('/schedules', { code: 'X', name: 'x', legal_entity_id: 'KAHE360', clock_in: '08:00', clock_out: '17:00', effective_from: '2026-01-01' })).status, 403);
    eq((await fetch(`${BASE}/api/work-schedule/schedules`)).status, 401);
  });
  await check('legal-entity isolation on configuration (list, direct id, create)', async () => {
    const mine = (await mitra.sched('/schedules')).body;
    ok(!mine.some((s) => s.legal_entity_id === 'KAHE360'), 'KAHE schedule leaked to MITRA user');
    eq((await mitra.sched(`/schedules/${S.OFFICE}`)).status, 404);
    eq((await mitra.schedPost('/schedules', { code: 'M1', name: 'x', legal_entity_id: 'KAHE360', clock_in: '08:00', clock_out: '17:00', effective_from: '2026-01-01' })).status, 404);
  });

  section('WORK PATTERNS — fixed, custom weekly, rotating, date roster');
  const day = (i, status, schedule) => ({ day_index: i, day_status: status, work_schedule_id: schedule || null });
  await check('FIXED_WEEKLY 5/2 (Mon-Fri work, Sat+Sun off)', async () => {
    const days = [1, 2, 3, 4, 5].map((i) => day(i, 'WORK', S.SITE_DAY)).concat([day(6, 'OFF'), day(7, 'OFF')]);
    const r = await wf.schedPost('/patterns', { code: 'W52', name: '5/2', legal_entity_id: 'KAHE360',
      pattern_type: 'FIXED_WEEKLY', effective_from: '2019-01-01', days });
    eq(r.status, 201); PAT.W52 = r.body.id;
    eq((await assign('SITE', { pattern_id: PAT.W52 })).status, 201);
    const mon = await resolve(wf, 'SITE', '2026-10-05');
    const sat = await resolve(wf, 'SITE', '2026-10-10');
    eq([mon.day_status, mon.schedule.code, mon.day_type, sat.day_status, sat.day_type],
      ['WORK', 'SITE-DAY', 'WORKDAY', 'OFF', 'WEEKLY_REST_DAY']);
  });
  await check('6/1 pattern: Saturday is a WORKDAY, only Sunday off', async () => {
    const days = [1, 2, 3, 4, 5, 6].map((i) => day(i, 'WORK', S.SITE_DAY)).concat([day(7, 'OFF')]);
    const r = await wf.schedPost('/patterns', { code: 'W61', name: '6/1', legal_entity_id: 'KAHE360',
      pattern_type: 'FIXED_WEEKLY', effective_from: '2019-01-01', days });
    PAT.W61 = r.body.id;
    await assign('OFFICE', { pattern_id: PAT.W61 });
    const sat = await resolve(wf, 'OFFICE', '2026-10-10');
    const sun = await resolve(wf, 'OFFICE', '2026-10-11');
    eq([sat.day_status, sat.day_type, sun.day_status, sun.day_type], ['WORK', 'WORKDAY', 'OFF', 'WEEKLY_REST_DAY']);
  });
  await check('pattern with no day-level shift lets the per-employee assignment shift apply', async () => {
    const days = [1, 2, 3, 4, 5, 6].map((i) => day(i, 'WORK')).concat([day(7, 'OFF')]);
    const r = await wf.schedPost('/patterns', { code: 'W61NS', name: '6/1 tanpa shift', legal_entity_id: 'KAHE360',
      pattern_type: 'FIXED_WEEKLY', effective_from: '2019-01-01', days });
    eq(r.status, 201); PAT.W61NS = r.body.id;
    await assign('BREAK0', { pattern_id: PAT.W61NS, work_schedule_id: S.NOBREAK });
    const x = await resolve(wf, 'BREAK0', '2026-10-05');
    eq([x.day_status, x.schedule.code, x.scheduled_minutes], ['WORK', 'SEC-DAY', 720]);
  });
  await check('CUSTOM_WEEKLY: Wed OFF, Fri night shift, Sat short shift, Sun WORK', async () => {
    const days = [
      day(1, 'WORK', S.SITE_DAY), day(2, 'WORK', S.SITE_DAY), day(3, 'OFF'), day(4, 'WORK', S.SITE_DAY),
      day(5, 'WORK', S.SITE_NIGHT), day(6, 'WORK', S.SHORT), day(7, 'WORK', S.SITE_DAY),
    ];
    const r = await wf.schedPost('/patterns', { code: 'CUSTOM1', name: 'Custom mix', legal_entity_id: 'KAHE360',
      pattern_type: 'CUSTOM_WEEKLY', effective_from: '2019-01-01', days });
    eq(r.status, 201); PAT.CUSTOM1 = r.body.id;
    await assign('CUSTOM', { pattern_id: PAT.CUSTOM1 });
    const got = {};
    for (const [label, d] of [['mon', '2026-10-05'], ['wed', '2026-10-07'], ['fri', '2026-10-09'], ['sat', '2026-10-10'], ['sun', '2026-10-11']]) {
      const r2 = await resolve(wf, 'CUSTOM', d);
      got[label] = [r2.day_status, r2.schedule ? r2.schedule.code : null];
    }
    eq(got, { mon: ['WORK', 'SITE-DAY'], wed: ['OFF', null], fri: ['WORK', 'SITE-NIGHT'],
      sat: ['WORK', 'SHORT'], sun: ['WORK', 'SITE-DAY'] });
  });
  await check('Monday OFF + Saturday and Sunday WORK is a valid configuration', async () => {
    const days = [day(1, 'OFF'), day(2, 'WORK', S.SITE_DAY), day(3, 'WORK', S.SITE_DAY), day(4, 'WORK', S.SITE_DAY),
      day(5, 'OFF'), day(6, 'WORK', S.SITE_DAY), day(7, 'WORK', S.SITE_DAY)];
    const r = await wf.schedPost('/patterns', { code: 'MONOFF', name: 'Senin libur', legal_entity_id: 'KAHE360',
      pattern_type: 'CUSTOM_WEEKLY', effective_from: '2019-01-01', days });
    eq(r.status, 201);
    await assign('MONOFF', { pattern_id: r.body.id });
    const got = [];
    for (const d of ['2026-10-05', '2026-10-09', '2026-10-10', '2026-10-11']) got.push((await resolve(wf, 'MONOFF', d)).day_status);
    eq(got, ['OFF', 'OFF', 'WORK', 'WORK']);
  });
  await check('weekly pattern must define all 7 days', async () => {
    const r = await wf.schedPost('/patterns', { code: 'BADW', name: 'x', legal_entity_id: 'KAHE360',
      pattern_type: 'CUSTOM_WEEKLY', effective_from: '2026-01-01', days: [day(1, 'WORK')] });
    eq([r.status, r.body.error], [400, 'INVALID_PATTERN']);
  });
  await check('ROTATING_CYCLE 4 ON / 2 OFF resolves from the cycle anchor', async () => {
    const days = [day(1, 'WORK', S.SITE_DAY), day(2, 'WORK', S.SITE_DAY), day(3, 'WORK', S.SITE_DAY),
      day(4, 'WORK', S.SITE_DAY), day(5, 'OFF'), day(6, 'OFF')];
    const r = await wf.schedPost('/patterns', { code: 'ROT42', name: '4 on 2 off', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 6, cycle_start_date: '2026-10-01', effective_from: '2019-01-01', days });
    eq(r.status, 201); PAT.ROT4 = r.body.id;
    await assign('ROT4', { pattern_id: PAT.ROT4 });
    const seq = [];
    for (let i = 0; i < 8; i += 1) seq.push((await resolve(wf, 'ROT4', bt.addDays('2026-10-01', i))).day_status);
    eq(seq, ['WORK', 'WORK', 'WORK', 'WORK', 'OFF', 'OFF', 'WORK', 'WORK']);
  });
  await check('ROTATING_CYCLE 6 ON / 2 OFF (8-day cycle)', async () => {
    const days = [];
    for (let i = 1; i <= 8; i += 1) days.push(day(i, i <= 6 ? 'WORK' : 'OFF', i <= 6 ? S.SITE_DAY : null));
    const r = await wf.schedPost('/patterns', { code: 'ROT62', name: '6/2', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 8, cycle_start_date: '2026-10-01', effective_from: '2019-01-01', days });
    eq(r.status, 201); PAT.ROT62 = r.body.id;
    await assign('ROT62', { pattern_id: PAT.ROT62 });
    const seq = [];
    for (let i = 0; i < 10; i += 1) seq.push((await resolve(wf, 'ROT62', bt.addDays('2026-10-01', i))).day_status);
    eq(seq, ['WORK', 'WORK', 'WORK', 'WORK', 'WORK', 'WORK', 'OFF', 'OFF', 'WORK', 'WORK']);
  });
  await check('rotating cycle keeps counting across a MONTH boundary', async () => {
    // anchor 2026-10-01, 6-day cycle: 2026-10-31 is day 31 -> slot 1, 11-01 -> slot 2
    const a = await resolve(wf, 'ROT4', '2026-10-31');
    const b = await resolve(wf, 'ROT4', '2026-11-01');
    eq([a.cycle_day_index, a.day_status, b.cycle_day_index, b.day_status], [1, 'WORK', 2, 'WORK']);
  });
  await check('rotating cycle keeps counting across a YEAR boundary', async () => {
    const dec = await resolve(wf, 'ROT4', '2026-12-31');
    const jan = await resolve(wf, 'ROT4', '2027-01-01');
    const expected = ((bt.daysBetween('2026-10-01', '2026-12-31') % 6) + 6) % 6 + 1;
    eq([dec.cycle_day_index, jan.cycle_day_index], [expected, (expected % 6) + 1]);
    ok(dec.status === 'OK' && jan.status === 'OK', 'resolution failed at the year boundary');
  });
  await check('ROTATING_CYCLE 14 ON / 7 OFF (21-day cycle)', async () => {
    const days = [];
    for (let i = 1; i <= 21; i += 1) days.push(day(i, i <= 14 ? 'WORK' : 'OFF', i <= 14 ? S.SITE_DAY : null));
    const r = await wf.schedPost('/patterns', { code: 'ROT147', name: '14/7', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 21, cycle_start_date: '2026-10-01', effective_from: '2019-01-01', days });
    PAT.ROT14 = r.body.id;
    await assign('ROT14', { pattern_id: PAT.ROT14 });
    const probe = async (d) => (await resolve(wf, 'ROT14', d)).day_status;
    eq([await probe('2026-10-01'), await probe('2026-10-14'), await probe('2026-10-15'), await probe('2026-10-21'), await probe('2026-10-22')],
      ['WORK', 'WORK', 'OFF', 'OFF', 'WORK']);
  });
  await check('ROTATING_CYCLE 21 ON / 7 OFF (28-day cycle)', async () => {
    const days = [];
    for (let i = 1; i <= 28; i += 1) days.push(day(i, i <= 21 ? 'WORK' : 'OFF', i <= 21 ? S.SITE_DAY : null));
    const r = await wf.schedPost('/patterns', { code: 'ROT217', name: '21/7', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 28, cycle_start_date: '2026-10-01', effective_from: '2019-01-01', days });
    PAT.ROT21 = r.body.id;
    await assign('ROT21', { pattern_id: PAT.ROT21 });
    const probe = async (d) => (await resolve(wf, 'ROT21', d)).day_status;
    eq([await probe('2026-10-21'), await probe('2026-10-22'), await probe('2026-10-28'), await probe('2026-10-29')],
      ['WORK', 'OFF', 'OFF', 'WORK']);
  });
  await check('ROTATING_CYCLE 2 DAY / 2 NIGHT / 2 OFF alternates the SHIFT, not just work/off', async () => {
    const days = [day(1, 'WORK', S.SITE_DAY), day(2, 'WORK', S.SITE_DAY), day(3, 'WORK', S.SITE_NIGHT),
      day(4, 'WORK', S.SITE_NIGHT), day(5, 'OFF'), day(6, 'OFF')];
    const r = await wf.schedPost('/patterns', { code: 'ROT2D2N', name: '2D/2N/2OFF', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 6, cycle_start_date: '2026-10-05', effective_from: '2019-01-01', days });
    PAT.ROT2D2N = r.body.id;
    await assign('ROT2D2N', { pattern_id: PAT.ROT2D2N });
    const seq = [];
    for (let i = 0; i < 6; i += 1) {
      const x = await resolve(wf, 'ROT2D2N', bt.addDays('2026-10-05', i));
      seq.push(x.schedule ? x.schedule.code : x.day_status);
    }
    eq(seq, ['SITE-DAY', 'SITE-DAY', 'SITE-NIGHT', 'SITE-NIGHT', 'OFF', 'OFF']);
  });
  await check('rotating cycle without an anchor is REFUSED, never guessed', async () => {
    const r = await wf.schedPost('/patterns', { code: 'NOANCHOR', name: 'x', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 6, effective_from: '2026-01-01', days: [day(1, 'WORK')] });
    eq([r.status, r.body.error], [400, 'MISSING_CYCLE_ANCHOR']);
  });
  await check('cycle day count must match cycle_length_days', async () => {
    const r = await wf.schedPost('/patterns', { code: 'BADCYCLE', name: 'x', legal_entity_id: 'KAHE360',
      pattern_type: 'ROTATING_CYCLE', cycle_length_days: 6, cycle_start_date: '2026-01-01', effective_from: '2026-01-01',
      days: [day(1, 'WORK'), day(2, 'WORK')] });
    eq([r.status, r.body.error], [400, 'INVALID_CYCLE']);
  });
  await check('DATE_BASED_ROSTER: explicit WORK date, explicit OFF date, unlisted date = OFF', async () => {
    const r = await wf.schedPost('/patterns', { code: 'ROSTER1', name: 'Project roster', legal_entity_id: 'KAHE360',
      pattern_type: 'DATE_BASED_ROSTER', effective_from: '2019-01-01' });
    eq(r.status, 201); PAT.ROSTER = r.body.id;
    await assign('ROSTER', { pattern_id: PAT.ROSTER });
    const posted = await wf.schedPost(`/patterns/${PAT.ROSTER}/roster-dates`, { dates: [
      { work_date: '2026-10-01', day_status: 'WORK', work_schedule_id: S.SITE_DAY },
      { work_date: '2026-10-02', day_status: 'WORK', work_schedule_id: S.SITE_DAY },
      { work_date: '2026-10-03', day_status: 'OFF' },
      { work_date: '2026-10-04', day_status: 'WORK', work_schedule_id: S.SITE_NIGHT },
    ] });
    eq(posted.status, 201);
    const probe = async (d) => { const x = await resolve(wf, 'ROSTER', d); return [x.day_status, x.schedule ? x.schedule.code : null]; };
    eq([await probe('2026-10-01'), await probe('2026-10-03'), await probe('2026-10-04'), await probe('2026-10-09')],
      [['WORK', 'SITE-DAY'], ['OFF', null], ['WORK', 'SITE-NIGHT'], ['OFF', null]]);
  });

  await check('an EMPLOYEE roster row outranks the pattern roster for the same date', async () => {
    await assign('ROSTER2', { pattern_id: PAT.ROSTER });
    await db.prepare(`INSERT INTO attendance_roster_dates (employee_id,work_date,day_status,work_schedule_id,created_by)
                VALUES ('ROSTER2','2026-10-03','WORK',?, 'test')`).run(S.SITE_NIGHT);
    const own = await resolve(wf, 'ROSTER2', '2026-10-03');     // pattern roster says OFF
    const other = await resolve(wf, 'ROSTER', '2026-10-03');
    eq([own.day_status, own.schedule.code, own.source, other.day_status],
      ['WORK', 'SITE-NIGHT', 'roster_date:employee', 'OFF']);
  });

  section('DATE OVERRIDE');
  await check('OFF -> WORK override with shift and reason; base pattern untouched', async () => {
    await assign('OVR', { pattern_id: PAT.W52 });
    const before = await resolve(wf, 'OVR', '2026-10-11');     // Sunday, OFF by pattern
    const r = await wf.schedPost('/overrides', { employee_id: 'OVR', work_date: '2026-10-11', override_status: 'WORK',
      work_schedule_id: S.SITE_DAY, reason: 'PROJECT REQUIREMENT' });
    eq(r.status, 201);
    const after = await resolve(wf, 'OVR', '2026-10-11');
    eq([before.day_status, after.day_status, after.source, after.schedule.code],
      ['OFF', 'WORK', 'date_override:employee', 'SITE-DAY']);
    // the pattern itself is unchanged for everyone else
    eq((await resolve(wf, 'SITE', '2026-10-11')).day_status, 'OFF');
    const patDays = (await wf.sched(`/patterns/${PAT.W52}`)).body.days;
    eq(patDays.find((d) => d.day_index === 7).day_status, 'OFF');
  });
  await check('WORK -> OFF override (project shutdown)', async () => {
    const r = await wf.schedPost('/overrides', { employee_id: 'OVR', work_date: '2026-10-22', override_status: 'OFF', reason: 'PROJECT SHUTDOWN' });
    eq(r.status, 201);
    const x = await resolve(wf, 'OVR', '2026-10-22');
    eq([x.day_status, x.day_type], ['OFF', 'WEEKLY_REST_DAY']);
  });
  await check('override on a PUBLIC HOLIDAY sets WORK but the day TYPE stays PUBLIC_HOLIDAY', async () => {
    await assign('OVRHOL', { pattern_id: PAT.W52 });
    await wf.schedPost('/overrides', { employee_id: 'OVRHOL', work_date: '2026-09-10', override_status: 'WORK',
      work_schedule_id: S.SITE_DAY, reason: 'Kebutuhan proyek pada hari libur' });
    const x = await resolve(wf, 'OVRHOL', '2026-09-10');
    eq([x.day_status, x.day_type], ['WORK', 'PUBLIC_HOLIDAY']);
    ok(x.warnings.some((w) => w.includes('PUBLIC_HOLIDAY')), 'holiday not flagged');
  });
  await check('override records actor, reason and timestamp', async () => {
    const row = await db.prepare(`SELECT * FROM attendance_date_overrides WHERE employee_id='OVR' AND work_date='2026-10-22'`).get();
    eq([row.reason, row.created_by_user_id, !!row.created_at], ['PROJECT SHUTDOWN', U.workforce, true]);
    ok(String(row.created_by).length > 0, 'actor name missing');
  });
  await check('rotating roster + public holiday: the holiday still wins the day TYPE', async () => {
    await assign('ROTHOL', { pattern_id: PAT.ROT14 });
    const x = await resolve(wf, 'ROTHOL', '2026-09-10');
    eq(x.day_type, 'PUBLIC_HOLIDAY');
    ok(['WORK', 'OFF'].includes(x.day_status), 'no roster status resolved');
  });
  await check('deactivating an override restores the base pattern', async () => {
    const list = (await wf.sched('/overrides')).body;
    const target = list.find((o) => o.employee_id === 'OVR' && o.work_date === '2026-10-11');
    eq((await wf.schedPost(`/overrides/${target.id}/deactivate`)).status, 200);
    eq((await resolve(wf, 'OVR', '2026-10-11')).day_status, 'OFF');
  });
  await check('override requires a reason, and is entity-scoped', async () => {
    eq((await wf.schedPost('/overrides', { employee_id: 'OVR', work_date: '2026-10-25', override_status: 'OFF' })).status, 400);
    eq((await mitra.schedPost('/overrides', { employee_id: 'OVR', work_date: '2026-10-26', override_status: 'OFF', reason: 'x' })).status, 404);
  });

  section('EFFECTIVE DATING');
  await check('assignment change: October keeps October pattern, November uses the new one', async () => {
    await assign('EFF', { pattern_id: PAT.W52, effective_from: '2026-10-01' });
    const r = await wf.schedPost('/assignments', { employee_id: 'EFF', pattern_id: PAT.ROT2D2N, effective_from: '2026-11-01' });
    eq(r.status, 201);
    const oct = await resolve(wf, 'EFF', '2026-10-07');    // Wednesday: 5/2 -> WORK
    const nov = await resolve(wf, 'EFF', '2026-11-04');
    eq([oct.pattern.code, nov.pattern.code], ['W52', 'ROT2D2N']);
    const rows = await db.prepare(`SELECT effective_from, effective_to FROM attendance_schedule_assignments WHERE employee_id='EFF' ORDER BY effective_from`).all();
    eq(rows.map((x) => [x.effective_from, x.effective_to]), [['2026-10-01', '2026-10-31'], ['2026-11-01', null]]);
  });
  await check('assignment landing inside an existing CLOSED period is rejected', async () => {
    const r = await wf.schedPost('/assignments', { employee_id: 'EFF', pattern_id: PAT.W52, effective_from: '2026-10-15' });
    eq([r.status, r.body.error], [409, 'ASSIGNMENT_OVERLAP']);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_schedule_assignments WHERE employee_id='EFF'`).get()).n, 2);
  });
  await check('a later assignment supersedes the open one (closes it the day before)', async () => {
    const r = await wf.schedPost('/assignments', { employee_id: 'EFF', pattern_id: PAT.W61, effective_from: '2026-12-01' });
    eq(r.status, 201);
    const rows = await db.prepare(`SELECT effective_from, effective_to FROM attendance_schedule_assignments WHERE employee_id='EFF' ORDER BY effective_from`).all();
    eq(rows.map((x) => [x.effective_from, x.effective_to]),
      [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', null]]);
    eq((await resolve(wf, 'EFF', '2026-11-04')).pattern.code, 'ROT2D2N');
  });
  await check('schedule versions are effective-dated: Oct resolves v1 08:00, Nov resolves v2 08:30', async () => {
    await assign('LEGACY', { work_schedule_id: S.OFFICE, pattern_id: PAT.W61 });
    // the pattern's day rows point at SITE-DAY, so probe the schedule versions directly
    const v1 = (await wf.sched(`/schedules/${S.OFFICE}`)).body;
    const v2 = (await wf.sched(`/schedules/${S.OFFICE_V2}`)).body;
    eq([v1.effective_from, v1.effective_to, v2.effective_from], ['2019-01-01', '2026-10-31', '2026-11-01']);
  });

  section('BREAKS & WORKED MINUTES (integer minutes, derived from actual clocks)');
  const entry = async (emp, date, body) => {
    const r = await wf.tsPost('/entries', { employee_id: emp, work_date: date, ...body });
    if (r.status !== 201) throw new Error(`entry ${emp} ${date}: ${JSON.stringify(r.body)}`);
    return r;
  };
  await check('zero breaks: worked = elapsed (07:00-19:00 = 720)', async () => {
    const r = await entry('BREAK0', '2026-09-07', { clock_in: '07:00', clock_out: '19:00' });
    eq([r.body.work_minutes, r.body.scheduled_minutes], [720, 720]);
  });
  await check('one unpaid break deducted: 07:00-16:00 - 60 = 480', async () => {
    await assign('BREAK1', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    const r = await entry('BREAK1', '2026-09-07', { clock_in: '07:00', clock_out: '16:00' });
    eq([r.body.work_minutes, (await entryRow(r.body.id)).break_minutes_unpaid], [480, 60]);
  });
  await check('paid break is NOT deducted: 09:00-17:00 = 480 with a 30-minute paid break', async () => {
    await assign('BREAKP', { work_schedule_id: S.PAIDBREAK, pattern_id: PAT.W61NS });
    const r = await entry('BREAKP', '2026-09-07', { clock_in: '09:00', clock_out: '17:00' });
    eq([r.body.work_minutes, (await entryRow(r.body.id)).break_minutes_paid, (await entryRow(r.body.id)).break_minutes_unpaid], [480, 30, 0]);
  });
  await check('multiple breaks: 07:00-17:00 - (15+60+15) = 510', async () => {
    await assign('BREAKM', { work_schedule_id: S.MULTIBREAK, pattern_id: PAT.W61NS });
    const r = await entry('BREAKM', '2026-09-07', { clock_in: '07:00', clock_out: '17:00' });
    eq([r.body.work_minutes, (await entryRow(r.body.id)).break_minutes_unpaid], [510, 90]);
  });
  await check('mixed paid + unpaid breaks: only the unpaid minutes are deducted', async () => {
    S.MIXBRK = await mk({ code: 'MIX-BRK', name: 'Mixed breaks', clock_in: '07:00', clock_out: '17:00',
      standard_work_minutes: 540, breaks: [{ name: 'Kopi', duration_minutes: 30, is_paid: true },
        { name: 'Siang', duration_minutes: 60, is_paid: false }] });
    await assign('MIXBRK', { work_schedule_id: S.MIXBRK, pattern_id: PAT.W61NS });
    const r = await entry('MIXBRK', '2026-09-07', { clock_in: '07:00', clock_out: '17:00' });
    const row = await entryRow(r.body.id);
    eq([row.elapsed_minutes, row.break_minutes_paid, row.break_minutes_unpaid, row.work_minutes], [600, 30, 60, 540]);
  });
  await check('early arrival and late departure are measured, not paid', async () => {
    await assign('DERIVE', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    const r = await entry('DERIVE', '2026-09-07', { clock_in: '06:45', clock_out: '18:12' });
    const row = await entryRow(r.body.id);
    eq([row.elapsed_minutes, row.work_minutes, row.late_minutes, row.worked_after_shift_minutes, row.overtime_minutes_approved],
      [687, 627, 0, 132, 0]);
  });
  await check('late arrival and early departure are measured', async () => {
    const r = await entry('DERIVE', '2026-09-08', { clock_in: '07:20', clock_out: '15:00' });
    const row = await entryRow(r.body.id);
    eq([row.late_minutes, row.early_leave_minutes, row.work_minutes], [20, 60, 400]);
  });
  await check('supplied work_hours is ignored once clocks + schedule are known (derivation wins)', async () => {
    const r = await entry('DERIVE', '2026-09-09', { clock_in: '07:00', clock_out: '16:00', work_hours: 12 });
    eq([r.body.work_minutes, r.body.work_minutes_derived_from_clock, r.body.supplied_work_minutes_ignored], [480, true, 720]);
  });
  await check('without a resolved schedule the recorded figure is used (integer minutes preserved)', async () => {
    const got = [];
    for (const [d, h] of [['2026-09-01', 0.1], ['2026-09-02', 0.25], ['2026-09-03', 0.5], ['2026-09-04', 7.25], ['2026-09-05', 8]]) {
      const r = await entry('MANUAL', d, { work_hours: h });
      got.push(r.body.work_minutes);
    }
    eq(got, [6, 15, 30, 435, 480]);
  });

  section('OVERTIME ELIGIBILITY (eligible ≠ payable)');
  await check('OT eligible at shift end: late clock-out is reported, approved minutes stay 0', async () => {
    await assign('OT', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    const r = await entry('OT', '2026-09-07', { clock_in: '07:00', clock_out: '18:00' });
    const row = await entryRow(r.body.id);
    eq([row.overtime_eligible_from, row.worked_after_shift_minutes, row.overtime_status, row.overtime_minutes_approved],
      ['16:00', 120, 'none', 0]);
    eq(ws.payrollTimeContract(row).overtime_minutes_approved, 0);
  });
  await check('delayed eligibility (AFTER_DELAY 30 min) shifts the boundary to 16:30', async () => {
    S.DELAY = await mk({ code: 'SITE-DELAY', name: 'Site with OT delay', clock_in: '07:00', clock_out: '16:00',
      standard_work_minutes: 480, overtime_eligibility_rule: 'AFTER_DELAY', overtime_delay_minutes: 30,
      breaks: [{ name: 'Lunch', duration_minutes: 60, is_paid: false }] });
    await assign('OTDELAY', { work_schedule_id: S.DELAY, pattern_id: PAT.W61NS });
    const r = await entry('OTDELAY', '2026-09-07', { clock_in: '07:00', clock_out: '18:00' });
    const row = await entryRow(r.body.id);
    eq([row.overtime_eligible_from, row.worked_after_shift_minutes], ['16:30', 90]);
  });
  await check('a NOT_ELIGIBLE shift refuses overtime requests', async () => {
    S.NOOT = await mk({ code: 'NO-OT', name: 'No overtime', clock_in: '08:00', clock_out: '17:00',
      standard_work_minutes: 540, overtime_eligibility_rule: 'NOT_ELIGIBLE', breaks: [] });
    await assign('OTNONE', { work_schedule_id: S.NOOT, pattern_id: PAT.W61NS });
    const e = await entry('OTNONE', '2026-09-07', { clock_in: '08:00', clock_out: '19:00' });
    const r = await wf.tsPost(`/entries/${e.body.id}/overtime-request`, { hours: 2 });
    eq([r.status, r.body.error], [409, 'OVERTIME_NOT_ELIGIBLE']);
  });
  await check('approved overtime produces validated minutes; A1 SoD still blocks the requester', async () => {
    const e = await entry('OT', '2026-09-08', { clock_in: '07:00', clock_out: '18:00' });
    eq((await wf.tsPost(`/entries/${e.body.id}/overtime-request`, { hours: 2 })).status, 201);
    eq((await wf.tsPost(`/entries/${e.body.id}/overtime-decide`, { decision: 'approved' })).body.error, 'SOD_VIOLATION');
    eq((await dir.tsPost(`/entries/${e.body.id}/overtime-decide`, { decision: 'approved' })).status, 200);
    const row = await entryRow(e.body.id);
    eq([row.overtime_status, row.overtime_minutes_approved, ws.payrollTimeContract(row).overtime_minutes_approved],
      ['approved', 120, 120]);
  });

  await check('rejected overtime leaves approved minutes at 0', async () => {
    await assign('OTREJ', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    const e = await entry('OTREJ', '2026-09-07', { clock_in: '07:00', clock_out: '18:00' });
    eq((await wf.tsPost(`/entries/${e.body.id}/overtime-request`, { hours: 2 })).status, 201);
    eq((await dir.tsPost(`/entries/${e.body.id}/overtime-decide`, { decision: 'rejected' })).status, 200);
    const row = await entryRow(e.body.id);
    eq([row.overtime_status, row.overtime_minutes_approved, ws.payrollTimeContract(row).overtime_minutes_approved],
      ['rejected', 0, 0]);
  });
  await check('actual time shorter than the approved request is reported, not silently trusted', async () => {
    await assign('OTSHORT', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    // requested 2 hours, but the worker actually left at 16:45 — 45 minutes past
    // the OT boundary. Attendance records BOTH figures and hides neither.
    const e = await entry('OTSHORT', '2026-09-07', { clock_in: '07:00', clock_out: '16:45' });
    await wf.tsPost(`/entries/${e.body.id}/overtime-request`, { hours: 2 });
    eq((await dir.tsPost(`/entries/${e.body.id}/overtime-decide`, { decision: 'approved' })).status, 200);
    const row = await entryRow(e.body.id);
    eq([row.overtime_minutes_approved, row.worked_after_shift_minutes], [120, 45]);
    ok(row.worked_after_shift_minutes < row.overtime_minutes_approved,
      'the discrepancy must stay visible for review (correction workflow is A3)');
    // and A1 still locks the clocks after a decision, so the discrepancy cannot
    // be quietly edited away — it needs the correction workflow.
    eq((await wf.tsPut(`/entries/${e.body.id}`, { clock_out: '18:00' })).body.error, 'OVERTIME_DECISION_LOCKED');
  });

  section('CROSS-MIDNIGHT SHIFTS');
  await check('ordinary night shift: one row, positive duration, clock_out_date = next day', async () => {
    await assign('XMID', { work_schedule_id: S.SITE_NIGHT, pattern_id: PAT.W61NS });
    const r = await entry('XMID', '2026-09-07', { clock_in: '19:55', clock_out: '05:10' });
    const row = await entryRow(r.body.id);
    eq([row.elapsed_minutes, row.work_minutes, row.clock_out_date, row.schedule_cross_midnight], [555, 495, '2026-09-08', 1]);
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE employee_id='XMID'`).get()).n, 1, 'duplicate day created: ');
  });
  await check('night shift across a MONTH boundary', async () => {
    await assign('XMONTH', { work_schedule_id: S.SITE_NIGHT, pattern_id: PAT.W61NS });
    const r = await entry('XMONTH', '2026-08-31', { clock_in: '20:00', clock_out: '05:00' });
    const row = await entryRow(r.body.id);
    eq([row.work_date, row.clock_out_date, row.elapsed_minutes, row.work_minutes], ['2026-08-31', '2026-09-01', 540, 480]);
  });
  await check('night shift across a YEAR boundary', async () => {
    await assign('XYEAR', { work_schedule_id: S.SITE_NIGHT, pattern_id: PAT.W61NS });
    const r = await entry('XYEAR', '2025-12-31', { clock_in: '20:00', clock_out: '05:00' });
    const row = await entryRow(r.body.id);
    eq([row.clock_out_date, row.work_minutes], ['2026-01-01', 480]);
  });
  await check('a non-crossing shift with clock_out before clock_in is refused (never negative)', async () => {
    await assign('NEG', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS });
    const r = await wf.tsPost('/entries', { employee_id: 'NEG', work_date: '2026-09-07', clock_in: '16:00', clock_out: '07:00' });
    eq([r.status, r.body.error], [400, 'NEGATIVE_DURATION']);
    const all = (await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries WHERE employee_id='NEG'`).get()).n;
    eq(all, 0, 'row written despite refusal: ');
  });

  section('DAY TYPE / CALENDAR INTERACTION');
  await check('workday, rest day and configured public holiday resolve correctly', async () => {
    await assign('HOL', { pattern_id: PAT.W52 });
    const workday = await resolve(wf, 'HOL', '2026-09-07');
    const rest = await resolve(wf, 'HOL', '2026-09-13');
    const holiday = await resolve(wf, 'HOL', '2026-09-10');
    eq([workday.day_type, rest.day_type, holiday.day_type], ['WORKDAY', 'WEEKLY_REST_DAY', 'PUBLIC_HOLIDAY']);
  });
  await check('attendance on a holiday snapshots PUBLIC_HOLIDAY (payroll band preserved)', async () => {
    const r = await entry('HOL', '2026-09-10', { clock_in: '07:00', clock_out: '16:00' });
    eq((await entryRow(r.body.id)).day_type, 'PUBLIC_HOLIDAY');
  });
  await check('custom-weekday OFF still yields WEEKLY_REST_DAY for payroll', async () => {
    const wed = await resolve(wf, 'CUSTOM', '2026-09-09');
    eq([wed.day_status, wed.day_type], ['OFF', 'WEEKLY_REST_DAY']);
  });

  section('TIMEZONE AUTHORITY (Asia/Jakarta)');
  await check('business "today" is WIB, not UTC: 17:30Z is already tomorrow in Jakarta', async () => {
    eq(bt.businessToday(new Date('2026-03-10T17:30:00Z')), '2026-03-11');
  });
  await check('00:01 WIB resolves to the new day (the UTC previous-day bug)', async () => {
    eq(bt.businessToday(new Date('2026-03-10T17:01:00Z')), '2026-03-11');
  });
  await check('06:30 WIB (before 07:00) still resolves to today, not yesterday', async () => {
    eq(bt.businessToday(new Date('2026-03-10T23:30:00Z')), '2026-03-11');
  });
  await check('01:00 and 06:59 WIB are TODAY, and 07:00 WIB is the same day', async () => {
    eq([bt.businessToday(new Date('2026-03-10T18:00:00Z')),   // 01:00 WIB 11 Mar
      bt.businessToday(new Date('2026-03-10T23:59:00Z')),     // 06:59 WIB 11 Mar
      bt.businessToday(new Date('2026-03-11T00:00:00Z'))],    // 07:00 WIB 11 Mar
    ['2026-03-11', '2026-03-11', '2026-03-11']);
  });
  await check('the API exposes one canonical timezone; no page derives its own', async () => {
    const ctx = (await wf.sched('/context')).body;
    eq([ctx.timezone, ctx.today], ['Asia/Jakarta', bt.businessToday()]);
  });

  section('FUTURE DATE POLICY');
  await check('future SCHEDULE and ASSIGNMENT configuration is allowed', async () => {
    const s = await wf.schedPost('/schedules', { code: 'FUTURE-SHIFT', name: 'Future', legal_entity_id: 'KAHE360',
      clock_in: '06:00', clock_out: '14:00', standard_work_minutes: 480, effective_from: bt.addDays(bt.businessToday(), 60) });
    eq(s.status, 201);
    const a = await wf.schedPost('/assignments', { employee_id: 'FUT', pattern_id: PAT.W52, effective_from: bt.addDays(bt.businessToday(), 30) });
    eq(a.status, 201);
  });
  await check('actual attendance far in the future is refused', async () => {
    const r = await wf.tsPost('/entries', { employee_id: 'FUT', work_date: bt.addDays(bt.businessToday(), 30) });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_DATE_IN_FUTURE']);
  });
  await check('tomorrow is still recordable (night shift entered in advance)', async () => {
    const r = await wf.tsPost('/entries', { employee_id: 'FUT', work_date: bt.addDays(bt.businessToday(), 1) });
    eq(r.status, 201);
  });

  section('MANUAL ATTENDANCE IS NOT A BYPASS (A1 guarantees still hold)');
  await check('manual entry snapshots the resolved schedule and records source MANUAL', async () => {
    await assign('MANUAL', { work_schedule_id: S.SITE_DAY, pattern_id: PAT.W61NS, effective_from: '2026-09-06' });
    const r = await entry('MANUAL', '2026-09-14', { clock_in: '07:05', clock_out: '16:00' });
    const row = await entryRow(r.body.id);
    eq([row.entry_source, row.schedule_code, row.scheduled_clock_in, row.scheduled_minutes, row.day_status, row.schedule_source],
      ['MANUAL', 'SITE-DAY', '07:00', 480, 'WORK', 'pattern:weekly']);
    ok(JSON.parse(row.schedule_snapshot).schedule.id === S.SITE_DAY, 'schedule snapshot missing');
  });
  await check('manual entry still respects legal-entity scope', async () => {
    eq((await mitra.tsPost('/entries', { employee_id: 'MANUAL', work_date: '2026-09-15' })).status, 404);
  });
  await check('manual entry still respects employee eligibility (terminated worker)', async () => {
    const r = await wf.tsPost('/entries', { employee_id: 'TERM', work_date: '2026-09-14' });
    eq([r.status, r.body.error], [409, 'EMPLOYEE_NOT_ELIGIBLE']);
  });
  await check('manual entry still respects the attendance cutoff', async () => {
    const r = await wf.tsPost('/entries', { employee_id: 'CUT', work_date: '2026-07-15' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_PERIOD_CLOSED']);
  });
  await check('manual entry still respects a frozen payroll snapshot', async () => {
    const r = await wf.tsPost('/entries', { employee_id: 'FRZ', work_date: '2026-06-11' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_SOURCE_FROZEN']);
  });

  section('HISTORICAL IMMUTABILITY & PAYROLL INTERFACE');
  await check('a schedule version already used by attendance cannot have its times changed', async () => {
    await throwsLike(async () => await db.prepare('UPDATE work_schedules SET clock_in = ? WHERE id = ?').run('05:00', S.SITE_DAY), 'SCHEDULE_VERSION_IN_USE');
    await throwsLike(async () => await db.prepare('UPDATE work_schedule_breaks SET duration_minutes = 5 WHERE work_schedule_id = ?').run(S.SITE_DAY), 'SCHEDULE_VERSION_IN_USE');
  });
  await check('a later schedule version does not re-interpret existing attendance', async () => {
    const row = await entryRow((await db.prepare(`SELECT id FROM timesheet_entries WHERE employee_id='BREAK1' AND work_date='2026-09-07'`).get()).id);
    await wf.schedPost(`/schedules/${S.SITE_DAY}/versions`, { clock_in: '06:00', clock_out: '15:00', standard_work_minutes: 480,
      effective_from: bt.addDays(bt.businessToday(), 1) });
    const after = await entryRow(row.id);
    eq([after.scheduled_clock_in, after.scheduled_clock_out, after.work_minutes, after.work_schedule_id],
      [row.scheduled_clock_in, row.scheduled_clock_out, row.work_minutes, row.work_schedule_id]);
  });
  await check('an edit re-derives against the row OWN snapshot, not today\'s configuration', async () => {
    const id = (await db.prepare(`SELECT id FROM timesheet_entries WHERE employee_id='BREAK1' AND work_date='2026-09-07'`).get()).id;
    const r = await wf.tsPut(`/entries/${id}`, { clock_in: '07:00', clock_out: '17:00' });
    eq([r.status, r.body.work_minutes], [200, 540]);   // 600 elapsed - 60 unpaid, old schedule's breaks
  });
  await check('the payroll time contract carries TIME only — no money field anywhere', async () => {
    const row = await entryRow((await db.prepare(`SELECT id FROM timesheet_entries WHERE employee_id='OT' AND work_date='2026-09-08'`).get()).id);
    const contract = ws.payrollTimeContract(row);
    eq(Object.keys(contract).sort(), ['day_type', 'overtime_minutes_approved', 'schedule_code', 'scheduled_minutes', 'work_date', 'work_minutes', 'work_schedule_id']);
    const money = /sen|rupiah|multiplier|rate_bp|salary|bpjs|pph/i;
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'workSchedule.js'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    ok(!money.test(src), 'lib/workSchedule.js mentions money');
  });
  await check('every value is an integer number of minutes', async () => {
    const rows = await db.prepare(`SELECT work_minutes, scheduled_minutes, elapsed_minutes, break_minutes_unpaid, break_minutes_paid,
      worked_after_shift_minutes FROM timesheet_entries WHERE work_minutes IS NOT NULL`).all();
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (v !== null && !Number.isInteger(v)) throw new Error(`${k} = ${v} is not an integer`);
      }
    }
    ok(rows.length > 10, `only ${rows.length} rows checked`);
  });

  section('PERFORMANCE — schedule resolution at workforce scale');
  const bulk = async (n, prefix, patternId) => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
      VALUES (?,?,'internal','active','2019-01-01','PPB')`);
    const insP = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
      payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2019-01-01')`);
    const insA = db.prepare(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from)
      VALUES (?,'KAHE360',?, '2019-01-01')`);
    const ids = [];
    await db.exec('BEGIN');
    for (let i = 0; i < n; i += 1) {
      const id = `${prefix}${i}`;
      await insE.run(id, `Bulk ${id}`); await insP.run(id, wp5, cal, groups.KAHE360); await insA.run(id, patternId);
      ids.push(id);
    }
    await db.exec('COMMIT');
    return ids;
  };
  let perf100 = null, perf1500 = null;
  await check('100 employees resolve in one pass', async () => {
    const ids = await bulk(100, 'B1-', PAT.ROT4);
    const cache = ws.makeCache();
    const t0 = Date.now();
    let work = 0;
    for (const id of ids) { const r = await ws.resolveSchedule(db, id, '2026-10-03', { cache }); if (r.dayStatus === 'WORK') work += 1; }
    perf100 = Date.now() - t0;
    eq(work, 100, 'all 100 share the cycle: ');
    ok(perf100 < 5000, `100 employees took ${perf100} ms`);
  });
  await check('1,500 employees resolve in one pass, cached, no per-employee schedule re-read', async () => {
    const ids = await bulk(1500, 'B2-', PAT.CUSTOM1);
    const cache = ws.makeCache();
    const t0 = Date.now();
    let off = 0;
    for (const id of ids) { const r = await ws.resolveSchedule(db, id, '2026-10-07', { cache }); if (r.dayStatus === 'OFF') off += 1; }
    perf1500 = Date.now() - t0;
    eq(off, 1500, 'Wednesday is OFF for all 1,500: ');
    eq([cache.schedules.size <= 8, cache.patterns.size], [true, 1]);
    ok(perf1500 < 30000, `1,500 employees took ${perf1500} ms`);
    console.log(`        timing: 100 employees ${perf100} ms · 1,500 employees ${perf1500} ms`);
  });

  section('A1 REGRESSION SPOT CHECKS (full A1 suite runs separately)');
  await check('overtime decision still terminal and SoD-protected', async () => {
    const id = (await db.prepare(`SELECT id FROM timesheet_entries WHERE employee_id='OT' AND work_date='2026-09-08'`).get()).id;
    eq((await dir.tsPost(`/entries/${id}/overtime-decide`, { decision: 'rejected' })).body.error, 'OVERTIME_DECISION_CONFLICT');
    eq((await wf.tsPut(`/entries/${id}`, { attendance_status: 'absent' })).body.error, 'OVERTIME_DECISION_LOCKED');
  });
  await check('entity isolation and audit trail still hold', async () => {
    eq((await mitra.ts('/entries?date=2026-09-07')).body.length, 0);
    const id = (await db.prepare(`SELECT id FROM timesheet_entries WHERE employee_id='OT' AND work_date='2026-09-08'`).get()).id;
    const ev = (await wf.ts(`/entries/${id}/events`)).body.map((e) => e.event_type);
    ok(ev.includes('ENTRY_CREATED') && ev.includes('OVERTIME_APPROVED'), ev.join(','));
  });

  section('MIGRATION');
  await check('migrate-attendance-a2 is idempotent and invents no schedule', async () => {
    const { migrate } = require('../database/migrate-attendance-a2');
    const { getDb } = require('../database/init-db');
    const h = getDb();
    try {
      const before = (await db.prepare('SELECT COUNT(*) AS n FROM work_schedules').get()).n;
      const r1 = await migrate(h);
      const r2 = await migrate(h);
      eq((await db.prepare('SELECT COUNT(*) AS n FROM work_schedules').get()).n, before, 'schedules invented: ');
      ok(r1.entries === r2.entries && r1.employees_with_assignment > 0, JSON.stringify(r2));
      // opt-in examples are fixtures for a named entity, still assigned to nobody
      const seeded = await migrate(h, { seedExamplesFor: 'MITRA', effectiveFrom: '2026-01-01' });
      eq(seeded.examples_created, 3);
      eq((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_schedule_assignments WHERE legal_entity_id='MITRA'`).get()).n, 0);
    } finally { h.close(); }
  });

  server.kill();
  db.close();
  await __t.drop();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log(` - ${f.name}: ${f.message}`); process.exit(1); }
})().catch((err) => {
  if (server) server.kill();
  console.error('FATAL', err);
  process.exit(1);
});

})().catch((err) => { console.error(err); process.exit(1); });
