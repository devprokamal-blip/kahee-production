// routes/payroll/adjustments.js — Phase 2G: adjustments, retro & reversal.
//
// SCOPE: corrections to FINALIZED payroll. No payment, no bank file.
//
// PERMISSIONS (segregation of duties, mirroring the run-level control):
//   create / void adjustment  -> payroll_run:CREATE / EDIT
//   approve adjustment        -> payroll_run:APPROVE, and not the creator
//   apply to a correction run -> payroll_run:CREATE
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const adj = require('../../lib/payrollAdjustment');
const runLib = require('../../lib/payrollRun');

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

function sendAdjError(res, err) {
  if (!(err instanceof adj.AdjustmentError)) throw err;
  const status = {
    [adj.ERROR.SOURCE_NOT_FINALIZED]: 409,
    [adj.ERROR.SOURCE_LINE_NOT_FOUND]: 404,
    [adj.ERROR.DUPLICATE_REFERENCE]: 409,
    [adj.ERROR.ALREADY_APPLIED]: 409,
    [adj.ERROR.NOTHING_TO_APPLY]: 409,
    [adj.ERROR.INVALID_STATE]: 400,
    [adj.ERROR.ENTITY_MISMATCH]: 403,
    [adj.ERROR.NOT_AUTHORIZED]: 403,
    [adj.ERROR.VALIDATION]: 400,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

router.post('/adjustments', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const row = await withRetry(async () => await withTransaction(db, async () =>
      await adj.createAdjustment(db, req.body, req.userContext)), { label: 'create adjustment' });
    res.status(201).json(row);
  } catch (err) { return sendAdjError(res, err); } finally { db.close(); }
});

router.get('/adjustments', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { source_run_id, employee_id, status, period_id } = req.query;
    const sc = await scope.scopeClause(db, req.userContext, 'a.legal_entity_id',
      { resourceType: 'adjustment', route: req.originalUrl });
    let sql = `SELECT a.*, e.full_name FROM payroll_adjustments a JOIN employees e ON e.id = a.employee_id WHERE ${sc.sql}`;
    const params = [...sc.params];
    if (source_run_id) { sql += ' AND a.source_run_id = ?'; params.push(source_run_id); }
    if (period_id) { sql += ' AND a.source_period_id = ?'; params.push(period_id); }
    if (employee_id) { sql += ' AND a.employee_id = ?'; params.push(employee_id); }
    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    sql += ' ORDER BY a.id DESC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

router.post('/adjustments/:id/approve', requirePermission('payroll_run', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'adjustment', req.params.id);
    const row = await withRetry(async () => await withTransaction(db, async () =>
      await adj.approveAdjustment(db, Number(req.params.id), req.userContext, req.body.note)),
    { label: 'approve adjustment' });
    res.json(row);
  } catch (err) { return sendAdjError(res, err); } finally { db.close(); }
});

router.post('/adjustments/:id/void', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'adjustment', req.params.id);
    const row = await withRetry(async () => await withTransaction(db, async () =>
      await adj.voidAdjustment(db, Number(req.params.id), req.userContext, req.body.reason)),
    { label: 'void adjustment' });
    res.json(row);
  } catch (err) { return sendAdjError(res, err); } finally { db.close(); }
});

/** Create a CORRECTION or REVERSAL run against a FINALIZED run. */
router.post('/runs/:runId/correction-run', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const source = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(req.params.runId);
    if (!source) return res.status(404).json({ error: 'NOT_FOUND' });
    const runType = (req.body.run_type || 'CORRECTION').toUpperCase();
    if (!['CORRECTION', 'REVERSAL'].includes(runType)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'run_type harus CORRECTION atau REVERSAL.' });
    }
    const run = await withRetry(async () => await withTransaction(db, async () =>
      await runLib.createRun(db, source.payroll_period_id, req.userContext,
        { runType, correctsRunId: source.id })), { label: 'create correction run' });
    res.status(201).json(run);
  } catch (err) {
    if (err instanceof runLib.TransitionError) {
      return res.status(err.code === runLib.TRANSITION_ERROR.ENTITY_MISMATCH ? 403 : 400)
        .json({ error: err.code, message: err.message, detail: err.detail });
    }
    return sendAdjError(res, err);
  } finally { db.close(); }
});

/** Materialise the correction run's delta lines. */
router.post('/runs/:runId/apply-adjustments', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });

    const summary = await withRetry(async () => await withTransaction(db, async () => {
      const out = await adj.applyToRun(db, run, req.userContext);
      await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now() WHERE id=?`)
        .run(req.userContext.displayName, run.id);
      await runLib.recordEvent(db, run.id, run.status, 'CALCULATED', req.userContext.displayName,
        req.body.note || `Penyesuaian diterapkan (${run.run_type}).`, out);
      return out;
    }), { label: 'apply adjustments' });

    res.status(201).json({ ok: true, status: 'CALCULATED', ...summary });
  } catch (err) { return sendAdjError(res, err); } finally { db.close(); }
});

/** Reconciliation: original + every finalized correction = what is owed. */
router.get('/periods/:periodId/reconciliation', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    const result = await adj.reconcilePeriod(db, Number(req.params.periodId));
    if (req.query.employee_id) {
      result.employee = await adj.reconcileEmployee(db, Number(req.params.periodId), req.query.employee_id);
    }
    res.json(result);
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

module.exports = router;
