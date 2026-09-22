(async () => {
// database/migrate-attendance-a1.js
// Attendance Hardening A1 — upgrade an existing database in place.
// Usage: npm run migrate:attendance-a1
//
// Idempotent, transactional, NON-destructive. Adds nothing a fresh initDb()
// would not add, drops nothing, renames nothing.
//   1. initDb() -> ensureAttendanceSchema(): new nullable columns,
//      attendance_events, frozen-attendance triggers, entity backfill.
//   2. Stable identity backfill for LEGACY rows, where the legacy display
//      label matches EXACTLY ONE user. Ambiguous or unknown labels stay NULL
//      rather than being guessed — a pending legacy overtime request without a
//      verified requester must be re-submitted before it can be decided.
// Checkpoint the WAL before copying the database (see PROJECT_CHECKPOINT.md).

const { getDb, initDb, withTransaction, DB_PATH } = require('./init-db');

async function uniqueUserIdByLabel(db, label) {
  if (!label) return null;
  const rows = await db.prepare('SELECT id FROM users WHERE display_name = ?').all(label);
  return rows.length === 1 ? rows[0].id : null;
}

async function migrate(db) {
  await initDb(db);
  const report = { recorded: 0, requested: 0, decided: 0, unresolved_pending: 0, no_entity: 0, invalid_date: 0 };
  await withTransaction(db, async () => {
    const rows = await db.prepare(`SELECT id, recorded_by, recorded_by_user_id, overtime_requested_by,
      overtime_requested_by_user_id, overtime_approved_by, overtime_decided_by_user_id, overtime_status
      FROM timesheet_entries`).all();
    const set = (col) => db.prepare(`UPDATE timesheet_entries SET ${col} = ? WHERE id = ? AND ${col} IS NULL`);
    const setRec = set('recorded_by_user_id');
    const setReq = set('overtime_requested_by_user_id');
    const setDec = set('overtime_decided_by_user_id');
    for (const r of rows) {
      if (r.recorded_by_user_id === null) {
        const id = await uniqueUserIdByLabel(db, r.recorded_by);
        if (id) { await setRec.run(id, r.id); report.recorded += 1; }
      }
      if (r.overtime_status !== 'none' && r.overtime_requested_by_user_id === null) {
        const id = await uniqueUserIdByLabel(db, r.overtime_requested_by);
        if (id) { await setReq.run(id, r.id); report.requested += 1; }
        else if (r.overtime_status === 'pending') report.unresolved_pending += 1;
      }
      if (['approved', 'rejected'].includes(r.overtime_status) && r.overtime_decided_by_user_id === null) {
        const id = await uniqueUserIdByLabel(db, r.overtime_approved_by);
        if (id) { await setDec.run(id, r.id); report.decided += 1; }
      }
    }
    report.no_entity = (await db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries WHERE legal_entity_id IS NULL').get()).n;
    // Pre-A1 the API accepted any work_date string. On PostgreSQL work_date is a
    // DATE column, so a malformed value cannot be stored at all and this count is
    // structurally 0. The scan itself is NOT dropped: it runs against the SQLite
    // SOURCE in the DB-M1 data-migration pre-flight, where malformed legacy dates
    // are REPORTED and block the migration — never silently normalised.
    report.invalid_date = 0;
  });
  return report;
}

if (require.main === module) {
  const db = getDb();
  try {
    const r = await migrate(db);
    console.log(`Attendance A1 migration complete on ${DB_PATH}`);
    console.log(`  recorder ids backfilled        : ${r.recorded}`);
    console.log(`  OT requester ids backfilled    : ${r.requested}`);
    console.log(`  OT decider ids backfilled      : ${r.decided}`);
    console.log(`  pending OT, requester unknown  : ${r.unresolved_pending} (must be re-submitted before a decision)`);
    console.log(`  rows with no entity on date    : ${r.no_entity} (visible only via audited entity override)`);
    console.log(`  rows with invalid work_date    : ${r.invalid_date} (pre-A1 data; left untouched for the correction phase)`);
  } finally { db.close(); }
}

module.exports = { migrate };

})().catch((err) => { console.error(err); process.exit(1); });
