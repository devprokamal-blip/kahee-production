// tools/scale/rush-hour.js <workers-db-suffix> <events> <concurrency> <out.json> — DB-M1 CP5
// 07:45–08:00 WIB clock-in peak through the REAL server: POST /api/timesheet/entries for <events> DISTINCT workers on a
// new business day, <concurrency> requests in flight, real RBAC + entity scope + eligibility + schedule resolution +
// audit event per record, durable tables (no UNLOGGED, synchronous_commit as configured on the server). Then a
// duplicate replay proves idempotency: the same worker/day must be refused and must not create a second row.
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const { Client } = require('pg');
const [N, C, OUT] = [Number(process.argv[3]), Number(process.argv[4]), process.argv[5]]; const DATE = process.env.RUSH_DATE || '2026-10-05';
const PORT = 47000 + Math.floor(Math.random() * 2000); const BASE = `http://127.0.0.1:${PORT}`;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] * 10) / 10 : null; };
(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', SESSION_SECRET: 'bench-only-secret-0123456789abcdef-0123456789' }, stdio: 'pipe' });
  let serverErr = ''; server.stderr.on('data', (d) => { serverErr += d; });
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/api/system/health`); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'workforce@kahe360.local', password: 'Kahe360Demo!2026' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]; if (login.status !== 200) throw new Error(`login ${login.status} ${serverErr.slice(0, 200)}`);
  // pg_stat_activity hides state / wait_event / xact_start of OTHER roles' sessions from an ordinary role (they read as NULL),
  // so lock waiters, active queries and transaction age are only valid through a monitoring role (pg_monitor / superuser).
  const mon = new Client({ connectionString: process.env.RUSH_MONITOR_URL || process.env.DATABASE_MIGRATION_URL }); await mon.connect();
  const canSeeState = (await mon.query(`SELECT pg_has_role(current_user, 'pg_monitor', 'MEMBER') OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS ok`)).rows[0].ok;
  const dbStat = async () => (await mon.query(`SELECT deadlocks, xact_commit, xact_rollback, tup_inserted FROM pg_stat_database WHERE datname = current_database()`)).rows[0];
  const before = await dbStat(); const rowsBefore = Number((await mon.query('SELECT COUNT(*) AS n FROM timesheet_entries WHERE work_date = $1', [DATE])).rows[0].n);
  const evBefore = Number((await mon.query('SELECT COUNT(*) AS n FROM attendance_events WHERE work_date = $1', [DATE])).rows[0].n);
  const peak = { connections: 0, active: 0, lock_waiters: 0, longest_tx_ms: 0, idle_in_tx: 0, samples: 0, samples_with_lock_wait: 0 }; let sampling = true;
  const sampler = (async () => { while (sampling) { const r = (await mon.query(`SELECT COUNT(*) AS c, COUNT(*) FILTER (WHERE state = 'active') AS a, COUNT(*) FILTER (WHERE wait_event_type = 'Lock') AS l, COUNT(*) FILTER (WHERE state = 'idle in transaction') AS iit,
      COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000) FILTER (WHERE xact_start IS NOT NULL AND state <> 'idle'), 0) AS t FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'kahe360'`)).rows[0];
    peak.connections = Math.max(peak.connections, Number(r.c)); peak.active = Math.max(peak.active, Number(r.a)); peak.lock_waiters = Math.max(peak.lock_waiters, Number(r.l)); peak.idle_in_tx = Math.max(peak.idle_in_tx, Number(r.iit)); peak.samples += 1; if (Number(r.l) > 0) peak.samples_with_lock_wait += 1; peak.longest_tx_ms = Math.max(peak.longest_tx_ms, Math.round(Number(r.t)));
    await new Promise((res) => setTimeout(res, 100)); } })();
  const body = (i) => ({ employee_id: `SC-${String(i + 1).padStart(6, '0')}`, work_date: DATE, attendance_status: 'present', shift: 'day', clock_in: `07:${String(45 + (i % 15)).padStart(2, '0')}` });
  const fire = async (list) => { const lat = []; const status = {}; const samples = {}; let next = 0; const t0 = Date.now();
    await Promise.all(Array.from({ length: C }, async () => { for (;;) { const i = next; next += 1; if (i >= list.length) return; const s = process.hrtime.bigint();
      let code; let text = ''; try { const r = await fetch(`${BASE}/api/timesheet/entries`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body(list[i])) }); code = r.status; text = await r.text(); } catch (e) { code = `ERR:${e.cause ? e.cause.code : e.message}`; }
      lat.push(Number(process.hrtime.bigint() - s) / 1e6); status[code] = (status[code] || 0) + 1; if (!samples[code]) samples[code] = text.slice(0, 160); } }));
    return { lat, status, samples, seconds: (Date.now() - t0) / 1000 }; };
  const main = await fire(Array.from({ length: N }, (_, i) => i));
  const dupList = Array.from({ length: Math.ceil(N / 10) }, (_, i) => i * 10); const dup = await fire(dupList);
  sampling = false; await sampler;
  const after = await dbStat(); const rows = Number((await mon.query('SELECT COUNT(*) AS n FROM timesheet_entries WHERE work_date = $1', [DATE])).rows[0].n) - rowsBefore;
  const events = Number((await mon.query('SELECT COUNT(*) AS n FROM attendance_events WHERE work_date = $1', [DATE])).rows[0].n) - evBefore;
  const dupes = Number((await mon.query('SELECT COUNT(*) AS n FROM (SELECT 1 FROM timesheet_entries WHERE work_date = $1 GROUP BY employee_id HAVING COUNT(*) > 1) d', [DATE])).rows[0].n);
  const okCount = Object.entries(main.status).filter(([k]) => /^20/.test(k)).reduce((n, [, v]) => n + v, 0);
  const out = { events_sent: N, concurrency: C, business_date: DATE, seconds: main.seconds, events_per_second: Math.round(N / main.seconds), accepted: okCount, http_status: main.status, error_rate_pct: Math.round((N - okCount) / N * 10000) / 100, error_samples: Object.fromEntries(Object.entries(main.samples).filter(([k]) => !/^20/.test(k))),
    p50_ms: pct(main.lat, 50), p95_ms: pct(main.lat, 95), p99_ms: pct(main.lat, 99), max_ms: pct(main.lat, 100), attendance_rows_created: rows, audit_events_created: events, db_rows_inserted: Number(after.tup_inserted) - Number(before.tup_inserted),
    db_inserts_per_second: Math.round((Number(after.tup_inserted) - Number(before.tup_inserted)) / (main.seconds + dup.seconds)), transactions_committed: Number(after.xact_commit) - Number(before.xact_commit), transactions_rolled_back: Number(after.xact_rollback) - Number(before.xact_rollback),
    deadlocks: Number(after.deadlocks) - Number(before.deadlocks), session_state_visible_to_monitor: canSeeState, peak_db_connections: peak.connections, pool_max: Number(process.env.PGPOOL_MAX || 10), peak_active_queries: peak.active, peak_lock_waiters: peak.lock_waiters, longest_transaction_ms: peak.longest_tx_ms, peak_idle_in_transaction: peak.idle_in_tx, monitor_samples: peak.samples, samples_with_lock_wait: peak.samples_with_lock_wait,
    duplicate_replay: { sent: dupList.length, http_status: dup.status, sample: Object.values(dup.samples)[0], rows_with_duplicate_employee_day: dupes }, integrity_ok: rows === okCount && dupes === 0 };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(JSON.stringify(out));
  await mon.end(); server.kill(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
