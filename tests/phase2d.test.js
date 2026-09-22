(async () => {
// tests/phase2d.test.js
// Phase 2D — Validation & Exception Engine. Throwaway database.
// Usage: npm run test:phase2d

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
const calc = require('../lib/payrollCalculator');
const validation = require('../lib/payrollValidation');
const runner = require('../lib/validationRunner');
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
function section(t) { console.log(`\n${t}`); }
const rp = (sen) => money.senToRupiah(sen);
const C = validation.CODE;

const TEST_DB = path.join(__dirname, 'phase2d.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2d');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra','subkontraktor','medium','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',127,'2026-01-01')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();

async function makeRuleSet(otTaxable = 1) {
  const id = (await db.prepare(`INSERT INTO payroll_rule_sets
    (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
     jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
     overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
    VALUES ('RS','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,?,0) RETURNING id`).run(otTaxable)).lastInsertRowid;
  for (const [cat, lo, hi, bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['B',620000000,null,100],['C',0,660000000,0]])
    await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(id,cat,lo,hi,bp);
  for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],['rest_or_holiday_5day',1,8,20000]])
    await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(id,dt,hf,ht,m);
  return id;
}
const rsId = await makeRuleSet(1);

async function makeGroup(code, entity) {
  return (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,effective_from)
    VALUES (?,?,?,'monthly',12,0,0,2,5,'2026-01-01') RETURNING id`).run(code, code, entity)).lastInsertRowid;
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
const pJun = await makePeriod(gKahe, 2026, 6);
const pJunM = await makePeriod(gMitra, 2026, 6);

async function makeComp(code, o = {}) {
  const f = { type:'earning', calc:'fixed', paid:'employee', tax:1, bpjs:0, ot:0, pro:1, order:100, ...o };
  return (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
    is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES (?,?,?,?,?,?,?,?,?,'recurring',?,'2026-01-01') RETURNING id`).run(code,code,f.type,f.calc,f.paid,f.tax,f.bpjs,f.ot,f.pro,f.order)).lastInsertRowid;
}
const cBasic = await makeComp('BASIC', { bpjs:1, ot:1, order:10 });
const cLoan = await makeComp('DED_LOAN', { type:'deduction', tax:0, pro:0, order:200 });

async function makeEmp(id, o = {}) {
  const f = { start:'2026-01-01', term:null, status:'active', bank:'1234567890', ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code,bank_account_no)
              VALUES (?,?,'internal',?,?,?,'PPB',?)`).run(id,id,f.status,f.start,f.term,f.bank);
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
  const f = { work:480, ot:0, otStatus:'none', dayType:'WORKDAY', ...o };
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_minutes_requested,overtime_minutes_approved,overtime_hours_approved,overtime_status,day_type,day_type_source)
    VALUES (?,?,'present',?,?,?,?,?,?,?,'test')`)
    .run(id,date,f.work,time.minutesToHours(f.work), f.otStatus==='pending'?f.ot:0, f.otStatus==='approved'?f.ot:0,
      time.minutesToHours(f.otStatus==='approved'?f.ot:0), f.otStatus, f.dayType);
}
async function snap(id, periodId) {
  const out = await withTransaction(db, async () => await writer.writeOne(db, id, periodId, { resolvedBy:'test' }));
  return await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id=?').get(out.snapshotId);
}
async function validate(id, periodId) {
  const s = await snap(id, periodId);
  const r = await withTransaction(db, async () => await runner.validateOne(db, s, { detectedAt: '2026-07-01 00:00:00' }));
  return { snapshot: s, ...r, codes: r.exceptions.map((e) => e.exception_code) };
}

// =============================================================================
section('POLICY LOCKS (1, 2, 3)');
// =============================================================================

await check('POLICY 1: mid-period salary change uses SEGMENT-BASED proration', async () => {
  await makeEmp('E-SEG'); await assign('E-SEG');
  await withTransaction(db, async () => {
    await addComp('E-SEG', cBasic, 8000000, '2026-01-01', '2026-06-14');
    await addComp('E-SEG', cBasic, 9500000, '2026-06-15');
  });
  const payload = resolver.buildPayload(await resolver.resolve(db, 'E-SEG', pJun));
  eq(payload.salary_structure_segments.length, 2, 'two segments: ');
  const r = calc.calculate(payload);
  // (8.000.000 x 14 + 9.500.000 x 16) / 30 = 8.800.000
  const expected = money.roundHalfUp((money.rupiahToSen(8000000) * 14 + money.rupiahToSen(9500000) * 16) / 30);
  eq(r.earnings.total_sen, expected, 'segment-weighted: ');
  eq(rp(r.earnings.total_sen), 8800000, 'in rupiah: ');
  const traceLine = r.trace.find((t) => t.component === 'BASIC');
  eq(traceLine.formula, 'sum(segment_amount_sen * segment_days) / total_days');
  eq(traceLine.source_snapshot_field, 'salary_structure_segments[].components[].amount_sen');
});

await check('POLICY 1: a single-segment employee is unaffected (no regression)', async () => {
  await makeEmp('E-FLAT'); await assign('E-FLAT'); await addComp('E-FLAT', cBasic, 8000000);
  const r = calc.calculate(resolver.buildPayload(await resolver.resolve(db, 'E-FLAT', pJun)));
  eq(rp(r.earnings.total_sen), 8000000);
  eq(r.trace.find((t) => t.component === 'BASIC').formula, 'amount_sen');
});

await check('POLICY 2: overtime taxability comes from CONFIG, not the calculator', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  if (!code.includes('overtime_is_taxable')) throw new Error('calculator must read the config flag');

  await makeEmp('E-OTTAX'); await assign('E-OTTAX'); await addComp('E-OTTAX', cBasic, 8000000);
  await addTs('E-OTTAX', '2026-06-15', { ot: 180, otStatus: 'approved' });
  const taxable = calc.calculate(resolver.buildPayload(await resolver.resolve(db, 'E-OTTAX', pJun)));
  eq(taxable.totals.taxable_base_sen, taxable.earnings.total_sen + taxable.overtime.total_sen, 'overtime included: ');

  // Flip the CONFIG (not the code) and the behaviour changes.
  const payload = resolver.buildPayload(await resolver.resolve(db, 'E-OTTAX', pJun));
  const nonTaxable = calc.calculate({ ...payload, bpjs_rule: { ...payload.bpjs_rule, overtime_is_taxable: 0 } });
  eq(nonTaxable.totals.taxable_base_sen, nonTaxable.earnings.total_sen, 'overtime excluded by config: ');
  eq(nonTaxable.trace.find((t) => t.component === 'TAXABLE_BASE').basis.includes('non-taxable'), true);
});

await check('POLICY 3: monthly TER is never treated as final annual tax', async () => {
  const r = calc.calculate(resolver.buildPayload(await resolver.resolve(db, 'E-FLAT', pJun)));
  eq(r.tax.is_final_annual_tax, false);
  eq(r.tax.annual_reconciliation_required, true);
  eq(r.tax.annual_reconciliation_scope, 'OUT_OF_MVP_SCOPE');
  const v = await validate('E-FLAT', pJun);
  eq(v.codes.includes(C.ANNUAL_TAX_RECONCILIATION_PENDING), true, 'tracked as an explicit exception: ');
  const ex = v.exceptions.find((e) => e.exception_code === C.ANNUAL_TAX_RECONCILIATION_PENDING);
  eq(ex.severity, 'INFORMATIONAL');
  eq(ex.blocking, 0);
});

// =============================================================================
section('EXCEPTION DETECTION');
// =============================================================================

await check('1. CLEAN PAYROLL produces no blocking exception', async () => {
  await makeEmp('E-CLEAN'); await assign('E-CLEAN'); await addComp('E-CLEAN', cBasic, 8000000);
  await addTs('E-CLEAN', '2026-06-15'); await addTs('E-CLEAN', '2026-06-16');
  const v = await validate('E-CLEAN', pJun);
  eq(v.exceptions.filter((e) => e.blocking === 1).length, 0, `blocking: ${JSON.stringify(v.codes)} — `);
  eq(v.codes.includes(C.ANNUAL_TAX_RECONCILIATION_PENDING), true, 'informational only: ');
});

await check('2. MISSING SALARY STRUCTURE is BLOCKING', async () => {
  await makeEmp('E-NOSAL'); await assign('E-NOSAL'); await addTs('E-NOSAL', '2026-06-15');
  const v = await validate('E-NOSAL', pJun);
  eq(v.codes.includes(C.MISSING_SALARY_STRUCTURE), true);
  eq(v.exceptions.find((e) => e.exception_code === C.MISSING_SALARY_STRUCTURE).blocking, 1);
});

await check('3/4. MISSING BPJS and TAX CONFIGURATION are BLOCKING', async () => {
  // A period in a year with no rule-set coverage.
  const p2025 = await makePeriod(gKahe, 2025, 12);
  await makeEmp('E-NORULE'); await assign('E-NORULE', { from: '2025-01-01' });
  await addComp('E-NORULE', cBasic, 5000000, '2025-01-01');
  const v = await validate('E-NORULE', p2025);
  eq(v.codes.includes(C.MISSING_BPJS_CONFIGURATION), true, 'bpjs: ');
  eq(v.exceptions.find((e) => e.exception_code === C.MISSING_BPJS_CONFIGURATION).severity, 'BLOCKING');
  // and a tax-config case, driven directly through the pure validator
  const exs = validation.evaluate({
    snapshot: { id: 1, employee_id: 'X', payroll_period_id: 1, legal_entity_id: 'KAHE360' },
    payload: { resolution_errors: [{ code: resolver.ERROR.MISSING_TER_TABLE }] },
    result: { status: 'BLOCKED', errors: [{ code: calc.CALC_ERROR.MISSING_TAX_RULE }] },
    context: {},
  });
  eq(exs.some((e) => e.exception_code === C.MISSING_TAX_CONFIGURATION && e.blocking === 1), true, 'tax: ');
});

await check('5. MISSING PAYROLL ASSIGNMENT is BLOCKING', async () => {
  await makeEmp('E-NOASSIGN');
  const v = await validate('E-NOASSIGN', pJun);
  eq(v.codes.includes(C.MISSING_PAYROLL_ASSIGNMENT), true);
  eq(v.exceptions.find((e) => e.exception_code === C.MISSING_PAYROLL_ASSIGNMENT).blocking, 1);
});

await check('6. UNAPPROVED OVERTIME is BLOCKING and reports the minutes', async () => {
  await makeEmp('E-OTPEND'); await assign('E-OTPEND'); await addComp('E-OTPEND', cBasic, 8000000);
  await addTs('E-OTPEND', '2026-06-15', { ot: 120, otStatus: 'pending' });
  const v = await validate('E-OTPEND', pJun);
  eq(v.codes.includes(C.UNAPPROVED_OVERTIME), true);
  const ex = v.exceptions.find((e) => e.exception_code === C.UNAPPROVED_OVERTIME);
  eq(ex.blocking, 1);
  eq(ex.detail.pending_minutes, 120);
});

await check('7. NEGATIVE NET PAY is BLOCKING', async () => {
  await makeEmp('E-NEG'); await assign('E-NEG');
  await addComp('E-NEG', cBasic, 3000000); await addComp('E-NEG', cLoan, 5000000);
  const v = await validate('E-NEG', pJun);
  eq(v.codes.includes(C.NEGATIVE_NET_PAY), true);
  eq(v.exceptions.find((e) => e.exception_code === C.NEGATIVE_NET_PAY).blocking, 1);
});

await check('8. ZERO SALARY on an ACTIVE employee is a WARNING', async () => {
  await makeEmp('E-ZEROSAL'); await assign('E-ZEROSAL'); await addComp('E-ZEROSAL', cBasic, 0);
  const v = await validate('E-ZEROSAL', pJun);
  eq(v.codes.includes(C.ZERO_SALARY_ACTIVE_EMPLOYEE), true);
  eq(v.exceptions.find((e) => e.exception_code === C.ZERO_SALARY_ACTIVE_EMPLOYEE).severity, 'WARNING');
});

await check('9. MISSING ATTENDANCE is a WARNING, not a blocker', async () => {
  await makeEmp('E-NOATT'); await assign('E-NOATT'); await addComp('E-NOATT', cBasic, 8000000);
  const v = await validate('E-NOATT', pJun);
  eq(v.codes.includes(C.MISSING_ATTENDANCE), true);
  const ex = v.exceptions.find((e) => e.exception_code === C.MISSING_ATTENDANCE);
  eq(ex.severity, 'WARNING'); eq(ex.blocking, 0);
});

await check('SUSPICIOUSLY HIGH OVERTIME is a WARNING (daily legal cap and period total)', async () => {
  await makeEmp('E-OTBIG'); await assign('E-OTBIG'); await addComp('E-OTBIG', cBasic, 8000000);
  await addTs('E-OTBIG', '2026-06-15', { ot: 360, otStatus: 'approved' });   // 6h > 4h workday cap
  const v = await validate('E-OTBIG', pJun);
  eq(v.codes.includes(C.SUSPICIOUS_OVERTIME), true);
  eq(v.exceptions.find((e) => e.exception_code === C.SUSPICIOUS_OVERTIME).severity, 'WARNING');
});

await check('MISSING BANK DETAILS is a forward-looking WARNING', async () => {
  await makeEmp('E-NOBANK', { bank: null }); await assign('E-NOBANK'); await addComp('E-NOBANK', cBasic, 8000000);
  await addTs('E-NOBANK', '2026-06-15');
  const v = await validate('E-NOBANK', pJun);
  const ex = v.exceptions.find((e) => e.exception_code === C.MISSING_BANK_DETAILS);
  eq(ex.severity, 'WARNING'); eq(ex.detail.future_stage, 'payment');
});

await check('10. MASTER DATA DRIFT after snapshot is BLOCKING', async () => {
  await makeEmp('E-DRIFT'); await assign('E-DRIFT'); await addComp('E-DRIFT', cBasic, 8000000);
  await addTs('E-DRIFT', '2026-06-15');
  const s = await snap('E-DRIFT', pJun);
  // change the world after the snapshot
  await addTs('E-DRIFT', '2026-06-16');
  const r = await withTransaction(db, async () => await runner.validateOne(db, s, { detectedAt: '2026-07-01 00:00:00' }));
  const codes = r.exceptions.map((e) => e.exception_code);
  eq(codes.includes(C.MASTER_DATA_DRIFT), true);
  eq(r.exceptions.find((e) => e.exception_code === C.MASTER_DATA_DRIFT).blocking, 1);
});

await check('11. DUPLICATE PAYROLL CANDIDATE across overlapping periods is BLOCKING', async () => {
  // A second group whose June period covers the same dates.
  const gDup = await makeGroup('DUP-M', 'KAHE360');
  const pDup = await makePeriod(gDup, 2026, 6);
  await makeEmp('E-DUP'); await assign('E-DUP'); await addComp('E-DUP', cBasic, 8000000);
  await addTs('E-DUP', '2026-06-15');
  await snap('E-DUP', pJun);
  // Force a second snapshot in the overlapping period (bypassing group check;
  // the point is that validation CATCHES it).
  await withTransaction(db, async () => await writer.writeOne(db, 'E-DUP', pDup, { resolvedBy: 'test' }));
  const s = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-DUP', pJun);
  const r = await withTransaction(db, async () => await runner.validateOne(db, s, { detectedAt: '2026-07-01 00:00:00' }));
  const ex = r.exceptions.find((e) => e.exception_code === C.DUPLICATE_PAYROLL_CANDIDATE);
  if (!ex) throw new Error(`expected duplicate detection, got ${JSON.stringify(r.exceptions.map((e) => e.exception_code))}`);
  eq(ex.blocking, 1);
  eq(ex.detail.other_period_id, pDup);
});

await check('12. JOINER / LEAVER boundaries validate cleanly (prorated, not flagged)', async () => {
  await makeEmp('E-JOIN', { start: '2026-06-16' }); await assign('E-JOIN', { from: '2026-06-16' });
  await addComp('E-JOIN', cBasic, 9000000, '2026-06-16'); await addTs('E-JOIN', '2026-06-16');
  const vj = await validate('E-JOIN', pJun);
  eq(vj.exceptions.filter((e) => e.blocking === 1).length, 0, `joiner blocking: ${JSON.stringify(vj.codes)} — `);
  eq(vj.result.proration.payable_days, 15);

  await makeEmp('E-LEAVE', { term: '2026-06-20', status: 'inactive' });
  await assign('E-LEAVE', { from: '2026-01-01', to: '2026-06-20' });
  await addComp('E-LEAVE', cBasic, 9000000, '2026-01-01', '2026-06-20'); await addTs('E-LEAVE', '2026-06-10');
  const vl = await validate('E-LEAVE', pJun);
  eq(vl.exceptions.filter((e) => e.blocking === 1).length, 0, `leaver blocking: ${JSON.stringify(vl.codes)} — `);
});

await check('EMPLOYEE OUTSIDE ELIGIBILITY PERIOD is BLOCKING', async () => {
  await makeEmp('E-OUTSIDE', { start: '2026-09-01' }); await assign('E-OUTSIDE', { from: '2026-09-01' });
  await addComp('E-OUTSIDE', cBasic, 5000000, '2026-09-01');
  const v = await validate('E-OUTSIDE', pJun);
  const blocking = v.exceptions.filter((e) => e.blocking === 1).map((e) => e.exception_code);
  eq(blocking.length > 0, true, 'must be blocked: ');
  eq(blocking.includes(C.OUTSIDE_ELIGIBILITY_PERIOD) || blocking.includes(C.MISSING_PAYROLL_ASSIGNMENT), true, `got ${blocking}: `);
});

await check('13. MID-PERIOD SALARY CHANGE is recorded as INFORMATIONAL', async () => {
  const v = await validate('E-SEG', pJun);
  const ex = v.exceptions.find((e) => e.exception_code === C.MID_PERIOD_SALARY_CHANGE);
  eq(ex.severity, 'INFORMATIONAL'); eq(ex.blocking, 0);
  eq(ex.detail.segments.length, 2);
});

await check('INVALID SALARY COMPONENT is BLOCKING (via the pure validator)', () => {
  const exs = validation.evaluate({
    snapshot: { id: 2, employee_id: 'X', payroll_period_id: 1, legal_entity_id: 'KAHE360' },
    payload: {},
    result: { status: 'BLOCKED', errors: [{ code: calc.CALC_ERROR.INVALID_COMPONENT, detail: 'BASIC: negative' }] },
    context: {},
  });
  const ex = exs.find((e) => e.exception_code === C.INVALID_SALARY_COMPONENT);
  eq(ex.blocking, 1);
});

await check('INCONSISTENT PAYABLE DAYS is a WARNING (via the pure validator)', () => {
  const exs = validation.evaluate({
    snapshot: { id: 3, employee_id: 'X', payroll_period_id: 1, legal_entity_id: 'KAHE360' },
    payload: { eligibility: { payable_days: 25, total_days: 30, segments: [{ days: 10 }, { days: 5 }] }, attendance: { row_count: 1 } },
    result: { status: 'OK', errors: [], earnings: { total_sen: 1 }, tax: {} },
    context: { employee: { bank_account_no: '1' } },
  });
  const ex = exs.find((e) => e.exception_code === C.INCONSISTENT_PAYABLE_DAYS);
  eq(ex.severity, 'WARNING');
  eq(ex.detail, { segment_days: 15, payable_days: 25 });
});

// =============================================================================
section('EXCEPTION RECORD SHAPE & DETERMINISM');
// =============================================================================

await check('every exception carries all 12 required fields', async () => {
  const v = await validate('E-OTPEND', pJun);
  const required = ['exception_code','severity','employee_id','payroll_period_id','source','message',
    'blocking','detected_at','resolution_status','resolved_by','resolved_at','resolution_note'];
  for (const e of v.exceptions) {
    for (const f of required) if (!(f in e)) throw new Error(`${e.exception_code} missing ${f}`);
  }
  const stored = await db.prepare('SELECT * FROM payroll_exceptions WHERE employee_id=? ').all('E-OTPEND');
  eq(stored.length > 0, true);
  for (const f of required) if (!(f in stored[0])) throw new Error(`stored row missing ${f}`);
});

await check('every code has a declared severity (no undeclared code can be raised)', () => {
  for (const code of Object.values(validation.CODE)) {
    if (!validation.SEVERITY_OF[code]) throw new Error(`no severity declared for ${code}`);
  }
});

await check('18. DETERMINISTIC RERUN yields the identical exception set', async () => {
  const s = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-OTPEND', pJun);
  const payload = JSON.parse(s.resolved_payload);
  const result = calc.calculate(payload);
  const ctx = await runner.buildContext(db, s, { detectedAt: '2026-07-01 00:00:00' });
  const a = validation.evaluate({ snapshot: s, payload, result, context: ctx });
  const b = validation.evaluate({ snapshot: s, payload, result, context: ctx });
  eq(JSON.stringify(a), JSON.stringify(b), 'two evaluations differ: ');
});

await check('re-validating does NOT duplicate rows and PRESERVES a resolution', async () => {
  const s = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NOATT', pJun);
  await withTransaction(db, async () => await runner.validateOne(db, s, { detectedAt: '2026-07-01 00:00:00' }));
  const ex = await db.prepare(`SELECT * FROM payroll_exceptions WHERE snapshot_id=? AND exception_code=?`).get(s.id, C.MISSING_ATTENDANCE);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='ACKNOWLEDGED', resolved_by='Tester', resolution_note='dicek manual' WHERE id=?`).run(ex.id);
  });
  // re-validate
  await withTransaction(db, async () => await runner.validateOne(db, s, { detectedAt: '2026-07-02 00:00:00' }));
  const after = await db.prepare(`SELECT * FROM payroll_exceptions WHERE snapshot_id=? AND exception_code=?`).all(s.id, C.MISSING_ATTENDANCE);
  eq(after.length, 1, 'no duplicate row: ');
  eq(after[0].resolution_status, 'ACKNOWLEDGED', 'resolution survived re-validation: ');
  eq(after[0].resolution_note, 'dicek manual');
});

await check('a duplicate (snapshot, code) is impossible at the database level', async () => {
  const ex = await db.prepare('SELECT * FROM payroll_exceptions LIMIT 1').get();
  let threw = false;
  try {
    await db.prepare(`INSERT INTO payroll_exceptions (snapshot_id,payroll_period_id,employee_id,legal_entity_id,
      exception_code,severity,blocking,source,message,detected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ex.snapshot_id, ex.payroll_period_id, ex.employee_id,
      ex.legal_entity_id, ex.exception_code, ex.severity, ex.blocking, 'x', 'x', 'x');
  } catch (e) { threw = true; }
  if (!threw) throw new Error('duplicate (snapshot_id, exception_code) must be rejected');
});

// =============================================================================
section('RESOLUTION WORKFLOW & GATE');
// =============================================================================

await check('14. BLOCKING exceptions prevent progression; the gate says so', async () => {
  const gate = await validation.getBlockingSummary(db, pJun);
  eq(gate.unresolved_blocking > 0, true, 'there are unresolved blockers: ');
  eq(gate.may_progress, false, 'gate must be closed: ');
});

await check('15. RESOLVING a blocking exception opens the gate for that item', async () => {
  const ex = await db.prepare(`SELECT * FROM payroll_exceptions WHERE payroll_period_id=? AND blocking=1 AND resolution_status='OPEN' LIMIT 1`).get(pJun);
  const before = (await validation.getBlockingSummary(db, pJun)).unresolved_blocking;
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED', resolved_by='Director', resolved_at=kahe_now(), resolution_note='disetujui' WHERE id=?`).run(ex.id);
  });
  eq((await validation.getBlockingSummary(db, pJun)).unresolved_blocking, before - 1, 'one fewer blocker: ');
});

await check('16. ACKNOWLEDGING a warning changes only its own state', async () => {
  const ex = await db.prepare(`SELECT * FROM payroll_exceptions WHERE severity='WARNING' AND resolution_status='OPEN' LIMIT 1`).get();
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='ACKNOWLEDGED', resolved_by='Officer', resolution_note='ok' WHERE id=?`).run(ex.id);
  });
  const after = await db.prepare('SELECT * FROM payroll_exceptions WHERE id=?').get(ex.id);
  eq(after.resolution_status, 'ACKNOWLEDGED');
  eq(after.blocking, 0, 'severity unchanged by acknowledgement: ');
});

await check('the engine NEVER auto-fixes data — resolution is a record, not a mutation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollValidation.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const table of ['employee_salary_components', 'timesheet_entries', 'employee_payroll_assignments', 'payroll_rule_sets']) {
    if (new RegExp(`UPDATE\\s+${table}|INSERT\\s+INTO\\s+${table}|DELETE\\s+FROM\\s+${table}`).test(code)) {
      throw new Error(`validation must not write to ${table}`);
    }
  }
  // it may only write to its own table
  eq(/payroll_exceptions/.test(code), true);
});

// =============================================================================
section('ISOLATION, SCALE, NO PERSISTENCE OF RESULTS');
// =============================================================================

await check('17. LEGAL ENTITY ISOLATION: exceptions carry their own entity', async () => {
  await makeEmp('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra });
  await addComp('E-MITRA', cBasic, 8000000);
  const v = await validate('E-MITRA', pJunM);
  eq(v.exceptions.every((e) => e.legal_entity_id === 'MITRA'), true);
  const kahe = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_exceptions WHERE payroll_period_id=? AND legal_entity_id='MITRA'`).get(pJun)).n;
  eq(kahe, 0, 'no MITRA exception under a KAHE period: ');
});

await check('19. 1,500 EMPLOYEE VALIDATION BATCH runs in bounded chunks', async () => {
  const pJul = await makePeriod(gKahe, 2026, 7);
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_account_no) VALUES (?,?,'internal','active','2026-01-01','PPB','111')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source) VALUES (?, '2026-07-15','present',480,8,'none','WORKDAY','test')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await insE.run(id, id); await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  await writer.snapshotPeriod(db, pJul, { chunkSize: 200, resolvedBy: 'bulk' });
  const summary = await runner.validatePeriod(db, pJul, { chunkSize: 200, detectedAt: '2026-08-01 00:00:00' });
  eq(summary.total >= 1500, true, `snapshots validated (${summary.total}) must cover the 1,500 cohort: `);
  eq(summary.chunks >= 8, true, `chunks (${summary.chunks}) must be bounded: `);
  // Assert the BULK cohort specifically: the period also contains earlier
  // deliberately-broken fixtures that share this payroll group, and those
  // SHOULD still be blocked — that is the engine working, not a failure.
  const bulkBlockers = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_exceptions
    WHERE payroll_period_id = ? AND blocking = 1 AND employee_id LIKE 'BULK-%'`).get(pJul)).n;
  eq(bulkBlockers, 0, 'the 1,500 clean employees have no blockers: ');
  const bulkInfo = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_exceptions
    WHERE payroll_period_id = ? AND severity = 'INFORMATIONAL' AND employee_id LIKE 'BULK-%'`).get(pJul)).n;
  eq(bulkInfo, 1500, 'one informational (annual tax) per clean employee: ');
  // The gate is correctly CLOSED, because the broken fixtures are still open.
  eq(summary.gate.may_progress, false, 'gate closed while broken fixtures remain: ');
  eq(summary.gate.unresolved_blocking > 0, true, 'and it says why: ');
});

await check('rerunning the whole-period validation is idempotent', async () => {
  const pJul = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=7').get(gKahe)).id;
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_exceptions WHERE payroll_period_id=?').get(pJul)).n;
  await runner.validatePeriod(db, pJul, { chunkSize: 200, detectedAt: '2026-08-02 00:00:00' });
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_exceptions WHERE payroll_period_id=?').get(pJul)).n, before, 'row count unchanged: ');
});

await check('Phase 2D persists EXCEPTIONS ONLY', async () => {
  // SUPERSEDED IN PART BY PHASE 2E: payroll_runs / payroll_run_lines now
  // exist. The guarantee this test protects is unchanged: the VALIDATION
  // engine writes exceptions and nothing else.
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 2H: payment tables now exist. What this
  // test guards is unchanged and is asserted below: this module writes no
  // payment row of its own.
  const paymentRows = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n;
  eq(paymentRows, 0, 'this phase must create no payment record: ');
  eq(tables.includes('payroll_exceptions'), true);

  const countRows = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  const before = [await countRows('payroll_runs'), await countRows('payroll_run_lines')];
  const s2 = await db.prepare('SELECT * FROM payroll_input_snapshots LIMIT 1').get();
  await withTransaction(db, async () => await runner.validateOne(db, s2, { detectedAt: '2026-07-01 00:00:00' }));
  eq([await countRows('payroll_runs'), await countRows('payroll_run_lines')], before,
    'validation must not write a payroll result: ');
});

// =============================================================================
section('20. REGRESSION');
// =============================================================================

await check('all prior invariant indexes still present, plus the new one', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee','uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class','uq_holiday_national_per_date','uq_emp_salary_component_open',
    'uq_salary_component_open_global','uq_salary_component_open_scoped','uq_work_calendar_open_code',
    'uq_payroll_group_open_code','uq_payroll_period_group_cycle','uq_payroll_period_group_start',
    'uq_snapshot_period_employee','uq_exception_snapshot_code']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('prior canonical libraries behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq((await dc.classifyDay(db, 'E-CLEAN', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-CLEAN', '2026-06-15')).eligible, true);
  eq((await pp.resolvePeriodForDate(db, 'E-CLEAN', '2026-06-15')).period.id, pJun);
});

await check('the calculator remains PURE after the policy changes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  eq(requires, ['./money', './time'], 'allowed imports unchanged: ');
});

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2D TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
