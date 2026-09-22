(async () => {
// database/migrate-attendance-a2.js
// Attendance A2 — upgrade an existing database in place.
// Usage: npm run migrate:attendance-a2
//
// Idempotent, transactional, NON-destructive.
//   1. initDb() -> ensureAttendanceScheduleSchema(): the A2 tables, the new
//      nullable timesheet columns, and the schedule-immutability triggers.
//   2. A report only. NOTHING is auto-created: no schedule, no pattern, no
//      assignment is invented for existing employees, because guessing a
//      workforce's real shifts is exactly the hardcoding A2 exists to remove.
//      Until an employee has an A2 assignment, attendance keeps using the
//      legacy path (payroll work_patterns weekly rest day) — see
//      docs/ATTENDANCE_ARCHITECTURE.md.
// Optional: `--seed-examples <LEGAL_ENTITY_ID>` creates EXAMPLE schedules
// (OFFICE / SITE-DAY / SITE-NIGHT) as a starting point for configuration.
// They are fixtures, not defaults, and no employee is assigned to them.

const { getDb, initDb, withTransaction, DB_PATH } = require('./init-db');
const bt = require('../lib/businessTime');

const EXAMPLE_SCHEDULES = [
  { code: 'OFFICE', name: 'Office 08:00-17:00', type: 'OFFICE', in: '08:00', out: '17:00', minutes: 480, cross: 0,
    breaks: [{ name: 'Istirahat Siang', start: '12:00', end: '13:00', minutes: 60, paid: 0 }] },
  { code: 'SITE-DAY', name: 'Site Day 07:00-16:00', type: 'SITE', in: '07:00', out: '16:00', minutes: 480, cross: 0,
    breaks: [{ name: 'Istirahat Siang', start: '12:00', end: '13:00', minutes: 60, paid: 0 }] },
  { code: 'SITE-NIGHT', name: 'Site Night 20:00-05:00', type: 'SITE', in: '20:00', out: '05:00', minutes: 480, cross: 1,
    breaks: [{ name: 'Istirahat Malam', start: '00:00', end: '01:00', minutes: 60, paid: 0 }] },
];

async function migrate(db, { seedExamplesFor = null, effectiveFrom = null } = {}) {
  await initDb(db);
  const report = { entries: 0, without_schedule: 0, employees_with_assignment: 0, schedules: 0, patterns: 0, examples_created: 0 };
  await withTransaction(db, async () => {
    report.entries = (await db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries').get()).n;
    report.without_schedule = (await db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries WHERE work_schedule_id IS NULL').get()).n;
    report.employees_with_assignment = (await db.prepare('SELECT COUNT(DISTINCT employee_id) AS n FROM attendance_schedule_assignments').get()).n;
    report.schedules = (await db.prepare('SELECT COUNT(*) AS n FROM work_schedules').get()).n;
    report.patterns = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_work_patterns').get()).n;

    if (seedExamplesFor) {
      const from = effectiveFrom || bt.businessToday();
      const insS = db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,schedule_type,clock_in,clock_out,
        standard_work_minutes,cross_midnight,overtime_eligibility_rule,effective_from,created_by,note)
        VALUES (?,?,?,?,?,?,?,?,'AFTER_SHIFT_END',?, 'migrate_attendance_a2', 'Contoh konfigurasi — ubah sesuai kebutuhan') RETURNING id`);
      const insB = db.prepare(`INSERT INTO work_schedule_breaks (work_schedule_id,name,start_time,end_time,duration_minutes,is_paid,sequence)
        VALUES (?,?,?,?,?,?,?)`);
      for (const e of EXAMPLE_SCHEDULES) {
        const exists = await db.prepare('SELECT id FROM work_schedules WHERE code = ? AND legal_entity_id = ?').get(e.code, seedExamplesFor);
        if (exists) continue;
        const id = Number((await insS.run(e.code, e.name, seedExamplesFor, e.type, e.in, e.out, e.minutes, e.cross, from)).lastInsertRowid);
        for (const [i, b] of e.breaks.entries()) await insB.run(id, b.name, b.start, b.end, b.minutes, b.paid, i + 1);
        report.examples_created += 1;
      }
    }
  });
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--seed-examples');
  const entity = idx >= 0 ? args[idx + 1] : null;
  const db = getDb();
  try {
    const r = await migrate(db, { seedExamplesFor: entity });
    console.log(`Attendance A2 migration complete on ${DB_PATH}`);
    console.log(`  business timezone              : ${bt.BUSINESS_TIMEZONE} (today = ${bt.businessToday()})`);
    console.log(`  attendance rows                : ${r.entries} (${r.without_schedule} without a resolved schedule — legacy path)`);
    console.log(`  employees with A2 assignment   : ${r.employees_with_assignment}`);
    console.log(`  schedules / patterns defined   : ${r.schedules} / ${r.patterns}`);
    if (entity) console.log(`  example schedules created      : ${r.examples_created} for ${entity} (fixtures, nobody assigned)`);
    else console.log('  no schedule was invented for existing employees — configure them in Jadwal & Pola Kerja.');
  } finally { db.close(); }
}

module.exports = { migrate, EXAMPLE_SCHEDULES };

})().catch((err) => { console.error(err); process.exit(1); });
