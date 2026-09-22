// tools/dbm1/smoke-migrated.js — DB-M1 CP4. Representative READ workflows against a MIGRATED PostgreSQL
// database, through the REAL server and RBAC (runtime role), plus an id-collision probe that is rolled back.
//   DATABASE_URL=<runtime url of the migrated db> node tools/dbm1/smoke-migrated.js [--login email] [--password pw]
const { spawn } = require('child_process'); const path = require('path');
const { getDb, closeDb, withTransaction } = require('../../database/db');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const PORT = 41000 + Math.floor(Math.random() * 9000); const BASE = `http://127.0.0.1:${PORT}`;
(async () => {
  const db = getDb(); const one = async (sql, ...p) => db.prepare(sql).get(...p);
  const results = []; const rec = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`); };
  const users = (await one('SELECT COUNT(*) AS n FROM users')).n;
  let server; let cookie = '';
  const get = async (url) => { const r = await fetch(BASE + url, { headers: { cookie } }); let body = null; try { body = await r.json(); } catch (_) { /* not json */ } return { status: r.status, body }; };
  const size = (b) => (Array.isArray(b) ? b.length : b && typeof b === 'object' ? (Array.isArray(b.rows) ? b.rows.length : Array.isArray(b.items) ? b.items.length : Object.keys(b).length) : 0);
  if (users) {
    server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SESSION_SECRET: 'smoke-only-secret-0123456789abcdef' }, stdio: 'pipe' });
    for (let i = 0; i < 50; i += 1) { try { await fetch(`${BASE}/api/system/health`); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
    const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: arg('--login', 'director@kahe360.local'), password: arg('--password', 'Kahe360Demo!2026') }) });
    cookie = (login.headers.get('set-cookie') || '').split(';')[0]; rec('sign in with a MIGRATED user + bcrypt hash', login.status === 200, `HTTP ${login.status}`);
    const e = await one(`SELECT t.id, t.employee_id, t.work_date FROM timesheet_entries t ORDER BY (SELECT COUNT(*) FROM attendance_entry_versions v WHERE v.timesheet_entry_id = t.id) DESC, t.id LIMIT 1`);
    const actor = await one('SELECT actor_user_id AS id, COUNT(*) AS n FROM attendance_events WHERE actor_user_id IS NOT NULL GROUP BY actor_user_id ORDER BY n DESC, 1 LIMIT 1');
    const run = await one(`SELECT id, payroll_period_id FROM payroll_runs WHERE status = 'FINALIZED' ORDER BY id LIMIT 1`);
    const corr = await one('SELECT id FROM attendance_corrections ORDER BY id LIMIT 1');
    const runLines = run ? (await one('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id = ?', run.id)).n : 0;   // expectation comes from the migrated data itself
    // every minimum is derived from the MIGRATED DATA (a payroll-only source has no corrections to list, and that is correct)
    const has = async (table, where = '') => ((await one(`SELECT COUNT(*) AS n FROM ${table} ${where}`)).n ? 1 : 0);
    const H = { ev: await has('attendance_events', `WHERE timesheet_entry_id = ${e.id}`), sch: await has('work_schedules'), cor: await has('attendance_corrections'), ver: await has('attendance_entry_versions', `WHERE timesheet_entry_id = ${e.id}`),
      aud: await has('attendance_events'), exc: await has('attendance_exceptions'), q: await has('attendance_payroll_adjustments') };
    const checks = [
      ['Attendance read (day list)', `/api/timesheet/entries?date=${e.work_date}`, 1],
      ['Attendance record audit trail', `/api/timesheet/entries/${e.id}/events`, H.ev],
      ['Schedule / roster resolution (effective-dated)', `/api/work-schedule/resolve/${e.employee_id}/${e.work_date}`, 1],
      ['Schedules + patterns + assignments', '/api/work-schedule/schedules', H.sch], ['Roster date overrides', '/api/work-schedule/overrides', 0],
      ['OT lookup (pending queue)', '/api/timesheet/overtime/pending', 0],
      ['Correction requests', '/api/attendance-correction/requests', H.cor], ...(corr ? [['Correction detail + approval history', `/api/attendance-correction/requests/${corr.id}`, 1]] : []),
      ['Record history (version chain)', `/api/attendance-correction/entries/${e.id}/history`, H.ver],
      ...(actor ? [['Actor Activity History', `/api/attendance-correction/audit/actors/${actor.id}`, 1]] : []),
      ['Audit Center', '/api/attendance-correction/audit', H.aud], ['Exception Center', '/api/attendance-correction/exceptions', H.exc],
      ['Payroll Adjustment Queue', '/api/attendance-correction/payroll-queue', H.q], ['Finalized-payroll impact references', '/api/attendance-correction/payroll-impact', H.q],
      ['Payroll periods', '/api/payroll/periods', 1], ['Payroll runs', '/api/payroll/runs', run ? 1 : 0],
      ...(run ? [['Payroll run detail', `/api/payroll/runs/${run.id}`, 1], ['Payroll run lines', `/api/payroll/runs/${run.id}/lines`, runLines ? 1 : 0], ['Payslips of the run', `/api/payroll/runs/${run.id}/payslips`, 0],
        ['Payment reconciliation of the period', `/api/payroll/periods/${run.payroll_period_id}/payment-reconciliation`, 1]] : []),
      ['Payment batches', '/api/payroll/payment-batches', 0],
    ];
    for (const [name, url, min] of checks) { const r = await get(url); rec(name, r.status === 200 && size(r.body) >= min, `HTTP ${r.status} · ${size(r.body)} item(s)  ${url}`); }
    const anon = await fetch(`${BASE}/api/attendance-correction/audit`); rec('unauthenticated access is still refused', anon.status === 401, `HTTP ${anon.status}`);
  } else console.log('  (no users in this database: HTTP workflows skipped, library-level checks only)');
  // payroll history through the frozen libraries (works for a lib-only source too)
  // only meaningful where the source actually holds finalized run LINES (the attendance source has a finalized run header only)
  const fin = await one(`SELECT r.id, r.payroll_period_id FROM payroll_runs r WHERE r.status = 'FINALIZED' AND EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.payroll_run_id = r.id) ORDER BY r.id LIMIT 1`);
  if (fin) {
    const totals = await require('../../lib/runCalculator').getRunTotals(db, fin.id); rec('finalized run totals via lib/runCalculator', totals && Number.isSafeInteger(totals.net_sen ?? totals.total_net_sen ?? 0), JSON.stringify(totals).slice(0, 110));
    const payable = await require('../../lib/payrollPayment').getPayableEmployees(db, fin.payroll_period_id); rec('payable-per-employee on migrated run lines', payable.length > 0, `${payable.length} employee(s)`);
    const slip = await one('SELECT id, payroll_run_line_id, net_sen FROM payroll_payslips ORDER BY id LIMIT 1');
    if (slip) { const line = await one('SELECT net_sen FROM payroll_run_lines WHERE id = ?', slip.payroll_run_line_id); rec('payslip ↔ run line reference and amount agree', line && line.net_sen === slip.net_sen, `net ${slip.net_sen} sen`); }
    let blocked = false; try { await db.exec(`UPDATE payroll_run_lines SET net_sen = net_sen + 1 WHERE payroll_run_id = ${fin.id}`); } catch (err) { blocked = /PAYROLL_FINALIZED/.test(err.message); }
    rec('migrated FINALIZED payroll is still immutable', blocked);
  }
  let frozenBlocked = null; const fz = await one(`SELECT t.id FROM timesheet_entries t JOIN payroll_input_snapshots s ON s.employee_id = t.employee_id AND s.status = 'FROZEN' JOIN payroll_periods p ON p.id = s.payroll_period_id AND p.period_start <= t.work_date AND p.period_end >= t.work_date ORDER BY t.id LIMIT 1`);
  if (fz) { try { await db.exec(`UPDATE timesheet_entries SET work_minutes = COALESCE(work_minutes,0) + 1 WHERE id = ${fz.id}`); frozenBlocked = false; } catch (err) { frozenBlocked = /ATTENDANCE_SOURCE_FROZEN/.test(err.message); }
    rec('attendance under a migrated FROZEN snapshot loaded as history and is still protected', frozenBlocked === true); }
  // new ids never collide with history (probe rolled back, database left untouched)
  const probe = []; for (const tname of ['attendance_events', 'timesheet_entries', 'attendance_corrections', 'payroll_runs', 'users', 'roles']) {
    const max = (await one(`SELECT COALESCE(MAX(id),0) AS m FROM ${tname}`)).m; const seq = (await one(`SELECT last_value AS v, is_called AS c FROM ${(await one(`SELECT pg_get_serial_sequence('${tname}','id') AS s`)).s}`));
    probe.push(`${tname}: max ${max} → next ${seq.c ? seq.v + 1 : seq.v}`); if ((seq.c ? seq.v + 1 : seq.v) <= max) rec(`identity of ${tname} is behind its data`, false); }
  try { await withTransaction(db, async () => { const before = (await one('SELECT COALESCE(MAX(id),0) AS m FROM attendance_events')).m;
    const id = (await db.prepare(`INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('SMOKE', '2026-01-01', 'SMOKE') RETURNING id`).run()).lastInsertRowid;
    rec('a NEW record gets an id above every historical id', id > before, `historical max ${before} → new ${id}`); throw new Error('rollback probe'); }); } catch (err) { if (err.message !== 'rollback probe') throw err; }
  console.log(`  identity: ${probe.join(' · ')}`);
  if (server) server.kill(); await closeDb();
  const bad = results.filter((r) => !r.ok).length; console.log(`SMOKE: ${results.length - bad} ok, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
