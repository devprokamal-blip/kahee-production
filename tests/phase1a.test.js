(async () => {
// tests/phase1a.test.js
// Phase 1A — Salary Components (B1) test suite.
// Runs against a THROWAWAY database. Usage: npm run test:phase1a

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const salary = require('../lib/salaryStructure');
const money = require('../lib/money');

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
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(label);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase1a.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase1a');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('LE1','Entity One','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('LE2','Mitra Jaya','subkontraktor','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01')`).run();
const wpId = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;

async function makeEmployee(id) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date) VALUES (?,?,'internal','active','2026-01-01')`).run(id, id);
}
async function makeComponent(code, overrides = {}) {
  const f = {
    name: code, component_type: 'earning', calculation_type: 'fixed', paid_by: 'employee',
    is_taxable: 1, is_bpjs_base: 0, is_overtime_base: 0, is_proratable: 1,
    recurrence: 'recurring', legal_entity_id: null, calculation_order: 100,
    effective_from: '2026-01-01', ...overrides,
  };
  const info = await db.prepare(`
    INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,
      is_overtime_base,is_proratable,recurrence,legal_entity_id,calculation_order,effective_from,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'test') RETURNING id
  `).run(code, f.name, f.component_type, f.calculation_type, f.paid_by, f.is_taxable, f.is_bpjs_base,
    f.is_overtime_base, f.is_proratable, f.recurrence, f.legal_entity_id, f.calculation_order, f.effective_from);
  return info.lastInsertRowid;
}
async function assignComponent(employeeId, componentId, amountRupiah, from, to = null) {
  return (await db.prepare(`
    INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to,created_by)
    VALUES (?,?,?,?,?,'test') RETURNING id
  `).run(employeeId, componentId, money.rupiahToSen(amountRupiah), from, to)).lastInsertRowid;
}

// =============================================================================
section('COMPONENT MASTER — classification & flags');
// =============================================================================

const cBasic = await makeComponent('BASIC', { is_bpjs_base: 1, is_overtime_base: 1, calculation_order: 10 });
const cFixed = await makeComponent('ALLOW_FIXED', { is_bpjs_base: 1, is_overtime_base: 1, calculation_order: 20 });
const cSite = await makeComponent('ALLOW_SITE', { calculation_order: 30 });
const cMeal = await makeComponent('ALLOW_MEAL', { calculation_type: 'variable', is_taxable: 0, calculation_order: 40 });
const cLoan = await makeComponent('DED_LOAN', { component_type: 'deduction', is_taxable: 0, calculation_order: 200 });
const cEmployerBpjs = await makeComponent('ER_BPJS', { paid_by: 'employer', is_taxable: 0, calculation_order: 300 });

await check('component master stores every required classification field', async () => {
  const c = await db.prepare('SELECT * FROM salary_components WHERE id = ?').get(cBasic);
  eq(c.code, 'BASIC'); eq(c.component_type, 'earning'); eq(c.calculation_type, 'fixed');
  eq(c.paid_by, 'employee'); eq(c.is_taxable, 1); eq(c.is_bpjs_base, 1);
  eq(c.is_overtime_base, 1); eq(c.is_proratable, 1); eq(c.recurrence, 'recurring');
  eq(c.calculation_order, 10); eq(c.status, 'active'); eq(c.effective_to, null);
});

await check('invalid classification values are rejected by CHECK constraints', async () => {
  await throws(async () => await makeComponent('BAD1', { component_type: 'bonus' }), 'invalid component_type must be rejected');
  await throws(async () => await makeComponent('BAD2', { paid_by: 'government' }), 'invalid paid_by must be rejected');
  await throws(async () => await makeComponent('BAD3', { recurrence: 'weekly' }), 'invalid recurrence must be rejected');
});

await check('DUPLICATE COMPONENT: a second open version of one global code is rejected', async () => {
  await throws(async () => await makeComponent('BASIC'), 'two open global BASIC versions must be impossible');
});

await check('the same code IS allowed once per legal entity scope', async () => {
  const scoped = await makeComponent('BASIC', { legal_entity_id: 'LE2', name: 'Gaji Pokok Mitra' });
  eq(typeof scoped, 'number');
  await throws(async () => await makeComponent('BASIC', { legal_entity_id: 'LE2' }), 'two open LE2-scoped BASIC versions must be impossible');
});

// =============================================================================
section('COMPONENT MASTER — versioning & history');
// =============================================================================

await check('revising a component closes the old version and opens a new one', async () => {
  const before = await db.prepare('SELECT * FROM salary_components WHERE id = ?').get(cSite);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE salary_components SET effective_to = kahe_date_add('2026-07-01'::date, -1), status='superseded' WHERE id = ?`).run(cSite);
    await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,
      is_overtime_base,is_proratable,recurrence,legal_entity_id,calculation_order,effective_from,created_by)
      VALUES ('ALLOW_SITE','Tunjangan Lokasi (rev)','earning','fixed','employee',1,1,0,1,'recurring',NULL,30,'2026-07-01','test')`).run();
  });
  const versions = await db.prepare("SELECT * FROM salary_components WHERE code='ALLOW_SITE' AND legal_entity_id IS NULL ORDER BY effective_from").all();
  eq(versions.length, 2, 'version count: ');
  eq(versions[0].effective_to, '2026-06-30', 'old version closed: ');
  eq(versions[0].status, 'superseded');
  eq(versions[1].effective_to, null, 'new version open: ');
  eq(before.is_bpjs_base, 0, 'old flag preserved: ');
  eq(versions[1].is_bpjs_base, 1, 'new flag applied: ');
});

await check('resolver returns the version in force on the asked-for date, not the latest', async () => {
  eq((await salary.getComponentOn(db, cSite, '2026-03-15')).is_bpjs_base, 0, 'March uses old version: ');
  const julyVersion = (await db.prepare("SELECT id FROM salary_components WHERE code='ALLOW_SITE' AND effective_from='2026-07-01'").get()).id;
  eq((await salary.getComponentOn(db, julyVersion, '2026-08-15')).is_bpjs_base, 1, 'August uses new version: ');
});

// =============================================================================
section('EMPLOYEE SALARY STRUCTURE — the B1 goal');
// =============================================================================

await makeEmployee('E-A');
await assignComponent('E-A', cBasic, 8000000, '2026-01-01');
await assignComponent('E-A', cFixed, 1500000, '2026-01-01');
await assignComponent('E-A', cMeal, 600000, '2026-01-01');
await assignComponent('E-A', cLoan, 500000, '2026-01-01');
await assignComponent('E-A', cEmployerBpjs, 296000, '2026-01-01');

await check('one employee holds multiple components, ordered by calculation_order', async () => {
  const rows = await salary.getStructureOn(db, 'E-A', '2026-03-15');
  eq(rows.map((r) => r.code), ['BASIC', 'ALLOW_FIXED', 'ALLOW_MEAL', 'DED_LOAN', 'ER_BPJS']);
});

await check('derived bases come from per-component FLAGS, not hardcoded assumptions', async () => {
  const b = await salary.getBasesOn(db, 'E-A', '2026-03-15');
  // employee-side earnings: 8.000.000 + 1.500.000 + 600.000
  eq(money.senToRupiah(b.grossEarningsSen), 10100000, 'gross: ');
  // taxable excludes ALLOW_MEAL (is_taxable = 0)
  eq(money.senToRupiah(b.taxableBaseSen), 9500000, 'taxable: ');
  // BPJS base = only components flagged is_bpjs_base
  eq(money.senToRupiah(b.bpjsBaseSen), 9500000, 'bpjs base: ');
  eq(money.senToRupiah(b.overtimeBaseSen), 9500000, 'overtime base: ');
  eq(money.senToRupiah(b.employeeDeductionsSen), 500000, 'deductions: ');
  // employer-side never touches the employee's gross
  eq(money.senToRupiah(b.employerCostSen), 296000, 'employer cost: ');
});

await check('all amounts are integer sen (Phase 0 B3 preserved)', async () => {
  const rows = await db.prepare('SELECT amount_sen FROM employee_salary_components').all();
  for (const r of rows) {
    if (!Number.isInteger(r.amount_sen)) throw new Error(`non-integer amount_sen: ${r.amount_sen}`);
  }
  eq((await pgx.tableInfo(db, 'employee_salary_components')).find((c) => c.name === 'amount_sen').type, 'INTEGER');
});

// =============================================================================
section('EFFECTIVE DATING & MID-PERIOD CHANGE');
// =============================================================================

await check('MID-PERIOD CHANGE: closing + reopening leaves history intact', async () => {
  const openRow = await db.prepare("SELECT * FROM employee_salary_components WHERE employee_id='E-A' AND component_id=? AND effective_to IS NULL").get(cBasic);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE employee_salary_components SET effective_to = kahe_date_add('2026-06-15'::date, -1) WHERE id = ?`).run(openRow.id);
    await assignComponent('E-A', cBasic, 9500000, '2026-06-15');
  });
  eq(money.senToRupiah((await salary.getBasesOn(db, 'E-A', '2026-06-14')).grossEarningsSen), 10100000, 'before change: ');
  eq(money.senToRupiah((await salary.getBasesOn(db, 'E-A', '2026-06-15')).grossEarningsSen), 11600000, 'on change date: ');
});

await check('HISTORICAL PAYROLL UNCHANGED: an old date still resolves the old amount', async () => {
  const basicInMarch = (await salary.getStructureOn(db, 'E-A', '2026-03-15')).find((c) => c.code === 'BASIC');
  eq(money.senToRupiah(basicInMarch.amount_sen), 8000000, 'March BASIC must still be 8.000.000: ');
  const basicInJuly = (await salary.getStructureOn(db, 'E-A', '2026-07-15')).find((c) => c.code === 'BASIC');
  eq(money.senToRupiah(basicInJuly.amount_sen), 9500000, 'July BASIC: ');
});

await check('segments: a mid-period raise splits June into TWO segments', async () => {
  const segs = await salary.getStructureSegments(db, 'E-A', '2026-06-01', '2026-06-30');
  eq(segs.length, 2, 'segment count: ');
  eq(segs[0].days, 14, 'segment 1 days (1-14 June): ');
  eq(segs[1].days, 16, 'segment 2 days (15-30 June): ');
  eq(money.senToRupiah(segs[0].bases.grossEarningsSen), 10100000);
  eq(money.senToRupiah(segs[1].bases.grossEarningsSen), 11600000);
});

await check('a month with no change yields exactly ONE segment', async () => {
  const segs = await salary.getStructureSegments(db, 'E-A', '2026-08-01', '2026-08-31');
  eq(segs.length, 1);
  eq(segs[0].days, 31);
});

await check('an ended allowance stops appearing after effective_to', async () => {
  await makeEmployee('E-END');
  await assignComponent('E-END', cBasic, 5000000, '2026-01-01');
  await assignComponent('E-END', cMeal, 400000, '2026-01-01', '2026-04-30');
  eq((await salary.getStructureOn(db, 'E-END', '2026-04-30')).length, 2, 'on last day: ');
  eq((await salary.getStructureOn(db, 'E-END', '2026-05-01')).length, 1, 'day after: ');
  eq(money.senToRupiah((await salary.getBasesOn(db, 'E-END', '2026-05-01')).grossEarningsSen), 5000000);
});

// =============================================================================
section('DUPLICATE & OVERLAP PREVENTION');
// =============================================================================

await check('DUPLICATE ASSIGNMENT: a second open row for the same component is rejected by the DB', async () => {
  await makeEmployee('E-DUP');
  await assignComponent('E-DUP', cBasic, 5000000, '2026-01-01');
  await throws(async () => await assignComponent('E-DUP', cBasic, 7000000, '2026-03-01'),
    'two open rows of one component for one employee must be impossible');
  eq((await db.prepare("SELECT COUNT(*) AS n FROM employee_salary_components WHERE employee_id='E-DUP' AND component_id=? AND effective_to IS NULL").get(cBasic)).n, 1);
});

await check('OVERLAP: a closed range overlapping an existing one is detected', async () => {
  await makeEmployee('E-OVL');
  await assignComponent('E-OVL', cFixed, 1000000, '2026-01-01', '2026-06-30');
  // overlaps the existing Jan-Jun window
  const clash = await salary.findOverlappingAssignment(db, 'E-OVL', cFixed, '2026-05-01', '2026-08-31');
  if (!clash) throw new Error('overlapping closed range should have been detected');
  // adjacent, non-overlapping window is fine
  eq(await salary.findOverlappingAssignment(db, 'E-OVL', cFixed, '2026-07-01', '2026-12-31'), null, 'adjacent range: ');
});

await check('OVERLAP: an open-ended row is treated as extending forever', async () => {
  await makeEmployee('E-OPEN');
  await assignComponent('E-OPEN', cSite, 750000, '2026-01-01'); // open-ended
  const clash = await salary.findOverlappingAssignment(db, 'E-OPEN', cSite, '2027-01-01', '2027-12-31');
  if (!clash) throw new Error('an open-ended row must block a later range');
});

await check('TRANSACTION SAFETY: a failed mid-period change rolls back cleanly', async () => {
  await makeEmployee('E-TX2');
  await assignComponent('E-TX2', cBasic, 6000000, '2026-01-01');
  const before = (await db.prepare("SELECT COUNT(*) AS n FROM employee_salary_components WHERE employee_id='E-TX2'").get()).n;
  await throws(async () => {
    await withTransaction(db, async () => {
      // deliberately DO NOT close the open row, then open a second one
      await assignComponent('E-TX2', cBasic, 7000000, '2026-06-01');
    });
  }, 'duplicate open row should violate the index');
  eq((await db.prepare("SELECT COUNT(*) AS n FROM employee_salary_components WHERE employee_id='E-TX2'").get()).n, before,
    'row count unchanged after rollback: ');
});

// =============================================================================
section('MIGRATION — base_salary_sen backfill');
// =============================================================================

await check('legacy base_salary_sen is backfilled into a BASIC component with the same window', async () => {
  await makeEmployee('E-LEGACY');
  await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,base_salary_sen,effective_date)
    VALUES ('E-LEGACY','LE1',?, 'TK',0,?, '2026-01-01')`).run(wpId, money.rupiahToSen(7250000));

  // Inline replication of migrate-phase1a's backfill step (the script itself
  // is exercised end-to-end against a real database in the shell test run).
  const basic = await db.prepare("SELECT * FROM salary_components WHERE code='BASIC' AND legal_entity_id IS NULL AND effective_to IS NULL").get();
  const a = await db.prepare("SELECT * FROM employee_payroll_assignments WHERE employee_id='E-LEGACY'").get();
  await withTransaction(db, async () => {
    await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to,note,created_by)
                VALUES (?,?,?,?,?,'backfill','migrate_phase1a')`)
      .run(a.employee_id, basic.id, a.base_salary_sen, a.effective_date, a.end_date);
  });

  const bases = await salary.getBasesOn(db, 'E-LEGACY', '2026-03-15');
  eq(money.senToRupiah(bases.grossEarningsSen), 7250000, 'component resolves the same money: ');
  // backward compatibility: the original field is untouched
  eq((await db.prepare("SELECT base_salary_sen FROM employee_payroll_assignments WHERE employee_id='E-LEGACY'").get()).base_salary_sen,
    money.rupiahToSen(7250000), 'base_salary_sen retained: ');
});

// =============================================================================
section('REGRESSION — Phase 0 guarantees still hold');
// =============================================================================

await check('Phase 0 B5 indexes still present alongside the new Phase 1A ones', async () => {
  // Asserts PRESENCE, not exclusivity — later phases legitimately add more
  // uq_* indexes (Phase 1B adds uq_work_calendar_open_code).
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const required of [
    'uq_emp_salary_component_open',
    'uq_holiday_national_per_date',
    'uq_jkk_open_per_risk_class',
    'uq_payroll_assignment_open_per_employee',
    'uq_payroll_rule_set_single_active',
    'uq_salary_component_open_global',
    'uq_salary_component_open_scoped',
  ]) {
    if (!names.includes(required)) throw new Error(`missing index: ${required}`);
  }
});

await check('Phase 0 B6 eligibility still works and is unaffected by components', async () => {
  const eligibility = require('../lib/employeeEligibility');
  await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date)
    VALUES ('E-A','LE1',?, 'TK',0,'2026-01-01')`).run(wpId);
  eq((await eligibility.isEligibleOn(db, 'E-A', '2026-03-15')).eligible, true);
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 1A TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
