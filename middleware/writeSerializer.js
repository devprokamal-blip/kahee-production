// middleware/writeSerializer.js — DB-M1 CP5
// WHY: through A3 the application ran on synchronous node:sqlite, so every request executed to completion before the
// next one started. A great deal of code relies on that without saying so: "load the row, check its status in
// JavaScript, then UPDATE … WHERE id = ?". With asynchronous PostgreSQL access two such requests can interleave — measured
// in CP5: 12 simultaneous decisions on ONE correction request were ALL accepted (6 approvals and 6 rejections, 6 applied
// versions). 52 state-changing UPDATEs follow that pattern, 31 of them in FROZEN payroll files that must not be edited.
//
// WHAT: mutating API requests (POST/PUT/PATCH/DELETE under /api, except /api/auth) are executed ONE AT A TIME, in arrival
// order — exactly the write concurrency A3 had. Reads are NOT queued and run concurrently on the pool. No business code
// is touched; nothing about any single request changes.
//
// LIMITS (documented, not hidden): the queue is per process — a multi-process deployment needs the same guarantee from
// PostgreSQL (advisory lock or per-statement state guards; the attendance correction flow already has such guards). A long
// write (a 1,500-employee payroll calculation) delays other writes while it runs, as it did on SQLite.
// KAHE_WRITE_SERIALIZATION=off disables it (benchmarks only — never in operation until every write path is guarded).
const MODE = process.env.KAHE_WRITE_SERIALIZATION === 'off' ? 'off' : 'global';
let tail = Promise.resolve(); let depth = 0; let maxDepth = 0;

function writeSerializer(req, res, next) {
  if (MODE === 'off' || !/^(POST|PUT|PATCH|DELETE)$/.test(req.method) || !req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
  depth += 1; maxDepth = Math.max(maxDepth, depth);
  const turn = tail;
  let release; tail = new Promise((resolve) => { release = resolve; });
  let done = false; const finish = () => { if (!done) { done = true; depth -= 1; release(); } };
  res.once('finish', finish); res.once('close', finish);       // released when the response is sent OR the client goes away
  return turn.then(() => { if (done) return undefined; return next(); });
}
writeSerializer.stats = () => ({ mode: MODE, queued_now: depth, max_queue_depth: maxDepth });
module.exports = writeSerializer;
