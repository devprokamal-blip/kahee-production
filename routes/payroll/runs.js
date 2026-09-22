// routes/payroll/runs.js — Phase 2E: payroll run lifecycle.
//
// SCOPE: state machine, persisted results, approval, finalization.
// NOT payment, bank export or payslip delivery.
//
// PERMISSIONS (segregation of duties):
//   create / calculate run  -> payroll_run:CREATE
//   validate                -> payroll_run:EDIT
//   approve / finalize      -> payroll_run:APPROVE  AND  not the preparer,
//                              unless the actor holds payroll_sod_override.
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const runLib = require('../../lib/payrollRun');
const runCalc = require('../../lib/runCalculator');
const validationRunner = require('../../lib/validationRunner');
const validation = require('../../lib/payrollValidation');

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

/** Map a TransitionError onto the right HTTP status. */
function sendTransitionError(res, err) {
  if (!(err instanceof runLib.TransitionError)) throw err;
  const status = {
    [runLib.TRANSITION_ERROR.NOT_AUTHORIZED]: 403,
    [runLib.TRANSITION_ERROR.SOD_VIOLATION]: 403,
    [runLib.TRANSITION_ERROR.INVALID_TRANSITION]: 400,
    [runLib.TRANSITION_ERROR.ALREADY_FINALIZED]: 409,
    [runLib.TRANSITION_ERROR.BLOCKING_EXCEPTIONS]: 409,
    [runLib.TRANSITION_ERROR.UNACKNOWLEDGED_WARNINGS]: 409,
    [runLib.TRANSITION_ERROR.SNAPSHOTS_NOT_READY]: 409,
    [runLib.TRANSITION_ERROR.NO_LINES]: 409,
    [runLib.TRANSITION_ERROR.ENTITY_MISMATCH]: 409,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

async function loadRun(db, id) {
  return await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
}

router.get('/runs', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { period_id, status } = req.query;
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'payroll_run', route: req.originalUrl });
    let sql = `SELECT * FROM payroll_runs WHERE ${sc.sql}`;
    const params = [...sc.params];
    if (period_id) { sql += ' AND payroll_period_id = ?'; params.push(period_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY payroll_period_id DESC, run_number DESC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

router.get('/runs/:id', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    run.totals = await runCalc.getRunTotals(db, run.id);
    run.allowed_transitions = runLib.ALLOWED_TRANSITIONS[run.status] || [];
    run.gate = await validation.getBlockingSummary(db, run.payroll_period_id);
    res.json(run);
  } finally { db.close(); }
});

router.get('/runs/:id/history', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    res.json(await runLib.getHistory(db, Number(req.params.id)));
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

router.get('/runs/:id/lines', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const rows = await db.prepare(`
      SELECT l.id, l.employee_id, e.full_name, l.calc_status, l.gross_sen, l.net_sen,
             l.bpjs_employee_sen, l.bpjs_employer_sen, l.tax_sen, l.overtime_sen,
             l.ter_category, l.payroll_rule_set_id, l.jkk_rate_version_id,
             l.result_hash, l.snapshot_hash, l.calculated_at
      FROM payroll_run_lines l JOIN employees e ON e.id = l.employee_id
      WHERE l.payroll_run_id = ? ORDER BY e.full_name ASC LIMIT ? OFFSET ?
    `).all(req.params.id, Math.min(Number(req.query.limit) || 200, 2000), Number(req.query.offset) || 0);
    res.json(rows);
  } finally { db.close(); }
});

/** Component breakdown for one line — the future payslip source. */
router.get('/lines/:id/components', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run_line', req.params.id);
    res.json(await db.prepare(
      'SELECT * FROM payroll_run_line_components WHERE payroll_run_line_id = ? ORDER BY sequence ASC'
    ).all(req.params.id));
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

router.post('/periods/:periodId/runs', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    const run = await withRetry(async () => await withTransaction(db, async () =>
      await runLib.createRun(db, Number(req.params.periodId), req.userContext)), { label: 'create run' });
    res.status(201).json(run);
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/** DRAFT -> SNAPSHOT_READY */
router.post('/runs/:id/snapshot-ready', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    const counts = await withRetry(async () => await withTransaction(db, async () =>
      await runLib.markSnapshotReady(db, run, req.userContext, req.body.note)), { label: 'snapshot ready' });
    res.json({ ok: true, status: runLib.STATUS.SNAPSHOT_READY, ...counts });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/**
 * SNAPSHOT_READY -> CALCULATED (or CALCULATED -> CALCULATED to recalculate).
 * Records the preparer, which is what the SoD check later compares against.
 */
router.post('/runs/:id/calculate', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    if (run.status !== runLib.STATUS.SNAPSHOT_READY && run.status !== runLib.STATUS.CALCULATED
        && run.status !== runLib.STATUS.VALIDATED) {
      return sendTransitionError(res, new runLib.TransitionError(
        runLib.TRANSITION_ERROR.INVALID_TRANSITION,
        `Tidak bisa menghitung dari status ${run.status}.`, { from: run.status }));
    }
    if (run.status === runLib.STATUS.FINALIZED) {
      return sendTransitionError(res, new runLib.TransitionError(
        runLib.TRANSITION_ERROR.ALREADY_FINALIZED, 'Run sudah FINALIZED.'));
    }

    const summary = await runCalc.calculateRun(db, run, { chunkSize: Number(req.body.chunk_size) || undefined });

    await withRetry(async () => await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_runs SET status='CALCULATED', prepared_by=?, prepared_at=kahe_now(), engine_version=? WHERE id=?`)
        .run(req.userContext.displayName, req.body.engine_version || 'payroll-calc-2c.1', run.id);
      await runLib.recordEvent(db, run.id, run.status, runLib.STATUS.CALCULATED, req.userContext.displayName,
        req.body.note || 'Perhitungan dijalankan.', summary);
    }), { label: 'mark calculated' });

    res.status(201).json({ ok: true, status: runLib.STATUS.CALCULATED, ...summary, totals: await runCalc.getRunTotals(db, run.id) });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/** CALCULATED -> VALIDATED */
router.post('/runs/:id/validate', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!runLib.canTransition(run.status, runLib.STATUS.VALIDATED)) {
      return sendTransitionError(res, new runLib.TransitionError(
        runLib.TRANSITION_ERROR.INVALID_TRANSITION,
        `Transisi ${run.status} -> VALIDATED tidak diizinkan.`,
        { from: run.status, allowed: runLib.ALLOWED_TRANSITIONS[run.status] || [] }));
    }
    const summary = await validationRunner.validatePeriod(db, run.payroll_period_id, {
      chunkSize: Number(req.body.chunk_size) || undefined,
    });
    await withRetry(async () => await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_runs SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`)
        .run(req.userContext.displayName, run.id);
      await runLib.recordEvent(db, run.id, run.status, runLib.STATUS.VALIDATED, req.userContext.displayName,
        req.body.note || 'Validasi dijalankan.', summary);
    }), { label: 'mark validated' });
    res.json({ ok: true, status: runLib.STATUS.VALIDATED, ...summary });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/** VALIDATED -> APPROVED. Idempotent. SoD enforced. */
router.post('/runs/:id/approve', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await runLib.approve(db, run, req.userContext, req.body.note)), { label: 'approve run' });
    res.json({ ok: true, idempotent: out.idempotent, status: runLib.STATUS.APPROVED, run: out.run });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/** APPROVED -> VALIDATED (audited un-approve). */
router.post('/runs/:id/unapprove', requirePermission('payroll_run', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    await withRetry(async () => await withTransaction(db, async () =>
      await runLib.unapprove(db, run, req.userContext, req.body.note)), { label: 'unapprove run' });
    res.json({ ok: true, status: runLib.STATUS.VALIDATED });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

/** APPROVED -> FINALIZED. Terminal; duplicate finalization is rejected. */
router.post('/runs/:id/finalize', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.id);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await runLib.finalize(db, run, req.userContext, req.body.note)), { label: 'finalize run' });
    res.json({ ok: true, status: runLib.STATUS.FINALIZED, ...out });
  } catch (err) { return sendTransitionError(res, err); } finally { db.close(); }
});

module.exports = router;
