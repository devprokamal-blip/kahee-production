// tests/helpers/pgIntrospect.js — DB-M1. PostgreSQL catalog equivalents of the
// SQLite introspection the suites used (sqlite_master / PRAGMA table_info).
// Each returns the same SHAPE the SQLite query returned, so the assertions that
// consume them are unchanged.
const tableNames = async (db) => (await db.prepare(
  "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1").all());
const indexNames = async (db, like = '%') => (await db.prepare(
  "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE ? ORDER BY 1").all(like));
const indexDefs = async (db) => (await db.prepare(
  "SELECT indexname AS name, tablename AS tbl_name, indexdef AS sql FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1").all());
const triggerNames = async (db) => (await db.prepare(
  "SELECT t.tgname AS name, c.relname AS tbl_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND t.tgname NOT LIKE '%no_truncate' ORDER BY 1").all());
// Storage-class vocabulary of the original assertions ("money is INTEGER, not REAL"):
// bigint/integer -> INTEGER, float/numeric -> REAL, text -> TEXT. DATE and TIMESTAMPTZ
// keep their own names — they are NOT reported as TEXT. `pg_type` is the raw type.
const STORAGE_CLASS = { bigint: 'INTEGER', integer: 'INTEGER', smallint: 'INTEGER', 'double precision': 'REAL', real: 'REAL',
  numeric: 'REAL', text: 'TEXT', date: 'DATE', 'timestamp with time zone': 'TIMESTAMPTZ' };
/** PRAGMA table_info shape: { cid, name, type, notnull, dflt_value, pk } (+ pg_type). */
const tableInfo = async (db, table) => (await db.prepare(`
  SELECT c.ordinal_position - 1 AS cid, c.column_name AS name, c.data_type AS type,
         CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull, c.column_default AS dflt_value,
         COALESCE((SELECT k.ordinal_position FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
           WHERE tc.table_schema = 'public' AND tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
             AND k.column_name = c.column_name), 0) AS pk
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = ? ORDER BY c.ordinal_position`).all(table))
  .map((c) => ({ ...c, pg_type: c.type, type: STORAGE_CLASS[c.type] || c.type.toUpperCase() }));
/** Successor of `SELECT sql FROM sqlite_master WHERE name = <table>`: a CREATE TABLE-like text built from the catalog (columns + constraint definitions). */
const tableSql = async (db, table) => {
  const cols = (await tableInfo(db, table)).map((c) => `  ${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}`);
  const cons = (await db.prepare(`SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ? ORDER BY con.conname`).all(table)).map((r) => `  ${r.def}`);
  return { sql: `CREATE TABLE ${table} (\n${[...cols, ...cons].join(',\n')}\n)` };
};
module.exports = { tableSql, tableNames, indexNames, indexDefs, triggerNames, tableInfo };
