(async () => {
// tests/phase2c.test.js
// Phase 2C — Payroll Calculation Core (DRY-RUN ONLY). Throwaway database.
// Usage: npm run test:phase2c

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
const calc = require('../lib/payrollCalculator');
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
function hasError(r, code) { return (r.errors || []).some((e) => e.code === code); }
function section(t) { console.log(`\n${t}`); }
const rp = (sen) => money.senToRupiah(sen);

const TEST_DB = path.join(__dirname, 'phase2c.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2c');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra','subkontraktor','medium','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',127,'2026-01-01')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();
await db.prepare(`INSERT INTO holidays (date,name,scope,holiday_type) VALUES ('2026-06-01','Hari Lahir Pancasila','national','PUBLIC_HOLIDAY')`).run();

const rsId = (await db.prepare(`INSERT INTO payroll_rule_sets
  (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
   jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,overtime_hourly_divisor)
  VALUES ('RS 2026','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173) RETURNING id`).run()).lastInsertRowid;
// Simplified TER: A -> 0% up to Rp5.4jt, 1.5% above. B -> 0% up to Rp6.2jt, 1% above.
for (const [cat, lo, hi, bp] of [
  ['A', 0, 540000000, 0], ['A', 540000000, null, 150],
  ['B', 0, 620000000, 0], ['B', 620000000, null, 100],
  ['C', 0, 660000000, 0], ['C', 660000000, null, 75],
]) await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rsId, cat, lo, hi, bp);
for (const [dt, hf, ht, mbp] of [
  ['workday', 1, 1, 15000], ['workday', 2, null, 20000],
  ['rest_or_holiday_5day', 1, 8, 20000], ['rest_or_holiday_5day', 9, 9, 30000], ['rest_or_holiday_5day', 10, 11, 40000],
]) await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rsId, dt, hf, ht, mbp);

const gKahe = (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
  attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,effective_from)
  VALUES ('KAHE-M','KAHE Bulanan','KAHE360','monthly',12,0,0,2,5,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
const gMitra = (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
  attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,effective_from)
  VALUES ('MITRA-M','Mitra','MITRA','monthly',12,0,0,2,5,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makePeriod(g, y, s) {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(g);
  const w = pp.monthlyWindow(y, s); const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN') RETURNING id`).run(g, y, s, s, d.period_start, d.period_end,
    d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date)).lastInsertRowid;
}
const pJun = await makePeriod(gKahe, 2026, 6);
const pJunM = await makePeriod(gMitra, 2026, 6);

async function makeComp(code, o = {}) {
  const f = { type: 'earning', calc: 'fixed', paid: 'employee', tax: 1, bpjs: 0, ot: 0, pro: 1, order: 100, ...o };
  return (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
    is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES (?,?,?,?,?,?,?,?,?,'recurring',?,'2026-01-01') RETURNING id`)
    .run(code, code, f.type, f.calc, f.paid, f.tax, f.bpjs, f.ot, f.pro, f.order)).lastInsertRowid;
}
const cBasic = await makeComp('BASIC', { bpjs: 1, ot: 1, order: 10 });
const cFixed = await makeComp('ALLOW_FIXED', { bpjs: 1, ot: 1, order: 20 });
const cSite = await makeComp('ALLOW_SITE', { order: 30 });
const cMeal = await makeComp('ALLOW_MEAL', { calc: 'variable', tax: 0, order: 40 });
const cLoan = await makeComp('DED_LOAN', { type: 'deduction', tax: 0, pro: 0, order: 200 });

async function makeEmp(id, o = {}) {
  const f = { start: '2026-01-01', term: null, status: 'active', ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code)
              VALUES (?,?,'internal',?,?,?,'PPB')`).run(id, id, f.status, f.start, f.term);
}
async function assign(id, o = {}) {
  const a = { entity: 'KAHE360', group: gKahe, from: '2026-01-01', to: null, marital: 'TK', dep: 0, ...o };
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date,end_date) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, a.entity, wp5, cal, a.group, a.marital, a.dep, a.from, a.to);
}
async function addComp(id, cid, rupiah, from = '2026-01-01', to = null) {
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to)
              VALUES (?,?,?,?,?)`).run(id, cid, money.rupiahToSen(rupiah), from, to);
}
async function addOt(id, date, otMinutes, dayType) {
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_minutes_approved,overtime_hours_approved,overtime_status,day_type,day_type_source)
    VALUES (?,?,'present',480,8,?,?,'approved',?,'test')`)
    .run(id, date, otMinutes, time.minutesToHours(otMinutes), dayType);
}
/** Resolve + build payload without persisting — the calculator's real input. */
async function payloadFor(id, periodId, asOf = null) {
  return resolver.buildPayload(await resolver.resolve(db, id, periodId, asOf));
}

// =============================================================================
section('PURITY & DETERMINISM (the Phase 2C contract)');
// =============================================================================

await check('the calculator performs NO database access (purity, enforced)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const token of ['database/init-db', 'getDb', 'db.prepare', 'require(\'./asOfResolver', 'sqlite']) {
    if (code.includes(token)) throw new Error(`calculator must not touch the database: found ${token}`);
  }
  // Only pure numeric helpers may be imported.
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  eq(requires, ['./money', './time'], 'allowed imports: ');
});

await check('the calculator does not mutate its input payload', async () => {
  await makeEmp('E-PURE'); await assign('E-PURE'); await addComp('E-PURE', cBasic, 8000000);
  const payload = await payloadFor('E-PURE', pJun);
  const before = JSON.stringify(payload);
  calc.calculate(payload);
  eq(JSON.stringify(payload), before, 'payload unchanged: ');
});

await check('17. DETERMINISTIC RERUN produces an identical result', async () => {
  const payload = await payloadFor('E-PURE', pJun);
  const a = calc.calculate(payload);
  const b = calc.calculate(JSON.parse(JSON.stringify(payload)));
  // engine_version and all amounts must match byte for byte.
  eq(JSON.stringify(a), JSON.stringify(b), 'two runs differ: ');
});

// =============================================================================
section('CORE CALCULATION');
// =============================================================================

await makeEmp('E-NORM'); await assign('E-NORM');
await addComp('E-NORM', cBasic, 8000000);
await addComp('E-NORM', cFixed, 1500000);
await addComp('E-NORM', cSite, 1000000);
await addComp('E-NORM', cMeal, 600000);
await addComp('E-NORM', cLoan, 500000);

await check('1. NORMAL MONTHLY EMPLOYEE: gross, BPJS, tax and net are exact', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  eq(r.status, 'OK', `errors: ${JSON.stringify(r.errors)} — `);
  // earnings: 8.000.000 + 1.500.000 + 1.000.000 + 600.000 = 11.100.000
  eq(rp(r.totals.gross_sen), 11100000, 'gross: ');
  eq(rp(r.earnings.fixed_sen), 10500000, 'fixed: ');
  eq(rp(r.earnings.variable_sen), 600000, 'variable: ');
  // BPJS base = only BASIC + ALLOW_FIXED (is_bpjs_base = 1) = 9.500.000
  eq(rp(r.totals.bpjs_base_sen), 9500000, 'bpjs base: ');
  // employee BPJS = 1% kesehatan + 2% JHT + 1% JP on 9.500.000 = 380.000
  eq(rp(r.bpjs.kesehatan.employee_sen), 95000);
  eq(rp(r.bpjs.jht.employee_sen), 190000);
  eq(rp(r.bpjs.jp.employee_sen), 95000);
  eq(rp(r.bpjs.employee_total_sen), 380000, 'BPJS employee: ');
  // employer = 4% + 3.7% + 2% + 0.3% JKM + 1.27% JKK on 9.500.000
  eq(rp(r.bpjs.employer_total_sen), 380000 + 351500 + 190000 + 28500 + 120650, 'BPJS employer: ');
  // taxable = all taxable earnings (excl. ALLOW_MEAL) = 10.500.000, TER A above 5.4jt -> 1.5%
  eq(rp(r.totals.taxable_base_sen), 10500000, 'taxable base: ');
  eq(rp(r.tax.amount_sen), 157500, 'PPh21: ');
  // net = 11.100.000 - (380.000 + 157.500 + 500.000)
  eq(rp(r.totals.employee_deductions_sen), 1037500, 'employee deductions: ');
  eq(rp(r.totals.net_sen), 10062500, 'net: ');
});

await check('5. MULTIPLE EARNING COMPONENTS are all itemised', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  eq(r.earnings.components.map((c) => c.code).sort(), ['ALLOW_FIXED', 'ALLOW_MEAL', 'ALLOW_SITE', 'BASIC']);
  eq(r.earnings.components.every((c) => Number.isInteger(c.computed_sen)), true, 'all integer sen: ');
});

await check('6. DEDUCTION COMPONENT reduces net but not gross', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  eq(r.deductions.components.map((c) => c.code), ['DED_LOAN']);
  eq(rp(r.deductions.other_sen), 500000);
  eq(r.totals.gross_sen, r.earnings.total_sen + r.overtime.total_sen, 'deduction not in gross: ');
});

await check('7. BPJS BASIS respects per-component inclusion/exclusion flags', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  // ALLOW_SITE and ALLOW_MEAL are excluded by their flags, not by hardcoding.
  eq(rp(r.totals.bpjs_base_sen), 9500000);
  eq(rp(r.earnings.total_sen) - rp(r.totals.bpjs_base_sen), 1600000, 'excluded amount: ');
});

await check('BPJS CAPS apply to the base, not to the contribution', async () => {
  await makeEmp('E-HIGH'); await assign('E-HIGH');
  await addComp('E-HIGH', cBasic, 15000000);   // above both caps
  const r = calc.calculate(await payloadFor('E-HIGH', pJun));
  eq(r.bpjs.kesehatan.capped, true);
  eq(rp(r.bpjs.kesehatan.base_sen), 12000000, 'kesehatan capped: ');
  eq(rp(r.bpjs.jp.base_sen), 10547400, 'JP capped: ');
  eq(rp(r.bpjs.jht.base_sen), 15000000, 'JHT uncapped: ');
  eq(rp(r.bpjs.kesehatan.employee_sen), 120000);
  eq(r.bpjs.jp.employee_sen, money.applyBp(money.rupiahToSen(10547400), 100));
});

await check('8. TAX/TER VERSION is taken from the snapshot, and category drives the bracket', async () => {
  await makeEmp('E-K2'); await assign('E-K2', { marital: 'K', dep: 2 });
  await addComp('E-K2', cBasic, 8000000);
  const r = calc.calculate(await payloadFor('E-K2', pJun));
  eq(r.tax.ter_category, 'B', 'K/2 -> B: ');
  eq(r.tax.bracket.rate_bp, 100, 'category B rate: ');
  eq(rp(r.tax.amount_sen), 80000, '8.000.000 x 1% = 80.000: ');
  eq(r.rule_versions.tax_rule_set_id, rsId, 'pinned rule set: ');
});

await check('a taxable base below the first threshold yields zero tax', async () => {
  await makeEmp('E-LOW'); await assign('E-LOW'); await addComp('E-LOW', cBasic, 4000000);
  const r = calc.calculate(await payloadFor('E-LOW', pJun));
  eq(r.tax.bracket.rate_bp, 0);
  eq(r.tax.amount_sen, 0);
});

// =============================================================================
section('PRORATION — joiner, leaver, mid-period change');
// =============================================================================

await check('2. JOINER MID-PERIOD is prorated by payable days', async () => {
  await makeEmp('E-JOIN', { start: '2026-06-16' }); await assign('E-JOIN', { from: '2026-06-16' });
  await addComp('E-JOIN', cBasic, 9000000, '2026-06-16');
  await addComp('E-JOIN', cLoan, 300000, '2026-06-16');     // is_proratable = 0
  const r = calc.calculate(await payloadFor('E-JOIN', pJun));
  eq(r.proration, { payable_days: 15, period_days: 30, prorated: true });
  eq(rp(r.earnings.total_sen), 4500000, '9jt x 15/30: ');
  eq(rp(r.deductions.other_sen), 300000, 'non-proratable deduction unchanged: ');
});

await check('3. LEAVER MID-PERIOD is prorated to the termination date', async () => {
  await makeEmp('E-LEAVE', { term: '2026-06-20', status: 'inactive' });
  await assign('E-LEAVE', { from: '2026-01-01', to: '2026-06-20' });
  await addComp('E-LEAVE', cBasic, 9000000, '2026-01-01', '2026-06-20');
  const r = calc.calculate(await payloadFor('E-LEAVE', pJun, '2026-06-20'));
  eq(r.proration.payable_days, 20);
  eq(rp(r.earnings.total_sen), 6000000, '9jt x 20/30: ');
});

await check('4. SALARY CHANGE MID-PERIOD: snapshot segments are preserved for the run', async () => {
  await makeEmp('E-RAISE'); await assign('E-RAISE');
  await withTransaction(db, async () => {
    await addComp('E-RAISE', cBasic, 8000000, '2026-01-01', '2026-06-14');
    await addComp('E-RAISE', cBasic, 9500000, '2026-06-15');
  });
  const payload = await payloadFor('E-RAISE', pJun);
  eq(payload.salary_structure_segments.length, 2, 'two segments captured: ');
  eq(payload.salary_structure_segments[0].days, 14);
  eq(payload.salary_structure_segments[1].days, 16);
  const r = calc.calculate(payload);
  eq(r.status, 'OK');
  // SUPERSEDED BY PHASE 2D POLICY LOCK #1: proration is now segment-based.
  // (8.000.000 x 14 + 9.500.000 x 16) / 30 = 8.800.000, not the flat as-of
  // amount of 9.500.000 this phase originally produced.
  const expected = money.roundHalfUp((money.rupiahToSen(8000000) * 14 + money.rupiahToSen(9500000) * 16) / 30);
  eq(r.earnings.total_sen, expected, 'segment-weighted proration: ');
  eq(rp(r.earnings.total_sen), 8800000, 'in rupiah: ');
});

// =============================================================================
section('OVERTIME');
// =============================================================================

await check('9. NORMAL WORKDAY OVERTIME is progressive (1.5x then 2x)', async () => {
  await makeEmp('E-OT1'); await assign('E-OT1'); await addComp('E-OT1', cBasic, 8000000);
  await addOt('E-OT1', '2026-06-15', 180, 'WORKDAY');   // Monday, 3 hours
  const r = calc.calculate(await payloadFor('E-OT1', pJun));
  const rate = time.hourlyRateSen(money.rupiahToSen(8000000), 173);
  eq(r.overtime.hourly_rate_sen, rate, 'hourly rate: ');
  const expected = time.overtimePaySen(rate, 60, 15000)
    + time.overtimePaySen(rate, 60, 20000)
    + time.overtimePaySen(rate, 60, 20000);
  eq(r.overtime.total_sen, expected, 'progressive 1.5x + 2x + 2x: ');
  eq(r.overtime.by_day[0].segments.map((s) => s.multiplier_bp), [15000, 20000, 20000]);
  eq(r.overtime.by_day[0].band, 'workday');
});

await check('10. WEEKLY REST DAY OVERTIME uses the rest/holiday band (2x)', async () => {
  await makeEmp('E-OT2'); await assign('E-OT2'); await addComp('E-OT2', cBasic, 8000000);
  await addOt('E-OT2', '2026-06-21', 180, 'WEEKLY_REST_DAY');   // Sunday
  const r = calc.calculate(await payloadFor('E-OT2', pJun));
  eq(r.overtime.by_day[0].band, 'rest_or_holiday_5day');
  eq(r.overtime.by_day[0].segments.map((s) => s.multiplier_bp), [20000, 20000, 20000], 'all 2x: ');
  const rate = r.overtime.hourly_rate_sen;
  eq(r.overtime.total_sen, time.overtimePaySen(rate, 60, 20000) * 3);
});

await check('11. PUBLIC HOLIDAY OVERTIME uses the rest/holiday band too', async () => {
  await makeEmp('E-OT3'); await assign('E-OT3'); await addComp('E-OT3', cBasic, 8000000);
  await addOt('E-OT3', '2026-06-01', 120, 'PUBLIC_HOLIDAY');   // seeded holiday
  const r = calc.calculate(await payloadFor('E-OT3', pJun));
  eq(r.overtime.by_day[0].day_type, 'PUBLIC_HOLIDAY');
  eq(r.overtime.by_day[0].band, 'rest_or_holiday_5day');
  eq(r.overtime.by_day[0].segments.every((s) => s.multiplier_bp === 20000), true);
});

await check('12. OVERTIME MINUTES are exact — partial hours land in the right band', async () => {
  await makeEmp('E-OT4'); await assign('E-OT4'); await addComp('E-OT4', cBasic, 8000000);
  await addOt('E-OT4', '2026-06-16', 90, 'WORKDAY');   // 1.5 hours
  const r = calc.calculate(await payloadFor('E-OT4', pJun));
  const segs = r.overtime.by_day[0].segments;
  eq(segs.map((s) => [s.minutes, s.multiplier_bp]), [[60, 15000], [30, 20000]], 'hour 1 then 30 min at 2x: ');
  const rate = r.overtime.hourly_rate_sen;
  eq(r.overtime.total_sen, time.overtimePaySen(rate, 60, 15000) + time.overtimePaySen(rate, 30, 20000));
  eq(Number.isInteger(r.overtime.total_sen), true, 'integer sen: ');
  eq(r.overtime.minutes, 90);
});

await check('13. EMPLOYEE WITH NO OVERTIME yields zero, not null or an error', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  eq(r.overtime.total_sen, 0);
  eq(r.overtime.minutes, 0);
  eq(r.overtime.by_day, []);
  eq(r.status, 'OK');
});

await check('overtime base uses only components flagged is_overtime_base', async () => {
  const r = calc.calculate(await payloadFor('E-NORM', pJun));
  eq(rp(r.overtime.base_sen), 9500000, 'BASIC + ALLOW_FIXED only: ');
});

// =============================================================================
section('EXCEPTIONS — never guess');
// =============================================================================

await check('14. MISSING REQUIRED SNAPSHOT INPUT is blocked, not defaulted', async () => {
  const payload = await payloadFor('E-NORM', pJun);
  for (const [field, code] of [
    ['bpjs_rule', calc.CALC_ERROR.MISSING_BPJS_RULE],
    ['jkk', calc.CALC_ERROR.MISSING_JKK],
    ['eligibility', calc.CALC_ERROR.MISSING_ELIGIBILITY],
  ]) {
    const broken = { ...payload, [field]: null };
    const r = calc.calculate(broken);
    eq(r.status, 'BLOCKED', `${field}: `);
    eq(hasError(r, code), true, `${field} error code: `);
    eq(r.totals, null, `${field}: no fabricated totals: `);
  }
  const noStructure = { ...payload, salary_structure: [] };
  eq(hasError(calc.calculate(noStructure), calc.CALC_ERROR.MISSING_SALARY_STRUCTURE), true);
});

await check('a snapshot whose RESOLUTION failed cannot be calculated', async () => {
  await makeEmp('E-NOASSIGN');
  const payload = await payloadFor('E-NOASSIGN', pJun);
  const r = calc.calculate(payload);
  eq(r.status, 'BLOCKED');
  eq(hasError(r, calc.CALC_ERROR.SNAPSHOT_INCOMPLETE), true);
  // the original resolution errors are carried forward, not replaced
  eq(r.errors.some((e) => e.code === resolver.ERROR.MISSING_ASSIGNMENT), true, 'original cause preserved: ');
});

await check('15. INVALID COMPONENT CONFIGURATION is rejected with the offending code', async () => {
  const payload = await payloadFor('E-NORM', pJun);
  const withFloat = { ...payload, salary_structure: payload.salary_structure.map((c, i) => i === 0 ? { ...c, amount_sen: 123.45 } : c) };
  const r1 = calc.calculate(withFloat);
  eq(r1.status, 'BLOCKED');
  eq(hasError(r1, calc.CALC_ERROR.INVALID_COMPONENT), true, 'non-integer amount: ');
  eq(r1.errors[0].detail.includes('BASIC'), true, 'names the component: ');

  const withNegative = { ...payload, salary_structure: payload.salary_structure.map((c, i) => i === 0 ? { ...c, amount_sen: -100 } : c) };
  eq(hasError(calc.calculate(withNegative), calc.CALC_ERROR.INVALID_COMPONENT), true, 'negative amount: ');

  const withBadType = { ...payload, salary_structure: payload.salary_structure.map((c, i) => i === 0 ? { ...c, component_type: 'bonus' } : c) };
  eq(hasError(calc.calculate(withBadType), calc.CALC_ERROR.INVALID_COMPONENT), true, 'unknown type: ');
});

await check('16. NEGATIVE NET PAY is flagged, and the figure is still shown for diagnosis', async () => {
  await makeEmp('E-NEG'); await assign('E-NEG');
  await addComp('E-NEG', cBasic, 3000000);
  await addComp('E-NEG', cLoan, 5000000);      // deduction exceeds gross
  const r = calc.calculate(await payloadFor('E-NEG', pJun));
  eq(r.status, 'BLOCKED');
  eq(hasError(r, calc.CALC_ERROR.NEGATIVE_NET_PAY), true);
  eq(r.totals.net_sen < 0, true, 'the negative figure is exposed, not hidden: ');
});

await check('zero payable days is blocked rather than producing a zero payslip', async () => {
  await makeEmp('E-ZERO', { start: '2026-08-01' }); await assign('E-ZERO', { from: '2026-08-01' });
  await addComp('E-ZERO', cBasic, 5000000, '2026-08-01');
  const r = calc.calculate(await payloadFor('E-ZERO', pJun));
  eq(r.status, 'BLOCKED');
  eq(hasError(r, calc.CALC_ERROR.SNAPSHOT_INCOMPLETE) || hasError(r, calc.CALC_ERROR.ZERO_PAYABLE_DAYS), true);
});

await check('overtime with no matching rule band is flagged, never priced at a default', async () => {
  const payload = await payloadFor('E-OT1', pJun);
  const stripped = { ...payload, overtime_rules: payload.overtime_rules.filter((r) => r.day_type !== 'workday') };
  const r = calc.calculate(stripped);
  eq(r.status, 'BLOCKED');
  eq(hasError(r, calc.CALC_ERROR.MISSING_OVERTIME_RULE), true);
});

// =============================================================================
section('TRACEABILITY & IMMUTABILITY');
// =============================================================================

await check('every trace entry carries the full required breakdown', async () => {
  const r = calc.calculate(await payloadFor('E-OT1', pJun));
  const required = ['component', 'source_snapshot_field', 'rule_version', 'basis', 'quantity', 'rate', 'formula', 'rounding_rule', 'amount'];
  for (const entry of r.trace) {
    for (const key of required) {
      if (!(key in entry)) throw new Error(`trace entry ${entry.component} missing ${key}`);
    }
    eq(entry.rounding_rule, 'half_up_to_sen', `${entry.component} rounding: `);
  }
  // key amounts must be traceable back to a snapshot field
  const bpjsLine = r.trace.find((t) => t.component === 'JHT_EMPLOYEE');
  eq(bpjsLine.source_snapshot_field, 'bpjs_rule.jht_rate_employee_bp');
  eq(bpjsLine.formula, 'base_sen * rate_bp / 10000');
  const taxLine = r.trace.find((t) => t.component === 'PPH21_TER');
  eq(taxLine.source_snapshot_field, 'tax.ter_brackets');
  eq(taxLine.rule_version.startsWith(`rule_set:${rsId}:category:`), true, 'tax rule version: ');
});

await check('18. MASTER DATA CHANGED AFTER SNAPSHOT -> result unchanged', async () => {
  await makeEmp('E-FROZEN'); await assign('E-FROZEN'); await addComp('E-FROZEN', cBasic, 8000000);
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-FROZEN', pJun, { resolvedBy: 'test' }));
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(out.snapshotId);
  const before = calc.calculate(JSON.parse(snap.resolved_payload));

  // Change the world: reprice JKK and raise the salary.
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE jkk_risk_classes SET end_date = '2026-05-31' WHERE risk_class='high' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',300,'2026-06-01')`).run();
    await db.prepare(`UPDATE employee_salary_components SET effective_to='2026-06-30' WHERE employee_id='E-FROZEN' AND effective_to IS NULL`).run();
    await addComp('E-FROZEN', cBasic, 20000000, '2026-07-01');
  });

  const after = calc.calculate(JSON.parse(
    (await db.prepare('SELECT resolved_payload FROM payroll_input_snapshots WHERE id = ?').get(out.snapshotId)).resolved_payload
  ));
  eq(JSON.stringify(after), JSON.stringify(before), 'result changed after master data moved: ');
  eq(after.rule_versions.jkk_rate_bp, 127, 'still the old JKK rate: ');
  eq(rp(after.earnings.total_sen), 8000000, 'still the old salary: ');
  // and a LIVE resolve now genuinely differs, proving the world really moved
  const live = calc.calculate(await payloadFor('E-FROZEN', pJun));
  eq(live.rule_versions.jkk_rate_bp, 300, 'live resolve sees the new rate: ');
});

await check('LEGAL ENTITY ISOLATION: JKK comes from the employee’s own entity', async () => {
  await makeEmp('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra });
  await addComp('E-MITRA', cBasic, 8000000);
  const r = calc.calculate(await payloadFor('E-MITRA', pJunM));
  eq(r.bpjs.jkk.risk_class, 'medium');
  eq(r.bpjs.jkk.rate_bp, 89, 'MITRA rate, not KAHE: ');
  eq(r.bpjs.jkk.employer_sen, money.applyBp(money.rupiahToSen(8000000), 89));
});

// =============================================================================
section('SCALE & NO PERSISTENCE');
// =============================================================================

await check('19. 1,500 EMPLOYEE DRY-RUN BATCH completes and reconciles exactly', async () => {
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code) VALUES (?,?,'internal','active','2026-01-01','PPB')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await insE.run(id, id); await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000));
    }
  });
  await writer.snapshotPeriod(db, pJun, { chunkSize: 200, resolvedBy: 'bulk' });

  const snaps = await db.prepare(`SELECT resolved_payload FROM payroll_input_snapshots WHERE payroll_period_id = ? AND employee_id LIKE 'BULK-%'`).all(pJun);
  eq(snaps.length, 1500, 'snapshots: ');

  let gross = 0, net = 0, ok = 0;
  const lineTotals = [];
  for (const s of snaps) {
    const r = calc.calculate(JSON.parse(s.resolved_payload));
    if (r.status !== 'OK') continue;
    ok += 1; gross += r.totals.gross_sen; net += r.totals.net_sen;
    lineTotals.push(r.totals.net_sen);
  }
  eq(ok, 1500, 'all calculated: ');
  eq(rp(gross), 1500 * 5000000, 'gross reconciles exactly: ');
  // Integer arithmetic: the sum of the lines equals the aggregate, exactly.
  eq(lineTotals.reduce((a, b) => a + b, 0), net, 'line sum equals aggregate: ');
  eq(Number.isInteger(net), true, 'aggregate is integer sen: ');
});

await check('Phase 2C persists NOTHING: the calculator writes no rows', async () => {
  // SUPERSEDED IN PART BY PHASE 2E: the payroll_runs / payroll_run_lines
  // tables now exist, because a result must be stored before it can be
  // approved. What this test guards is unchanged and still the real point:
  // the CALCULATOR itself writes nothing. Running it must leave every
  // persistence table untouched.
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 2H: payment tables now exist. What this
  // test guards is unchanged and is asserted below: this module writes no
  // payment row of its own.
  const paymentRows = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n;
  eq(paymentRows, 0, 'this phase must create no payment record: ');
  eq(tables.includes('payroll_input_snapshots'), true);

  const countRows = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  const before = [await countRows('payroll_runs'), await countRows('payroll_run_lines'), await countRows('payroll_run_line_components')];
  calc.calculate(await payloadFor('E-NORM', pJun));
  calc.calculate(await payloadFor('E-OT1', pJun));
  eq([await countRows('payroll_runs'), await countRows('payroll_run_lines'), await countRows('payroll_run_line_components')], before,
    'calculating must not write any row: ');
});

// =============================================================================
section('20. REGRESSION — all prior phases');
// =============================================================================

await check('all prior invariant indexes still present', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee', 'uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class', 'uq_holiday_national_per_date', 'uq_emp_salary_component_open',
    'uq_salary_component_open_global', 'uq_salary_component_open_scoped', 'uq_work_calendar_open_code',
    'uq_payroll_group_open_code', 'uq_payroll_period_group_cycle', 'uq_payroll_period_group_start',
    'uq_snapshot_period_employee']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('prior canonical libraries behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  const sal = require('../lib/salaryStructure');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq(time.overtimePaySen(4624277, 180, 15000), money.roundHalfUp(4624277 * 3 * 1.5));
  eq((await dc.classifyDay(db, 'E-NORM', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-NORM', '2026-06-15')).eligible, true);
  eq((await sal.getStructureOn(db, 'E-NORM', '2026-06-15')).length, 5);
  eq((await pp.resolvePeriodForDate(db, 'E-NORM', '2026-06-15')).period.id, pJun);
});

// ---- representative calculation traces ---------------------------------------
console.log('\nREPRESENTATIVE CALCULATION TRACE — E-NORM (normal monthly, no overtime)');
console.log(calc.formatTrace(calc.calculate(await payloadFor('E-NORM', pJun))));

console.log('\nREPRESENTATIVE CALCULATION TRACE — E-OT1 (3h workday overtime, progressive bands)');
const otTrace = calc.calculate(await payloadFor('E-OT1', pJun));
console.log(calc.formatTrace(otTrace));

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2C TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
