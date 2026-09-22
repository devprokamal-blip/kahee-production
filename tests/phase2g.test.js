(async () => {
// tests/phase2g.test.js
// Phase 2G — Adjustments, Retroactive Payroll & Reversal. Throwaway database.
// Usage: npm run test:phase2g

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const writer = require('../lib/snapshotWriter');
const validationRunner = require('../lib/validationRunner');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
const payslip = require('../lib/payslip');
const adj = require('../lib/payrollAdjustment');
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

const TEST_DB = path.join(__dirname, 'phase2g.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2g');
const db = __t.db;
await initDb(db);

const PREPARER = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'] } };
const OTHER_APPROVER = { displayName: 'Finance Head', permissions: { payroll_run: ['VIEW','APPROVE'] } };

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
  VALUES ('RS 2026','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,1,0) RETURNING id`).run()).lastInsertRowid;
for (const [c,lo,hi,bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['B',620000000,null,100],['C',0,660000000,0]])
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

async function makeEmp(id) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_account_no)
              VALUES (?,?,'internal','active','2026-01-01','PPB','123')`).run(id, `Nama ${id}`);
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
const lineFor = async (runId, emp) => await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id=?').get(runId, emp);

async function finalizeOriginal(periodId) {
  await writer.snapshotPeriod(db, periodId, { chunkSize: 200, resolvedBy: PREPARER.displayName });
  await writer.freezePeriod(db, periodId, PREPARER.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, periodId, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'SNAPSHOT_READY','CALCULATED',PREPARER.displayName,'calc');
  });
  await validationRunner.validatePeriod(db, periodId, { chunkSize: 200, detectedAt: '2026-07-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED',resolved_by='Ops Director',
      resolved_at=kahe_now(),resolution_note='ok' WHERE payroll_period_id=? AND blocking=1`).run(periodId);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'CALCULATED','VALIDATED',PREPARER.displayName,'val');
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'final'));
  return await reload(run.id);
}
/** Drive a CORRECTION/REVERSAL run to FINALIZED. */
async function finalizeCorrection(run) {
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=?,validated_at=kahe_now() WHERE id=?`).run(PREPARER.displayName, run.id);
    await runLib.recordEvent(db, run.id,'CALCULATED','VALIDATED',PREPARER.displayName,'val');
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'koreksi ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'koreksi final'));
  return await reload(run.id);
}

const pJun = await makePeriod(gKahe, 2026, 6);
for (const id of ['E-A','E-B','E-C']) { await makeEmp(id); await assign(id); await addComp(id, 8000000); await addTs(id, '2026-06-15'); }
const original = await finalizeOriginal(pJun);

// =============================================================================
section('IMMUTABILITY OF THE ORIGINAL');
// =============================================================================

await check('the adjustment engine never edits finalized payroll', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollAdjustment.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const forbidden of [/UPDATE\s+payroll_run_lines/i, /DELETE\s+FROM\s+payroll_run_lines/i,
    /UPDATE\s+payroll_input_snapshots/i, /UPDATE\s+payroll_payslips/i, /UPDATE\s+payroll_run_line_components/i]) {
    if (forbidden.test(code)) throw new Error(`adjustment engine must not write finalized data: ${forbidden}`);
  }
  // and it must not read live rule tables — corrections use frozen rules
  for (const t of ['payroll_rule_sets','ptkp_ter_rates','overtime_multiplier_rules','jkk_risk_classes','employee_salary_components']) {
    if (code.includes(t)) throw new Error(`adjustment engine must not read live rule table ${t}`);
  }
});

await check('the original run, lines and payslip are untouched by the whole flow', async () => {
  const before = {
    run: await reload(original.id),
    lines: await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id').all(original.id),
  };
  const a = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-A', adjustment_type: adj.TYPE.RETRO_EARNING,
    component_code: 'RETRO_BASIC', direction: adj.DIRECTION.CREDIT, amount_sen: money.rupiahToSen(1000000),
    is_taxable: 1, is_bpjs_base: 1, reason: 'kenaikan berlaku surut',
  }, PREPARER));
  eq(a.status, 'DRAFT');
  eq(await reload(original.id), before.run, 'run unchanged: ');
  eq(await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id').all(original.id), before.lines, 'lines unchanged: ');
});

await check('a FINALIZED run still cannot be mutated (Phase 2E locks intact)', async () => {
  const line = await lineFor(original.id, 'E-A');
  await throwsMatching(async () => await db.prepare('UPDATE payroll_run_lines SET net_sen=1 WHERE id=?').run(line.id), /PAYROLL_FINALIZED/);
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='VALIDATED' WHERE id=?`).run(original.id), /PAYROLL_FINALIZED/);
});

// =============================================================================
section('ADJUSTMENT LEDGER');
// =============================================================================

await check('an adjustment can only be raised against a FINALIZED run', async () => {
  const pOpen = await makePeriod(gKahe, 2026, 7);
  await makeEmp('E-OPEN'); await assign('E-OPEN'); await addComp('E-OPEN', 7000000); await addTs('E-OPEN','2026-07-15');
  await writer.snapshotPeriod(db, pOpen, { chunkSize: 50, resolvedBy: 'x' });
  await writer.freezePeriod(db, pOpen, 'x');
  const r = await withTransaction(db, async () => await runLib.createRun(db, pOpen, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(r.id), PREPARER, 'f'));
  await runCalc.calculateRun(db, await reload(r.id), { chunkSize: 50 });
  await throwsCode(async () => await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: r.id, employee_id: 'E-OPEN', adjustment_type: adj.TYPE.RETRO_EARNING,
    component_code: 'X', direction: 'CREDIT', amount_sen: 100, reason: 'x',
  }, PREPARER)), adj.ERROR.SOURCE_NOT_FINALIZED);
});

await check('the DATABASE also refuses an adjustment against a non-finalized run', async () => {
  const r = await db.prepare(`SELECT * FROM payroll_runs WHERE status != 'FINALIZED' LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare(`INSERT INTO payroll_adjustments (source_run_id,source_period_id,employee_id,
    legal_entity_id,adjustment_type,component_code,direction,amount_sen,reason,created_by,created_at)
    VALUES (?,?,?,?,'MANUAL_ADJUSTMENT','X','CREDIT',100,'x','x',kahe_now())`)
    .run(r.id, r.payroll_period_id, 'E-OPEN', 'KAHE360'), /ADJUSTMENT_SOURCE_NOT_FINALIZED/);
});

await check('POSITIVE and NEGATIVE adjustments use explicit direction, never a negative amount', async () => {
  const credit = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-B', adjustment_type: adj.TYPE.RETRO_EARNING,
    component_code: 'RETRO_BONUS', direction: 'CREDIT', amount_sen: money.rupiahToSen(500000), reason: '+',
  }, PREPARER));
  const debit = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-B', adjustment_type: adj.TYPE.RETRO_DEDUCTION,
    component_code: 'OVERPAY_RECOVERY', direction: 'DEBIT', amount_sen: money.rupiahToSen(200000),
    is_taxable: 0, reason: '-',
  }, PREPARER));
  eq(adj.signedAmount(credit), money.rupiahToSen(500000));
  eq(adj.signedAmount(debit), -money.rupiahToSen(200000));
  await throwsCode(async () => await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-B', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'X', direction: 'CREDIT', amount_sen: -100, reason: 'x',
  }, PREPARER)), adj.ERROR.VALIDATION, 'negative amount: ');
});

await check('LATE OVERTIME is priced from the ORIGINAL frozen hourly rate', async () => {
  const a = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-C', adjustment_type: adj.TYPE.LATE_OVERTIME,
    component_code: 'LATE_OT', direction: 'CREDIT', overtime_minutes: 120,
    overtime_day_type: 'WORKDAY', work_date: '2026-06-20', reason: 'lembur telat disetujui',
  }, PREPARER));
  const rate = time.hourlyRateSen(money.rupiahToSen(8000000), 173);
  const expected = time.overtimePaySen(rate, 60, 15000) + time.overtimePaySen(rate, 60, 20000);
  eq(a.amount_sen, expected, 'progressive 1.5x + 2x at the frozen rate: ');
  eq(a.overtime_minutes, 120);
});

await check('DUPLICATE PREVENTION: an external_reference can only be used once', async () => {
  await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-A', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'REF_TEST', direction: 'CREDIT', amount_sen: 1000, reason: 'x',
    external_reference: 'TICKET-9001',
  }, PREPARER));
  await throwsCode(async () => await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-A', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'REF_TEST', direction: 'CREDIT', amount_sen: 1000, reason: 'dobel',
    external_reference: 'TICKET-9001',
  }, PREPARER)), adj.ERROR.DUPLICATE_REFERENCE);
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments WHERE external_reference='TICKET-9001'`).get()).n, 1);
});

await check('an employee outside the source run cannot be adjusted', async () => {
  await makeEmp('E-OUTSIDER'); await assign('E-OUTSIDER');
  await throwsCode(async () => await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-OUTSIDER', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'X', direction: 'CREDIT', amount_sen: 100, reason: 'x',
  }, PREPARER)), adj.ERROR.SOURCE_LINE_NOT_FOUND);
});

// =============================================================================
section('RBAC & SEGREGATION OF DUTIES');
// =============================================================================

await check('the CREATOR of an adjustment cannot approve it', async () => {
  const a = await db.prepare(`SELECT * FROM payroll_adjustments WHERE employee_id='E-A' AND component_code='RETRO_BASIC'`).get();
  const selfApprover = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','APPROVE'] } };
  const err = await throwsCode(async () => await withTransaction(db, async () => await adj.approveAdjustment(db, a.id, selfApprover, 'sendiri')),
    adj.ERROR.NOT_AUTHORIZED);
  eq(err.detail.created_by, 'Payroll Officer');
  eq((await db.prepare('SELECT status FROM payroll_adjustments WHERE id=?').get(a.id)).status, 'DRAFT');
});

await check('a DIFFERENT approver is accepted, and the approval is recorded', async () => {
  const a = await db.prepare(`SELECT * FROM payroll_adjustments WHERE employee_id='E-A' AND component_code='RETRO_BASIC'`).get();
  const out = await withTransaction(db, async () => await adj.approveAdjustment(db, a.id, OTHER_APPROVER, 'diperiksa'));
  eq(out.status, 'APPROVED');
  eq(out.approved_by, 'Finance Head');
  if (!out.approved_at) throw new Error('approved_at must be recorded');
});

await check('only DRAFT adjustments can be approved', async () => {
  const a = await db.prepare(`SELECT * FROM payroll_adjustments WHERE status='APPROVED' LIMIT 1`).get();
  await throwsCode(async () => await withTransaction(db, async () => await adj.approveAdjustment(db, a.id, APPROVER, 'lagi')), adj.ERROR.INVALID_STATE);
});

await check('VOID requires a reason and is audited', async () => {
  const a = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: original.id, employee_id: 'E-A', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'SALAH_INPUT', direction: 'CREDIT', amount_sen: 999, reason: 'keliru',
  }, PREPARER));
  await throwsCode(async () => await withTransaction(db, async () => await adj.voidAdjustment(db, a.id, APPROVER, null)), adj.ERROR.VALIDATION);
  const voided = await withTransaction(db, async () => await adj.voidAdjustment(db, a.id, APPROVER, 'salah input'));
  eq(voided.status, 'VOID');
  eq(voided.void_reason, 'salah input');
  eq(voided.voided_by, 'Ops Director');
});

// =============================================================================
section('CORRECTION RUN — DELTAS ONLY');
// =============================================================================

let correctionRun;

await check('a CORRECTION run references the original and inherits its snapshots', async () => {
  correctionRun = await withTransaction(db, async () => await runLib.createRun(db, pJun, PREPARER,
    { runType: 'CORRECTION', correctsRunId: original.id }));
  eq(correctionRun.run_type, 'CORRECTION');
  eq(correctionRun.corrects_run_id, original.id);
  eq(correctionRun.run_number, 2, 'its own run number: ');
  const out = await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(correctionRun.id), PREPARER, null));
  eq(out.inherited, true, 'snapshots inherited, not re-frozen: ');
});

await check('a correction run cannot be created against a non-finalized run', async () => {
  const open = await db.prepare(`SELECT * FROM payroll_runs WHERE status != 'FINALIZED' AND run_type='ORIGINAL' LIMIT 1`).get();
  await throwsCode(async () => await withTransaction(db, async () => await runLib.createRun(db, open.payroll_period_id, PREPARER,
    { runType: 'CORRECTION', correctsRunId: open.id })), runLib.TRANSITION_ERROR.INVALID_TRANSITION);
});

await check('applying adjustments produces DELTA lines, not a recalculation', async () => {
  // approve the rest first
  await withTransaction(db, async () => {
    for (const a of await db.prepare(`SELECT * FROM payroll_adjustments WHERE source_run_id=? AND status='DRAFT'`).all(original.id)) {
      await adj.approveAdjustment(db, a.id, OTHER_APPROVER, 'batch');
    }
  });
  const summary = await withTransaction(db, async () => await adj.applyToRun(db, await reload(correctionRun.id), PREPARER));
  eq(summary.lines, 3, 'one delta line per affected employee: ');
  eq(summary.adjustments_applied >= 4, true, `adjustments applied (${summary.adjustments_applied}): `);

  const dLine = await lineFor(correctionRun.id, 'E-A');
  const payload = JSON.parse(dLine.result_payload);
  eq(payload.is_delta, true, 'marked as a delta: ');
  eq(payload.corrects_run_id, original.id);
  eq(payload.rule_versions.payroll_rule_set_id, rsId, 'frozen rule version inherited: ');
  // E-A: +1.000.000 taxable & bpjs-base, +1.000 manual
  const orig = await lineFor(original.id, 'E-A');
  eq(dLine.gross_sen, money.rupiahToSen(1000000) + 1000, 'gross delta only: ');
  if (dLine.gross_sen === orig.gross_sen) throw new Error('delta must not equal the original gross');
});

await check('statutory DELTA is computed under the ORIGINAL frozen rules', async () => {
  const dLine = await lineFor(correctionRun.id, 'E-A');
  const base = money.rupiahToSen(1000000);   // only the bpjs-flagged part
  const expectedBpjsEmployee = money.applyBp(base, 100) + money.applyBp(base, 200) + money.applyBp(base, 100);
  eq(dLine.bpjs_employee_sen, expectedBpjsEmployee, 'BPJS employee delta: ');
  const expectedEmployer = money.applyBp(base, 400) + money.applyBp(base, 370) + money.applyBp(base, 200)
    + money.applyBp(base, 30) + money.applyBp(base, 127);
  eq(dLine.bpjs_employer_sen, expectedEmployer, 'BPJS employer delta incl. frozen JKK 127bp: ');
  // net delta = gross - (deductions + bpjs + tax)
  eq(dLine.net_sen, dLine.gross_sen - dLine.employee_deductions_sen, 'net delta reconciles: ');
});

await check('a NEGATIVE (DEBIT) adjustment reduces net pay', async () => {
  // CORRECTED IN PHASE 2H: a DEBIT means the employee receives LESS, so a
  // DEBIT on a deduction component RAISES the deduction. The earlier
  // expectation (negative deduction) encoded the opposite, which made a
  // recovery increase someone's pay.
  const dLine = await lineFor(correctionRun.id, 'E-B');
  eq(rp(dLine.gross_sen), 500000, 'gross delta: ');
  eq(rp(dLine.other_deductions_sen), 200000, 'DEBIT raises the deduction: ');
  eq(dLine.net_sen, dLine.gross_sen - dLine.employee_deductions_sen, 'net reconciles: ');
  eq(dLine.net_sen < dLine.gross_sen, true, 'the recovery reduced take-home: ');
});

await check('LATE OVERTIME delta lands on the correction run', async () => {
  const dLine = await lineFor(correctionRun.id, 'E-C');
  const rate = time.hourlyRateSen(money.rupiahToSen(8000000), 173);
  const expected = time.overtimePaySen(rate, 60, 15000) + time.overtimePaySen(rate, 60, 20000);
  eq(dLine.gross_sen, expected);
});

await check('DUPLICATE APPLICATION is impossible: applied adjustments are pinned', async () => {
  const applied = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments WHERE status='APPLIED' AND applied_to_run_id=?`).get(correctionRun.id)).n;
  eq(applied >= 4, true);
  // re-applying finds nothing approved left
  await throwsCode(async () => await withTransaction(db, async () => await adj.applyToRun(db, await reload(correctionRun.id), PREPARER)),
    adj.ERROR.NOTHING_TO_APPLY);
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(correctionRun.id)).n, 3,
    'no duplicate delta lines: ');
});

await check('an APPLIED adjustment is immutable — database trigger', async () => {
  const a = await db.prepare(`SELECT * FROM payroll_adjustments WHERE status='APPLIED' LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare('UPDATE payroll_adjustments SET amount_sen=1 WHERE id=?').run(a.id), /ADJUSTMENT_APPLIED/);
  await throwsMatching(async () => await db.prepare('DELETE FROM payroll_adjustments WHERE id=?').run(a.id), /ADJUSTMENT_APPLIED/);
  await throwsCode(async () => await withTransaction(db, async () => await adj.voidAdjustment(db, a.id, APPROVER, 'coba')), adj.ERROR.ALREADY_APPLIED);
});

await check('the correction run finalizes alongside the original, not instead of it', async () => {
  correctionRun = await finalizeCorrection(await reload(correctionRun.id));
  eq(correctionRun.status, 'FINALIZED');
  eq((await reload(original.id)).status, 'FINALIZED', 'original still finalized: ');
  const runs = await db.prepare('SELECT run_number, run_type, status FROM payroll_runs WHERE payroll_period_id=? ORDER BY run_number').all(pJun);
  eq(runs, [
    { run_number: 1, run_type: 'ORIGINAL', status: 'FINALIZED' },
    { run_number: 2, run_type: 'CORRECTION', status: 'FINALIZED' },
  ]);
});

await check('a SECOND finalized ORIGINAL is still impossible', async () => {
  const r = await withTransaction(db, async () => await runLib.createRun(db, pJun, PREPARER));
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='FINALIZED' WHERE id=?`).run(r.id),
    /UNIQUE|constraint/i);
});

// =============================================================================
section('RECONCILIATION');
// =============================================================================

await check('period reconciliation sums the original and every finalized correction', async () => {
  const rec = await adj.reconcilePeriod(db, pJun);
  eq(rec.finalized_run_count, 2);
  eq(rec.reconciles, true, 'gross - deductions == net exactly: ');

  const origTotals = await db.prepare(`SELECT COALESCE(SUM(gross_sen),0) g, COALESCE(SUM(net_sen),0) n FROM payroll_run_lines WHERE payroll_run_id=?`).get(original.id);
  const corrTotals = await db.prepare(`SELECT COALESCE(SUM(gross_sen),0) g, COALESCE(SUM(net_sen),0) n FROM payroll_run_lines WHERE payroll_run_id=?`).get(correctionRun.id);
  eq(rec.effective_totals.gross_sen, origTotals.g + corrTotals.g, 'effective gross: ');
  eq(rec.effective_totals.net_sen, origTotals.n + corrTotals.n, 'effective net: ');
});

await check('per-employee reconciliation shows the original and its correction', async () => {
  const rec = await adj.reconcileEmployee(db, pJun, 'E-A');
  eq(rec.runs.length, 2);
  eq(rec.runs.map((r) => r.run_type), ['ORIGINAL','CORRECTION']);
  const orig = await lineFor(original.id, 'E-A');
  const corr = await lineFor(correctionRun.id, 'E-A');
  eq(rec.effective_totals.net_sen, orig.net_sen + corr.net_sen, 'effective net for the employee: ');
});

await check('a correction produces its OWN payslip without touching the original one', async () => {
  const origLine = await lineFor(original.id, 'E-A');
  const corrLine = await lineFor(correctionRun.id, 'E-A');
  const origPs = await withTransaction(db, async () => await payslip.generate(db, origLine.id, { generatedBy: 'test' }));
  const corrPs = await withTransaction(db, async () => await payslip.generate(db, corrLine.id, { generatedBy: 'test' }));
  eq(corrPs.created, true);
  if (corrPs.payslip.id === origPs.payslip.id) throw new Error('correction must get its own payslip');
  eq(corrPs.payslip.run_number, 2);
  eq(origPs.payslip.run_number, 1);
  // the original payslip's hash is unchanged by all of this
  const stored = await db.prepare('SELECT content_hash FROM payroll_payslips WHERE payroll_run_line_id=?').get(origLine.id);
  eq(stored.content_hash, origPs.payslip.content_hash);
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_payslips WHERE employee_id=?').get('E-A')).n, 2,
    'two payslips: original and correction: ');
});

// =============================================================================
section('REVERSAL');
// =============================================================================

let reversalRun;
const pJul = await makePeriod(gKahe, 2026, 8);

await check('a REVERSAL run negates every line of the original', async () => {
  for (const id of ['E-R1','E-R2']) { await makeEmp(id); await assign(id); await addComp(id, 6000000); await addTs(id, '2026-08-17'); }
  const orig2 = await finalizeOriginal(pJul);

  reversalRun = await withTransaction(db, async () => await runLib.createRun(db, pJul, PREPARER,
    { runType: 'REVERSAL', correctsRunId: orig2.id }));
  eq(reversalRun.run_type, 'REVERSAL');
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(reversalRun.id), PREPARER, null));
  const summary = await withTransaction(db, async () => await adj.applyToRun(db, await reload(reversalRun.id), PREPARER));
  // The period's payroll group also contains employees created by earlier
  // tests, so a REVERSAL legitimately covers every line of the original.
  const originalLines = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(orig2.id)).n;
  eq(summary.lines, originalLines, 'a reversal covers every original line: ');
  eq(originalLines >= 2, true);

  for (const emp of ['E-R1','E-R2']) {
    const o = await lineFor(orig2.id, emp);
    const r = await lineFor(reversalRun.id, emp);
    eq(r.gross_sen, -o.gross_sen, `${emp} gross negated: `);
    eq(r.net_sen, -o.net_sen, `${emp} net negated: `);
    eq(r.bpjs_employer_sen, -o.bpjs_employer_sen, `${emp} employer negated: `);
  }
  reversalRun = await finalizeCorrection(await reload(reversalRun.id));
  const rec = await adj.reconcilePeriod(db, pJul);
  eq(rec.effective_totals.net_sen, 0, 'after full reversal the period nets to zero: ');
  eq(rec.effective_totals.gross_sen, 0);
});

await check('a run cannot be reversed twice', async () => {
  const orig2 = await db.prepare(`SELECT * FROM payroll_runs WHERE payroll_period_id=? AND run_type='ORIGINAL'`).get(pJul);
  const second = await withTransaction(db, async () => await runLib.createRun(db, pJul, PREPARER,
    { runType: 'REVERSAL', correctsRunId: orig2.id }));
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='FINALIZED' WHERE id=?`).run(second.id),
    /UNIQUE|constraint/i, 'second finalized reversal must be impossible: ');
});

// =============================================================================
section('ISOLATION, ROLLBACK, SCALE');
// =============================================================================

await check('LEGAL ENTITY ISOLATION: a correction run cannot cross entities', async () => {
  const pMitra = await makePeriod(gMitra, 2026, 6);
  await makeEmp('E-M'); await assign('E-M', { entity: 'MITRA', group: gMitra }); await addComp('E-M', 7000000); await addTs('E-M','2026-06-15');
  await finalizeOriginal(pMitra);
  // a KAHE period cannot host a correction of a MITRA run
  await throwsCode(async () => await withTransaction(db, async () => await runLib.createRun(db, pJun, PREPARER,
    { runType: 'CORRECTION', correctsRunId: (await db.prepare(`SELECT id FROM payroll_runs WHERE legal_entity_id='MITRA'`).get()).id })),
    runLib.TRANSITION_ERROR.ENTITY_MISMATCH);
});

await check('adjustments carry their own legal entity', async () => {
  const mitraRun = await db.prepare(`SELECT * FROM payroll_runs WHERE legal_entity_id='MITRA' AND status='FINALIZED'`).get();
  const a = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: mitraRun.id, employee_id: 'E-M', adjustment_type: adj.TYPE.MANUAL_ADJUSTMENT,
    component_code: 'X', direction: 'CREDIT', amount_sen: 1000, reason: 'x',
  }, PREPARER));
  eq(a.legal_entity_id, 'MITRA');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments WHERE source_run_id=? AND legal_entity_id!='MITRA'`).get(mitraRun.id)).n, 0);
});

await check('ROLLBACK during application leaves nothing behind', async () => {
  const pRb = await makePeriod(gKahe, 2026, 9);
  await makeEmp('E-RB'); await assign('E-RB'); await addComp('E-RB', 6000000); await addTs('E-RB','2026-09-15');
  const origRb = await finalizeOriginal(pRb);
  const a = await withTransaction(db, async () => await adj.createAdjustment(db, {
    source_run_id: origRb.id, employee_id: 'E-RB', adjustment_type: adj.TYPE.RETRO_EARNING,
    component_code: 'RETRO', direction: 'CREDIT', amount_sen: money.rupiahToSen(100000), reason: 'x',
  }, PREPARER));
  await withTransaction(db, async () => await adj.approveAdjustment(db, a.id, OTHER_APPROVER, 'ok'));
  const corr = await withTransaction(db, async () => await runLib.createRun(db, pRb, PREPARER, { runType: 'CORRECTION', correctsRunId: origRb.id }));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(corr.id), PREPARER, null));

  const before = {
    lines: (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(corr.id)).n,
    status: (await db.prepare('SELECT status FROM payroll_adjustments WHERE id=?').get(a.id)).status,
  };
  let threw = false;
  try {
    await withTransaction(db, async () => {
      await adj.applyToRun(db, await reload(corr.id), PREPARER);
      throw new Error('simulated failure after applying');
    });
  } catch (e) { threw = true; }
  eq(threw, true);
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(corr.id)).n, before.lines,
    'no delta line survived: ');
  eq((await db.prepare('SELECT status FROM payroll_adjustments WHERE id=?').get(a.id)).status, before.status,
    'adjustment not marked applied: ');
});

await check('1,500 employee correction run applies in one pass and reconciles', async () => {
  const pBulk = await makePeriod(gKahe, 2026, 10);
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_account_no) VALUES (?,?,'internal','active','2026-01-01','PPB','1')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source) VALUES (?, '2026-10-15','present',480,8,'none','WORKDAY','t')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BK-${String(i).padStart(4,'0')}`;
      await insE.run(id, id); await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  const origB = await finalizeOriginal(pBulk);

  await withTransaction(db, async () => {
    for (let i = 0; i < 1500; i += 1) {
      const id = `BK-${String(i).padStart(4,'0')}`;
      const a = await adj.createAdjustment(db, {
        source_run_id: origB.id, employee_id: id, adjustment_type: adj.TYPE.RETRO_EARNING,
        component_code: 'RETRO_UMR', direction: 'CREDIT', amount_sen: money.rupiahToSen(250000),
        is_taxable: 1, is_bpjs_base: 1, reason: 'penyesuaian UMR',
        external_reference: `UMR-2026-${id}`,
      }, PREPARER);
      await adj.approveAdjustment(db, a.id, OTHER_APPROVER, 'batch');
    }
  });

  const corrB = await withTransaction(db, async () => await runLib.createRun(db, pBulk, PREPARER, { runType: 'CORRECTION', correctsRunId: origB.id }));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(corrB.id), PREPARER, null));
  const summary = await withTransaction(db, async () => await adj.applyToRun(db, await reload(corrB.id), PREPARER));
  eq(summary.lines >= 1500, true, `delta lines (${summary.lines}): `);

  const bulkGross = (await db.prepare(`SELECT COALESCE(SUM(gross_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id LIKE 'BK-%'`).get(corrB.id)).n;
  eq(rp(bulkGross), 1500 * 250000, 'cohort retro gross reconciles exactly: ');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments WHERE applied_to_run_id=? AND status='APPLIED'`).get(corrB.id)).n >= 1500, true);
});

await check('Phase 2G builds NO payment or bank file', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 2H: payment tables now exist. What this
  // test guards is unchanged and is asserted below: this module writes no
  // payment row of its own.
  const paymentRows = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n;
  eq(paymentRows, 0, 'this phase must create no payment record: ');
  eq(tables.includes('payroll_adjustments'), true);
});

// =============================================================================
section('REGRESSION');
// =============================================================================

await check('all prior invariant indexes present, with the narrowed finalized index', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee','uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class','uq_holiday_national_per_date','uq_emp_salary_component_open',
    'uq_salary_component_open_global','uq_salary_component_open_scoped','uq_work_calendar_open_code',
    'uq_payroll_group_open_code','uq_payroll_period_group_cycle','uq_payroll_period_group_start',
    'uq_snapshot_period_employee','uq_exception_snapshot_code',
    'uq_payroll_run_single_finalized_original','uq_payroll_reversal_single',
    'uq_adjustment_external_reference']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('all immutability triggers present (payroll, payslip, adjustment)', async () => {
  const t = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_line_update','trg_lock_finalized_run_status',
    'trg_lock_payslip_update','trg_payslip_requires_finalized_run',
    'trg_lock_applied_adjustment','trg_adjustment_requires_finalized_source']) {
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

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2G TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
