// database/pg/migrate-from-sqlite.js — DB-M1 CP4
// ONE-WAY data migration: authoritative A3 SQLite file -> FRESH PostgreSQL database.
//
//   node database/pg/migrate-from-sqlite.js --source <file.db> --preflight          inspect the source only
//   node database/pg/migrate-from-sqlite.js --source <file.db> --dry-run            preflight + full trial load, ROLLED BACK
//   node database/pg/migrate-from-sqlite.js --source <file.db> [--report out.json]  migrate + reconcile
// Destination: DATABASE_MIGRATION_URL (schema owner). It must already be migrated (`npm run db:migrate`) and EMPTY.
//
// Rules this tool enforces:
//   * The SQLite source is opened READ-ONLY and its sha256 is checked before and after. It is never modified.
//   * PREFLIGHT runs before any PostgreSQL write. A malformed date, timestamp, integer, orphan reference,
//     duplicate, NULL or broken chain is REPORTED (table, row identity, column, reason) and BLOCKS the migration.
//     Nothing is ever normalised, repaired, skipped or renumbered.
//   * Historical primary keys are inserted exactly as they are. Identity sequences are then advanced to
//     GREATEST(max(id), sqlite_sequence.seq) so new rows can never collide with — or reuse — a historical id.
//   * Table order is computed from the real foreign keys of the destination schema (topological), never guessed.
//   * The whole load is ONE PostgreSQL transaction with a SAVEPOINT per table for precise error reporting.
//     Any failure rolls back everything: the destination is left fresh and the tool can simply be rerun.
//     A successful run writes a row to data_migrations in the same transaction; a second run is refused
//     because the destination is no longer empty. There is no dual-write and no incremental/merge mode.
//   * Integrity triggers are disabled ONLY inside that transaction (history must load as-is: e.g. attendance
//     that is already covered by a frozen snapshot) and are re-enabled before COMMIT. Foreign keys, CHECK,
//     NOT NULL and unique constraints stay ON throughout.
//   * `sessions` is not migrated: sessions are ephemeral; users sign in again after cut-over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, types: pgTypes } = require('pg');

const TOOL_VERSION = 'dbm1-cp4-1';
const SKIP_TABLES = new Set(['sessions', 'schema_migrations', 'data_migrations']);
// A4 CP1 (migration 0006): PostgreSQL-NATIVE tables. They have no A3 SQLite source and start empty in a
// fresh destination, so they are not part of the A3 catalogue. EXPLICIT allowlist — every A3 table stays
// mandatory and fully reconciled. Add a name here only together with the migration that creates it.
const PG_NATIVE_TABLES = new Set(['attendance_periods', 'attendance_period_events', 'attendance_closing_policies',
  'attendance_closing_policy_rules', 'attendance_closing_policy_events']);
// A4 CP2 (migration 0007): same rule, separate exact allowlist (the CP1 set above stays exactly the 5 CP1 tables).
const PG_NATIVE_TABLES_CP2 = new Set(['attendance_readiness_evaluations']);
const BATCH_ROWS = 400;
const MAX_FINDINGS_PER_CHECK = 50;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

// References the A3 schema relies on but does not declare as FOREIGN KEY (audit / history / actor links).
const SOFT_REFERENCES = [
  ['attendance_events', 'timesheet_entry_id', 'timesheet_entries', 'id'], ['attendance_events', 'correction_id', 'attendance_corrections', 'id'],
  ['attendance_events', 'exception_id', 'attendance_exceptions', 'id'], ['attendance_events', 'actor_user_id', 'users', 'id'],
  ['attendance_events', 'employee_id', 'employees', 'id'],
  ['attendance_entry_versions', 'timesheet_entry_id', 'timesheet_entries', 'id'], ['attendance_entry_versions', 'actor_user_id', 'users', 'id'],
  ['attendance_correction_actions', 'actor_user_id', 'users', 'id'],
  ['attendance_corrections', 'requested_by_user_id', 'users', 'id'], ['attendance_corrections', 'reviewed_by_user_id', 'users', 'id'],
  ['attendance_corrections', 'decided_by_user_id', 'users', 'id'], ['attendance_corrections', 'payroll_reviewed_by_user_id', 'users', 'id'],
  ['attendance_exceptions', 'employee_id', 'employees', 'id'], ['attendance_exceptions', 'resolved_by_user_id', 'users', 'id'],
  ['attendance_payroll_adjustments', 'payroll_reviewed_by_user_id', 'users', 'id'],
  ['timesheet_entries', 'recorded_by_user_id', 'users', 'id'], ['timesheet_entries', 'overtime_requested_by_user_id', 'users', 'id'],
  ['timesheet_entries', 'overtime_decided_by_user_id', 'users', 'id'], ['timesheet_entries', 'work_schedule_id', 'work_schedules', 'id'],
];

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const validDate = (s) => { const m = DATE_RE.exec(s); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return +m[1] >= 1 && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const validTimestamp = (s) => { const m = TS_RE.exec(s); return Boolean(m) && validDate(`${m[1]}-${m[2]}-${m[3]}`) && +m[4] < 24 && +m[5] < 60 && +m[6] < 60; };

function openSource(file) {
  if (!fs.existsSync(file)) throw new Error(`SQLite source not found: ${file}`);
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// ---- destination catalogue ---------------------------------------------------
async function loadCatalogue(pg) {
  const cols = (await pg.query(`SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n, is_identity AS i, ordinal_position AS o
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
  const tables = {};
  for (const r of cols) { if (SKIP_TABLES.has(r.t) || PG_NATIVE_TABLES.has(r.t) || PG_NATIVE_TABLES_CP2.has(r.t) || r.t.startsWith('_')) continue;
    (tables[r.t] = tables[r.t] || { name: r.t, columns: [], pk: [], fks: [], uniques: [] }).columns.push({ name: r.c, type: r.d, notNull: r.n === 'NO', identity: r.i === 'YES' }); }
  const cons = (await pg.query(`SELECT c.relname AS t, con.contype AS k, con.conname AS name,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
      rc.relname AS rt,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS rcols
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class rc ON rc.oid = con.confrelid
    WHERE c.relnamespace = 'public'::regnamespace AND con.contype IN ('p','f','u')`)).rows;
  for (const r of cons) { const t = tables[r.t]; if (!t) continue;
    if (r.k === 'p') t.pk = r.cols; else if (r.k === 'u') t.uniques.push({ name: r.name, cols: r.cols }); else t.fks.push({ cols: r.cols, table: r.rt, rcols: r.rcols }); }
  // dependency-safe order from the REAL foreign keys (self references ignored; they are validated by preflight + FK on insert order by pk)
  const order = []; const seen = new Set();
  const visit = (n, stack) => { if (seen.has(n)) return; if (stack.includes(n)) throw new Error(`Foreign-key cycle: ${[...stack, n].join(' -> ')}`);
    for (const fk of tables[n].fks) if (fk.table !== n && tables[fk.table]) visit(fk.table, [...stack, n]); seen.add(n); order.push(n); };
  for (const n of Object.keys(tables).sort()) visit(n, []);
  return { tables, order };
}

// ---- PREFLIGHT (source only; no PostgreSQL write) ---------------------------
function preflight(src, cat) {
  const findings = []; const counts = {}; const stats = { tables: 0, rows: 0, values_checked: 0 };
  const add = (check, table, row, column, reason) => { counts[check] = (counts[check] || 0) + 1; if (counts[check] <= MAX_FINDINGS_PER_CHECK) findings.push({ check, table, row, column, reason }); };
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
  for (const t of srcTables) if (!cat.tables[t] && !SKIP_TABLES.has(t)) add('schema', t, null, null, 'source table does not exist in the PostgreSQL schema (not an A3-shaped database?)');
  for (const name of cat.order) {
    const t = cat.tables[name];
    if (!srcTables.has(name)) { add('schema', name, null, null, 'table missing in the source: upgrade the SQLite file to the A3 shape first (database/legacy-sqlite/migrate-*.js)'); continue; }
    const srcCols = new Set(src.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    for (const c of t.columns) if (!srcCols.has(c.name)) add('schema', name, null, c.name, 'column missing in the source');
    for (const c of srcCols) if (!t.columns.find((x) => x.name === c)) add('schema', name, null, c, 'source column has no destination column — data would be lost');
    if (counts.schema) continue;
    stats.tables += 1;
    const ident = (row) => (t.pk.length ? t.pk.map((k) => `${k}=${JSON.stringify(row[k])}`).join(',') : JSON.stringify(row).slice(0, 80));
    // read integers as BigInt so a value beyond the safe range is REPORTED instead of crashing the reader
    const reader = src.prepare(`SELECT * FROM ${name}`); reader.setReadBigInts(true);
    for (const raw of reader.iterate()) {
      const row = {}; for (const k of Object.keys(raw)) { const x = raw[k]; row[k] = typeof x === 'bigint' && x >= -9007199254740991n && x <= 9007199254740991n ? Number(x) : x; }
      stats.rows += 1;
      for (const c of t.columns) {
        const v = row[c.name]; stats.values_checked += 1;
        if (v === null || v === undefined) { if (c.notNull) add('nullability', name, ident(row), c.name, 'NULL in a column that is NOT NULL in PostgreSQL'); continue; }
        const ty = typeof v;
        if (ty === 'object') { add('type', name, ident(row), c.name, 'BLOB value; no destination column is binary'); continue; }
        if (c.type === 'bigint') {
          if (ty === 'bigint' || (ty === 'number' && !Number.isSafeInteger(v))) add('integer_range', name, ident(row), c.name, `${String(v)} is not a safe 64-bit/JS integer`);
          else if (ty !== 'number') add('type', name, ident(row), c.name, `${JSON.stringify(v)} (${ty}) stored in an INTEGER column`);
          else if (c.identity && v <= 0) add('identity', name, ident(row), c.name, `historical id ${v} cannot be preserved (must be a positive integer)`);
        } else if (c.type === 'double precision') { if (ty !== 'number' || !Number.isFinite(v)) add('type', name, ident(row), c.name, `${JSON.stringify(v)} is not a finite number`); }
        else if (ty !== 'string') add('type', name, ident(row), c.name, `${JSON.stringify(v)} (${ty}) stored in a TEXT/DATE/TIMESTAMP column — would change representation`);
        else if (c.type === 'date') { if (!validDate(v)) add('malformed_date', name, ident(row), c.name, `${JSON.stringify(v)} is not a real calendar date in YYYY-MM-DD form`); }
        else if (c.type === 'timestamp with time zone') { if (!validTimestamp(v)) add('malformed_timestamp', name, ident(row), c.name, `${JSON.stringify(v)} is not a valid UTC 'YYYY-MM-DD HH:MM:SS' timestamp`); }
        else if (v.includes('\u0000')) add('type', name, ident(row), c.name, 'text contains a NUL byte, which PostgreSQL cannot store');
      }
    }
    if (t.pk.length) for (const r of src.prepare(`SELECT ${t.pk.join(', ')}, COUNT(*) AS n FROM ${name} GROUP BY ${t.pk.join(', ')} HAVING COUNT(*) > 1 LIMIT ${MAX_FINDINGS_PER_CHECK + 1}`).all())
      add('duplicate', name, t.pk.map((k) => `${k}=${JSON.stringify(r[k])}`).join(','), t.pk.join(','), `duplicate primary key (${r.n} rows)`);
    // declared foreign keys (checked explicitly: SQLite only enforces them when the pragma was ON at write time)
    for (const fk of t.fks) { if (!srcTables.has(fk.table)) continue;
      const on = fk.cols.map((c, i) => `p.${fk.rcols[i]} = c.${c}`).join(' AND '); const nn = fk.cols.map((c) => `c.${c} IS NOT NULL`).join(' AND ');
      for (const r of src.prepare(`SELECT c.* FROM ${name} c WHERE ${nn} AND NOT EXISTS (SELECT 1 FROM ${fk.table} p WHERE ${on}) LIMIT ${MAX_FINDINGS_PER_CHECK + 1}`).all())
        add('foreign_key', name, ident(r), fk.cols.join(','), `references ${fk.table}(${fk.rcols.join(',')}) = ${fk.cols.map((c) => JSON.stringify(r[c])).join(',')} which does not exist`); }
    for (const u of t.uniques) { const g = u.cols.join(', ');
      for (const r of src.prepare(`SELECT ${g}, COUNT(*) AS n FROM ${name} WHERE ${u.cols.map((c) => `${c} IS NOT NULL`).join(' AND ')} GROUP BY ${g} HAVING COUNT(*) > 1 LIMIT ${MAX_FINDINGS_PER_CHECK + 1}`).all())
        add('duplicate', name, u.cols.map((c) => `${c}=${JSON.stringify(r[c])}`).join(','), g, `${r.n} rows violate UNIQUE ${u.name}`); }
  }
  if (!counts.schema) {
    // unique + PARTIAL unique indexes: evaluate the authoritative A3 index definitions against the source data
    const ref = new (require('node:sqlite').DatabaseSync)(':memory:'); require('../legacy-sqlite/init-db').initDb(ref);
    for (const ix of ref.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql LIKE 'CREATE UNIQUE%'").all()) {
      const sql = ix.sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '); const open = sql.indexOf('(', sql.toUpperCase().indexOf(' ON ')); let depth = 0; let end = open;
      for (let i = open; i < sql.length; i += 1) { if (sql[i] === '(') depth += 1; if (sql[i] === ')') { depth -= 1; if (!depth) { end = i; break; } } }
      const exprs = sql.slice(open + 1, end); const where = /\bWHERE\b/i.test(sql.slice(end)) ? sql.slice(end).split(/\bWHERE\b/i)[1] : null;
      const rows = src.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${ix.tbl_name} ${where ? `WHERE ${where}` : ''} GROUP BY ${exprs} HAVING COUNT(*) > 1)`).get();
      if (rows.n) add('duplicate', ix.tbl_name, null, exprs, `${rows.n} key(s) violate the unique${where ? ' PARTIAL' : ''} index ${ix.name}`);
    }
    ref.close();
    for (const [tbl, col, rt, rc] of SOFT_REFERENCES) {
      for (const r of src.prepare(`SELECT c.* FROM ${tbl} c WHERE c.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${rt} p WHERE p.${rc} = c.${col}) LIMIT ${MAX_FINDINGS_PER_CHECK + 1}`).all())
        add(/event|version|action/.test(tbl) ? 'audit_reference' : 'soft_reference', tbl, `id=${r.id}`, col, `points at ${rt}.${rc} = ${JSON.stringify(r[col])} which does not exist`);
    }
    // correction / version chains
    for (const r of src.prepare(`SELECT timesheet_entry_id AS e, COUNT(*) AS n, MIN(version_no) AS lo, MAX(version_no) AS hi, COUNT(DISTINCT version_no) AS d
      FROM attendance_entry_versions GROUP BY timesheet_entry_id HAVING lo != 1 OR hi != n OR d != n`).all())
      add('version_chain', 'attendance_entry_versions', `timesheet_entry_id=${r.e}`, 'version_no', `chain is not 1..n without gaps or repeats (n=${r.n}, min=${r.lo}, max=${r.hi}, distinct=${r.d})`);
    for (const r of src.prepare(`SELECT c.id, c.timesheet_entry_id AS e, c.applied_version_no AS v FROM attendance_corrections c WHERE c.applied_version_no IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM attendance_entry_versions x WHERE x.timesheet_entry_id = c.timesheet_entry_id AND x.version_no = c.applied_version_no)`).all())
      add('version_chain', 'attendance_corrections', `id=${r.id}`, 'applied_version_no', `applied version ${r.v} of entry ${r.e} does not exist`);
    for (const r of src.prepare(`SELECT id FROM attendance_corrections c WHERE status IN ('APPLIED','VOIDED') AND NOT EXISTS (SELECT 1 FROM attendance_correction_actions a WHERE a.correction_id = c.id)`).all())
      add('version_chain', 'attendance_corrections', `id=${r.id}`, 'status', 'applied/voided request has no approval-history rows');
    for (const r of src.prepare(`SELECT l.id FROM payroll_run_lines l JOIN payroll_input_snapshots s ON s.id = l.snapshot_id WHERE s.employee_id != l.employee_id`).all())
      add('payroll_reference', 'payroll_run_lines', `id=${r.id}`, 'snapshot_id', 'run line and its snapshot belong to different employees');
    for (const r of src.prepare(`SELECT p.id FROM payroll_payslips p JOIN payroll_run_lines l ON l.id = p.payroll_run_line_id WHERE l.payroll_run_id != p.payroll_run_id OR l.employee_id != p.employee_id`).all())
      add('payroll_reference', 'payroll_payslips', `id=${r.id}`, 'payroll_run_line_id', 'payslip does not match the run/employee of its run line');
    // identity collision risk: sqlite_sequence must never be below max(id) handled at reset; report the plan
  }
  return { ok: findings.length === 0, stats, counts, findings };
}

// ---- LOAD -------------------------------------------------------------------
async function assertFresh(pg, cat) {
  const dirty = [];
  for (const name of cat.order) if ((await pg.query(`SELECT 1 FROM ${name} LIMIT 1`)).rowCount) dirty.push(name);
  if (dirty.length) throw new Error(`Destination is not fresh — these tables already contain rows: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}. `
    + 'This tool only loads into an EMPTY, migrated database; create a new one (it never merges and never overwrites).');
}
async function load(src, pg, cat, log) {
  const perTable = {}; let total = 0;
  const userTriggers = (await pg.query(`SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace`)).rows.map((r) => r.t);
  for (const t of userTriggers) await pg.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  for (const name of cat.order) {
    const t = cat.tables[name]; const cols = t.columns.map((c) => c.name); const colSql = cols.map((c) => `"${c}"`).join(',');
    await pg.query(`SAVEPOINT t_${name}`);
    let n = 0; let batch = [];
    const flush = async () => { if (!batch.length) return;
      const values = []; const tuples = batch.map((row, i) => `(${cols.map((c, j) => { values.push(row[c]); return `$${i * cols.length + j + 1}`; }).join(',')})`);
      // ids are GENERATED BY DEFAULT, so an explicit historical id is stored exactly as given
      await pg.query(`INSERT INTO ${name} (${colSql}) VALUES ${tuples.join(',')}`, values);
      n += batch.length; batch = []; };
    try {
      const orderBy = t.pk.length ? ` ORDER BY ${t.pk.join(',')}` : '';
      for (const row of src.prepare(`SELECT ${cols.join(',')} FROM ${name}${orderBy}`).iterate()) { batch.push(row); if (batch.length >= Math.max(1, Math.floor(BATCH_ROWS * 20 / cols.length))) await flush(); }
      await flush();
      await pg.query(`RELEASE SAVEPOINT t_${name}`);
    } catch (err) {
      await pg.query(`ROLLBACK TO SAVEPOINT t_${name}`).catch(() => {});
      const e = new Error(`Table ${name}: ${err.message}${err.detail ? ` — ${err.detail}` : ''}${err.constraint ? ` [constraint ${err.constraint}]` : ''}`);
      e.table = name; throw e;
    }
    perTable[name] = n; total += n; if (n) log(`  loaded ${String(n).padStart(8)}  ${name}`);
  }
  // identity generators: never collide with, and never REUSE, a historical id
  const sequences = {};
  const seqSrc = src.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").get() ? Object.fromEntries(src.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, r.seq])) : {};
  for (const name of cat.order) { const idc = cat.tables[name].columns.find((c) => c.identity); if (!idc) continue;
    const max = Number((await pg.query(`SELECT COALESCE(MAX(${idc.name}), 0) AS m FROM ${name}`)).rows[0].m); const floor = Math.max(max, Number(seqSrc[name] || 0));
    if (floor > 0) await pg.query(`SELECT setval(pg_get_serial_sequence($1, $2), $3, true)`, [name, idc.name, floor]);
    sequences[name] = { max_historical_id: max, sqlite_sequence: seqSrc[name] ?? null, next_id: floor + 1 }; }
  for (const t of userTriggers) await pg.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  const stillOff = (await pg.query(`SELECT COUNT(*)::int AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND g.tgenabled <> 'O'`)).rows[0].n;
  if (stillOff) throw new Error(`${stillOff} integrity trigger(s) are not enabled after the load`);
  return { perTable, total, sequences };
}

// ---- RECONCILIATION ----------------------------------------------------------
// Canonical row form, identical on both sides: column order of the destination schema; integers as numbers;
// DATE 'YYYY-MM-DD'; TIMESTAMPTZ 'YYYY-MM-DD HH:MM:SS' (UTC); everything else verbatim. No column is excluded.
const RENDER = { 20: (t) => Number(t), 1700: (t) => Number(t), 701: (t) => Number(t), 1082: (t) => t, 1184: (t) => t.slice(0, 19), 1114: (t) => t.slice(0, 19) };
const renderTypes = { getTypeParser: (oid, fmt) => (fmt !== 'binary' && RENDER[oid]) || pgTypes.getTypeParser(oid, fmt) };
// BOUNDED MEMORY: tables with a single-column primary key are walked in key order, RECONCILE_CHUNK rows at a time, on
// both engines; the running sha256 and the row-by-row comparison see EVERY row and EVERY column — no sampling. The
// result is identical to hashing the whole table at once (CP4), but memory stays flat however large the table is.
const RECONCILE_CHUNK = 20000;
async function reconcile(src, pg, cat) {
  const tables = {}; let mismatched = 0; const all = crypto.createHash('sha256');
  for (const name of cat.order) {
    const t = cat.tables[name]; const cols = t.columns.map((c) => c.name); const sel = cols.map((c) => `"${c}"`).join(',');
    const ha = crypto.createHash('sha256'); const hb = crypto.createHash('sha256'); let firstDiff = null; let na = 0; let nb = 0;
    const feed = (a, b) => { const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i += 1) { const x = a[i] ? JSON.stringify(cols.map((c) => a[i][c])) : '<missing>'; const y = b[i] ? JSON.stringify(cols.map((c) => b[i][c])) : '<missing>';
        if (a[i]) { ha.update(x); na += 1; } if (b[i]) { hb.update(y); nb += 1; }
        if (x !== y && !firstDiff) { const col = a[i] && b[i] ? cols.find((c) => JSON.stringify(a[i][c]) !== JSON.stringify(b[i][c])) : null;
          firstDiff = { row: t.pk.map((k) => `${k}=${(a[i] || b[i])[k]}`).join(','), column: col, sqlite: col ? a[i][col] : x.slice(0, 80), postgresql: col ? b[i][col] : y.slice(0, 80) }; } } };
    if (t.pk.length === 1) {
      const k = t.pk[0]; let last = null; const qa = src.prepare(`SELECT ${cols.join(',')} FROM ${name} WHERE ? IS NULL OR ${k} > ? ORDER BY ${k} LIMIT ${RECONCILE_CHUNK}`);
      for (;;) {
        const a = qa.all(last, last);
        const b = (await pg.query({ text: last === null ? `SELECT ${sel} FROM ${name} ORDER BY "${k}" LIMIT ${RECONCILE_CHUNK}` : `SELECT ${sel} FROM ${name} WHERE "${k}" > $1 ORDER BY "${k}" LIMIT ${RECONCILE_CHUNK}`, values: last === null ? [] : [last], types: renderTypes })).rows;
        feed(a, b); if (a.length < RECONCILE_CHUNK && b.length < RECONCILE_CHUNK) break;
        const la = a.length ? a[a.length - 1][k] : null; const lb = b.length ? b[b.length - 1][k] : null;
        if (la === null || lb === null || JSON.stringify(la) !== JSON.stringify(lb)) { // the two sides drifted apart: already recorded as a difference; finish by count only
          na = src.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n; nb = Number((await pg.query(`SELECT COUNT(*) AS n FROM ${name}`)).rows[0].n); break; }
        last = la; }
    } else { const order = t.pk.length ? t.pk : cols;
      feed(src.prepare(`SELECT ${cols.join(',')} FROM ${name} ORDER BY ${order.join(',')}`).all(), (await pg.query({ text: `SELECT ${sel} FROM ${name} ORDER BY ${order.map((c) => `"${c}"`).join(',')}`, types: renderTypes })).rows); }
    const da = ha.digest('hex'); const db = hb.digest('hex'); const ok = na === nb && da === db && !firstDiff; if (!ok) mismatched += 1; all.update(`${name}:${db}`);
    tables[name] = { sqlite_rows: na, postgresql_rows: nb, difference: nb - na, sqlite_sha256: da, postgresql_sha256: db, content_match: ok, values: na * cols.length, ...(firstDiff ? { first_difference: firstDiff } : {}) };
  }
  return { ok: mismatched === 0, mismatched_tables: mismatched, tables, content_checksum: all.digest('hex') };
}
// The same portable SQL on both engines: history that must survive as history.
const INVARIANTS = {
  attendance_per_status: `SELECT attendance_status AS k, COUNT(*) AS n FROM timesheet_entries GROUP BY attendance_status ORDER BY 1`,
  duplicate_logical_attendance: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM timesheet_entries GROUP BY employee_id, work_date HAVING COUNT(*) > 1) d`,
  overtime_per_status: `SELECT overtime_status AS k, COUNT(*) AS n, COALESCE(SUM(overtime_minutes_approved),0) AS approved_minutes FROM timesheet_entries GROUP BY overtime_status ORDER BY 1`,
  corrections_per_status: `SELECT request_type AS t, status AS k, COUNT(*) AS n FROM attendance_corrections GROUP BY request_type, status ORDER BY 1, 2`,
  version_chains: `SELECT COUNT(DISTINCT timesheet_entry_id) AS entries, COUNT(*) AS versions, MAX(version_no) AS longest, SUM(CASE WHEN version_type = 'VOID' THEN 1 ELSE 0 END) AS void_versions FROM attendance_entry_versions`,
  approval_history: `SELECT action AS k, COUNT(*) AS n FROM attendance_correction_actions GROUP BY action ORDER BY 1`,
  audit_events: `SELECT event_type AS k, COUNT(*) AS n, MIN(id) AS first_id, MAX(id) AS last_id FROM attendance_events GROUP BY event_type ORDER BY 1`,
  audit_role_snapshots: `SELECT actor_role_snapshot AS k, COUNT(*) AS n FROM attendance_events WHERE actor_role_snapshot IS NOT NULL GROUP BY actor_role_snapshot ORDER BY 1`,
  exceptions: `SELECT exception_type AS t, status AS k, COUNT(*) AS n FROM attendance_exceptions GROUP BY exception_type, status ORDER BY 1, 2`,
  payroll_adjustment_queue: `SELECT impact_category AS t, queue_status AS k, COUNT(*) AS n, COALESCE(SUM(delta_work_minutes),0) AS dw, COALESCE(SUM(delta_overtime_minutes),0) AS dot FROM attendance_payroll_adjustments GROUP BY impact_category, queue_status ORDER BY 1, 2`,
  schedules_effective_dating: `SELECT COUNT(*) AS versions, COUNT(DISTINCT code) AS codes, SUM(CASE WHEN effective_to IS NULL THEN 1 ELSE 0 END) AS open_versions FROM work_schedules`,
  legal_entity_links: `SELECT legal_entity_id AS k, COUNT(*) AS n FROM timesheet_entries GROUP BY legal_entity_id ORDER BY 1`,
  payroll_runs: `SELECT run_type AS t, status AS k, COUNT(*) AS n FROM payroll_runs GROUP BY run_type, status ORDER BY 1, 2`,
  finalized_money: `SELECT COUNT(*) AS lines, COALESCE(SUM(l.gross_sen),0) AS gross_sen, COALESCE(SUM(l.net_sen),0) AS net_sen FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id WHERE r.status = 'FINALIZED'`,
  snapshots: `SELECT status AS k, COUNT(*) AS n FROM payroll_input_snapshots GROUP BY status ORDER BY 1`,
  payslips: `SELECT COUNT(*) AS n, COALESCE(SUM(net_sen),0) AS net_sen FROM payroll_payslips`,
  payments: `SELECT status AS k, COUNT(*) AS n, COALESCE(SUM(amount_sen),0) AS amount_sen FROM payroll_payment_items GROUP BY status ORDER BY 1`,
  rbac: `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM roles) AS roles, (SELECT COUNT(*) FROM permissions) AS permissions, (SELECT COUNT(*) FROM role_permissions) AS grants, (SELECT COUNT(*) FROM user_roles) AS user_roles, (SELECT COUNT(*) FROM user_legal_entity_scope) AS entity_scopes`,
};
async function invariants(src, pg) {
  const out = {}; let ok = true;
  for (const [k, sql] of Object.entries(INVARIANTS)) { const a = JSON.stringify(src.prepare(sql).all()); const b = JSON.stringify((await pg.query({ text: sql, types: renderTypes })).rows);
    out[k] = { match: a === b, sqlite: JSON.parse(a), ...(a === b ? {} : { postgresql: JSON.parse(b) }) }; if (a !== b) ok = false; }
  return { ok, checks: out };
}
async function destinationIntegrity(pg, cat) {
  const out = { orphans: 0, invalid_constraints: 0, disabled_triggers: 0, soft_orphans: 0 };
  for (const name of cat.order) for (const fk of cat.tables[name].fks) {
    const on = fk.cols.map((c, i) => `p."${fk.rcols[i]}" = c."${c}"`).join(' AND '); const nn = fk.cols.map((c) => `c."${c}" IS NOT NULL`).join(' AND ');
    out.orphans += (await pg.query(`SELECT COUNT(*)::int AS n FROM ${name} c WHERE ${nn} AND NOT EXISTS (SELECT 1 FROM ${fk.table} p WHERE ${on})`)).rows[0].n; }
  for (const [tbl, col, rt, rc] of SOFT_REFERENCES) out.soft_orphans += (await pg.query(`SELECT COUNT(*)::int AS n FROM ${tbl} c WHERE c.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${rt} p WHERE p.${rc} = c.${col})`)).rows[0].n;
  out.invalid_constraints = (await pg.query(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated`)).rows[0].n;
  out.disabled_triggers = (await pg.query(`SELECT COUNT(*)::int AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND g.tgenabled <> 'O'`)).rows[0].n;
  out.ok = !out.orphans && !out.soft_orphans && !out.invalid_constraints && !out.disabled_triggers;
  return out;
}

// ---- orchestration ------------------------------------------------------------
async function migrateFromSqlite({ source, connectionString, mode = 'migrate', log = console.log } = {}) {
  const url = connectionString || process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (schema-owner role of the FRESH destination database).');
  const sourceSha = sha256File(source);
  const report = { tool_version: TOOL_VERSION, mode, source: { file: path.basename(source), sha256_before: sourceSha }, started_at: new Date().toISOString() };
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250); sampler.unref(); const T = {}; let mark = Date.now();
  const lap = (k) => { T[k] = Date.now() - mark; mark = Date.now(); peak = Math.max(peak, process.memoryUsage().rss); };
  const src = openSource(source);
  const pg = new Client({ connectionString: url, application_name: 'kahe360-data-migration', options: '-c timezone=UTC' });
  await pg.connect();
  let inTx = false;
  try {
    const { assertSchemaCurrent } = require('./migrate');
    await assertSchemaCurrent({ query: (t, v) => pg.query(t, v) });
    const cat = await loadCatalogue(pg);
    report.destination = { database: (await pg.query('SELECT current_database() AS d, version() AS v')).rows[0] };
    report.migration_order = cat.order;
    log(`PREFLIGHT  ${path.basename(source)}  (${cat.order.length} tables)`);
    mark = Date.now(); report.preflight = preflight(src, cat); lap('preflight_ms');
    log(`  rows inspected ${report.preflight.stats.rows} · values ${report.preflight.stats.values_checked} · findings ${report.preflight.findings.length}`);
    if (!report.preflight.ok) {
      report.result = 'BLOCKED_BY_PREFLIGHT';
      for (const f of report.preflight.findings.slice(0, 20)) log(`  BLOCK [${f.check}] ${f.table}${f.row ? ` (${f.row})` : ''}${f.column ? ` .${f.column}` : ''}: ${f.reason}`);
      log('MIGRATION BLOCKED — the source was not modified and nothing was written to PostgreSQL. Fix the data AT THE SOURCE, through the application, then rerun.');
      return report;
    }
    if (mode === 'preflight') { report.result = 'PREFLIGHT_OK'; return report; }
    await assertFresh(pg, cat);
    await pg.query('BEGIN'); inTx = true;
    log('LOAD (single transaction, savepoint per table)');
    report.load = await load(src, pg, cat, log); lap('load_ms');
    log('RECONCILE');
    report.reconciliation = await reconcile(src, pg, cat); lap('reconcile_ms');
    report.invariants = await invariants(src, pg);
    report.integrity = await destinationIntegrity(pg, cat);
    const ok = report.reconciliation.ok && report.invariants.ok && report.integrity.ok;
    report.totals = { source_tables: cat.order.length, migrated_tables: Object.keys(report.load.perTable).length,
      source_rows: Object.values(report.reconciliation.tables).reduce((n, t) => n + t.sqlite_rows, 0), destination_rows: Object.values(report.reconciliation.tables).reduce((n, t) => n + t.postgresql_rows, 0),
      values_compared: Object.values(report.reconciliation.tables).reduce((n, t) => n + t.values, 0) };
    if (!ok) { await pg.query('ROLLBACK'); inTx = false; report.result = 'RECONCILIATION_FAILED_ROLLED_BACK'; log('RECONCILIATION FAILED — everything was rolled back; the destination is still fresh.'); return report; }
    if (mode === 'dry-run') { await pg.query('ROLLBACK'); inTx = false; report.result = 'DRY_RUN_OK_ROLLED_BACK'; log('DRY RUN OK — trial load reconciled and was rolled back; the destination is unchanged.'); return report; }
    await pg.query(`INSERT INTO data_migrations (source_kind, source_name, source_sha256, tool_version, tables_migrated, rows_migrated, content_checksum, report) VALUES ('sqlite', $1, $2, $3, $4, $5, $6, $7)`,
      [path.basename(source), sourceSha, TOOL_VERSION, report.totals.migrated_tables, report.totals.destination_rows, report.reconciliation.content_checksum,
        JSON.stringify({ totals: report.totals, sequences: report.load.sequences })]);
    await pg.query('COMMIT'); inTx = false;
    report.result = 'MIGRATED';
    log(`MIGRATED  ${report.totals.destination_rows} rows in ${report.totals.migrated_tables} tables · row-count difference 0 · content match on every table`);
    return report;
  } catch (err) {
    if (inTx) await pg.query('ROLLBACK').catch(() => {});
    report.result = 'FAILED_ROLLED_BACK'; report.error = { table: err.table || null, message: err.message };
    log(`MIGRATION FAILED and was rolled back completely: ${err.message}`);
    return report;
  } finally {
    src.close(); await pg.end();
    report.source.sha256_after = sha256File(source); report.source.untouched = report.source.sha256_after === sourceSha;
    clearInterval(sampler); report.performance = { ...T, peak_rss_mb: Math.round(peak / 1048576), reconcile_chunk_rows: RECONCILE_CHUNK };
    report.finished_at = new Date().toISOString();
  }
}

module.exports = { RECONCILE_CHUNK, PG_NATIVE_TABLES, PG_NATIVE_TABLES_CP2, migrateFromSqlite, preflight, reconcile, loadCatalogue, validDate, validTimestamp, SOFT_REFERENCES, INVARIANTS };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) { /* optional */ }
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const source = arg('--source');
  if (!source) { console.error('usage: migrate-from-sqlite.js --source <file.db> [--preflight | --dry-run] [--report out.json]'); process.exit(2); }
  const mode = process.argv.includes('--preflight') ? 'preflight' : process.argv.includes('--dry-run') ? 'dry-run' : 'migrate';
  migrateFromSqlite({ source, mode }).then((r) => {
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(r, null, 1));
    console.log(`RESULT: ${r.result} · source untouched: ${r.source.untouched}`);
    process.exit(['MIGRATED', 'DRY_RUN_OK_ROLLED_BACK', 'PREFLIGHT_OK'].includes(r.result) ? 0 : 1);
  }).catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
}
