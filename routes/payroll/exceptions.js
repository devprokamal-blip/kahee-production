// routes/payroll/exceptions.js — Phase 2D: validation & exception management.
//
// SCOPE LOCK: persists EXCEPTIONS only. No payroll result, payslip, approval
// or payment. Nothing here auto-fixes payroll data.
//
// PERMISSIONS (segregation of duties):
//   run validation      -> payroll_run:CREATE
//   acknowledge WARNING -> payroll_run:EDIT
//   resolve BLOCKING    -> payroll_run:APPROVE   (deliberately higher)
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const validation = require('../../lib/payrollValidation');
const runner = require('../../lib/validationRunner');

const router = express.Router();

/**
 * Phase 2I: cross-entity reads are refused with 404, never 403 — a 403 would
 * confirm the record exists in another entity, which is the basis of id
 * enumeration. The attempt is audited either way.
 */
async function guard(db, req, resourceType, resourceId) {
  return await scope.assertResourceAccess(db, req.userContext, resourceType, resourceId, req.originalUrl);
}
function sendScopeError(res, err) {
  if (!(err instanceof scope.EntityAccessError)) return false;
  res.status(404).json({ error: 'NOT_FOUND', message: err.message });
  return true;
}

router.post('/periods/:periodId/validate', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.periodId);
    if (!period) return res.status(404).json({ error: 'NOT_FOUND' });
    const summary = await runner.validatePeriod(db, Number(req.params.periodId), {
      chunkSize: Number(req.body.chunk_size) || runner.DEFAULT_CHUNK_SIZE,
    });
    res.status(201).json({ persisted: 'exceptions_only', ...summary });
  } finally { db.close(); }
});

router.get('/periods/:periodId/exceptions', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { severity, status, employee_id } = req.query;
    const sc = await scope.scopeClause(db, req.userContext, 'x.legal_entity_id',
      { resourceType: 'exception', route: req.originalUrl });
    let sql = `SELECT x.*, e.full_name FROM payroll_exceptions x
               JOIN employees e ON e.id = x.employee_id
               WHERE x.payroll_period_id = ? AND ${sc.sql}`;
    const params = [req.params.periodId, ...sc.params];
    if (severity) { sql += ' AND x.severity = ?'; params.push(severity); }
    if (status) { sql += ' AND x.resolution_status = ?'; params.push(status); }
    if (employee_id) { sql += ' AND x.employee_id = ?'; params.push(employee_id); }
    sql += " ORDER BY CASE x.severity WHEN 'BLOCKING' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, x.exception_code, e.full_name";
    const rows = (await db.prepare(sql).all(...params)).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    res.json(rows);
  } finally { db.close(); }
});

/** The gate the future approval/finalisation state machine must consult. */
router.get('/periods/:periodId/gate', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    res.json(await validation.getBlockingSummary(db, Number(req.params.periodId)));
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

/** Acknowledge a WARNING. Blocking exceptions cannot be acknowledged away. */
router.post('/exceptions/:id/acknowledge', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'exception', req.params.id);
    const ex = await db.prepare('SELECT * FROM payroll_exceptions WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'NOT_FOUND' });
    if (ex.severity === validation.SEVERITY.BLOCKING) {
      return res.status(400).json({
        error: 'INVALID_ACTION',
        message: 'Exception BLOCKING tidak bisa sekadar di-acknowledge; gunakan resolve (butuh izin APPROVE).',
      });
    }
    if (!req.body.note) return res.status(400).json({ error: 'VALIDATION', message: 'note wajib diisi.' });

    await withRetry(async () => await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_exceptions
        SET resolution_status='ACKNOWLEDGED', resolved_by=?, resolved_at=kahe_now(), resolution_note=?
        WHERE id = ?`).run(req.userContext.displayName, req.body.note, ex.id);
    }), { label: 'acknowledge exception' });
    res.json({ ok: true, resolution_status: 'ACKNOWLEDGED' });
  } finally { db.close(); }
});

/** Resolve an exception. BLOCKING requires APPROVE — enforced here. */
router.post('/exceptions/:id/resolve', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'exception', req.params.id);
    const ex = await db.prepare('SELECT * FROM payroll_exceptions WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!req.body.note) return res.status(400).json({ error: 'VALIDATION', message: 'note wajib diisi.' });

    if (ex.blocking === 1 && !(req.userContext.permissions.payroll_run || []).includes('APPROVE')) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Menyelesaikan exception BLOCKING memerlukan izin payroll_run:APPROVE.',
      });
    }

    await withRetry(async () => await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_exceptions
        SET resolution_status='RESOLVED', resolved_by=?, resolved_at=kahe_now(), resolution_note=?
        WHERE id = ?`).run(req.userContext.displayName, req.body.note, ex.id);
    }), { label: 'resolve exception' });
    res.json({ ok: true, resolution_status: 'RESOLVED' });
  } finally { db.close(); }
});

module.exports = router;
