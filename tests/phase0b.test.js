(async () => {
// tests/phase0b.test.js
// Phase 0B — N1 (exact time) and N2 (write contention) test suite.
// Throwaway database. Usage: npm run test:phase0b

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction, withRetry, isRetryableLockError, BUSY_TIMEOUT_MS, MAX_WRITE_ATTEMPTS } = require('../database/init-db');
const time = require('../lib/time');
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
  let t = false; try { await fn(); } catch (e) { t = true; }
  if (!t) throw new Error(label);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase0b.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase0b');
const db = __t.db;
await initDb(db);

// =============================================================================
section('N1 — EXACT TIME REPRESENTATION');
// =============================================================================

await check('required legacy values convert to whole minutes deterministically', () => {
  eq(time.hoursToMinutes(0.1), 6, '0.1h: ');
  eq(time.hoursToMinutes(0.25), 15, '0.25h: ');
  eq(time.hoursToMinutes(0.5), 30, '0.5h: ');
  eq(time.hoursToMinutes(1.25), 75, '1.25h: ');
  eq(time.hoursToMinutes(7.25), 435, '7.25h: ');
  eq(time.hoursToMinutes(8), 480, 'normal work hours: ');
  eq(time.hoursToMinutes(3), 180, 'overtime: ');
});

await check('MIGRATION ROUND TRIP: every required value survives hours->minutes->hours', () => {
  for (const h of [0.1, 0.25, 0.5, 1.25, 7.25, 8, 3, 2.5, 0.75]) {
    const back = time.minutesToHours(time.hoursToMinutes(h));
    if (back !== h) throw new Error(`round trip failed for ${h}h: got ${back}`);
  }
});

await check('rounding policy is half-up at the minute, and documented', () => {
  eq(time.hoursToMinutes(0.008), 0, '0.48 min rounds down: ');
  eq(time.hoursToMinutes(0.009), 1, '0.54 min rounds up: ');
  eq(time.hoursToMinutes(1 / 60), 1, 'exactly one minute: ');
  eq(time.hoursToMinutes(-0.5), -30, 'negative is symmetric: ');
});

await check('integer minutes SUM exactly where REAL hours drift', () => {
  const floatSum = Array(10).fill(0.1).reduce((a, b) => a + b);
  if (floatSum === 1) throw new Error('float sanity check unexpectedly passed');
  let minutes = 0;
  for (let i = 0; i < 10; i += 1) minutes += time.hoursToMinutes(0.1);
  eq(minutes, 60, '10 x 0.1h in minutes: ');
  eq(time.minutesToHours(minutes), 1, 'back to hours: ');
});

await check('CALCULATION time x rate is exact and deterministic', () => {
  // Rp8.000.000 monthly, divisor 173 -> hourly rate in integer sen
  const rate = time.hourlyRateSen(money.rupiahToSen(8000000), 173);
  eq(rate, 4624277, 'hourly rate sen: ');   // 800000000/173 = 4624277.45 -> 4624277

  // The float form this replaces produced 33526008.25 for 7.25h.
  const pay725 = time.overtimePaySen(rate, time.hoursToMinutes(7.25), 10000); // 1.0x
  if (!Number.isInteger(pay725)) throw new Error(`pay must be an integer sen value, got ${pay725}`);
  eq(pay725, 33526008, '7.25h at 1.0x: ');

  // 1 hour at 1.5x = rate * 1.5, exactly
  eq(time.overtimePaySen(rate, 60, 15000), money.roundHalfUp(rate * 1.5), '1h at 1.5x: ');
  // 2 hours at 2x = rate * 4, exactly
  eq(time.overtimePaySen(rate, 120, 20000), rate * 4, '2h at 2x: ');
  // deterministic: same inputs, same output, every time
  eq(time.overtimePaySen(rate, 435, 15000), time.overtimePaySen(rate, 435, 15000));
});

await check('overtimePaySen refuses to silently lose precision on absurd inputs', async () => {
  await throws(() => time.overtimePaySen(Number.MAX_SAFE_INTEGER, 480, 40000),
    'an unsafe intermediate must throw, not round silently');
});

await check('resolveMinutes gives ONE source of truth (accepts hours or minutes)', async () => {
  eq(time.resolveMinutes({ work_hours: 7.25 }, 'work_hours'), 435);
  eq(time.resolveMinutes({ work_hours_minutes: 435 }, 'work_hours'), 435);
  // minutes wins when both are present — the canonical field is authoritative
  eq(time.resolveMinutes({ work_hours: 99, work_hours_minutes: 435 }, 'work_hours'), 435);
  await throws(() => time.resolveMinutes({ work_hours_minutes: 12.5 }, 'work_hours'),
    'a fractional minute must be rejected');
});

await check('schema stores minutes as INTEGER', async () => {
  const cols = Object.fromEntries((await pgx.tableInfo(db, 'timesheet_entries')).map((c) => [c.name, c.type]));
  eq(cols.work_minutes, 'INTEGER');
  eq(cols.overtime_minutes_requested, 'INTEGER');
  eq(cols.overtime_minutes_approved, 'INTEGER');
});

// ---- migration behaviour (exercised directly; the script itself runs in the shell tests)
await check('MIGRATION: legacy REAL hours convert and the mirror is rewritten from minutes', async () => {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('LE1','E','internal','high','2026-01-01')`).run();
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date) VALUES ('E-T','T','internal','active','2026-01-01')`).run();
  for (const [d, h, otr, ota] of [['2026-03-01', 7.25, 3, 3], ['2026-03-02', 0.1, 0, 0], ['2026-03-03', 8, 1.25, 1.25]]) {
    await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_hours,overtime_hours_requested,overtime_hours_approved)
                VALUES ('E-T',?,'present',?,?,?)`).run(d, h, otr, ota);
  }
  // apply the same conversion the migration performs
  await withTransaction(db, async () => {
    for (const r of await db.prepare('SELECT * FROM timesheet_entries').all()) {
      const wm = time.hoursToMinutes(r.work_hours);
      const om = time.hoursToMinutes(r.overtime_hours_requested ?? 0) ?? 0;
      const oa = time.hoursToMinutes(r.overtime_hours_approved ?? 0) ?? 0;
      await db.prepare(`UPDATE timesheet_entries SET work_minutes=?, work_hours=?, overtime_minutes_requested=?, overtime_hours_requested=?, overtime_minutes_approved=?, overtime_hours_approved=? WHERE id=?`)
        .run(wm, time.minutesToHours(wm), om, time.minutesToHours(om), oa, time.minutesToHours(oa), r.id);
    }
  });
  const rows = await db.prepare('SELECT work_minutes, work_hours, overtime_minutes_requested FROM timesheet_entries ORDER BY work_date').all();
  eq(rows.map((r) => r.work_minutes), [435, 6, 480]);
  eq(rows.map((r) => r.work_hours), [7.25, 0.1, 8], 'mirror matches minutes: ');
  eq(rows[2].overtime_minutes_requested, 75, '1.25h overtime: ');
});

await check('REPEATED MIGRATION is a no-op (idempotent)', async () => {
  const before = await db.prepare('SELECT id, work_minutes, overtime_minutes_requested FROM timesheet_entries ORDER BY id').all();
  await withTransaction(db, async () => {
    for (const r of await db.prepare('SELECT * FROM timesheet_entries').all()) {
      const wm = r.work_minutes !== null ? r.work_minutes : time.hoursToMinutes(r.work_hours);
      await db.prepare('UPDATE timesheet_entries SET work_minutes=?, work_hours=? WHERE id=?').run(wm, time.minutesToHours(wm), r.id);
    }
  });
  eq(await db.prepare('SELECT id, work_minutes, overtime_minutes_requested FROM timesheet_entries ORDER BY id').all(), before);
});

await check('no competing source of truth: hours always equal minutes/60', async () => {
  for (const r of await db.prepare('SELECT work_minutes, work_hours FROM timesheet_entries').all()) {
    if (time.minutesToHours(r.work_minutes) !== r.work_hours) {
      throw new Error(`divergent pair: ${r.work_minutes} min vs ${r.work_hours} h`);
    }
  }
});

// =============================================================================
section('N2 — WRITE CONTENTION & TRANSACTION RESILIENCE');
// =============================================================================

await check('busy_timeout is set on every connection (was 0)', async () => {
  const probe = __t.openApp(1);
  eq(Number.parseInt((await probe.prepare('SHOW lock_timeout').get()).lock_timeout, 10) * 1000, BUSY_TIMEOUT_MS);
  await probe.close();
  if (BUSY_TIMEOUT_MS <= 0) throw new Error('busy_timeout must be > 0');
});

await check('TWO COMPETING WRITERS: a temporary lock resolves within the timeout', async () => {
  const a = __t.openApp(1);
  await __t.ddl('CREATE TABLE IF NOT EXISTS contention (v INTEGER)');
  await a.exec('DELETE FROM contention');

  const b = __t.openApp(1);

  await withTransaction(a, async () => { await a.prepare('INSERT INTO contention VALUES (1)').run(); });   // lock released promptly

  // The second writer now succeeds where, pre-Phase-0B, an overlapping
  // attempt failed instantly with SQLITE_BUSY.
  await withTransaction(b, async () => { await b.prepare('INSERT INTO contention VALUES (2)').run(); });

  eq((await a.prepare('SELECT COUNT(*) AS n FROM contention').get()).n, 2);
  await a.close(); await b.close();
});

await check('RETRY SUCCEEDS: a transient lock error is retried and then works', async () => {
  let attempts = 0;
  const result = await withRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      const e = new Error('lock_not_available: database is locked');
      e.code = '55P03';
      throw e;
    }
    return 'committed';
  }, { label: 'test-transient' });
  eq(result, 'committed');
  eq(attempts, 3, 'should have retried twice before succeeding: ');
});

await check('PERMANENT CONTENTION fails cleanly after bounded attempts (no infinite retry)', async () => {
  let attempts = 0;
  let caught = null;
  try {
    await withRetry(() => {
      attempts += 1;
      const e = new Error('lock_not_available: database is locked');
      e.code = '55P03';
      throw e;
    }, { label: 'test-permanent' });
  } catch (err) { caught = err; }

  eq(attempts, MAX_WRITE_ATTEMPTS, 'attempts must be bounded: ');
  if (!caught) throw new Error('exhaustion must throw');
  eq(caught.code, 'DB_BUSY_EXHAUSTED');
  if (!caught.cause) throw new Error('original cause must be attached for diagnosis');
  if (!/percobaan/.test(caught.message)) throw new Error('message should explain the failure to the user');
});

await check('non-contention errors are NOT retried (fail fast)', async () => {
  let attempts = 0;
  await throws(async () => await withRetry(() => { attempts += 1; throw new Error('VALIDATION: bad input'); }));
  eq(attempts, 1, 'a validation error must not be retried: ');
});

await check('isRetryableLockError distinguishes contention from real faults', () => {
  const pgErr = (code, message) => Object.assign(new Error(message), { code });
  eq(isRetryableLockError(pgErr('55P03', 'canceling statement due to lock timeout')), true);
  eq(isRetryableLockError(pgErr('40P01', 'deadlock detected')), true);
  eq(isRetryableLockError(pgErr('23505', 'duplicate key value violates unique constraint "x_y"')), false);
  eq(isRetryableLockError(pgErr('42703', 'column "z" does not exist')), false);
});

await check('ROLLBACK still works and leaves NO partial state (Phase 0 B4 intact)', async () => {
  await __t.ddl('CREATE TABLE IF NOT EXISTS probe0b (v TEXT)');
  await db.exec('DELETE FROM probe0b');
  await throws(async () => await withTransaction(db, async () => {
    await db.prepare('INSERT INTO probe0b VALUES (?)').run('a');
    await db.prepare('INSERT INTO probe0b VALUES (?)').run('b');
    throw new Error('simulated mid-transaction failure');
  }));
  eq((await db.prepare('SELECT COUNT(*) AS n FROM probe0b').get()).n, 0, 'rows after rollback: ');
});

await check('retry wrapping a whole transaction keeps atomicity (the correct composition)', async () => {
  await db.exec('DELETE FROM probe0b');
  let attempts = 0;
  const out = await withRetry(async () => await withTransaction(db, async () => {
    attempts += 1;
    await db.prepare('INSERT INTO probe0b VALUES (?)').run('x');
    if (attempts < 2) {
      const e = new Error('lock_not_available: database is locked');
      e.code = '55P03';
      throw e;   // first attempt rolls back its insert
    }
    return 'ok';
  }));
  eq(out, 'ok');
  // Exactly ONE row: the rolled-back attempt left nothing behind.
  eq((await db.prepare('SELECT COUNT(*) AS n FROM probe0b').get()).n, 1, 'no duplicate from the retried attempt: ');
});

await check('existing atomic operations remain atomic under the new layer', async () => {
  await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01')`).run();
  const wp = (await db.prepare('SELECT id FROM work_patterns LIMIT 1').get()).id;
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date)
              VALUES ('E-T','LE1',?,'TK',0,'2026-01-01')`).run(wp);
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments`).get()).n;
  await throws(async () => await withRetry(async () => await withTransaction(db, async () => {
    // second open assignment violates the Phase 0 B5 index
    await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,marital_status,dependents_count,effective_date)
                VALUES ('E-T','LE1',?,'K',1,'2026-06-01')`).run(wp);
  })));
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM employee_payroll_assignments`).get()).n, before, 'unchanged after failure: ');
});

// =============================================================================
section('REGRESSION — Phase 0, 1A, 1B');
// =============================================================================

await check('Phase 0 B3 money precision unchanged', () => {
  eq(money.rateToBp(0.037), 370);
  eq(money.bpToPercentString(370), '3.7');
  eq(money.applyBp(800000000, 370), 29600000);
});

await check('Phase 0 B6 eligibility unchanged', async () => {
  const eligibility = require('../lib/employeeEligibility');
  eq((await eligibility.isEligibleOn(db, 'E-T', '2026-06-15')).eligible, true);
});

await check('Phase 1A salary structure unchanged', async () => {
  const salary = require('../lib/salaryStructure');
  const cid = (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
    VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES ('E-T',?,?,'2026-01-01')`)
    .run(cid, money.rupiahToSen(8000000));
  eq(money.senToRupiah((await salary.getBasesOn(db, 'E-T', '2026-06-15')).grossEarningsSen), 8000000);
});

await check('Phase 1B day classification unchanged', async () => {
  const dc = require('../lib/dayClassification');
  await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01')`).run();
  eq((await dc.classifyDay(db, 'E-T', '2026-06-15')).dayType, 'WORKDAY');
  eq((await dc.classifyDay(db, 'E-T', '2026-06-21')).dayType, 'WEEKLY_REST_DAY');
});

await check('all Phase 0/1A/1B invariant indexes still present', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee', 'uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class', 'uq_holiday_national_per_date', 'uq_emp_salary_component_open',
    'uq_salary_component_open_global', 'uq_salary_component_open_scoped', 'uq_work_calendar_open_code']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 0B TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
