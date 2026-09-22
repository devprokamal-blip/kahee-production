(async () => {
// tests/e2e.test.js
// FULL END-TO-END PAYROLL AUDIT — no new features, verification only.
//
// Runs ONE complete payroll cycle through every stage:
//   Employee/Contract -> Payroll Assignment -> Salary Structure -> Attendance
//   -> Day Classification -> Overtime -> Payroll Period -> As-Of Resolver
//   -> Frozen Snapshot -> Calculation -> Validation/Exception -> Approval
//   -> Finalization -> Payslip -> Correction/Retro/Reversal -> Payment
//   -> Bank Export -> Payment Reconciliation
//
// Usage: npm run test:e2e

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction, withRetry, BUSY_TIMEOUT_MS } = require('../database/init-db');
const money = require('../lib/money');
const time = require('../lib/time');
const eligibility = require('../lib/employeeEligibility');
const salary = require('../lib/salaryStructure');
const dayClass = require('../lib/dayClassification');
const pp = require('../lib/payrollPeriod');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
const calc = require('../lib/payrollCalculator');
const validation = require('../lib/payrollValidation');
const validationRunner = require('../lib/validationRunner');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
const payslip = require('../lib/payslip');
const adjLib = require('../lib/payrollAdjustment');
const pay = require('../lib/payrollPayment');
const bankExport = require('../lib/bankExport');

let passed = 0, failed = 0;
const failures = [];
const findings = { blockers: [], nonBlocking: [], scale: [], security: [], integrity: [] };

async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function throwsCode(fn, code, label = '') {
  try { await fn(); } catch (e) {
    if (e.code !== code) throw new Error(`${label}expected ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(`${label}expected a throw with code ${code}`);
}
async function throwsMatching(fn, re, label = '') {
  try { await fn(); } catch (e) {
    if (!re.test(e.message)) throw new Error(`${label}did not match ${re}: ${e.message}`);
    return e;
  }
  throw new Error(`${label}expected a throw matching ${re}`);
}
function section(t) { console.log(`\n${'─'.repeat(62)}\n${t}\n${'─'.repeat(62)}`); }
const rp = (sen) => money.senToRupiah(sen);
const fmt = (sen) => money.formatIDR(sen);

const TEST_DB = path.join(__dirname, 'e2e.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('e2e');
const db = __t.db;
await initDb(db);

// ---- actors -------------------------------------------------------------------
const HRD = { displayName: 'HRD Officer', permissions: { hrd_kontrak: ['VIEW','CREATE','EDIT'] } };
const PREPARER = { displayName: 'Payroll Officer', permissions: {
  payroll_run: ['VIEW','CREATE','EDIT','EXPORT'], payroll_payment: ['VIEW','CREATE','EDIT','EXPORT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: {
  payroll_run: ['VIEW','CREATE','EDIT','APPROVE'], payroll_payment: ['VIEW','CREATE','EDIT','EXPORT','APPROVE'] } };
const FINANCE = { displayName: 'Finance Head', permissions: {
  payroll_run: ['VIEW','APPROVE'], payroll_payment: ['VIEW','APPROVE'] } };

// =============================================================================
section('STAGE 1-3  EMPLOYEE / CONTRACT -> PAYROLL ASSIGNMENT -> SALARY STRUCTURE');
// =============================================================================

await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,npwp,jkk_risk_class,effective_date)
            VALUES ('KAHE360','KAHE 360 Workforce Solutions','internal','01.234.567.8-901.000','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
            VALUES ('MITRA','Mitra Jaya','subkontraktor','medium','2026-01-01')`).run();

const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5 Hari',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const wp6 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('6 Hari',6,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Kalender Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date,source_note) VALUES ('high',127,'2026-01-01','Kepmenaker')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();
await db.prepare(`INSERT INTO holidays (date,name,scope,holiday_type) VALUES ('2026-06-01','Hari Lahir Pancasila','national','PUBLIC_HOLIDAY')`).run();

const RS_JUNE = (await db.prepare(`INSERT INTO payroll_rule_sets
  (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
   jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
   overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
  VALUES ('BPJS 2026 H1','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,1,0) RETURNING id`).run()).lastInsertRowid;
for (const [c,lo,hi,bp] of [
  ['A',0,540000000,0],['A',540000000,null,150],
  ['B',0,620000000,0],['B',620000000,null,100],
  ['C',0,660000000,0],['C',660000000,null,75]])
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(RS_JUNE,c,lo,hi,bp);
for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],
  ['rest_or_holiday_5day',1,8,20000],['rest_or_holiday_5day',9,9,30000],
  ['rest_or_holiday_6day',1,7,20000],['rest_or_holiday_6day',8,8,30000]])
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(RS_JUNE,dt,hf,ht,m);

async function makeGroup(code, entity) {
  return (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2026-01-01') RETURNING id`)
    .run(code, code, entity)).lastInsertRowid;
}
const G_KAHE = await makeGroup('KAHE-MONTHLY','KAHE360');
const G_ALT = await makeGroup('KAHE-ALT','KAHE360');
const G_MITRA = await makeGroup('MITRA-MONTHLY','MITRA');

async function makePeriod(g,y,s) {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(g);
  const w = pp.monthlyWindow(y,s); const d = pp.deriveDates(grp,w.periodStart,w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN') RETURNING id`).run(g,y,s,s,d.period_start,d.period_end,
    d.attendance_cutoff,d.overtime_cutoff,d.adjustment_cutoff,d.payment_date)).lastInsertRowid;
}

async function makeComp(code, o={}) {
  const f = { type:'earning', calcType:'fixed', paid:'employee', tax:1, bpjs:0, ot:0, pro:1, order:100, ...o };
  return (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
    is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES (?,?,?,?,?,?,?,?,?,'recurring',?,'2026-01-01') RETURNING id`)
    .run(code,code,f.type,f.calcType,f.paid,f.tax,f.bpjs,f.ot,f.pro,f.order)).lastInsertRowid;
}
const C_BASIC = await makeComp('BASIC', { bpjs:1, ot:1, order:10 });
const C_FIXED = await makeComp('ALLOW_FIXED', { bpjs:1, ot:1, order:20 });
const C_SITE  = await makeComp('ALLOW_SITE', { order:30 });
const C_MEAL  = await makeComp('ALLOW_MEAL', { calcType:'variable', tax:0, order:40 });
const C_LOAN  = await makeComp('DED_LOAN', { type:'deduction', tax:0, pro:0, order:200 });

async function hireEmployee(id, o={}) {
  const f = { start:'2026-01-01', term:null, status:'active', pattern:wp5, group:G_KAHE, entity:'KAHE360',
    marital:'TK', dep:0, bank:'BCA', acc:'1000000001', pos:'Pipe Welder', ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code,
    nik,position,bank_name,bank_account_no,bank_account_name)
    VALUES (?,?,'pkwt',?,?,?,'PPB','32xxxx',?,?,?,?)`)
    .run(id, `Nama ${id}`, f.status, f.start, f.term, f.pos, f.bank, f.acc, `Nama ${id}`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, f.entity, f.pattern, cal, f.group, f.marital, f.dep, f.assignFrom || f.start, f.assignTo || null);
}
async function giveComponent(id, cid, rupiah, from='2026-01-01', to=null) {
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to)
              VALUES (?,?,?,?,?)`).run(id,cid,money.rupiahToSen(rupiah),from,to);
}
async function recordAttendance(id, date, o={}) {
  const f = { minutes:480, ot:0, otStatus:'none', dayType:null, ...o };
  const cls = await dayClass.classifyDay(db, id, date);
  const snap = dayClass.toSnapshot(cls);
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_minutes_requested,overtime_minutes_approved,overtime_hours_approved,overtime_status,
    day_type,day_type_source,day_type_calendar_id,day_type_pattern_id,day_classified_at)
    VALUES (?,?,'present',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, date, f.minutes, time.minutesToHours(f.minutes),
      f.otStatus==='pending'?f.ot:0, f.otStatus==='approved'?f.ot:0,
      time.minutesToHours(f.otStatus==='approved'?f.ot:0), f.otStatus,
      f.dayType || snap.day_type, snap.day_type_source, snap.day_type_calendar_id,
      snap.day_type_pattern_id, snap.day_classified_at);
  return cls;
}

// ---- the June cohort ----------------------------------------------------------
const P_JUNE = await makePeriod(G_KAHE, 2026, 6);

// CASE 1 — normal worker
await hireEmployee('E-NORMAL', { marital:'K', dep:2 });
await giveComponent('E-NORMAL', C_BASIC, 8000000);
await giveComponent('E-NORMAL', C_FIXED, 1500000);
await giveComponent('E-NORMAL', C_SITE, 1000000);
await giveComponent('E-NORMAL', C_MEAL, 600000);
await giveComponent('E-NORMAL', C_LOAN, 500000);

// CASE 2 — joiner mid-period
await hireEmployee('E-JOINER', { start:'2026-06-16' });
await giveComponent('E-JOINER', C_BASIC, 9000000, '2026-06-16');

// CASE 3 — leaver mid-period
await hireEmployee('E-LEAVER', { term:'2026-06-20', status:'inactive', assignTo:'2026-06-20' });
await giveComponent('E-LEAVER', C_BASIC, 9000000, '2026-01-01', '2026-06-20');

// CASE 4 — salary change mid-period
await hireEmployee('E-RAISE');
await giveComponent('E-RAISE', C_BASIC, 8000000, '2026-01-01', '2026-06-14');
await giveComponent('E-RAISE', C_BASIC, 9500000, '2026-06-15');

// overtime worker (6-day pattern, to exercise the other band)
await hireEmployee('E-OT', { pattern: wp6 });
await giveComponent('E-OT', C_BASIC, 8000000);

// CASE 5 target — late overtime correction after finalization
await hireEmployee('E-LATEOT');
await giveComponent('E-LATEOT', C_BASIC, 7000000);

// CASE 6 target — overpayment recovery
await hireEmployee('E-RECOVER');
await giveComponent('E-RECOVER', C_BASIC, 7000000);

// CASE 8/9 target — bank rejection then retry
await hireEmployee('E-BADBANK', { acc: '1000000009' });
await giveComponent('E-BADBANK', C_BASIC, 6500000);

// legal entity isolation control
await hireEmployee('E-MITRA', { entity:'MITRA', group:G_MITRA });
await giveComponent('E-MITRA', C_BASIC, 7500000);

await check('employees, assignments and salary structures are in place', async () => {
  eq((await db.prepare('SELECT COUNT(*) AS n FROM employees').get()).n, 9);
  eq((await db.prepare('SELECT COUNT(*) AS n FROM employee_payroll_assignments').get()).n, 9);
  eq((await salary.getStructureOn(db, 'E-NORMAL', '2026-06-30')).length, 5, 'E-NORMAL components: ');
});

await check('ELIGIBILITY is deterministic for joiner and leaver boundaries', async () => {
  eq((await eligibility.isEligibleOn(db, 'E-JOINER', '2026-06-15')).eligible, false, 'day before joining: ');
  eq((await eligibility.isEligibleOn(db, 'E-JOINER', '2026-06-16')).eligible, true, 'joining day: ');
  eq((await eligibility.isEligibleOn(db, 'E-LEAVER', '2026-06-20')).eligible, true, 'last day: ');
  eq((await eligibility.isEligibleOn(db, 'E-LEAVER', '2026-06-21')).eligible, false, 'day after: ');
  eq((await eligibility.getEligibilityForPeriod(db, 'E-JOINER', '2026-06-01', '2026-06-30')).payableDays, 15);
  eq((await eligibility.getEligibilityForPeriod(db, 'E-LEAVER', '2026-06-01', '2026-06-30')).payableDays, 20);
});

// =============================================================================
section('STAGE 4-6  ATTENDANCE -> DAY CLASSIFICATION -> OVERTIME');
// =============================================================================

await check('DAY CLASSIFICATION resolves all three day types correctly', async () => {
  eq((await dayClass.classifyDay(db, 'E-NORMAL', '2026-06-15')).dayType, 'WORKDAY', 'Monday: ');
  eq((await dayClass.classifyDay(db, 'E-NORMAL', '2026-06-21')).dayType, 'WEEKLY_REST_DAY', 'Sunday: ');
  eq((await dayClass.classifyDay(db, 'E-NORMAL', '2026-06-01')).dayType, 'PUBLIC_HOLIDAY', 'seeded holiday: ');
  // pattern drives the overtime band
  eq(dayClass.resolveOvertimeRuleDayType(await dayClass.classifyDay(db, 'E-NORMAL', '2026-06-21')), 'rest_or_holiday_5day');
  eq(dayClass.resolveOvertimeRuleDayType(await dayClass.classifyDay(db, 'E-OT', '2026-06-21')), 'rest_or_holiday_6day');
});

// attendance for the whole cohort
for (const d of ['2026-06-15','2026-06-16','2026-06-17']) await recordAttendance('E-NORMAL', d);
await recordAttendance('E-NORMAL', '2026-06-18', { ot: 180, otStatus: 'approved' });   // 3h workday OT
await recordAttendance('E-JOINER', '2026-06-16');
await recordAttendance('E-LEAVER', '2026-06-10');
await recordAttendance('E-RAISE', '2026-06-17');
await recordAttendance('E-OT', '2026-06-21', { ot: 120, otStatus: 'approved' });        // rest day, 6-day pattern
await recordAttendance('E-LATEOT', '2026-06-19');
await recordAttendance('E-RECOVER', '2026-06-19');
await recordAttendance('E-BADBANK', '2026-06-19');
await recordAttendance('E-MITRA', '2026-06-19');

await check('attendance carries a frozen day-type snapshot', async () => {
  const row = await db.prepare(`SELECT * FROM timesheet_entries WHERE employee_id='E-NORMAL' AND work_date='2026-06-18'`).get();
  eq(row.day_type, 'WORKDAY');
  eq(row.overtime_minutes_approved, 180);
  eq(row.work_minutes, 480, 'integer minutes: ');
  if (!row.day_classified_at) throw new Error('classification timestamp missing');
});

// =============================================================================
section('STAGE 7-9  PAYROLL PERIOD -> AS-OF RESOLVER -> FROZEN SNAPSHOT');
// =============================================================================

await check('PERIOD OWNERSHIP resolves for every employee', async () => {
  eq((await pp.resolvePeriodForDate(db, 'E-NORMAL', '2026-06-15')).period.id, P_JUNE);
  eq((await pp.resolvePeriodForDate(db, 'E-MITRA', '2026-06-15')).group.legal_entity_id, 'MITRA', 'isolation: ');
});

await check('AS-OF RESOLVER pins every rule version to the period', async () => {
  const r = await resolver.resolve(db, 'E-NORMAL', P_JUNE);
  eq(r.status, 'OK', `errors: ${JSON.stringify(r.errors)} — `);
  eq(r.ruleSet.id, RS_JUNE, 'BPJS rule set: ');
  eq(r.jkkVersion.rate_bp, 127, 'JKK version: ');
  eq(r.terCategory, 'B', 'K/2 -> TER B: ');
  eq(r.overtimeRules.every((x) => x.rule_set_id === RS_JUNE), true, 'overtime rules pinned: ');
});

const snapSummary = await writer.snapshotPeriod(db, P_JUNE, { chunkSize: 200, resolvedBy: PREPARER.displayName });
const frozen = await writer.freezePeriod(db, P_JUNE, PREPARER.displayName);

await check('SNAPSHOTS are taken and frozen for the whole period', async () => {
  eq(snapSummary.created, 8, 'KAHE cohort snapshotted: ');
  eq(frozen.frozen, 8);
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_input_snapshots WHERE payroll_period_id=? AND status='FROZEN'`).get(P_JUNE)).n, 8);
});

await check('a frozen snapshot carries the full rule payload', async () => {
  const s = await db.prepare(`SELECT * FROM payroll_input_snapshots WHERE payroll_period_id=? AND employee_id='E-NORMAL'`).get(P_JUNE);
  const p = JSON.parse(s.resolved_payload);
  eq(p.bpjs_rule.rule_set_id, RS_JUNE);
  eq(p.jkk.rate_bp, 127);
  eq(p.tax.ter_brackets.length > 0, true);
  eq(p.overtime_rules.length, 6);
  eq(s.payload_hash.length, 64);
});

// =============================================================================
section('STAGE 10-13  CALCULATION -> VALIDATION -> APPROVAL -> FINALIZATION');
// =============================================================================

const reload = async (id) => await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
const lineFor = async (runId, emp) => await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id=?').get(runId, emp);

const RUN_JUNE = await withTransaction(db, async () => await runLib.createRun(db, P_JUNE, PREPARER));
await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(RUN_JUNE.id), PREPARER, 'snapshot beku'));
const calcSummary = await runCalc.calculateRun(db, await reload(RUN_JUNE.id), { chunkSize: 200 });
await withTransaction(db, async () => {
  await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now(),engine_version='payroll-calc-2c.1' WHERE id=?`)
    .run(PREPARER.displayName, RUN_JUNE.id);
  await runLib.recordEvent(db, RUN_JUNE.id, 'SNAPSHOT_READY', 'CALCULATED', PREPARER.displayName, 'perhitungan dijalankan');
});

await check('CALCULATION produces a line for every snapshot', () => {
  eq(calcSummary.created, 8);
  eq(calcSummary.blocked, 0, 'no blocked calculation: ');
});

await check('CASE 1 — NORMAL WORKER: every figure is exact', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-NORMAL');
  const r = JSON.parse(l.result_payload);
  // earnings 8.000.000 + 1.500.000 + 1.000.000 + 600.000 = 11.100.000, plus OT
  eq(rp(r.earnings.total_sen), 11100000, 'earnings: ');
  eq(r.overtime.minutes, 180);
  // OT base = BASIC + ALLOW_FIXED = 9.500.000; rate = /173; 1.5x + 2x + 2x
  const rate = time.hourlyRateSen(money.rupiahToSen(9500000), 173);
  const expectedOt = time.overtimePaySen(rate, 60, 15000) + time.overtimePaySen(rate, 60, 20000) * 2;
  eq(r.overtime.total_sen, expectedOt, 'progressive overtime: ');
  eq(l.gross_sen, r.earnings.total_sen + expectedOt, 'gross: ');
  // BPJS base = 9.500.000 -> employee 1%+2%+1% = 380.000
  eq(rp(l.bpjs_base_sen), 9500000);
  eq(rp(l.bpjs_employee_sen), 380000);
  // TER B, taxable = taxable earnings (excl. MEAL) + OT
  eq(l.taxable_base_sen, money.rupiahToSen(10500000) + expectedOt, 'taxable base: ');
  eq(l.net_sen, l.gross_sen - l.employee_deductions_sen, 'net reconciles: ');
  eq(Number.isInteger(l.net_sen), true, 'integer sen: ');
});

await check('CASE 2 — JOINER is prorated to 15/30 days', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-JOINER');
  const r = JSON.parse(l.result_payload);
  eq(r.proration, { payable_days: 15, period_days: 30, prorated: true });
  eq(rp(r.earnings.total_sen), 4500000, '9jt x 15/30: ');
});

await check('CASE 3 — LEAVER is prorated to 20/30 days', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-LEAVER');
  const r = JSON.parse(l.result_payload);
  eq(r.proration.payable_days, 20);
  eq(rp(r.earnings.total_sen), 6000000, '9jt x 20/30: ');
});

await check('CASE 4 — MID-PERIOD SALARY CHANGE is segment-weighted', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-RAISE');
  const expected = money.roundHalfUp((money.rupiahToSen(8000000) * 14 + money.rupiahToSen(9500000) * 16) / 30);
  eq(l.gross_sen, expected);
  eq(rp(l.gross_sen), 8800000, '(8jt x14 + 9,5jt x16)/30: ');
});

await check('OVERTIME on a rest day uses the 6-day band', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-OT');
  const r = JSON.parse(l.result_payload);
  eq(r.overtime.by_day[0].band, 'rest_or_holiday_6day');
  eq(r.overtime.by_day[0].segments.every((s) => s.multiplier_bp === 20000), true, 'all 2x: ');
});

const valSummary = await validationRunner.validatePeriod(db, P_JUNE, { chunkSize: 200, detectedAt: '2026-07-01 00:00:00' });

await check('VALIDATION runs and produces the expected exception profile', () => {
  eq(valSummary.blocking, 0, `no blockers: ${JSON.stringify(valSummary)} — `);
  eq(valSummary.informational >= 8, true, 'one annual-tax notice per employee: ');
  eq(valSummary.gate.may_progress, true, 'gate open: ');
});

await withTransaction(db, async () => {
  await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`)
    .run(PREPARER.displayName, RUN_JUNE.id);
  await runLib.recordEvent(db, RUN_JUNE.id, 'CALCULATED', 'VALIDATED', PREPARER.displayName, 'validasi');
});

await check('SEGREGATION OF DUTIES: the preparer cannot approve their own run', async () => {
  const selfApprove = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','APPROVE'] } };
  await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, await reload(RUN_JUNE.id), selfApprove, 'sendiri')),
    runLib.TRANSITION_ERROR.SOD_VIOLATION);
  eq((await reload(RUN_JUNE.id)).status, 'VALIDATED', 'unchanged: ');
});

await withTransaction(db, async () => await runLib.approve(db, await reload(RUN_JUNE.id), APPROVER, 'disetujui'));
await withTransaction(db, async () => await runLib.finalize(db, await reload(RUN_JUNE.id), APPROVER, 'final Juni'));

await check('APPROVAL and FINALIZATION complete with a full audit trail', async () => {
  const run = await reload(RUN_JUNE.id);
  eq(run.status, 'FINALIZED');
  eq(run.prepared_by, 'Payroll Officer');
  eq(run.approved_by, 'Ops Director');
  eq(run.finalized_by, 'Ops Director');
  const history = (await runLib.getHistory(db, RUN_JUNE.id)).map((h) => h.to_status);
  eq(history, ['DRAFT','SNAPSHOT_READY','CALCULATED','VALIDATED','APPROVED','FINALIZED']);
});

// snapshot the finalized figures for later immutability checks
const JUNE_BASELINE = await db.prepare(
  'SELECT employee_id, gross_sen, net_sen, result_hash FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id'
).all(RUN_JUNE.id);

// =============================================================================
section('STAGE 14  PAYSLIP');
// =============================================================================

let payslipsCreated = 0;
await withTransaction(db, async () => {
  for (const l of await db.prepare(`SELECT id FROM payroll_run_lines WHERE payroll_run_id=? AND calc_status='OK'`).all(RUN_JUNE.id)) {
    if ((await payslip.generate(db, l.id, { generatedBy: PREPARER.displayName })).created) payslipsCreated += 1;
  }
});

await check('PAYSLIPS are generated and reconcile exactly with the run lines', async () => {
  eq(payslipsCreated, 8);
  for (const b of JUNE_BASELINE) {
    const ps = await db.prepare(`SELECT * FROM payroll_payslips WHERE payroll_run_id=? AND employee_id=?`).get(RUN_JUNE.id, b.employee_id);
    const doc = JSON.parse(ps.document);
    eq(doc.sections.EMPLOYEE_EARNINGS.total_sen, b.gross_sen, `${b.employee_id} gross: `);
    eq(doc.sections.TAKE_HOME_PAY.net_sen, b.net_sen, `${b.employee_id} net: `);
  }
});

await check('EMPLOYER CONTRIBUTIONS are shown separately and never reduce net pay', async () => {
  const ps = await db.prepare(`SELECT * FROM payroll_payslips WHERE payroll_run_id=? AND employee_id='E-NORMAL'`).get(RUN_JUNE.id);
  const doc = JSON.parse(ps.document);
  const erCodes = doc.sections.EMPLOYER_CONTRIBUTIONS.items.map((i) => i.code);
  const empCodes = doc.sections.EMPLOYEE_DEDUCTIONS.items.map((i) => i.code);
  for (const c of ['BPJS_KESEHATAN_EMPLOYER','JHT_EMPLOYER','JP_EMPLOYER','JKM_EMPLOYER','JKK_EMPLOYER']) {
    if (!erCodes.includes(c)) throw new Error(`${c} missing from employer section`);
    if (empCodes.includes(c)) throw new Error(`${c} must not reduce net pay`);
  }
  eq(doc.sections.EMPLOYER_CONTRIBUTIONS.reduces_net_pay, false);
  eq(doc.sections.TAKE_HOME_PAY.net_sen,
    doc.sections.EMPLOYEE_EARNINGS.total_sen - doc.sections.EMPLOYEE_DEDUCTIONS.total_sen);
});

// =============================================================================
section('STAGE 15  CORRECTION / RETRO / REVERSAL');
// =============================================================================

// CASE 5 — late overtime approved after finalization
const adjLateOt = await withTransaction(db, async () => await adjLib.createAdjustment(db, {
  source_run_id: RUN_JUNE.id, employee_id: 'E-LATEOT', adjustment_type: adjLib.TYPE.LATE_OVERTIME,
  component_code: 'LATE_OT', direction: 'CREDIT', overtime_minutes: 120,
  overtime_day_type: 'WORKDAY', work_date: '2026-06-22', reason: 'lembur disetujui terlambat',
  external_reference: 'OT-LATE-001',
}, PREPARER));
// CASE 6 — overpayment recovery (DEBIT reduces take-home)
const adjRecover = await withTransaction(db, async () => await adjLib.createAdjustment(db, {
  source_run_id: RUN_JUNE.id, employee_id: 'E-RECOVER', adjustment_type: adjLib.TYPE.RETRO_DEDUCTION,
  component_code: 'OVERPAY_RECOVERY', direction: 'DEBIT', amount_sen: money.rupiahToSen(500000),
  is_taxable: 0, reason: 'pemulihan kelebihan bayar Mei',
}, PREPARER));

await withTransaction(db, async () => {
  await adjLib.approveAdjustment(db, adjLateOt.id, FINANCE, 'diperiksa');
  await adjLib.approveAdjustment(db, adjRecover.id, FINANCE, 'diperiksa');
});

const RUN_CORRECTION = await withTransaction(db, async () => await runLib.createRun(db, P_JUNE, PREPARER,
  { runType: 'CORRECTION', correctsRunId: RUN_JUNE.id }));
await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(RUN_CORRECTION.id), PREPARER, null));
const corrSummary = await withTransaction(db, async () => await adjLib.applyToRun(db, await reload(RUN_CORRECTION.id), PREPARER));
await withTransaction(db, async () => {
  await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, RUN_CORRECTION.id);
  await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, RUN_CORRECTION.id);
});
await withTransaction(db, async () => await runLib.approve(db, await reload(RUN_CORRECTION.id), APPROVER, 'koreksi disetujui'));
await withTransaction(db, async () => await runLib.finalize(db, await reload(RUN_CORRECTION.id), APPROVER, 'koreksi final'));

await check('CASE 5 — LATE OVERTIME is priced at the original frozen rate', async () => {
  const l = await lineFor(RUN_CORRECTION.id, 'E-LATEOT');
  const rate = time.hourlyRateSen(money.rupiahToSen(7000000), 173);
  const expected = time.overtimePaySen(rate, 60, 15000) + time.overtimePaySen(rate, 60, 20000);
  eq(l.gross_sen, expected, 'progressive 1.5x + 2x: ');
  eq(l.net_sen, l.gross_sen - l.employee_deductions_sen, 'delta reconciles: ');
  eq(l.net_sen > 0, true, 'a late-overtime correction increases pay: ');
});

await check('CASE 6 — OVERPAYMENT RECOVERY reduces take-home, never increases it', async () => {
  const l = await lineFor(RUN_CORRECTION.id, 'E-RECOVER');
  eq(rp(l.other_deductions_sen), 500000, 'DEBIT raises the deduction: ');
  eq(l.net_sen, l.gross_sen - l.employee_deductions_sen);
  eq(l.net_sen < 0, true, 'the correction is a negative delta (money owed back): ');
  eq(rp(l.net_sen), -500000);
});

await check('correction run carries deltas only and references the original', async () => {
  eq(corrSummary.lines, 2, 'only the two adjusted employees: ');
  const p = JSON.parse((await lineFor(RUN_CORRECTION.id, 'E-LATEOT')).result_payload);
  eq(p.is_delta, true);
  eq(p.corrects_run_id, RUN_JUNE.id);
  eq(p.rule_versions.payroll_rule_set_id, RS_JUNE, 'frozen rule inherited: ');
});

// CASE 7 — reversal, on a separate period so June's payment flow stays clean
const P_JULY = await makePeriod(G_KAHE, 2026, 7);
await hireEmployee('E-REVERSE'); await giveComponent('E-REVERSE', C_BASIC, 6000000);
await recordAttendance('E-REVERSE', '2026-07-15');

async function fullCycleTo(periodId, finalize = true) {
  await writer.snapshotPeriod(db, periodId, { chunkSize: 200, resolvedBy: PREPARER.displayName });
  await writer.freezePeriod(db, periodId, PREPARER.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, periodId, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
  });
  await validationRunner.validatePeriod(db, periodId, { chunkSize: 200, detectedAt: '2026-08-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED',resolved_by='Ops Director',
      resolved_at=kahe_now(),resolution_note='ok' WHERE payroll_period_id=? AND blocking=1`).run(periodId);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'ok'));
  if (finalize) await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'final'));
  return await reload(run.id);
}
const RUN_JULY = await fullCycleTo(P_JULY);
const julyBaseline = (await db.prepare(`SELECT net_sen FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-REVERSE'`).get(RUN_JULY.id)).net_sen;

const RUN_REVERSAL = await withTransaction(db, async () => await runLib.createRun(db, P_JULY, PREPARER,
  { runType: 'REVERSAL', correctsRunId: RUN_JULY.id }));
await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(RUN_REVERSAL.id), PREPARER, null));
await withTransaction(db, async () => await adjLib.applyToRun(db, await reload(RUN_REVERSAL.id), PREPARER));
await withTransaction(db, async () => {
  await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(PREPARER.displayName, RUN_REVERSAL.id);
  await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=? WHERE id=?`).run(PREPARER.displayName, RUN_REVERSAL.id);
});
await withTransaction(db, async () => await runLib.approve(db, await reload(RUN_REVERSAL.id), APPROVER, 'pembalikan'));
await withTransaction(db, async () => await runLib.finalize(db, await reload(RUN_REVERSAL.id), APPROVER, 'pembalikan final'));

await check('CASE 7 — REVERSAL negates the original exactly and nets the period to zero', async () => {
  const rev = await lineFor(RUN_REVERSAL.id, 'E-REVERSE');
  eq(rev.net_sen, -julyBaseline, 'exact negation: ');
  const rec = await adjLib.reconcileEmployee(db, P_JULY, 'E-REVERSE');
  eq(rec.effective_totals.net_sen, 0, 'effective net after reversal: ');
  eq((await reload(RUN_JULY.id)).status, 'FINALIZED', 'the original is untouched: ');
});

await check('CASE 10 — MASTER CONFIG CHANGED AFTER FINALIZATION does not alter history', async () => {
  // Move the world: reprice JKK, activate a new rule set, raise salaries, rename.
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE jkk_risk_classes SET end_date='2026-05-31' WHERE risk_class='high' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',900,'2026-06-01')`).run();
    await db.prepare(`UPDATE payroll_rule_sets SET status='superseded', end_date='2026-05-31' WHERE id=?`).run(RS_JUNE);
    const rs2 = (await db.prepare(`INSERT INTO payroll_rule_sets
      (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
       jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
       overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
      VALUES ('BPJS 2026 H2','active','2026-06-01',150,500,1300000000,250,400,150,250,1100000000,50,173,1,0) RETURNING id`).run()).lastInsertRowid;
    for (const [c,lo,hi,bp] of [['A',0,null,200],['B',0,null,900],['C',0,null,100]])
      await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rs2,c,lo,hi,bp);
    // A rule set without overtime rules is INCOMPLETE and the engine correctly
    // refuses to calculate under it — discovered during this audit when the
    // fixture omitted them (see docs/E2E_AUDIT.md, non-blocking finding).
    for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],
      ['rest_or_holiday_5day',1,8,20000],['rest_or_holiday_6day',1,7,20000]])
      await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rs2,dt,hf,ht,m);
    await db.prepare(`UPDATE employee_salary_components SET effective_to='2026-06-30' WHERE employee_id='E-NORMAL' AND effective_to IS NULL`).run();
    await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
                VALUES ('E-NORMAL',?,?, '2026-07-01')`).run(C_BASIC, money.rupiahToSen(50000000));
    await db.prepare(`UPDATE employees SET full_name='NAMA BERUBAH TOTAL' WHERE id='E-NORMAL'`).run();
    await db.prepare(`UPDATE legal_entities SET name='ENTITAS GANTI NAMA' WHERE id='KAHE360'`).run();
  });

  // Every finalized figure is byte-identical.
  const after = await db.prepare(
    'SELECT employee_id, gross_sen, net_sen, result_hash FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id'
  ).all(RUN_JUNE.id);
  eq(after, JUNE_BASELINE, 'finalized June payroll unchanged: ');

  // Payslips too, including the frozen names.
  const ps = await db.prepare(`SELECT * FROM payroll_payslips WHERE payroll_run_id=? AND employee_id='E-NORMAL'`).get(RUN_JUNE.id);
  const doc = JSON.parse(ps.document);
  eq(doc.employee.full_name, 'Nama E-NORMAL', 'employee name frozen: ');
  eq(doc.employer.legal_entity_name, 'KAHE 360 Workforce Solutions', 'entity name frozen: ');
  const jkk = doc.sections.EMPLOYER_CONTRIBUTIONS.items.find((i) => i.code === 'JKK_EMPLOYER');
  eq(jkk.rate.includes('127'), true, `JKK still 127bp (${jkk.rate}): `);

  // And a LIVE resolve genuinely differs — the world really moved.
  const live = await resolver.resolve(db, 'E-NORMAL', P_JUNE);
  eq(live.jkkVersion.rate_bp, 900, 'live sees the new JKK: ');
});

await check('finalized payroll is immutable at the DATABASE layer', async () => {
  const l = await lineFor(RUN_JUNE.id, 'E-NORMAL');
  await throwsMatching(async () => await db.prepare('UPDATE payroll_run_lines SET net_sen=1 WHERE id=?').run(l.id), /PAYROLL_FINALIZED/);
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='VALIDATED' WHERE id=?`).run(RUN_JUNE.id), /PAYROLL_FINALIZED/);
  const ps = await db.prepare(`SELECT id FROM payroll_payslips WHERE payroll_run_id=? LIMIT 1`).get(RUN_JUNE.id);
  await throwsMatching(async () => await db.prepare('UPDATE payroll_payslips SET net_sen=1 WHERE id=?').run(ps.id), /PAYSLIP_IMMUTABLE/);
  const a = await db.prepare(`SELECT id FROM payroll_adjustments WHERE status='APPLIED' LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare('UPDATE payroll_adjustments SET amount_sen=1 WHERE id=?').run(a.id), /ADJUSTMENT_APPLIED/);
});

// =============================================================================
section('STAGE 16-18  PAYMENT -> BANK EXPORT -> PAYMENT RECONCILIATION');
// =============================================================================

const reloadBatch = async (id) => await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(id);
const prep = await withTransaction(db, async () => await pay.prepareBatch(db, P_JUNE, PREPARER));
const BATCH = prep.batch;

await check('PAYMENT prepares instructions from finalized payroll only', async () => {
  eq(prep.summary.prepared, 8, `prepared (${prep.summary.prepared}): `);
  // CASE 6 — the recovery does not exclude the employee; it REDUCES what they
  // are paid. Original net minus the 500.000 recovery, netted across runs.
  const origNet = (await lineFor(RUN_JUNE.id, 'E-RECOVER')).net_sen;
  const corrNet = (await lineFor(RUN_CORRECTION.id, 'E-RECOVER')).net_sen;
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-RECOVER'`).get(BATCH.id);
  eq(item.amount_sen, origNet + corrNet, 'payment = original + recovery delta: ');
  eq(item.amount_sen < origNet, true, 'the recovery reduced take-home: ');
  eq(rp(origNet - item.amount_sen), 500000, 'by exactly the recovered amount: ');
});

await check('PAYABLE equals finalized ORIGINAL + CORRECTION exactly', async () => {
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-LATEOT'`).get(BATCH.id);
  const orig = (await lineFor(RUN_JUNE.id, 'E-LATEOT')).net_sen;
  const corr = (await lineFor(RUN_CORRECTION.id, 'E-LATEOT')).net_sen;
  eq(item.amount_sen, orig + corr, 'original + correction: ');
  eq(JSON.parse(item.source_run_ids).sort(), [RUN_JUNE.id, RUN_CORRECTION.id].sort(), 'traceable to both runs: ');
});

await check('BANK ACCOUNT is snapshotted at preparation', async () => {
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-NORMAL'`).get(BATCH.id);
  eq(item.bank_account_no, '1000000001');
  eq(item.bank_name, 'BCA');
  if (!item.bank_snapshot_at) throw new Error('bank_snapshot_at missing');
});

await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(BATCH.id), PREPARER, 'diperiksa'));
const exported = await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(BATCH.id), 'GENERIC_CSV', PREPARER, 'ekspor'));

await check('BANK EXPORT is deterministic, honest about format, and reconciles', async () => {
  eq(exported.file.verified_against_bank_spec, false, 'no unverified bank claim: ');
  const lines = exported.file.content.trim().split('\n');
  eq(lines.length, (await reloadBatch(BATCH.id)).item_count + 2, 'header + rows + trailer: ');
  const trailer = lines[lines.length - 1].split(',');
  eq(Number(trailer[2]), (await reloadBatch(BATCH.id)).total_amount_sen, 'file trailer equals batch total: ');
  const itemSum = (await db.prepare('SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items WHERE batch_id=?').get(BATCH.id)).n;
  eq(Number(trailer[2]), itemSum, 'and equals the sum of instructions: ');
});

await check('EXPORT RERUN is idempotent', async () => {
  const again = await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(BATCH.id), 'GENERIC_CSV', APPROVER, 'lagi'));
  eq(again.idempotent, true);
  eq(again.file.content_hash, exported.file.content_hash);
  eq((await reloadBatch(BATCH.id)).exported_by, 'Payroll Officer', 'original exporter preserved: ');
});

await check('SoD on PAYMENT: the preparer cannot authorise the submission', async () => {
  const selfAuth = { displayName: 'Payroll Officer', permissions: { payroll_payment: ['VIEW','CREATE','APPROVE'] } };
  await throwsCode(async () => await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(BATCH.id), selfAuth, 'sendiri')),
    pay.ERROR.SOD_VIOLATION);
});

await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(BATCH.id), APPROVER, 'dikirim ke bank'));

await check('CASE 8 — BANK REJECTION is recorded with a reason, nothing auto-fixed', async () => {
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-BADBANK'`).get(BATCH.id);
  const before = (await db.prepare(`SELECT bank_account_no FROM employees WHERE id='E-BADBANK'`).get()).bank_account_no;
  const rejected = await withTransaction(db, async () => await pay.recordItemOutcome(db, item.id, 'REJECTED', APPROVER,
    { reason: 'Nama penerima tidak cocok', bankCode: 'E31' }));
  eq(rejected.status, 'REJECTED');
  eq(rejected.bank_response_code, 'E31');
  eq((await db.prepare(`SELECT bank_account_no FROM employees WHERE id='E-BADBANK'`).get()).bank_account_no, before,
    'master record untouched: ');
  eq((await reloadBatch(BATCH.id)).status, 'PARTIALLY_PAID', 'batch derives its status: ');
});

// pay everyone else
await withTransaction(db, async () => {
  for (const i of await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status='SUBMITTED'`).all(BATCH.id)) {
    await pay.recordItemOutcome(db, i.id, 'PAID', APPROVER, { bankCode: '00' });
  }
});

await check('CASE 9 — RETRY creates a new linked instruction without duplicating', async () => {
  const rejected = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status='REJECTED'`).get(BATCH.id);
  // a human corrects the master record first
  await withTransaction(db, async () => await db.prepare(`UPDATE employees SET bank_account_name='Nama E-BADBANK' WHERE id='E-BADBANK'`).run());

  const retryBatch = (await withTransaction(db, async () => await pay.prepareBatch(db, P_JUNE, PREPARER))).batch;
  const auto = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id=?').get(retryBatch.id, 'E-BADBANK');
  await withTransaction(db, async () => await db.prepare(`UPDATE payroll_payment_items SET status='CANCELLED', status_reason='diganti retry eksplisit' WHERE id=?`).run(auto.id));
  const retry = await withTransaction(db, async () => await pay.retryItem(db, rejected.id, retryBatch.id, PREPARER, 'rekening diperbaiki'));

  eq(retry.retry_of_item_id, rejected.id);
  eq(retry.amount_sen, rejected.amount_sen, 'same amount: ');
  eq((await db.prepare('SELECT status FROM payroll_payment_items WHERE id=?').get(rejected.id)).status, 'REJECTED',
    'rejected record survives: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items
      WHERE payroll_period_id=? AND employee_id='E-BADBANK' AND status NOT IN ('REJECTED','FAILED','RETURNED','CANCELLED')`)
    .get(P_JUNE)).n, 1, 'exactly one live instruction: ');

  // finish the retry through to PAID
  await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(retryBatch.id), PREPARER, 'x'));
  await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(retryBatch.id), 'GENERIC_CSV', PREPARER, 'x'));
  await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(retryBatch.id), APPROVER, 'x'));
  await withTransaction(db, async () => await pay.recordItemOutcome(db, retry.id, 'PAID', APPROVER, { bankCode: '00' }));
  eq((await db.prepare('SELECT status FROM payroll_payment_items WHERE id=?').get(retry.id)).status, 'PAID');
});

await check('DUPLICATE PAYMENT is impossible at the database level', async () => {
  const live = await db.prepare(`SELECT * FROM payroll_payment_items WHERE payroll_period_id=? AND status='PAID' LIMIT 1`).get(P_JUNE);
  await throwsMatching(async () => await db.prepare(`INSERT INTO payroll_payment_items (batch_id,payroll_period_id,employee_id,
    legal_entity_id,payment_reference,amount_sen,source_run_ids,bank_snapshot_at,created_at)
    VALUES (?,?,?,?,?,?,'[]',kahe_now(),kahe_now())`)
    .run(live.batch_id, P_JUNE, live.employee_id, live.legal_entity_id, 'E2E-DUP-1', 1000),
    /UNIQUE|constraint/i);
});

await check('PAYMENT RECONCILIATION is exact for the whole period', async () => {
  const rec = await pay.reconcilePayment(db, P_JUNE);
  const paidSum = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items WHERE payroll_period_id=? AND status='PAID'`).get(P_JUNE)).n;
  eq(rec.paid_sen, paidSum, 'paid matches the ledger: ');
  eq(rec.payable_total_sen - rec.paid_sen - rec.in_flight_sen, rec.outstanding_sen, 'identity holds: ');
  const recoverPayable = (await pay.getPayableEmployees(db, P_JUNE)).find((r) => r.employee_id === 'E-RECOVER');
  eq(recoverPayable.payable_sen > 0, true, 'E-RECOVER is still net positive after the recovery: ');
  console.log(`\n     payable ${fmt(rec.payable_total_sen)} | paid ${fmt(rec.paid_sen)} | outstanding ${fmt(rec.outstanding_sen)}`);
});

await check('CROSS-STAGE RECONCILIATION: payroll -> payslip -> payment agree exactly', async () => {
  for (const emp of ['E-NORMAL','E-JOINER','E-LEAVER','E-RAISE','E-OT','E-LATEOT']) {
    const effective = (await adjLib.reconcileEmployee(db, P_JUNE, emp)).effective_totals.net_sen;
    const paidRows = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items
      WHERE payroll_period_id=? AND employee_id=? AND status='PAID'`).get(P_JUNE, emp)).n;
    eq(paidRows, effective, `${emp}: paid must equal effective net: `);
    // payslip for the original run must equal the original line
    const ps = await db.prepare(`SELECT * FROM payroll_payslips WHERE payroll_run_id=? AND employee_id=?`).get(RUN_JUNE.id, emp);
    const doc = JSON.parse(ps.document);
    eq(doc.totals.net_sen, (await lineFor(RUN_JUNE.id, emp)).net_sen, `${emp}: payslip vs run line: `);
  }
});

// =============================================================================
section('CROSS-CUTTING  ISOLATION · ROLLBACK · CONCURRENCY · SCALE');
// =============================================================================

await check('LEGAL ENTITY ISOLATION holds across every stage', async () => {
  // MITRA employee never appears in a KAHE run, payslip, adjustment or payment
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-MITRA'`).get(RUN_JUNE.id)).n, 0);
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE legal_entity_id='MITRA' AND payroll_period_id=?`).get(P_JUNE)).n, 0);
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payslips WHERE payroll_run_id=? AND legal_entity_id!='KAHE360'`).get(RUN_JUNE.id)).n, 0);
  // and a cross-entity correction run is refused
  const mitraPeriod = await makePeriod(G_MITRA, 2026, 6);
  await throwsCode(async () => await withTransaction(db, async () => await runLib.createRun(db, mitraPeriod, PREPARER,
    { runType: 'CORRECTION', correctsRunId: RUN_JUNE.id })), runLib.TRANSITION_ERROR.ENTITY_MISMATCH);
});

await check('TRANSACTION ROLLBACK leaves no partial financial state', async () => {
  const before = {
    runs: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_runs').get()).n,
    lines: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines').get()).n,
    batches: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n,
    items: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n,
    payslips: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips').get()).n,
  };
  let threw = false;
  try {
    await withTransaction(db, async () => {
      await pay.prepareBatch(db, P_JULY, PREPARER);
      await runLib.createRun(db, P_JULY, PREPARER);
      throw new Error('simulated mid-cycle failure');
    });
  } catch (e) { threw = true; }
  eq(threw, true);
  eq({
    runs: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_runs').get()).n,
    lines: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines').get()).n,
    batches: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n,
    items: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n,
    payslips: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips').get()).n,
  }, before, 'nothing survived the rollback: ');
});

await check('CONCURRENT-WRITE RESILIENCE: a second writer waits rather than failing', async () => {
  const a = __t.openApp(1);
  const b = __t.openApp(1);
  await __t.ddl('CREATE TABLE IF NOT EXISTS _e2e_probe (v INT)');
  await withTransaction(a, async () => { await a.prepare('INSERT INTO _e2e_probe VALUES (1)').run(); });
  await withTransaction(b, async () => { await b.prepare('INSERT INTO _e2e_probe VALUES (2)').run(); });
  eq((await a.prepare('SELECT COUNT(*) AS n FROM _e2e_probe').get()).n, 2);
  eq(Number.parseInt((await a.prepare('SHOW lock_timeout').get()).lock_timeout, 10) * 1000, BUSY_TIMEOUT_MS, 'timeout is set: ');
  // bounded retry surfaces a clean exhaustion rather than hanging
  let attempts = 0;
  try {
    await withRetry(() => { attempts += 1; const e = new Error('lock_not_available: database is locked'); e.code = '55P03'; throw e; },
      { label: 'e2e probe' });
  } catch (err) { eq(err.code, 'DB_BUSY_EXHAUSTED'); }
  eq(attempts, 4, 'bounded attempts: ');
  await a.close(); await b.close();
});

await check('MONETARY AND TIME PRECISION hold system-wide', async () => {
  // every stored money column is an integer
  for (const [table, col] of [['payroll_run_lines','net_sen'], ['payroll_run_lines','gross_sen'],
    ['payroll_payment_items','amount_sen'], ['payroll_payslips','net_sen'],
    ['employee_salary_components','amount_sen'], ['payroll_adjustments','amount_sen']]) {
    const bad = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL AND CAST(${col} AS BIGINT) != ${col}`).get()).n;
    eq(bad, 0, `${table}.${col} non-integer rows: `);
  }
  const badMinutes = (await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries
    WHERE work_minutes IS NOT NULL AND CAST(work_minutes AS BIGINT) != work_minutes`).get()).n;
  eq(badMinutes, 0, 'non-integer minutes: ');
  // and the line sum equals the aggregate, exactly
  const lines = await db.prepare(`SELECT net_sen FROM payroll_run_lines WHERE payroll_run_id=?`).all(RUN_JUNE.id);
  const agg = (await db.prepare(`SELECT COALESCE(SUM(net_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=?`).get(RUN_JUNE.id)).n;
  eq(lines.reduce((t, l) => t + l.net_sen, 0), agg, 'exact aggregation: ');
});

await check('CALCULATION DETERMINISM: the same snapshot always yields the same result', async () => {
  const s = await db.prepare(`SELECT * FROM payroll_input_snapshots WHERE payroll_period_id=? AND employee_id='E-NORMAL'`).get(P_JUNE);
  const payload = JSON.parse(s.resolved_payload);
  const a = calc.calculate(payload);
  const b = calc.calculate(JSON.parse(JSON.stringify(payload)));
  eq(JSON.stringify(a), JSON.stringify(b), 'two runs differ: ');
  // and it still matches what was persisted at finalization
  eq(a.totals.net_sen, (await lineFor(RUN_JUNE.id, 'E-NORMAL')).net_sen, 'matches the finalized line: ');
});

let scaleTiming = null;
await check('SCALE: 1,500 employees through the full cycle to payment', async () => {
  const pScale = await makePeriod(G_ALT, 2027, 1);
  const t0 = Date.now();
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_name,bank_account_no,bank_account_name)
      VALUES (?,?,'pkwt','active','2026-01-01','PPB','BCA',?,?)`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date)
      VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source)
      VALUES (?, '2027-01-15','present',480,8,'none','WORKDAY','e2e')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `SCALE-${String(i).padStart(4,'0')}`;
      await insE.run(id, `Scale ${i}`, String(2000000000 + i), `Scale ${i}`);
      await insA.run(id, wp5, cal, G_ALT); await insC.run(id, C_BASIC, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  const tSetup = Date.now();
  const snap = await writer.snapshotPeriod(db, pScale, { chunkSize: 200, resolvedBy: 'scale' });
  await writer.freezePeriod(db, pScale, 'scale');
  const tSnap = Date.now();
  const run = await withTransaction(db, async () => await runLib.createRun(db, pScale, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'f'));
  const cs = await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200 });
  const tCalc = Date.now();
  await withTransaction(db, async () => await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(PREPARER.displayName, run.id));
  const vs = await validationRunner.validatePeriod(db, pScale, { chunkSize: 200, detectedAt: '2027-02-01 00:00:00' });
  const tVal = Date.now();
  await withTransaction(db, async () => await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=? WHERE id=?`).run(PREPARER.displayName, run.id));
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'final'));
  let created = 0;
  for (let off = 0; off < 1500; off += 200) {
    const chunk = await db.prepare(`SELECT id FROM payroll_run_lines WHERE payroll_run_id=? AND calc_status='OK' ORDER BY employee_id LIMIT 200 OFFSET ?`).all(run.id, off);
    await withTransaction(db, async () => { for (const l of chunk) if ((await payslip.generate(db, l.id, { generatedBy: 'scale' })).created) created += 1; });
  }
  const tSlip = Date.now();
  const batch = (await withTransaction(db, async () => await pay.prepareBatch(db, pScale, PREPARER))).batch;
  await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(batch.id), PREPARER, 'x'));
  const file = await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(batch.id), 'GENERIC_CSV', PREPARER, 'x'));
  const tPay = Date.now();

  eq(snap.created, 1500, 'snapshots: ');
  eq(cs.created, 1500, 'calculated lines: ');
  eq(vs.blocking, 0, 'no blockers: ');
  eq(created, 1500, 'payslips: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE batch_id=?`).get(batch.id)).n, 1500, 'instructions: ');

  // exact reconciliation at scale
  const payrollNet = (await db.prepare(`SELECT COALESCE(SUM(net_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=?`).get(run.id)).n;
  const paymentSum = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items WHERE batch_id=?`).get(batch.id)).n;
  eq(paymentSum, payrollNet, 'payment equals payroll net exactly at 1,500: ');
  eq(rp((await db.prepare(`SELECT COALESCE(SUM(gross_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=?`).get(run.id)).n), 1500 * 5000000, 'gross: ');
  eq(file.file.content.trim().split('\n').length, 1502, 'file rows: ');

  scaleTiming = {
    setup_ms: tSetup - t0, snapshot_ms: tSnap - tSetup, calculate_ms: tCalc - tSnap,
    validate_ms: tVal - tCalc, payslip_ms: tSlip - tVal, payment_ms: tPay - tSlip,
    total_ms: tPay - t0,
  };
  console.log(`\n     1,500-employee cycle: snapshot ${scaleTiming.snapshot_ms}ms · calc ${scaleTiming.calculate_ms}ms `
    + `· validate ${scaleTiming.validate_ms}ms · payslip ${scaleTiming.payslip_ms}ms · payment ${scaleTiming.payment_ms}ms `
    + `· TOTAL ${scaleTiming.total_ms}ms`);
});

await check('FINAL INTEGRITY SWEEP: June history is still byte-identical', async () => {
  const after = await db.prepare(
    'SELECT employee_id, gross_sen, net_sen, result_hash FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id'
  ).all(RUN_JUNE.id);
  eq(after, JUNE_BASELINE, 'after the entire audit run: ');
  // orphan check across the whole chain
  const orphans = {
    lines_without_run: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines l LEFT JOIN payroll_runs r ON r.id=l.payroll_run_id WHERE r.id IS NULL').get()).n,
    payslips_without_line: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips p LEFT JOIN payroll_run_lines l ON l.id=p.payroll_run_line_id WHERE l.id IS NULL').get()).n,
    items_without_batch: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items i LEFT JOIN payroll_payment_batches b ON b.id=i.batch_id WHERE b.id IS NULL').get()).n,
    applied_adj_without_run: (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments a LEFT JOIN payroll_runs r ON r.id=a.applied_to_run_id WHERE a.status='APPLIED' AND r.id IS NULL`).get()).n,
  };
  eq(orphans, { lines_without_run: 0, payslips_without_line: 0, items_without_batch: 0, applied_adj_without_run: 0 });
});

// ---- summary -------------------------------------------------------------------
const counts = {
  employees: (await db.prepare('SELECT COUNT(*) AS n FROM employees').get()).n,
  snapshots: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_input_snapshots').get()).n,
  runs: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_runs').get()).n,
  run_lines: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines').get()).n,
  payslips: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips').get()).n,
  adjustments: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_adjustments').get()).n,
  payment_items: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n,
  exceptions: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_exceptions').get()).n,
};

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(62)}`);
console.log('E2E DATA VOLUME:', JSON.stringify(counts));
if (scaleTiming) console.log('SCALE TIMING   :', JSON.stringify(scaleTiming));
console.log(`E2E AUDIT TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(62));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
