(async () => {
// tests/attendance-a1.test.js
// Attendance Hardening A1 — API regression suite.
//
// Hits the REAL server (server.js spawned as a child process) over HTTP with
// REAL sessions, the REAL RBAC seed (database/seed.js) and a throwaway SQLite
// database selected through KAHE360_DB_PATH. Nothing security- or
// database-related is mocked.
// Usage: npm run test:attendance

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');
const __t = await createTestDatabase('attendance_a1');
process.env.DATABASE_URL = __t.appUrl;   // the REAL server and seed run against this throwaway PostgreSQL database
const bcrypt = require('bcryptjs');

const PORT = 40000 + Math.floor(Math.random() * 20000);
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

// ---- 1. real RBAC seed into the throwaway DB -------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], {
  cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl }, stdio: 'pipe',
});

const db = __t.db;

// ---- 2. fixtures -----------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active') ON CONFLICT DO NOTHING`).run();
for (const [id, name] of [['KAHE360', 'KAHE'], ['MITRA', 'Mitra Jaya']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2019-01-01') ON CONFLICT DO NOTHING`).run(id, name, id === 'KAHE360' ? 'internal' : 'subkontraktor');
}
const wp = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H-A1',5,'sunday','2019-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('A1CAL','A1',NULL,NULL,'2019-01-01') RETURNING id`).run()).lastInsertRowid;

const groups = {};
for (const e of ['KAHE360', 'MITRA']) {
  groups[e] = (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2019-01-01') RETURNING id`)
    .run(`${e}-A1`, `${e} A1`, e)).lastInsertRowid;
}
const FAR = '2099-12-31', PAST = '2020-02-05';
async function period(entity, y, m, status, attCut, otCut) {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return Number((await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(groups[entity], y, m, m, start, end, attCut, otCut, FAR, FAR, status)).lastInsertRowid);
}
const P = {
  open:      await period('KAHE360', 2026, 1, 'OPEN', FAR, FAR),
  pastCut:   await period('KAHE360', 2020, 1, 'OPEN', PAST, PAST),
  closed:    await period('KAHE360', 2020, 2, 'CLOSED', FAR, FAR),
  frozen:    await period('KAHE360', 2026, 3, 'OPEN', FAR, FAR),
  otClosed:  await period('KAHE360', 2026, 4, 'OPEN', FAR, PAST),
  draft:     await period('KAHE360', 2026, 5, 'DRAFT', FAR, FAR),
  mitraOpen: await period('MITRA', 2026, 1, 'OPEN', FAR, FAR),
};

async function hire(id, entity, { start = '2019-01-01', termination = null, status = 'active', assign = true } = {}) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code)
              VALUES (?,?,'internal',?,?,?,'PPB')`).run(id, `Pekerja ${id}`, status, start, termination);
  if (assign) {
    await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
      payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2019-01-01')`)
      .run(id, entity, wp, cal, groups[entity]);
  }
}
await hire('K1', 'KAHE360'); await hire('K2', 'KAHE360'); await hire('K3', 'KAHE360');
await hire('KFUT', 'KAHE360', { start: '2026-06-01' });
await hire('KTERM', 'KAHE360');
await hire('KFRZ', 'KAHE360');
await hire('KNOA', 'KAHE360', { assign: false });
await hire('M1', 'MITRA');

// Legacy rows written before A1 (direct SQL, as a pre-A1 database would hold them).
async function legacyRow(emp, date, extra = {}) {
  const r = { attendance_status: 'present', work_minutes: 480, work_hours: 8, overtime_status: 'none',
    overtime_minutes_requested: 0, overtime_requested_by: null, day_type: 'WORKDAY', legal_entity_id: 'KAHE360', ...extra };
  return Number((await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_status,overtime_minutes_requested,overtime_requested_by,day_type,day_type_source,legal_entity_id)
    VALUES (?,?,?,?,?,?,?,?,?,'legacy',?) RETURNING id`).run(emp, date, r.attendance_status, r.work_minutes, r.work_hours,
    r.overtime_status, r.overtime_minutes_requested, r.overtime_requested_by, r.day_type, r.legal_entity_id)).lastInsertRowid);
}
const ROW_PASTCUT = await legacyRow('K1', '2020-01-20');
const ROW_FROZEN = await legacyRow('KFRZ', '2026-03-02');
const ROW_NOENTITY = await legacyRow('KNOA', '2026-01-05', { legal_entity_id: null });
const ROW_LEGACY_PENDING = await legacyRow('K3', '2026-01-09',
  { overtime_status: 'pending', overtime_minutes_requested: 60, overtime_requested_by: 'Nama Tidak Dikenal' });

// A FROZEN payroll snapshot over KFRZ / March 2026 (after its row exists).
await db.prepare(`INSERT INTO payroll_input_snapshots (payroll_period_id,employee_id,as_of_date,legal_entity_id,payroll_group_id,
  resolved_payload,payload_hash,resolved_at,status,frozen_at,frozen_by)
  VALUES (?, 'KFRZ', '2026-03-31', 'KAHE360', ?, '{}', 'x', kahe_now(), 'FROZEN', kahe_now(), 'test')`)
  .run(P.frozen, groups.KAHE360);

// Users: the seeded demo users plus scoped extras, with explicit entity scope.
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
  mitraWf: await makeUser('mitra.wf@t.local', 'Mitra Workforce', 'workforce_manager'),
  mitraDir: await makeUser('mitra.dir@t.local', 'Mitra Director', 'operations_director'),
  noScope: await makeUser('noscope@t.local', 'No Scope Workforce', 'workforce_manager'),
};
for (const k of ['director', 'workforce', 'hrd', 'payroll']) await grant(U[k], 'KAHE360');
await grant(U.mitraWf, 'MITRA'); await grant(U.mitraDir, 'MITRA');

// ---- 3. HTTP client with real sessions -------------------------------------------
async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(`${BASE}/api/timesheet${url}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, body: json };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}
const entryRow = async (id) => await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);
const events = async (id) => await db.prepare('SELECT * FROM attendance_events WHERE timesheet_entry_id = ? ORDER BY id').all(id);

// ---- 4. run -----------------------------------------------------------------------
let server;
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: __t.appUrl, PORT: String(PORT), NODE_ENV: 'development' }, stdio: 'pipe',
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${BASE}/login.html`); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${out}`);
}

(async () => {
  await startServer();
  const wf = await login('workforce@kahe360.local');
  const dir = await login('director@kahe360.local');
  const hrd = await login('hrd@kahe360.local');
  const pay = await login('payroll@kahe360.local');
  const mwf = await login('mitra.wf@t.local');
  const mdir = await login('mitra.dir@t.local');
  const none = await login('noscope@t.local');

  let E1; // K1 2026-01-05, the main overtime subject
  section('ATTENDANCE — create / update / authorization');
  await check('valid attendance create (201, entity + actor id + source + event snapshotted server-side)', async () => {
    const r = await wf.post('/entries', { employee_id: 'K1', work_date: '2026-01-05', clock_in: '07:00', clock_out: '16:00',
      work_hours: 8, day_type: 'PUBLIC_HOLIDAY', entry_source: 'FINGERPRINT', recorded_by_user_id: 999 });
    eq(r.status, 201, 'status '); E1 = r.body.id;
    const row = await entryRow(E1);
    eq([row.legal_entity_id, row.recorded_by_user_id, row.entry_source, row.day_type, row.work_minutes],
      ['KAHE360', U.workforce, 'MANUAL', 'WORKDAY', 480]);
    eq((await events(E1)).map((e) => e.event_type), ['ENTRY_CREATED']);
  });
  await check('valid authorized update (200, old/new recorded, updated_by_user_id)', async () => {
    const r = await wf.put(`/entries/${E1}`, { clock_out: '16:30', note: 'lupa clock out' });
    eq(r.status, 200); eq(r.body.changed.sort(), ['clock_out', 'note']);
    eq((await entryRow(E1)).updated_by_user_id, U.workforce);
    const ev = (await events(E1)).pop();
    eq([ev.event_type, JSON.parse(ev.old_values).clock_out, JSON.parse(ev.new_values).clock_out, ev.actor_user_id],
      ['ENTRY_UPDATED', '16:00', '16:30', U.workforce]);
  });
  await check('unauthorized create (HRD Officer: VIEW only) -> 403', async () => {
    eq((await hrd.post('/entries', { employee_id: 'K2', work_date: '2026-01-05' })).status, 403);
  });
  await check('unauthorized update (Payroll Officer: VIEW only) -> 403, row unchanged', async () => {
    eq((await pay.put(`/entries/${E1}`, { note: 'x' })).status, 403);
    eq((await entryRow(E1)).note, 'lupa clock out');
  });
  await check('unauthenticated -> 401', async () => {
    eq((await fetch(`${BASE}/api/timesheet/entries`)).status, 401);
  });
  await check('duplicate employee/work-date -> 409 DUPLICATE', async () => {
    const r = await wf.post('/entries', { employee_id: 'K1', work_date: '2026-01-05' });
    eq([r.status, r.body.error], [409, 'DUPLICATE']);
  });
  await check('invalid work_date ("hello", 2026-02-30) -> 400 INVALID_DATE (no cutoff bypass)', async () => {
    eq((await wf.post('/entries', { employee_id: 'K1', work_date: 'hello' })).body.error, 'INVALID_DATE');
    eq((await wf.post('/entries', { employee_id: 'K1', work_date: '2026-02-30' })).body.error, 'INVALID_DATE');
  });
  await check('out-of-range minutes (2000 min) -> 400 INVALID_WORK_MINUTES', async () => {
    const r = await wf.post('/entries', { employee_id: 'K2', work_date: '2026-01-05', work_minutes: 2000 });
    eq([r.status, r.body.error], [400, 'INVALID_WORK_MINUTES']);
  });
  await check('integer-minute lock: 0.1h=6, 0.25h=15, 0.5h=30, 7.25h=435, 8h=480', async () => {
    const got = [];
    for (const h of [0.1, 0.25, 0.5, 7.25, 8]) {
      const r = await wf.put(`/entries/${E1}`, { work_hours: h }); eq(r.status, 200);
      got.push((await entryRow(E1)).work_minutes);
    }
    eq(got, [6, 15, 30, 435, 480]);
  });

  section('ATTENDANCE — cutoff / period / frozen snapshot');
  await check('create past attendance cutoff -> 409 ATTENDANCE_PERIOD_CLOSED (PAST_CUTOFF)', async () => {
    const r = await wf.post('/entries', { employee_id: 'K2', work_date: '2020-01-15' });
    eq([r.status, r.body.error, r.body.detail.reason], [409, 'ATTENDANCE_PERIOD_CLOSED', 'PAST_CUTOFF']);
  });
  await check('create in CLOSED period -> 409 ATTENDANCE_PERIOD_CLOSED (PERIOD_CLOSED)', async () => {
    const r = await wf.post('/entries', { employee_id: 'K2', work_date: '2020-02-10' });
    eq([r.status, r.body.error, r.body.detail.reason], [409, 'ATTENDANCE_PERIOD_CLOSED', 'PERIOD_CLOSED']);
  });
  await check('update past cutoff -> 409, original row unchanged, still readable', async () => {
    const r = await wf.put(`/entries/${ROW_PASTCUT}`, { attendance_status: 'absent' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_PERIOD_CLOSED']);
    eq((await entryRow(ROW_PASTCUT)).attendance_status, 'present');
    eq((await wf.get('/entries?date=2020-01-20')).body.map((x) => x.id), [ROW_PASTCUT]);
  });
  await check('DRAFT period stays writable (attendance precedes period opening)', async () => {
    const r = await wf.post('/entries', { employee_id: 'K2', work_date: '2026-05-04' });
    eq([r.status, r.body.period_status], [201, 'DRAFT']);
  });
  await check('frozen payroll snapshot: create -> 409 ATTENDANCE_SOURCE_FROZEN', async () => {
    const r = await wf.post('/entries', { employee_id: 'KFRZ', work_date: '2026-03-03' });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_SOURCE_FROZEN']);
  });
  await check('frozen payroll snapshot: update -> 409, row unchanged', async () => {
    const r = await wf.put(`/entries/${ROW_FROZEN}`, { work_minutes: 300 });
    eq([r.status, r.body.error], [409, 'ATTENDANCE_SOURCE_FROZEN']);
    eq((await entryRow(ROW_FROZEN)).work_minutes, 480);
  });
  await check('frozen payroll snapshot: raw SQL UPDATE/DELETE/INSERT refused by trigger', async () => {
    await throwsLike(async () => await db.prepare('UPDATE timesheet_entries SET work_minutes = 1 WHERE id = ?').run(ROW_FROZEN), 'ATTENDANCE_SOURCE_FROZEN');
    await throwsLike(async () => await db.prepare('UPDATE timesheet_entries SET overtime_status = \'approved\' WHERE id = ?').run(ROW_FROZEN), 'ATTENDANCE_SOURCE_FROZEN');
    await throwsLike(async () => await db.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(ROW_FROZEN), 'ATTENDANCE_SOURCE_FROZEN');
    await throwsLike(async () => await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status) VALUES ('KFRZ','2026-03-10','present')`).run(), 'ATTENDANCE_SOURCE_FROZEN');
  });
  await check('frozen payroll snapshot: metadata (note) is not payroll-source and stays writable at DB level', async () => {
    await db.prepare('UPDATE timesheet_entries SET note = ? WHERE id = ?').run('catatan', ROW_FROZEN);
    eq((await entryRow(ROW_FROZEN)).note, 'catatan');
  });

  section('OVERTIME — workflow, immutability, SoD');
  await check('valid OT request (201 pending, requester id recorded)', async () => {
    const r = await wf.post(`/entries/${E1}/overtime-request`, { hours: 1.5 });
    eq([r.status, r.body.overtime_minutes_requested], [201, 90]);
    const row = await entryRow(E1);
    eq([row.overtime_status, row.overtime_requested_by_user_id], ['pending', U.workforce]);
  });
  await check('second request while pending -> 409 OVERTIME_ALREADY_PENDING', async () => {
    eq((await wf.post(`/entries/${E1}/overtime-request`, { hours: 3 })).body.error, 'OVERTIME_ALREADY_PENDING');
    eq((await entryRow(E1)).overtime_minutes_requested, 90);
  });
  await check('requester self-approval -> 403 SOD_VIOLATION (server-side)', async () => {
    const r = await wf.post(`/entries/${E1}/overtime-decide`, { decision: 'approved' });
    eq([r.status, r.body.error], [403, 'SOD_VIOLATION']);
    eq((await entryRow(E1)).overtime_status, 'pending');
  });
  await check('requester self-rejection -> 403 SOD_VIOLATION', async () => {
    eq((await wf.post(`/entries/${E1}/overtime-decide`, { decision: 'rejected' })).body.error, 'SOD_VIOLATION');
  });
  await check('SoD uses user id, not display name: renamed requester still blocked', async () => {
    await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Nama Baru Workforce', U.workforce);
    eq((await wf.post(`/entries/${E1}/overtime-decide`, { decision: 'approved' })).body.error, 'SOD_VIOLATION');
  });
  await check('unauthorized approval (Payroll Officer, HRD Officer) -> 403 FORBIDDEN', async () => {
    eq((await pay.post(`/entries/${E1}/overtime-decide`, { decision: 'approved' })).body.error, 'FORBIDDEN');
    eq((await hrd.post(`/entries/${E1}/overtime-decide`, { decision: 'rejected' })).status, 403);
    eq((await entryRow(E1)).overtime_status, 'pending');
  });
  await check('valid OT approval by a different authorized user (Operations Director)', async () => {
    const r = await dir.post(`/entries/${E1}/overtime-decide`, { decision: 'approved' });
    eq([r.status, r.body.overtime_minutes_approved], [200, 90]);
    const row = await entryRow(E1);
    eq([row.overtime_status, row.overtime_minutes_approved, row.overtime_decided_by_user_id], ['approved', 90, U.director]);
  });
  await check('duplicate same decision -> 200 idempotent, nothing rewritten, no extra event', async () => {
    const before = [(await events(E1)).length, (await entryRow(E1)).overtime_decided_at];
    const r = await dir.post(`/entries/${E1}/overtime-decide`, { decision: 'approved' });
    eq([r.status, r.body.idempotent], [200, true]);
    eq([(await events(E1)).length, (await entryRow(E1)).overtime_decided_at], before);
  });
  await check('conflicting decision APPROVED -> REJECTED -> 409 OVERTIME_DECISION_CONFLICT', async () => {
    const r = await dir.post(`/entries/${E1}/overtime-decide`, { decision: 'rejected' });
    eq([r.status, r.body.error], [409, 'OVERTIME_DECISION_CONFLICT']);
    eq([(await entryRow(E1)).overtime_status, (await entryRow(E1)).overtime_minutes_approved], ['approved', 90]);
  });
  await check('new OT request after terminal decision -> 409 OVERTIME_ALREADY_DECIDED', async () => {
    eq((await wf.post(`/entries/${E1}/overtime-request`, { hours: 5 })).body.error, 'OVERTIME_ALREADY_DECIDED');
    eq((await entryRow(E1)).overtime_minutes_approved, 90);
  });
  await check('terminal OT decision cannot be invalidated by generic PUT (status/clock/minutes)', async () => {
    for (const body of [{ attendance_status: 'absent' }, { clock_out: '12:00' }, { work_minutes: 60 }]) {
      const r = await wf.put(`/entries/${E1}`, body);
      eq([r.status, r.body.error], [409, 'OVERTIME_DECISION_LOCKED']);
    }
    const row = await entryRow(E1);
    eq([row.attendance_status, row.clock_out, row.work_minutes, row.overtime_status, row.overtime_minutes_approved],
      ['present', '16:30', 480, 'approved', 90]);
  });
  await check('metadata-only PUT after decision allowed (note), decision untouched', async () => {
    const full = await entryRow(E1);
    // The UI resends every field; unchanged payroll fields must not trip the lock.
    const r = await wf.put(`/entries/${E1}`, { attendance_status: full.attendance_status, clock_in: full.clock_in,
      clock_out: full.clock_out, work_hours: 8, note: 'catatan supervisor' });
    eq([r.status, r.body.changed], [200, ['note']]);
    eq((await entryRow(E1)).overtime_status, 'approved');
  });
  let E2;
  await check('valid OT rejection (minutes approved = 0), then approve -> 409 conflict', async () => {
    E2 = (await wf.post('/entries', { employee_id: 'K1', work_date: '2026-01-06', work_hours: 8 })).body.id;
    eq((await wf.post(`/entries/${E2}/overtime-request`, { minutes: 45 })).status, 201);
    const r = await dir.post(`/entries/${E2}/overtime-decide`, { decision: 'rejected' });
    eq([r.status, (await entryRow(E2)).overtime_status, (await entryRow(E2)).overtime_minutes_approved], [200, 'rejected', 0]);
    eq((await dir.post(`/entries/${E2}/overtime-decide`, { decision: 'approved' })).body.error, 'OVERTIME_DECISION_CONFLICT');
  });
  await check('decision without pending request -> 409 NO_PENDING_OVERTIME_REQUEST', async () => {
    const id = (await wf.post('/entries', { employee_id: 'K1', work_date: '2026-01-07' })).body.id;
    const r = await dir.post(`/entries/${id}/overtime-decide`, { decision: 'approved' });
    eq([r.status, r.body.error], [409, 'NO_PENDING_OVERTIME_REQUEST']);
    eq((await entryRow(id)).overtime_status, 'none');
  });
  await check('OT on a non-working day -> 409 OVERTIME_REQUIRES_PRESENCE', async () => {
    const id = (await wf.post('/entries', { employee_id: 'K1', work_date: '2026-01-08', attendance_status: 'absent' })).body.id;
    eq((await wf.post(`/entries/${id}/overtime-request`, { hours: 1 })).body.error, 'OVERTIME_REQUIRES_PRESENCE');
  });
  await check('pending OT blocks switching the day to absent -> 409 OVERTIME_PENDING', async () => {
    const id = (await wf.post('/entries', { employee_id: 'K2', work_date: '2026-01-12' })).body.id;
    eq((await wf.post(`/entries/${id}/overtime-request`, { hours: 1 })).status, 201);
    eq((await wf.put(`/entries/${id}`, { attendance_status: 'absent' })).body.error, 'OVERTIME_PENDING');
  });
  await check('OT past overtime cutoff (attendance still open) -> 409 OVERTIME_PERIOD_CLOSED', async () => {
    const r1 = await wf.post('/entries', { employee_id: 'K2', work_date: '2026-04-06' });
    eq(r1.status, 201);
    const r2 = await wf.post(`/entries/${r1.body.id}/overtime-request`, { hours: 1 });
    eq([r2.status, r2.body.error], [409, 'OVERTIME_PERIOD_CLOSED']);
  });
  await check('legacy pending OT with unverified requester -> 409 OVERTIME_REQUESTER_UNVERIFIED; re-submit then decide', async () => {
    eq((await dir.post(`/entries/${ROW_LEGACY_PENDING}/overtime-decide`, { decision: 'approved' })).body.error, 'OVERTIME_REQUESTER_UNVERIFIED');
    eq((await wf.post(`/entries/${ROW_LEGACY_PENDING}/overtime-request`, { hours: 1 })).status, 201);
    eq((await dir.post(`/entries/${ROW_LEGACY_PENDING}/overtime-decide`, { decision: 'approved' })).status, 200);
  });
  await check('decision history is auditable and append-only', async () => {
    const r = await wf.get(`/entries/${E1}/events`);
    eq(r.status, 200);
    const types = r.body.map((e) => e.event_type);
    ok(types[0] === 'ENTRY_CREATED' && types.includes('OVERTIME_REQUESTED') && types.at(-2) === 'OVERTIME_APPROVED', types.join(','));
    const appr = r.body.find((e) => e.event_type === 'OVERTIME_APPROVED');
    eq([appr.actor_user_id, JSON.parse(appr.new_values).overtime_minutes_approved], [U.director, 90]);
    await throwsLike(async () => await db.prepare('UPDATE attendance_events SET actor_user_id = 1 WHERE id = ?').run(appr.id), 'ATTENDANCE_EVENT_IMMUTABLE');
    await throwsLike(async () => await db.prepare('DELETE FROM attendance_events WHERE id = ?').run(appr.id), 'ATTENDANCE_EVENT_IMMUTABLE');
  });

  section('ELIGIBILITY (canonical lib/employeeEligibility, as of the work date)');
  let ETERM;
  await check('valid active employee on the work date -> 201', async () => {
    const r = await wf.post('/entries', { employee_id: 'KTERM', work_date: '2026-01-05' });
    eq(r.status, 201); ETERM = r.body.id;
  });
  await check('not-yet-active employee -> 409 EMPLOYEE_NOT_ELIGIBLE (NOT_STARTED)', async () => {
    const r = await wf.post('/entries', { employee_id: 'KFUT', work_date: '2026-01-07' });
    eq([r.status, r.body.error, r.body.detail.reason], [409, 'EMPLOYEE_NOT_ELIGIBLE', 'NOT_STARTED']);
  });
  await check('terminated employee after termination date -> 409 (TERMINATED)', async () => {
    await db.prepare(`UPDATE employees SET termination_date = '2026-01-10', status = 'inactive' WHERE id = 'KTERM'`).run();
    const r = await wf.post('/entries', { employee_id: 'KTERM', work_date: '2026-01-15' });
    eq([r.status, r.body.error, r.body.detail.reason], [409, 'EMPLOYEE_NOT_ELIGIBLE', 'TERMINATED']);
  });
  await check('historical attendance of a former employee remains readable (list + audit)', async () => {
    ok((await wf.get('/entries?date=2026-01-05')).body.some((x) => x.id === ETERM), 'former employee row missing');
    eq((await wf.get(`/entries/${ETERM}/events`)).status, 200);
  });
  await check('former employee: attendance on a still-valid date remains editable (not judged by today)', async () => {
    eq((await wf.put(`/entries/${ETERM}`, { note: 'koreksi' })).status, 200);
  });
  await check('employee with no payroll assignment -> 409 (NO_PAYROLL_ASSIGNMENT)', async () => {
    const r = await wf.post('/entries', { employee_id: 'KNOA', work_date: '2026-01-06' });
    eq([r.status, r.body.detail.reason], [409, 'NO_PAYROLL_ASSIGNMENT']);
  });

  section('LEGAL ENTITY ISOLATION (Phase 2I authority, SQL-level)');
  let EM;
  await check('same-entity create/list: MITRA user records and sees MITRA attendance', async () => {
    const r = await mwf.post('/entries', { employee_id: 'M1', work_date: '2026-01-05' });
    eq(r.status, 201); EM = r.body.id;
    eq((await mwf.get('/entries?date=2026-01-05')).body.map((x) => x.employee_id), ['M1']);
  });
  await check('cross-entity list isolation: KAHE list has no MITRA rows (and no NULL-entity legacy rows)', async () => {
    const ids = (await wf.get('/entries?date=2026-01-05')).body.map((x) => x.employee_id).sort();
    eq(ids, ['K1', 'KTERM']);
    ok(!ids.includes('KNOA'), 'NULL-entity row leaked');
  });
  await check('no-scope user sees zero records, zero KPIs, empty pending queue', async () => {
    eq((await none.get('/entries?date=2026-01-05')).body, []);
    const s = (await none.get('/entries/summary?date=2026-01-05')).body;
    eq([s.totalActive, s.present, s.pendingOvertime], [0, 0, 0]);
    eq((await none.get('/overtime/pending')).body, []);
  });
  await check('summary is scoped (KAHE active workforce excludes MITRA)', async () => {
    const k = (await wf.get('/entries/summary?date=2026-01-05')).body;
    const m = (await mwf.get('/entries/summary?date=2026-01-05')).body;
    eq([m.totalActive, m.present], [1, 1]);
    ok(k.totalActive >= 5 && k.present === 2, JSON.stringify(k));
  });
  await check('direct cross-entity access -> 404, body identical to a non-existent id', async () => {
    const foreign = await mwf.get(`/entries/${E1}/events`);
    const absent = await mwf.get('/entries/999999/events');
    eq([foreign.status, absent.status], [404, 404]);
    eq(foreign.body, absent.body);
  });
  await check('cross-entity CREATE -> 404 (no disclosure), nothing written', async () => {
    eq((await mwf.post('/entries', { employee_id: 'K2', work_date: '2026-01-13' })).status, 404);
    ok(!await db.prepare(`SELECT 1 FROM timesheet_entries WHERE employee_id='K2' AND work_date='2026-01-13'`).get(), 'row written');
  });
  await check('cross-entity UPDATE -> 404, row unchanged', async () => {
    eq((await mwf.put(`/entries/${E1}`, { note: 'hack' })).status, 404);
    eq((await entryRow(E1)).note, 'catatan supervisor');
  });
  await check('cross-entity OT request -> 404', async () => {
    const id = (await wf.post('/entries', { employee_id: 'K3', work_date: '2026-01-05' })).body.id;
    eq((await mwf.post(`/entries/${id}/overtime-request`, { hours: 1 })).status, 404);
    eq((await entryRow(id)).overtime_status, 'none');
  });
  await check('cross-entity OT decision (MITRA director on KAHE pending) -> 404, state unchanged', async () => {
    const pending = (await db.prepare(`SELECT id FROM timesheet_entries WHERE overtime_status='pending' AND legal_entity_id='KAHE360'`).get()).id;
    eq((await mdir.post(`/entries/${pending}/overtime-decide`, { decision: 'approved' })).status, 404);
    eq((await entryRow(pending)).overtime_status, 'pending');
    ok(!(await mdir.get('/overtime/pending')).body.some((x) => x.id === pending), 'foreign pending leaked');
  });
  await check('KAHE user cannot enumerate MITRA attendance (by id sweep)', async () => {
    eq((await wf.get(`/entries/${EM}/events`)).status, 404);
    eq((await dir.post(`/entries/${EM}/overtime-decide`, { decision: 'approved' })).status, 404);
  });
  await check('cross-entity day-type probe -> 404', async () => {
    eq((await mwf.get('/day-type/K1/2026-01-05')).status, 404);
    eq((await wf.get('/day-type/K1/2026-01-05')).status, 200);
  });
  await check('cross-entity denials are audited in entity_access_audit', async () => {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE user_id = ? AND outcome = 'DENIED'`).get(U.mitraWf)).n;
    ok(n >= 4, `only ${n} denials audited`);
  });

  section('MIGRATION');
  await check('migrate-attendance-a1 is idempotent and never guesses identity', async () => {
    await db.prepare(`UPDATE users SET display_name = 'Unique Legacy Name' WHERE id = ?`).run(U.hrd);
    const legacy = await legacyRow('K2', '2026-01-14', { overtime_status: 'pending', overtime_minutes_requested: 30, overtime_requested_by: 'Unique Legacy Name' });
    const { migrate } = require('../database/migrate-attendance-a1');
    const { getDb } = require('../database/init-db');
    const h = getDb();
    try {
      await migrate(h);
      eq((await entryRow(legacy)).overtime_requested_by_user_id, U.hrd);
      eq((await entryRow(ROW_NOENTITY)).legal_entity_id, null);        // no assignment on date: not guessed
      const second = await migrate(h);
      eq([second.requested, second.recorded, second.decided], [0, 0, 0]);
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
