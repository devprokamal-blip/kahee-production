(async () => {
// tests/phase0.test.js
// Phase 0 remediation test suite — B3 (money precision), B4 (transaction
// safety), B5 (database-enforced invariants), B6 (employee eligibility).
//
// Runs against a THROWAWAY database file so it can never touch real data.
// Usage: npm run test:phase0

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const money = require('../lib/money');
const eligibility = require('../lib/employeeEligibility');

// ---- tiny assertion harness (no external test dependency) -------------------
let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}expected ${e}, got ${a}`);
}
async function throws(fn, label = 'expected a throw') {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(label);
}
function section(title) { console.log(`\n${title}`); }

// ---- throwaway database -----------------------------------------------------
const TEST_DB = path.join(__dirname, 'phase0.test.db');
for (const suffix of ['', '-shm', '-wal']) {
  const f = TEST_DB + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
const __t = await createTestDatabase('phase0');
const db = __t.db;
await require('../database/init-db').initDb(db);

// Local copy of withTransaction bound to this test handle.
const { withTransaction } = require('../database/init-db');

// =============================================================================
section('B3 — MONETARY PRECISION');
// =============================================================================

await check('rupiah -> sen is exact for whole rupiah', () => {
  eq(money.rupiahToSen(8000000), 800000000);
  eq(money.rupiahToSen(10547400), 1054740000);
});

await check('rate -> basis points is exact for every statutory rate in use', () => {
  eq(money.rateToBp(0.0024), 24);
  eq(money.rateToBp(0.0127), 127);
  eq(money.rateToBp(0.037), 370);   // the rate that produced 3.6999999999999996
  eq(money.rateToBp(0.003), 30);
  eq(money.rateToBp(0.0025), 25);
});

await check('bp -> percent string has no float artifact (the original bug)', () => {
  // Before Phase 0: (0.037 * 100) === 3.6999999999999996
  eq(money.bpToPercentString(370), '3.7');
  eq(money.bpToPercentString(400), '4');
  eq(money.bpToPercentString(24), '0.24');
  eq(money.bpToPercentString(127), '1.27');
});

await check('applyBp stays in integer space and rounds exactly once', () => {
  // Rp8,000,000 x 3.7% = Rp296,000 exactly
  eq(money.applyBp(800000000, 370), 29600000);
  eq(money.senToRupiah(money.applyBp(800000000, 370)), 296000);
  // Rp8,000,000 x 1.27% (JKK high) = Rp101,600 exactly
  eq(money.applyBp(800000000, 127), 10160000);
});

await check('roundHalfUp is symmetric for negatives (Math.round is not)', () => {
  eq(money.roundHalfUp(2.5), 3);
  eq(money.roundHalfUp(-2.5), -3);   // Math.round(-2.5) === -2
  eq(money.roundHalfUp(2.4), 2);
});

await check('integer sen addition reconciles exactly where float does not', () => {
  // The float failure mode this replaces: 0.1 + 0.2 !== 0.3
  const floatSum = 0.1 + 0.2;
  if (floatSum === 0.3) throw new Error('float sanity check unexpectedly passed');
  // Integer sen: 10 + 20 === 30, exactly, always.
  eq(10 + 20, 30);
  // 1000 payslip lines of Rp1,234.56 must sum exactly.
  const lineSen = money.rupiahToSen(1234.56);
  let total = 0;
  for (let i = 0; i < 1000; i += 1) total += lineSen;
  eq(total, 123456000);
  eq(money.senToRupiah(total), 1234560);
});

await check('schema stores money/rates as INTEGER, not REAL', async () => {
  const cols = async (table) => Object.fromEntries(
    (await pgx.tableInfo(db, table)).map((c) => [c.name, c.type])
  );
  const rs = await cols('payroll_rule_sets');
  eq(rs.jht_rate_company_bp, 'INTEGER', 'payroll_rule_sets.jht_rate_company_bp: ');
  eq(rs.jp_salary_cap_sen, 'INTEGER', 'payroll_rule_sets.jp_salary_cap_sen: ');
  eq((await cols('ptkp_ter_rates')).income_min_sen, 'INTEGER');
  eq((await cols('ptkp_ter_rates')).rate_bp, 'INTEGER');
  eq((await cols('overtime_multiplier_rules')).multiplier_bp, 'INTEGER');
  eq((await cols('employee_payroll_assignments')).base_salary_sen, 'INTEGER');
  eq((await cols('jkk_risk_classes')).rate_bp, 'INTEGER');
  eq((await cols('employees')).daily_rate_sen, 'INTEGER');
});

// =============================================================================
section('B4 — TRANSACTION SAFETY');
// =============================================================================

await __t.ddl(`CREATE TABLE IF NOT EXISTS _tx_probe (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v TEXT)`);

await check('successful transaction commits every statement', async () => {
  await db.exec('DELETE FROM _tx_probe');
  await withTransaction(db, async () => {
    await db.prepare('INSERT INTO _tx_probe (v) VALUES (?)').run('a');
    await db.prepare('INSERT INTO _tx_probe (v) VALUES (?)').run('b');
  });
  eq((await db.prepare('SELECT COUNT(*) AS n FROM _tx_probe').get()).n, 2);
});

await check('DELIBERATE ROLLBACK: a mid-transaction throw undoes earlier writes', async () => {
  await db.exec('DELETE FROM _tx_probe');
  await throws(async () => {
    await withTransaction(db, async () => {
      await db.prepare('INSERT INTO _tx_probe (v) VALUES (?)').run('first');
      await db.prepare('INSERT INTO _tx_probe (v) VALUES (?)').run('second');
      throw new Error('simulated failure partway through');
    });
  }, 'withTransaction should re-throw');
  // The critical assertion: NO partial state survived.
  eq((await db.prepare('SELECT COUNT(*) AS n FROM _tx_probe').get()).n, 0, 'rows after rollback: ');
});

await check('DELIBERATE ROLLBACK: a failing constraint rolls back a real payroll write', async () => {
  // Seed one legal entity + work pattern + employee to assign against.
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('LE1','Entity One','internal','high','2026-01-01') ON CONFLICT DO NOTHING`).run();
  await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01')`).run();
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date) VALUES ('E-TX','TX Probe','internal','active','2026-01-01')`).run();
  const wp = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;

  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,base_salary_sen,effective_date) VALUES ('E-TX','LE1',?,'TK',0,100000000,'2026-01-01')`).run(wp);
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments WHERE employee_id='E-TX'`).get()).n;

  // Attempt a supersession that violates the B5 index halfway through.
  await throws(async () => {
    await withTransaction(db, async () => {
      // Deliberately DO NOT close the current row, then open a second one.
      await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,base_salary_sen,effective_date) VALUES ('E-TX','LE1',?,'TK',0,200000000,'2026-06-01')`).run(wp);
    });
  }, 'second open assignment should violate the unique index');

  const after = (await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments WHERE employee_id='E-TX'`).get()).n;
  eq(after, before, 'assignment count must be unchanged after rollback: ');
});

// =============================================================================
section('B5 — DATABASE-ENFORCED INVARIANTS');
// =============================================================================

await check('all four Phase 0 indexes exist', async () => {
  // Asserts PRESENCE, not exclusivity — later phases legitimately add more
  // uq_* indexes (Phase 1A adds three for salary components).
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const required of [
    'uq_holiday_national_per_date',
    'uq_jkk_open_per_risk_class',
    'uq_payroll_assignment_open_per_employee',
    'uq_payroll_rule_set_single_active',
  ]) {
    if (!names.includes(required)) throw new Error(`missing Phase 0 index: ${required}`);
  }
});

await check('DUPLICATE ASSIGNMENT: a second open assignment is rejected by the DB', async () => {
  const wp = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date) VALUES ('E-DUP','Dup Probe','internal','active','2026-01-01')`).run();
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date) VALUES ('E-DUP','LE1',?,'TK',0,'2026-01-01')`).run(wp);
  await throws(async () => {
    await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date) VALUES ('E-DUP','LE1',?,'K',1,'2026-03-01')`).run(wp);
  }, 'two open assignments for one employee must be impossible');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments WHERE employee_id='E-DUP' AND end_date IS NULL`).get()).n, 1);
});

await check('proper supersession still works (close then open)', async () => {
  const wp = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE employee_payroll_assignments SET end_date = kahe_date_add('2026-03-01'::date, -1) WHERE employee_id='E-DUP' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date) VALUES ('E-DUP','LE1',?,'K',1,'2026-03-01')`).run(wp);
  });
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments WHERE employee_id='E-DUP'`).get()).n, 2, 'history preserved: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments WHERE employee_id='E-DUP' AND end_date IS NULL`).get()).n, 1, 'exactly one open: ');
});

await check('DUPLICATE HOLIDAY: a second national holiday on one date is rejected', async () => {
  await db.prepare(`INSERT INTO holidays (date,name,scope) VALUES ('2026-08-17','Hari Kemerdekaan RI','national')`).run();
  await throws(async () => {
    await db.prepare(`INSERT INTO holidays (date,name,scope) VALUES ('2026-08-17','Duplicate Entry','national')`).run();
  }, 'duplicate national holiday must be impossible (was ALLOWED before Phase 0)');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM holidays WHERE date='2026-08-17' AND scope='national'`).get()).n, 1);
});

await check('two active rule sets are rejected', async () => {
  const insert = async (name, status, eff) => await db.prepare(`
    INSERT INTO payroll_rule_sets (name,status,effective_date,
      bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
      jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,
      jkm_rate_bp,overtime_hourly_divisor)
    VALUES (?,?,?,100,400,1200000000,200,370,100,200,1054740000,30,173)`).run(name, status, eff);
  await insert('RS Active', 'active', '2026-01-01');
  await throws(async () => await insert('RS Second Active', 'active', '2027-01-01'), 'two active rule sets must be impossible');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_rule_sets WHERE status='active'`).get()).n, 1);
});

await check('two open versions of one JKK risk class are rejected', async () => {
  await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();
  await throws(async () => {
    await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',95,'2027-01-01')`).run();
  }, 'two open JKK versions for one class must be impossible');
});

// =============================================================================
section('B6 — EMPLOYEE ELIGIBILITY (single source of truth)');
// =============================================================================

const wpId = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;
async function makeEmployee(id, fields = {}) {
  const f = { worker_type: 'internal', status: 'active', start_date: '2026-01-01', termination_date: null, contract_start: null, contract_end: null, ...fields };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,contract_start,contract_end)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, id, f.worker_type, f.status, f.start_date, f.termination_date, f.contract_start, f.contract_end);
}
async function assign(id, effectiveDate = '2026-01-01') {
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,base_salary_sen,effective_date)
              VALUES (?,'LE1',?,'TK',0,800000000,?)`).run(id, wpId, effectiveDate);
}

await check('a normal active employee is eligible mid-period', async () => {
  await makeEmployee('E-NORMAL'); await assign('E-NORMAL');
  const r = await eligibility.isEligibleOn(db, 'E-NORMAL', '2026-06-15');
  eq(r.eligible, true);
  eq(r.reason, null);
});

await check('JOINER boundary: not eligible the day before start, eligible on start day', async () => {
  await makeEmployee('E-JOINER', { start_date: '2026-06-10' }); await assign('E-JOINER', '2026-06-10');
  eq((await eligibility.isEligibleOn(db, 'E-JOINER', '2026-06-09')).eligible, false, 'day before start: ');
  eq((await eligibility.isEligibleOn(db, 'E-JOINER', '2026-06-09')).reason, eligibility.INELIGIBLE.NOT_STARTED);
  eq((await eligibility.isEligibleOn(db, 'E-JOINER', '2026-06-10')).eligible, true, 'on start day: ');
});

await check('LEAVER boundary: eligible ON the termination date, not the day after', async () => {
  await makeEmployee('E-LEAVER', { termination_date: '2026-06-20', status: 'inactive' }); await assign('E-LEAVER');
  eq((await eligibility.isEligibleOn(db, 'E-LEAVER', '2026-06-20')).eligible, true, 'on last day: ');
  eq((await eligibility.isEligibleOn(db, 'E-LEAVER', '2026-06-21')).eligible, false, 'day after: ');
  eq((await eligibility.isEligibleOn(db, 'E-LEAVER', '2026-06-21')).reason, eligibility.INELIGIBLE.TERMINATED);
});

await check('inactive WITHOUT a termination date is not payable', async () => {
  await makeEmployee('E-INACTIVE', { status: 'inactive' }); await assign('E-INACTIVE');
  const r = await eligibility.isEligibleOn(db, 'E-INACTIVE', '2026-06-15');
  eq(r.eligible, false);
  eq(r.reason, eligibility.INELIGIBLE.INACTIVE);
});

await check('PKWT outside its contract window is not payable', async () => {
  await makeEmployee('E-PKWT', { worker_type: 'pkwt', contract_start: '2026-02-01', contract_end: '2026-05-31' });
  await assign('E-PKWT');
  eq((await eligibility.isEligibleOn(db, 'E-PKWT', '2026-03-15')).eligible, true, 'inside window: ');
  eq((await eligibility.isEligibleOn(db, 'E-PKWT', '2026-06-01')).eligible, false, 'after contract end: ');
  eq((await eligibility.isEligibleOn(db, 'E-PKWT', '2026-06-01')).reason, eligibility.INELIGIBLE.CONTRACT_NOT_COVERING);
});

await check('an employee with no payroll assignment is not payable', async () => {
  await makeEmployee('E-NOASSIGN');
  const r = await eligibility.isEligibleOn(db, 'E-NOASSIGN', '2026-06-15');
  eq(r.eligible, false);
  eq(r.reason, eligibility.INELIGIBLE.NO_PAYROLL_ASSIGNMENT);
});

await check('an unknown employee id returns NOT_FOUND, never a crash', async () => {
  eq((await eligibility.isEligibleOn(db, 'E-DOES-NOT-EXIST', '2026-06-15')).reason, eligibility.INELIGIBLE.NOT_FOUND);
});

await check('period view: joiner mid-June is payable for 21 of 30 days', async () => {
  const r = await eligibility.getEligibilityForPeriod(db, 'E-JOINER', '2026-06-01', '2026-06-30');
  eq(r.totalDays, 30);
  eq(r.payableDays, 21);            // 10 June .. 30 June inclusive
  eq(r.segments.length, 1);
  eq(r.segments[0].from, '2026-06-10');
  eq(r.segments[0].to, '2026-06-30');
});

await check('period view: leaver mid-June is payable for 20 of 30 days', async () => {
  const r = await eligibility.getEligibilityForPeriod(db, 'E-LEAVER', '2026-06-01', '2026-06-30');
  eq(r.payableDays, 20);            // 1 June .. 20 June inclusive
  eq(r.segments[0].to, '2026-06-20');
});

await check('period view: a mid-period assignment change produces TWO segments', async () => {
  await makeEmployee('E-CHANGE'); await assign('E-CHANGE', '2026-01-01');
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE employee_payroll_assignments SET end_date='2026-06-14' WHERE employee_id='E-CHANGE' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,base_salary_sen,effective_date)
                VALUES ('E-CHANGE','LE1',?,'K',2,1200000000,'2026-06-15')`).run(wpId);
  });
  const r = await eligibility.getEligibilityForPeriod(db, 'E-CHANGE', '2026-06-01', '2026-06-30');
  eq(r.payableDays, 30, 'still payable every day: ');
  eq(r.segments.length, 2, 'segment count: ');
  eq(r.segments[0].days, 14);
  eq(r.segments[1].days, 16);
  eq(r.segments[0].assignment.base_salary_sen, 800000000);
  eq(r.segments[1].assignment.base_salary_sen, 1200000000);
});

await check('period view: a fully ineligible employee reports zero payable days with a reason', async () => {
  const r = await eligibility.getEligibilityForPeriod(db, 'E-NOASSIGN', '2026-06-01', '2026-06-30');
  eq(r.payableDays, 0);
  eq(r.segments.length, 0);
  eq(r.ineligibleReasons, [eligibility.INELIGIBLE.NO_PAYROLL_ASSIGNMENT]);
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const suffix of ['', '-shm', '-wal']) {
  const f = TEST_DB + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 0 TESTS: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
}
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
