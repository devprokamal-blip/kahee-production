// tools/parity/engines.js — DB-M1 CP3. Opens the two implementations side by side:
//   A3  = the preserved, UNMODIFIED A3 package (node:sqlite, synchronous libs)
//   PG  = this working tree (PostgreSQL, async libs)
// Scenario code is written once with `await`; awaiting a synchronous A3 value is a
// no-op, so the very same scenario drives both engines.
const path = require('path');
const A3_ROOT = process.env.KAHE_A3_ROOT;
if (!A3_ROOT) throw new Error('Set KAHE_A3_ROOT to the extracted KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3 package');

async function openEngines(label) {
  const { DatabaseSync } = require('node:sqlite');
  const lite = new DatabaseSync(':memory:');
  lite.exec('PRAGMA foreign_keys = ON;');
  require(path.join(A3_ROOT, 'database', 'init-db')).initDb(lite);
  const { createTestDatabase } = require('../../tests/helpers/pgTestDb');
  const t = await createTestDatabase(`parity_${label}`);
  const pgTypes = {};
  for (const r of await t.db.prepare(`SELECT table_name t, column_name c, data_type d FROM information_schema.columns WHERE table_schema='public'`).all()) {
    (pgTypes[r.t] = pgTypes[r.t] || {})[r.c] = r.d;
  }
  const info = (table) => lite.prepare(`PRAGMA table_info(${table})`).all();
  const ddl = (table) => lite.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table).sql;
  // first value allowed by a `col IN ('a','b')` CHECK, so auto-filled rows satisfy the schema on both engines
  const firstAllowed = (table, col) => { const m = ddl(table).match(new RegExp(`\\b${col}\\s+IN\\s*\\(\\s*'([^']+)'`)); return m ? m[1] : null; };
  const mk = (name, root, db) => ({
    name, db, lib: (m) => require(path.join(root, 'lib', m)),
    /** Insert a row, auto-filling NOT NULL columns the scenario does not care about. Identical values on both engines. */
    async insert(table, values) {
      const row = { ...values };
      for (const c of info(table)) {
        if (c.name in row || !c.notnull || c.dflt_value !== null || (c.pk && c.type === 'INTEGER')) continue;
        const pg = pgTypes[table][c.name];
        row[c.name] = firstAllowed(table, c.name) !== null ? firstAllowed(table, c.name) : c.type === 'INTEGER' ? 0 : pg === 'date' ? '2026-01-01' : pg === 'timestamp with time zone' ? '2026-01-01 00:00:00' : 'x';
      }
      const cols = Object.keys(row);
      return db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`).get(...cols.map((k) => row[k]));
    },
  });
  return { a3: mk('A3-SQLite', A3_ROOT, lite), pg: mk('DBM1-PostgreSQL', path.join(__dirname, '..', '..'), t.db),
    async close() { lite.close(); await t.drop(); } };
}
module.exports = { openEngines, A3_ROOT };
