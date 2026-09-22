(async () => {
// tests/phase2f.test.js
// Phase 2F — Finalized Payslip Generation. Throwaway database.
// Usage: npm run test:phase2f

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
const calc = require('../lib/payrollCalculator');
const validationRunner = require('../lib/validationRunner');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
const payslip = require('../lib/payslip');
const pp = require('../lib/payrollPeriod');
const money = require('../lib/money');
const time = require('../lib/time');

let passed = 0, failed = 0;
const failures = [];
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
    if (!re.test(e.message)) throw new Error(`${label}error did not match ${re}: ${e.message}`);
    return e;
  }
  throw new Error(`${label}expected a throw matching ${re}`);
}
function section(t) { console.log(`\n${t}`); }
const rp = (sen) => money.senToRupiah(sen);

const TEST_DB = path.join(__dirname, 'phase2f.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2f');
const db = __t.db;
await initDb(db);

const PREPARER = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'] } };

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,npwp,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE 360 Workforce Solutions','internal','01.234.567.8-901.000','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra Jaya','subkontraktor','medium','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',127,'2026-01-01')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();

const rsId = (await db.prepare(`INSERT INTO payroll_rule_sets
  (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
   jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
   overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
  VALUES ('RS 2026','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,1,0) RETURNING id`).run()).lastInsertRowid;
for (const [cat, lo, hi, bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['B',620000000,null,100],['C',0,660000000,0]])
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rsId,cat,lo,hi,bp);
for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],['rest_or_holiday_5day',1,8,20000]])
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rsId,dt,hf,ht,m);

async function makeGroup(code, entity) {
  return (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from)
    VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2026-01-01') RETURNING id`).run(code, code, entity)).lastInsertRowid;
}
const gKahe = await makeGroup('KAHE-M', 'KAHE360');
const gMitra = await makeGroup('MITRA-M', 'MITRA');
async function makePeriod(g, y, s) {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(g);
  const w = pp.monthlyWindow(y, s); const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN') RETURNING id`).run(g,y,s,s,d.period_start,d.period_end,
    d.attendance_cutoff,d.overtime_cutoff,d.adjustment_cutoff,d.payment_date)).lastInsertRowid;
}
async function makeComp(code, o = {}) {
  const f = { type:'earning', calc:'fixed', paid:'employee', tax:1, bpjs:0, ot:0, pro:1, order:100, ...o };
  return (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
    is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES (?,?,?,?,?,?,?,?,?,'recurring',?,'2026-01-01') RETURNING id`).run(code,code,f.type,f.calc,f.paid,f.tax,f.bpjs,f.ot,f.pro,f.order)).lastInsertRowid;
}
const cBasic = await makeComp('BASIC', { bpjs:1, ot:1, order:10 });
const cFixed = await makeComp('ALLOW_FIXED', { bpjs:1, ot:1, order:20 });
const cSite = await makeComp('ALLOW_SITE', { order:30 });
const cLoan = await makeComp('DED_LOAN', { type:'deduction', tax:0, pro:0, order:200 });

async function makeEmp(id, o = {}) {
  const f = { start:'2026-01-01', term:null, status:'active', nik:'32', pos:'Pipe Welder', ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code,
    nik,position,bank_name,bank_account_no) VALUES (?,?,'internal',?,?,?,'PPB',?,?,'BCA','123456')`)
    .run(id, `Nama ${id}`, f.status, f.start, f.term, f.nik, f.pos);
}
async function assign(id, o = {}) {
  const a = { entity:'KAHE360', group:gKahe, from:'2026-01-01', to:null, marital:'TK', dep:0, ...o };
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id,a.entity,wp5,cal,a.group,a.marital,a.dep,a.from,a.to);
}
async function addComp(id, cid, rupiah, from='2026-01-01', to=null) {
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to)
              VALUES (?,?,?,?,?)`).run(id,cid,money.rupiahToSen(rupiah),from,to);
}
async function addTs(id, date, o = {}) {
  const f = { ot:0, otStatus:'none', dayType:'WORKDAY', ...o };
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_minutes_approved,overtime_hours_approved,overtime_status,day_type,day_type_source)
    VALUES (?,?,'present',480,8,?,?,?,?,'test')`)
    .run(id,date,f.otStatus==='approved'?f.ot:0,time.minutesToHours(f.otStatus==='approved'?f.ot:0),f.otStatus,f.dayType);
}
const reload = async (id) => await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);

/** Drive a period all the way to FINALIZED and return the run. */
async function finalizeRun(periodId) {
  await writer.snapshotPeriod(db, periodId, { chunkSize: 200, resolvedBy: PREPARER.displayName });
  await writer.freezePeriod(db, periodId, PREPARER.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, periodId, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'frozen'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id, 'SNAPSHOT_READY', 'CALCULATED', PREPARER.displayName, 'calc');
  });
  await validationRunner.validatePeriod(db, periodId, { chunkSize: 200, detectedAt: '2026-07-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED', resolved_by='Ops Director',
      resolved_at=kahe_now(), resolution_note='ok' WHERE payroll_period_id=? AND blocking=1`).run(periodId);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id, 'CALCULATED', 'VALIDATED', PREPARER.displayName, 'validated');
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'final'));
  return await reload(run.id);
}
const lineFor = async (runId, empId) =>
  await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id=?').get(runId, empId);
const gen = async (lineId) => await withTransaction(db, async () => await payslip.generate(db, lineId, { generatedBy: 'Payroll Officer' }));

// ---- the main cohort ---------------------------------------------------------
const pJun = await makePeriod(gKahe, 2026, 6);
await makeEmp('E-NORM'); await assign('E-NORM');
await addComp('E-NORM', cBasic, 8000000); await addComp('E-NORM', cFixed, 1500000);
await addComp('E-NORM', cSite, 1000000); await addComp('E-NORM', cLoan, 500000);
await addTs('E-NORM', '2026-06-15', { ot: 180, otStatus: 'approved' });

await makeEmp('E-JOIN', { start: '2026-06-16' }); await assign('E-JOIN', { from: '2026-06-16' });
await addComp('E-JOIN', cBasic, 9000000, '2026-06-16'); await addTs('E-JOIN', '2026-06-16');

await makeEmp('E-LEAVE', { term: '2026-06-20', status: 'inactive' });
await assign('E-LEAVE', { from: '2026-01-01', to: '2026-06-20' });
await addComp('E-LEAVE', cBasic, 9000000, '2026-01-01', '2026-06-20'); await addTs('E-LEAVE', '2026-06-10');

await makeEmp('E-RAISE'); await assign('E-RAISE');
await addComp('E-RAISE', cBasic, 8000000, '2026-01-01', '2026-06-14');
await addComp('E-RAISE', cBasic, 9500000, '2026-06-15');
await addTs('E-RAISE', '2026-06-17');

await makeEmp('E-NOOT'); await assign('E-NOOT'); await addComp('E-NOOT', cBasic, 7000000); await addTs('E-NOOT', '2026-06-18');

const runJun = await finalizeRun(pJun);

// =============================================================================
section('ARCHITECTURAL CONTRACT');
// =============================================================================

await check('the payslip generator NEVER touches calculation or live rule tables', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payslip.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const forbidden of ['employee_salary_components', 'payroll_rule_sets', 'ptkp_ter_rates',
    'overtime_multiplier_rules', 'jkk_risk_classes', 'timesheet_equivalents', 'timesheet_entries']) {
    if (code.includes(forbidden)) throw new Error(`payslip generator must not read ${forbidden}`);
  }
  for (const forbidden of ['payrollCalculator', 'calculate(']) {
    if (code.includes(forbidden)) throw new Error(`payslip generator must not recalculate: found ${forbidden}`);
  }
});

await check('12. the generator does not mutate payroll results or snapshots', async () => {
  const line = await lineFor(runJun.id, 'E-NORM');
  const before = {
    line: await db.prepare('SELECT * FROM payroll_run_lines WHERE id=?').get(line.id),
    comps: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_line_components WHERE payroll_run_line_id=?').get(line.id)).n,
    snap: await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id=?').get(line.snapshot_id),
    run: await reload(runJun.id),
  };
  await gen(line.id);
  eq(await db.prepare('SELECT * FROM payroll_run_lines WHERE id=?').get(line.id), before.line, 'line unchanged: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_line_components WHERE payroll_run_line_id=?').get(line.id)).n, before.comps);
  eq(await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id=?').get(line.snapshot_id), before.snap, 'snapshot unchanged: ');
  eq(await reload(runJun.id), before.run, 'run unchanged: ');
});

// =============================================================================
section('PAYSLIP CONTENT');
// =============================================================================

await check('1. NORMAL MONTHLY PAYSLIP contains every required field', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  // identity + employer
  eq(d.employee.employee_id, 'E-NORM');
  eq(d.employee.full_name, 'Nama E-NORM');
  eq(d.employee.position, 'Pipe Welder');
  eq(d.employer.legal_entity_id, 'KAHE360');
  eq(d.employer.legal_entity_name, 'KAHE 360 Workforce Solutions');
  eq(d.employer.payroll_group_code, 'KAHE-M');
  // period + payment
  eq(d.period.period_start, '2026-06-01');
  eq(d.period.period_end, '2026-06-30');
  eq(d.period.payment_date, '2026-07-05');
  // work context
  eq(d.work.payable_days, 30);
  eq(d.work.overtime_minutes, 180);
  eq(d.work.overtime_hours, 3);
  eq(d.work.overtime_display, '3 jam');
  // integrity metadata
  eq(d.integrity.payroll_run_id, runJun.id);
  eq(d.integrity.run_number, 1);
  eq(d.integrity.run_status, 'FINALIZED');
  if (!d.integrity.finalized_at) throw new Error('finalized_at missing');
  if (!d.integrity.generated_at) throw new Error('generated_at missing');
  eq(d.integrity.line_result_hash.length, 64);
  eq(d.payslip_version, 1);
  eq(d.payslip_reference, 'PS-KAHE360-202606-R1-E-NORM');
});

await check('the four sections are clearly separated', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  eq(Object.keys(d.sections).sort(),
    ['EMPLOYEE_DEDUCTIONS','EMPLOYEE_EARNINGS','EMPLOYER_CONTRIBUTIONS','TAKE_HOME_PAY']);
  eq(d.sections.EMPLOYER_CONTRIBUTIONS.reduces_net_pay, false);
});

await check('5/6. MULTIPLE EARNINGS including overtime are itemised', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  const codes = d.sections.EMPLOYEE_EARNINGS.items.map((i) => i.code);
  for (const expected of ['BASIC', 'ALLOW_FIXED', 'ALLOW_SITE']) {
    if (!codes.includes(expected)) throw new Error(`missing earning ${expected} in ${codes}`);
  }
  eq(codes.some((c) => c.startsWith('OVERTIME_2026-06-15')), true, 'overtime lines present: ');
  const basic = d.sections.EMPLOYEE_EARNINGS.items.find((i) => i.code === 'BASIC');
  eq(rp(basic.amount_sen), 8000000);
  eq(basic.amount_display, 'Rp8.000.000');
});

await check('7. DEDUCTIONS appear in the employee-deduction section only', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  const codes = d.sections.EMPLOYEE_DEDUCTIONS.items.map((i) => i.code);
  eq(codes.includes('DED_LOAN'), true);
  eq(d.sections.EMPLOYEE_EARNINGS.items.some((i) => i.code === 'DED_LOAN'), false, 'not an earning: ');
});

await check('8. BPJS EMPLOYEE vs EMPLOYER contributions are correctly separated', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  const empCodes = d.sections.EMPLOYEE_DEDUCTIONS.items.map((i) => i.code);
  const erCodes = d.sections.EMPLOYER_CONTRIBUTIONS.items.map((i) => i.code);

  for (const c of ['BPJS_KESEHATAN_EMPLOYEE', 'JHT_EMPLOYEE', 'JP_EMPLOYEE']) {
    if (!empCodes.includes(c)) throw new Error(`${c} must be an employee deduction`);
    if (erCodes.includes(c)) throw new Error(`${c} must NOT be an employer contribution`);
  }
  for (const c of ['BPJS_KESEHATAN_EMPLOYER', 'JHT_EMPLOYER', 'JP_EMPLOYER', 'JKM_EMPLOYER', 'JKK_EMPLOYER']) {
    if (!erCodes.includes(c)) throw new Error(`${c} must be an employer contribution`);
    if (empCodes.includes(c)) throw new Error(`${c} must NOT reduce the employee's net pay`);
  }
  // bpjs base 9.500.000 -> employee 1% + 2% + 1% = 380.000
  const empBpjs = d.sections.EMPLOYEE_DEDUCTIONS.items
    .filter((i) => ['BPJS_KESEHATAN_EMPLOYEE','JHT_EMPLOYEE','JP_EMPLOYEE'].includes(i.code))
    .reduce((t, i) => t + i.amount_sen, 0);
  eq(rp(empBpjs), 380000, 'employee BPJS: ');
});

await check('EMPLOYER CONTRIBUTIONS never reduce net pay', async () => {
  const line = await lineFor(runJun.id, 'E-NORM');
  const { document: d } = await gen(line.id);
  const employerTotal = d.sections.EMPLOYER_CONTRIBUTIONS.total_sen;
  if (employerTotal <= 0) throw new Error('expected employer contributions to exist');
  // net = gross - employee deductions, with employer money nowhere in it
  eq(d.sections.TAKE_HOME_PAY.net_sen,
    d.sections.EMPLOYEE_EARNINGS.total_sen - d.sections.EMPLOYEE_DEDUCTIONS.total_sen);
  eq(d.sections.TAKE_HOME_PAY.net_sen, line.net_sen, 'matches persisted net: ');
  // sanity: adding employer money would have changed net
  if (d.sections.TAKE_HOME_PAY.net_sen === line.net_sen - employerTotal) {
    throw new Error('employer contributions appear to have been deducted');
  }
});

await check('9. PPh21 appears as an employee deduction with its rule reference', async () => {
  const line = await lineFor(runJun.id, 'E-NORM');
  const { document: d } = await gen(line.id);
  const tax = d.sections.EMPLOYEE_DEDUCTIONS.items.find((i) => i.code === 'PPH21_TER');
  if (!tax) throw new Error('PPH21_TER missing from deductions');
  eq(tax.amount_sen, line.tax_sen, 'matches persisted tax: ');
  eq(d.tax.method, 'TER');
  eq(d.tax.rule_set_id, rsId);
  eq(d.tax.is_final_annual_tax, false, 'monthly TER is an instalment: ');
  eq(d.tax.annual_reconciliation_required, true);
  eq(tax.rule_version.startsWith(`rule_set:${rsId}:category:`), true);
});

await check('15. TOTALS RECONCILE EXACTLY with payroll_run_lines', async () => {
  for (const emp of ['E-NORM','E-JOIN','E-LEAVE','E-RAISE','E-NOOT']) {
    const line = await lineFor(runJun.id, emp);
    const { document: d } = await gen(line.id);
    eq(d.sections.EMPLOYEE_EARNINGS.total_sen, line.gross_sen, `${emp} gross: `);
    eq(d.sections.EMPLOYEE_DEDUCTIONS.total_sen, line.employee_deductions_sen, `${emp} deductions: `);
    eq(d.sections.TAKE_HOME_PAY.net_sen, line.net_sen, `${emp} net: `);
    // and against the component rows themselves
    const compSum = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_run_line_components
      WHERE payroll_run_line_id = ? AND component_group IN ('earning','overtime')`).get(line.id)).n;
    eq(d.sections.EMPLOYEE_EARNINGS.total_sen, compSum, `${emp} vs components: `);
  }
});

await check('2. JOINER payslip shows prorated days and amount', async () => {
  const line = await lineFor(runJun.id, 'E-JOIN');
  const { document: d } = await gen(line.id);
  eq(d.work.payable_days, 15);
  eq(d.work.period_days, 30);
  eq(d.work.prorated, true);
  eq(rp(d.sections.EMPLOYEE_EARNINGS.total_sen), 4500000, '9jt x 15/30: ');
  eq(d.employee.start_date, '2026-06-16');
});

await check('3. LEAVER payslip shows the termination date and prorated pay', async () => {
  const line = await lineFor(runJun.id, 'E-LEAVE');
  const { document: d } = await gen(line.id);
  eq(d.work.payable_days, 20);
  eq(d.employee.termination_date, '2026-06-20');
  eq(rp(d.sections.EMPLOYEE_EARNINGS.total_sen), 6000000, '9jt x 20/30: ');
});

await check('4. MID-PERIOD SALARY CHANGE shows the segment-weighted amount', async () => {
  const line = await lineFor(runJun.id, 'E-RAISE');
  const { document: d } = await gen(line.id);
  const expected = money.roundHalfUp((money.rupiahToSen(8000000) * 14 + money.rupiahToSen(9500000) * 16) / 30);
  eq(d.sections.EMPLOYEE_EARNINGS.total_sen, expected);
  eq(rp(d.sections.EMPLOYEE_EARNINGS.total_sen), 8800000);
  const basic = d.sections.EMPLOYEE_EARNINGS.items.find((i) => i.code === 'BASIC');
  eq(basic.formula, 'sum(segment_amount_sen * segment_days) / total_days', 'formula is visible on the slip: ');
});

await check('10. ZERO OVERTIME renders cleanly as zero, not as a missing section', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NOOT')).id);
  eq(d.work.overtime_minutes, 0);
  eq(d.work.overtime_display, '0 jam');
  eq(d.work.overtime_by_day, []);
  eq(d.sections.EMPLOYEE_EARNINGS.items.some((i) => i.code.startsWith('OVERTIME_2')), false, 'no overtime line: ');
});

await check('the printable rendering is produced from the frozen document', async () => {
  const { document: d } = await gen((await lineFor(runJun.id, 'E-NORM')).id);
  const text = payslip.renderText(d);
  for (const expected = ['PENGHASILAN KARYAWAN','POTONGAN KARYAWAN','GAJI BERSIH (TAKE HOME PAY)',
    'KONTRIBUSI PERUSAHAAN']; false;) break;
  for (const heading of ['PENGHASILAN KARYAWAN','POTONGAN KARYAWAN','GAJI BERSIH (TAKE HOME PAY)',
    'KONTRIBUSI PERUSAHAAN (tidak mengurangi gaji bersih)']) {
    if (!text.includes(heading)) throw new Error(`printable payslip missing section: ${heading}`);
  }
  if (!text.includes(d.sections.TAKE_HOME_PAY.net_display)) throw new Error('net pay not printed');
  if (!text.includes(d.payslip_reference)) throw new Error('reference not printed');
});

// =============================================================================
section('FINALIZATION GATE & IMMUTABILITY');
// =============================================================================

await check('11. NON-FINALIZED run is REJECTED', async () => {
  const pOpen = await makePeriod(gKahe, 2026, 7);
  await makeEmp('E-OPEN'); await assign('E-OPEN'); await addComp('E-OPEN', cBasic, 8000000); await addTs('E-OPEN', '2026-07-15');
  await writer.snapshotPeriod(db, pOpen, { chunkSize: 50, resolvedBy: 'x' });
  await writer.freezePeriod(db, pOpen, 'x');
  const run = await withTransaction(db, async () => await runLib.createRun(db, pOpen, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 50 });
  const line = await lineFor(run.id, 'E-OPEN');

  const err = await throwsCode(async () => await gen(line.id), payslip.ERROR.RUN_NOT_FINALIZED);
  eq(err.detail.status, 'SNAPSHOT_READY');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips WHERE payroll_run_line_id=?').get(line.id)).n, 0);
});

await check('11b. the DATABASE also refuses a payslip for a non-finalized run', async () => {
  const run = await db.prepare(`SELECT * FROM payroll_runs WHERE status != 'FINALIZED' LIMIT 1`).get();
  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? LIMIT 1').get(run.id);
  await throwsMatching(async () => await db.prepare(`INSERT INTO payroll_payslips (payroll_run_id,payroll_run_line_id,payroll_period_id,
    employee_id,legal_entity_id,run_number,payslip_reference,document,content_hash,line_result_hash,snapshot_hash,
    gross_sen,employee_deductions_sen,net_sen,employer_cost_sen,finalized_at,generated_at,generated_by)
    VALUES (?,?,?,?,?,?,?,'{}','h','h','h',0,0,0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00','x')`)
    .run(run.id, line.id, run.payroll_period_id, line.employee_id, line.legal_entity_id, run.run_number, 'PS-RAW-1'),
    /PAYSLIP_RUN_NOT_FINALIZED/);
});

await check('a stored payslip is IMMUTABLE — database trigger', async () => {
  const ps = await db.prepare('SELECT * FROM payroll_payslips LIMIT 1').get();
  await throwsMatching(async () => await db.prepare('UPDATE payroll_payslips SET net_sen = 1 WHERE id = ?').run(ps.id),
    /PAYSLIP_IMMUTABLE/, 'update: ');
  await throwsMatching(async () => await db.prepare('DELETE FROM payroll_payslips WHERE id = ?').run(ps.id),
    /PAYSLIP_IMMUTABLE/, 'delete: ');
  eq((await db.prepare('SELECT net_sen FROM payroll_payslips WHERE id=?').get(ps.id)).net_sen, ps.net_sen);
});

await check('14. REPEATED GENERATION returns identical financial content', async () => {
  const line = await lineFor(runJun.id, 'E-NORM');
  const first = await gen(line.id);
  const second = await gen(line.id);
  eq(second.created, false, 'second call returns the stored payslip: ');
  eq(second.payslip.content_hash, first.payslip.content_hash, 'content hash identical: ');
  eq(JSON.stringify(second.document.sections), JSON.stringify(first.document.sections), 'sections identical: ');
  eq(second.document.integrity.generated_at, first.document.integrity.generated_at, 'not regenerated: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips WHERE payroll_run_line_id=?').get(line.id)).n, 1,
    'exactly one payslip per line: ');
});

await check('13. LIVE MASTER CHANGES after finalization do not change the payslip', async () => {
  const line = await lineFor(runJun.id, 'E-NORM');
  const before = await db.prepare('SELECT * FROM payroll_payslips WHERE payroll_run_line_id=?').get(line.id);
  const beforeDoc = JSON.parse(before.document);

  // Change the world: rename the employee and the entity, reprice JKK, raise salary.
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE employees SET full_name='NAMA BERUBAH', position='Jabatan Baru' WHERE id='E-NORM'`).run();
    await db.prepare(`UPDATE legal_entities SET name='ENTITAS BERGANTI NAMA' WHERE id='KAHE360'`).run();
    await db.prepare(`UPDATE jkk_risk_classes SET end_date='2026-05-31' WHERE risk_class='high' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',900,'2026-06-01')`).run();
    await db.prepare(`UPDATE employee_salary_components SET effective_to='2026-06-30' WHERE employee_id='E-NORM' AND effective_to IS NULL`).run();
    await addComp('E-NORM', cBasic, 30000000, '2026-07-01');
  });

  const after = await db.prepare('SELECT * FROM payroll_payslips WHERE payroll_run_line_id=?').get(line.id);
  const afterDoc = JSON.parse(after.document);
  eq(after.content_hash, before.content_hash, 'content hash unchanged: ');
  eq(afterDoc.sections.TAKE_HOME_PAY.net_sen, beforeDoc.sections.TAKE_HOME_PAY.net_sen, 'net unchanged: ');
  eq(afterDoc.employee.full_name, 'Nama E-NORM', 'name frozen at generation: ');
  eq(afterDoc.employer.legal_entity_name, 'KAHE 360 Workforce Solutions', 'entity name frozen: ');
  const jkk = afterDoc.sections.EMPLOYER_CONTRIBUTIONS.items.find((i) => i.code === 'JKK_EMPLOYER');
  eq(jkk.rate.includes('127'), true, `JKK still the old rate (${jkk.rate}): `);
  // and generating again still returns the same thing
  eq((await gen(line.id)).payslip.content_hash, before.content_hash, 'regeneration identical: ');
});

await check('18. CORRECTION RUN produces a separate payslip without touching the original', async () => {
  const original = await db.prepare('SELECT * FROM payroll_payslips WHERE employee_id=? AND run_number=1').get('E-NOOT');
  if (!original) throw new Error('expected an original payslip for E-NOOT');

  // A correction run for the same period.
  const run2 = await withTransaction(db, async () => await runLib.createRun(db, pJun, PREPARER));
  eq(run2.run_number, 2);
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run2.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(run2.id), { chunkSize: 200 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run2.id);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run2.id);
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run2.id), APPROVER, 'koreksi'));
  // the original finalized run blocks a second finalization for this period
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='FINALIZED' WHERE id=?`).run(run2.id),
    /UNIQUE|constraint/i, 'only one finalized run per period: ');

  // The original payslip is untouched.
  const after = await db.prepare('SELECT * FROM payroll_payslips WHERE id=?').get(original.id);
  eq(after.content_hash, original.content_hash);
  eq(after.run_number, 1);
  // And the correction run's line is a DIFFERENT line, so it would get its
  // own payslip once finalized — the unique key is per line, not per employee.
  const line2 = await lineFor(run2.id, 'E-NOOT');
  eq(line2.id !== original.payroll_run_line_id, true, 'correction line is distinct: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips WHERE employee_id=?').get('E-NOOT')).n, 1,
    'no payslip for the unfinalized correction run: ');
});

// =============================================================================
section('ISOLATION, ACCESS, SCALE');
// =============================================================================

await check('17. LEGAL ENTITY ISOLATION: a payslip carries its own entity', async () => {
  const pMitra = await makePeriod(gMitra, 2026, 6);
  await makeEmp('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra });
  await addComp('E-MITRA', cBasic, 8000000); await addTs('E-MITRA', '2026-06-15');
  const runM = await finalizeRun(pMitra);
  const { document: d } = await gen((await lineFor(runM.id, 'E-MITRA')).id);
  eq(d.employer.legal_entity_id, 'MITRA');
  const jkk = d.sections.EMPLOYER_CONTRIBUTIONS.items.find((i) => i.code === 'JKK_EMPLOYER');
  eq(jkk.rate.includes('89'), true, `MITRA rate, not KAHE (${jkk.rate}): `);
  // no KAHE payslip carries the MITRA entity, and vice versa
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payslips WHERE payroll_run_id=? AND legal_entity_id!='MITRA'`).get(runM.id)).n, 0);
});

await check('16. UNAUTHORIZED ACCESS is rejected by the route permission', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payroll', 'payslips.js'), 'utf8');
  // every route must be permission-gated
  const routes = [...src.matchAll(/router\.(get|post)\('([^']+)'\s*,\s*([^,]+),/g)];
  eq(routes.length >= 5, true, `routes found (${routes.length}): `);
  for (const r of routes) {
    if (!/requirePermission\('payroll_run'/.test(r[3])) {
      throw new Error(`route ${r[2]} is not gated by payroll_run permission`);
    }
  }
  // generation requires CREATE, reading requires VIEW
  if (!/router\.post\('\/runs\/:runId\/payslips', requirePermission\('payroll_run', 'CREATE'\)/.test(src)) {
    throw new Error('payslip generation must require payroll_run:CREATE');
  }
});

await check('employee self-service basis: payslips are queryable per employee', async () => {
  const rows = await db.prepare('SELECT * FROM payroll_payslips WHERE employee_id = ?').all('E-NORM');
  eq(rows.length, 1);
  eq(rows[0].employee_id, 'E-NORM');
  // the index supporting a self-service lookup exists
  const idx = (await pgx.indexNames(db, 'idx_payslip_employee'))[0];
  if (!idx) throw new Error('missing idx_payslip_employee');
});

await check('19. 1,500 EMPLOYEE payslip generation and read', async () => {
  const pBulk = await makePeriod(gKahe, 2027, 1);
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,nik,position,bank_account_no) VALUES (?,?,'internal','active','2026-01-01','PPB','32','Welder','111')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source) VALUES (?, '2027-01-15','present',480,8,'none','WORKDAY','t')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await insE.run(id, `Bulk ${i}`); await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  const runB = await finalizeRun(pBulk);

  const lines = (await db.prepare(`SELECT id FROM payroll_run_lines WHERE payroll_run_id=? AND calc_status='OK' AND employee_id LIKE 'BULK-%'`).all(runB.id)).map((r) => r.id);
  eq(lines.length, 1500, 'payable lines: ');

  let created = 0;
  for (let offset = 0; offset < lines.length; offset += 200) {
    const chunk = lines.slice(offset, offset + 200);
    await withTransaction(db, async () => {
      for (const id of chunk) if ((await payslip.generate(db, id, { generatedBy: 'bulk' })).created) created += 1;
    });
  }
  eq(created, 1500, 'payslips created: ');

  // Read-side aggregate reconciles exactly with the run lines.
  const psTotals = await db.prepare(`SELECT COALESCE(SUM(net_sen),0) AS net, COALESCE(SUM(gross_sen),0) AS gross
    FROM payroll_payslips WHERE payroll_run_id=? AND employee_id LIKE 'BULK-%'`).get(runB.id);
  const lineTotals = await db.prepare(`SELECT COALESCE(SUM(net_sen),0) AS net, COALESCE(SUM(gross_sen),0) AS gross
    FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id LIKE 'BULK-%'`).get(runB.id);
  eq(psTotals, lineTotals, 'payslip totals equal run-line totals exactly: ');
  eq(rp(psTotals.gross), 1500 * 5000000, 'cohort gross: ');

  // Re-running generation creates nothing new.
  let again = 0;
  await withTransaction(db, async () => {
    for (const id of lines.slice(0, 100)) if ((await payslip.generate(db, id, { generatedBy: 'bulk' })).created) again += 1;
  });
  eq(again, 0, 'idempotent on re-run: ');
});

await check('Phase 2F builds NO payment, bank export or delivery', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 2H: payment tables now exist. What this
  // test guards is unchanged and is asserted below: this module writes no
  // payment row of its own.
  const paymentRows = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n;
  eq(paymentRows, 0, 'this phase must create no payment record: ');
  eq(tables.includes('payroll_payslips'), true);
});

// =============================================================================
section('20. REGRESSION');
// =============================================================================

await check('all prior invariant indexes still present', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee','uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class','uq_holiday_national_per_date','uq_emp_salary_component_open',
    'uq_salary_component_open_global','uq_salary_component_open_scoped','uq_work_calendar_open_code',
    'uq_payroll_group_open_code','uq_payroll_period_group_cycle','uq_payroll_period_group_start',
    'uq_snapshot_period_employee','uq_exception_snapshot_code','uq_payroll_run_single_finalized_original']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('the Phase 2E/2F immutability triggers are installed', async () => {
  // Asserts PRESENCE, not exclusivity — Phase 2G adds adjustment locks.
  const t = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_line_update','trg_lock_finalized_run_line_delete',
    'trg_lock_finalized_component_update','trg_lock_finalized_component_delete',
    'trg_lock_finalized_snapshot_update','trg_lock_finalized_snapshot_delete',
    'trg_lock_finalized_run_status','trg_lock_payslip_update','trg_lock_payslip_delete',
    'trg_payslip_requires_finalized_run']) {
    if (!t.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

await check('the calculator remains PURE and untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  eq([...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./money', './time']);
});

await check('prior canonical libraries behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq((await dc.classifyDay(db, 'E-NOOT', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-NOOT', '2026-06-15')).eligible, true);
});

// ---- representative payslip ---------------------------------------------------
console.log('\nREPRESENTATIVE PAYSLIP — E-NORM (multiple earnings, overtime, deductions)');
console.log(payslip.renderText(JSON.parse(
  (await db.prepare('SELECT document FROM payroll_payslips WHERE employee_id=? AND run_number=1').get('E-NORM')).document
)));

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2F TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
