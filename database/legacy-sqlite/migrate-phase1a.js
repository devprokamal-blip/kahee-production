// database/migrate-phase1a.js
// Phase 1A migration — Salary Components (B1).
//
// Two jobs, both idempotent and non-destructive:
//   1. Ensure the Domain 7 tables/indexes exist on a database created before
//      Phase 1A (initDb is itself idempotent, so it is simply re-run).
//   2. Backfill: every employee_payroll_assignments row that carries a
//      base_salary_sen but has no BASIC salary component gets one, with the
//      SAME effective window, so the component-based resolver returns the
//      same money the old single field did.
//
// BACKWARD COMPATIBILITY: employee_payroll_assignments.base_salary_sen is
// deliberately LEFT IN PLACE and left populated. Nothing reads it for payroll
// any more — lib/salaryStructure.js is the source of truth — but keeping it
// means this migration is reversible and any report still referencing it does
// not break. It should be retired in a later phase, after the engine ships.
//
// Usage: npm run migrate:phase1a

const { getDb, withTransaction, initDb } = require('./init-db');

function migrate() {
  const db = getDb();
  const log = [];
  try {
    // 1. Idempotently create Domain 7 tables + indexes on an older database.
    initDb(db);

    withTransaction(db, () => {
      // 2. Make sure a global BASIC component exists to attach the backfill to.
      let basic = db.prepare(
        "SELECT * FROM salary_components WHERE code = 'BASIC' AND legal_entity_id IS NULL AND effective_to IS NULL"
      ).get();

      if (!basic) {
        const info = db.prepare(`
          INSERT INTO salary_components
            (code, name, component_type, calculation_type, paid_by, is_taxable, is_bpjs_base,
             is_overtime_base, is_proratable, recurrence, calculation_order, legal_entity_id,
             effective_from, created_by)
          VALUES ('BASIC','Gaji Pokok','earning','fixed','employee',1,1,1,1,'recurring',10,NULL,'2026-01-01','migrate_phase1a')
        `).run();
        basic = db.prepare('SELECT * FROM salary_components WHERE id = ?').get(info.lastInsertRowid);
        log.push('  BASIC component created (none existed)');
      }

      // 3. Backfill each assignment that has money but no BASIC component
      //    covering the same window.
      const assignments = db.prepare(`
        SELECT * FROM employee_payroll_assignments
        WHERE base_salary_sen IS NOT NULL AND base_salary_sen > 0
        ORDER BY employee_id, effective_date
      `).all();

      const existsForWindow = db.prepare(`
        SELECT 1 FROM employee_salary_components
        WHERE employee_id = ? AND component_id = ? AND effective_from = ?
      `);
      const overlapsOpen = db.prepare(`
        SELECT 1 FROM employee_salary_components
        WHERE employee_id = ? AND component_id = ? AND effective_to IS NULL
      `);
      const insertAssignment = db.prepare(`
        INSERT INTO employee_salary_components
          (employee_id, component_id, amount_sen, effective_from, effective_to, note, created_by)
        VALUES (?, ?, ?, ?, ?, 'Backfill dari base_salary_sen (migrate-phase1a)', 'migrate_phase1a')
      `);

      let created = 0;
      let skipped = 0;
      for (const a of assignments) {
        if (existsForWindow.get(a.employee_id, basic.id, a.effective_date)) { skipped += 1; continue; }
        // An open source row would create a second open component row, which
        // the uq_emp_salary_component_open index forbids. Skip rather than
        // guess which one is authoritative.
        if (a.end_date === null && overlapsOpen.get(a.employee_id, basic.id)) { skipped += 1; continue; }
        insertAssignment.run(a.employee_id, basic.id, a.base_salary_sen, a.effective_date, a.end_date);
        created += 1;
      }
      log.push(`  base_salary_sen -> BASIC component: ${created} created, ${skipped} skipped (already present)`);
      log.push('  employee_payroll_assignments.base_salary_sen retained for backward compatibility');
    });

    console.log('Phase 1A migration complete.');
    console.log(log.join('\n'));
  } finally {
    db.close();
  }
}

if (require.main === module) migrate();
module.exports = { migrate };
