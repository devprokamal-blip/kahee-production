// routes/payroll-config/employee-assignments.js — Domain 6: Employee Payroll Assignment
// Links an employee (from HRD & Kontrak) to a legal entity, work pattern,
// and PTKP status. History is kept: a new effective_date row supersedes
// the old one rather than overwriting it.
const express = require('express');
const { getDb, withTransaction } = require('../../database/init-db');
const { rupiahToSen } = require('../../lib/money');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'employee_payroll_assignment';

// TER category derivation — pure function of marital_status + dependents_count,
// per PMK 168/2023 (see routes/payroll-config/rule-sets.js for the bracket table).
function terCategory(maritalStatus, dependents) {
  if (maritalStatus === 'K' && dependents >= 3) return 'C';
  if (maritalStatus === 'TK' && dependents >= 2) return 'B';
  if (maritalStatus === 'K' && dependents >= 1) return 'B';
  return 'A'; // TK/0, TK/1, K/0
}

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const rows = await db.prepare(`
      SELECT a.*, e.full_name, e.worker_type
      FROM employee_payroll_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.end_date IS NULL
      ORDER BY e.full_name ASC
    `).all();
    rows.forEach((r) => { r.ter_category = terCategory(r.marital_status, r.dependents_count); });
    res.json(rows);
  } finally { db.close(); }
});

router.get('/:employeeId', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare(`SELECT * FROM employee_payroll_assignments WHERE employee_id = ? AND end_date IS NULL`).get(req.params.employeeId);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    row.ter_category = terCategory(row.marital_status, row.dependents_count);
    res.json(row);
  } finally { db.close(); }
});

// Upsert-by-supersession: closes the current assignment (if any) and
// inserts a new one, so payroll runs for past periods still see the
// assignment that was active THEN.
router.post('/', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.employee_id || !b.legal_entity_id || !b.work_pattern_id || !b.marital_status || !b.effective_date) {
      return res.status(400).json({ error: 'VALIDATION', message: 'employee_id, legal_entity_id, work_pattern_id, marital_status, effective_date wajib diisi.' });
    }
    const employee = await db.prepare('SELECT id FROM employees WHERE id = ?').get(b.employee_id);
    if (!employee) return res.status(404).json({ error: 'NOT_FOUND', message: 'Karyawan tidak ditemukan.' });

    // B4: closing the previous assignment and opening the new one is one
    // logical change. B5's partial unique index makes two open assignments
    // impossible; without the transaction a crash between the statements
    // could leave the employee with NO open assignment instead.
    const newId = await withTransaction(db, async () => {
      const current = await db.prepare(`SELECT * FROM employee_payroll_assignments WHERE employee_id = ? AND end_date IS NULL`).get(b.employee_id);
      if (current) {
        await db.prepare(`UPDATE employee_payroll_assignments SET end_date = kahe_date_add(?::date, -1) WHERE id = ?`).run(b.effective_date, current.id);
      }

      const info = await db.prepare(`
        INSERT INTO employee_payroll_assignments (
          employee_id, legal_entity_id, work_pattern_id, marital_status, dependents_count,
          npwp, base_salary_sen, effective_date, created_by
        ) VALUES (@employee_id, @legal_entity_id, @work_pattern_id, @marital_status, @dependents_count,
          @npwp, @base_salary_sen, @effective_date, @created_by) RETURNING id
      `).run({
        employee_id: b.employee_id, legal_entity_id: b.legal_entity_id, work_pattern_id: b.work_pattern_id,
        marital_status: b.marital_status, dependents_count: b.dependents_count || 0,
        npwp: b.npwp || null,
        // B3: accept rupiah from the client, persist integer sen.
        base_salary_sen: rupiahToSen(b.base_salary ?? b.base_salary_sen),
        effective_date: b.effective_date, created_by: req.userContext.displayName,
      });

      await logConfigChange(db, {
        domain: DOMAIN, recordId: info.lastInsertRowid, action: 'create', changedBy: req.userContext.displayName,
        oldValue: current || null, newValue: b,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId, ter_category: terCategory(b.marital_status, b.dependents_count || 0) });
  } finally { db.close(); }
});

module.exports = router;
