// tools/scale/stats-preload.js — DB-M1 CP5. `KAHE_DB_QUERY_STATS=1 node -r ./tools/scale/stats-preload.js <script>`
// Measures the SQL traffic of ANY script (e.g. a frozen payroll suite) WITHOUT modifying it: one statistics scope for the
// whole process, summary printed at exit. Used for N+1 evidence on the payroll engine.
const { statsStorage, newStats, summarizeStats } = require('../../database/db');
const st = newStats(); statsStorage.enterWith(st); const t0 = Date.now();
const exit = process.exit; process.exit = function patched(code) {
  const s = summarizeStats(st); const top = [...st.byText.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  console.log(`\n[SQL-STATS] wall ${((Date.now() - t0) / 1000).toFixed(1)} s · statements ${s.queries} · distinct ${s.distinct_statements} · db time ${(s.db_ms / 1000).toFixed(1)} s`);
  for (const [text, v] of top) console.log(`[SQL-STATS] ${String(v.n).padStart(7)} × ${(v.ms / v.n).toFixed(2)} ms  ${text.slice(0, 150)}`);
  return exit.call(process, code); };
