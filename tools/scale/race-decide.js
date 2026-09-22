// tools/scale/race-decide.js <app-root> <correction-id> — DB-M1 CP5. Fires N simultaneous approve/reject decisions at ONE open
// correction request through the real server and reports how many "won" and what history they left. Exactly one may win.
//   DATABASE_URL=<runtime url> DATABASE_MIGRATION_URL=<owner url> node tools/scale/race-decide.js . 4
const { spawn } = require('child_process'); const path = require('path'); const { Client } = require('pg');
const ROOT = path.resolve(process.argv[2]); const ID = Number(process.argv[3]); const N = Number(process.env.RACE_N || 12);
const PORT = 49000 + Math.floor(Math.random() * 900); const BASE = `http://127.0.0.1:${PORT}`;
(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SESSION_SECRET: 'race-only-secret-0123456789abcdef' }, stdio: 'pipe' });
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/api/system/health`); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.RACE_LOGIN || 'director@kahe360.local', password: 'Kahe360Demo!2026' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const fire = (i) => fetch(`${BASE}/api/attendance-correction/requests/${ID}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: i % 2 ? 'rejected' : 'approved', reason: `race ${i}` }) }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 90) }));
  const res = await Promise.all(Array.from({ length: N }, (_, i) => fire(i)));
  const pg = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL }); await pg.connect();
  const q = async (s) => (await pg.query(s, [ID])).rows;
  const out = { simultaneous_decisions: N, http: res.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}), sample_409: (res.find((r) => r.status === 409) || {}).body,
    final_status: (await q('SELECT status FROM attendance_corrections WHERE id = $1'))[0].status,
    decision_history_rows: (await q(`SELECT action, to_status FROM attendance_correction_actions WHERE correction_id = $1 AND to_status NOT IN ('SUBMITTED','DRAFT','UNDER_REVIEW') ORDER BY id`)).map((r) => `${r.action}->${r.to_status}`),
    versions_created: Number((await q('SELECT COUNT(*) AS n FROM attendance_entry_versions WHERE correction_id = $1'))[0].n),
    audit_events: Number((await q('SELECT COUNT(*) AS n FROM attendance_events WHERE correction_id = $1'))[0].n) };
  out.winners = out.http[200] || 0; out.exactly_one_winner = out.winners === 1;
  console.log(JSON.stringify(out)); await pg.end(); server.kill(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
