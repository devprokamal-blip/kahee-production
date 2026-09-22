(async () => {
// database/migrate-attendance-a3.js
// Attendance A3 — upgrade an existing database in place.
// Usage: npm run migrate:attendance-a3
//
// Idempotent, transactional, NON-destructive:
//   1. initDb() -> ensureAttendanceCorrectionSchema(): correction policies,
//      correction/void requests, approval history, the append-only version
//      chain, exceptions, the payroll-adjustment queue, the widened audit
//      columns, and the append-only triggers.
//   2. Back-fills NOTHING by default. No correction window is invented, and no
//      historical attendance row is rewritten — existing rows simply have no
//      version chain until their first correction, at which point v1 is
//      materialised from the record as it stands.
// Optional: `--seed-policy <LEGAL_ENTITY_ID> [window_days]` creates ONE example
// correction policy so the workflow is usable on a fresh install. It is a
// starting point for configuration, not a default baked into business logic.

const { getDb, initDb, withTransaction, DB_PATH } = require('./init-db');
const bt = require('../lib/businessTime');

async function migrate(db, { seedPolicyFor = null, windowDays = 3, effectiveFrom = null } = {}) {
  await initDb(db);
  const report = { entries: 0, without_version: 0, corrections: 0, exceptions: 0, policies: 0, policy_created: 0 };
  await withTransaction(db, async () => {
    report.entries = (await db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries').get()).n;
    report.without_version = (await db.prepare(`SELECT COUNT(*) AS n FROM timesheet_entries t
      WHERE NOT EXISTS (SELECT 1 FROM attendance_entry_versions v WHERE v.timesheet_entry_id = t.id)`).get()).n;
    report.corrections = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_corrections').get()).n;
    report.exceptions = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_exceptions').get()).n;
    report.policies = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_correction_policies').get()).n;

    if (seedPolicyFor) {
      const open = await db.prepare(`SELECT id FROM attendance_correction_policies
        WHERE legal_entity_id = ? AND effective_to IS NULL`).get(seedPolicyFor);
      if (!open) {
        await db.prepare(`INSERT INTO attendance_correction_policies
          (code,name,legal_entity_id,correction_window,window_unit,allow_late_correction,late_requires_approval,
           evidence_requirement,post_finalized_evidence_required,effective_from,created_by,note)
          VALUES (?,?,?,?, 'DAYS',1,1,'OPTIONAL',1,?, 'migrate_attendance_a3',
                  'Contoh kebijakan — sesuaikan jendela koreksi dan kewajiban bukti')`).run(
          `CORR-${seedPolicyFor}`, `Kebijakan koreksi ${seedPolicyFor}`, seedPolicyFor, Number(windowDays),
          effectiveFrom || bt.businessToday());
        report.policy_created = 1;
      }
    }
  });
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--seed-policy');
  const entity = i >= 0 ? args[i + 1] : null;
  const win = i >= 0 && args[i + 2] ? Number(args[i + 2]) : 3;
  const db = getDb();
  try {
    const r = await migrate(db, { seedPolicyFor: entity, windowDays: win });
    console.log(`Attendance A3 migration complete on ${DB_PATH}`);
    console.log(`  business timezone        : ${bt.BUSINESS_TIMEZONE} (today = ${bt.businessToday()})`);
    console.log(`  attendance rows          : ${r.entries} (${r.without_version} without a version chain yet)`);
    console.log(`  corrections / exceptions : ${r.corrections} / ${r.exceptions}`);
    console.log(`  correction policies      : ${r.policies}${r.policy_created ? ` (+1 example for ${entity}, window ${win} days)` : ''}`);
    if (!entity) console.log('  no correction window was invented — configure one in Koreksi & Audit Absensi.');
  } finally { db.close(); }
}

module.exports = { migrate };

})().catch((err) => { console.error(err); process.exit(1); });
