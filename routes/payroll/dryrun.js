// routes/payroll/dryrun.js — Phase 2C: dry-run calculation.
//
// SCOPE LOCK: nothing is persisted. No payroll record, no payslip, no
// approval, no payment. The calculator reads a FROZEN snapshot payload and
// returns a result; this route is the only place a db handle and the
// calculator meet, and even here the calculator is handed a plain object.
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const calculator = require('../../lib/payrollCalculator');

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

/** Dry-run one employee's snapshot. Read-only. */
router.get('/snapshots/:id/dry-run', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'snapshot', req.params.id);
    const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(req.params.id);
    if (!snap) return res.status(404).json({ error: 'NOT_FOUND' });

    const payload = JSON.parse(snap.resolved_payload);
    const result = calculator.calculate(payload);

    res.json({
      snapshot_id: snap.id,
      employee_id: snap.employee_id,
      payroll_period_id: snap.payroll_period_id,
      snapshot_status: snap.status,
      snapshot_hash: snap.payload_hash,
      persisted: false,           // Phase 2C never writes a payroll record
      result,
      trace_text: req.query.trace === 'text' ? calculator.formatTrace(result) : undefined,
    });
  } finally { db.close(); }
});

/** Dry-run a whole period, in bounded chunks. Read-only, aggregates only. */
router.get('/periods/:periodId/dry-run', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Number(req.query.offset) || 0;
    await guard(db, req, 'payroll_period', req.params.periodId);
    const snaps = await db.prepare(`
      SELECT s.id, s.employee_id, e.full_name, s.resolved_payload
      FROM payroll_input_snapshots s JOIN employees e ON e.id = s.employee_id
      WHERE s.payroll_period_id = ?
      ORDER BY s.employee_id ASC LIMIT ? OFFSET ?
    `).all(req.params.periodId, limit, offset);

    const summary = { count: 0, ok: 0, blocked: 0, gross_sen: 0, net_sen: 0, employer_cost_sen: 0 };
    const rows = snaps.map((s) => {
      const result = calculator.calculate(JSON.parse(s.resolved_payload));
      summary.count += 1;
      if (result.status === calculator.CALC_STATUS.OK) {
        summary.ok += 1;
        summary.gross_sen += result.totals.gross_sen;
        summary.net_sen += result.totals.net_sen;
        summary.employer_cost_sen += result.totals.employer_cost_sen;
      } else summary.blocked += 1;
      return {
        snapshot_id: s.id, employee_id: s.employee_id, full_name: s.full_name,
        status: result.status,
        gross_sen: result.totals ? result.totals.gross_sen : null,
        net_sen: result.totals ? result.totals.net_sen : null,
        errors: result.errors,
      };
    });

    res.json({ persisted: false, offset, limit, summary, rows });
  } finally { db.close(); }
});

module.exports = router;
