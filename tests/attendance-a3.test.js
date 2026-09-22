(async () => {
// tests/attendance-a3.test.js
// Attendance A3 — correction, void, exception, payroll impact, immutable audit.
//
// Same discipline as A1/A2: the REAL server.js over HTTP, the REAL seed.js
// RBAC, real sessions, a throwaway SQLite database via KAHE360_DB_PATH.
// Usage: npm run test:attendance-a3

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');
const __t = await createTestDatabase('attendance_a3');
process.env.DATABASE_URL = __t.appUrl;   // the REAL server and seed run against this throwaway PostgreSQL database
const bcrypt = require('bcryptjs');
const bt = require('../lib/businessTime');
const ac = require('../lib/attendanceCorrection');

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
for (const [id, name, type] of [['KAHE360', 'KAHE', 'internal'], ['MITRA', 'Mitra Jaya', 'subkontraktor']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2019-01-01') ON CONFLICT DO NOTHING`).run(id, name, type);
}
const wp = Number((await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date)
  VALUES ('5H',5,'sunday','2019-01-01') RETURNING id`).run()).lastInsertRowid);
const cal = Number((await db.prepare(`INSERT INTO work_calendars (code,name,effective_from) VALUES ('A3CAL','A3','2019-01-01') RETURNING id`).run()).lastInsertRowid);

const groups = {};
for (const e of ['KAHE360', 'MITRA']) {
  groups[e] = Number((await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2019-01-01') RETURNING id`)
    .run(`${e}-A3`, `${e} A3`, e)).lastInsertRowid);
}
const FAR = '2099-12-31';
async function period(entity, y, m, attCut = FAR, otCut = FAR) {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return Number((await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN') RETURNING id`).run(groups[entity], y, m, m, start, end, attCut, otCut, FAR, FAR)).lastInsertRowid);
}
const P_SEP = await period('KAHE360', 2026, 9);
const P_AUG = await period('KAHE360', 2026, 8);
const P_JUL = await period('KAHE360', 2026, 7);       // FINALIZED payroll run lives here
const P_JUN = await period('KAHE360', 2026, 6);       // FROZEN snapshot, no finalized run
await period('MITRA', 2026, 9);

// A FINALIZED payroll run over July 2026: corrections there must NEVER edit it.
const RUN_JUL = Number((await db.prepare(`INSERT INTO payroll_runs (payroll_period_id,legal_entity_id,run_number,run_type,status,
  prepared_by,prepared_at,finalized_by,finalized_at)
  VALUES (?, 'KAHE360', 1, 'ORIGINAL', 'FINALIZED', 'fixture', kahe_now(), 'fixture', kahe_now()) RETURNING id`)
  .run(P_JUL)).lastInsertRowid);

const EMPLOYEES = ['E-OPEN', 'E-OPEN2', 'E-VOID', 'E-VOID2', 'E-FINAL', 'E-FROZEN', 'E-LATE', 'E-LATE2', 'E-NOIMPACT',
  'E-EXC1', 'E-EXC2', 'E-EXC3', 'E-EXC4', 'E-EXC5', 'E-SOD', 'E-SCOPE', 'E-HIST', 'E-EVID', 'E-CANCEL', 'E-ROLE'];
async function hire(id, entity = 'KAHE360') {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
              VALUES (?,?,'internal','active','2019-01-01','PPB')`).run(id, `Pekerja ${id}`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2019-01-01')`)
    .run(id, entity, wp, cal, groups[entity]);
}
for (const e of EMPLOYEES) await hire(e);
await hire('M-1', 'MITRA');

// A2 schedule so worked minutes are derived, not guessed.
const SCHED = Number((await db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,schedule_type,clock_in,clock_out,
  standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by)
  VALUES ('SITE-DAY','Site Day','KAHE360','SITE','07:00','16:00',480,0,'AFTER_SHIFT_END','2019-01-01','fixture') RETURNING id`)
  .run()).lastInsertRowid);
await db.prepare(`INSERT INTO work_schedule_breaks (work_schedule_id,name,duration_minutes,is_paid,sequence)
  VALUES (?, 'Istirahat', 60, 0, 1)`).run(SCHED);
const PAT = Number((await db.prepare(`INSERT INTO attendance_work_patterns (code,name,legal_entity_id,pattern_type,effective_from,created_by)
  VALUES ('A3W','A3 weekly','KAHE360','FIXED_WEEKLY','2019-01-01','fixture') RETURNING id`).run()).lastInsertRowid);
for (let i = 1; i <= 7; i += 1) {
  await db.prepare(`INSERT INTO attendance_pattern_days (pattern_id,day_index,day_status,work_schedule_id)
    VALUES (?,?,?,?)`).run(PAT, i, i === 7 ? 'OFF' : 'WORK', i === 7 ? null : SCHED);
}
for (const e of EMPLOYEES) {
  await db.prepare(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,effective_from,created_by)
    VALUES (?,'KAHE360',?, '2019-01-01','fixture')`).run(e, PAT);
}

const roleId = async (code) => (await db.prepare('SELECT id FROM roles WHERE code = ?').get(code)).id;
const userId = async (email) => (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
async function makeUser(email, name, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email,display_name,password_hash,is_active) VALUES (?,?,?,1) RETURNING id`)
    .run(email, name, bcrypt.hashSync(PASSWORD, 4))).lastInsertRowid);
  await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)').run(id, await roleId(role));
  return id;
}
const grant = async (uid, e) => await db.prepare(`INSERT INTO user_legal_entity_scope (user_id,legal_entity_id,granted_by)
  VALUES (?,?,'test') ON CONFLICT DO NOTHING`).run(uid, e);
const U = {
  director: await userId('director@kahe360.local'),
  wf: await userId('workforce@kahe360.local'),
  hrd: await userId('hrd@kahe360.local'),
  payroll: await userId('payroll@kahe360.local'),
  wf2: await makeUser('wf2.a3@t.local', 'Rudi Hartono', 'workforce_manager'),
  sup: await makeUser('sup.a3@t.local', 'Supervisor Asep', 'supervisor'),
  mitra: await makeUser('mitra.a3@t.local', 'Mitra WF', 'workforce_manager'),
  admin: await makeUser('sysadmin.a3@t.local', 'Sys Admin', 'hse_officer'),  // technical-ish role: no correction authority
};
for (const k of ['director', 'wf', 'hrd', 'payroll', 'wf2', 'sup', 'admin']) await grant(U[k], 'KAHE360');
await grant(U.mitra, 'MITRA');

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
    c: (u) => call('GET', `/api/attendance-correction${u}`),
    cPost: (u, b) => call('POST', `/api/attendance-correction${u}`, b),
    tsPost: (u, b) => call('POST', `/api/timesheet${u}`, b),
    tsPut: (u, b) => call('PUT', `/api/timesheet${u}`, b),
  };
}
const entryRow = async (id) => await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);
const corrRow = async (id) => await db.prepare('SELECT * FROM attendance_corrections WHERE id = ?').get(id);

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
  const wf = await login('workforce@kahe360.local');       // requester + approver authority
  const wf2 = await login('wf2.a3@t.local');               // second approver (SoD partner)
  const hrd = await login('hrd@kahe360.local');
  const pay = await login('payroll@kahe360.local');
  const dir = await login('director@kahe360.local');
  const sup = await login('sup.a3@t.local');
  const mitra = await login('mitra.a3@t.local');
  const hse = await login('sysadmin.a3@t.local');

  // attendance rows used by the tests (recorded through the real A1/A2 route)
  const entries = {};
  async function makeEntry(emp, date, body = { clock_in: '07:00', clock_out: '16:00' }) {
    const r = await wf.tsPost('/entries', { employee_id: emp, work_date: date, ...body });
    if (r.status !== 201) throw new Error(`entry ${emp} ${date}: ${JSON.stringify(r.body)}`);
    entries[`${emp}|${date}`] = r.body.id;
    return r.body.id;
  }
  const E = (emp, date) => entries[`${emp}|${date}`];

  section('CORRECTION POLICY');
  let POLICY_ID = null;
  await check('create an effective-dated correction policy (no window is hardcoded)', async () => {
    const r = await wf.cPost('/policies', {
      code: 'CORR-KAHE', name: 'Kebijakan koreksi KAHE', legal_entity_id: 'KAHE360',
      correction_window: 3, window_unit: 'DAYS', allow_late_correction: true, late_requires_approval: true,
      evidence_requirement: 'OPTIONAL', post_finalized_evidence_required: true,
      abnormal_duration_ratio_pct: 150, ot_grace_minutes: 30, ot_mismatch_tolerance_minutes: 15,
      effective_from: '2019-01-01',
    });
    eq(r.status, 201); POLICY_ID = r.body.id;
    const list = (await wf.c('/policies')).body;
    eq(list.length, 1);
    eq([list[0].correction_window, list[0].window_unit, list[0].allow_late_correction], [3, 'DAYS', 1]);
  });
  await check('a second OPEN policy for the same entity is rejected', async () => {
    const r = await wf.cPost('/policies', { code: 'DUP', name: 'x', legal_entity_id: 'KAHE360',
      correction_window: 5, effective_from: '2026-01-01' });
    eq([r.status, r.body.error], [409, 'POLICY_OPEN_EXISTS']);
  });
  await check('policy versions are effective-dated; history resolves the OLD window', async () => {
    const r = await wf.cPost(`/policies/${POLICY_ID}/versions`, {
      name: 'Kebijakan koreksi KAHE v2', correction_window: 5, effective_from: '2027-01-01',
    });
    eq(r.status, 201);
    const oct = (await wf.c('/policies/resolve/KAHE360/2026-10-15')).body;
    const jan = (await wf.c('/policies/resolve/KAHE360/2027-01-15')).body;
    eq([oct.policy.correction_window, jan.policy.correction_window], [3, 5]);
    eq(oct.policy.effective_to, '2026-12-31');
  });
  await check('an overlapping policy version is rejected', async () => {
    const r = await wf.cPost(`/policies/${POLICY_ID}/versions`, { correction_window: 9, effective_from: '2019-06-01' });
    eq([r.status, r.body.error], [409, 'POLICY_VERSION_OVERLAP']);
  });
  await check('policy configuration needs EDIT; a Supervisor cannot set the window', async () => {
    const r = await sup.cPost('/policies', { code: 'SUP', name: 'x', legal_entity_id: 'KAHE360',
      correction_window: 30, effective_from: '2026-01-01' });
    eq(r.status, 403);
  });

  section('CORRECTION WORKFLOW (open period)');
  const today = bt.businessToday();
  // The fixture pattern makes Sunday a rest day, so attendance fixtures use
  // real working days — otherwise every row would resolve with no schedule.
  const workdays = [];
  for (let d = bt.addDays(today, -1); workdays.length < 8; d = bt.addDays(d, -1)) {
    if (bt.isoWeekday(d) !== 7) workdays.push(d);
  }
  const recent = workdays[0];
  await check('a correction inside the window: draft -> submit -> review -> approve -> applied', async () => {
    const id = await makeEntry('E-OPEN', recent, { clock_in: '07:00', clock_out: '16:00' });
    const created = await sup.cPost('/requests', {
      timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT', reason_text: 'Lupa tap pulang',
      proposed_values: { clock_out: '18:00' }, submit: false,
    });
    eq([created.status, created.body.status, created.body.payroll_impact],
      [201, 'DRAFT', 'PAYROLL_IMPACT_OPEN_PERIOD']);
    const cid = created.body.id;
    eq((await sup.cPost(`/requests/${cid}/submit`)).body.status, 'SUBMITTED');
    eq((await wf.cPost(`/requests/${cid}/review`, { note: 'Cocok dengan log gate' })).body.status, 'UNDER_REVIEW');
    const decided = await wf.cPost(`/requests/${cid}/decide`, { decision: 'approved' });
    eq([decided.status, decided.body.status, decided.body.applied], [200, 'APPLIED', true]);
    const row = await entryRow(id);
    // 07:00-18:00 = 660 elapsed - 60 unpaid break = 600
    eq([row.clock_out, row.work_minutes, row.record_status, row.current_version], ['18:00', 600, 'EFFECTIVE', 2]);
    eq(decided.body.delta.delta_work_minutes, 120);
  });
  await check('the ORIGINAL record is preserved as version 1 and stays readable', async () => {
    const id = E('E-OPEN', recent);
    const hist = (await wf.c(`/entries/${id}/history`)).body;
    eq(hist.versions.length, 2);
    eq([hist.versions[0].version_type, hist.versions[0].payload.clock_out, hist.versions[0].payload.work_minutes],
      ['ORIGINAL', '16:00', 480]);
    eq([hist.versions[1].version_type, hist.versions[1].payload.clock_out, hist.versions[1].is_effective],
      ['CORRECTION', '18:00', 1]);
    ok(hist.events.some((e) => e.event_type === 'CORRECTION_APPLIED'), 'no CORRECTION_APPLIED event');
  });
  await check('a rejected correction changes nothing on the record', async () => {
    const id = await makeEntry('E-OPEN2', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'DATA_ENTRY_ERROR',
      proposed_values: { clock_out: '20:00' } });
    const r = await wf.cPost(`/requests/${c.body.id}/decide`, { decision: 'rejected', reason: 'Tidak ada bukti' });
    eq([r.status, r.body.status], [200, 'REJECTED']);
    eq([(await entryRow(id)).clock_out, (await entryRow(id)).work_minutes], ['16:00', 480]);
  });
  await check('the requester can cancel their own request; a cancelled request is kept, not deleted', async () => {
    const id = await makeEntry('E-CANCEL', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_in: '06:30' } });
    eq((await sup.cPost(`/requests/${c.body.id}/cancel`, { reason: 'Salah orang' })).body.status, 'CANCELLED');
    eq((await corrRow(c.body.id)).status, 'CANCELLED');
    ok((await db.prepare('SELECT COUNT(*) AS n FROM attendance_correction_actions WHERE correction_id = ?').get(c.body.id)).n >= 2);
  });
  await check('derived values are recomputed server-side, never taken from the request', async () => {
    const id = await makeEntry('E-NOIMPACT', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'DATA_ENTRY_ERROR',
      proposed_values: { clock_in: '07:00', clock_out: '16:00', work_minutes: 999 } });
    ok(c.status === 400 || (c.status === 201 && c.body.projected.work_minutes === 480),
      `work_minutes was trusted: ${JSON.stringify(c.body)}`);
  });
  await check('a field outside the correctable set is refused', async () => {
    const id = E('E-NOIMPACT', recent);
    const r = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER',
      proposed_values: { overtime_minutes_approved: 300 } });
    eq([r.status, r.body.error], [400, 'FIELD_NOT_CORRECTABLE']);
  });
  await check('an unknown reason code is refused', async () => {
    const id = E('E-NOIMPACT', recent);
    const r = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'BECAUSE', proposed_values: { clock_in: '06:00' } });
    eq([r.status, r.body.error], [400, 'INVALID_REASON_CODE']);
  });
  await check('metadata-only correction is classified NO_PAYROLL_IMPACT', async () => {
    const id = await makeEntry('E-HIST', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'DATA_ENTRY_ERROR',
      proposed_values: { workfront: 'Piling', note: 'workfront salah' } });
    eq(c.body.payroll_impact, 'NO_PAYROLL_IMPACT');
    const r = await wf.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([r.body.applied, r.body.impact], [true, 'NO_PAYROLL_IMPACT']);
    eq((await entryRow(id)).workfront, 'Piling');
  });

  section('SEGREGATION OF DUTIES & ROLE MATRIX');
  await check('the requester cannot approve their own correction (stable user ID)', async () => {
    const id = await makeEntry('E-SOD', recent);
    const c = await wf.cPost('/requests', { timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '17:00' } });
    const self = await wf.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([self.status, self.body.error], [403, 'SOD_VIOLATION']);
    const other = await wf2.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq(other.status, 200);
  });
  await check('a Supervisor cannot approve anything (no APPROVE permission)', async () => {
    const id = await makeEntry('E-OPEN', workdays[1]);
    const c = await wf.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_out: '17:00' } });
    const r = await sup.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([r.status, r.body.error], [403, 'FORBIDDEN']);
    await wf2.cPost(`/requests/${c.body.id}/decide`, { decision: 'rejected', reason: 'cleanup' });
  });
  await check('a role without the module cannot request or approve, whatever its seniority', async () => {
    const id = E('E-SOD', recent);
    eq((await hse.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_in: '06:00' } })).status, 403);
    eq((await hse.c('/requests')).status, 403);
  });
  await check('Payroll Officer cannot edit raw attendance nor approve an attendance correction', async () => {
    const id = await makeEntry('E-OPEN2', workdays[1]);
    eq((await pay.tsPut(`/entries/${id}`, { clock_out: '19:00' })).status, 403);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_out: '17:00' } });
    eq((await pay.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' })).status, 403);
    await wf2.cPost(`/requests/${c.body.id}/decide`, { decision: 'rejected', reason: 'cleanup' });
  });
  await check('the approval inbox never shows the actor their own requests', async () => {
    const id = await makeEntry('E-OPEN', workdays[2]);
    const mine = await wf.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER',
      proposed_values: { clock_out: '17:30' }, late_reason: 'diketahui terlambat' });
    const own = (await wf.c('/requests?inbox=1')).body.map((r) => r.id);
    const others = (await wf2.c('/requests?inbox=1')).body.map((r) => r.id);
    ok(!own.includes(mine.body.id), 'own request appeared in own inbox');
    ok(others.includes(mine.body.id), 'request missing from the other approver inbox');
    await wf2.cPost(`/requests/${mine.body.id}/decide`, { decision: 'rejected', reason: 'cleanup' });
  });
  await check('legal-entity isolation: a MITRA user cannot see or touch KAHE corrections', async () => {
    const id = E('E-SOD', recent);
    const c = await db.prepare('SELECT id FROM attendance_corrections WHERE timesheet_entry_id = ?').get(id);
    eq((await mitra.c(`/requests/${c.id}`)).status, 404);
    eq((await mitra.cPost(`/requests/${c.id}/decide`, { decision: 'approved' })).status, 404);
    eq((await mitra.c('/requests')).body.length, 0);
  });

  section('LATE CORRECTION');
  await check('a correction past the configured window is flagged LATE and needs a reason', async () => {
    const oldDate = bt.addDays(today, -20);
    const id = await makeEntry('E-LATE', oldDate);
    const noReason = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '18:00' } });
    eq([noReason.status, noReason.body.error], [400, 'LATE_REASON_REQUIRED']);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '18:00' }, late_reason: 'Log gate baru diterima dari security' });
    eq([c.status, c.body.is_late_correction], [201, true]);
    eq((await corrRow(c.body.id)).late_reason, 'Log gate baru diterima dari security');
    entries['LATE_C'] = c.body.id;
  });
  await check('a late correction raises a LATE_CORRECTION exception automatically', async () => {
    const rows = (await wf.c('/exceptions?type=LATE_CORRECTION')).body;
    ok(rows.some((x) => x.employee_id === 'E-LATE'), 'no LATE_CORRECTION exception');
  });
  await check('approving a late correction requires the dedicated late-approval permission', async () => {
    const cid = entries.LATE_C;
    // HRD holds attendance_correction:APPROVE and late:APPROVE — it should pass;
    // the Supervisor (no APPROVE at all) and Payroll (no APPROVE) must not.
    eq((await sup.cPost(`/requests/${cid}/decide`, { decision: 'approved' })).status, 403);
    const r = await hrd.cPost(`/requests/${cid}/decide`, { decision: 'approved' });
    eq([r.status, r.body.status], [200, 'APPLIED']);
    const ev = (await db.prepare(`SELECT event_type FROM attendance_events WHERE correction_id = ?`).all(cid)).map((e) => e.event_type);
    ok(ev.includes('LATE_CORRECTION_APPROVED'), ev.join(','));
  });
  await check('a policy that forbids late corrections refuses the request outright', async () => {
    await db.prepare(`INSERT INTO attendance_correction_policies (code,name,legal_entity_id,correction_window,allow_late_correction,
      late_requires_approval,evidence_requirement,effective_from,created_by)
      VALUES ('CORR-MITRA','Mitra ketat','MITRA',2,0,1,'OPTIONAL','2019-01-01','fixture')`).run();
    const r = await mitra.cPost('/requests', { timesheet_entry_id: 999999, reason_code: 'OTHER', proposed_values: { clock_in: '07:00' } });
    eq(r.status, 404);   // foreign / missing entry is a 404, never a leak
    // now a real MITRA row, 20 days old
    const oldDate = bt.addDays(today, -20);
    const mid = Number((await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
      legal_entity_id,day_type,day_type_source) VALUES ('M-1',?, 'present',480,8,'MITRA','WORKDAY','fixture') RETURNING id`).run(oldDate)).lastInsertRowid);
    const r2 = await mitra.cPost('/requests', { timesheet_entry_id: mid, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '18:00' }, late_reason: 'terlambat' });
    eq([r2.status, r2.body.error], [409, 'LATE_CORRECTION_NOT_ALLOWED']);
  });
  await check('evidence is enforced when the policy requires it', async () => {
    await db.prepare(`UPDATE attendance_correction_policies SET evidence_requirement = 'REQUIRED'
      WHERE legal_entity_id = 'KAHE360' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`)
      .run(recent, recent);
    const id = await makeEntry('E-EVID', recent);
    const r = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_out: '17:00' } });
    eq([r.status, r.body.error], [400, 'EVIDENCE_REQUIRED']);
    const ok2 = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER',
      proposed_values: { clock_out: '17:00' }, evidence_ref: 'GATE-LOG-118' });
    eq(ok2.status, 201);
    await db.prepare(`UPDATE attendance_correction_policies SET evidence_requirement = 'OPTIONAL'
      WHERE legal_entity_id = 'KAHE360' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`)
      .run(recent, recent);
  });

  section('VOID WORKFLOW');
  await check('void: requested -> reviewed -> approved -> VOIDED, original preserved', async () => {
    const id = await makeEntry('E-VOID', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, request_type: 'VOID',
      reason_code: 'DUPLICATE_RECORD', reason_text: 'Tercatat dua kali dari device' });
    eq([c.status, c.body.status], [201, 'VOID_REQUESTED']);
    eq((await wf.cPost(`/requests/${c.body.id}/review`)).body.status, 'VOID_REVIEWED');
    const r = await wf.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([r.status, r.body.status], [200, 'VOIDED']);
    const row = await entryRow(id);
    eq([row.record_status, row.work_minutes, row.overtime_minutes_approved], ['VOIDED', 0, 0]);
    // the row still exists and its pre-void state is recoverable
    const hist = (await wf.c(`/entries/${id}/history`)).body;
    eq(hist.versions[0].payload.work_minutes, 480, 'original minutes lost: ');
    eq(hist.versions[hist.versions.length - 1].version_type, 'VOID');
  });
  await check('a void needs a reason code and cannot be requested without the void permission', async () => {
    const id = await makeEntry('E-VOID2', recent);
    const noReason = await sup.cPost('/requests', { timesheet_entry_id: id, request_type: 'VOID' });
    eq(noReason.status, 400);
    eq((await pay.cPost('/requests', { timesheet_entry_id: id, request_type: 'VOID', reason_code: 'OTHER' })).status, 403);
  });
  await check('HRD may REQUEST a void but not approve it; Workforce Manager can', async () => {
    const id = E('E-VOID2', recent);
    const c = await hrd.cPost('/requests', { timesheet_entry_id: id, request_type: 'VOID', reason_code: 'DUPLICATE_RECORD' });
    eq(c.status, 201);
    eq((await hrd.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' })).status, 403);
    eq((await wf.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' })).body.status, 'VOIDED');
  });
  await check('a voided record cannot be corrected again, and no API hard-deletes it', async () => {
    const id = E('E-VOID', recent);
    const r = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_in: '06:00' } });
    eq([r.status, r.body.error], [409, 'ENTRY_VOIDED']);
    ok(!!await entryRow(id), 'record was deleted');
    eq((await wf.post(`/api/timesheet/entries/${id}`)).status, 404);   // no DELETE route exists
  });

  section('PAYROLL IMPACT & FINALIZED PAYROLL PROTECTION');
  await check('a frozen payroll snapshot routes the correction to payroll review, source untouched', async () => {
    const jun = '2026-06-10';
    const id = Number((await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,clock_in,clock_out,
      work_minutes,work_hours,legal_entity_id,day_type,day_type_source,work_schedule_id,schedule_code,scheduled_clock_in,
      scheduled_clock_out,scheduled_minutes,break_minutes_unpaid,break_minutes_paid)
      VALUES ('E-FROZEN',?, 'present','07:00','16:00',480,8,'KAHE360','WORKDAY','fixture',?, 'SITE-DAY','07:00','16:00',480,60,0) RETURNING id`)
      .run(jun, SCHED)).lastInsertRowid);
    await db.prepare(`INSERT INTO payroll_input_snapshots (payroll_period_id,employee_id,as_of_date,legal_entity_id,payroll_group_id,
      resolved_payload,payload_hash,resolved_at,status,frozen_at,frozen_by)
      VALUES (?, 'E-FROZEN','2026-06-30','KAHE360',?, '{}','x',kahe_now(),'FROZEN',kahe_now(),'test')`)
      .run(P_JUN, groups.KAHE360);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '18:00' }, late_reason: 'koreksi jauh ke belakang', evidence_ref: 'GATE-991' });
    eq(c.body.payroll_impact, 'PAYROLL_IMPACT_FROZEN_PERIOD');
    const r = await hrd.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([r.body.status, r.body.applied], ['PENDING_PAYROLL_REVIEW', false]);
    eq([(await entryRow(id)).clock_out, (await entryRow(id)).work_minutes], ['16:00', 480], 'frozen source was mutated: ');
    entries.FROZEN_C = c.body.id;
    entries.FROZEN_E = id;
  });
  await check('FINALIZED payroll + financial impact => PAYROLL_ADJUSTMENT_REQUIRED, nothing recalculated', async () => {
    const jul = '2026-07-15';
    const id = Number((await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,clock_in,clock_out,
      work_minutes,work_hours,legal_entity_id,day_type,day_type_source,work_schedule_id,schedule_code,scheduled_clock_in,
      scheduled_clock_out,scheduled_minutes,break_minutes_unpaid,break_minutes_paid,overtime_eligible_from)
      VALUES ('E-FINAL',?, 'present','07:00','16:00',480,8,'KAHE360','WORKDAY','fixture',?, 'SITE-DAY','07:00','16:00',480,60,0,'16:00') RETURNING id`)
      .run(jul, SCHED)).lastInsertRowid);
    const runBefore = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(RUN_JUL);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'MISSED_CLOCK_OUT',
      proposed_values: { clock_out: '19:00' }, late_reason: 'Timesheet lapangan terlambat', evidence_ref: 'TS-LAP-77' });
    eq([c.body.payroll_impact, c.body.delta.delta_work_minutes], ['PAYROLL_ADJUSTMENT_REQUIRED', 180]);
    const r = await hrd.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    eq([r.body.status, r.body.applied], ['PENDING_PAYROLL_REVIEW', false]);
    const row = await entryRow(id);
    eq([row.clock_out, row.work_minutes], ['16:00', 480], 'finalized-period source was edited: ');
    const runAfter = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(RUN_JUL);
    eq([runAfter.status, runAfter.id], [runBefore.status, runBefore.id], 'payroll run changed: ');
    eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_adjustments').get()).n, 0, 'attendance created a MONEY adjustment: ');
    entries.FINAL_C = c.body.id;
    entries.FINAL_E = id;
  });
  await check('the correction cannot progress without the Payroll Officer', async () => {
    const cid = entries.FINAL_C;
    eq((await wf.cPost(`/requests/${cid}/decide`, { decision: 'approved' })).status, 409);
    eq((await sup.cPost(`/requests/${cid}/payroll-review`, { decision: 'approved' })).status, 403);
    eq((await wf.cPost(`/requests/${cid}/payroll-review`, { decision: 'approved' })).status, 403);
    eq((await corrRow(cid)).status, 'PENDING_PAYROLL_REVIEW');
  });
  await check('Payroll Officer approval queues a TIME delta — no rupiah anywhere', async () => {
    const cid = entries.FINAL_C;
    const r = await pay.cPost(`/requests/${cid}/payroll-review`, { decision: 'approved', reason: 'Sesuai bukti lapangan' });
    eq([r.status, r.body.status], [200, 'QUEUED_FOR_PAYROLL']);
    const q = await db.prepare('SELECT * FROM attendance_payroll_adjustments WHERE correction_id = ?').get(cid);
    eq([q.impact_category, q.delta_work_minutes, q.payroll_review_status, q.queue_status, q.source_run_id],
      ['PAYROLL_ADJUSTMENT_REQUIRED', 180, 'APPROVED', 'QUEUED', RUN_JUL]);
    const keys = Object.keys(q).join(' ');
    ok(!/amount|sen|rupiah|rate/i.test(keys), `money field in the queue: ${keys}`);
    eq((await entryRow(entries.FINAL_E)).work_minutes, 480, 'source moved after queueing: ');
    eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_adjustments').get()).n, 0);
  });
  await check('the Payroll Officer can reject the financial impact', async () => {
    const cid = entries.FROZEN_C;
    const r = await pay.cPost(`/requests/${cid}/payroll-review`, { decision: 'rejected', reason: 'Bukti tidak memadai' });
    eq([r.status, r.body.status], [200, 'PAYROLL_REJECTED']);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM attendance_payroll_adjustments WHERE correction_id = ?').get(cid)).n, 0);
    eq((await entryRow(entries.FROZEN_E)).work_minutes, 480);
  });
  await check('the payroll queue and impact views are entity-scoped and permission-gated', async () => {
    eq((await pay.c('/payroll-queue')).body.length, 1);
    eq((await mitra.c('/payroll-queue')).body.length, 0);
    eq((await sup.c('/payroll-queue')).status, 403);
  });
  await check('generic attendance editing is still blocked on a frozen source (A1 protection intact)', async () => {
    const r = await wf.tsPut(`/entries/${entries.FROZEN_E}`, { clock_out: '18:00' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_SOURCE_FROZEN']);
  });

  section('EXCEPTION ENGINE');
  await check('scan detects missing clock-out, off-day attendance, abnormal duration and OT without approval', async () => {
    const d = workdays[3];
    await makeEntry('E-EXC1', d, { clock_in: '07:00' });                              // missing clock-out
    // 07:00-21:00 = 780 worked against 480 scheduled: past the configured 150% ratio.
    await makeEntry('E-EXC2', d, { clock_in: '07:00', clock_out: '21:00' });          // OT without approval + abnormal
    const sunday = (() => { let x = bt.addDays(today, -1); while (bt.isoWeekday(x) !== 7) x = bt.addDays(x, -1); return x; })();
    await makeEntry('E-EXC3', sunday, { clock_in: '08:00', clock_out: '12:00', work_hours: 4 });  // OFF-day attendance
    const r = await wf.cPost('/exceptions/scan', { from: bt.addDays(today, -40), to: today });
    ok(r.body.scanned > 3, `scanned ${r.body.scanned}`);
    const types = (await wf.c('/exceptions')).body.reduce((m, x) => { (m[x.exception_type] ||= []).push(x.employee_id); return m; }, {});
    ok((types.MISSING_CLOCK_OUT || []).includes('E-EXC1'), 'MISSING_CLOCK_OUT missing');
    ok((types.OT_WITHOUT_APPROVAL || []).includes('E-EXC2'), 'OT_WITHOUT_APPROVAL missing');
    ok((types.OFF_DAY_ATTENDANCE || []).includes('E-EXC3'), 'OFF_DAY_ATTENDANCE missing');
    ok((types.ABNORMAL_DURATION || []).includes('E-EXC2'), 'ABNORMAL_DURATION missing');
  });
  await check('abnormal duration follows the configured ratio, not a hardcoded 12-hour rule', async () => {
    // A 12-hour security shift, fully scheduled: 660 worked against 660 scheduled is NOT abnormal.
    const sec = Number((await db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,clock_in,clock_out,
      standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by)
      VALUES ('SEC-12','Security 12h','KAHE360','07:00','19:00',660,0,'AFTER_SHIFT_END','2019-01-01','fixture') RETURNING id`)
      .run()).lastInsertRowid);
    await db.prepare(`INSERT INTO work_schedule_breaks (work_schedule_id,name,duration_minutes,is_paid,sequence)
      VALUES (?, 'Istirahat', 60, 0, 1)`).run(sec);
    const d = workdays[4];
    const id = Number((await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,clock_in,clock_out,
      work_minutes,work_hours,legal_entity_id,day_type,day_type_source,work_schedule_id,schedule_code,scheduled_clock_in,
      scheduled_clock_out,scheduled_minutes,break_minutes_unpaid,worked_after_shift_minutes,overtime_status)
      VALUES ('E-EXC4',?, 'present','07:00','19:00',660,11,'KAHE360','WORKDAY','fixture',?, 'SEC-12','07:00','19:00',660,60,0,'none') RETURNING id`)
      .run(d, sec)).lastInsertRowid);
    await wf.cPost('/exceptions/scan', { from: d, to: d });
    const rows = (await wf.c(`/exceptions?from=${d}&to=${d}`)).body.filter((x) => x.employee_id === 'E-EXC4');
    eq(rows.filter((x) => x.exception_type === 'ABNORMAL_DURATION').length, 0,
      '12-hour scheduled shift wrongly flagged: ');
    ok(!!id);
  });
  await check('detection never modifies attendance', async () => {
    const before = await db.prepare('SELECT id, work_minutes, clock_out, attendance_status FROM timesheet_entries ORDER BY id').all();
    await wf.cPost('/exceptions/scan', { from: bt.addDays(today, -40), to: today });
    const after = await db.prepare('SELECT id, work_minutes, clock_out, attendance_status FROM timesheet_entries ORDER BY id').all();
    eq(after, before, 'the scan changed attendance: ');
  });
  await check('re-scanning does not pile up duplicate open exceptions', async () => {
    const countOf = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM attendance_exceptions
      WHERE status IN ('OPEN','ASSIGNED','REOPENED')`).get()).n;
    const before = await countOf();
    await wf.cPost('/exceptions/scan', { from: bt.addDays(today, -40), to: today });
    eq(await countOf(), before);
  });
  await check('exception assign -> resolve -> reopen, each audited', async () => {
    const x = (await wf.c('/exceptions?status=OPEN')).body[0];
    eq((await wf.cPost(`/exceptions/${x.id}/assign`, { user_id: U.sup })).body.status, 'ASSIGNED');
    eq((await wf.cPost(`/exceptions/${x.id}/resolve`, {})).status, 400);   // note is mandatory
    eq((await wf.cPost(`/exceptions/${x.id}/resolve`, { note: 'Sudah dikoreksi via CR' })).body.status, 'RESOLVED');
    eq((await wf.cPost(`/exceptions/${x.id}/reopen`, { reason: 'Masih salah' })).body.status, 'REOPENED');
    const ev = (await db.prepare(`SELECT event_type FROM attendance_events WHERE exception_id = ? ORDER BY id`).all(x.id))
      .map((e) => e.event_type);
    ok(['EXCEPTION_ASSIGNED', 'EXCEPTION_RESOLVED', 'EXCEPTION_REOPENED'].every((t) => ev.includes(t)), ev.join(','));
  });
  await check('a Supervisor may view exceptions but not resolve them', async () => {
    const x = (await sup.c('/exceptions')).body[0];
    ok(!!x, 'supervisor saw no exceptions');
    eq((await sup.cPost(`/exceptions/${x.id}/resolve`, { note: 'x' })).status, 403);
  });
  await check('PAYROLL_ADJUSTMENT_REQUIRED raises its own HIGH exception', async () => {
    const rows = (await wf.c('/exceptions?type=PAYROLL_ADJUSTMENT_REQUIRED')).body;
    ok(rows.some((x) => x.employee_id === 'E-FINAL' && x.severity === 'HIGH'), JSON.stringify(rows));
  });

  section('IMMUTABLE AUDIT, ROLE SNAPSHOT, HISTORY');
  await check('audit events cannot be updated or deleted, even with raw SQL', async () => {
    const id = (await db.prepare('SELECT id FROM attendance_events ORDER BY id LIMIT 1').get()).id;
    await throwsLike(async () => await db.prepare('UPDATE attendance_events SET reason = ? WHERE id = ?').run('tampered', id), 'append-only');
    await throwsLike(async () => await db.prepare('DELETE FROM attendance_events WHERE id = ?').run(id), 'append-only');
    await throwsLike(async () => await db.prepare(`UPDATE attendance_correction_actions SET actor_name = 'x' WHERE id =
      (SELECT id FROM attendance_correction_actions LIMIT 1)`).run(), 'AUDIT_APPEND_ONLY');
    await throwsLike(async () => await db.prepare('DELETE FROM attendance_correction_actions WHERE id = (SELECT id FROM attendance_correction_actions LIMIT 1)').run(), 'AUDIT_APPEND_ONLY');
    await throwsLike(async () => await db.prepare(`UPDATE attendance_entry_versions SET payload = '{}' WHERE id =
      (SELECT id FROM attendance_entry_versions LIMIT 1)`).run(), 'AUDIT_APPEND_ONLY');
  });
  await check('every event carries actor, role snapshot, permission, before/after and reason', async () => {
    const ev = await db.prepare(`SELECT * FROM attendance_events WHERE event_type = 'CORRECTION_APPLIED' ORDER BY id LIMIT 1`).get();
    ok(ev.actor_user_id && ev.actor_name, 'actor missing');
    ok(ev.actor_role_snapshot, 'role snapshot missing');
    ok(ev.old_values && ev.new_values && ev.delta_values, 'before/after/delta missing');
    ok(ev.correction_id && ev.target_type && ev.result, 'target/result missing');
    const approved = await db.prepare(`SELECT * FROM attendance_events WHERE event_type = 'CORRECTION_APPROVED' ORDER BY id LIMIT 1`).get();
    eq(approved.permission_used, 'attendance_correction:APPROVE');
  });
  await check('a role change does NOT rewrite history: the event keeps the role held at the time', async () => {
    const ev = await db.prepare(`SELECT * FROM attendance_events WHERE actor_user_id = ? AND actor_role_snapshot IS NOT NULL
      ORDER BY id LIMIT 1`).get(U.wf2);
    eq(ev.actor_role_snapshot, 'Workforce Manager');
    // promote Rudi to Operations Director
    await db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(U.wf2);
    await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)').run(U.wf2, await roleId('operations_director'));
    const after = await db.prepare('SELECT actor_role_snapshot FROM attendance_events WHERE id = ?').get(ev.id);
    eq(after.actor_role_snapshot, 'Workforce Manager', 'history was rewritten by the promotion: ');
    const now = await login('wf2.a3@t.local');
    const id = await makeEntry('E-ROLE', recent);
    const c = await sup.cPost('/requests', { timesheet_entry_id: id, reason_code: 'OTHER', proposed_values: { clock_out: '17:00' } });
    await now.cPost(`/requests/${c.body.id}/decide`, { decision: 'approved' });
    const fresh = await db.prepare(`SELECT actor_role_snapshot FROM attendance_events WHERE correction_id = ?
      AND event_type = 'CORRECTION_APPROVED'`).get(c.body.id);
    eq(fresh.actor_role_snapshot, 'Operations Director', 'new event should carry the NEW role: ');
  });
  await check('approval history shows every step with its actor and role', async () => {
    const cid = entries.FINAL_C;
    const detail = (await wf.c(`/requests/${cid}`)).body;
    const steps = detail.approval_history.map((a) => [a.action, a.actor_name, a.actor_role]);
    const actions = steps.map((s) => s[0]);
    ok(actions.includes('CREATED') && actions.includes('APPROVED') && actions.includes('PAYROLL_IMPACT_APPROVED'),
      actions.join(','));
    const payrollStep = steps.find((s) => s[0] === 'PAYROLL_IMPACT_APPROVED');
    eq(payrollStep[2], 'Payroll Officer');
    const attStep = steps.find((s) => s[0] === 'APPROVED');
    eq(attStep[2], 'HRD Officer');
  });
  await check('record history reconstructs original -> correction -> void chain', async () => {
    const id = E('E-VOID2', recent);
    const hist = (await wf.c(`/entries/${id}/history`)).body;
    eq(hist.versions.map((v) => v.version_type), ['ORIGINAL', 'VOID']);
    ok(hist.corrections.length >= 1 && hist.events.length >= 2, JSON.stringify(hist.corrections));
  });
  await check('actor activity history answers "what has this manager done?"', async () => {
    const r = (await wf.c(`/audit/actors/${U.wf}`)).body;
    ok(r.events.length > 0, 'no events');
    ok(Object.keys(r.summary).some((k) => k.startsWith('CORRECTION_')), JSON.stringify(r.summary));
    ok(r.correction_actions.some((a) => ['APPROVED', 'REJECTED', 'VOID_APPROVED'].includes(a.action)),
      r.correction_actions.map((a) => a.action).join(','));
  });
  await check('audit filters by actor, event type, employee and date', async () => {
    const byType = (await wf.c('/audit?event_type=CORRECTION_APPROVED')).body;
    ok(byType.length > 0 && byType.every((e) => e.event_type === 'CORRECTION_APPROVED'));
    const byEmp = (await wf.c('/audit?employee_id=E-FINAL')).body;
    ok(byEmp.length > 0 && byEmp.every((e) => e.employee_id === 'E-FINAL'));
    const byActor = (await wf.c(`/audit?actor_user_id=${U.sup}`)).body;
    ok(byActor.every((e) => e.actor_user_id === U.sup));
  });
  await check('audit VIEW never implies approval, and a Supervisor sees only their OWN activity', async () => {
    const rows = (await sup.c('/audit')).body;
    ok(rows.length > 0, 'supervisor saw nothing at all');
    ok(rows.every((e) => e.actor_user_id === U.sup), 'supervisor saw other actors');
    eq((await sup.c(`/audit/actors/${U.wf}`)).status, 403);
    eq((await sup.c(`/audit/actors/${U.sup}`)).status, 200);
    const id = E('E-SOD', recent);
    const c = await db.prepare('SELECT id FROM attendance_corrections WHERE timesheet_entry_id = ?').get(id);
    eq((await sup.cPost(`/requests/${c.id}/decide`, { decision: 'approved' })).status, 403);
  });
  await check('audit is entity-scoped: a MITRA user sees no KAHE activity', async () => {
    const rows = (await mitra.c('/audit')).body;
    ok(!rows.some((e) => e.legal_entity_id === 'KAHE360'), 'cross-entity audit leak');
  });
  await check('audit access itself requires the audit module', async () => {
    eq((await hse.c('/audit')).status, 403);
  });

  section('PERFORMANCE — inbox, exceptions, audit and actor history at scale');
  let perf = {};
  await check('1,500 employees with correction + audit volume stay responsive', async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
      VALUES (?,?,'internal','active','2019-01-01','PPB')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,
      work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date)
      VALUES (?,'KAHE360',?,?,?, 'TK',0,'2019-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,clock_in,clock_out,
      work_minutes,work_hours,legal_entity_id,day_type,day_type_source,work_schedule_id,schedule_code,scheduled_clock_in,
      scheduled_clock_out,scheduled_minutes,break_minutes_unpaid,worked_after_shift_minutes,overtime_status)
      VALUES (?,?, 'present','07:00',?,?,?, 'KAHE360','WORKDAY','bulk',?, 'SITE-DAY','07:00','16:00',480,60,?, 'none')`);
    const insEv = db.prepare(`INSERT INTO attendance_events (timesheet_entry_id,employee_id,work_date,legal_entity_id,
      event_type,actor_user_id,actor_name,actor_role_snapshot,permission_used,result)
      VALUES (NULL,?,?, 'KAHE360','ENTRY_CREATED',?, 'Bulk','Workforce Manager','timesheet_absensi:CREATE','ok')`);
    const day100 = workdays[5];
    const day1500 = workdays[6];
    await db.exec('BEGIN');
    for (let i = 0; i < 1600; i += 1) {
      const id = `BULK-${i}`;
      await insE.run(id, `Bulk ${i}`); await insA.run(id, wp, cal, groups.KAHE360);
      const late = i % 5 === 0;
      await insT.run(id, i < 100 ? day100 : day1500, late ? '18:00' : '16:00', late ? 600 : 480, late ? 10 : 8, SCHED, late ? 120 : 0);
      await insEv.run(id, i < 100 ? day100 : day1500, U.wf);
    }
    await db.exec('COMMIT');

    let t = Date.now();
    const scan100 = await wf.cPost('/exceptions/scan', { from: day100, to: day100 });
    perf.scan100 = Date.now() - t;
    t = Date.now();
    const scan1500 = await wf.cPost('/exceptions/scan', { from: day1500, to: day1500 });
    perf.scan1500 = Date.now() - t;
    t = Date.now(); await wf.c('/requests?inbox=1'); perf.inbox = Date.now() - t;
    t = Date.now(); const exc = await wf.c('/exceptions?status=OPEN'); perf.exceptions = Date.now() - t;
    t = Date.now(); await wf.c('/audit?limit=500'); perf.audit = Date.now() - t;
    t = Date.now(); await wf.c(`/audit/actors/${U.wf}`); perf.actor = Date.now() - t;
    ok(scan100.body.scanned >= 100 && scan1500.body.scanned >= 1500, `${scan100.body.scanned}/${scan1500.body.scanned}`);
    ok(exc.body.length > 0);
    console.log(`        timing: scan 100 = ${perf.scan100} ms · scan 1,500 = ${perf.scan1500} ms · inbox ${perf.inbox} ms · `
      + `exceptions ${perf.exceptions} ms · audit ${perf.audit} ms · actor history ${perf.actor} ms`);
    ok(perf.scan1500 < 30000 && perf.audit < 5000 && perf.inbox < 5000, JSON.stringify(perf));
  });

  section('SCOPE LOCK & MIGRATION');
  await check('no money anywhere in the A3 libraries or routes', async () => {
    const money = /sen\b|rupiah|amount_sen|multiplier|salary|bpjs|pph|rate_bp/i;
    for (const f of ['lib/attendanceCorrection.js', 'lib/attendanceException.js', 'lib/attendanceAudit.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      ok(!money.test(src), `${f} mentions money`);
    }
  });
  await check('migrate-attendance-a3 is idempotent and invents no policy', async () => {
    const { migrate } = require('../database/migrate-attendance-a3');
    const { getDb } = require('../database/init-db');
    const h = getDb();
    try {
      const before = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_correction_policies').get()).n;
      const r1 = await migrate(h);
      const r2 = await migrate(h);
      eq((await db.prepare('SELECT COUNT(*) AS n FROM attendance_correction_policies').get()).n, before, 'policy invented: ');
      eq([r1.entries === r2.entries, r1.corrections > 0], [true, true]);
      const seeded = await migrate(h, { seedPolicyFor: 'MITRA', windowDays: 7 });
      eq(seeded.policy_created, 0, 'MITRA already had a policy: ');
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
