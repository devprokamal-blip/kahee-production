// database/migrate-phase0b.js
// Phase 0B — N1 (exact time) migration.
//
// N2 needs no migration: busy_timeout and the bounded retry live in
// database/init-db.js and apply to every connection from the next start.
//
// Idempotent, transactional, non-destructive:
//   1. Adds work_minutes / overtime_minutes_requested / overtime_minutes_approved.
//   2. Converts every legacy REAL hour to integer minutes, half-up
//      (minutes = roundHalfUp(hours * 60)).
//   3. Leaves the REAL columns in place and REWRITES them from the minutes so
//      the pair can never disagree. Minutes are the source of truth; hours are
//      a display mirror. This is what avoids two competing sources of truth.
//
// Determinism: 0.1h -> 6 min, 0.25h -> 15, 0.5h -> 30, 1.25h -> 75,
// 7.25h -> 435. Every value the UI can produce (0.5 steps) and every legacy
// 0.1 step round-trips exactly.
//
// Usage: npm run migrate:phase0b

const { getDb, withTransaction, initDb } = require('./init-db');
const { hoursToMinutes, minutesToHours } = require('../lib/time');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrate() {
  const db = getDb();
  const log = [];
  try {
    initDb(db); // idempotent; creates the columns on a fresh schema

    withTransaction(db, () => {
      for (const [col, ddl] of [
        ['work_minutes', 'work_minutes INTEGER'],
        ['overtime_minutes_requested', 'overtime_minutes_requested INTEGER DEFAULT 0'],
        ['overtime_minutes_approved', 'overtime_minutes_approved INTEGER DEFAULT 0'],
      ]) {
        if (!columnExists(db, 'timesheet_entries', col)) {
          db.exec(`ALTER TABLE timesheet_entries ADD COLUMN ${ddl}`);
          log.push(`  timesheet_entries.${col} added`);
        }
      }

      // Convert only rows not yet converted, so re-running is a no-op.
      const rows = db.prepare(`
        SELECT id, work_hours, overtime_hours_requested, overtime_hours_approved,
               work_minutes, overtime_minutes_requested, overtime_minutes_approved
        FROM timesheet_entries
      `).all();

      const update = db.prepare(`
        UPDATE timesheet_entries
        SET work_minutes = ?, work_hours = ?,
            overtime_minutes_requested = ?, overtime_hours_requested = ?,
            overtime_minutes_approved = ?, overtime_hours_approved = ?
        WHERE id = ?
      `);

      let converted = 0;
      for (const r of rows) {
        const alreadyDone = r.work_minutes !== null
          && r.overtime_minutes_requested !== null
          && r.overtime_minutes_approved !== null
          && (r.work_hours === null || r.work_minutes === hoursToMinutes(r.work_hours));
        if (alreadyDone) continue;

        const wm = r.work_minutes !== null ? r.work_minutes : hoursToMinutes(r.work_hours);
        const om = r.overtime_minutes_requested ? r.overtime_minutes_requested : hoursToMinutes(r.overtime_hours_requested ?? 0) ?? 0;
        const oa = r.overtime_minutes_approved ? r.overtime_minutes_approved : hoursToMinutes(r.overtime_hours_approved ?? 0) ?? 0;

        update.run(
          wm, minutesToHours(wm),
          om, minutesToHours(om),
          oa, minutesToHours(oa),
          r.id
        );
        converted += 1;
      }
      log.push(`  hours -> integer minutes: ${converted} of ${rows.length} rows converted (half-up at the minute)`);
      log.push('  REAL hour columns retained, rewritten from minutes as a display mirror');
    });

    console.log('Phase 0B migration complete.');
    console.log(log.length ? log.join('\n') : '  (nothing to do — already migrated)');
  } finally {
    db.close();
  }
}

if (require.main === module) migrate();
module.exports = { migrate };
