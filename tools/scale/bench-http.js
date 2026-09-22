// tools/scale/bench-http.js — DB-M1 CP5. Workload benchmark through the REAL server (RBAC, entity scope, runtime role)
// with per-request SQL statistics, then EXPLAIN (ANALYZE, BUFFERS) of the slowest statement of each workload.
//   DATABASE_URL=<runtime url> DATABASE_MIGRATION_URL=<owner url> node tools/scale/bench-http.js <workers> <out.json>
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const { Client } = require('pg');
const W = Number(process.argv[2]); const OUT = process.argv[3]; const ITER = Number(process.env.BENCH_ITER || 25);
const PORT = 42000 + Math.floor(Math.random() * 5000); const BASE = `http://127.0.0.1:${PORT}`;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] * 10) / 10 : null; };
const day = (k) => new Date(Date.UTC(2025, 9, 1) + ((k * 37) % 330 + 20) * 86400000).toISOString().slice(0, 10);
const emp = (k, pat) => `SC-${String(((k * 53) % Math.max(1, Math.floor(W / 5))) * 5 + pat).padStart(6, '0')}`;   // pat 1..5 -> pattern of that worker
(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', KAHE_DB_QUERY_STATS: '1', SESSION_SECRET: 'bench-only-secret-0123456789abcdef' }, stdio: 'pipe' });
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/api/system/health`); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'director@kahe360.local', password: 'Kahe360Demo!2026' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]; if (login.status !== 200) throw new Error(`login ${login.status}`);
  const owner = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL, options: '-c timezone=UTC' }); await owner.connect();
  const q1 = async (sql) => (await owner.query(sql)).rows[0];
  const corrected = (await q1('SELECT timesheet_entry_id AS id FROM attendance_corrections WHERE applied_version_no = 2 ORDER BY id DESC LIMIT 1')).id;
  const run = await q1(`SELECT r.id, r.payroll_period_id FROM payroll_runs r WHERE r.legal_entity_id = 'KAHE360' ORDER BY r.id DESC LIMIT 1`);
  const batch = (await q1(`SELECT id FROM payroll_payment_batches WHERE legal_entity_id = 'KAHE360' ORDER BY id DESC LIMIT 1`)).id;
  const workloads = [
    ['Daily attendance retrieval', (k) => `/api/timesheet/entries?date=${day(k)}`], ['Daily attendance summary', (k) => `/api/timesheet/entries/summary?date=${day(k)}`],
    ['Schedule resolution (fixed weekly, effective-dated)', (k) => `/api/work-schedule/resolve/${emp(k, 1)}/${day(k)}`], ['Rotating roster resolution (21-day cycle)', (k) => `/api/work-schedule/resolve/${emp(k, 4)}/${day(k)}`],
    ['Date-based roster resolution', (k) => `/api/work-schedule/resolve/${emp(k, 5)}/${day(k)}`], ['Overtime lookup (pending queue)', () => '/api/timesheet/overtime/pending'],
    ['Exception Center (open)', () => '/api/attendance-correction/exceptions?status=OPEN'], ['Correction requests', () => '/api/attendance-correction/requests'],
    ['Correction approval inbox', () => '/api/attendance-correction/requests?inbox=1'], ['Record history (version chain)', () => `/api/attendance-correction/entries/${corrected}/history`],
    ['Actor Activity History', (k) => `/api/attendance-correction/audit/actors/${2 + (k % 6)}`], ['Audit Center', () => '/api/attendance-correction/audit'],
    ['Audit Center filtered by employee', (k) => `/api/attendance-correction/audit?employee_id=${emp(k, 2)}`], ['Record audit trail', () => `/api/timesheet/entries/${corrected}/events`],
    ['Payroll periods', () => '/api/payroll/periods'], ['Payroll period detail (closing reads)', () => `/api/payroll/periods/${run.payroll_period_id}`],
    ['Payment reconciliation of a period (closing reads)', () => `/api/payroll/periods/${run.payroll_period_id}/payment-reconciliation`], ['Payroll runs', () => '/api/payroll/runs'],
    ['Finalized run lines (one entity, one period)', () => `/api/payroll/runs/${run.id}/lines`], ['Payslips of a run', () => `/api/payroll/runs/${run.id}/payslips`],
    ['Payslips of one employee (12 months)', (k) => `/api/payroll/employees/${emp(k, 1)}/payslips`], ['Payment batch detail', () => `/api/payroll/payment-batches/${batch}`],
    ['Exception scan — one business day (WRITES)', (k) => ({ method: 'POST', url: '/api/attendance-correction/exceptions/scan', body: { from: day(k + 900), to: day(k + 900) }, iter: 2 })],
  ];
  const results = [];
  for (const [name, mk] of workloads) {
    const lat = []; let stats = null; let status = 0; let items = 0; let bytes = 0; const first = mk(0); const iters = typeof first === 'object' ? first.iter : ITER;
    for (let k = 0; k < iters; k += 1) { const spec = mk(k); const url = typeof spec === 'string' ? spec : spec.url; const t0 = process.hrtime.bigint();
      const r = await fetch(BASE + url, typeof spec === 'string' ? { headers: { cookie } } : { method: spec.method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(spec.body) });
      const text = await r.text(); lat.push(Number(process.hrtime.bigint() - t0) / 1e6); status = r.status; bytes = text.length;
      try { const j = JSON.parse(text); items = Array.isArray(j) ? j.length : Array.isArray(j.rows) ? j.rows.length : Array.isArray(j.items) ? j.items.length : (j.created ?? j.count ?? Object.keys(j).length); } catch (_) { /* not json */ }
      const h = r.headers.get('x-db-stats'); if (h) { const s = JSON.parse(decodeURIComponent(h)); if (!stats || s.queries > stats.queries) stats = s; } }
    let plan = null;
    if (stats && stats.slowest && /^\s*(SELECT|WITH)/i.test(stats.slowest.text)) { try {
      const ex = (await owner.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${stats.slowest.text}`, values: stats.slowest.values || [] })).rows[0]['QUERY PLAN'][0]; const nodes = [];
      const walk = (n) => { nodes.push(n); (n.Plans || []).forEach(walk); }; walk(ex.Plan);
      plan = { execution_ms: Math.round(ex['Execution Time'] * 100) / 100, nodes: [...new Set(nodes.map((n) => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] && /Seq Scan/.test(n['Node Type']) ? `(${n['Relation Name']})` : '')))].join(' → '),
        seq_scans: nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => `${n['Relation Name']}:${n['Actual Rows']}+${n['Rows Removed by Filter'] || 0} filtered`),
        rows_returned: ex.Plan['Actual Rows'], rows_removed_by_filter: nodes.reduce((a, n) => a + (n['Rows Removed by Filter'] || 0) * (n['Actual Loops'] || 1), 0),
        shared_hit_blocks: ex.Plan['Shared Hit Blocks'], shared_read_blocks: ex.Plan['Shared Read Blocks'], temp_blocks: ex.Plan['Temp Written Blocks'] || 0,
        sort_spill: nodes.some((n) => /external/i.test(n['Sort Method'] || '')), statement: stats.slowest.text.slice(0, 220) }; } catch (e) { plan = { error: e.message.slice(0, 120) }; } }
    const r = { workload: name, http: status, iterations: iters, p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), p99_ms: pct(lat, 99), max_ms: pct(lat, 100), items, response_kb: Math.round(bytes / 102.4) / 10,
      sql_statements: stats && stats.queries, distinct_sql: stats && stats.distinct_statements, db_ms: stats && stats.db_ms, most_repeated: stats && stats.most_repeated[0], plan };
    results.push(r);
    console.log(`${name.padEnd(52)} ${String(r.http).padEnd(4)} p50 ${String(r.p50_ms).padStart(8)}  p95 ${String(r.p95_ms).padStart(8)}  p99 ${String(r.p99_ms).padStart(8)}  items ${String(items).padStart(6)}  sql ${String(r.sql_statements).padStart(6)}  ${plan && plan.seq_scans && plan.seq_scans.length ? 'SEQ ' + plan.seq_scans.join(',') : ''}`);
  }
  const size = await q1(`SELECT pg_database_size(current_database()) AS db, (SELECT SUM(pg_indexes_size(c.oid)) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r') AS idx`);
  fs.writeFileSync(OUT, JSON.stringify({ workers: W, iterations: ITER, database_mb: Math.round(size.db / 1048576), index_mb: Math.round(size.idx / 1048576), results }, null, 1));
  await owner.end(); server.kill(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
