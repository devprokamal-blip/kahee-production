// database/db.js
// DB-M1 — the CANONICAL DATABASE ACCESS LAYER.
//
//   Route / Service  ->  this module  ->  pg Pool  ->  PostgreSQL (single authority)
//
// Nothing outside this file talks to the PostgreSQL driver. Business code keeps
// the statement-shaped API it always had —
//     await db.prepare(sql).get(...params)   -> row | undefined
//     await db.prepare(sql).all(...params)   -> row[]
//     await db.prepare(sql).run(...params)   -> { changes, lastInsertRowid }
//     await db.exec(sql)                     -> multi-statement, no parameters
//     await withTransaction(db, async () => { ... })
// — but every call is now asynchronous and pooled. This is NOT a SQLite
// emulation: SQL is PostgreSQL SQL, written in the source. The only thing the
// layer normalises is positional parameters (`?` -> `$n`), because the code base
// builds WHERE clauses dynamically and cannot number them statically.
//
// Value rendering is pinned so business output is byte-identical to A3:
//   BIGINT / integral NUMERIC -> JS number (throws rather than lose precision)
//   DATE        -> 'YYYY-MM-DD'
//   TIMESTAMPTZ -> 'YYYY-MM-DD HH:MM:SS' in UTC (session TimeZone is forced to UTC;
//                  the BUSINESS timezone Asia/Jakarta lives in lib/businessTime.js)
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types: pgTypes } = require('pg');

// ---- configuration (environment driven; no credentials in source) ------------
const intEnv = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};
function poolConfigFromEnv(overrides = {}) {
  const cfg = {
    max: intEnv('PGPOOL_MAX', 10),
    idleTimeoutMillis: intEnv('PGPOOL_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMillis: intEnv('PGPOOL_CONNECTION_TIMEOUT_MS', 5000),
    application_name: process.env.PGAPPNAME || 'kahe360',
  };
  const url = overrides.connectionString || process.env.DATABASE_URL;
  if (url) cfg.connectionString = url;               // else pg falls back to PGHOST/PGUSER/...
  else if (!process.env.PGHOST && !process.env.PGDATABASE) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and point it at PostgreSQL.');
  }
  if (process.env.PGSSLMODE === 'require' || process.env.DATABASE_SSL === 'true') {
    cfg.ssl = { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
  }
  return { ...cfg, ...overrides };
}
const LOCK_TIMEOUT_MS = intEnv('KAHE_DB_LOCK_TIMEOUT_MS', 5000);
const STATEMENT_TIMEOUT_MS = intEnv('KAHE_DB_STATEMENT_TIMEOUT_MS', 0);   // 0 = off
const MAX_WRITE_ATTEMPTS = 4;        // 1 initial + 3 retries (unchanged from A3)
const RETRY_BASE_DELAY_MS = 25;      // 25 / 50 / 100 ms

// ---- value rendering ---------------------------------------------------------
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 };
function safeInt(text) {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Database integer ${text} exceeds the safe JavaScript range; refusing to round it.`);
  }
  return n;
}
const parsers = {
  [OID.INT8]: safeInt,
  [OID.NUMERIC]: (t) => (/^-?\d+$/.test(t) ? safeInt(t) : Number(t)),
  [OID.DATE]: (t) => t,
  [OID.TIMESTAMPTZ]: (t) => t.slice(0, 19),
  [OID.TIMESTAMP]: (t) => t.slice(0, 19),
};
const kaheTypes = {
  getTypeParser: (oid, format) => (format !== 'binary' && parsers[oid]) || pgTypes.getTypeParser(oid, format),
};

// ---- `?` -> `$n` (skips string literals, quoted identifiers and comments) ----
const placeholderCache = new Map();
// Two parameter styles exist in the code base and both are kept as written:
//   positional `?`      -> run(a, b, c)
//   named      `@name`  -> run({ name: value })      (a name may repeat)
function toNumbered(sql) {
  let hit = placeholderCache.get(sql);
  if (hit !== undefined) return hit;
  let out = ''; let n = 0; let i = 0; const names = [];
  while (i < sql.length) {
    const ch = sql[i]; const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === ch) { if (sql[j + 1] === ch) j += 2; else break; } else j += 1; }
      out += sql.slice(i, j + 1); i = j + 1;
    } else if (two === '--') {
      let j = sql.indexOf('\n', i); if (j === -1) j = sql.length; out += sql.slice(i, j); i = j;
    } else if (two === '/*') {
      let j = sql.indexOf('*/', i); j = j === -1 ? sql.length : j + 2; out += sql.slice(i, j); i = j;
    } else if (ch === '?') { n += 1; out += `$${n}`; i += 1; } else if (ch === '@' && /[A-Za-z_]/.test(sql[i + 1] || '') && !/[\w@]/.test(sql[i - 1] || '')) {
      let j = i + 1; while (j < sql.length && /\w/.test(sql[j])) j += 1;
      const name = sql.slice(i + 1, j); let k = names.indexOf(name);
      if (k === -1) { names.push(name); k = names.length - 1; }
      out += `$${k + 1}`; i = j;
    } else { out += ch; i += 1; }
  }
  if (n && names.length) throw new TypeError(`SQL mixes positional and named parameters: ${sql.slice(0, 120)}`);
  hit = { text: out, count: n || names.length, names: names.length ? names : null };
  if (placeholderCache.size < 5000) placeholderCache.set(sql, hit);
  return hit;
}
function bindParams(params, plan, sql) {
  let values = params;
  if (plan.names) {
    const bag = params[0];
    if (params.length !== 1 || bag === null || typeof bag !== 'object' || Array.isArray(bag)) {
      throw new TypeError(`SQL uses named parameters and needs ONE object argument: ${sql.slice(0, 120)}`);
    }
    values = plan.names.map((name) => {
      if (!(name in bag)) throw new TypeError(`Missing named SQL parameter @${name}: ${sql.slice(0, 120)}`);
      return bag[name];
    });
  } else if (params.length !== plan.count) {
    throw new TypeError(`SQL expects ${plan.count} parameter(s) but received ${params.length}: ${sql.slice(0, 120)}`);
  }
  for (let i = 0; i < values.length; i += 1) {
    const p = values[i];
    if (p === undefined) throw new TypeError(`SQL parameter ${i + 1} is undefined (pass null explicitly): ${sql.slice(0, 120)}`);
    if (typeof p === 'boolean') throw new TypeError(`SQL parameter ${i + 1} is a boolean; flags are stored as 0/1`);
  }
  return values;
}

// ---- safe, diagnosable errors (never log credentials or row data) ------------
function decorate(err, sql) {
  if (err && typeof err === 'object' && !err.kaheSql && sql) {
    Object.defineProperty(err, 'kaheSql', { value: sql.replace(/\s+/g, ' ').slice(0, 160), enumerable: false });
  }
  return err;
}
function describeError(err) {
  return { code: err && err.code, message: err && err.message, constraint: err && err.constraint,
    table: err && err.table, statement: err && err.kaheSql };
}

// ---- the handle --------------------------------------------------------------
const txStorage = new AsyncLocalStorage();   // Map<handle, txContext>

// ---- optional query statistics (KAHE_DB_QUERY_STATS=1) — diagnostics only, off by default ----
// Counts statements per unit of work so N+1 patterns can be MEASURED: middleware/dbStats.js opens a
// scope per HTTP request, scripts can open one with runWithQueryStats(). No SQL parameters are kept
// except for the single slowest statement of a scope (needed to EXPLAIN it), and nothing is logged.
const STATS_ON = process.env.KAHE_DB_QUERY_STATS === '1';
const statsStorage = new AsyncLocalStorage();
function newStats() { return { queries: 0, db_ms: 0, byText: new Map(), slowest: null }; }
function recordStat(text, values, ms) {
  const st = statsStorage.getStore(); if (!st) return;
  st.queries += 1; st.db_ms += ms; const key = text.replace(/\s+/g, ' ').trim();
  const e = st.byText.get(key) || { n: 0, ms: 0 }; e.n += 1; e.ms += ms; st.byText.set(key, e);
  if (!st.slowest || ms > st.slowest.ms) st.slowest = { text: key, values, ms };
}
function summarizeStats(st) {
  const top = [...st.byText.entries()].sort((a, b) => b[1].n - a[1].n);
  return { queries: st.queries, distinct_statements: st.byText.size, db_ms: Math.round(st.db_ms * 10) / 10,
    most_repeated: top.slice(0, 3).map(([text, v]) => ({ n: v.n, ms: Math.round(v.ms * 10) / 10, text: text.slice(0, 160) })),
    slowest: st.slowest ? { ms: Math.round(st.slowest.ms * 10) / 10, text: st.slowest.text, values: st.slowest.values } : null };
}
async function runWithQueryStats(fn) { const st = newStats(); const result = await statsStorage.run(st, fn); return { result, stats: summarizeStats(st) }; }

class Db {
  constructor(poolConfig) {
    // Session settings travel in the startup packet, so they are in force before
    // the first statement on every pooled connection (no per-checkout round trip).
    const session = [`-c timezone=UTC`, `-c lock_timeout=${LOCK_TIMEOUT_MS}`];
    if (STATEMENT_TIMEOUT_MS > 0) session.push(`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    this.pool = new Pool({ ...poolConfig, options: session.join(' '), types: kaheTypes });
    this.pool.on('error', (e) => console.error('[db] idle client error:', e.code || e.message));
    this.closed = false;
    this._core = this;
  }

  _tx() { const store = txStorage.getStore(); return store ? store.get(this._core) : undefined; }
  get isTransaction() { return Boolean(this._tx()); }

  async _query(text, values) {
    const tx = this._tx();
    const t0 = STATS_ON ? process.hrtime.bigint() : 0n;
    try {
      if (tx) {
        if (tx.finished) throw new Error('Query issued after its transaction ended — a missing `await` inside withTransaction.');
        return await tx.client.query(text, values);
      }
      return await this.pool.query(text, values);
    } catch (err) { throw decorate(err, text); } finally { if (STATS_ON) recordStat(text, values, Number(process.hrtime.bigint() - t0) / 1e6); }
  }

  /** Native PostgreSQL parameters ($1..$n). */
  query(text, values = []) { return this._query(text, values); }

  prepare(sql) {
    const plan = toNumbered(sql);
    const exec = async (params) => this._query(plan.text, bindParams(params, plan, sql));
    return {
      get: async (...params) => (await exec(params)).rows[0],
      all: async (...params) => (await exec(params)).rows,
      run: async (...params) => {
        const r = await exec(params);
        const first = r.rows && r.rows[0];
        return { changes: r.rowCount || 0, lastInsertRowid: first && first.id !== undefined ? first.id : undefined };
      },
    };
  }

  /** Multi-statement SQL without parameters (DDL, fixtures). */
  async exec(sql) { await this._query(sql); }

  async close() { if (!this.closed) { this.closed = true; await this.pool.end(); } }
  poolStats() { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }; }
}

/**
 * Atomic unit of work on ONE checked-out client. A nested call joins the outer
 * transaction (same contract as A3). Any throw rolls back everything.
 */
async function withTransaction(db, fn) {
  if (db._tx()) return fn();
  const client = await db.pool.connect();
  const ctx = { client, finished: false };
  const store = new Map(txStorage.getStore() || []);
  store.set(db._core, ctx);
  let broken = false;
  // DB-M1 CP6: pg-pool only listens for errors on IDLE clients. A checked-out client whose connection dies (server
  // restart, fail-over, pg_terminate_backend) emits 'error' with no listener — which would crash the whole Node process.
  // While the transaction owns the client we own its errors: remember it, let the failing statement reject normally,
  // and make sure the dead connection is destroyed instead of being returned to the pool.
  const onConnectionError = (e) => { broken = true; ctx.connectionError = e; };
  client.on('error', onConnectionError);
  try {
    await client.query('BEGIN');
    const result = await txStorage.run(store, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {
      broken = true;
      console.error('[db] ROLLBACK failed after error:', rollbackErr.code || rollbackErr.message);
    }
    throw err;
  } finally {
    ctx.finished = true;
    client.removeListener('error', onConnectionError);
    client.release(broken ? (ctx.connectionError || new Error('rollback failed')) : undefined);   // broken clients are destroyed, not reused
  }
}

// serialization_failure, deadlock_detected, lock_not_available
const RETRYABLE = new Set(['40001', '40P01', '55P03']);
const isRetryableLockError = (err) => Boolean(err && RETRYABLE.has(err.code));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bounded retry of a WHOLE unit of work (normally one withTransaction call). */
async function withRetry(fn, { maxAttempts = MAX_WRITE_ATTEMPTS, label = 'write' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await fn(attempt); } catch (err) {
      if (!isRetryableLockError(err)) throw err;
      lastError = err;
      if (attempt === maxAttempts) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  const exhausted = new Error(
    `Database sedang sibuk dan tidak bisa diakses setelah ${maxAttempts} percobaan (${label}). `
    + `Coba lagi sesaat lagi. Penyebab asal: ${lastError && lastError.message}`);
  exhausted.code = 'DB_BUSY_EXHAUSTED';
  exhausted.cause = lastError;
  throw exhausted;
}

// ---- process-wide handle -----------------------------------------------------
let shared = null;
// Request code follows the A3 shape `const db = getDb(); try { … } finally { db.close(); }`.
// With a pool that per-request close() must NOT end the pool, so getDb() hands
// out a lightweight facade whose close() is a no-op; closeDb() ends the pool.
function getDb() {
  if (!shared || shared.closed) shared = new Db(poolConfigFromEnv());
  return Object.create(shared, { close: { value: async () => {} } });
}
function createDb(overrides) { return new Db(poolConfigFromEnv(overrides)); }
async function closeDb() { if (shared) { await shared.close(); shared = null; } }

module.exports = { runWithQueryStats, statsStorage, newStats, summarizeStats, STATS_ON, getDb, createDb, closeDb, withTransaction, withRetry, isRetryableLockError,
  describeError, toNumbered, poolConfigFromEnv, LOCK_TIMEOUT_MS, MAX_WRITE_ATTEMPTS };
