(async () => {
// tests/phase1b.test.js
// Phase 1B / B2 — Day-Type & Overtime Day Classification test suite.
// Throwaway database. Usage: npm run test:phase1b

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb } = require('../database/init-db');
const dc = require('../lib/dayClassification');

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function throws(fn, label = 'expected a throw') {
  let t = false; try { await fn(); } catch (e) { t = true; }
  if (!t) throw new Error(label);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase1b.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase1b');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PRJ2','Project Two','Cilacap','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra Jaya','subkontraktor','high','2026-01-01')`).run();

const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5 Hari',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const wp6 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('6 Hari',6,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const wp5sat = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5 Hari Sabtu Libur',5,'saturday','2026-01-01') RETURNING id`).run()).lastInsertRowid;

const calGlobal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
const calMitra = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('MITRA_CAL','Kalender Mitra','MITRA',NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makeEmployee(id, projectCode = 'PPB') {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES (?,?,'internal','active','2026-01-01',?)`).run(id, id, projectCode);
}
async function assign(id, { entity = 'KAHE360', pattern = wp5, calendar = null, from = '2026-01-01', to = null } = {}) {
  return (await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,marital_status,dependents_count,effective_date,end_date)
    VALUES (?,?,?,?,'TK',0,?,?) RETURNING id`).run(id, entity, pattern, calendar, from, to)).lastInsertRowid;
}
async function addHoliday(date, name, opts = {}) {
  const o = { scope: 'national', project_code: null, holiday_type: 'PUBLIC_HOLIDAY', work_calendar_id: null, observed_for: null, ...opts };
  return (await db.prepare(`INSERT INTO holidays (date,name,scope,project_code,holiday_type,work_calendar_id,observed_for,created_by)
    VALUES (?,?,?,?,?,?,?,'test') RETURNING id`).run(date, name, o.scope, o.project_code, o.holiday_type, o.work_calendar_id, o.observed_for)).lastInsertRowid;
}

// 2026 reference dates: 2026-06-15 = Monday, 2026-06-21 = Sunday,
// 2026-06-20 = Saturday, 2026-08-17 = Monday (Hari Kemerdekaan).

// =============================================================================
section('CORE CLASSIFICATION');
// =============================================================================

await makeEmployee('E-5DAY'); await assign('E-5DAY', { pattern: wp5 });

await check('1. normal scheduled workday -> WORKDAY', async () => {
  const c = await dc.classifyDay(db, 'E-5DAY', '2026-06-15'); // Monday
  eq(c.status, dc.CLASSIFICATION_STATUS.OK);
  eq(c.dayType, 'WORKDAY');
  eq(c.source, `work_pattern:${wp5}`);
});

await check('2. employee weekly rest day -> WEEKLY_REST_DAY', async () => {
  const c = await dc.classifyDay(db, 'E-5DAY', '2026-06-21'); // Sunday
  eq(c.dayType, 'WEEKLY_REST_DAY');
  eq(c.weeklyRestDay, 'sunday');
});

await check('3. official holiday -> PUBLIC_HOLIDAY', async () => {
  await addHoliday('2026-08-17', 'Hari Kemerdekaan RI');
  const c = await dc.classifyDay(db, 'E-5DAY', '2026-08-17'); // Monday
  eq(c.dayType, 'PUBLIC_HOLIDAY');
  eq(c.source.startsWith('holiday:'), true, 'source should name the holiday row: ');
  eq(c.matchedHolidays.length, 1);
});

await check('4. PRECEDENCE: holiday falling on the weekly rest day -> PUBLIC_HOLIDAY', async () => {
  await addHoliday('2026-06-21', 'Libur Uji Presedensi'); // a Sunday = also the rest day
  const c = await dc.classifyDay(db, 'E-5DAY', '2026-06-21');
  eq(c.dayType, 'PUBLIC_HOLIDAY', 'holiday must outrank rest day: ');
  eq(dc.DAY_TYPE_PRECEDENCE.indexOf('PUBLIC_HOLIDAY') < dc.DAY_TYPE_PRECEDENCE.indexOf('WEEKLY_REST_DAY'), true);
});

await check('SUBSTITUTED_HOLIDAY outranks a plain public holiday on the same date', async () => {
  await addHoliday('2026-12-24', 'Cuti Bersama Natal');
  await addHoliday('2026-12-24', 'Pengganti Libur', { holiday_type: 'SUBSTITUTED_HOLIDAY', observed_for: '2026-12-25', scope: 'project', project_code: 'PPB' });
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-12-24')).dayType, 'SUBSTITUTED_HOLIDAY');
});

await check('COMPANY_HOLIDAY is supported without any classifier code change', async () => {
  await addHoliday('2026-09-10', 'HUT Perusahaan', { holiday_type: 'COMPANY_HOLIDAY' });
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-09-10')).dayType, 'COMPANY_HOLIDAY');
});

// =============================================================================
section('WORK PATTERNS (5-day vs 6-day)');
// =============================================================================

await makeEmployee('E-6DAY'); await assign('E-6DAY', { pattern: wp6 });
await makeEmployee('E-SAT'); await assign('E-SAT', { pattern: wp5sat });

await check('5. 5-day pattern: Saturday is a WORKDAY, Sunday is the rest day', async () => {
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-06-20')).dayType, 'WORKDAY', 'Saturday: ');
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-06-14')).dayType, 'WEEKLY_REST_DAY', 'Sunday: ');
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-06-15')).daysPerWeek, 5);
});

await check('6. 6-day pattern: Saturday is a WORKDAY, only Sunday rests', async () => {
  eq((await dc.classifyDay(db, 'E-6DAY', '2026-06-20')).dayType, 'WORKDAY');
  eq((await dc.classifyDay(db, 'E-6DAY', '2026-06-14')).dayType, 'WEEKLY_REST_DAY');
  eq((await dc.classifyDay(db, 'E-6DAY', '2026-06-20')).daysPerWeek, 6);
});

await check('a pattern resting on Saturday classifies Saturday, not Sunday', async () => {
  eq((await dc.classifyDay(db, 'E-SAT', '2026-06-20')).dayType, 'WEEKLY_REST_DAY', 'Saturday: ');
  eq((await dc.classifyDay(db, 'E-SAT', '2026-06-14')).dayType, 'WORKDAY', 'Sunday: ');
});

// =============================================================================
section('OVERTIME RULE MAPPING (no multipliers in the classifier)');
// =============================================================================

await check('the classifier module contains NO multiplier values', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dayClassification.js'), 'utf8');
  for (const forbidden = ['multiplier_bp', '1.5', '15000', '20000']; false;) break;
  for (const token of ['multiplier_bp', '15000', '20000', '30000', '40000']) {
    if (src.includes(token)) throw new Error(`classifier must not contain multiplier token: ${token}`);
  }
});

await check('mapping to the overtime rule band is pattern-aware', async () => {
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-5DAY', '2026-06-15')), 'workday');
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-5DAY', '2026-06-14')), 'rest_or_holiday_5day');
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-6DAY', '2026-06-14')), 'rest_or_holiday_6day');
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-5DAY', '2026-08-17')), 'rest_or_holiday_5day', 'holiday on 5-day: ');
});

await check('a failed classification maps to NULL, never to a default band', () => {
  eq(dc.resolveOvertimeRuleDayType({ status: 'MISSING_ASSIGNMENT', dayType: null }), null);
  eq(dc.resolveOvertimeRuleDayType(null), null);
});

// =============================================================================
section('CALENDAR SCOPE & EFFECTIVE DATING');
// =============================================================================

await check('7. legal-entity-specific calendar: its holiday applies only to its employees', async () => {
  await makeEmployee('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', pattern: wp5 });
  await addHoliday('2026-07-06', 'Libur Khusus Mitra', { work_calendar_id: calMitra });

  eq((await dc.classifyDay(db, 'E-MITRA', '2026-07-06')).dayType, 'PUBLIC_HOLIDAY', 'Mitra employee: ');
  eq((await dc.classifyDay(db, 'E-MITRA', '2026-07-06')).calendarId, calMitra);
  // A KAHE employee on the global calendar is unaffected.
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-07-06')).dayType, 'WORKDAY', 'KAHE employee: ');
});

await check('a calendar-agnostic holiday (work_calendar_id NULL) applies to everyone', async () => {
  eq((await dc.classifyDay(db, 'E-MITRA', '2026-08-17')).dayType, 'PUBLIC_HOLIDAY');
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-08-17')).dayType, 'PUBLIC_HOLIDAY');
});

await check('6b. MID-PERIOD CALENDAR CHANGE via effective dating', async () => {
  await makeEmployee('E-SWITCH');
  // 5-day pattern until 14 June, 6-day from 15 June
  await assign('E-SWITCH', { pattern: wp5, from: '2026-01-01', to: '2026-06-14' });
  await assign('E-SWITCH', { pattern: wp6, from: '2026-06-15' });

  // 13 June is a Saturday: workday under both patterns
  eq((await dc.classifyDay(db, 'E-SWITCH', '2026-06-13')).daysPerWeek, 5, 'before switch: ');
  eq((await dc.classifyDay(db, 'E-SWITCH', '2026-06-20')).daysPerWeek, 6, 'after switch: ');
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-SWITCH', '2026-06-07')), 'rest_or_holiday_5day', 'Sunday before: ');
  eq(dc.resolveOvertimeRuleDayType(await dc.classifyDay(db, 'E-SWITCH', '2026-06-21')), 'rest_or_holiday_6day', 'Sunday after: ');
});

await check('a superseded calendar version is not used for dates after it closed', async () => {
  const calOld = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from,effective_to,status)
    VALUES ('OLD_CAL','Kalender Lama',NULL,NULL,'2026-01-01','2026-03-31','superseded') RETURNING id`).run()).lastInsertRowid;
  await makeEmployee('E-OLDCAL'); await assign('E-OLDCAL', { calendar: calOld, pattern: wp5 });
  // The assignment points at a calendar not in force in June -> flagged, not guessed.
  eq((await dc.classifyDay(db, 'E-OLDCAL', '2026-06-15')).status, dc.CLASSIFICATION_STATUS.AMBIGUOUS_CALENDAR);
  eq((await dc.classifyDay(db, 'E-OLDCAL', '2026-02-15')).status, dc.CLASSIFICATION_STATUS.OK, 'in-force date: ');
});

// =============================================================================
section('AMBIGUOUS / MISSING CONFIGURATION (requirement 8)');
// =============================================================================

await check('8a. MISSING CALENDAR/ASSIGNMENT is flagged, never defaulted to WORKDAY', async () => {
  await makeEmployee('E-NOASSIGN');
  const c = await dc.classifyDay(db, 'E-NOASSIGN', '2026-06-15');
  eq(c.status, dc.CLASSIFICATION_STATUS.MISSING_ASSIGNMENT);
  eq(c.dayType, null, 'dayType must be null, not a guess: ');
});

await check('8b. AMBIGUOUS entity calendar (two in force) is flagged', async () => {
  await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from)
              VALUES ('MITRA_CAL_2','Kalender Mitra Kedua','MITRA',NULL,'2026-01-01')`).run();
  const c = await dc.classifyDay(db, 'E-MITRA', '2026-06-15');
  eq(c.status, dc.CLASSIFICATION_STATUS.AMBIGUOUS_CALENDAR);
  eq(c.dayType, null);
  // clean up so later assertions are unaffected
  await db.prepare(`DELETE FROM work_calendars WHERE code = 'MITRA_CAL_2'`).run();
  eq((await dc.classifyDay(db, 'E-MITRA', '2026-06-15')).status, dc.CLASSIFICATION_STATUS.OK, 'after cleanup: ');
});

await check('an unknown employee returns EMPLOYEE_NOT_FOUND, never a crash', async () => {
  eq((await dc.classifyDay(db, 'NOPE', '2026-06-15')).status, dc.CLASSIFICATION_STATUS.EMPLOYEE_NOT_FOUND);
});

// =============================================================================
section('HISTORICAL INTEGRITY & SNAPSHOT (requirements 9 & 10)');
// =============================================================================

await check('9a. a timesheet snapshot survives a later calendar change', async () => {
  await makeEmployee('E-SNAP'); await assign('E-SNAP', { pattern: wp5 });
  const c = await dc.classifyDay(db, 'E-SNAP', '2026-10-05'); // Monday, no holiday yet
  eq(c.dayType, 'WORKDAY');
  const snap = dc.toSnapshot(c);
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,day_type,day_type_source,day_type_calendar_id,day_type_pattern_id,day_classified_at)
              VALUES ('E-SNAP','2026-10-05','present',?,?,?,?,?)`)
    .run(snap.day_type, snap.day_type_source, snap.day_type_calendar_id, snap.day_type_pattern_id, snap.day_classified_at);

  // Someone later declares 5 October a holiday.
  await addHoliday('2026-10-05', 'Libur Ditambahkan Belakangan');

  // Live classification now says holiday...
  eq((await dc.classifyDay(db, 'E-SNAP', '2026-10-05')).dayType, 'PUBLIC_HOLIDAY', 'live reclassification: ');
  // ...but the already-recorded row still carries what applied at the time.
  eq((await db.prepare(`SELECT day_type FROM timesheet_entries WHERE employee_id='E-SNAP'`).get()).day_type, 'WORKDAY',
    'snapshot must NOT change retroactively: ');
});

await check('9b. soft-deleted holiday keeps history explainable', async () => {
  const hid = await addHoliday('2026-11-20', 'Libur Yang Akan Dihapus');
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-11-20')).dayType, 'PUBLIC_HOLIDAY');
  await db.prepare('UPDATE holidays SET is_active = 0 WHERE id = ?').run(hid);
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-11-20')).dayType, 'WORKDAY', 'after soft delete: ');
  // the row itself is still there to explain any snapshot that referenced it
  eq(!!await db.prepare('SELECT id FROM holidays WHERE id = ?').get(hid), true, 'row retained: ');
});

await check('10. snapshot fields are derived, and day_type has a CHECK constraint', async () => {
  const snap = dc.toSnapshot(await dc.classifyDay(db, 'E-5DAY', '2026-06-15'));
  eq(Object.keys(snap).sort(), ['day_classified_at', 'day_type', 'day_type_calendar_id', 'day_type_pattern_id', 'day_type_source']);
  await throws(async () => await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,day_type)
    VALUES ('E-5DAY','2026-12-31','present','SUPER_PREMIUM_DAY')`).run(),
    'an invented day_type must be rejected by the CHECK constraint');
});

// =============================================================================
section('DUPLICATE HOLIDAY & MIDNIGHT-SPANNING');
// =============================================================================

await check('11. duplicate national holiday on one date is still rejected (Phase 0 index intact)', async () => {
  await addHoliday('2026-05-01', 'Hari Buruh');
  await throws(async () => await addHoliday('2026-05-01', 'Hari Buruh (duplikat)'), 'duplicate national holiday must be rejected');
});

await check('a project-scoped holiday may share a date with a national one', async () => {
  const id = await addHoliday('2026-05-01', 'Tambahan Proyek', { scope: 'project', project_code: 'PRJ2' });
  eq(typeof id, 'number');
});

await check('12. midnight-spanning shift classifies by its START date (work_date)', async () => {
  await makeEmployee('E-NIGHT'); await assign('E-NIGHT', { pattern: wp5 });
  // Night shift starting Saturday 20 June 19:00, ending Sunday 04:00.
  // work_date = the start date, so it is a WORKDAY even though it ends on the rest day.
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,shift,clock_in,clock_out,attendance_status)
              VALUES ('E-NIGHT','2026-06-20','night','19:00','04:00','present')`).run();
  const row = await db.prepare(`SELECT * FROM timesheet_entries WHERE employee_id='E-NIGHT'`).get();
  const c = await dc.classifyDay(db, 'E-NIGHT', row.work_date);
  eq(c.dayType, 'WORKDAY', 'Saturday start on a 5-day pattern: ');
  // The model is one row per (employee, work_date); a shift crossing midnight
  // belongs to its start date. Documented, and asserted here so a future
  // change to that convention breaks loudly.
  eq(row.clock_out < row.clock_in, true, 'clock_out earlier than clock_in indicates midnight crossing: ');
});

// =============================================================================
section('REGRESSION — Phase 0 & Phase 1A');
// =============================================================================

await check('13a. Phase 0 B6 eligibility still works', async () => {
  const eligibility = require('../lib/employeeEligibility');
  eq((await eligibility.isEligibleOn(db, 'E-5DAY', '2026-06-15')).eligible, true);
  eq((await eligibility.isEligibleOn(db, 'E-NOASSIGN', '2026-06-15')).reason, 'NO_PAYROLL_ASSIGNMENT');
});

await check('13b. Phase 0 B5 indexes all still present', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_holiday_national_per_date', 'uq_jkk_open_per_risk_class',
    'uq_payroll_assignment_open_per_employee', 'uq_payroll_rule_set_single_active']) {
    if (!names.includes(req)) throw new Error(`missing Phase 0 index: ${req}`);
  }
});

await check('13c. Phase 1A salary structure still resolves', async () => {
  const salary = require('../lib/salaryStructure');
  const money = require('../lib/money');
  const cid = (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
              VALUES ('E-5DAY',?,?, '2026-01-01')`).run(cid, money.rupiahToSen(8000000));
  eq(money.senToRupiah((await salary.getBasesOn(db, 'E-5DAY', '2026-06-15')).grossEarningsSen), 8000000);
});

await check('13d. Phase 1A component indexes still present alongside Phase 1B ones', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_emp_salary_component_open', 'uq_salary_component_open_global',
    'uq_salary_component_open_scoped', 'uq_work_calendar_open_code']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 1B TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
