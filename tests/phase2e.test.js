(async () => {
// tests/phase2e.test.js
// Phase 2E — Approval, Finalization & Immutability Lock. Throwaway database.
// Usage: npm run test:phase2e

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
const calc = require('../lib/payrollCalculator');
const validationRunner = require('../lib/validationRunner');
const validation = require('../lib/payrollValidation');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
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
    if (e.code !== code) throw new Error(`${label}expected code ${code}, got ${e.code} (${e.message})`);
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

const TEST_DB = path.join(__dirname, 'phase2e.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2e');
const db = __t.db;
await initDb(db);

// ---- actors (userContext shapes, mirroring middleware/permissions) ----------
const PREPARER = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT','EXPORT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE','REJECT','EXPORT','ADMIN'] } };
const VIEWER   = { displayName: 'HRD Officer', permissions: { payroll_run: ['VIEW'] } };
// Holds the explicit override, so may approve work they prepared themselves.
const SUPERUSER = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'], payroll_sod_override: ['ADMIN'] } };

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
for (const [cat, lo, hi, bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['B',620000000,null,100],['C',0,660000000,0]])
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rsId,cat,lo,hi,bp);
for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],['rest_or_holiday_5day',1,8,20000]])
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rsId,dt,hf,ht,m);

async function makeGroup(code, entity, requireWarnAck = 1) {
  return (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from)
    VALUES (?,?,?,'monthly',12,0,0,2,5,?,'2026-01-01') RETURNING id`).run(code, code, entity, requireWarnAck)).lastInsertRowid;
}
const gKahe = await makeGroup('KAHE-M', 'KAHE360', 0);     // warnings advisory
const gStrict = await makeGroup('STRICT-M', 'KAHE360', 1); // warnings must be acknowledged
const gMitra = await makeGroup('MITRA-M', 'MITRA', 0);

async function makePeriod(g, y, s) {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(g);
  const w = pp.monthlyWindow(y, s); const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN') RETURNING id`).run(g,y,s,s,d.period_start,d.period_end,
    d.attendance_cutoff,d.overtime_cutoff,d.adjustment_cutoff,d.payment_date)).lastInsertRowid;
}
const cBasic = (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
  is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
  VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makeEmp(id, o = {}) {
  const f = { bank: '123456', ...o };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_account_no)
              VALUES (?,?,'internal','active','2026-01-01','PPB',?)`).run(id, id, f.bank);
}
async function assign(id, o = {}) {
  const a = { entity:'KAHE360', group:gKahe, ...o };
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2026-01-01')`)
    .run(id, a.entity, wp5, cal, a.group);
}
async function addComp(id, rupiah) {
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
              VALUES (?,?,?,'2026-01-01')`).run(id, cBasic, money.rupiahToSen(rupiah));
}
async function addTs(id, date, o = {}) {
  const f = { ot: 0, otStatus: 'none', ...o };
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_minutes_requested,overtime_minutes_approved,overtime_hours_approved,overtime_status,day_type,day_type_source)
    VALUES (?,?,'present',480,8,?,?,?,?,'WORKDAY','test')`)
    .run(id, date, f.otStatus==='pending'?f.ot:0, f.otStatus==='approved'?f.ot:0,
      time.minutesToHours(f.otStatus==='approved'?f.ot:0), f.otStatus);
}
/** Take + freeze snapshots, then drive a run to a chosen state. */
async function prepareRun(periodId, { toStatus = 'VALIDATED', preparer = PREPARER } = {}) {
  await writer.snapshotPeriod(db, periodId, { chunkSize: 200, resolvedBy: preparer.displayName });
  await writer.freezePeriod(db, periodId, preparer.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, periodId, preparer));
  if (toStatus === 'DRAFT') return await reload(run.id);
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), preparer, 'snapshots frozen'));
  if (toStatus === 'SNAPSHOT_READY') return await reload(run.id);
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now() WHERE id=?`)
      .run(preparer.displayName, run.id);
    await runLib.recordEvent(db, run.id, 'SNAPSHOT_READY', 'CALCULATED', preparer.displayName, 'calculated');
  });
  if (toStatus === 'CALCULATED') return await reload(run.id);
  await validationRunner.validatePeriod(db, periodId, { chunkSize: 200, detectedAt: '2026-07-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`)
      .run(preparer.displayName, run.id);
    await runLib.recordEvent(db, run.id, 'CALCULATED', 'VALIDATED', preparer.displayName, 'validated');
  });
  return await reload(run.id);
}
const reload = async (id) => await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
/** Acknowledge every open warning so a strict group's gate can open. */
async function ackWarnings(periodId) {
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='ACKNOWLEDGED', resolved_by='Ops Director',
      resolved_at=kahe_now(), resolution_note='ditinjau' WHERE payroll_period_id=? AND severity='WARNING' AND resolution_status='OPEN'`).run(periodId);
  });
}

// =============================================================================
section('LIFECYCLE MODEL');
// =============================================================================

await check('the lifecycle is exactly the six validated states', () => {
  eq(Object.keys(runLib.STATUS), ['DRAFT','SNAPSHOT_READY','CALCULATED','VALIDATED','APPROVED','FINALIZED']);
  eq(runLib.ALLOWED_TRANSITIONS.FINALIZED, [], 'FINALIZED is terminal: ');
});

await check('allowed transitions are explicit; everything else is refused', () => {
  eq(runLib.canTransition('DRAFT','SNAPSHOT_READY'), true);
  eq(runLib.canTransition('SNAPSHOT_READY','CALCULATED'), true);
  eq(runLib.canTransition('CALCULATED','VALIDATED'), true);
  eq(runLib.canTransition('VALIDATED','APPROVED'), true);
  eq(runLib.canTransition('APPROVED','FINALIZED'), true);
  eq(runLib.canTransition('VALIDATED','CALCULATED'), true, 'recalculate: ');
  eq(runLib.canTransition('APPROVED','VALIDATED'), true, 'un-approve: ');
  // the shortcuts that must never exist
  eq(runLib.canTransition('DRAFT','APPROVED'), false);
  eq(runLib.canTransition('DRAFT','FINALIZED'), false);
  eq(runLib.canTransition('CALCULATED','APPROVED'), false, 'cannot skip validation: ');
  eq(runLib.canTransition('CALCULATED','FINALIZED'), false);
  eq(runLib.canTransition('FINALIZED','APPROVED'), false);
});

// =============================================================================
section('CLEAN PAYROLL PROGRESSES NORMALLY');
// =============================================================================

const pClean = await makePeriod(gKahe, 2026, 6);
await makeEmp('E-A'); await assign('E-A'); await addComp('E-A', 8000000); await addTs('E-A', '2026-06-15');
await makeEmp('E-B'); await assign('E-B'); await addComp('E-B', 9000000); await addTs('E-B', '2026-06-16');

await check('1. CLEAN PAYROLL: DRAFT -> SNAPSHOT_READY -> CALCULATED -> VALIDATED -> APPROVED -> FINALIZED', async () => {
  const run = await prepareRun(pClean, { toStatus: 'VALIDATED' });
  eq(run.status, 'VALIDATED');
  eq(run.prepared_by, 'Payroll Officer');

  const approved = await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'disetujui'));
  eq(approved.run.status, 'APPROVED');
  eq(approved.run.approved_by, 'Ops Director');

  const fin = await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'final'));
  eq(fin.lines, 2);
  const final = await reload(run.id);
  eq(final.status, 'FINALIZED');
  eq(final.finalized_by, 'Ops Director');
  if (!final.finalized_at) throw new Error('finalized_at must be recorded');
});

await check('results are PERSISTED with component breakdown', async () => {
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pClean);
  const lines = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? ORDER BY employee_id').all(run.id);
  eq(lines.length, 2);
  eq(lines[0].calc_status, 'OK');
  eq(rp(lines[0].gross_sen), 8000000, 'E-A gross: ');
  eq(lines[0].payroll_rule_set_id, rsId, 'rule version recorded on the line: ');
  eq(lines[0].result_hash.length, 64, 'result hash: ');
  eq(lines[0].snapshot_hash.length, 64, 'input hash: ');
  const comps = await db.prepare('SELECT * FROM payroll_run_line_components WHERE payroll_run_line_id=? ORDER BY sequence').all(lines[0].id);
  eq(comps.length > 5, true, `component rows (${comps.length}): `);
  const basic = comps.find((c) => c.component_code === 'BASIC');
  eq(basic.amount_sen, money.rupiahToSen(8000000));
  eq(basic.rounding_rule, 'half_up_to_sen');
  const tax = comps.find((c) => c.component_code === 'PPH21_TER');
  eq(tax.rule_version.startsWith(`rule_set:${rsId}`), true, 'tax rule version on the breakdown: ');
});

await check('every transition recorded actor, timestamp, from, to and note', async () => {
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pClean);
  const history = await runLib.getHistory(db, run.id);
  eq(history.map((h) => h.to_status), ['DRAFT','SNAPSHOT_READY','CALCULATED','VALIDATED','APPROVED','FINALIZED']);
  for (const h of history) {
    if (!h.actor) throw new Error(`event ${h.to_status} has no actor`);
    if (!h.occurred_at) throw new Error(`event ${h.to_status} has no timestamp`);
  }
  eq(history.find((h) => h.to_status === 'APPROVED').actor, 'Ops Director');
  eq(history.find((h) => h.to_status === 'CALCULATED').actor, 'Payroll Officer');
});

// =============================================================================
section('APPROVAL GATES');
// =============================================================================

await check('2. BLOCKING EXCEPTION prevents approval', async () => {
  const pBlocked = await makePeriod(gKahe, 2026, 7);
  await makeEmp('E-OTPEND'); await assign('E-OTPEND'); await addComp('E-OTPEND', 8000000);
  await addTs('E-OTPEND', '2026-07-15', { ot: 120, otStatus: 'pending' });   // unapproved overtime
  const run = await prepareRun(pBlocked, { toStatus: 'VALIDATED' });
  const gate = await validation.getBlockingSummary(db, pBlocked);
  eq(gate.unresolved_blocking > 0, true, 'there is a blocker: ');
  const err = await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'coba')),
    runLib.TRANSITION_ERROR.BLOCKING_EXCEPTIONS);
  eq(err.detail.unresolved_blocking > 0, true);
  eq((await reload(run.id)).status, 'VALIDATED', 'run stays put: ');
});

await check('3. RESOLVED BLOCKER lets the run proceed', async () => {
  const pBlocked = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=7').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pBlocked);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED', resolved_by='Ops Director',
      resolved_at=kahe_now(), resolution_note='lembur disetujui terpisah'
      WHERE payroll_period_id=? AND blocking=1`).run(pBlocked);
  });
  const out = await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'disetujui'));
  eq(out.run.status, 'APPROVED');
});

await check('WARNING POLICY: a strict group blocks approval until warnings are acknowledged', async () => {
  const pStrict = await makePeriod(gStrict, 2026, 8);
  await makeEmp('E-NOBANK', { bank: null }); await assign('E-NOBANK', { group: gStrict }); await addComp('E-NOBANK', 7000000);
  await addTs('E-NOBANK', '2026-08-17');
  const run = await prepareRun(pStrict, { toStatus: 'VALIDATED' });
  const err = await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'coba')),
    runLib.TRANSITION_ERROR.UNACKNOWLEDGED_WARNINGS);
  eq(err.detail.policy, 'require_warning_acknowledgement');

  await ackWarnings(pStrict);
  const out = await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'ok'));
  eq(out.run.status, 'APPROVED', 'after acknowledgement: ');
});

await check('WARNING POLICY: a permissive group approves with warnings still open', async () => {
  const pLoose = await makePeriod(gKahe, 2026, 9);
  await makeEmp('E-LOOSE', { bank: null }); await assign('E-LOOSE'); await addComp('E-LOOSE', 7000000); await addTs('E-LOOSE', '2026-09-15');
  const run = await prepareRun(pLoose, { toStatus: 'VALIDATED' });
  eq((await validation.getBlockingSummary(db, pLoose)).unacknowledged_warnings > 0, true, 'a warning is open: ');
  const out = await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'warnings advisory'));
  eq(out.run.status, 'APPROVED');
});

// =============================================================================
section('SEGREGATION OF DUTIES & AUTHORISATION');
// =============================================================================

await check('4. UNAUTHORIZED APPROVAL is rejected (no APPROVE permission)', async () => {
  const pSod = await makePeriod(gKahe, 2026, 10);
  await makeEmp('E-SOD'); await assign('E-SOD'); await addComp('E-SOD', 8000000); await addTs('E-SOD', '2026-10-15');
  const run = await prepareRun(pSod, { toStatus: 'VALIDATED' });
  await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, run, VIEWER, 'coba')),
    runLib.TRANSITION_ERROR.NOT_AUTHORIZED);
  eq((await reload(run.id)).status, 'VALIDATED');
});

await check('6. SOD VIOLATION: the preparer cannot approve their own run', async () => {
  const pSod = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=10').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pSod);
  eq(run.prepared_by, 'Payroll Officer');
  // Same human, and they DO hold APPROVE — still refused.
  const selfApprover = { displayName: 'Payroll Officer', permissions: { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'] } };
  const err = await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, run, selfApprover, 'saya sendiri')),
    runLib.TRANSITION_ERROR.SOD_VIOLATION);
  eq(err.detail.prepared_by, 'Payroll Officer');
  eq((await reload(run.id)).status, 'VALIDATED', 'run unchanged: ');
});

await check('SOD OVERRIDE is a SEPARATE explicit permission, and its use is audited', async () => {
  const pSod = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=10').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pSod);
  const out = await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), SUPERUSER, 'override: penyetuju lain cuti'));
  eq(out.run.status, 'APPROVED');
  const event = (await runLib.getHistory(db, run.id)).find((h) => h.to_status === 'APPROVED');
  eq(event.detail.sod_override_used, true, 'override recorded: ');
  eq(event.detail.prepared_by, 'Payroll Officer', 'target preparer recorded: ');
  eq(event.actor, 'Payroll Officer', 'actor recorded: ');
  eq(event.note, 'override: penyetuju lain cuti', 'reason recorded: ');
  if (!event.occurred_at) throw new Error('override must carry a timestamp');
});

await check('5. AUTHORIZED APPROVAL by a different person is accepted', async () => {
  const pOk = await makePeriod(gKahe, 2026, 11);
  await makeEmp('E-OK'); await assign('E-OK'); await addComp('E-OK', 8000000); await addTs('E-OK', '2026-11-16');
  const run = await prepareRun(pOk, { toStatus: 'VALIDATED' });
  const out = await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'ok'));
  eq(out.run.status, 'APPROVED');
  eq(out.run.approved_by, 'Ops Director');
});

await check('finalization also requires APPROVE permission', async () => {
  const pOk = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=11').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pOk);
  await throwsCode(async () => await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), VIEWER, 'coba')),
    runLib.TRANSITION_ERROR.NOT_AUTHORIZED);
  eq((await reload(run.id)).status, 'APPROVED', 'still approved, not finalized: ');
});

await check('the SoD override permission is granted to NO role by the seed', () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', 'database', 'seed.js'), 'utf8');
  // The Director's blanket grant must explicitly exclude the override module.
  // Phase 2I added a second override (entity read), so the filter now excludes
  // a list; the guarantee is unchanged.
  if (!/filter\(\(\[m\]\) =>[^)]*SOD_OVERRIDE_MODULE/.test(seed)) {
    throw new Error('operations_director must not receive payroll_sod_override via the blanket grant');
  }
  const granted = [...seed.matchAll(/payroll_sod_override:\s*\[/g)];
  eq(granted.length, 0, 'no role literal grants the override: ');
});

// =============================================================================
section('TRANSITION SAFETY');
// =============================================================================

await check('7. INVALID TRANSITION is rejected with the allowed set', async () => {
  const pInv = await makePeriod(gKahe, 2026, 12);
  await makeEmp('E-INV'); await assign('E-INV'); await addComp('E-INV', 8000000); await addTs('E-INV', '2026-12-15');
  const run = await prepareRun(pInv, { toStatus: 'DRAFT' });
  const err = await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, run, APPROVER, 'lompat')),
    runLib.TRANSITION_ERROR.INVALID_TRANSITION);
  eq(err.detail.from, 'DRAFT');
  eq(err.detail.allowed, ['SNAPSHOT_READY']);
});

await check('SNAPSHOT_READY refuses to advance while snapshots are unfrozen', async () => {
  const pUnfrozen = await makePeriod(gKahe, 2027, 1);
  await makeEmp('E-UNFROZEN'); await assign('E-UNFROZEN'); await addComp('E-UNFROZEN', 8000000);
  await writer.snapshotPeriod(db, pUnfrozen, { chunkSize: 50, resolvedBy: 'Payroll Officer' });
  // deliberately NOT frozen
  const run = await withTransaction(db, async () => await runLib.createRun(db, pUnfrozen, PREPARER));
  await throwsCode(async () => await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'x')),
    runLib.TRANSITION_ERROR.SNAPSHOTS_NOT_READY);
  eq((await reload(run.id)).status, 'DRAFT');
});

await check('8. DUPLICATE APPROVAL is IDEMPOTENT and does not rewrite the approver', async () => {
  const pOk = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=11').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pOk);
  const before = await reload(run.id);
  const again = await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'lagi'));
  eq(again.idempotent, true);
  const after = await reload(run.id);
  eq(after.approved_by, before.approved_by, 'approver unchanged: ');
  eq(after.approved_at, before.approved_at, 'timestamp unchanged: ');
  const approvals = (await runLib.getHistory(db, run.id)).filter((h) => h.to_status === 'APPROVED');
  eq(approvals.length, 1, 'no second approval event: ');
});

await check('9. DUPLICATE FINALIZATION is REJECTED (not idempotent, by design)', async () => {
  const run = await db.prepare(`SELECT * FROM payroll_runs WHERE payroll_period_id=?`).get(pClean);
  eq(run.status, 'FINALIZED');
  await throwsCode(async () => await withTransaction(db, async () => await runLib.finalize(db, run, APPROVER, 'lagi')),
    runLib.TRANSITION_ERROR.ALREADY_FINALIZED);
});

await check('only ONE finalized run per period is possible (database index)', async () => {
  const run2 = await withTransaction(db, async () => await runLib.createRun(db, pClean, PREPARER));
  eq(run2.run_number, 2, 'correction run gets its own number: ');
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='FINALIZED' WHERE id=?`).run(run2.id),
    /UNIQUE|constraint/i, 'a second finalized run must be impossible: ');
});

await check('UN-APPROVE returns an approved run to VALIDATED, audited', async () => {
  const pOk = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=11').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pOk);
  await withTransaction(db, async () => await runLib.unapprove(db, await reload(run.id), APPROVER, 'ditemukan selisih'));
  const after = await reload(run.id);
  eq(after.status, 'VALIDATED');
  eq(after.approved_by, null, 'approver cleared: ');
  const ev = (await runLib.getHistory(db, run.id)).filter((h) => h.to_status === 'VALIDATED').pop();
  eq(ev.note, 'ditemukan selisih');
  eq(ev.detail.action, 'un-approve');
});

// =============================================================================
section('IMMUTABILITY — APPLICATION AND DATABASE LAYER');
// =============================================================================

const finalizedRun = await db.prepare(`SELECT * FROM payroll_runs WHERE payroll_period_id=? AND status='FINALIZED'`).get(pClean);

await check('10. FINALIZED RUN cannot change status — application layer', async () => {
  await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, finalizedRun, APPROVER, 'x')),
    runLib.TRANSITION_ERROR.ALREADY_FINALIZED);
});

await check('10b. FINALIZED RUN cannot change status — DATABASE TRIGGER', async () => {
  // Bypassing the application entirely must still fail.
  await throwsMatching(async () => await db.prepare(`UPDATE payroll_runs SET status='VALIDATED' WHERE id=?`).run(finalizedRun.id),
    /PAYROLL_FINALIZED/, 'raw SQL must be blocked: ');
  eq((await reload(finalizedRun.id)).status, 'FINALIZED');
});

await check('11. FINALIZED RESULT LINES are immutable — DATABASE TRIGGER', async () => {
  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? LIMIT 1').get(finalizedRun.id);
  await throwsMatching(async () => await db.prepare('UPDATE payroll_run_lines SET net_sen = 1 WHERE id = ?').run(line.id),
    /PAYROLL_FINALIZED/, 'update: ');
  await throwsMatching(async () => await db.prepare('DELETE FROM payroll_run_lines WHERE id = ?').run(line.id),
    /PAYROLL_FINALIZED/, 'delete: ');
  eq((await db.prepare('SELECT net_sen FROM payroll_run_lines WHERE id=?').get(line.id)).net_sen, line.net_sen, 'value intact: ');
});

await check('11b. FINALIZED COMPONENT BREAKDOWN is immutable — DATABASE TRIGGER', async () => {
  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? LIMIT 1').get(finalizedRun.id);
  const comp = await db.prepare('SELECT * FROM payroll_run_line_components WHERE payroll_run_line_id=? LIMIT 1').get(line.id);
  await throwsMatching(async () => await db.prepare('UPDATE payroll_run_line_components SET amount_sen = 1 WHERE id = ?').run(comp.id),
    /PAYROLL_FINALIZED/, 'update: ');
  await throwsMatching(async () => await db.prepare('DELETE FROM payroll_run_line_components WHERE id = ?').run(comp.id),
    /PAYROLL_FINALIZED/, 'delete: ');
});

await check('11c. FROZEN SNAPSHOT behind a finalized run is immutable — DATABASE TRIGGER', async () => {
  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=? LIMIT 1').get(finalizedRun.id);
  await throwsMatching(async () => await db.prepare('UPDATE payroll_input_snapshots SET resolved_payload = ? WHERE id = ?').run('{}', line.snapshot_id),
    /PAYROLL_FINALIZED/, 'update: ');
  await throwsMatching(async () => await db.prepare('DELETE FROM payroll_input_snapshots WHERE id = ?').run(line.snapshot_id),
    /PAYROLL_FINALIZED/, 'delete: ');
});

await check('12. LIVE MASTER CHANGES after finalization do not alter finalized payroll', async () => {
  const line = await db.prepare(`SELECT * FROM payroll_run_lines WHERE payroll_run_id=? AND employee_id='E-A'`).get(finalizedRun.id);
  const beforeGross = line.gross_sen;
  const beforeHash = line.result_hash;

  // Change the world: reprice JKK, raise the salary, add attendance.
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE jkk_risk_classes SET end_date='2026-05-31' WHERE risk_class='high' AND end_date IS NULL`).run();
    await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',400,'2026-06-01')`).run();
    await db.prepare(`UPDATE employee_salary_components SET effective_to='2026-06-30' WHERE employee_id='E-A' AND effective_to IS NULL`).run();
    await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
                VALUES ('E-A',?,?,'2026-07-01')`).run(cBasic, money.rupiahToSen(25000000));
  });

  const after = await db.prepare('SELECT * FROM payroll_run_lines WHERE id=?').get(line.id);
  eq(after.gross_sen, beforeGross, 'gross unchanged: ');
  eq(after.result_hash, beforeHash, 'result hash unchanged: ');
  eq(JSON.parse(after.result_payload).rule_versions.jkk_rate_bp, 127, 'still the old JKK rate: ');
  // and a LIVE recalculation genuinely differs, proving the world moved
  const live = calc.calculate(resolver.buildPayload(await resolver.resolve(db, 'E-A', pClean)));
  eq(live.rule_versions.jkk_rate_bp, 400, 'live sees the new rate: ');
});

await check('13. CORRECTION after finalization creates a NEW run, history preserved', async () => {
  const runs = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=? ORDER BY run_number').all(pClean);
  eq(runs.length, 2, 'the original plus a correction run: ');
  eq(runs[0].status, 'FINALIZED', 'original untouched: ');
  eq(runs[0].run_number, 1);
  eq(runs[1].run_number, 2);
  // The finalized run's lines are still there in full.
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(runs[0].id)).n, 2);
  eq((await runLib.getHistory(db, runs[0].id)).length >= 6, true, 'full transition history retained: ');
});

// =============================================================================
section('ROLLBACK, ISOLATION, SCALE');
// =============================================================================

await check('14. ROLLBACK during a transition leaves the prior state intact', async () => {
  const pRb = await makePeriod(gKahe, 2027, 2);
  await makeEmp('E-RB'); await assign('E-RB'); await addComp('E-RB', 8000000); await addTs('E-RB', '2027-02-15');
  const run = await prepareRun(pRb, { toStatus: 'VALIDATED' });
  const before = await reload(run.id);
  const eventsBefore = (await runLib.getHistory(db, run.id)).length;

  let threw = false;
  try {
    await withTransaction(db, async () => {
      await runLib.approve(db, await reload(run.id), APPROVER, 'akan gagal');
      throw new Error('simulated failure after approval');
    });
  } catch (e) { threw = true; }
  eq(threw, true);
  const after = await reload(run.id);
  eq(after.status, before.status, 'status rolled back: ');
  eq(after.approved_by, null, 'approver rolled back: ');
  eq((await runLib.getHistory(db, run.id)).length, eventsBefore, 'no orphan event: ');
});

await check('15. LEGAL ENTITY ISOLATION: a run only ever contains its own entity', async () => {
  const pMitra = await makePeriod(gMitra, 2026, 6);
  await makeEmp('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra }); await addComp('E-MITRA', 7000000);
  await addTs('E-MITRA', '2026-06-15');
  const run = await prepareRun(pMitra, { toStatus: 'CALCULATED' });
  const lines = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id=?').all(run.id);
  eq(lines.every((l) => l.legal_entity_id === 'MITRA'), true);
  eq(lines.some((l) => l.employee_id === 'E-A'), false, 'no KAHE employee leaked in: ');
  eq((await reload(run.id)).legal_entity_id, 'MITRA');
  // and the calculated JKK is MITRA's, not KAHE's
  eq(JSON.parse(lines[0].result_payload).bpjs.jkk.rate_bp, 89);
});

await check('a snapshot from another entity is refused by the run calculator', async () => {
  const mitraRun = await db.prepare(`SELECT * FROM payroll_runs WHERE legal_entity_id='MITRA'`).get();
  const kaheSnapshot = await db.prepare(`SELECT * FROM payroll_input_snapshots WHERE legal_entity_id='KAHE360' LIMIT 1`).get();
  const out = await withTransaction(db, async () => await runCalc.calculateOne(db, mitraRun, kaheSnapshot));
  eq(out.outcome, 'ENTITY_MISMATCH');
});

await check('16. 1,500 EMPLOYEE RUN transitions through the full lifecycle', async () => {
  const pBulk = await makePeriod(gKahe, 2027, 3);
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_account_no) VALUES (?,?,'internal','active','2026-01-01','PPB','111')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source) VALUES (?, '2027-03-15','present',480,8,'none','WORKDAY','test')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await insE.run(id, id); await insA.run(id, wp5, cal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });

  await writer.snapshotPeriod(db, pBulk, { chunkSize: 200, resolvedBy: 'Payroll Officer' });
  await writer.freezePeriod(db, pBulk, 'Payroll Officer');
  const run = await withTransaction(db, async () => await runLib.createRun(db, pBulk, PREPARER));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), PREPARER, 'frozen'));

  const chunkSizes = [];
  const summary = await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 200, onChunk: (c) => chunkSizes.push(c.size) });
  // The period's group also contains earlier fixtures, so assert the BULK
  // cohort specifically rather than an exact grand total.
  const bulkLines = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_run_lines
    WHERE payroll_run_id = ? AND employee_id LIKE 'BULK-%'`).get(run.id)).n;
  eq(bulkLines, 1500, 'lines created for the 1,500 cohort: ');
  eq(summary.created >= 1500, true, `total created (${summary.created}): `);
  eq(summary.chunks >= 8, true, `bounded chunks (${summary.chunks}): `);
  eq(Math.max(...chunkSizes) <= 200, true, 'no chunk exceeded the bound: ');

  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now() WHERE id=?`).run('Payroll Officer', run.id);
    await runLib.recordEvent(db, run.id, 'SNAPSHOT_READY', 'CALCULATED', 'Payroll Officer', 'bulk');
  });
  await validationRunner.validatePeriod(db, pBulk, { chunkSize: 200, detectedAt: '2027-04-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`).run('Payroll Officer', run.id);
    await runLib.recordEvent(db, run.id, 'CALCULATED', 'VALIDATED', 'Payroll Officer', 'bulk');
  });

  const approved = await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), APPROVER, 'bulk ok'));
  eq(approved.run.status, 'APPROVED');
  const fin = await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), APPROVER, 'bulk final'));
  eq(fin.lines >= 1500, true, `finalized lines (${fin.lines}): `);
  eq((await reload(run.id)).status, 'FINALIZED');

  // Totals reconcile exactly in integer sen.
  const totals = await runCalc.getRunTotals(db, run.id);
  const bulkGross = (await db.prepare(`SELECT COALESCE(SUM(gross_sen),0) AS n FROM payroll_run_lines
    WHERE payroll_run_id = ? AND employee_id LIKE 'BULK-%'`).get(run.id)).n;
  eq(rp(bulkGross), 1500 * 5000000, 'cohort gross reconciles exactly: ');
  const lineSum = (await db.prepare('SELECT COALESCE(SUM(net_sen),0) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(run.id)).n;
  eq(lineSum, totals.net_sen, 'line sum equals aggregate: ');

  // And the whole cohort is now locked.
  const anyLine = await db.prepare('SELECT id FROM payroll_run_lines WHERE payroll_run_id=? LIMIT 1').get(run.id);
  await throwsMatching(async () => await db.prepare('UPDATE payroll_run_lines SET net_sen=0 WHERE id=?').run(anyLine.id), /PAYROLL_FINALIZED/);
});

await check('IDEMPOTENT recalculation: re-running calculate creates no duplicate lines', async () => {
  const pRb = (await db.prepare('SELECT id FROM payroll_periods WHERE payroll_group_id=? AND period_sequence=2 AND period_year=2027').get(gKahe)).id;
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE payroll_period_id=?').get(pRb);
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(run.id)).n;
  const again = await runCalc.calculateRun(db, run, { chunkSize: 50 });
  eq(again.created, 0, 'nothing new created: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id=?').get(run.id)).n, before);
});

await check('Phase 2E builds NO payment, bank export or payslip delivery', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 2H: payment tables now exist. What this
  // test guards is unchanged and is asserted below: this module writes no
  // payment row of its own.
  const paymentRows = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_batches').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM payroll_payment_items').get()).n;
  eq(paymentRows, 0, 'this phase must create no payment record: ');
  eq(tables.includes('payroll_runs'), true);
});

// =============================================================================
section('17. REGRESSION');
// =============================================================================

await check('all prior invariant indexes still present, plus the new ones', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee','uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class','uq_holiday_national_per_date','uq_emp_salary_component_open',
    'uq_salary_component_open_global','uq_salary_component_open_scoped','uq_work_calendar_open_code',
    'uq_payroll_group_open_code','uq_payroll_period_group_cycle','uq_payroll_period_group_start',
    'uq_snapshot_period_employee','uq_exception_snapshot_code','uq_payroll_run_single_finalized_original']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('all seven Phase 2E immutability triggers are installed', async () => {
  // Asserts PRESENCE, not exclusivity — Phase 2F legitimately adds two more
  // (payslip update/delete locks).
  const triggers = (await pgx.triggerNames(db)).map((t) => t.name);
  for (const req of ['trg_lock_finalized_run_line_update','trg_lock_finalized_run_line_delete',
    'trg_lock_finalized_component_update','trg_lock_finalized_component_delete',
    'trg_lock_finalized_snapshot_update','trg_lock_finalized_snapshot_delete',
    'trg_lock_finalized_run_status']) {
    if (!triggers.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

await check('the calculator remains PURE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  eq(requires, ['./money', './time']);
});

await check('prior canonical libraries behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq((await dc.classifyDay(db, 'E-B', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-B', '2026-06-15')).eligible, true);
  eq((await pp.resolvePeriodForDate(db, 'E-B', '2026-06-15')).period.id, pClean);
});

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2E TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
