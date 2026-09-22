// tools/scale/generate-sqlite.js <workers> <out.db> — DB-M1 CP5
// Synthetic, NON-SENSITIVE, deterministic scale fixture in the AUTHORITATIVE A3 SQLite shape
// (no real person; names are "Pekerja 000123"). It is then moved to PostgreSQL with the real CP4
// migration tool, so every scale profile also exercises preflight, load and reconciliation.
// 12 months (2025-10-01 .. 2026-09-30): effective-dated schedules (2 versions each), fixed-weekly /
// custom-weekly / 6-day and 21-day rotating / date-based rosters, date overrides, attendance with
// status mix, OT requests + decisions, corrections with version chains and approval history,
// exceptions, immutable audit events with actor + role snapshot, 36 payroll periods, frozen input
// snapshots, 33 finalized runs with lines, components, payslips, payment batches and instructions.
const fs = require('fs'); const path = require('path'); const { DatabaseSync } = require('node:sqlite');
const W = Number(process.argv[2]); const OUT = process.argv[3];
if (!W || !OUT) { console.error('usage: generate-sqlite.js <workers> <out.db>'); process.exit(2); }
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(OUT + s)) fs.unlinkSync(OUT + s);
const t0 = Date.now();
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -400000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;');
require(path.join(__dirname, '..', '..', 'database', 'legacy-sqlite', 'init-db')).initDb(db);
const ddl = (t) => db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t).sql;
const allowed = (t, c) => { const m = ddl(t).match(new RegExp(`\\b${c}\\s+IN\\s*\\(([^)]*)\\)`)); return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')) : null; };
/** INSERT … SELECT with every NOT NULL column the scenario does not set filled by a schema-valid constant. */
function ins(table, cols, from) {
  const map = { ...cols };
  for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) { if (c.name in map || !c.notnull || c.dflt_value !== null || (c.pk && c.type === 'INTEGER')) continue;
    const a = allowed(table, c.name); map[c.name] = a ? `'${a[0]}'` : c.type === 'INTEGER' ? '0' : /(_at|timestamp)$/.test(c.name) ? `'2026-01-01 00:00:00'` : /date|_from$|_start$|_end$|cutoff/.test(c.name) ? `'2026-01-01'` : `'x'`; }
  const names = Object.keys(map); const s = Date.now();
  const n = db.prepare(`INSERT INTO ${table} (${names.join(',')}) SELECT ${names.map((k) => map[k]).join(',')} ${from}`).run().changes;
  console.log(`  ${String(n).padStart(9)}  ${table}  (${Date.now() - s} ms)`); return n;
}
db.exec('BEGIN');
// ---- reference data ----------------------------------------------------------
db.exec(`CREATE TEMP TABLE _n (i INTEGER PRIMARY KEY); WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < ${Math.max(W, 400)}) INSERT INTO _n SELECT i FROM s;
  CREATE TEMP TABLE _d (i INTEGER PRIMARY KEY, d TEXT, dow INTEGER, seq INTEGER);
  INSERT INTO _d SELECT i, date('2025-10-01', '+' || i || ' day'), CAST(strftime('%w', date('2025-10-01', '+' || i || ' day')) AS INTEGER),
    (CAST(strftime('%Y', date('2025-10-01', '+' || i || ' day')) AS INTEGER) - 2025) * 12 + CAST(strftime('%m', date('2025-10-01', '+' || i || ' day')) AS INTEGER) - 9 FROM _n WHERE i < 365;`);
const ROLES = [['operations_director', 'Operations Director'], ['workforce_manager', 'Workforce Manager'], ['supervisor', 'Supervisor'], ['payroll_officer', 'Payroll Officer']];
for (const [code, name] of ROLES) db.prepare('INSERT INTO roles (code, name) VALUES (?, ?)').run(code, name);
// 1 director, 2-7 workforce managers, 8-10 supervisors, 11-12 payroll officers (placeholder hashes: nobody can sign in)
ins('users', { email: `'user' || (i + 1) || '@scale.invalid'`, display_name: `'Scale User ' || (i + 1)`, password_hash: `'!'`, is_active: '1' }, 'FROM _n WHERE i < 12');
db.exec(`INSERT INTO user_roles SELECT id, CASE WHEN id = 1 THEN 1 WHEN id <= 7 THEN 2 WHEN id <= 10 THEN 3 ELSE 4 END FROM users`);
const LE = [['KAHE360', 'internal'], ['MITRA-A', 'subkontraktor'], ['MITRA-B', 'subkontraktor']];
for (const [id, type] of LE) ins('legal_entities', { id: `'${id}'`, name: `'${id}'`, entity_type: `'${type}'`, jkk_risk_class: `'high'`, effective_date: `'2019-01-01'` }, '');
db.exec(`INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by) SELECT u.id, l.id, 'scale' FROM users u, legal_entities l`);
ins('projects', { code: `'PPB'`, name: `'PPB Balongan'`, status: `'ACTIVE'` }, '');
ins('work_patterns', { name: `'6H'`, days_per_week: '6', weekly_rest_day: `'sunday'`, effective_date: `'2019-01-01'` }, '');
ins('payroll_groups', { code: `'G-' || id`, name: `'Group ' || id`, legal_entity_id: 'id', effective_from: `'2019-01-01'` }, 'FROM legal_entities ORDER BY id');
db.exec(`CREATE TEMP TABLE _e (idx INTEGER PRIMARY KEY, id TEXT, le TEXT, grp INTEGER, pat INTEGER);
  INSERT INTO _e SELECT i, printf('SC-%06d', i + 1), CASE WHEN i % 10 < 6 THEN 'KAHE360' WHEN i % 10 < 9 THEN 'MITRA-A' ELSE 'MITRA-B' END, CASE WHEN i % 10 < 6 THEN 1 WHEN i % 10 < 9 THEN 2 ELSE 3 END, i % 5 + 1 FROM _n WHERE i < ${W};`);
ins('employees', { id: 'id', full_name: `printf('Pekerja %06d', idx + 1)`, status: `'active'`, worker_type: `CASE WHEN le = 'KAHE360' THEN 'pkwt' ELSE 'subkontraktor' END` }, 'FROM _e');
ins('employee_payroll_assignments', { employee_id: 'id', legal_entity_id: 'le', work_pattern_id: '1', payroll_group_id: 'grp', marital_status: `'TK'`, base_salary_sen: '450000000 + (idx % 40) * 2500000',
  effective_date: `CASE WHEN idx % 10 = 3 THEN '2026-04-01' ELSE '2019-01-01' END`, end_date: 'NULL' }, 'FROM _e');
ins('employee_payroll_assignments', { employee_id: 'id', legal_entity_id: 'le', work_pattern_id: '1', payroll_group_id: 'grp', marital_status: `'TK'`, base_salary_sen: '430000000', effective_date: `'2019-01-01'`, end_date: `'2026-03-31'` }, 'FROM _e WHERE idx % 10 = 3');
// ---- schedules: 3 codes x 2 effective-dated versions ---------------------------
const SCH = [['OFFICE', '08:00', '17:00', 480, 0], ['SITE-DAY', '07:00', '17:00', 540, 0], ['SITE-NIGHT', '19:00', '05:00', 540, 1]];
for (const [v, from, to] of [[1, '2019-01-01', '2026-03-31'], [2, '2026-04-01', null]]) for (const [code, ci, co, min, x] of SCH)
  ins('work_schedules', { code: `'${code}'`, name: `'${code} v${v}'`, legal_entity_id: 'NULL', clock_in: `'${ci}'`, clock_out: `'${co}'`, standard_work_minutes: String(min), cross_midnight: String(x), effective_from: `'${from}'`, effective_to: to ? `'${to}'` : 'NULL' }, '');
ins('work_schedule_breaks', { work_schedule_id: 'id', name: `'Istirahat'`, start_time: `'12:00'`, end_time: `'13:00'`, duration_minutes: '60' }, 'FROM work_schedules');
const dayWork = (allowed('attendance_pattern_days', 'day_status') || ['WORK', 'OFF']); const WORK = dayWork.find((x) => /WORK/i.test(x)) || dayWork[0]; const OFF = dayWork.find((x) => /OFF|REST/i.test(x)) || dayWork[1];
const PAT = [['FW-6', 'FIXED_WEEKLY', 7, 'i != 0'], ['CW-5', 'CUSTOM_WEEKLY', 7, 'i NOT IN (0, 5)'], ['ROT-6', 'ROTATING_CYCLE', 6, 'i < 4'], ['ROT-21', 'ROTATING_CYCLE', 21, 'i < 14'], ['ROSTER', 'DATE_BASED_ROSTER', 0, null]];
PAT.forEach(([code, type, len, rule], k) => { ins('attendance_work_patterns', { code: `'${code}'`, name: `'${code}'`, pattern_type: `'${type}'`, cycle_length_days: len ? String(len) : 'NULL', cycle_start_date: type === 'ROTATING_CYCLE' ? `'2025-10-01'` : 'NULL', default_schedule_id: String(4 + (k % 3)), effective_from: `'2019-01-01'` }, '');
  if (rule) ins('attendance_pattern_days', { pattern_id: String(k + 1), day_index: type === 'ROTATING_CYCLE' ? 'i + 1' : 'i', day_status: `CASE WHEN ${rule} THEN '${WORK}' ELSE '${OFF}' END`, work_schedule_id: `CASE WHEN ${rule} THEN ${4 + (k % 3)} ELSE NULL END` }, `FROM _n WHERE i < ${len}`); });
// who works when (kept in one expression so attendance, roster dates and the benchmark agree)
const WORKS = `(CASE e.pat WHEN 1 THEN d.dow != 0 WHEN 2 THEN d.dow NOT IN (0, 5) WHEN 3 THEN d.i % 6 < 4 WHEN 4 THEN d.i % 21 < 14 ELSE d.dow NOT IN (0, 6) END)`;
ins('attendance_roster_dates', { pattern_id: '5', employee_id: 'NULL', work_date: 'd.d', day_status: `CASE WHEN d.dow NOT IN (0, 6) THEN '${WORK}' ELSE '${OFF}' END`, work_schedule_id: `CASE WHEN d.dow NOT IN (0, 6) THEN 5 ELSE NULL END` }, 'FROM _d d');
ins('attendance_schedule_assignments', { employee_id: 'id', legal_entity_id: 'le', pattern_id: 'pat', effective_from: `'2019-01-01'`, effective_to: `CASE WHEN idx % 7 = 0 THEN '2026-03-31' ELSE NULL END` }, 'FROM _e');
ins('attendance_schedule_assignments', { employee_id: 'id', legal_entity_id: 'le', pattern_id: 'pat', work_schedule_id: '5', effective_from: `'2026-04-01'`, effective_to: 'NULL' }, 'FROM _e WHERE idx % 7 = 0');
ins('attendance_date_overrides', { employee_id: 'e.id', legal_entity_id: 'e.le', work_date: 'd.d', override_status: `'OFF'`, reason: `'Cuti bersama'` }, `FROM _e e, _d d WHERE (e.idx * 31 + d.i * 17) % 400 = 0`);
// ---- attendance -------------------------------------------------------------
const H = '((e.idx * 7919 + d.i * 104729) % 1000)';      // deterministic pseudo-random 0..999 per employee-day
const SID = `(CASE WHEN d.d >= '2026-04-01' THEN 3 ELSE 0 END + CASE e.pat % 3 WHEN 0 THEN 1 WHEN 1 THEN 2 ELSE 3 END)`;
const OTQ = `(${H} % 5 = 0 AND ${H} < 900)`;
ins('timesheet_entries', { employee_id: 'e.id', work_date: 'd.d', legal_entity_id: 'e.le', workfront: `'WF-' || (e.idx % 12)`, shift: `CASE WHEN e.pat % 3 = 2 THEN 'night' ELSE 'day' END`,
  clock_in: `CASE WHEN ${H} >= 960 THEN NULL ELSE printf('%02d:%02d', CASE WHEN e.pat % 3 = 2 THEN 18 ELSE 6 END, 45 + ${H} % 15) END`, clock_out: `CASE WHEN ${H} >= 960 THEN NULL ELSE printf('%02d:%02d', CASE WHEN e.pat % 3 = 2 THEN 5 ELSE 17 END, ${H} % 30) END`,
  work_minutes: `CASE WHEN ${H} >= 960 THEN 0 ELSE 480 + ${H} % 60 END`, attendance_status: `CASE WHEN ${H} < 900 THEN 'present' WHEN ${H} < 940 THEN 'late' WHEN ${H} < 960 THEN 'sick' WHEN ${H} < 980 THEN 'absent' WHEN ${H} < 995 THEN 'leave' ELSE 'no_show' END`,
  overtime_status: `CASE WHEN NOT ${OTQ} THEN 'none' WHEN d.seq = 12 AND ${H} % 20 = 0 THEN 'pending' WHEN ${H} % 50 = 5 THEN 'rejected' ELSE 'approved' END`,
  overtime_minutes_requested: `CASE WHEN ${OTQ} THEN 60 + ${H} % 121 ELSE NULL END`, overtime_minutes_approved: `CASE WHEN ${OTQ} AND NOT (d.seq = 12 AND ${H} % 20 = 0) AND ${H} % 50 != 5 THEN 60 + ${H} % 121 ELSE NULL END`,
  overtime_requested_by_user_id: `CASE WHEN ${OTQ} THEN 8 + e.idx % 3 ELSE NULL END`, overtime_decided_by_user_id: `CASE WHEN ${OTQ} AND NOT (d.seq = 12 AND ${H} % 20 = 0) THEN 2 + e.idx % 6 ELSE NULL END`,
  day_type: `'WORKDAY'`, recorded_by: `'Scale User'`, recorded_by_user_id: '2 + e.idx % 6', work_schedule_id: SID, schedule_code: `CASE e.pat % 3 WHEN 0 THEN 'OFFICE' WHEN 1 THEN 'SITE-DAY' ELSE 'SITE-NIGHT' END`,
  scheduled_minutes: '480', late_minutes: `CASE WHEN ${H} BETWEEN 900 AND 939 THEN 5 + ${H} % 40 ELSE 0 END`, created_at: `d.d || ' 10:00:00'`, updated_at: `d.d || ' 10:00:00'` }, `FROM _e e, _d d WHERE ${WORKS}`);
db.exec(`CREATE TEMP TABLE _t AS SELECT t.id, t.employee_id, t.work_date, t.legal_entity_id, t.overtime_status, t.recorded_by_user_id AS uid, t.overtime_decided_by_user_id AS dec, (t.id * 2654435761) % 1000 AS h FROM timesheet_entries t; CREATE INDEX _t_h ON _t(h);`);
// ---- corrections (1.5 %), version chains, approval history, exceptions (4 %) ----
ins('attendance_corrections', { request_no: `'COR-' || id`, request_type: `CASE WHEN h % 150 = 7 THEN 'VOID' ELSE 'CORRECTION' END`, timesheet_entry_id: 'id', employee_id: 'employee_id', legal_entity_id: 'legal_entity_id', work_date: 'work_date',
  status: `CASE WHEN h % 150 = 7 THEN 'VOIDED' WHEN h % 10 = 1 THEN 'REJECTED' WHEN h % 10 = 2 THEN 'SUBMITTED' ELSE 'APPLIED' END`, reason_code: `'CLOCK_FIX'`, reason_text: `'Koreksi jam'`, before_values: `'{"work_minutes":480}'`, proposed_values: `'{"work_minutes":450}'`,
  payroll_impact: `'NO_PAYROLL_IMPACT'`, applied_version_no: `CASE WHEN h % 10 IN (1, 2) AND h % 150 != 7 THEN NULL ELSE 2 END`, requested_by_user_id: '8 + id % 3', requested_by_name: `'Scale User'`, requested_by_role: `'Supervisor'`, requested_at: `work_date || ' 12:00:00'`,
  decided_by_user_id: `CASE WHEN h % 10 = 2 THEN NULL ELSE 2 + id % 6 END`, decided_by_role: `CASE WHEN h % 10 = 2 THEN NULL ELSE 'Workforce Manager' END`, decided_at: `CASE WHEN h % 10 = 2 THEN NULL ELSE work_date || ' 15:00:00' END`, created_at: `work_date || ' 12:00:00'`, updated_at: `work_date || ' 15:00:00'` }, 'FROM _t WHERE h < 15');
for (const [no, type] of [[1, 'ORIGINAL'], [2, null]]) ins('attendance_entry_versions', { timesheet_entry_id: 'c.timesheet_entry_id', employee_id: 'c.employee_id', legal_entity_id: 'c.legal_entity_id', version_no: String(no),
  version_type: type ? `'${type}'` : `CASE WHEN c.request_type = 'VOID' THEN 'VOID' ELSE 'CORRECTION' END`, correction_id: no === 1 ? 'NULL' : 'c.id', payload: no === 1 ? `'{"work_minutes":480}'` : `'{"work_minutes":450}'`, actor_user_id: no === 1 ? '2' : 'c.decided_by_user_id',
  created_at: no === 1 ? `c.work_date || ' 10:00:00'` : `c.work_date || ' 15:00:00'` }, 'FROM attendance_corrections c WHERE c.applied_version_no = 2');
db.exec(`UPDATE timesheet_entries SET current_version = 2, last_correction_id = (SELECT c.id FROM attendance_corrections c WHERE c.timesheet_entry_id = timesheet_entries.id) WHERE id IN (SELECT timesheet_entry_id FROM attendance_corrections WHERE applied_version_no = 2)`);
const ACT = allowed('attendance_correction_actions', 'action');
[['SUBMIT', 'NULL', 'SUBMITTED', 'c.requested_by_user_id', '1=1'], ['APPROVE', 'SUBMITTED', 'APPROVED', 'c.decided_by_user_id', `c.status IN ('APPLIED','VOIDED')`], ['APPLY', 'APPROVED', 'APPLIED', 'c.decided_by_user_id', `c.status IN ('APPLIED','VOIDED')`], ['REJECT', 'SUBMITTED', 'REJECTED', 'c.decided_by_user_id', `c.status = 'REJECTED'`]]
  .forEach(([a, f, to, actor, where], k) => ins('attendance_correction_actions', { correction_id: 'c.id', action: `'${ACT ? (ACT.find((x) => x.startsWith(a.slice(0, 4))) || ACT[k % ACT.length]) : a}'`, from_status: f === 'NULL' ? 'NULL' : `'${f}'`, to_status: `'${to}'`, actor_user_id: actor }, `FROM attendance_corrections c WHERE ${where}`));
ins('attendance_exceptions', { timesheet_entry_id: 'id', employee_id: 'employee_id', legal_entity_id: 'legal_entity_id', work_date: 'work_date', exception_type: `CASE h % 4 WHEN 0 THEN 'MISSING_CLOCK_OUT' WHEN 1 THEN 'LATE_ARRIVAL' WHEN 2 THEN 'OT_WITHOUT_APPROVAL' ELSE 'ABNORMAL_DURATION' END`,
  severity: `CASE h % 3 WHEN 0 THEN 'LOW' WHEN 1 THEN 'MEDIUM' ELSE 'HIGH' END`, status: `CASE WHEN h % 5 < 3 THEN 'RESOLVED' ELSE 'OPEN' END`, resolved_by_user_id: `CASE WHEN h % 5 < 3 THEN 2 + id % 6 ELSE NULL END`, detected_at: `work_date || ' 23:00:00'`, updated_at: `work_date || ' 23:30:00'` }, 'FROM _t WHERE h BETWEEN 100 AND 139');
// ---- immutable audit: CREATED for every record, OT request/decision, corrections ----
const EV = (type, actor, role, when, from) => ins('attendance_events', { timesheet_entry_id: 't.id', employee_id: 't.employee_id', work_date: 't.work_date', legal_entity_id: 't.legal_entity_id', event_type: `'${type}'`, actor_user_id: actor, actor_role_snapshot: `'${role}'`, occurred_at: `t.work_date || ' ${when}'` }, from);
EV('CREATED', 't.uid', 'Workforce Manager', '10:00:00', 'FROM _t t');
EV('OVERTIME_REQUESTED', '8 + t.id % 3', 'Supervisor', '16:00:00', `FROM _t t WHERE t.overtime_status != 'none'`);
EV('OVERTIME_DECIDED', 't.dec', 'Workforce Manager', '18:00:00', `FROM _t t WHERE t.overtime_status IN ('approved','rejected')`);
ins('attendance_events', { timesheet_entry_id: 'c.timesheet_entry_id', employee_id: 'c.employee_id', work_date: 'c.work_date', legal_entity_id: 'c.legal_entity_id', event_type: `'CORRECTION_' || c.status`, actor_user_id: 'COALESCE(c.decided_by_user_id, c.requested_by_user_id)',
  actor_role_snapshot: `COALESCE(c.decided_by_role, 'Supervisor')`, correction_id: 'c.id', occurred_at: `c.work_date || ' 15:00:00'` }, 'FROM attendance_corrections c');
// ---- payroll: 36 periods, frozen snapshots, finalized runs, lines, components, payslips, payments ----
ins('payroll_periods', { payroll_group_id: 'g.id', period_year: `CAST(substr(m.s, 1, 4) AS INTEGER)`, period_sequence: 'm.seq', period_month: `CAST(substr(m.s, 6, 2) AS INTEGER)`, period_start: 'm.s', period_end: 'm.e', attendance_cutoff: 'm.e', overtime_cutoff: 'm.e', adjustment_cutoff: 'm.e', payment_date: `date(m.e, '+5 day')`, status: `CASE WHEN m.seq < 12 THEN 'CLOSED' ELSE 'OPEN' END` },
  `FROM payroll_groups g, (SELECT seq, MIN(d) AS s, MAX(d) AS e FROM _d GROUP BY seq) m`);
ins('payroll_input_snapshots', { payroll_period_id: 'p.id', employee_id: 'e.id', as_of_date: 'p.period_end', legal_entity_id: 'e.le', payroll_group_id: 'e.grp', resolved_payload: `'{"employee_id":"' || e.id || '","period":' || p.id || '}'`, payable_days: '26', period_days: '30',
  payload_hash: `printf('%064d', e.idx * 100 + p.period_sequence)`, status: `CASE WHEN p.period_sequence < 12 THEN 'FROZEN' ELSE 'DRAFT' END`, resolved_at: `p.period_end || ' 20:00:00'` }, 'FROM _e e JOIN payroll_periods p ON p.payroll_group_id = e.grp');
db.exec(`UPDATE payroll_input_snapshots SET work_minutes_total = (SELECT COALESCE(SUM(t.work_minutes), 0) FROM timesheet_entries t JOIN payroll_periods p ON p.id = payroll_input_snapshots.payroll_period_id WHERE t.employee_id = payroll_input_snapshots.employee_id AND t.work_date BETWEEN p.period_start AND p.period_end) WHERE payroll_period_id % 4 = 1`);
ins('payroll_runs', { payroll_period_id: 'p.id', legal_entity_id: 'g.legal_entity_id', run_number: '1', run_type: `'ORIGINAL'`, status: `'CALCULATED'` }, 'FROM payroll_periods p JOIN payroll_groups g ON g.id = p.payroll_group_id WHERE p.period_sequence < 12');
const GROSS = '(450000000 + (e.idx % 40) * 2500000 + s.payroll_period_id * 10000)';
ins('payroll_run_lines', { payroll_run_id: 'r.id', snapshot_id: 's.id', employee_id: 's.employee_id', legal_entity_id: 's.legal_entity_id', calc_status: `'OK'`, gross_sen: GROSS, bpjs_employee_sen: `${GROSS} / 25`, tax_sen: `${GROSS} / 20`, employee_deductions_sen: `${GROSS} / 25 + ${GROSS} / 20`,
  net_sen: `${GROSS} - ${GROSS} / 25 - ${GROSS} / 20`, employer_cost_sen: `${GROSS} + ${GROSS} / 10`, result_payload: `'{}'`, result_hash: `printf('%064d', s.id)`, snapshot_hash: 's.payload_hash', calculated_at: `'2026-01-01 00:00:00'` },
  'FROM payroll_input_snapshots s JOIN payroll_runs r ON r.payroll_period_id = s.payroll_period_id JOIN _e e ON e.id = s.employee_id');
ins('payroll_run_line_components', { payroll_run_line_id: 'l.id', sequence: 'k.i + 1', component_code: `CASE k.i WHEN 0 THEN 'BASIC' WHEN 1 THEN 'OVERTIME' WHEN 2 THEN 'MEAL' WHEN 3 THEN 'BPJS_JHT' WHEN 4 THEN 'BPJS_KES' ELSE 'PPH21' END`, component_group: `CASE WHEN k.i < 3 THEN 'EARNING' ELSE 'DEDUCTION' END`, amount_sen: 'l.gross_sen / (k.i + 2)' }, 'FROM payroll_run_lines l, _n k WHERE k.i < 6');
db.exec(`UPDATE payroll_runs SET status = 'FINALIZED', finalized_at = '2026-01-01 00:00:00', finalized_by = 'Scale User 11'`);
ins('payroll_payslips', { payroll_run_id: 'l.payroll_run_id', payroll_run_line_id: 'l.id', payroll_period_id: 'r.payroll_period_id', employee_id: 'l.employee_id', legal_entity_id: 'l.legal_entity_id', run_number: '1', payslip_reference: `'PS-' || l.id`, document: `'{"net_sen":' || l.net_sen || '}'`,
  content_hash: `printf('%064d', l.id)`, line_result_hash: 'l.result_hash', snapshot_hash: 'l.snapshot_hash', gross_sen: 'l.gross_sen', employee_deductions_sen: 'l.employee_deductions_sen', net_sen: 'l.net_sen', employer_cost_sen: 'l.employer_cost_sen', generated_by: `'Scale User 11'` }, 'FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id');
ins('payroll_payment_batches', { batch_reference: `'PB-' || r.legal_entity_id || '-' || r.payroll_period_id`, payroll_period_id: 'r.payroll_period_id', payroll_group_id: 'p.payroll_group_id', legal_entity_id: 'r.legal_entity_id', status: `'PAID'`, created_by: `'Scale User 11'` }, 'FROM payroll_runs r JOIN payroll_periods p ON p.id = r.payroll_period_id');
ins('payroll_payment_items', { batch_id: 'b.id', payroll_period_id: 'b.payroll_period_id', employee_id: 'l.employee_id', legal_entity_id: 'l.legal_entity_id', payment_reference: `b.batch_reference || '-' || l.employee_id`, amount_sen: 'l.net_sen', source_run_ids: `'[' || l.payroll_run_id || ']'`, status: `'PAID'` },
  'FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id JOIN payroll_payment_batches b ON b.payroll_period_id = r.payroll_period_id AND b.legal_entity_id = r.legal_entity_id');
db.exec('COMMIT'); db.exec('DROP TABLE _t; DROP TABLE _e; DROP TABLE _d; DROP TABLE _n;');
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get().c, 0);
db.close();
console.log(`workers ${W} · rows ${rows} · file ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
