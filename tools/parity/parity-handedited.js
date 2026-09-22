// tools/parity/parity-handedited.js — DB-M1 CP3. Side-by-side parity of the two frozen
// queries that had to be re-expressed for PostgreSQL (SQLite bare-column GROUP BY):
//   1. payrollPeriod.getGroupMembership      2. payrollPayment.getPayableEmployees
const { openEngines } = require('./engines');
let cases = 0; let comparisons = 0; let diffs = 0;
const count = (v) => (Array.isArray(v) ? v.reduce((n, r) => n + (r && typeof r === 'object' ? Object.keys(r).length : 1), 0) : 1);
function compare(name, a, b) {
  cases += 1; comparisons += count(a);
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { console.log(`  SAME  ${name}  (${Array.isArray(a) ? a.length : 1} row(s))`); return; }
  diffs += 1; console.log(`  DIFF  ${name}\n        A3: ${x}\n        PG: ${y}`);
}
let E;
(async () => {
  E = await openEngines('handedited');
  const out = { a3: {}, pg: {} };
  for (const key of ['a3', 'pg']) {
    const e = E[key]; const pp = e.lib('payrollPeriod'); const pay = e.lib('payrollPayment');
    for (const le of ['LE-A', 'LE-B']) await e.insert('legal_entities', { id: le, name: le, entity_type: 'internal', jkk_risk_class: 'low' });
    const wp = await e.insert('work_patterns', { name: 'wp', days_per_week: 5, weekly_rest_day: 'sunday' });
    const grp = {};
    for (const code of ['G', 'H']) grp[code] = (await e.insert('payroll_groups', { code, name: code, legal_entity_id: 'LE-A' })).id;
    const emp = async (id, full_name) => e.insert('employees', { id, full_name, status: 'active', worker_type: id === 'M13' ? 'subkontraktor' : 'pkwt' });
    const asg = async (employee_id, g, effective_date, end_date, le = 'LE-A') => e.insert('employee_payroll_assignments',
      { employee_id, legal_entity_id: le, work_pattern_id: wp.id, payroll_group_id: grp[g], effective_date, end_date });
    // ---- membership fixtures (period 2026-06-01 .. 2026-06-30) ----
    await emp('M01', 'Citra');  await asg('M01', 'G', '2020-01-01', null);                       // whole period
    await emp('M02', 'Budi');   await asg('M02', 'G', '2026-06-10', null);                       // joins mid-period
    await emp('M03', 'Agus');   await asg('M03', 'G', '2020-01-01', '2026-06-20');               // leaves mid-period
    await emp('M04', 'Dewi');   await asg('M04', 'G', '2020-01-01', '2026-06-14'); await asg('M04', 'G', '2026-06-15', null);        // 2 rows, chronological ids
    await emp('M05', 'Eko');    await asg('M05', 'G', '2026-06-15', '2026-12-31'); await asg('M05', 'G', '2020-01-01', '2026-06-14'); // 2 rows, REVERSED ids
    await emp('M06', 'Fajar');  await asg('M06', 'G', '2020-01-01', '2026-06-09'); await asg('M06', 'H', '2026-06-10', '2026-06-19'); await asg('M06', 'G', '2026-06-20', null); // G -> H -> G
    await emp('M07', 'Gita');   await asg('M07', 'G', '2026-06-30', null);                       // boundary: starts on period end
    await emp('M08', 'Hadi');   await asg('M08', 'G', '2020-01-01', '2026-06-01');               // boundary: ends on period start
    await emp('M09', 'Indra');  await asg('M09', 'G', '2020-01-01', '2026-05-31');               // ended before -> excluded
    await emp('M10', 'Joko');   await asg('M10', 'G', '2026-07-01', null);                       // starts after -> excluded
    await emp('M11', 'adi');    await asg('M11', 'G', '2020-01-01', null);                       // ordering: lower-case
    await emp('M12', 'Adi');    await asg('M12', 'G', '2020-01-01', null);                       // ordering: upper-case
    await emp('M13', '_Zed');   await asg('M13', 'G', '2020-01-01', null, 'LE-B');               // ordering: punctuation, other entity
    await emp('M14', 'Kiki');   await asg('M14', 'G', '2020-01-01', '2026-06-05'); await asg('M14', 'G', '2026-06-06', '2026-06-20'); await asg('M14', 'G', '2026-06-21', null); // 3 rows
    await emp('M15', 'Lina');   await asg('M15', 'H', '2020-01-01', null);                       // other group only
    const o = out[key];
    o['membership: June, group G'] = await pp.getGroupMembership(e.db, grp.G, '2026-06-01', '2026-06-30');
    o['membership: June, group H'] = await pp.getGroupMembership(e.db, grp.H, '2026-06-01', '2026-06-30');
    o['membership: one-day period on a boundary'] = await pp.getGroupMembership(e.db, grp.G, '2026-06-14', '2026-06-14');
    o['membership: period with nobody'] = await pp.getGroupMembership(e.db, grp.G, '2019-01-01', '2019-01-31');
    o['membership: unknown group'] = await pp.getGroupMembership(e.db, 999999, '2026-06-01', '2026-06-30');
    // ---- payable fixtures ----
    const period = async (seq) => (await e.insert('payroll_periods', { payroll_group_id: grp.G, period_year: 2026, period_sequence: seq, period_month: seq,
      period_start: `2026-0${seq}-01`, period_end: `2026-0${seq}-28`, status: 'OPEN' })).id;
    const P1 = await period(6); const P2 = await period(7); const P3 = await period(8);
    const runs = [];
    const run = async (pid, run_number, run_type, corrects) => { const r = await e.insert('payroll_runs',
      { payroll_period_id: pid, legal_entity_id: 'LE-A', run_number, run_type, status: 'CALCULATED', corrects_run_id: corrects || null }); runs.push(r.id); runPeriod[r.id] = pid; return r.id; };
    const snaps = {}; const runPeriod = {};
    const line = async (rid, employee_id, net_sen, calc_status = 'OK', le = 'LE-A') => {
      const k = `${runPeriod[rid]}|${employee_id}`;
      if (!snaps[k]) snaps[k] = (await e.insert('payroll_input_snapshots', { payroll_period_id: runPeriod[rid], employee_id, legal_entity_id: le })).id;
      return e.insert('payroll_run_lines', { payroll_run_id: rid, snapshot_id: snaps[k], employee_id, legal_entity_id: le, net_sen, calc_status });
    };
    const r1 = await run(P1, 1, 'ORIGINAL'); const r2 = await run(P1, 2, 'CORRECTION', r1); const r3 = await run(P1, 3, 'CORRECTION', r1); const r4 = await run(P1, 4, 'CORRECTION', r1);
    // lines deliberately inserted OUT of run order, to expose any order dependence of the run-id list
    await line(r3, 'M01', -50000); await line(r1, 'M01', 2150000000); await line(r2, 'M01', 125075);
    await line(r2, 'M02', 700); await line(r1, 'M02', 510000000);
    await line(r1, 'M03', 430000000);
    await line(r2, 'M04', 999);                                  // only in a correction run
    await line(r1, 'M13', 380000000, 'OK', 'LE-B');              // another legal entity
    await line(r1, 'M05', 111, 'ERROR'); await line(r2, 'M05', 222);   // ERROR line excluded, OK line kept
    await line(r1, 'M06', 0);                                    // zero net
    await line(r1, 'M07', -1); await line(r2, 'M07', 1);         // nets to zero
    await line(r1, 'M09', 10, 'OK', 'LE-B'); await line(r2, 'M09', 20, 'OK', 'LE-A');   // INVALID-in-practice: entity differs between runs
    await line(r2, 'M10', 30, 'OK', 'LE-B'); await line(r1, 'M10', 40, 'OK', 'LE-A');   // same, other insertion order
    await line(r4, 'M01', 77777); await line(r4, 'M08', 88888);  // r4 stays NOT finalized -> excluded
    const rOther = await run(P2, 1, 'ORIGINAL'); await line(rOther, 'M01', 123);   // other period
    for (const id of [r1, r2, r3, rOther]) await e.db.prepare(`UPDATE payroll_runs SET status = 'FINALIZED' WHERE id = ?`).run(id);
    o['payable: period with 3 finalized runs + 1 open run'] = await pay.getPayableEmployees(e.db, P1);
    o['payable: other period'] = await pay.getPayableEmployees(e.db, P2);
    o['payable: period without runs'] = await pay.getPayableEmployees(e.db, P3);
    o['payable: unknown period'] = await pay.getPayableEmployees(e.db, 999999);
  }
  console.log('HAND-EDITED FROZEN QUERIES — A3 SQLite vs DB-M1 PostgreSQL');
  for (const k of Object.keys(out.a3)) compare(k, out.a3[k], out.pg[k]);
  console.log(`\ncases ${cases} · field comparisons ${comparisons} · diffs ${diffs}`);
  await E.close();
  process.exit(diffs ? 1 : 0);
})().catch(async (e) => { console.error(e); if (E) await E.close().catch(() => {}); process.exit(2); });
