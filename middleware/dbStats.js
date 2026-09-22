// middleware/dbStats.js — DB-M1 CP5 diagnostics. Active ONLY when KAHE_DB_QUERY_STATS=1 (never in normal operation).
// Opens a statistics scope per request and reports it in response headers, so the benchmark can measure the number
// of SQL statements, the database time and the most repeated statement of every endpoint (N+1 detection).
const { STATS_ON, statsStorage, newStats, summarizeStats } = require('../database/db');
module.exports = function dbStats(req, res, next) {
  if (!STATS_ON) return next();
  const st = newStats(); const end = res.end;
  res.end = function patched(...args) { if (!res.headersSent) { try { res.setHeader('X-DB-Stats', encodeURIComponent(JSON.stringify(summarizeStats(st)))); } catch (_) { /* header too large */ } } return end.apply(this, args); };
  return statsStorage.run(st, next);
};
