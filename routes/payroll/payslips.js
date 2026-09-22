// routes/payroll/payslips.js — Phase 2F: payslip generation and access.
//
// SCOPE: rendering FINALIZED payroll only. No payment, no bank export, no
// delivery. Generation is idempotent and the stored document is immutable.
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const payslip = require('../../lib/payslip');

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

function sendPayslipError(res, err) {
  if (!(err instanceof payslip.PayslipError)) throw err;
  const status = {
    [payslip.ERROR.RUN_NOT_FINALIZED]: 409,
    [payslip.ERROR.LINE_NOT_FOUND]: 404,
    [payslip.ERROR.LINE_NOT_PAYABLE]: 409,
    [payslip.ERROR.RECONCILIATION_FAILED]: 500,
    [payslip.ERROR.ENTITY_MISMATCH]: 403,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

/** Generate payslips for an entire FINALIZED run, in bounded chunks. */
router.post('/runs/:runId/payslips', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.runId);
    const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    if (run.status !== 'FINALIZED') {
      return res.status(409).json({
        error: payslip.ERROR.RUN_NOT_FINALIZED,
        message: `Payslip hanya bisa dibuat dari run FINALIZED (status: ${run.status}).`,
      });
    }

    const lines = (await db.prepare(
      `SELECT id FROM payroll_run_lines WHERE payroll_run_id = ? AND calc_status = 'OK' ORDER BY employee_id ASC`
    ).all(run.id)).map((r) => r.id);

    const chunkSize = Math.min(Number(req.body.chunk_size) || 200, 500);
    const summary = { total: lines.length, created: 0, existing: 0, failed: 0, chunks: 0, errors: [] };

    for (let offset = 0; offset < lines.length; offset += chunkSize) {
      const chunk = lines.slice(offset, offset + chunkSize);
      await withRetry(async () => await withTransaction(db, async () => {
        for (const lineId of chunk) {
          try {
            const out = await payslip.generate(db, lineId, { generatedBy: req.userContext.displayName });
            if (out.created) summary.created += 1; else summary.existing += 1;
          } catch (err) {
            if (!(err instanceof payslip.PayslipError)) throw err;
            summary.failed += 1;
            summary.errors.push({ line_id: lineId, code: err.code, message: err.message });
          }
        }
      }), { label: `generate payslips ${offset}-${offset + chunk.length}` });
      summary.chunks += 1;
    }
    res.status(201).json(summary);
  } catch (err) { return sendPayslipError(res, err); } finally { db.close(); }
});

/** Generate (or fetch) one payslip for a single run line. */
router.post('/lines/:lineId/payslip', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run_line', req.params.lineId);
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await payslip.generate(db, Number(req.params.lineId), { generatedBy: req.userContext.displayName })),
    { label: 'generate payslip' });
    res.status(out.created ? 201 : 200).json({
      created: out.created, payslip_id: out.payslip.id,
      payslip_reference: out.payslip.payslip_reference,
      content_hash: out.payslip.content_hash,
      document: out.document,
    });
  } catch (err) { return sendPayslipError(res, err); } finally { db.close(); }
});

router.get('/runs/:runId/payslips', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_run', req.params.runId);
    const rows = await db.prepare(`
      SELECT p.id, p.payslip_reference, p.employee_id, e.full_name, p.legal_entity_id,
             p.run_number, p.payslip_version, p.gross_sen, p.employee_deductions_sen,
             p.net_sen, p.employer_cost_sen, p.content_hash, p.finalized_at, p.generated_at
      FROM payroll_payslips p JOIN employees e ON e.id = p.employee_id
      WHERE p.payroll_run_id = ? ORDER BY e.full_name ASC LIMIT ? OFFSET ?
    `).all(req.params.runId, Math.min(Number(req.query.limit) || 200, 2000), Number(req.query.offset) || 0);
    res.json(rows);
  } finally { db.close(); }
});

/** One payslip. `?format=text` returns the printable rendering. */
router.get('/payslips/:id', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payslip', req.params.id);
    const row = await db.prepare('SELECT * FROM payroll_payslips WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    const document = JSON.parse(row.document);
    if (req.query.format === 'text') {
      res.type('text/plain').send(payslip.renderText(document));
      return;
    }
    res.json({
      payslip_id: row.id,
      payslip_reference: row.payslip_reference,
      content_hash: row.content_hash,
      generated_at: row.generated_at,
      generated_by: row.generated_by,
      document,
    });
  } finally { db.close(); }
});

/** All payslips for one employee — the basis of future self-service. */
router.get('/employees/:employeeId/payslips', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'payslip', route: req.originalUrl });
    res.json(await db.prepare(`
      SELECT id, payslip_reference, payroll_period_id, run_number, payslip_version,
             gross_sen, net_sen, finalized_at, generated_at
      FROM payroll_payslips WHERE employee_id = ? AND ${sc.sql}
      ORDER BY payroll_period_id DESC, run_number DESC
    `).all(req.params.employeeId, ...sc.params));
  } finally { db.close(); }
});

module.exports = router;
