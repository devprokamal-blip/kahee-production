// routes/payroll-config/salary-components.js — Domain 7: Salary Components
// Two related surfaces, one domain file (same modular pattern as every other
// payroll-config domain):
//   /components            — the master catalogue (what CAN be paid)
//   /employee-structure    — which components an employee HAS, and at what amount
//
// Versioning discipline matches the rest of the codebase: nothing is mutated
// in place. A change closes the current row (effective_to) and opens a new
// one, inside a transaction, with a config_audit_log entry.

const express = require('express');
const { getDb, withTransaction } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange, getConfigHistory } = require('../../lib/configAudit');
const {
  getStructureOn, getBasesOn, findOverlappingAssignment, resolveAmountSen,
} = require('../../lib/salaryStructure');

const router = express.Router();
const DOMAIN_MASTER = 'salary_component';
const DOMAIN_ASSIGNMENT = 'employee_salary_component';

const MASTER_FIELDS = [
  'code', 'name', 'component_type', 'calculation_type', 'paid_by',
  'is_taxable', 'tax_rule_ref', 'is_bpjs_base', 'is_overtime_base',
  'is_proratable', 'recurrence', 'legal_entity_id', 'calculation_order',
];

function toFlag(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return (v === 1 || v === '1' || v === true || v === 'true') ? 1 : 0;
}

// ============================================================
// MASTER CATALOGUE
// ============================================================

router.get('/components', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { include_superseded } = req.query;
    const sql = include_superseded === 'true'
      ? 'SELECT * FROM salary_components ORDER BY calculation_order ASC, code ASC, effective_from DESC'
      : "SELECT * FROM salary_components WHERE effective_to IS NULL ORDER BY calculation_order ASC, code ASC";
    res.json(await db.prepare(sql).all());
  } finally { db.close(); }
});

/** Every version of one component code — the version-history surface. */
router.get('/components/versions/:code', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare(
      'SELECT * FROM salary_components WHERE code = ? ORDER BY effective_from DESC'
    ).all(req.params.code));
  } finally { db.close(); }
});

/** Audit trail across every version row of one component code. */
router.get('/components/audit/:code', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const ids = (await db.prepare('SELECT id FROM salary_components WHERE code = ?').all(req.params.code)).map((r) => r.id);
    if (!ids.length) return res.json([]);
    const placeholders = ids.map(() => '?').join(',');
    res.json(await db.prepare(`
      SELECT * FROM config_audit_log
      WHERE domain = '${DOMAIN_MASTER}' AND record_id IN (${placeholders})
      ORDER BY changed_at DESC
    `).all(...ids.map(String)));
  } finally { db.close(); }
});

router.post('/components', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.code || !b.name || !b.component_type || !b.calculation_type || !b.effective_from) {
      return res.status(400).json({
        error: 'VALIDATION',
        message: 'code, name, component_type, calculation_type, effective_from wajib diisi.',
      });
    }

    const params = {
      code: String(b.code).trim().toUpperCase(),
      name: b.name,
      component_type: b.component_type,
      calculation_type: b.calculation_type,
      paid_by: b.paid_by || 'employee',
      is_taxable: toFlag(b.is_taxable, 1),
      tax_rule_ref: b.tax_rule_ref || null,
      is_bpjs_base: toFlag(b.is_bpjs_base, 0),
      is_overtime_base: toFlag(b.is_overtime_base, 0),
      is_proratable: toFlag(b.is_proratable, 1),
      recurrence: b.recurrence || 'recurring',
      legal_entity_id: b.legal_entity_id || null,
      calculation_order: b.calculation_order !== undefined ? Number(b.calculation_order) : 100,
      effective_from: b.effective_from,
      created_by: req.userContext.displayName,
    };

    const newId = await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO salary_components (${MASTER_FIELDS.join(', ')}, effective_from, created_by)
        VALUES (${MASTER_FIELDS.map((f) => `@${f}`).join(', ')}, @effective_from, @created_by) RETURNING id
      `).run(params);
      await logConfigChange(db, {
        domain: DOMAIN_MASTER, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName, newValue: params,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId });
  } finally { db.close(); }
});

/**
 * Revise a component: closes the current version and opens a new one.
 * Never an in-place UPDATE — a payroll already calculated under the old
 * definition must keep resolving the old definition.
 */
router.post('/components/:id/revise', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const current = await db.prepare('SELECT * FROM salary_components WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
    if (current.effective_to !== null) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Versi ini sudah ditutup. Revisi versi yang masih aktif.' });
    }
    const b = req.body;
    if (!b.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'effective_from wajib diisi.' });
    }
    if (b.effective_from <= current.effective_from) {
      return res.status(400).json({
        error: 'VALIDATION',
        message: 'effective_from versi baru harus setelah versi saat ini (' + current.effective_from + ').',
      });
    }

    const merged = {};
    for (const f of MASTER_FIELDS) merged[f] = (b[f] !== undefined && b[f] !== '') ? b[f] : current[f];
    merged.code = current.code;                       // code identifies the component; never revised
    merged.is_taxable = toFlag(b.is_taxable, current.is_taxable);
    merged.is_bpjs_base = toFlag(b.is_bpjs_base, current.is_bpjs_base);
    merged.is_overtime_base = toFlag(b.is_overtime_base, current.is_overtime_base);
    merged.is_proratable = toFlag(b.is_proratable, current.is_proratable);
    merged.calculation_order = Number(merged.calculation_order);
    merged.effective_from = b.effective_from;
    merged.created_by = req.userContext.displayName;

    const newId = await withTransaction(db, async () => {
      await db.prepare(`UPDATE salary_components SET effective_to = kahe_date_add(?::date, -1), status = 'superseded' WHERE id = ?`)
        .run(b.effective_from, current.id);
      const info = await db.prepare(`
        INSERT INTO salary_components (${MASTER_FIELDS.join(', ')}, effective_from, created_by)
        VALUES (${MASTER_FIELDS.map((f) => `@${f}`).join(', ')}, @effective_from, @created_by) RETURNING id
      `).run(merged);
      await logConfigChange(db, {
        domain: DOMAIN_MASTER, recordId: info.lastInsertRowid, action: 'update',
        changedBy: req.userContext.displayName, oldValue: current, newValue: merged,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId });
  } finally { db.close(); }
});

// ============================================================
// EMPLOYEE SALARY STRUCTURE
// ============================================================

/** Resolved structure + derived bases for one employee on a date. */
router.get('/employee-structure/:employeeId', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    res.json(await getBasesOn(db, req.params.employeeId, date));
  } finally { db.close(); }
});

/** Full history (every version row) for one employee. */
router.get('/employee-structure/:employeeId/history', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare(`
      SELECT esc.*, sc.code, sc.name, sc.component_type, sc.paid_by
      FROM employee_salary_components esc
      JOIN salary_components sc ON sc.id = esc.component_id
      WHERE esc.employee_id = ?
      ORDER BY esc.effective_from DESC, sc.calculation_order ASC
    `).all(req.params.employeeId));
  } finally { db.close(); }
});

/** Everyone who currently has at least one component (list view). */
router.get('/employee-structure', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const employees = await db.prepare(`
      SELECT DISTINCT esc.employee_id, e.full_name, e.worker_type
      FROM employee_salary_components esc
      JOIN employees e ON e.id = esc.employee_id
      WHERE esc.effective_from <= ? AND (esc.effective_to IS NULL OR esc.effective_to >= ?)
      ORDER BY e.full_name ASC
    `).all(date, date);

    res.json(await Promise.all(employees.map(async (emp) => {
      const bases = await getBasesOn(db, emp.employee_id, date);
      return {
        employee_id: emp.employee_id,
        full_name: emp.full_name,
        worker_type: emp.worker_type,
        component_count: bases.components.length,
        gross_earnings_sen: bases.grossEarningsSen,
        taxable_base_sen: bases.taxableBaseSen,
        bpjs_base_sen: bases.bpjsBaseSen,
        overtime_base_sen: bases.overtimeBaseSen,
      };
    })));
  } finally { db.close(); }
});

/** Assign a component to an employee. Rejects overlapping effective periods. */
router.post('/employee-structure', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.employee_id || !b.component_id || !b.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'employee_id, component_id, effective_from wajib diisi.' });
    }
    const amountSen = resolveAmountSen(b);
    if (amountSen === null || !Number.isFinite(amountSen)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'amount (rupiah) atau amount_sen wajib diisi.' });
    }
    if (!await db.prepare('SELECT id FROM employees WHERE id = ?').get(b.employee_id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Karyawan tidak ditemukan.' });
    }
    if (!await db.prepare('SELECT id FROM salary_components WHERE id = ?').get(b.component_id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Komponen tidak ditemukan.' });
    }

    // Range overlap is not expressible as a SQLite constraint, so it is
    // checked here; the partial unique index still guards duplicate OPEN rows.
    const clash = await findOverlappingAssignment(db, b.employee_id, b.component_id, b.effective_from, b.effective_to || null);
    if (clash) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Periode bertumpang tindih dengan assignment yang sudah ada (${clash.effective_from} s/d ${clash.effective_to || 'sekarang'}). Gunakan "Ubah Nilai" untuk perubahan di tengah periode.`,
      });
    }

    const newId = await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO employee_salary_components (employee_id, component_id, amount_sen, effective_from, effective_to, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).run(b.employee_id, b.component_id, amountSen, b.effective_from, b.effective_to || null, b.note || null, req.userContext.displayName);
      await logConfigChange(db, {
        domain: DOMAIN_ASSIGNMENT, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName,
        newValue: { ...b, amount_sen: amountSen },
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId, amount_sen: amountSen });
  } finally { db.close(); }
});

/**
 * Mid-period amount change: closes the open row the day before the new
 * effective date and opens a new one. Historical payroll is untouched.
 */
router.post('/employee-structure/:id/change-amount', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const current = await db.prepare('SELECT * FROM employee_salary_components WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
    if (current.effective_to !== null) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Baris ini sudah ditutup. Ubah baris yang masih aktif.' });
    }
    const b = req.body;
    if (!b.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'effective_from wajib diisi.' });
    }
    if (b.effective_from <= current.effective_from) {
      return res.status(400).json({
        error: 'VALIDATION',
        message: 'Tanggal berlaku perubahan harus setelah ' + current.effective_from + '.',
      });
    }
    const amountSen = resolveAmountSen(b);
    if (amountSen === null || !Number.isFinite(amountSen)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'amount (rupiah) atau amount_sen wajib diisi.' });
    }

    const newId = await withTransaction(db, async () => {
      await db.prepare(`UPDATE employee_salary_components SET effective_to = kahe_date_add(?::date, -1) WHERE id = ?`)
        .run(b.effective_from, current.id);
      const info = await db.prepare(`
        INSERT INTO employee_salary_components (employee_id, component_id, amount_sen, effective_from, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id
      `).run(current.employee_id, current.component_id, amountSen, b.effective_from, b.note || null, req.userContext.displayName);
      await logConfigChange(db, {
        domain: DOMAIN_ASSIGNMENT, recordId: info.lastInsertRowid, action: 'update',
        changedBy: req.userContext.displayName, oldValue: current,
        newValue: { ...current, amount_sen: amountSen, effective_from: b.effective_from, id: info.lastInsertRowid },
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId, amount_sen: amountSen });
  } finally { db.close(); }
});

/** End an assignment (e.g. an allowance the employee stops receiving). */
router.post('/employee-structure/:id/end', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const current = await db.prepare('SELECT * FROM employee_salary_components WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
    const { effective_to } = req.body;
    if (!effective_to) return res.status(400).json({ error: 'VALIDATION', message: 'effective_to wajib diisi.' });
    if (effective_to < current.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'effective_to tidak boleh sebelum effective_from.' });
    }

    await withTransaction(db, async () => {
      await db.prepare('UPDATE employee_salary_components SET effective_to = ? WHERE id = ?').run(effective_to, current.id);
      await logConfigChange(db, {
        domain: DOMAIN_ASSIGNMENT, recordId: current.id, action: 'update',
        changedBy: req.userContext.displayName, oldValue: current,
        newValue: { ...current, effective_to },
      });
    });
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get('/employee-structure/audit/:assignmentId', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await getConfigHistory(db, DOMAIN_ASSIGNMENT, req.params.assignmentId));
  } finally { db.close(); }
});

module.exports = router;
