// database/migrate-phase3b.js — Phase 3B additive migration. Idempotent.
// Adds client_billable_mode / billable_condition to the Phase 3A add-on table
// and backfills them from the existing boolean, so nothing changes meaning.
const { getDb, withTransaction, initDb } = require('./init-db');

function migrate() {
  const db = getDb();
  try {
    initDb(db);
    withTransaction(db, () => {
      const cols = db.prepare('PRAGMA table_info(worker_service_addons)').all().map((c) => c.name);
      if (!cols.includes('client_billable_mode')) {
        db.exec(`ALTER TABLE worker_service_addons ADD COLUMN client_billable_mode TEXT NOT NULL DEFAULT 'NO'`);
      }
      if (!cols.includes('billable_condition')) {
        db.exec('ALTER TABLE worker_service_addons ADD COLUMN billable_condition TEXT');
      }
      const n = db.prepare(`UPDATE worker_service_addons SET client_billable_mode = 'YES'
                            WHERE client_billable = 1 AND client_billable_mode = 'NO'`).run().changes;
      console.log(`Phase 3B migration complete. Backfilled ${n} row(s) to client_billable_mode = 'YES'.`);
    });
  } finally { db.close(); }
}
if (require.main === module) migrate();
module.exports = { migrate };
