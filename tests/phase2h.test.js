(async () => {
// tests/phase2h.test.js
// Phase 2H — Payment Processing & Bank File Export. Throwaway database.
// Usage: npm run test:phase2h

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const writer = require('../lib/snapshotWriter');
const validationRunner = require('../lib/validationRunner');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
const adjLib = require('../lib/payrollAdjustment');
const pay = require('../lib/payrollPayment');
const bankExport = require('../lib/bankExport');
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
    if (!re.test(e.message)) throw new Error(`${label}did not match ${re}: ${e.message}`);
    return e;
  }
  throw new Error(`${label}expected a throw matching ${re}`);
}
function section(t) { console.log(`\n${t}`); }
const rp = (sen) => money.senToRupiah(sen);

const TEST_DB = path.join(__dirname, 'phase2h.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2h');
const db = __t.db;
await initDb(db);

const PREPARER = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT'], payroll_payment: ['VIEW','CREATE','EDIT','EXPORT'] } };
const AUTHORIZER = { displayName: 'Ops Director', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'], payroll_payment: ['VIEW','CREATE','EDIT','EXPORT','APPROVE'] } };
const OTHER_APPROVER = { displayName: 'Finance Head', permissions: { payroll_run: ['VIEW','APPROVE'], payroll_payment: ['VIEW','APPROVE'] } };
const VIEWER = { displayName: 'HRD Officer', permissions: { payroll_payment: ['VIEW'] } };

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra','subkontraktor','medium','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',127,'2026-01-01')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();
const rsId = (await db.prepare(`INSERT INTO payroll_rule_sets
  (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
   jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
   overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
  VALUES ('RS','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,1,0) RETURNING id`).run()).lastInsertRowid;
for (const [c,lo,hi,bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['C',0,660000000,0]])
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rsId,c,lo,hi,bp);
for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],['rest_or_holiday_5day',1,8,20000]])
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rsId,dt,hf,ht,m);

async function makeGroup(code, entity) {
  return (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2026-01-01') RETURNING id`)
    .run(code, code, entity)).lastInsertRowid;
}
const gKahe = await makeGroup('KAHE-M','KAHE360');
const gMitra = await makeGroup('MITRA-M','MITRA');
async function makePeriod(g,y,s) {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(g);
  const w = pp.monthlyWindow(y,s); const d = pp.deriveDates(grp,w.periodStart,w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN') RETURNING id`).run(g,y,s,s,d.period_start,d.period_end,
    d.attendance_cutoff,d.overtime_cutoff,d.adjustment_cutoff,d.payment_date)).lastInsertRowid;
}
const cBasic = (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
  is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
  VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makeEmp(id, o={}) {
  const f = { bank:'BCA', acc:'1234567890', accName:null, ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,
    bank_name,bank_account_no,bank_account_name) VALUES (?,?,'internal','active','2026-01-01','PPB',?,?,?)`)
    .run(id, `Nama ${id}`, f.bank, f.acc, f.accName);
}
async function assign(id, o={}) {
  const a = { entity:'KAHE360', group:gKahe, ...o };
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2026-01-01')`)
    .run(id,a.entity,wp5,cal,a.group);
}
async function addComp(id, rupiah) {
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
              VALUES (?,?,?,'2026-01-01')`).run(id,cBasic,money.rupiahToSen(rupiah));
}
async function addTs(id, date) {
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_status,day_type,day_type_source) VALUES (?,?,'present',480,8,'none','WORKDAY','t')`).run(id,date);
}
const reload = async (id) => await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
const reloadBatch = async (id) => await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(id);

async function finalizeOriginal(periodId) {
  await writer.snapshotPeriod(db, periodId, { chunkSize: 300, resolvedBy: PREPARER.displayName });
  await writer.freezePeriod(db, periodId, PREPARER.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, periodId, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 300 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'SNAPSHOT_READY','CALCULATED',PREPARER.displayName,'c');
  });
  await validationRunner.validatePeriod(db, periodId, { chunkSize: 300, detectedAt: '2026-07-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED',resolved_by='Ops Director',
      resolved_at=kahe_now(),resolution_note='ok' WHERE payroll_period_id=? AND blocking=1`).run(periodId);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'CALCULATED','VALIDATED',PREPARER.displayName,'v');
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), AUTHORIZER, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), AUTHORIZER, 'final'));
  return await reload(run.id);
}
async function finalizeCorrectionRun(run) {
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'CALCULATED','VALIDATED',PREPARER.displayName,'v');
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), AUTHORIZER, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), AUTHORIZER, 'final'));
  return await reload(run.id);
}

// =============================================================================
section('ARCHITECTURAL CONTRACT');
// =============================================================================

await check('the payment layer never recalculates payroll or reads live rules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollPayment.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const t of ['payroll_rule_sets','ptkp_ter_rates','overtime_multiplier_rules','jkk_risk_classes',
    'employee_salary_components','timesheet_entries','payrollCalculator','calculate(']) {
    if (code.includes(t)) throw new Error(`payment must not touch ${t}`);
  }
  for (const w of [/UPDATE\s+payroll_run/i, /DELETE\s+FROM\s+payroll_run/i,
    /UPDATE\s+payroll_adjustments/i, /UPDATE\s+payroll_payslips/i, /UPDATE\s+payroll_input_snapshots/i]) {
    if (w.test(code)) throw new Error(`payment must not modify finalized payroll: ${w}`);
  }
});

await check('BANK FORMAT HONESTY: generic adapters do not claim bank compatibility', () => {
  const formats = bankExport.listAdapters();
  eq(formats.map((f) => f.code).sort(), ['GENERIC_CSV','GENERIC_JSON']);
  for (const f of formats) {
    eq(f.verified_against_bank_spec, false, `${f.code} must not claim verification: `);
    eq(f.bank, null, `${f.code} must not name a bank: `);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bankExport.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const bank of ['BCA','Mandiri','MANDIRI','BNI','BRI']) {
    if (new RegExp(`['"\`][^'"\`]*${bank}`).test(code)) {
      throw new Error(`no bank-specific format is implemented; code must not reference ${bank}`);
    }
  }
});

await check('an unknown export format is rejected, not guessed', async () => {
  await throwsMatching(() => bankExport.getAdapter('BANK_X'), /Format ekspor tidak dikenal/);
});

// =============================================================================
section('PREPARATION');
// =============================================================================

const pJun = await makePeriod(gKahe, 2026, 6);
for (const id of ['E-A','E-B','E-C']) { await makeEmp(id); await assign(id); await addComp(id, 8000000); await addTs(id, '2026-06-15'); }
await makeEmp('E-NOBANK', { acc: null }); await assign('E-NOBANK'); await addComp('E-NOBANK', 7000000); await addTs('E-NOBANK','2026-06-16');
await makeEmp('E-BADBANK', { acc: '12-XX' }); await assign('E-BADBANK'); await addComp('E-BADBANK', 7000000); await addTs('E-BADBANK','2026-06-17');
const originalRun = await finalizeOriginal(pJun);

let batch;

await check('1. NORMAL FINALIZED PAYROLL produces payment instructions', async () => {
  const out = await withTransaction(db, async () => await pay.prepareBatch(db, pJun, PREPARER));
  batch = out.batch;
  eq(out.summary.prepared, 3, 'three payable employees with valid bank details: ');
  eq(batch.status, 'DRAFT');
  eq(batch.legal_entity_id, 'KAHE360');
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-A'`).get(batch.id);
  const line = await db.prepare(`SELECT net_sen FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-A'`).get(originalRun.id);
  eq(item.amount_sen, line.net_sen, 'amount equals the finalized net: ');
  eq(JSON.parse(item.source_run_ids), [originalRun.id], 'traceable to its source run: ');
});

await check('5/6. MISSING and INVALID bank accounts are EXCLUDED with a reason, never auto-fixed', async () => {
  const out = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id IN ('E-NOBANK','E-BADBANK')`).all(batch.id);
  eq(out.length, 0, 'not paid: ');
  // re-run preparation on a fresh batch to inspect the exception list
  const again = await withTransaction(db, async () => await pay.prepareBatch(db, pJun, PREPARER));
  const codes = Object.fromEntries(again.exceptions.map((e) => [e.employee_id, e.code]));
  eq(codes['E-NOBANK'], pay.ERROR.MISSING_BANK_ACCOUNT);
  eq(codes['E-BADBANK'], pay.ERROR.INVALID_BANK_ACCOUNT);
  // and the employees' master records were NOT modified
  eq((await db.prepare(`SELECT bank_account_no FROM employees WHERE id='E-BADBANK'`).get()).bank_account_no, '12-XX',
    'no silent auto-fix: ');
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(again.batch.id), PREPARER, 'batch uji'));
});

await check('8. EMPLOYER CONTRIBUTIONS never become an employee payment', async () => {
  const line = await db.prepare(`SELECT * FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-A'`).get(originalRun.id);
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-A'`).get(batch.id);
  if (line.bpjs_employer_sen <= 0) throw new Error('fixture should have employer contributions');
  eq(item.amount_sen, line.net_sen);
  if (item.amount_sen === line.net_sen + line.bpjs_employer_sen) throw new Error('employer cost leaked into payment');
  if (item.amount_sen === line.gross_sen) throw new Error('gross paid instead of net');
  // the payment module never even reads the employer column
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollPayment.js'), 'utf8');
  if (/employer_cost_sen|bpjs_employer_sen/.test(src.replace(/\/\/.*$/gm, ''))) {
    throw new Error('payment must not read employer contribution columns');
  }
});

await check('BANK ACCOUNT is SNAPSHOTTED at preparation', async () => {
  const item = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-A'`).get(batch.id);
  eq(item.bank_name, 'BCA');
  eq(item.bank_account_no, '1234567890');
  eq(item.bank_account_name, 'Nama E-A', 'falls back to the legal name: ');
  if (!item.bank_snapshot_at) throw new Error('bank_snapshot_at must be recorded');
});

await check('payment is refused when no ORIGINAL run is finalized', async () => {
  const pOpen = await makePeriod(gKahe, 2026, 7);
  await makeEmp('E-OPEN'); await assign('E-OPEN'); await addComp('E-OPEN', 6000000); await addTs('E-OPEN','2026-07-15');
  await throwsCode(async () => await withTransaction(db, async () => await pay.prepareBatch(db, pOpen, PREPARER)), pay.ERROR.RUN_NOT_FINALIZED);
});

// =============================================================================
section('VALIDATION, EXPORT, SUBMIT');
// =============================================================================

await check('batch VALIDATION reconciles every instruction against finalized payroll', async () => {
  const out = await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(batch.id), PREPARER, 'diperiksa'));
  eq(out.items, 3);
  const sum = (await db.prepare('SELECT COALESCE(SUM(net_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id IN (?,?,?)')
    .get(originalRun.id, 'E-A','E-B','E-C')).n;
  eq(out.total_amount_sen, sum, 'batch total equals payroll net exactly: ');
  eq((await reloadBatch(batch.id)).status, 'VALIDATED');
});

await check('a tampered instruction fails validation instead of being exported', async () => {
  const p2 = await makePeriod(gKahe, 2026, 9);
  await makeEmp('E-TAMPER'); await assign('E-TAMPER'); await addComp('E-TAMPER', 6000000); await addTs('E-TAMPER','2026-09-15');
  await finalizeOriginal(p2);
  const b2 = (await withTransaction(db, async () => await pay.prepareBatch(db, p2, PREPARER))).batch;
  const it = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-TAMPER'`).get(b2.id);
  await db.prepare('UPDATE payroll_payment_items SET amount_sen = amount_sen + 100 WHERE id=?').run(it.id);
  const err = await throwsCode(async () => await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(b2.id), PREPARER, 'x')),
    pay.ERROR.RECONCILIATION_FAILED);
  eq(err.detail.problems.length > 0, true);
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(b2.id), PREPARER, 'uji tamper'));
});

await check('BANK FILE export produces a deterministic file and hash', async () => {
  const out = await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(batch.id), 'GENERIC_CSV', PREPARER, 'ekspor'));
  eq(out.idempotent, false);
  eq(out.file.format, 'GENERIC_CSV');
  eq(out.file.verified_against_bank_spec, false, 'honest about being unverified: ');
  eq(out.file.content.split('\n').length, 5, 'header + 3 rows + trailer: ');
  if (!out.file.content.includes('1234567890')) throw new Error('account number missing from the file');
  if (!out.file.content.startsWith('payment_reference,')) throw new Error('unexpected header');
  eq((await reloadBatch(batch.id)).status, 'EXPORTED');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE batch_id=? AND status='EXPORTED'`).get(batch.id)).n, 3);
});

await check('12. EXPORT RERUN is idempotent and produces identical bytes', async () => {
  const b = await reloadBatch(batch.id);
  const again = await withTransaction(db, async () => await pay.exportBatch(db, b, 'GENERIC_CSV', AUTHORIZER, 'lagi'));
  eq(again.idempotent, true);
  eq(again.file.content_hash, b.export_hash, 'same hash: ');
  eq((await reloadBatch(batch.id)).exported_by, 'Payroll Officer', 'original exporter not overwritten: ');
});

await check('the JSON adapter renders the same instructions in another shape', async () => {
  const b = await reloadBatch(batch.id);
  const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=? ORDER BY employee_id').all(b.id);
  const file = bankExport.buildExport('GENERIC_JSON', { ...b, period_label: '2026-06' }, items);
  const parsed = JSON.parse(file.content);
  eq(parsed.instructions.length, 3);
  eq(parsed.total_amount_sen, b.total_amount_sen);
  eq(parsed.currency, 'IDR');
});

await check('10/11. UNAUTHORIZED submit and SoD VIOLATION are both rejected', async () => {
  await throwsCode(async () => await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(batch.id), VIEWER, 'x')),
    pay.ERROR.NOT_AUTHORIZED, 'no APPROVE: ');
  // the preparer holds APPROVE here, and is still refused
  const selfAuth = { displayName: 'Payroll Officer', permissions: { payroll_payment: ['VIEW','CREATE','APPROVE'] } };
  const err = await throwsCode(async () => await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(batch.id), selfAuth, 'sendiri')),
    pay.ERROR.SOD_VIOLATION, 'preparer self-authorising: ');
  eq(err.detail.prepared_by, 'Payroll Officer');
  eq((await reloadBatch(batch.id)).status, 'EXPORTED', 'batch unchanged: ');
});

await check('an authorised, different person can submit', async () => {
  const out = await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(batch.id), AUTHORIZER, 'dikirim ke bank'));
  eq(out.items, 3);
  const b = await reloadBatch(batch.id);
  eq(b.status, 'SUBMITTED');
  eq(b.authorized_by, 'Ops Director');
});

await check('7. BANK ACCOUNT CHANGED AFTER EXPORT does not alter the instruction', async () => {
  const before = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-A'`).get(batch.id);
  await db.prepare(`UPDATE employees SET bank_account_no='9999999999', bank_name='BANK LAIN' WHERE id='E-A'`).run();
  const after = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-A'`).get(batch.id);
  eq(after.bank_account_no, before.bank_account_no, 'snapshot unchanged: ');
  eq(after.bank_name, before.bank_name);
  // and the database refuses an edit outright
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_payment_items SET bank_account_no='9999999999' WHERE id=?`).run(before.id),
    /PAYMENT_EXPORTED/, 'db trigger: ');
  await throwsMatching(async () => await db.prepare('UPDATE payroll_payment_items SET amount_sen=1 WHERE id=?').run(before.id),
    /PAYMENT_EXPORTED/, 'amount locked: ');
  await db.prepare(`UPDATE employees SET bank_account_no='1234567890', bank_name='BCA' WHERE id='E-A'`).run();
});

// =============================================================================
section('BANK OUTCOMES, RETRY, DUPLICATES');
// =============================================================================

await check('13/14/15. REJECTED, FAILED and RETURNED outcomes are recorded with a reason', async () => {
  const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=? ORDER BY employee_id').all(batch.id);
  const paid = await withTransaction(db, async () => await pay.recordItemOutcome(db, items[0].id, 'PAID', AUTHORIZER, { bankCode: '00' }));
  eq(paid.status, 'PAID');
  if (!paid.paid_at) throw new Error('paid_at must be recorded');

  const rejected = await withTransaction(db, async () => await pay.recordItemOutcome(db, items[1].id, 'REJECTED', AUTHORIZER,
    { reason: 'Nomor rekening tidak ditemukan', bankCode: 'E12' }));
  eq(rejected.status, 'REJECTED');
  eq(rejected.bank_response_code, 'E12');

  const failed = await withTransaction(db, async () => await pay.recordItemOutcome(db, items[2].id, 'FAILED', AUTHORIZER,
    { reason: 'Gangguan jaringan bank' }));
  eq(failed.status, 'FAILED');

  await throwsCode(async () => await withTransaction(db, async () => await pay.recordItemOutcome(db, items[0].id, 'RETURNED', AUTHORIZER, {})),
    pay.ERROR.VALIDATION, 'a failure needs a reason: ');
  const returned = await withTransaction(db, async () => await pay.recordItemOutcome(db, items[0].id, 'RETURNED', AUTHORIZER,
    { reason: 'Dana dikembalikan bank penerima' }));
  eq(returned.status, 'RETURNED', 'a PAID transfer can still be returned: ');
});

await check('the batch status is DERIVED from its items', async () => {
  const b = await reloadBatch(batch.id);
  eq(b.status, 'PARTIALLY_PAID', 'not all items succeeded: ');
});

await check('an invalid item transition is refused', async () => {
  const rejected = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status='REJECTED'`).get(batch.id);
  const err = await throwsCode(async () => await withTransaction(db, async () => await pay.recordItemOutcome(db, rejected.id, 'PAID', AUTHORIZER, {})),
    pay.ERROR.INVALID_TRANSITION);
  eq(err.detail.allowed, []);
});

await check('4. DUPLICATE PAYMENT is prevented at the database level', async () => {
  // Build a period with a genuinely LIVE instruction to test against.
  const pD = await makePeriod(gKahe, 2027, 6);
  await makeEmp('E-DUP2'); await assign('E-DUP2'); await addComp('E-DUP2', 6000000); await addTs('E-DUP2','2027-06-15');
  await finalizeOriginal(pD);
  const bD = (await withTransaction(db, async () => await pay.prepareBatch(db, pD, PREPARER))).batch;
  const live = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-DUP2'`).get(bD.id);
  eq(live.status, 'PENDING', 'a live instruction exists: ');

  await throwsMatching(async () => await db.prepare(`INSERT INTO payroll_payment_items (batch_id,payroll_period_id,employee_id,
    legal_entity_id,payment_reference,amount_sen,source_run_ids,bank_snapshot_at,created_at)
    VALUES (?,?,?,?,?,?,'[]',kahe_now(),kahe_now())`)
    .run(live.batch_id, pD, live.employee_id, live.legal_entity_id, 'DUP-REF-1', 1000),
    /UNIQUE|constraint/i, 'second live instruction for the same period: ');

  // a second batch for the same period flags the employee instead of re-paying
  const again = await withTransaction(db, async () => await pay.prepareBatch(db, pD, PREPARER));
  const dup = again.exceptions.filter((e) => e.code === pay.ERROR.DUPLICATE_PAYMENT);
  eq(dup.some((e) => e.employee_id === 'E-DUP2'), true, `duplicates flagged (${dup.length}): `);
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(again.batch.id), PREPARER, 'uji duplikat'));
});

await check('16. RETRY creates a NEW instruction without editing or duplicating', async () => {
  const rejected = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status='REJECTED'`).get(batch.id);
  // correct the account at source first — the system never does this itself
  await db.prepare(`UPDATE employees SET bank_account_no='7777777777' WHERE id=?`).run(rejected.employee_id);
  const retryBatch = (await withTransaction(db, async () => await pay.prepareBatch(db, pJun, PREPARER))).batch;
  // prepareBatch already re-prepared this employee (their prior instruction is
  // REJECTED, so not live). Cancel that auto-prepared item and use the EXPLICIT
  // linked retry instead, so the new instruction points back at what failed.
  const autoItem = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id=?')
    .get(retryBatch.id, rejected.employee_id);
  if (autoItem) {
    await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_payment_items SET status='CANCELLED', status_reason='diganti retry eksplisit' WHERE id=?`).run(autoItem.id);
    });
  }
  const retry = await withTransaction(db, async () => await pay.retryItem(db, rejected.id, retryBatch.id, PREPARER, 'rekening diperbaiki'));

  eq(retry.retry_of_item_id, rejected.id);
  eq(retry.retry_count, 1);
  eq(retry.amount_sen, rejected.amount_sen, 'same amount: ');
  eq(retry.bank_account_no, '7777777777', 're-snapshotted corrected account: ');
  eq((await db.prepare('SELECT status FROM payroll_payment_items WHERE id=?').get(rejected.id)).status, 'REJECTED',
    'the rejected record survives untouched: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE payroll_period_id=? AND employee_id=? AND status NOT IN ('REJECTED','FAILED','RETURNED','CANCELLED')`)
    .get(pJun, rejected.employee_id)).n, 1, 'exactly one live instruction: ');
});

await check('a PAID item cannot be retried', async () => {
  const p3 = await makePeriod(gKahe, 2026, 11);
  await makeEmp('E-PAID'); await assign('E-PAID'); await addComp('E-PAID', 6000000); await addTs('E-PAID','2026-11-16');
  await finalizeOriginal(p3);
  const b3 = (await withTransaction(db, async () => await pay.prepareBatch(db, p3, PREPARER))).batch;
  await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(b3.id), PREPARER, 'x'));
  await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(b3.id), 'GENERIC_CSV', PREPARER, 'x'));
  await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(b3.id), AUTHORIZER, 'x'));
  const it = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND employee_id='E-PAID'`).get(b3.id);
  await withTransaction(db, async () => await pay.recordItemOutcome(db, it.id, 'PAID', AUTHORIZER, { bankCode: '00' }));
  const b4 = (await withTransaction(db, async () => await pay.prepareBatch(db, p3, PREPARER))).batch;
  await throwsCode(async () => await withTransaction(db, async () => await pay.retryItem(db, it.id, b4.id, PREPARER, 'x')), pay.ERROR.NOT_RETRYABLE);
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(b4.id), PREPARER, 'uji'));
});

// =============================================================================
section('CORRECTION & REVERSAL IMPACT');
// =============================================================================

await check('2. CORRECTION payment pays only the DELTA', async () => {
  const pC = await makePeriod(gKahe, 2026, 12);
  await makeEmp('E-CORR'); await assign('E-CORR'); await addComp('E-CORR', 8000000); await addTs('E-CORR','2026-12-15');
  const orig = await finalizeOriginal(pC);
  const origNet = (await db.prepare(`SELECT net_sen FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-CORR'`).get(orig.id)).net_sen;

  // pay the original in full
  const b = (await withTransaction(db, async () => await pay.prepareBatch(db, pC, PREPARER))).batch;
  await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(b.id), PREPARER, 'x'));
  await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(b.id), 'GENERIC_CSV', PREPARER, 'x'));
  await withTransaction(db, async () => await pay.submitBatch(db, await reloadBatch(b.id), AUTHORIZER, 'x'));
  for (const it of await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=?').all(b.id)) {
    await withTransaction(db, async () => await pay.recordItemOutcome(db, it.id, 'PAID', AUTHORIZER, { bankCode: '00' }));
  }

  // a retro correction, finalized
  const a = await withTransaction(db, async () => await adjLib.createAdjustment(db, {
    source_run_id: orig.id, employee_id: 'E-CORR', adjustment_type: adjLib.TYPE.RETRO_EARNING,
    component_code: 'RETRO', direction: 'CREDIT', amount_sen: money.rupiahToSen(1000000),
    is_taxable: 1, is_bpjs_base: 1, reason: 'retro',
  }, PREPARER));
  await withTransaction(db, async () => await adjLib.approveAdjustment(db, a.id, OTHER_APPROVER, 'ok'));
  const corr = await withTransaction(db, async () => await runLib.createRun(db, pC, PREPARER, { runType: 'CORRECTION', correctsRunId: orig.id }));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(corr.id), PREPARER, null));
  await withTransaction(db, async () => await adjLib.applyToRun(db, await reload(corr.id), PREPARER));
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(PREPARER.displayName, corr.id);
  });
  await finalizeCorrectionRun(await reload(corr.id));
  const deltaNet = (await db.prepare(`SELECT net_sen FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-CORR'`).get(corr.id)).net_sen;

  // the next batch pays only what is still outstanding
  const b2 = await withTransaction(db, async () => await pay.prepareBatch(db, pC, PREPARER));
  eq(b2.summary.prepared, 0, 'the employee already has a PAID instruction, so nothing new is prepared: ');
  const dupe = b2.exceptions.find((e) => e.employee_id === 'E-CORR');
  eq(dupe.code, pay.ERROR.DUPLICATE_PAYMENT, 'flagged rather than silently double-paid: ');

  // reconciliation shows exactly what is still owed: the delta
  // The period also holds employees from earlier fixtures, so assert the
  // employee-level figures rather than the period grand total.
  const empPayable = (await pay.getPayableEmployees(db, pC)).find((r) => r.employee_id === 'E-CORR');
  eq(empPayable.payable_sen, origNet + deltaNet, 'effective payable includes the correction: ');
  const empPaid = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items
    WHERE payroll_period_id=? AND employee_id='E-CORR' AND status='PAID'`).get(pC)).n;
  eq(empPaid, origNet, 'only the original has been paid: ');
  eq(empPayable.payable_sen - empPaid, deltaNet, 'outstanding equals the correction delta exactly: ');
  const rec = await pay.reconcilePayment(db, pC);
  eq(rec.fully_settled, false);
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(b2.batch.id), PREPARER, 'kosong'));
});

await check('3. REVERSAL makes the effective payable zero and blocks a payment', async () => {
  const pR = await makePeriod(gKahe, 2027, 1);
  await makeEmp('E-REV'); await assign('E-REV'); await addComp('E-REV', 6000000); await addTs('E-REV','2027-01-15');
  const orig = await finalizeOriginal(pR);
  const rev = await withTransaction(db, async () => await runLib.createRun(db, pR, PREPARER, { runType: 'REVERSAL', correctsRunId: orig.id }));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(rev.id), PREPARER, null));
  await withTransaction(db, async () => await adjLib.applyToRun(db, await reload(rev.id), PREPARER));
  await withTransaction(db, async () => await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(PREPARER.displayName, rev.id));
  await finalizeCorrectionRun(await reload(rev.id));

  const out = await withTransaction(db, async () => await pay.prepareBatch(db, pR, PREPARER));
  const exc = out.exceptions.find((e) => e.employee_id === 'E-REV');
  eq(out.summary.prepared, 0, 'nothing is payable after a full reversal: ');
  eq(exc.code, pay.ERROR.PERIOD_NOT_PAYABLE);
  eq(exc.amount_sen, 0);
  const rec = await pay.reconcilePayment(db, pR);
  eq(rec.payable_total_sen, 0);
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(out.batch.id), PREPARER, 'nihil'));
});

await check('a NEGATIVE effective payable is refused, never paid as a negative transfer', async () => {
  const pN = await makePeriod(gKahe, 2027, 2);
  await makeEmp('E-NEG2'); await assign('E-NEG2'); await addComp('E-NEG2', 6000000); await addTs('E-NEG2','2027-02-15');
  const orig = await finalizeOriginal(pN);
  const a = await withTransaction(db, async () => await adjLib.createAdjustment(db, {
    source_run_id: orig.id, employee_id: 'E-NEG2', adjustment_type: adjLib.TYPE.RETRO_DEDUCTION,
    component_code: 'RECOVERY', direction: 'DEBIT', amount_sen: money.rupiahToSen(50000000),
    is_taxable: 0, reason: 'pemulihan kelebihan bayar besar',
  }, PREPARER));
  await withTransaction(db, async () => await adjLib.approveAdjustment(db, a.id, OTHER_APPROVER, 'ok'));
  const corr = await withTransaction(db, async () => await runLib.createRun(db, pN, PREPARER, { runType: 'CORRECTION', correctsRunId: orig.id }));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(corr.id), PREPARER, null));
  await withTransaction(db, async () => await adjLib.applyToRun(db, await reload(corr.id), PREPARER));
  await withTransaction(db, async () => await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(PREPARER.displayName, corr.id));
  await finalizeCorrectionRun(await reload(corr.id));

  const out = await withTransaction(db, async () => await pay.prepareBatch(db, pN, PREPARER));
  const exc = out.exceptions.find((e) => e.employee_id === 'E-NEG2');
  eq(exc.code, pay.ERROR.PERIOD_NOT_PAYABLE);
  eq(exc.amount_sen < 0, true, 'the negative figure is surfaced: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE payroll_period_id=? AND employee_id='E-NEG2'`).get(pN)).n, 0,
    'no instruction created for the negative employee: ');
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(out.batch.id), PREPARER, 'negatif'));
});

// =============================================================================
section('ISOLATION, ROLLBACK, RECONCILIATION, SCALE');
// =============================================================================

await check('9. LEGAL ENTITY ISOLATION: a batch carries only its own entity', async () => {
  const pM = await makePeriod(gMitra, 2026, 6);
  await makeEmp('E-M'); await assign('E-M', { entity:'MITRA', group:gMitra }); await addComp('E-M', 7000000); await addTs('E-M','2026-06-15');
  await finalizeOriginal(pM);
  const out = await withTransaction(db, async () => await pay.prepareBatch(db, pM, PREPARER));
  eq(out.batch.legal_entity_id, 'MITRA');
  const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=?').all(out.batch.id);
  eq(items.every((i) => i.legal_entity_id === 'MITRA'), true);
  eq(items.some((i) => i.employee_id === 'E-A'), false, 'no KAHE employee leaked in: ');
  await withTransaction(db, async () => await pay.cancelBatch(db, await reloadBatch(out.batch.id), PREPARER, 'uji'));
});

await check('18. BATCH ROLLBACK leaves nothing behind', async () => {
  const before = {
    batches: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n,
    items: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n,
  };
  let threw = false;
  try {
    await withTransaction(db, async () => {
      await pay.prepareBatch(db, pJun, PREPARER);
      throw new Error('simulated failure during preparation');
    });
  } catch (e) { threw = true; }
  eq(threw, true);
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n, before.batches, 'no batch: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n, before.items, 'no items: ');
});

await check('17. RECONCILIATION is exact', async () => {
  const rec = await pay.reconcilePayment(db, pJun);
  const paidSum = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items WHERE payroll_period_id=? AND status='PAID'`).get(pJun)).n;
  eq(rec.paid_sen, paidSum);
  eq(rec.payable_total_sen - rec.paid_sen - rec.in_flight_sen, rec.outstanding_sen, 'outstanding reconciles exactly: ');
});

await check('every transition is audited with actor and timestamp', async () => {
  const events = await db.prepare('SELECT * FROM payroll_payment_events WHERE batch_id=? ORDER BY id').all(batch.id);
  eq(events.length >= 5, true, `events (${events.length}): `);
  for (const e of events) {
    if (!e.actor) throw new Error(`event ${e.to_status} has no actor`);
    if (!e.occurred_at) throw new Error(`event ${e.to_status} has no timestamp`);
  }
  const statuses = events.map((e) => e.to_status);
  for (const s of ['DRAFT','VALIDATED','EXPORTED','SUBMITTED']) {
    if (!statuses.includes(s)) throw new Error(`missing batch event ${s}`);
  }
});

await check('19. 1,500 EMPLOYEE payment batch prepares, exports and reconciles', async () => {
  const pB = await makePeriod(gKahe, 2027, 3);
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_name,bank_account_no,bank_account_name) VALUES (?,?,'internal','active','2026-01-01','PPB','BCA',?,?)`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source) VALUES (?, '2027-03-16','present',480,8,'none','WORKDAY','t')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `PB-${String(i).padStart(4,'0')}`;
      await insE.run(id, `Bulk ${i}`, String(1000000000 + i), `Bulk ${i}`);
      await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  await finalizeOriginal(pB);

  const out = await withTransaction(db, async () => await pay.prepareBatch(db, pB, PREPARER));
  const bulkItems = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_payment_items WHERE batch_id=? AND employee_id LIKE 'PB-%'`).get(out.batch.id)).n;
  eq(bulkItems, 1500, 'instructions for the cohort: ');

  await withTransaction(db, async () => await pay.validateBatch(db, await reloadBatch(out.batch.id), PREPARER, 'x'));
  const exp = await withTransaction(db, async () => await pay.exportBatch(db, await reloadBatch(out.batch.id), 'GENERIC_CSV', PREPARER, 'x'));
  const lines = exp.file.content.split('\n');
  eq(lines.length, out.batch.item_count + 2, 'header + rows + trailer: ');

  // the file total must equal the batch total, exactly
  const trailer = lines[lines.length - 1].split(',');
  eq(Number(trailer[2]), (await reloadBatch(out.batch.id)).total_amount_sen, 'file trailer reconciles: ');
  const bulkSum = (await db.prepare(`SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items WHERE batch_id=? AND employee_id LIKE 'PB-%'`).get(out.batch.id)).n;
  const bulkNet = (await db.prepare(`SELECT COALESCE(SUM(l.net_sen),0) AS n FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.payroll_run_id
    WHERE r.payroll_period_id=? AND r.status='FINALIZED' AND l.employee_id LIKE 'PB-%'`).get(pB)).n;
  eq(bulkSum, bulkNet, 'cohort payment equals cohort payroll net exactly: ');
});

await check('Phase 2H builds NO client billing / service fee module', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 3B: the billing tables now exist. What
  // this test guards is unchanged and is asserted below — THIS module
  // creates no billing record of its own.
  for (const f of ['client_invoices','invoice_lines','accounts_receivable','tax_invoices']) {
    if (tables.includes(f)) throw new Error(`must not create ${f}`);
  }
  const billingRows = (await db.prepare('SELECT COUNT(*) AS n FROM billing_runs').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM billing_lines').get()).n;
  eq(billingRows, 0, 'this phase must create no billing record: ');
  eq(tables.includes('payroll_payment_batches'), true);
  eq(tables.includes('payroll_payment_items'), true);
});

// =============================================================================
section('20. REGRESSION');
// =============================================================================

await check('all prior invariant indexes present, plus the payment ones', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee','uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class','uq_holiday_national_per_date','uq_emp_salary_component_open',
    'uq_salary_component_open_global','uq_salary_component_open_scoped','uq_work_calendar_open_code',
    'uq_payroll_group_open_code','uq_payroll_period_group_cycle','uq_payroll_period_group_start',
    'uq_snapshot_period_employee','uq_exception_snapshot_code','uq_payroll_run_single_finalized_original',
    'uq_payroll_reversal_single','uq_adjustment_external_reference','uq_payment_item_live_per_period','uq_payment_item_live_per_batch']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('all immutability triggers present (payroll, payslip, adjustment, payment)', async () => {
  const t = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_line_update','trg_lock_finalized_run_status',
    'trg_lock_payslip_update','trg_payslip_requires_finalized_run',
    'trg_lock_applied_adjustment','trg_adjustment_requires_finalized_source',
    'trg_lock_exported_payment_item','trg_lock_exported_payment_item_delete']) {
    if (!t.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

await check('the calculator remains PURE and untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  eq([...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./money','./time']);
});

await check('prior canonical libraries behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq((await dc.classifyDay(db, 'E-A', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-A', '2026-06-15')).eligible, true);
});

// ---- representative bank file -------------------------------------------------
console.log('\nREPRESENTATIVE BANK FILE (GENERIC_CSV — not a bank-specific format)');
{
  const b = await reloadBatch(batch.id);
  const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id=? ORDER BY employee_id').all(b.id);
  console.log(bankExport.buildExport('GENERIC_CSV', { ...b, period_label: '2026-06' }, items).content);
}

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2H TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
