// database/migrate-phase2a.js
// Phase 2A migration — Payroll Groups & Periods.
//
// Idempotent, transactional, non-destructive:
//   1. Creates the Domain 9 tables/indexes on an older database.
//   2. Adds employee_payroll_assignments.payroll_group_id if missing.
//   3. Seeds one default monthly group per legal entity that has none, so
//      existing assignments resolve to a regime instead of MISSING_PAYROLL_GROUP.
//   4. Links assignments with no group to their entity's default group.
//   5. Materialises the current year's periods for each default group.
//
// Nothing is deleted and no existing group/period is modified: a second run
// finds everything present and does nothing.
//
// Usage: npm run migrate:phase2a

const { getDb, withTransaction, initDb } = require('./init-db');
const pp = require('../lib/payrollPeriod');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrate(year = new Date().getUTCFullYear()) {
  const db = getDb();
  const log = [];
  try {
    initDb(db); // idempotent: creates payroll_groups / payroll_periods / indexes

    withTransaction(db, () => {
      if (!columnExists(db, 'employee_payroll_assignments', 'payroll_group_id')) {
        db.exec('ALTER TABLE employee_payroll_assignments ADD COLUMN payroll_group_id INTEGER');
        log.push('  employee_payroll_assignments.payroll_group_id added');
      }

      const entities = db.prepare(`SELECT * FROM legal_entities WHERE status = 'active'`).all();
      let groupsCreated = 0;
      let periodsCreated = 0;
      let assignmentsLinked = 0;

      const insertPeriod = db.prepare(`
        INSERT INTO payroll_periods
          (payroll_group_id, period_year, period_sequence, period_month,
           period_start, period_end, attendance_cutoff, overtime_cutoff,
           adjustment_cutoff, payment_date, status, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'migrate_phase2a'
        WHERE NOT EXISTS (
          SELECT 1 FROM payroll_periods WHERE payroll_group_id = ? AND period_year = ? AND period_sequence = ?
        )
      `);

      for (const entity of entities) {
        let group = db.prepare(
          `SELECT * FROM payroll_groups WHERE legal_entity_id = ? AND effective_to IS NULL ORDER BY id ASC LIMIT 1`
        ).get(entity.id);

        if (!group) {
          const code = `${entity.id}-MONTHLY`.toUpperCase();
          db.prepare(`
            INSERT INTO payroll_groups
              (code, name, legal_entity_id, project_code, frequency, periods_per_year,
               attendance_cutoff_offset_days, overtime_cutoff_offset_days,
               adjustment_cutoff_offset_days, payment_offset_days, effective_from, created_by)
            VALUES (?, ?, ?, NULL, 'monthly', 12, 0, 0, 2, 5, ?, 'migrate_phase2a')
          `).run(code, `${entity.name} Bulanan`, entity.id, entity.effective_date || '2026-01-01');
          group = db.prepare('SELECT * FROM payroll_groups WHERE code = ?').get(code);
          groupsCreated += 1;
        }

        for (let month = 1; month <= 12; month += 1) {
          const w = pp.monthlyWindow(year, month);
          const d = pp.deriveDates(group, w.periodStart, w.periodEnd);
          const before = db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE payroll_group_id = ?').get(group.id).n;
          insertPeriod.run(
            group.id, year, month, month,
            d.period_start, d.period_end, d.attendance_cutoff, d.overtime_cutoff,
            d.adjustment_cutoff, d.payment_date,
            group.id, year, month
          );
          const after = db.prepare('SELECT COUNT(*) AS n FROM payroll_periods WHERE payroll_group_id = ?').get(group.id).n;
          if (after > before) periodsCreated += 1;
        }

        const linked = db.prepare(
          `UPDATE employee_payroll_assignments SET payroll_group_id = ?
           WHERE payroll_group_id IS NULL AND legal_entity_id = ?`
        ).run(group.id, entity.id);
        assignmentsLinked += linked.changes || 0;
      }

      log.push(`  payroll groups created: ${groupsCreated} (one per legal entity without one)`);
      log.push(`  payroll periods created for ${year}: ${periodsCreated}`);
      log.push(`  assignments linked to a group: ${assignmentsLinked}`);
    });

    console.log('Phase 2A migration complete.');
    console.log(log.length ? log.join('\n') : '  (nothing to do — already migrated)');
  } finally {
    db.close();
  }
}

if (require.main === module) migrate(Number(process.argv[2]) || undefined);
module.exports = { migrate };

// Phase 2D addendum: payment detail columns on employees. Added here (rather
// than a separate migration file) because it is a single additive column set
// with no data transformation. Idempotent.
function addBankColumns() {
  const db = getDb();
  try {
    const cols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
    withTransaction(db, () => {
      for (const [name, ddl] of [
        ['bank_name', 'bank_name TEXT'],
        ['bank_account_no', 'bank_account_no TEXT'],
        ['bank_account_name', 'bank_account_name TEXT'],
      ]) {
        if (!cols.includes(name)) db.exec(`ALTER TABLE employees ADD COLUMN ${ddl}`);
      }
    });
    console.log('Phase 2D: employees payment columns ensured.');
  } finally { db.close(); }
}
module.exports.addBankColumns = addBankColumns;
