// database/migrate-phase1b.js
// Phase 1B / B2 migration — Work Calendar & Day Classification.
//
// Idempotent, transactional, non-destructive:
//   1. Creates Domain 8 tables/indexes on an older database (initDb is itself
//      idempotent, so it is simply re-run).
//   2. Adds the new columns to `holidays`, `timesheet_entries` and
//      `employee_payroll_assignments` if they are missing.
//   3. Seeds a DEFAULT global work calendar if none exists, so every employee
//      resolves to something rather than to AMBIGUOUS.
//   4. Backfills the day-type snapshot on EXISTING timesheet rows. Rows that
//      cannot be classified are left NULL on purpose — the Exception Engine
//      must see them, not a fabricated default.
//
// Usage: npm run migrate:phase1b

const { getDb, withTransaction, initDb } = require('./init-db');
const { classifyDay, toSnapshot, CLASSIFICATION_STATUS } = require('../lib/dayClassification');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, ddl, log) {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  log.push(`  ${table}.${column} added`);
}

function migrate() {
  const db = getDb();
  const log = [];
  try {
    initDb(db); // creates work_calendars + indexes on older databases

    withTransaction(db, () => {
      // --- 2. columns on pre-existing tables ---
      // NOTE: SQLite cannot add a CHECK constraint via ALTER TABLE, so these
      // backfilled columns are unconstrained on migrated databases. Fresh
      // databases get the CHECK from init-db.js. Application code validates
      // in both cases, and the value is only ever written server-side.
      addColumn(db, 'holidays', 'holiday_type', "holiday_type TEXT NOT NULL DEFAULT 'PUBLIC_HOLIDAY'", log);
      addColumn(db, 'holidays', 'work_calendar_id', 'work_calendar_id INTEGER', log);
      addColumn(db, 'holidays', 'observed_for', 'observed_for TEXT', log);
      addColumn(db, 'holidays', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1', log);

      addColumn(db, 'timesheet_entries', 'day_type', 'day_type TEXT', log);
      addColumn(db, 'timesheet_entries', 'day_type_source', 'day_type_source TEXT', log);
      addColumn(db, 'timesheet_entries', 'day_type_calendar_id', 'day_type_calendar_id INTEGER', log);
      addColumn(db, 'timesheet_entries', 'day_type_pattern_id', 'day_type_pattern_id INTEGER', log);
      addColumn(db, 'timesheet_entries', 'day_classified_at', 'day_classified_at TEXT', log);

      addColumn(db, 'employee_payroll_assignments', 'work_calendar_id', 'work_calendar_id INTEGER', log);

      // --- 3. default global calendar ---
      const existing = db.prepare(
        'SELECT id FROM work_calendars WHERE legal_entity_id IS NULL AND project_code IS NULL AND effective_to IS NULL'
      ).get();
      if (!existing) {
        db.prepare(`
          INSERT INTO work_calendars (code, name, legal_entity_id, project_code, effective_from, created_by)
          VALUES ('DEFAULT', 'Kalender Kerja Default', NULL, NULL, '2026-01-01', 'migrate_phase1b')
        `).run();
        log.push('  DEFAULT global work calendar created');
      }

      // --- 4. backfill classification snapshot on existing timesheet rows ---
      const rows = db.prepare('SELECT id, employee_id, work_date FROM timesheet_entries WHERE day_type IS NULL').all();
      const update = db.prepare(`
        UPDATE timesheet_entries
        SET day_type = ?, day_type_source = ?, day_type_calendar_id = ?, day_type_pattern_id = ?, day_classified_at = ?
        WHERE id = ?
      `);
      let classified = 0;
      let unresolved = 0;
      for (const r of rows) {
        const c = classifyDay(db, r.employee_id, r.work_date);
        if (c.status !== CLASSIFICATION_STATUS.OK) { unresolved += 1; continue; }
        const s = toSnapshot(c);
        update.run(s.day_type, s.day_type_source, s.day_type_calendar_id, s.day_type_pattern_id, s.day_classified_at, r.id);
        classified += 1;
      }
      log.push(`  timesheet day-type backfill: ${classified} classified, ${unresolved} left NULL for the Exception Engine`);
    });

    console.log('Phase 1B migration complete.');
    console.log(log.length ? log.join('\n') : '  (nothing to do — already migrated)');
  } finally {
    db.close();
  }
}

if (require.main === module) migrate();
module.exports = { migrate };
