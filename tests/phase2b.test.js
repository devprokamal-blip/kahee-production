(async () => {
// tests/phase2b.test.js
// Phase 2B — As-Of Resolver & Snapshot Writer. Throwaway database.
// Usage: npm run test:phase2b

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const resolver = require('../lib/asOfResolver');
const writer = require('../lib/snapshotWriter');
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
async function throws(fn, label = 'expected a throw') {
  let t = false; try { await fn(); } catch (e) { t = true; }
  if (!t) throw new Error(label);
}
function hasError(result, code) {
  return (result.errors || []).some((e) => e.code === code);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase2b.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2b');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra','subkontraktor','medium','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const calGlobal = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from) VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

// JKK versions: 'high' = 127bp until 2026-06-30, 135bp from 2026-07-01
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date,end_date) VALUES ('high',127,'2026-01-01','2026-06-30')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('high',135,'2026-07-01')`).run();
await db.prepare(`INSERT INTO jkk_risk_classes (risk_class,rate_bp,effective_date) VALUES ('medium',89,'2026-01-01')`).run();

async function makeRuleSet(name, effDate, endDate, jhtCompanyBp, status = 'active') {
  const id = (await db.prepare(`INSERT INTO payroll_rule_sets
    (name,status,effective_date,end_date,
     bpjs_kesehatan_rate_employee_bp,bpjs_kesehatan_rate_company_bp,bpjs_kesehatan_salary_cap_sen,
     jht_rate_employee_bp,jht_rate_company_bp,jp_rate_employee_bp,jp_rate_company_bp,jp_salary_cap_sen,
     jkm_rate_bp,overtime_hourly_divisor)
    VALUES (?,?,?,?,100,400,1200000000,200,?,100,200,1054740000,30,173) RETURNING id`)
    .run(name, status, effDate, endDate, jhtCompanyBp)).lastInsertRowid;
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,'A',0,540000000,0)`).run(id);
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,'A',540000000,NULL,150)`).run(id);
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,'B',0,620000000,0)`).run(id);
  await db.prepare(`INSERT INTO ptkp_ter_rates (rule_set_id,category,income_min_sen,income_max_sen,rate_bp) VALUES (?,'C',0,660000000,0)`).run(id);
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,'workday',1,1,15000)`).run(id);
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,'workday',2,NULL,20000)`).run(id);
  await db.prepare(`INSERT INTO overtime_multiplier_rules (rule_set_id,day_type,hour_from,hour_to,multiplier_bp) VALUES (?,'rest_or_holiday_5day',1,8,20000)`).run(id);
  return id;
}
// Rule set v1 until 2026-06-30 (JHT company 370bp), v2 from 2026-07-01 (380bp)
const rs1 = await makeRuleSet('RS 2026 H1', '2026-01-01', '2026-06-30', 370, 'superseded');
const rs2 = await makeRuleSet('RS 2026 H2', '2026-07-01', null, 380, 'active');

const gKahe = (await db.prepare(`INSERT INTO payroll_groups
  (code,name,legal_entity_id,frequency,periods_per_year,attendance_cutoff_offset_days,
   overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,effective_from)
  VALUES ('KAHE-M','KAHE Bulanan','KAHE360','monthly',12,0,0,2,5,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
const gMitra = (await db.prepare(`INSERT INTO payroll_groups
  (code,name,legal_entity_id,frequency,periods_per_year,attendance_cutoff_offset_days,
   overtime_cutoff_offset_days,adjustment_cutoff_offset_days,payment_offset_days,effective_from)
  VALUES ('MITRA-M','Mitra Bulanan','MITRA','monthly',12,0,0,2,5,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makePeriod(groupId, year, seq, status = 'OPEN') {
  const g = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(groupId);
  const w = pp.monthlyWindow(year, seq);
  const d = pp.deriveDates(g, w.periodStart, w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods
    (payroll_group_id,period_year,period_sequence,period_month,period_start,period_end,
     attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(groupId, year, seq, seq, d.period_start, d.period_end,
      d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date, status)).lastInsertRowid;
}
const pJun = await makePeriod(gKahe, 2026, 6);   // rule set v1 / JKK 127bp era
const pJul = await makePeriod(gKahe, 2026, 7);   // rule set v2 / JKK 135bp era
const pJunMitra = await makePeriod(gMitra, 2026, 6);

const cBasic = (await db.prepare(`INSERT INTO salary_components
  (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
  VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,'2026-01-01') RETURNING id`).run()).lastInsertRowid;
const cSite = (await db.prepare(`INSERT INTO salary_components
  (code,name,component_type,calculation_type,paid_by,is_taxable,is_bpjs_base,is_overtime_base,is_proratable,recurrence,calculation_order,effective_from)
  VALUES ('ALLOW_SITE','Tunjangan Lokasi','earning','fixed','employee',1,0,0,1,'recurring',30,'2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makeEmployee(id, opts = {}) {
  const o = { worker_type: 'internal', status: 'active', start_date: '2026-01-01', termination_date: null, ...opts };
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,termination_date,project_code)
              VALUES (?,?,?,?,?,?,'PPB')`).run(id, id, o.worker_type, o.status, o.start_date, o.termination_date);
}
async function assign(id, o = {}) {
  const a = { entity: 'KAHE360', group: gKahe, from: '2026-01-01', to: null, marital: 'TK', dep: 0, ...o };
  return (await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(id, a.entity, wp5, calGlobal, a.group, a.marital, a.dep, a.from, a.to)).lastInsertRowid;
}
async function addComponent(id, componentId, rupiah, from, to = null) {
  return (await db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from,effective_to)
                     VALUES (?,?,?,?,?) RETURNING id`).run(id, componentId, money.rupiahToSen(rupiah), from, to)).lastInsertRowid;
}
async function addTimesheet(id, date, minutes, otMinutes = 0, dayType = 'WORKDAY') {
  return (await db.prepare(`INSERT INTO timesheet_entries
    (employee_id,work_date,attendance_status,work_minutes,work_hours,
     overtime_minutes_approved,overtime_hours_approved,overtime_status,day_type,day_type_source)
    VALUES (?,?,'present',?,?,?,?,?,?,'work_pattern:1') RETURNING id`)
    .run(id, date, minutes, time.minutesToHours(minutes), otMinutes, time.minutesToHours(otMinutes),
      otMinutes > 0 ? 'approved' : 'none', dayType)).lastInsertRowid;
}

// =============================================================================
section('AS-OF RESOLVER — normal case & version pinning');
// =============================================================================

await makeEmployee('E-NORMAL');
await assign('E-NORMAL');
await addComponent('E-NORMAL', cBasic, 8000000, '2026-01-01');
await addComponent('E-NORMAL', cSite, 1000000, '2026-01-01');
await addTimesheet('E-NORMAL', '2026-06-15', 480, 180);
await addTimesheet('E-NORMAL', '2026-06-16', 480);

await check('NORMAL EMPLOYEE resolves every slice with status OK', async () => {
  const r = await resolver.resolve(db, 'E-NORMAL', pJun);
  eq(r.status, 'OK', `errors: ${JSON.stringify(r.errors)} — `);
  eq(r.asOfDate, '2026-06-30', 'as-of defaults to period_end: ');
  eq(r.legalEntity.id, 'KAHE360');
  eq(r.group.code, 'KAHE-M');
  eq(r.workPattern.days_per_week, 5);
  eq(r.structure.length, 2, 'components: ');
  eq(r.terCategory, 'A', 'TK/0 -> A: ');
  eq(r.workMinutesTotal, 960);
  eq(r.overtimeMinutesApproved, 180);
});

await check('NO "LATEST ROW": June pins rule set v1 and JKK 127bp, not the current ones', async () => {
  const jun = await resolver.resolve(db, 'E-NORMAL', pJun);
  eq(jun.ruleSet.id, rs1, 'June must use the H1 rule set: ');
  eq(jun.ruleSet.jht_rate_company_bp, 370);
  eq(jun.jkkVersion.rate_bp, 127, 'June JKK: ');
  // Live "latest" would be rs2 / 135bp — proving the resolver is date-bound.
  const latestRs = (await db.prepare("SELECT id FROM payroll_rule_sets WHERE status='active'").get()).id;
  eq(latestRs, rs2, 'the latest rule set really is a different one: ');
});

await check('BPJS RULE VERSION CHANGE: July resolves the newer rule set', async () => {
  const jul = await resolver.resolve(db, 'E-NORMAL', pJul);
  eq(jul.ruleSet.id, rs2, 'July rule set: ');
  eq(jul.ruleSet.jht_rate_company_bp, 380);
});

await check('JKK VERSION CHANGE: July resolves 135bp while June keeps 127bp', async () => {
  eq((await resolver.resolve(db, 'E-NORMAL', pJul)).jkkVersion.rate_bp, 135);
  eq((await resolver.resolve(db, 'E-NORMAL', pJun)).jkkVersion.rate_bp, 127, 'June unchanged: ');
});

await check('TAX RULE VERSION CHANGE: the TER table is pinned to the period rule set', async () => {
  const jun = await resolver.resolve(db, 'E-NORMAL', pJun);
  const jul = await resolver.resolve(db, 'E-NORMAL', pJul);
  eq(jun.terBrackets.every((b) => b.rule_set_id === rs1), true, 'June brackets from rs1: ');
  eq(jul.terBrackets.every((b) => b.rule_set_id === rs2), true, 'July brackets from rs2: ');
});

await check('OVERTIME RULE CHANGE follows the same rule-set pinning', async () => {
  eq((await resolver.resolve(db, 'E-NORMAL', pJun)).overtimeRules.every((r) => r.rule_set_id === rs1), true);
  eq((await resolver.resolve(db, 'E-NORMAL', pJul)).overtimeRules.every((r) => r.rule_set_id === rs2), true);
});

await check('an explicit as_of overrides the period default (for diagnosis)', async () => {
  // 2026-07-15 sits in the v2 era even though we ask about the June period.
  const r = await resolver.resolve(db, 'E-NORMAL', pJun, '2026-07-15');
  eq(r.ruleSet.id, rs2, 'explicit as_of wins: ');
  eq(r.asOfDate, '2026-07-15');
});

await check('TER CATEGORY derives from the PTKP status on the assignment', async () => {
  await makeEmployee('E-K2'); await assign('E-K2', { marital: 'K', dep: 2 });
  await addComponent('E-K2', cBasic, 9000000, '2026-01-01');
  eq((await resolver.resolve(db, 'E-K2', pJun)).terCategory, 'B', 'K/2 -> B: ');
  eq(resolver.deriveTerCategory('K', 3), 'C');
  eq(resolver.deriveTerCategory('TK', 1), 'A');
});

// =============================================================================
section('AS-OF RESOLVER — mid-period changes, joiner, leaver, calendar');
// =============================================================================

await check('MID-PERIOD SALARY CHANGE produces two structure segments', async () => {
  await makeEmployee('E-RAISE'); await assign('E-RAISE');
  await withTransaction(db, async () => {
    await addComponent('E-RAISE', cBasic, 8000000, '2026-01-01', '2026-06-14');
    await addComponent('E-RAISE', cBasic, 9500000, '2026-06-15');
  });
  const r = await resolver.resolve(db, 'E-RAISE', pJun);
  eq(r.structureSegments.length, 2, 'segments: ');
  eq(r.structureSegments[0].days, 14);
  eq(r.structureSegments[1].days, 16);
  eq(r.structureSegments[0].components[0].amount_sen, money.rupiahToSen(8000000));
  eq(r.structureSegments[1].components[0].amount_sen, money.rupiahToSen(9500000));
  // as-of = period_end, so the flat structure shows the LATER amount
  eq(r.structure[0].amount_sen, money.rupiahToSen(9500000), 'as-of structure: ');
});

await check('PAYROLL GROUP CHANGE mid-period is detected as an entity/group mismatch', async () => {
  await makeEmployee('E-GRPCHG');
  await withTransaction(db, async () => {
    await assign('E-GRPCHG', { group: gKahe, from: '2026-01-01', to: '2026-06-14' });
    await assign('E-GRPCHG', { entity: 'MITRA', group: gMitra, from: '2026-06-15' });
  });
  await addComponent('E-GRPCHG', cBasic, 7000000, '2026-01-01');
  // Resolving against the KAHE June period: as-of 30 June the employee is in
  // the MITRA group, so the resolver refuses rather than paying them from the
  // wrong entity's cycle.
  const wrong = await resolver.resolve(db, 'E-GRPCHG', pJun);
  eq(hasError(wrong, resolver.ERROR.ENTITY_MISMATCH), true, 'mismatch must be flagged: ');
  eq(wrong.status, 'INCOMPLETE');
  // Against the MITRA June period it resolves cleanly.
  const right = await resolver.resolve(db, 'E-GRPCHG', pJunMitra);
  eq(right.group.code, 'MITRA-M');
  eq(right.legalEntity.id, 'MITRA');
  eq(right.jkkVersion.rate_bp, 89, 'MITRA is medium risk, not high: ');
});

await check('JOINER mid-period: payable days reflect only the joined portion', async () => {
  await makeEmployee('E-JOIN', { start_date: '2026-06-16' });
  await assign('E-JOIN', { from: '2026-06-16' });
  await addComponent('E-JOIN', cBasic, 6000000, '2026-06-16');
  const r = await resolver.resolve(db, 'E-JOIN', pJun);
  eq(r.status, 'OK', `errors: ${JSON.stringify(r.errors)} — `);
  eq(r.eligibility.payableDays, 15, '16-30 June: ');
  eq(r.eligibility.totalDays, 30);
});

await check('LEAVER mid-period: payable days stop at the termination date', async () => {
  await makeEmployee('E-LEAVE', { termination_date: '2026-06-20', status: 'inactive' });
  await assign('E-LEAVE', { from: '2026-01-01', to: '2026-06-20' });
  await addComponent('E-LEAVE', cBasic, 6500000, '2026-01-01', '2026-06-20');
  const r = await resolver.resolve(db, 'E-LEAVE', pJun, '2026-06-20');
  eq(r.eligibility.payableDays, 20, '1-20 June: ');
});

await check('CALENDAR CHANGE: the calendar in force at the as-of date is resolved', async () => {
  const calOld = (await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from,effective_to,status)
    VALUES ('OLD','Kalender Lama',NULL,NULL,'2026-01-01','2026-03-31','superseded') RETURNING id`).run()).lastInsertRowid;
  await makeEmployee('E-CAL'); await assign('E-CAL');
  await db.prepare('UPDATE employee_payroll_assignments SET work_calendar_id = ? WHERE employee_id = ?').run(calOld, 'E-CAL');
  await addComponent('E-CAL', cBasic, 5000000, '2026-01-01');
  // June is outside the old calendar's window -> flagged, not silently swapped
  const r = await resolver.resolve(db, 'E-CAL', pJun);
  eq(hasError(r, resolver.ERROR.CALENDAR_UNRESOLVED), true, 'stale calendar must be flagged: ');
  // restore to the global calendar for later assertions
  await db.prepare('UPDATE employee_payroll_assignments SET work_calendar_id = ? WHERE employee_id = ?').run(calGlobal, 'E-CAL');
  eq((await resolver.resolve(db, 'E-CAL', pJun)).status, 'OK', 'after fixing: ');
});

// =============================================================================
section('AS-OF RESOLVER — deterministic failures, never guesses');
// =============================================================================

await check('MISSING ASSIGNMENT returns a named error, not a default', async () => {
  await makeEmployee('E-NOASSIGN');
  const r = await resolver.resolve(db, 'E-NOASSIGN', pJun);
  eq(r.status, 'INCOMPLETE');
  eq(hasError(r, resolver.ERROR.MISSING_ASSIGNMENT), true);
  eq(r.assignment, null, 'no fabricated assignment: ');
});

await check('AMBIGUOUS EFFECTIVE DATES (two overlapping assignments) are flagged', async () => {
  await makeEmployee('E-AMBIG');
  // The B5 index blocks two OPEN rows, so ambiguity is created with two
  // CLOSED-but-overlapping rows — a real corruption the resolver must catch.
  await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
    VALUES ('E-AMBIG','KAHE360',?,?,'TK',0,'2026-01-01','2026-12-31')`).run(wp5, gKahe);
  await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
    VALUES ('E-AMBIG','KAHE360',?,?,'K',2,'2026-06-01','2026-08-31')`).run(wp5, gKahe);
  const r = await resolver.resolve(db, 'E-AMBIG', pJun);
  eq(hasError(r, resolver.ERROR.AMBIGUOUS_ASSIGNMENT), true);
  eq(r.assignment, null, 'must not pick one: ');
});

await check('MISSING SALARY STRUCTURE is flagged', async () => {
  await makeEmployee('E-NOSAL'); await assign('E-NOSAL');
  eq(hasError(await resolver.resolve(db, 'E-NOSAL', pJun), resolver.ERROR.MISSING_SALARY_STRUCTURE), true);
});

await check('MISSING RULE SET for a date with no coverage is flagged', async () => {
  const p2025 = await makePeriod(gKahe, 2025, 12);
  await makeEmployee('E-2025'); await assign('E-2025', { from: '2025-01-01' });
  await addComponent('E-2025', cBasic, 5000000, '2025-01-01');
  const r = await resolver.resolve(db, 'E-2025', p2025);
  eq(hasError(r, resolver.ERROR.MISSING_RULE_SET), true, 'no rule set covers Dec 2025: ');
  eq(r.ruleSet, null);
});

await check('APPROVED OVERTIME on an unclassified day is flagged, never priced by default', async () => {
  await makeEmployee('E-OTNODAY'); await assign('E-OTNODAY');
  await addComponent('E-OTNODAY', cBasic, 6000000, '2026-01-01');
  await db.prepare(`INSERT INTO timesheet_entries
    (employee_id,work_date,attendance_status,work_minutes,overtime_minutes_approved,overtime_status,day_type)
    VALUES ('E-OTNODAY','2026-06-10','present',480,120,'approved',NULL)`).run();
  const r = await resolver.resolve(db, 'E-OTNODAY', pJun);
  eq(hasError(r, resolver.ERROR.UNCLASSIFIED_OVERTIME_DAY), true);
});

await check('an unknown employee or period fails cleanly', async () => {
  eq(hasError(await resolver.resolve(db, 'NOPE', pJun), resolver.ERROR.EMPLOYEE_NOT_FOUND), true);
  eq(hasError(await resolver.resolve(db, 'E-NORMAL', 99999), resolver.ERROR.PERIOD_NOT_FOUND), true);
});

await check('SCOPE LOCK: the resolver computes no money', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'asOfResolver.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const token of ['applyBp', 'overtimePaySen', 'hourlyRateSen', 'grossPay', 'netPay']) {
    if (code.includes(token)) throw new Error(`resolver must not call calculation helper: ${token}`);
  }
});

// =============================================================================
section('SNAPSHOT WRITER — creation, idempotency, duplicates');
// =============================================================================

await check('a snapshot captures source ids, version ids and effective dates', async () => {
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-NORMAL', pJun, { resolvedBy: 'test' }));
  eq(out.outcome, 'CREATED');
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(out.snapshotId);
  eq(snap.legal_entity_id, 'KAHE360');
  eq(snap.payroll_group_id, gKahe);
  eq(snap.payroll_rule_set_id, rs1, 'pinned to the June rule set: ');
  eq(snap.payroll_rule_set_effective_from, '2026-01-01');
  eq(snap.jkk_risk_class, 'high');
  eq(snap.jkk_rate_effective_from, '2026-01-01');
  eq(snap.ter_category, 'A');
  eq(snap.work_minutes_total, 960);
  eq(snap.overtime_minutes_approved, 180);
  eq(snap.status, 'DRAFT');
  if (!snap.payload_hash || snap.payload_hash.length !== 64) throw new Error('payload_hash must be a sha256 hex digest');
  const payload = JSON.parse(snap.resolved_payload);
  eq(payload.bpjs_rule.jht_rate_company_bp, 370, 'frozen BPJS values: ');
  eq(payload.jkk.rate_bp, 127, 'frozen JKK rate: ');
  eq(payload.tax.ter_brackets.length > 0, true, 'frozen TER table: ');
  eq(payload.overtime_rules.length > 0, true, 'frozen overtime rules: ');
  eq(payload.attendance.source_row_ids.length, 2, 'traceable source rows: ');
});

await check('DUPLICATE SNAPSHOT attempt is rejected by the database index', async () => {
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id = ? AND payroll_period_id = ?').get('E-NORMAL', pJun);
  await throws(async () => await db.prepare(`INSERT INTO payroll_input_snapshots
    (payroll_period_id,employee_id,as_of_date,legal_entity_id,payroll_group_id,
     resolved_payload,payload_hash,resolved_at)
    VALUES (?,?,?,?,?,'{}','x',kahe_now())`).run(pJun, 'E-NORMAL', '2026-06-30', 'KAHE360', gKahe),
    'two snapshots for one employee+period must be impossible');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NORMAL', pJun)).n, 1);
  eq(snap.id > 0, true);
});

await check('IDEMPOTENT RERUN: writeOne skips an existing snapshot instead of duplicating', async () => {
  const before = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NORMAL', pJun);
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-NORMAL', pJun, { resolvedBy: 'test' }));
  eq(out.outcome, 'SKIPPED_EXISTING');
  eq(out.snapshotId, before.id);
  const after = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NORMAL', pJun);
  eq(after.resolved_at, before.resolved_at, 'existing row untouched: ');
});

await check('an INCOMPLETE resolution is still snapshotted, with its errors recorded', async () => {
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-NOASSIGN', pJun, { resolvedBy: 'test' }));
  eq(out.outcome, 'CREATED');
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(out.snapshotId);
  eq(snap.resolution_status, 'INCOMPLETE');
  const errs = JSON.parse(snap.resolution_errors);
  eq(errs.some((e) => e.code === resolver.ERROR.MISSING_ASSIGNMENT), true);
  // The exception is preserved for the Exception Engine, not swallowed.
});

// =============================================================================
section('SNAPSHOT IMMUTABILITY — the point of the phase');
// =============================================================================

await check('HISTORICAL SNAPSHOT IS UNCHANGED after master data changes', async () => {
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NORMAL', pJun);
  const storedHash = snap.payload_hash;
  const storedPayload = JSON.parse(snap.resolved_payload);
  eq(storedPayload.salary_structure.find((c) => c.code === 'BASIC').amount_sen, money.rupiahToSen(8000000));

  // Master data changes AFTER the snapshot: a raise, and a JKK reprice.
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE employee_salary_components SET effective_to='2026-06-30' WHERE employee_id='E-NORMAL' AND component_id=? AND effective_to IS NULL`).run(cBasic);
    await addComponent('E-NORMAL', cBasic, 12000000, '2026-07-01');
  });

  const after = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(snap.id);
  eq(after.payload_hash, storedHash, 'hash unchanged: ');
  eq(JSON.parse(after.resolved_payload).salary_structure.find((c) => c.code === 'BASIC').amount_sen,
    money.rupiahToSen(8000000), 'June still shows the June salary: ');
});

await check('DRIFT DETECTION reports divergence WITHOUT rewriting the snapshot', async () => {
  // Uses an employee untouched by earlier tests, so the baseline is clean.
  // (Note: closing a component row changes its recorded window even when the
  // amount is unchanged — that legitimately counts as drift, which is why the
  // baseline here must be a fresh, unmodified subject.)
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-K2', pJun, { resolvedBy: 'drift-test' }));
  const snapId = out.snapshotId;

  const same = await writer.detectDrift(db, snapId);
  eq(same.drifted, false, 'no drift when nothing changed: ');
  eq(same.storedHash, same.currentHash);

  // Now change something that DOES affect the as-of view.
  await db.prepare(`INSERT INTO timesheet_entries (employee_id,work_date,attendance_status,work_minutes,work_hours,day_type,day_type_source)
              VALUES ('E-K2','2026-06-17','present',480,8,'WORKDAY','work_pattern:1')`).run();
  const drifted = await writer.detectDrift(db, snapId);
  eq(drifted.drifted, true, 'added attendance must show as drift: ');
  const unchanged = await db.prepare('SELECT payload_hash FROM payroll_input_snapshots WHERE id = ?').get(snapId);
  eq(unchanged.payload_hash, same.storedHash, 'the snapshot itself was NOT rewritten: ');
});

await check('FREEZING makes the snapshot immutable and is recorded', async () => {
  const result = await writer.freezePeriod(db, pJun, 'Tester');
  eq(result.frozen >= 1, true, 'rows frozen: ');
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE employee_id=? AND payroll_period_id=?').get('E-NORMAL', pJun);
  eq(snap.status, 'FROZEN');
  eq(snap.frozen_by, 'Tester');
  if (!snap.frozen_at) throw new Error('frozen_at must be recorded');
  // A frozen snapshot is never re-written by the writer.
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-NORMAL', pJun, { resolvedBy: 'test2' }));
  eq(out.outcome, 'FROZEN_UNCHANGED');
  eq((await db.prepare('SELECT resolved_by FROM payroll_input_snapshots WHERE id=?').get(snap.id)).resolved_by, 'test', 'resolver identity preserved: ');
});

await check('the payload hash is stable and order-independent', () => {
  const a = resolver.hashPayload({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
  const b = resolver.hashPayload({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
  eq(a, b, 'key order must not change the hash: ');
  const c = resolver.hashPayload({ x: 2, y: [1, 2], z: { a: 1, b: 2 } });
  if (a === c) throw new Error('a value change must change the hash');
});

// =============================================================================
section('LEGAL ENTITY ISOLATION, TRANSACTIONS, CHUNKING, SCALE');
// =============================================================================

await check('LEGAL ENTITY ISOLATION: snapshots carry their own entity and never cross', async () => {
  await makeEmployee('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra });
  await addComponent('E-MITRA', cBasic, 7500000, '2026-01-01');
  const out = await withTransaction(db, async () => await writer.writeOne(db, 'E-MITRA', pJunMitra, { resolvedBy: 'test' }));
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(out.snapshotId);
  eq(snap.legal_entity_id, 'MITRA');
  eq(snap.jkk_risk_class, 'medium');
  eq(JSON.parse(snap.resolved_payload).jkk.rate_bp, 89, 'MITRA rate, not KAHE: ');
  // No MITRA employee appears under a KAHE period.
  const kaheSnaps = (await db.prepare('SELECT employee_id FROM payroll_input_snapshots WHERE payroll_period_id = ?').all(pJun)).map((r) => r.employee_id);
  eq(kaheSnaps.includes('E-MITRA'), false, 'no cross-entity leak: ');
});

await check('TRANSACTION ROLLBACK: a failed snapshot batch leaves nothing behind', async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_input_snapshots').get()).n;
  await throws(async () => await withTransaction(db, async () => {
    await writer.writeOne(db, 'E-K2', pJun, { resolvedBy: 'test' });
    await writer.writeOne(db, 'E-RAISE', pJun, { resolvedBy: 'test' });
    throw new Error('simulated chunk failure');
  }));
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_input_snapshots').get()).n, before, 'count unchanged: ');
});

await check('CHUNKED generation is restartable and produces no duplicates', async () => {
  // 1,500 employees in the KAHE group for July.
  await withTransaction(db, async () => {
    const insE = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
                             VALUES (?,?,'internal','active','2026-01-01','PPB')`);
    const insA = db.prepare(`INSERT INTO employee_payroll_assignments
      (employee_id,legal_entity_id,work_pattern_id,work_calendar_id,payroll_group_id,marital_status,dependents_count,effective_date)
      VALUES (?, 'KAHE360', ?, ?, ?, 'TK', 0, '2026-01-01')`);
    const insC = db.prepare(`INSERT INTO employee_salary_components (employee_id,component_id,amount_sen,effective_from)
                             VALUES (?,?,?,'2026-01-01')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await insE.run(id, id); await insA.run(id, wp5, calGlobal, gKahe); await insC.run(id, cBasic, money.rupiahToSen(5000000));
    }
  });

  const chunkSizes = [];
  const first = await writer.snapshotPeriod(db, pJul, { chunkSize: 200, resolvedBy: 'bulk', onChunk: (c) => chunkSizes.push(c.size) });
  eq(first.created >= 1500, true, `created (${first.created}) should cover the bulk cohort: `);
  eq(first.chunks >= 8, true, `chunks (${first.chunks}) must be bounded, not one giant transaction: `);
  eq(Math.max(...chunkSizes) <= 200, true, 'no chunk exceeded the bound: ');

  // RESTART: running again creates nothing new and duplicates nothing.
  const second = await writer.snapshotPeriod(db, pJul, { chunkSize: 200, resolvedBy: 'bulk' });
  eq(second.created, 0, 'rerun created: ');
  eq(second.total, 0, 'nothing pending after a complete run: ');

  const dupes = await db.prepare(`SELECT employee_id, COUNT(*) AS n FROM payroll_input_snapshots
                            WHERE payroll_period_id = ? GROUP BY employee_id HAVING COUNT(*) > 1`).all(pJul);
  eq(dupes.length, 0, 'no duplicate snapshots: ');
});

await check('PARTIAL RESTART: after deleting some rows only the pending set is redone', async () => {
  const victims = await db.prepare(`SELECT id, employee_id FROM payroll_input_snapshots WHERE payroll_period_id = ? LIMIT 25`).all(pJul);
  await withTransaction(db, async () => {
    for (const v of victims) await db.prepare('DELETE FROM payroll_input_snapshots WHERE id = ?').run(v.id);
  });
  eq((await writer.getPendingEmployees(db, pJul)).length, 25, 'pending set after simulated crash: ');
  const resume = await writer.snapshotPeriod(db, pJul, { chunkSize: 10, resolvedBy: 'resume' });
  eq(resume.created, 25, 'only the missing ones were redone: ');
  eq((await writer.getPendingEmployees(db, pJul)).length, 0, 'nothing pending after resume: ');
});

// =============================================================================
section('REGRESSION — Phase 0 / 0B / 1A / 1B / 2A');
// =============================================================================

await check('all prior invariant indexes still present, plus the new one', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee', 'uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class', 'uq_holiday_national_per_date', 'uq_emp_salary_component_open',
    'uq_salary_component_open_global', 'uq_salary_component_open_scoped', 'uq_work_calendar_open_code',
    'uq_payroll_group_open_code', 'uq_payroll_period_group_cycle', 'uq_payroll_period_group_start',
    'uq_snapshot_period_employee']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('prior canonical libraries still behave identically', async () => {
  const dc = require('../lib/dayClassification');
  const elig = require('../lib/employeeEligibility');
  const sal = require('../lib/salaryStructure');
  eq(money.applyBp(800000000, 370), 29600000);
  eq(time.hoursToMinutes(7.25), 435);
  eq((await dc.classifyDay(db, 'E-NORMAL', '2026-06-15')).dayType, 'WORKDAY');
  eq((await elig.isEligibleOn(db, 'E-NORMAL', '2026-06-15')).eligible, true);
  eq((await sal.getStructureOn(db, 'E-NORMAL', '2026-06-15')).length, 2);
  eq((await pp.resolvePeriodForDate(db, 'E-NORMAL', '2026-06-15')).period.id, pJun);
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2B TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
