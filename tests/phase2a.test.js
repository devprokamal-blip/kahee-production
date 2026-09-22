(async () => {
// tests/phase2a.test.js
// Phase 2A — Payroll Groups & Payroll Periods. Throwaway database.
// Usage: npm run test:phase2a

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const pp = require('../lib/payrollPeriod');

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

const TEST_DB = path.join(__dirname, 'phase2a.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase2a');
const db = __t.db;
await initDb(db);

// ---- fixtures ---------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('KAHE360','KAHE','internal','high','2026-01-01')`).run();
await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date) VALUES ('MITRA','Mitra Jaya','subkontraktor','high','2026-01-01')`).run();
const wp5 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('5H',5,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;
const wp6 = (await db.prepare(`INSERT INTO work_patterns (name,days_per_week,weekly_rest_day,effective_date) VALUES ('6H',6,'sunday','2026-01-01') RETURNING id`).run()).lastInsertRowid;

async function makeGroup(code, opts = {}) {
  const o = { name: code, legal_entity_id: 'KAHE360', frequency: 'monthly', periods_per_year: 12,
    att: 0, ot: 0, adj: 2, pay: 5, effective_from: '2026-01-01', ...opts };
  return (await db.prepare(`INSERT INTO payroll_groups
    (code,name,legal_entity_id,project_code,frequency,periods_per_year,
     attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,
     payment_offset_days,effective_from,created_by)
    VALUES (?,?,?,NULL,?,?,?,?,?,?,?,'test') RETURNING id`)
    .run(code, o.name, o.legal_entity_id, o.frequency, o.periods_per_year, o.att, o.ot, o.adj, o.pay, o.effective_from))
    .lastInsertRowid;
}
async function makePeriod(groupId, year, seq, overrides = {}) {
  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(groupId);
  const w = overrides.window || pp.monthlyWindow(year, seq);
  const d = pp.deriveDates(group, w.periodStart, w.periodEnd);
  return (await db.prepare(`INSERT INTO payroll_periods
    (payroll_group_id,period_year,period_sequence,period_month,period_start,period_end,
     attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'test') RETURNING id`)
    .run(groupId, year, seq, seq, d.period_start, d.period_end,
      d.attendance_cutoff, d.overtime_cutoff, d.adjustment_cutoff, d.payment_date,
      overrides.status || 'OPEN')).lastInsertRowid;
}
async function makeEmployee(id) {
  await db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
              VALUES (?,?,'internal','active','2026-01-01','PPB')`).run(id, id);
}
async function assign(id, { entity = 'KAHE360', pattern = wp5, group = null, from = '2026-01-01', to = null } = {}) {
  return (await db.prepare(`INSERT INTO employee_payroll_assignments
    (employee_id,legal_entity_id,work_pattern_id,payroll_group_id,marital_status,dependents_count,effective_date,end_date)
    VALUES (?,?,?,?,'TK',0,?,?) RETURNING id`).run(id, entity, pattern, group, from, to)).lastInsertRowid;
}

const gKahe = await makeGroup('KAHE-MONTHLY');
const gMitra = await makeGroup('MITRA-MONTHLY', { legal_entity_id: 'MITRA' });

// =============================================================================
section('PAYROLL GROUP');
// =============================================================================

await check('group stores scope, frequency, calendar link and offset policy', async () => {
  const g = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(gKahe);
  eq(g.legal_entity_id, 'KAHE360'); eq(g.frequency, 'monthly'); eq(g.periods_per_year, 12);
  eq(g.adjustment_cutoff_offset_days, 2); eq(g.payment_offset_days, 5);
  eq(g.status, 'active'); eq(g.effective_to, null);
});

await check('frequency is configurable, not hardcoded', async () => {
  const weekly = await makeGroup('WEEKLY-CREW', { frequency: 'weekly', periods_per_year: 52 });
  eq(await db.prepare('SELECT frequency, periods_per_year FROM payroll_groups WHERE id = ?').get(weekly),
    { frequency: 'weekly', periods_per_year: 52 });
  await throws(async () => await makeGroup('BAD-FREQ', { frequency: 'fortnightly' }), 'unknown frequency must be rejected');
});

await check('two open versions of one group code are rejected', async () => {
  await throws(async () => await makeGroup('KAHE-MONTHLY'), 'duplicate open group code must be impossible');
});

await check('group revision closes the old version and preserves it', async () => {
  const g = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(gKahe);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_groups SET effective_to = kahe_date_add('2026-07-01'::date, -1), status='superseded' WHERE id = ?`).run(gKahe);
    await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,frequency,periods_per_year,
      attendance_cutoff_offset_days,overtime_cutoff_offset_days,adjustment_cutoff_offset_days,
      payment_offset_days,effective_from,created_by)
      VALUES ('KAHE-MONTHLY','KAHE Bulanan (rev)','KAHE360','monthly',12,0,0,3,7,'2026-07-01','test')`).run();
  });
  const versions = await db.prepare(`SELECT * FROM payroll_groups WHERE code='KAHE-MONTHLY' ORDER BY effective_from`).all();
  eq(versions.length, 2);
  eq(versions[0].effective_to, '2026-06-30');
  eq(versions[0].payment_offset_days, 5, 'old policy preserved: ');
  eq(versions[1].payment_offset_days, 7, 'new policy: ');
  // restore a single open version for the rest of the suite
  await db.prepare(`DELETE FROM payroll_groups WHERE code='KAHE-MONTHLY' AND effective_from='2026-07-01'`).run();
  await db.prepare(`UPDATE payroll_groups SET effective_to=NULL, status='active' WHERE id=?`).run(gKahe);
  eq((await db.prepare('SELECT payment_offset_days FROM payroll_groups WHERE id=?').get(gKahe)).payment_offset_days, g.payment_offset_days);
});

// =============================================================================
section('PAYROLL PERIOD — identity, dates, duplicates, overlap');
// =============================================================================

const pJun = await makePeriod(gKahe, 2026, 6);

await check('NORMAL MONTHLY period has exact boundaries and derived cutoffs', async () => {
  const p = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pJun);
  eq(p.period_start, '2026-06-01'); eq(p.period_end, '2026-06-30');
  eq(p.attendance_cutoff, '2026-06-30', 'offset 0: ');
  eq(p.overtime_cutoff, '2026-06-30');
  eq(p.adjustment_cutoff, '2026-07-02', 'offset +2 crosses the month end: ');
  eq(p.payment_date, '2026-07-05', 'offset +5: ');
});

await check('month lengths are exact (28/29/30/31) and leap-safe', () => {
  eq(pp.monthlyWindow(2026, 2).periodEnd, '2026-02-28', 'Feb 2026: ');
  eq(pp.monthlyWindow(2028, 2).periodEnd, '2028-02-29', 'Feb 2028 leap: ');
  eq(pp.monthlyWindow(2026, 4).periodEnd, '2026-04-30');
  eq(pp.monthlyWindow(2026, 12).periodEnd, '2026-12-31');
});

await check('TIMEZONE SAFETY: boundaries are UTC-derived and independent of TZ', () => {
  const original = process.env.TZ;
  const results = [];
  for (const tz of ['UTC', 'Asia/Jakarta', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    results.push([pp.monthlyWindow(2026, 6).periodEnd, pp.addDays('2026-06-30', 5), pp.lastDayOfMonth(2026, 2)]);
  }
  process.env.TZ = original;
  for (const r of results) eq(r, ['2026-06-30', '2026-07-05', '2026-02-28'], 'same in every timezone: ');
});

await check('DUPLICATE PERIOD for the same group/year/sequence is rejected by the DB', async () => {
  await throws(async () => await makePeriod(gKahe, 2026, 6), 'duplicate group+year+sequence must be impossible');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE payroll_group_id=? AND period_year=2026 AND period_sequence=6').get(gKahe)).n, 1);
});

await check('two periods of one group cannot share a start date', async () => {
  await throws(async () => await db.prepare(`INSERT INTO payroll_periods
    (payroll_group_id,period_year,period_sequence,period_start,period_end,
     attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date)
    VALUES (?,2026,99,'2026-06-01','2026-06-15','2026-06-15','2026-06-15','2026-06-17','2026-06-20')`).run(gKahe),
    'same start date in one group must be impossible');
});

await check('OVERLAPPING period is detected (compensating control for range exclusion)', async () => {
  const clash = await pp.findOverlappingPeriod(db, gKahe, '2026-06-15', '2026-07-15');
  if (!clash) throw new Error('overlap with June should have been detected');
  eq(clash.id, pJun);
  eq(await pp.findOverlappingPeriod(db, gKahe, '2026-07-01', '2026-07-31'), null, 'adjacent July is fine: ');
});

await check('period_end before period_start is rejected by CHECK', async () => {
  await throws(async () => await db.prepare(`INSERT INTO payroll_periods
    (payroll_group_id,period_year,period_sequence,period_start,period_end,
     attendance_cutoff,overtime_cutoff,adjustment_cutoff,payment_date)
    VALUES (?,2026,98,'2026-08-31','2026-08-01','2026-08-31','2026-08-31','2026-09-02','2026-09-05')`).run(gKahe),
    'inverted range must be rejected');
});

// =============================================================================
section('PERIOD OWNERSHIP — "which period owns this date for employee X?"');
// =============================================================================

await makeEmployee('E-5DAY'); await assign('E-5DAY', { pattern: wp5, group: gKahe });
await makeEmployee('E-6DAY'); await assign('E-6DAY', { pattern: wp6, group: gKahe });

await check('a date inside the period resolves to that period', async () => {
  const r = await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-06-15');
  eq(r.status, 'OK'); eq(r.period.id, pJun); eq(r.group.id, gKahe);
});

await check('5-day and 6-day employees in one group share the same period', async () => {
  eq((await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-06-20')).period.id, pJun);
  eq((await pp.resolvePeriodForDate(db, 'E-6DAY', '2026-06-20')).period.id, pJun, '6-day employee: ');
  // Work pattern affects day classification (Phase 1B), never period ownership.
});

await check('PERIOD BOUNDARIES are inclusive on both ends', async () => {
  eq((await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-06-01')).period.id, pJun, 'first day: ');
  eq((await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-06-30')).period.id, pJun, 'last day: ');
  eq((await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-05-31')).status, 'NO_PERIOD', 'day before: ');
  eq((await pp.resolvePeriodForDate(db, 'E-5DAY', '2026-07-01')).status, 'NO_PERIOD', 'day after: ');
});

await check('a date with no assignment is flagged, never guessed', async () => {
  await makeEmployee('E-NONE');
  const r = await pp.resolvePeriodForDate(db, 'E-NONE', '2026-06-15');
  eq(r.status, 'MISSING_ASSIGNMENT'); eq(r.period, null);
});

await check('an assignment with no group is flagged', async () => {
  await makeEmployee('E-NOGROUP'); await assign('E-NOGROUP', { group: null });
  const r = await pp.resolvePeriodForDate(db, 'E-NOGROUP', '2026-06-15');
  eq(r.status, 'MISSING_PAYROLL_GROUP'); eq(r.period, null);
});

await check('JOINER around the boundary: only days from the start date are owned', async () => {
  await makeEmployee('E-JOIN');
  await assign('E-JOIN', { group: gKahe, from: '2026-06-16' });
  eq((await pp.resolvePeriodForDate(db, 'E-JOIN', '2026-06-15')).status, 'MISSING_ASSIGNMENT', 'before joining: ');
  eq((await pp.resolvePeriodForDate(db, 'E-JOIN', '2026-06-16')).period.id, pJun, 'on joining day: ');
});

await check('LEAVER around the boundary: days after the end date are not owned', async () => {
  await makeEmployee('E-LEAVE');
  await assign('E-LEAVE', { group: gKahe, from: '2026-01-01', to: '2026-06-20' });
  eq((await pp.resolvePeriodForDate(db, 'E-LEAVE', '2026-06-20')).period.id, pJun, 'last day: ');
  eq((await pp.resolvePeriodForDate(db, 'E-LEAVE', '2026-06-21')).status, 'MISSING_ASSIGNMENT', 'day after: ');
});

await check('GROUP CHANGE MID-PERIOD: each date resolves to the group owning it THAT DAY', async () => {
  const gSecond = await makeGroup('KAHE-SECOND');
  const pJunSecond = await makePeriod(gSecond, 2026, 6);
  await makeEmployee('E-SWITCH');
  await withTransaction(db, async () => {
    await assign('E-SWITCH', { group: gKahe, from: '2026-01-01', to: '2026-06-14' });
    await assign('E-SWITCH', { group: gSecond, from: '2026-06-15' });
  });
  eq((await pp.resolvePeriodForDate(db, 'E-SWITCH', '2026-06-10')).period.id, pJun, 'first half: ');
  eq((await pp.resolvePeriodForDate(db, 'E-SWITCH', '2026-06-20')).period.id, pJunSecond, 'second half: ');
  eq((await pp.resolvePeriodForDate(db, 'E-SWITCH', '2026-06-20')).group.code, 'KAHE-SECOND');
});

// =============================================================================
section('CUTOFFS & LIFECYCLE');
// =============================================================================

await check('CUTOFF DATES gate each stream INDEPENDENTLY', async () => {
  const p = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pJun);
  // 1 July: attendance and overtime are past cutoff, adjustments still open.
  eq(pp.isStreamOpen(p, 'attendance', '2026-07-01').open, false, 'attendance on 1 Jul: ');
  eq(pp.isStreamOpen(p, 'attendance', '2026-07-01').reason, 'PAST_CUTOFF');
  eq(pp.isStreamOpen(p, 'overtime', '2026-07-01').open, false, 'overtime on 1 Jul: ');
  eq(pp.isStreamOpen(p, 'adjustment', '2026-07-01').open, true, 'adjustment on 1 Jul: ');
  eq(pp.isStreamOpen(p, 'adjustment', '2026-07-03').open, false, 'adjustment after its cutoff: ');
  // This asymmetry is exactly why a single CUTOFF status was rejected.
});

await check('cutoff day itself is inclusive', async () => {
  const p = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pJun);
  eq(pp.isStreamOpen(p, 'attendance', '2026-06-30').open, true, 'on the cutoff date: ');
  eq(pp.isStreamOpen(p, 'attendance', '2026-07-01').open, false, 'the day after: ');
});

await check('a DRAFT period accepts nothing; a CLOSED period accepts nothing', async () => {
  const draft = { ...await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pJun), status: 'DRAFT' };
  eq(pp.isStreamOpen(draft, 'attendance', '2026-06-15').reason, 'PERIOD_NOT_OPEN');
  const closed = { ...draft, status: 'CLOSED' };
  eq(pp.isStreamOpen(closed, 'adjustment', '2026-06-15').reason, 'PERIOD_CLOSED');
});

await check('LIFECYCLE transitions are restricted and CLOSED is terminal', () => {
  eq(pp.canTransition('DRAFT', 'OPEN'), true);
  eq(pp.canTransition('DRAFT', 'CLOSED'), false, 'cannot close an unopened period: ');
  eq(pp.canTransition('OPEN', 'CUTOFF'), true);
  eq(pp.canTransition('CUTOFF', 'OPEN'), true, 'reopening for a late correction is allowed: ');
  eq(pp.canTransition('CLOSED', 'OPEN'), false, 'CLOSED is terminal in Phase 2A: ');
  eq(pp.canTransition('CLOSED', 'CUTOFF'), false);
});

await check('PERIOD CLOSING records who and when', async () => {
  const pAug = await makePeriod(gKahe, 2026, 8);
  await withTransaction(db, async () => {
    await db.prepare(`UPDATE payroll_periods SET status='CLOSED', closed_at=kahe_now(), closed_by='Tester' WHERE id=?`).run(pAug);
  });
  const p = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pAug);
  eq(p.status, 'CLOSED'); eq(p.closed_by, 'Tester');
  if (!p.closed_at) throw new Error('closed_at must be recorded');
});

await check('period lifecycle is SEPARATE from future run states', async () => {
  const statuses = (await pgx.tableSql(db, 'payroll_periods')).sql;
  for (const runState of ['Calculated', 'Validated', 'Approved', 'Finalized', 'Paid']) {
    if (statuses.includes(runState)) throw new Error(`period status must not include the run state ${runState}`);
  }
  eq(Object.keys(pp.PERIOD_STATUS), ['DRAFT', 'OPEN', 'CUTOFF', 'CLOSED']);
});

// =============================================================================
section('ISOLATION, SCALE, TRANSACTIONS');
// =============================================================================

await check('LEGAL ENTITY ISOLATION: a MITRA employee never resolves to a KAHE period', async () => {
  const pJunMitra = await makePeriod(gMitra, 2026, 6);
  await makeEmployee('E-MITRA'); await assign('E-MITRA', { entity: 'MITRA', group: gMitra });
  const r = await pp.resolvePeriodForDate(db, 'E-MITRA', '2026-06-15');
  eq(r.period.id, pJunMitra);
  eq(r.group.legal_entity_id, 'MITRA');
  if (r.period.id === pJun) throw new Error('cross-entity leak');
  // and the same calendar date exists as a distinct period per entity
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE period_start=? ').get('2026-06-01')).n >= 2, true);
});

await check('a group is always bound to a legal entity (NOT NULL)', async () => {
  await throws(async () => await db.prepare(`INSERT INTO payroll_groups (code,name,legal_entity_id,effective_from)
    VALUES ('NOENTITY','No Entity',NULL,'2026-01-01')`).run(), 'legal_entity_id must be required');
});

await check('SCALE: 1,500 workers produce 1,500 membership rows, not rows-per-day', async () => {
  await withTransaction(db, async () => {
    const ins = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
                            VALUES (?,?,'internal','active','2026-01-01','PPB')`);
    const asg = db.prepare(`INSERT INTO employee_payroll_assignments
      (employee_id,legal_entity_id,work_pattern_id,payroll_group_id,marital_status,dependents_count,effective_date)
      VALUES (?, 'KAHE360', ?, ?, 'TK', 0, '2026-01-01')`);
    for (let i = 0; i < 1500; i += 1) {
      const id = `BULK-${String(i).padStart(4, '0')}`;
      await ins.run(id, id); await asg.run(id, wp5, gKahe);
    }
  });
  const members = await pp.getGroupMembership(db, gKahe, '2026-06-01', '2026-06-30');
  eq(members.length >= 1500, true, `membership rows (${members.length}) should cover all bulk workers: `);
  // The period table itself does NOT grow with headcount.
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE payroll_group_id=? AND period_year=2026 AND period_sequence=6').get(gKahe)).n, 1,
    'still exactly ONE June period for 1,500 workers: ');
});

await check('membership windows are clamped to the period for joiners and leavers', async () => {
  const members = await pp.getGroupMembership(db, gKahe, '2026-06-01', '2026-06-30');
  const joiner = members.find((m) => m.employee_id === 'E-JOIN');
  const leaver = members.find((m) => m.employee_id === 'E-LEAVE');
  eq(joiner.member_from, '2026-06-16', 'joiner clamped to their start: ');
  eq(joiner.member_to, '2026-06-30', 'joiner clamped to period end: ');
  eq(leaver.member_from, '2026-06-01', 'leaver clamped to period start: ');
  eq(leaver.member_to, '2026-06-20', 'leaver clamped to their end: ');
});

await check('TRANSACTION ROLLBACK: a failed period batch leaves nothing behind', async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods').get()).n;
  await throws(async () => await withTransaction(db, async () => {
    await makePeriod(gKahe, 2027, 1);
    await makePeriod(gKahe, 2027, 2);
    await makePeriod(gKahe, 2027, 1);   // duplicate -> violates the unique index
  }));
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods').get()).n, before, 'count unchanged after rollback: ');
});

await check('IDEMPOTENT creation: re-creating the same cycle yields one row', async () => {
  const groupId = gKahe;
  const create = async () => {
    const existing = await db.prepare('SELECT * FROM payroll_periods WHERE payroll_group_id=? AND period_year=? AND period_sequence=?')
      .get(groupId, 2026, 9);
    if (existing) return existing.id;
    return await makePeriod(groupId, 2026, 9);
  };
  const first = await create();
  const second = await create();
  eq(first, second, 'same id returned: ');
  eq((await db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE payroll_group_id=? AND period_year=2026 AND period_sequence=9').get(groupId)).n, 1);
});

await check('CHUNK/RESTART READY: membership is stable and orderable for chunking', async () => {
  const all = await pp.getGroupMembership(db, gKahe, '2026-06-01', '2026-06-30');
  const again = await pp.getGroupMembership(db, gKahe, '2026-06-01', '2026-06-30');
  eq(all.map((m) => m.employee_id), again.map((m) => m.employee_id), 'deterministic order across calls: ');
  // A chunked run can slice this list and resume from an offset.
  const chunk1 = all.slice(0, 100); const chunk2 = all.slice(100, 200);
  eq(chunk1.length, 100); eq(chunk2.length, 100);
  eq(new Set([...chunk1, ...chunk2].map((m) => m.employee_id)).size, 200, 'chunks do not overlap: ');
});

// =============================================================================
section('SCOPE LOCK & REGRESSION');
// =============================================================================

await check('SCOPE LOCK: no money/calculation concept appears in this domain', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payrollPeriod.js'), 'utf8');
  // Strip comments first: the header comment legitimately NAMES the forbidden
  // concepts in order to forbid them. Only executable code is scanned.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const token of ['_sen', 'applyBp', 'gross', 'net_pay', 'bpjs', 'ter_rate', 'multiplier']) {
    if (code.toLowerCase().includes(token.toLowerCase())) {
      throw new Error(`payrollPeriod.js code must not reference calculation concept: ${token}`);
    }
  }
  const schema = (await pgx.tableSql(db, 'payroll_periods')).sql;
  const schemaCode = schema.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const token of ['_sen', 'gross', 'net', 'tax', 'bpjs']) {
    if (schemaCode.toLowerCase().includes(token)) throw new Error(`payroll_periods must not store ${token}`);
  }
});

await check('all prior invariant indexes still present', async () => {
  const names = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_assignment_open_per_employee', 'uq_payroll_rule_set_single_active',
    'uq_jkk_open_per_risk_class', 'uq_holiday_national_per_date', 'uq_emp_salary_component_open',
    'uq_salary_component_open_global', 'uq_salary_component_open_scoped', 'uq_work_calendar_open_code',
    'uq_payroll_group_open_code', 'uq_payroll_period_group_cycle', 'uq_payroll_period_group_start']) {
    if (!names.includes(req)) throw new Error(`missing index: ${req}`);
  }
});

await check('Phase 0B/1A/1B libraries still work alongside the new domain', async () => {
  const time = require('../lib/time');
  const money = require('../lib/money');
  const dc = require('../lib/dayClassification');
  const eligibility = require('../lib/employeeEligibility');
  eq(time.hoursToMinutes(7.25), 435);
  eq(money.applyBp(800000000, 370), 29600000);
  await db.prepare(`INSERT INTO work_calendars (code,name,legal_entity_id,project_code,effective_from)
              VALUES ('DEFAULT','Default',NULL,NULL,'2026-01-01')`).run();
  eq((await dc.classifyDay(db, 'E-5DAY', '2026-06-15')).dayType, 'WORKDAY');
  eq((await eligibility.isEligibleOn(db, 'E-5DAY', '2026-06-15')).eligible, true);
});

// ---- summary ----------------------------------------------------------------
db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 2A TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
