// database/migrate-phase0.js
// Phase 0 migration for databases created BEFORE the B3/B5/B6 remediation.
//
// A fresh database gets the new shape directly from init-db.js. This script
// exists for an already-running instance (e.g. the one on the Windows laptop)
// so it is upgraded in place WITHOUT losing data.
//
// Safe to run repeatedly: every step checks whether it has already been
// applied. Runs inside a single transaction — if any step fails, the database
// is left exactly as it was.
//
// Usage:  npm run migrate:phase0
//   or:   node database/migrate-phase0.js

const { getDb, withTransaction } = require('./init-db');
const { rupiahToSen, rateToBp } = require('../lib/money');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function tableExists(db, table) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

/** Add `newCol` (integer) alongside `oldCol` (real) and convert every value. */
function migrateColumn(db, table, oldCol, newCol, convert, log) {
  if (!tableExists(db, table)) return;
  if (!columnExists(db, table, oldCol)) return;       // already migrated away
  if (columnExists(db, table, newCol)) return;        // already added

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${newCol} INTEGER`);
  const rows = db.prepare(`SELECT rowid AS _rid, ${oldCol} AS v FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET ${newCol} = ? WHERE rowid = ?`);
  let converted = 0;
  for (const row of rows) {
    if (row.v === null || row.v === undefined) continue;
    update.run(convert(row.v), row._rid);
    converted += 1;
  }
  // The old REAL column is deliberately LEFT IN PLACE. SQLite's DROP COLUMN is
  // recent and refuses on indexed/constrained columns; keeping it costs a few
  // bytes and preserves a rollback path. Application code reads only *_sen/*_bp.
  log.push(`  ${table}.${oldCol} -> ${newCol} (${converted} rows converted, old column retained)`);
}

function migrate() {
  const db = getDb();
  const log = [];
  try {
    withTransaction(db, () => {
      // ---- B3: money -> integer sen, rates -> integer basis points ----
      migrateColumn(db, 'employees', 'daily_rate', 'daily_rate_sen', rupiahToSen, log);
      migrateColumn(db, 'employee_payroll_assignments', 'base_salary', 'base_salary_sen', rupiahToSen, log);
      migrateColumn(db, 'jkk_risk_classes', 'rate', 'rate_bp', rateToBp, log);

      for (const [oldCol, newCol] of [
        ['bpjs_kesehatan_rate_employee', 'bpjs_kesehatan_rate_employee_bp'],
        ['bpjs_kesehatan_rate_company', 'bpjs_kesehatan_rate_company_bp'],
        ['jht_rate_employee', 'jht_rate_employee_bp'],
        ['jht_rate_company', 'jht_rate_company_bp'],
        ['jp_rate_employee', 'jp_rate_employee_bp'],
        ['jp_rate_company', 'jp_rate_company_bp'],
        ['jkm_rate', 'jkm_rate_bp'],
      ]) migrateColumn(db, 'payroll_rule_sets', oldCol, newCol, rateToBp, log);

      for (const [oldCol, newCol] of [
        ['bpjs_kesehatan_salary_cap', 'bpjs_kesehatan_salary_cap_sen'],
        ['jp_salary_cap', 'jp_salary_cap_sen'],
      ]) migrateColumn(db, 'payroll_rule_sets', oldCol, newCol, rupiahToSen, log);

      migrateColumn(db, 'ptkp_ter_rates', 'income_min', 'income_min_sen', rupiahToSen, log);
      migrateColumn(db, 'ptkp_ter_rates', 'income_max', 'income_max_sen', rupiahToSen, log);
      migrateColumn(db, 'ptkp_ter_rates', 'rate', 'rate_bp', rateToBp, log);
      migrateColumn(db, 'overtime_multiplier_rules', 'multiplier', 'multiplier_bp', rateToBp, log);

      // ---- B6: termination date ----
      if (tableExists(db, 'employees') && !columnExists(db, 'employees', 'termination_date')) {
        db.exec('ALTER TABLE employees ADD COLUMN termination_date TEXT');
        log.push('  employees.termination_date added (NULL = still employed)');
      }

      // ---- B5: invariants enforced by the database ----
      // Pre-existing violations would make index creation fail, which rolls the
      // whole migration back — that is intended. A duplicate must be resolved
      // by a human, not silently deleted by a migration script.
      const indexes = [
        ['uq_payroll_assignment_open_per_employee',
         'CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_assignment_open_per_employee ON employee_payroll_assignments(employee_id) WHERE end_date IS NULL'],
        ['uq_payroll_rule_set_single_active',
         "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_rule_set_single_active ON payroll_rule_sets(status) WHERE status = 'active'"],
        ['uq_jkk_open_per_risk_class',
         'CREATE UNIQUE INDEX IF NOT EXISTS uq_jkk_open_per_risk_class ON jkk_risk_classes(risk_class) WHERE end_date IS NULL'],
        ['uq_holiday_national_per_date',
         "CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_national_per_date ON holidays(date) WHERE scope = 'national'"],
      ];
      for (const [name, sql] of indexes) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`).get(name);
        if (exists) continue;
        try {
          db.exec(sql);
          log.push(`  index ${name} created`);
        } catch (err) {
          throw new Error(
            `Cannot create ${name}: existing data violates this invariant (${err.message}). ` +
            'Resolve the duplicate rows manually, then re-run the migration. ' +
            'Nothing has been changed — the migration rolled back.'
          );
        }
      }
    });

    console.log('Phase 0 migration complete.');
    console.log(log.length ? log.join('\n') : '  (nothing to do — already migrated)');
  } finally {
    db.close();
  }
}

if (require.main === module) migrate();
module.exports = { migrate };
