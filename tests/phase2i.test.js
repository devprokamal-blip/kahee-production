(async () => {
// tests/phase2i.test.js
// Phase 2I — Legal Entity Read Scope / Tenant Isolation. Throwaway database.
// Usage: npm run test:phase2i

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const scope = require('../lib/entityScope');
const writer = require('../lib/snapshotWriter');
const validationRunner = require('../lib/validationRunner');
const runLib = require('../lib/payrollRun');
const runCalc = require('../lib/runCalculator');
const payslip = require('../lib/payslip');
const adjLib = require('../lib/payrollAdjustment');
const pay = require('../lib/payrollPayment');
const pp = require('../lib/payrollPeriod');
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
async function throwsCode(fn, code, label = '') {
  try { await fn(); } catch (e) {
    if (e.code !== code) throw new Error(`${label}expected ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(`${label}expected a throw with code ${code}`);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase2i.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2i');
const db = __t.db;
await initDb(db);

// ---- fixtures -----------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB','Indramayu','active')`).run();
for (const [id, name, risk] of [['KAHE360','KAHE','high'], ['MITRA','Mitra Jaya','medium'], ['THIRD','Pihak Ketiga','low']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,?,'2026-01-01')`).run(id, name, id === 'KAHE360' ? 'internal' : 'subkontraktor', risk);
}
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','D',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
for (const [rc, bp] of [['high',127],['medium',89],['low',54]])
  await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES (?,?,'2026-01-01')`).run(rc, bp);
const rsId = (await db.prepare(`INSERT INTO payroll_rule_sets
  (name,status,effective_date,bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
   jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,jkm_rate_bp,
   overtime_hourly_divisor,overtime_is_taxable,overtime_is_bpjs_base)
  VALUES ('RS','active','2026-01-01',100,400,1200000000,200,370,100,200,1054740000,30,173,1,0) RETURNING id`).run()).lastInsertRowid;
for (const [c,lo,hi,bp] of [['A',0,540000000,0],['A',540000000,null,150],['B',0,620000000,0],['C',0,660000000,0]])
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,?,?,?,?)`).run(rsId,c,lo,hi,bp);
for (const [dt,hf,ht,m] of [['workday',1,1,15000],['workday',2,null,20000],['rest_or_holiday_5day',1,8,20000]])
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,?,?,?,?)`).run(rsId,dt,hf,ht,m);

const groups = {};
const periods = {};
for (const e of ['KAHE360','MITRA','THIRD']) {
  groups[e] = (await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
    attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,
    require_warning_acknowledgement,effective_from) VALUES (?,?,?,'monthly',12,0,0,2,5,0,'2026-01-01') RETURNING id`)
    .run(`${e}-M`, `${e} Bulanan`, e)).lastInsertRowid;
  const w = pp.monthlyWindow(2026, 6);
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(groups[e]);
  const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
  periods[e] = (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,2026,6,6,?,?,?,?,?,?,'OPEN') RETURNING id`).run(groups[e], d.period_start, d.period_end,
    d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date)).lastInsertRowid;
}
const cBasic = (await db.prepare(`INSERT INTO salary_components (code,name,component_type,calculation_type,paid_by,
  is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
  VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function hire(id, entity) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_name,bank_account_no,bank_account_name)
              VALUES (?,?,'pkwt','active','2026-01-01','PPB','BCA','1234567890',?)`).run(id, `Nama ${id}`, `Nama ${id}`);
  await db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,
    payroll_group_id,marital_status,dependents_count,effective_date) VALUES (?,?,?,?,?,'TK',0,'2026-01-01')`)
    .run(id, entity, wp5, cal, groups[entity]);
  await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
              VALUES (?,?,?,'2026-01-01')`).run(id, cBasic, money.rupiahToSen(8000000));
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,
    overtime_status,day_type,day_type_source) VALUES (?, '2026-06-15','present',480,8,'none','WORKDAY','t')`).run(id);
}
await hire('E-KAHE','KAHE360'); await hire('E-MITRA','MITRA'); await hire('E-THIRD','THIRD');

// ---- users with explicit scopes -------------------------------------------------
async function makeUser(name, entities, perms) {
  const id = (await db.prepare(`INSERT INTO users (email,password_hash,display_name,is_active) VALUES (?,?,?,1) RETURNING id`)
    .run(`${name}@t.local`, 'x', name)).lastInsertRowid;
  for (const e of entities) await scope.grantEntity(db, id, e, 'test-admin');
  return { id, displayName: name, permissions: perms, entityScope: entities };
}
const FULL = { payroll_run: ['VIEW','CREATE','EDIT','APPROVE'], payroll_payment: ['VIEW','CREATE','EDIT','EXPORT','APPROVE'] };
const U_KAHE   = await makeUser('Scoped KAHE', ['KAHE360'], FULL);
const U_MITRA  = await makeUser('Scoped MITRA', ['MITRA'], FULL);
const U_BOTH   = await makeUser('Scoped BOTH', ['KAHE360','MITRA'], FULL);
const U_NONE   = await makeUser('Unscoped Director', [], FULL);   // every permission, no entity
const U_OVERRIDE = await makeUser('Auditor', [], { ...FULL, payroll_entity_override: ['ADMIN'] });

const reload = async (id) => await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
async function fullCycle(entity, actor, approver) {
  const period = periods[entity];
  await writer.snapshotPeriod(db, period, { chunkSize: 100, resolvedBy: actor.displayName });
  await writer.freezePeriod(db, period, actor.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, period, actor));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), actor, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 100 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=?,prepared_at=kahe_now() WHERE id=?`).run(actor.displayName, run.id);
  });
  await validationRunner.validatePeriod(db, period, { chunkSize: 100, detectedAt: '2026-07-01 00:00:00' });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_exceptions SET resolution_status='RESOLVED',resolved_by='x',resolved_at=kahe_now(),resolution_note='ok'
                WHERE payroll_period_id=? AND blocking=1`).run(period);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=? WHERE id=?`).run(actor.displayName, run.id);
  });
  await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), approver, 'ok'));
  await withTransaction(db, async () => await runLib.finalize(db, await reload(run.id), approver, 'final'));
  await withTransaction(db, async () => {
    for (const l of await db.prepare(`SELECT id FROM payroll_run_lines WHERE payroll_run_id=? AND calc_status='OK'`).all(run.id)) {
      await payslip.generate(db, l.id, { generatedBy: actor.displayName });
    }
  });
  const batch = (await withTransaction(db, async () => await pay.prepareBatch(db, period, actor))).batch;
  return { run: await reload(run.id), batch, period };
}
const PREP_K = { displayName: 'Prep K', permissions: FULL, entityScope: ['KAHE360'], id: U_KAHE.id };
const APPR   = { displayName: 'Appr', permissions: FULL, entityScope: ['KAHE360','MITRA','THIRD'], id: U_BOTH.id };
const CYC_KAHE  = await fullCycle('KAHE360', PREP_K, APPR);
const CYC_MITRA = await fullCycle('MITRA', { ...PREP_K, displayName: 'Prep M', entityScope: ['MITRA'] }, APPR);

// =============================================================================
section('SCOPE MODEL');
// =============================================================================

await check('scope is explicit: rows exist per user per entity', async () => {
  eq(await scope.getUserEntities(db, U_KAHE.id), ['KAHE360']);
  eq(await scope.getUserEntities(db, U_MITRA.id), ['MITRA']);
  eq(await scope.getUserEntities(db, U_BOTH.id), ['KAHE360','MITRA'], 'one user, two entities: ');
  eq(await scope.getUserEntities(db, U_NONE.id), [], 'no implicit grant: ');
});

await check('VIEW permission alone grants NOTHING cross-entity', async () => {
  // U_NONE holds every payroll permission and no entity scope.
  eq(U_NONE.permissions.payroll_run.includes('VIEW'), true, 'has VIEW: ');
  eq(await scope.canAccessEntity(db, U_NONE, 'KAHE360', { resourceType: 'payroll_run' }), false);
  eq(await scope.canAccessEntity(db, U_NONE, 'MITRA', { resourceType: 'payroll_run' }), false);
  const sc = await scope.scopeClause(db, U_NONE, 'legal_entity_id', { resourceType: 'payroll_run' });
  eq(sc.sql, '1=0', 'list query matches nothing: ');
});

await check('the override permission is granted to NO role by the seed', () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', 'database', 'seed.js'), 'utf8');
  if (!/ENTITY_OVERRIDE_MODULE/.test(seed)) throw new Error('override module not defined in seed');
  if (!/\[SOD_OVERRIDE_MODULE,\s*ENTITY_OVERRIDE_MODULE\]\.includes\(m\)/.test(seed)) {
    throw new Error('operations_director blanket grant must exclude the entity override');
  }
  eq([...seed.matchAll(/payroll_entity_override:\s*\[/g)].length, 0, 'no role literally grants it: ');
});

// =============================================================================
section('READ ISOLATION ACROSS EVERY RESOURCE');
// =============================================================================

const RESOURCES = async () => ({
  payroll_run:      CYC_MITRA.run.id,
  payroll_run_line: (await db.prepare('SELECT id FROM payroll_run_lines WHERE payroll_run_id=?').get(CYC_MITRA.run.id)).id,
  payslip:          (await db.prepare('SELECT id FROM payroll_payslips WHERE payroll_run_id=?').get(CYC_MITRA.run.id)).id,
  payment_batch:    CYC_MITRA.batch.id,
  payment_item:     (await db.prepare('SELECT id FROM payroll_payment_items WHERE batch_id=?').get(CYC_MITRA.batch.id)).id,
  snapshot:         (await db.prepare('SELECT id FROM payroll_input_snapshots WHERE payroll_period_id=?').get(CYC_MITRA.period)).id,
  exception:        (await db.prepare('SELECT id FROM payroll_exceptions WHERE payroll_period_id=?').get(CYC_MITRA.period)).id,
  payroll_period:   CYC_MITRA.period,
  payroll_group:    groups.MITRA,
});

await check('1. a user scoped to KAHE cannot read ANY MITRA resource', async () => {
  for (const [type, id] of Object.entries(await RESOURCES())) {
    await throwsCode(async () => await scope.assertResourceAccess(db, U_KAHE, type, id, '/test'),
      scope.ERROR.NOT_FOUND, `${type}: `);
  }
});

await check('2. a user scoped to MITRA cannot read KAHE resources', async () => {
  const kaheRun = CYC_KAHE.run.id;
  const kaheSlip = (await db.prepare('SELECT id FROM payroll_payslips WHERE payroll_run_id=?').get(kaheRun)).id;
  await throwsCode(async () => await scope.assertResourceAccess(db, U_MITRA, 'payroll_run', kaheRun, '/test'), scope.ERROR.NOT_FOUND);
  await throwsCode(async () => await scope.assertResourceAccess(db, U_MITRA, 'payslip', kaheSlip, '/test'), scope.ERROR.NOT_FOUND);
  await throwsCode(async () => await scope.assertResourceAccess(db, U_MITRA, 'payment_batch', CYC_KAHE.batch.id, '/test'), scope.ERROR.NOT_FOUND);
});

await check('3. a user scoped to BOTH can read both', async () => {
  eq(await scope.assertResourceAccess(db, U_BOTH, 'payroll_run', CYC_KAHE.run.id, '/test'), 'KAHE360');
  eq(await scope.assertResourceAccess(db, U_BOTH, 'payroll_run', CYC_MITRA.run.id, '/test'), 'MITRA');
  // and still cannot reach a third entity they were never granted
  const thirdGroup = groups.THIRD;
  await throwsCode(async () => await scope.assertResourceAccess(db, U_BOTH, 'payroll_group', thirdGroup, '/test'), scope.ERROR.NOT_FOUND);
});

await check('4. DIRECT-ID access from an unauthorized entity returns NOT_FOUND, not FORBIDDEN', async () => {
  const err = await throwsCode(async () => await scope.assertResourceAccess(db, U_KAHE, 'payroll_run', CYC_MITRA.run.id, '/test'),
    scope.ERROR.NOT_FOUND);
  // The message must not reveal that the record exists elsewhere.
  if (/MITRA|entity|forbidden|akses/i.test(err.message)) {
    throw new Error(`message leaks information: ${err.message}`);
  }
  eq(err.message, 'Data tidak ditemukan.');
  // identical to a genuinely absent record
  const absent = await throwsCode(async () => await scope.assertResourceAccess(db, U_KAHE, 'payroll_run', 999999, '/test'),
    scope.ERROR.NOT_FOUND);
  eq(absent.message, err.message, 'indistinguishable from "not there": ');
});

await check('ID ENUMERATION is impossible: list queries are filtered in SQL', async () => {
  const sc = await scope.scopeClause(db, U_KAHE, 'legal_entity_id', { resourceType: 'payroll_run' });
  const visible = await db.prepare(`SELECT id, legal_entity_id FROM payroll_runs WHERE ${sc.sql}`).all(...sc.params);
  eq(visible.every((r) => r.legal_entity_id === 'KAHE360'), true);
  eq(visible.some((r) => r.id === CYC_MITRA.run.id), false, 'MITRA run not enumerable: ');
  // sweep every id in the table — none from another entity is reachable
  const allRuns = await db.prepare('SELECT id FROM payroll_runs').all();
  let reachable = 0;
  for (const r of allRuns) {
    try { await scope.assertResourceAccess(db, U_KAHE, 'payroll_run', r.id, '/sweep'); reachable += 1; } catch (e) { /* denied */ }
  }
  eq(reachable, visible.length, 'reachable count equals visible count exactly: ');
});

await check('5. PAYSLIP isolation, including the per-employee listing', async () => {
  const sc = await scope.scopeClause(db, U_KAHE, 'legal_entity_id', { resourceType: 'payslip' });
  const rows = await db.prepare(`SELECT employee_id FROM payroll_payslips WHERE employee_id = ? AND ${sc.sql}`)
    .all('E-MITRA', ...sc.params);
  eq(rows.length, 0, 'a KAHE user listing a MITRA employee sees nothing: ');
  const own = await db.prepare(`SELECT employee_id FROM payroll_payslips WHERE employee_id = ? AND ${sc.sql}`)
    .all('E-KAHE', ...sc.params);
  eq(own.length, 1, 'their own entity is visible: ');
});

await check('6. PAYMENT isolation: batches and items', async () => {
  const sc = await scope.scopeClause(db, U_MITRA, 'legal_entity_id', { resourceType: 'payment_batch' });
  const batches = await db.prepare(`SELECT id, legal_entity_id FROM payroll_payment_batches WHERE ${sc.sql}`).all(...sc.params);
  eq(batches.every((b) => b.legal_entity_id === 'MITRA'), true);
  eq(batches.some((b) => b.id === CYC_KAHE.batch.id), false);
  const items = await db.prepare(`SELECT legal_entity_id FROM payroll_payment_items WHERE ${sc.sql}`).all(...sc.params);
  eq(items.every((i) => i.legal_entity_id === 'MITRA'), true);
});

await check('7. EXCEPTION isolation', async () => {
  const sc = await scope.scopeClause(db, U_KAHE, 'legal_entity_id', { resourceType: 'exception' });
  const rows = await db.prepare(`SELECT legal_entity_id FROM payroll_exceptions WHERE payroll_period_id = ? AND ${sc.sql}`)
    .all(CYC_MITRA.period, ...sc.params);
  eq(rows.length, 0, 'KAHE user sees no MITRA exception: ');
});

await check('8. CORRECTION / REVERSAL isolation', async () => {
  const a = await withTransaction(db, async () => await adjLib.createAdjustment(db, {
    source_run_id: CYC_MITRA.run.id, employee_id: 'E-MITRA', adjustment_type: adjLib.TYPE.RETRO_EARNING,
    component_code: 'RETRO', direction: 'CREDIT', amount_sen: money.rupiahToSen(100000), reason: 'retro',
  }, { displayName: 'Prep M' }));
  eq(a.legal_entity_id, 'MITRA');
  await throwsCode(async () => await scope.assertResourceAccess(db, U_KAHE, 'adjustment', a.id, '/test'), scope.ERROR.NOT_FOUND);
  eq(await scope.assertResourceAccess(db, U_MITRA, 'adjustment', a.id, '/test'), 'MITRA', 'own entity can: ');
  const sc = await scope.scopeClause(db, U_KAHE, 'legal_entity_id', { resourceType: 'adjustment' });
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_adjustments WHERE ${sc.sql}`).get(...sc.params)).n, 0,
    'KAHE user enumerates no MITRA adjustment: ');
});

await check('SNAPSHOT isolation', async () => {
  const mitraSnap = (await db.prepare('SELECT id FROM payroll_input_snapshots WHERE legal_entity_id=? LIMIT 1').get('MITRA')).id;
  await throwsCode(async () => await scope.assertResourceAccess(db, U_KAHE, 'snapshot', mitraSnap, '/test'), scope.ERROR.NOT_FOUND);
  eq(await scope.assertResourceAccess(db, U_BOTH, 'snapshot', mitraSnap, '/test'), 'MITRA');
});

// =============================================================================
section('OVERRIDE & AUDIT');
// =============================================================================

await check('9. OVERRIDE grants access and is AUDITED with full context', async () => {
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='OVERRIDE_ALLOWED'`).get()).n;
  eq(await scope.assertResourceAccess(db, U_OVERRIDE, 'payroll_run', CYC_MITRA.run.id, '/api/payroll/runs/x'), 'MITRA');
  const rows = await db.prepare(`SELECT * FROM entity_access_audit WHERE outcome='OVERRIDE_ALLOWED' ORDER BY id DESC LIMIT 1`).all();
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='OVERRIDE_ALLOWED'`).get()).n, before + 1);
  const a = rows[0];
  eq(a.actor, 'Auditor');
  eq(a.requested_entity, 'MITRA');
  eq(a.resource_type, 'payroll_run');
  eq(String(a.resource_id), String(CYC_MITRA.run.id));
  eq(JSON.parse(a.authorized_scope), [], 'records that they held no scope: ');
  eq(a.route, '/api/payroll/runs/x');
  if (!a.occurred_at) throw new Error('timestamp missing');
});

await check('DENIED attempts are audited too', async () => {
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='DENIED'`).get()).n;
  try { await scope.assertResourceAccess(db, U_KAHE, 'payroll_run', CYC_MITRA.run.id, '/api/payroll/runs/y'); } catch (e) { /* expected */ }
  const after = (await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='DENIED'`).get()).n;
  eq(after, before + 1);
  const a = await db.prepare(`SELECT * FROM entity_access_audit WHERE outcome='DENIED' ORDER BY id DESC LIMIT 1`).get();
  eq(a.actor, 'Scoped KAHE');
  eq(a.requested_entity, 'MITRA');
  eq(JSON.parse(a.authorized_scope), ['KAHE360'], 'records what they did hold: ');
});

await check('a genuinely absent record is NOT audited as a cross-entity attempt', async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM entity_access_audit').get()).n;
  try { await scope.assertResourceAccess(db, U_KAHE, 'payroll_run', 999999, '/test'); } catch (e) { /* expected */ }
  eq((await db.prepare('SELECT COUNT(*) AS n FROM entity_access_audit').get()).n, before, 'no false positive in the audit: ');
});

await check('an unscoped user hitting a LIST query is audited once and sees nothing', async () => {
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='DENIED'`).get()).n;
  const sc = await scope.scopeClause(db, U_NONE, 'legal_entity_id', { resourceType: 'payroll_run', route: '/api/payroll/runs' });
  eq(sc.sql, '1=0');
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_runs WHERE ${sc.sql}`).get()).n, 0);
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM entity_access_audit WHERE outcome='DENIED'`).get()).n, before + 1);
});

// =============================================================================
section('RBAC / SoD PRESERVED · ROUTE COVERAGE');
// =============================================================================

await check('existing RBAC and SoD are unchanged', async () => {
  // SoD still refuses a self-approval even for a fully scoped user
  const p3 = await (async () => {
    const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(groups.THIRD);
    const w = pp.monthlyWindow(2026, 7); const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
    return (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
      period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
      VALUES (?,2026,7,7,?,?,?,?,?,?,'OPEN') RETURNING id`).run(groups.THIRD, d.period_start, d.period_end,
      d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date)).lastInsertRowid;
  })();
  const actor = { displayName: 'Prep T', permissions: FULL, entityScope: ['THIRD'] };
  await writer.snapshotPeriod(db, p3, { chunkSize: 50, resolvedBy: actor.displayName });
  await writer.freezePeriod(db, p3, actor.displayName);
  const run = await withTransaction(db, async () => await runLib.createRun(db, p3, actor));
  await withTransaction(db, async () => await runLib.markSnapshotReady(db, await reload(run.id), actor, 'f'));
  await runCalc.calculateRun(db, await reload(run.id), { chunkSize: 50 });
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_runs SET status='CALCULATED',prepared_by=? WHERE id=?`).run(actor.displayName, run.id);
    await db.prepare(`UPDATE payroll_runs SET status='VALIDATED',validated_by=? WHERE id=?`).run(actor.displayName, run.id);
  });
  await throwsCode(async () => await withTransaction(db, async () => await runLib.approve(db, await reload(run.id), actor, 'sendiri')),
    runLib.TRANSITION_ERROR.SOD_VIOLATION, 'SoD intact: ');
});

await check('every payroll route is still permission-gated AND now entity-guarded', () => {
  const dir = path.join(__dirname, '..', 'routes', 'payroll');
  let total = 0, ungated = 0;
  const filesWithoutScope = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/require\('\.\.\/\.\.\/lib\/entityScope'\)/.test(src)) filesWithoutScope.push(f);
    for (const m of src.matchAll(/router\.(get|post|put|delete)\('([^']+)'\s*,\s*([^,]+),/g)) {
      total += 1;
      if (!/requirePermission/.test(m[3])) ungated += 1;
    }
  }
  eq(ungated, 0, `ungated routes (of ${total}): `);
  eq(filesWithoutScope, [], 'every payroll route file imports the scope guard: ');
});

await check('the global handler maps a scope error to 404', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  if (!/err\.name === 'EntityAccessError'/.test(src)) throw new Error('global handler does not map EntityAccessError');
  if (!/status\(404\)/.test(src.slice(src.indexOf("EntityAccessError")))) throw new Error('must map to 404');
  const err = new scope.EntityAccessError(scope.ERROR.NOT_FOUND, 'Data tidak ditemukan.');
  eq(err.name, 'EntityAccessError');
});

// =============================================================================
section('SCALE & REGRESSION');
// =============================================================================

await check('10. 1,500-worker scenario is unaffected by scoping', async () => {
  const grp = await db.prepare('SELECT * FROM payroll_groups WHERE id=?').get(groups.KAHE360);
  const w = pp.monthlyWindow(2027, 1); const d = pp.deriveDates(grp, w.periodStart, w.periodEnd);
  const pScale = (await db.prepare(`INSERT INTO payroll_periods (payroll_group_id,period_year,period_sequence,period_month,
    period_start,period_end,attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,2027,1,1,?,?,?,?,?,?,'OPEN') RETURNING id`).run(groups.KAHE360, d.period_start, d.period_end,
    d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date)).lastInsertRowid;
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code,bank_name,bank_account_no,bank_account_name)
      VALUES (?,?,'pkwt','active','2026-01-01','PPB','BCA',?,?)`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date)
      VALUES (?,'KAHE360',?,?,?,'TK',0,'2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from) VALUES (?,?,?,'2026-01-01')`);
    const insT = db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,overtime_status,day_type,day_type_source)
      VALUES (?, '2027-01-15','present',480,8,'none','WORKDAY','t')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `SC-${String(i).padStart(4,'0')}`;
      await insE.run(id, `Scale ${i}`, String(3000000000 + i), `Scale ${i}`);
      await insA.run(id, wp5, cal, groups.KAHE360); await insC.run(id, cBasic, money.rupiahToSen(5000000)); await insT.run(id);
    }
  });
  const t0 = Date.now();
  const snap = await writer.snapshotPeriod(db, pScale, { chunkSize: 200, resolvedBy: 'scale' });
  // The group also holds earlier fixtures, so assert the cohort specifically.
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_input_snapshots WHERE payroll_period_id=? AND employee_id LIKE 'SC-%'`)
    .get(pScale)).n, 1500, 'cohort snapshots: ');
  eq(snap.created >= 1500, true);
  // the scoped list query still returns the whole cohort for an authorised user
  const sc = await scope.scopeClause(db, U_KAHE, 'legal_entity_id', { resourceType: 'snapshot' });
  const visible = (await db.prepare(`SELECT COUNT(*) AS n FROM payroll_input_snapshots WHERE payroll_period_id=? AND ${sc.sql}`)
    .get(pScale, ...sc.params)).n;
  eq(visible >= 1500, true, `authorised user sees the full cohort (${visible}): `);
  const scM = await scope.scopeClause(db, U_MITRA, 'legal_entity_id', { resourceType: 'snapshot' });
  eq((await db.prepare(`SELECT COUNT(*) AS n FROM payroll_input_snapshots WHERE payroll_period_id=? AND ${scM.sql}`)
    .get(pScale, ...scM.params)).n, 0, 'MITRA user sees none of it: ');
  console.log(`\n     1,500 snapshots + scoped queries in ${Date.now() - t0}ms`);
});

await check('the audit table did not explode under the scale run', async () => {
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM entity_access_audit').get()).n;
  eq(n < 100, true, `audit rows (${n}) should reflect attempts, not row reads: `);
});

await check('MIGRATION is idempotent and NOT permissive by default', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrate-phase2i.js'), 'utf8');
  if (!/grantAllToDirectors = false/.test(src)) throw new Error('default must not grant all entities');
  if (!/INSERT INTO user_legal_entity_scope[\s\S]*?ON CONFLICT DO NOTHING/.test(src)) throw new Error('grant must be idempotent');
  // running the grant twice yields one row
  await scope.grantEntity(db, U_KAHE.id, 'KAHE360', 'again');
  await scope.grantEntity(db, U_KAHE.id, 'KAHE360', 'again');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM user_legal_entity_scope WHERE user_id=? AND legal_entity_id=?')
    .get(U_KAHE.id, 'KAHE360')).n, 1);
});

await check('revoking a scope takes effect immediately', async () => {
  eq(await scope.canAccessEntity(db, U_BOTH, 'MITRA', { resourceType: 'payroll_run' }), true);
  await scope.revokeEntity(db, U_BOTH.id, 'MITRA');
  const fresh = { ...U_BOTH, entityScope: await scope.getUserEntities(db, U_BOTH.id) };
  eq(fresh.entityScope, ['KAHE360']);
  eq(await scope.canAccessEntity(db, fresh, 'MITRA', { resourceType: 'payroll_run' }), false);
});

await check('prior invariants and triggers are untouched', async () => {
  const idx = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_run_single_finalized_original','uq_snapshot_period_employee',
    'uq_payment_item_live_per_period','uq_adjustment_external_reference']) {
    if (!idx.includes(req)) throw new Error(`missing index: ${req}`);
  }
  const trg = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_status','trg_lock_payslip_update','trg_lock_applied_adjustment','trg_lock_exported_payment_item']) {
    if (!trg.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2I TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
