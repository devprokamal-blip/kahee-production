// routes/payroll/snapshots.js — Phase 2B: as-of resolution & input snapshots.
//
// SCOPE LOCK: exposes RESOLVED INPUTS. No calculation, no money computed.
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const resolver = require('../../lib/asOfResolver');
const writer = require('../../lib/snapshotWriter');

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

/** Dry-run resolution: see exactly which versions apply, without writing. */
router.get('/resolve/:employeeId/period/:periodId', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    const result = await resolver.resolve(db, req.params.employeeId, Number(req.params.periodId), req.query.as_of || null);
    const payload = resolver.buildPayload(result);
    res.json({
      status: result.status,
      errors: result.errors,
      as_of_date: result.asOfDate,
      payload_hash: resolver.hashPayload(payload),
      payload,
    });
  } finally { db.close(); }
});

router.get('/periods/:periodId/snapshots', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    const rows = await db.prepare(`
      SELECT s.id, s.employee_id, e.full_name, s.legal_entity_id, s.payroll_group_id,
             s.as_of_date, s.payable_days, s.period_days, s.work_minutes_total,
             s.overtime_minutes_approved, s.attendance_row_count, s.ter_category,
             s.payroll_rule_set_id, s.jkk_rate_version_id,
             s.payload_hash, s.resolution_status, s.resolution_errors,
             s.status, s.resolved_at, s.frozen_at
      FROM payroll_input_snapshots s
      JOIN employees e ON e.id = s.employee_id
      WHERE s.payroll_period_id = ?
      ORDER BY e.full_name ASC
    `).all(req.params.periodId);
    res.json(rows);
  } finally { db.close(); }
});

router.get('/snapshots/:id', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'snapshot', req.params.id);
    const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(req.params.id);
    if (!snap) return res.status(404).json({ error: 'NOT_FOUND' });
    snap.resolved_payload = JSON.parse(snap.resolved_payload);
    if (snap.resolution_errors) snap.resolution_errors = JSON.parse(snap.resolution_errors);
    res.json(snap);
  } finally { db.close(); }
});

/** Immutability proof: compare a stored snapshot against live config. Read-only. */
router.get('/snapshots/:id/drift', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'snapshot', req.params.id);
    const result = await writer.detectDrift(db, Number(req.params.id));
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(result);
  } finally { db.close(); }
});

/**
 * Generate snapshots for a period, in bounded chunks. Idempotent: employees
 * that already have a snapshot are skipped, so a retried or resumed request
 * is safe.
 */
router.post('/periods/:periodId/snapshots', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.periodId);
    if (!period) return res.status(404).json({ error: 'NOT_FOUND', message: 'Payroll period tidak ditemukan.' });
    if (period.status === 'DRAFT') {
      return res.status(409).json({ error: 'PERIOD_NOT_OPEN', message: 'Buka periode (OPEN) sebelum mengambil snapshot.' });
    }
    const summary = await writer.snapshotPeriod(db, Number(req.params.periodId), {
      chunkSize: Number(req.body.chunk_size) || writer.DEFAULT_CHUNK_SIZE,
      asOfDate: req.body.as_of || null,
      resolvedBy: req.userContext.displayName,
    });
    res.status(201).json(summary);
  } finally { db.close(); }
});

/** Freeze: after this the inputs are immutable. Requires APPROVE. */
router.post('/periods/:periodId/snapshots/freeze', requirePermission('payroll_run', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await writer.freezePeriod(db, Number(req.params.periodId), req.userContext.displayName));
  } finally { db.close(); }
});

module.exports = router;
