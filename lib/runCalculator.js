// lib/runCalculator.js
// Phase 2E — persists calculation results into a payroll run.
//
// The calculator itself (lib/payrollCalculator.js) stays PURE and untouched.
// This module is the thin persistence layer between it and payroll_run_lines:
// it reads frozen snapshots, calls the pure calculator, and stores the result
// plus its component breakdown.
//
// Follows docs/DB_EXECUTION_POLICY.md: one transaction per bounded chunk,
// retry wrapping the whole chunk, restartable, idempotent.
//
// A result must be PERSISTED before it can be approved — approving a figure
// that is recomputed on every read would approve nothing.

const crypto = require('crypto');
const { withTransaction, withRetry } = require('../database/init-db');
const calculator = require('./payrollCalculator');
const { stableStringify } = require('./asOfResolver');

const DEFAULT_CHUNK_SIZE = 200;

/** Hash the result for tamper-evidence, excluding nothing — it is frozen as-is. */
function hashResult(result) {
  return crypto.createHash('sha256').update(stableStringify(result)).digest('hex');
}

/**
 * Flatten the calculator's trace into per-component rows. This IS the payslip
 * source data: every line carries its basis, quantity, rate, formula,
 * rounding rule and rule version, so a figure can always be explained.
 */
function buildComponentRows(result) {
  // DERIVED AND SUBTOTAL ROWS. These appear in the calculation trace for
  // explainability, but they are NOT payslip line items: OVERTIME_HOURLY_RATE
  // is a rate rather than an amount, and the rest are subtotals of lines that
  // are already listed. Grouping them as line items double-counts — a defect
  // caught by the Phase 2F reconciliation check, which compares the sum of
  // rendered lines against the persisted totals.
  const DERIVED_OR_SUBTOTAL = new Set([
    'PRORATION_BASIS', 'EARNINGS_SUBTOTAL', 'BPJS_BASE', 'TAXABLE_BASE',
    'OVERTIME_HOURLY_RATE', 'OVERTIME_TOTAL',
    'BPJS_EMPLOYEE_TOTAL', 'BPJS_EMPLOYER_TOTAL',
    'OTHER_DEDUCTIONS', 'EMPLOYEE_DEDUCTIONS_TOTAL',
    'GROSS_PAY', 'NET_PAY',
  ]);

  const groupOf = (component) => {
    if (DERIVED_OR_SUBTOTAL.has(component)) return 'total';
    // Per-hour overtime lines are real amounts: OVERTIME_<date>_H<n>
    if (/^OVERTIME_\d{4}-\d{2}-\d{2}_H\d+$/.test(component)) return 'overtime';
    if (component.startsWith('BPJS_') || component.startsWith('JHT_') || component.startsWith('JP_')
      || component.startsWith('JKM_') || component.startsWith('JKK_')) return 'bpjs';
    if (component.startsWith('PPH21')) return 'tax';
    return 'component';
  };

  const byCode = new Map();
  for (const c of [...(result.earnings.components || []), ...(result.deductions.components || []),
    ...(result.employer.components || [])]) byCode.set(c.code, c);

  return (result.trace || []).map((t, i) => {
    const known = byCode.get(t.component);
    let group = groupOf(t.component);
    if (known) group = known.component_type === 'deduction' ? 'deduction' : 'earning';
    return {
      sequence: i + 1,
      component_code: t.component,
      component_group: group,
      paid_by: known ? known.paid_by : null,
      basis: t.basis || null,
      quantity: t.quantity === null || t.quantity === undefined ? null : String(t.quantity),
      rate: t.rate === null || t.rate === undefined ? null : String(t.rate),
      formula: t.formula || null,
      rounding_rule: t.rounding_rule || null,
      rule_version: t.rule_version || null,
      source_snapshot_field: t.source_snapshot_field || null,
      amount_sen: t.amount === null || t.amount === undefined ? null : t.amount,
    };
  });
}

/**
 * Calculate and persist ONE employee's line. Caller supplies the transaction.
 * Idempotent: an existing line for this (run, employee) is left alone.
 */
async function calculateOne(db, run, snapshot) {
  const existing = await db.prepare(
    'SELECT * FROM payroll_run_lines WHERE payroll_run_id = ? AND employee_id = ?'
  ).get(run.id, snapshot.employee_id);
  if (existing) return { outcome: 'SKIPPED_EXISTING', lineId: existing.id, calcStatus: existing.calc_status };

  // Legal entity isolation: a snapshot from another entity must never be
  // pulled into this run, even if a period id were mis-passed.
  if (snapshot.legal_entity_id !== run.legal_entity_id) {
    return {
      outcome: 'ENTITY_MISMATCH',
      detail: `snapshot entity ${snapshot.legal_entity_id} != run entity ${run.legal_entity_id}`,
    };
  }

  const payload = JSON.parse(snapshot.resolved_payload);
  const result = calculator.calculate(payload);
  const totals = result.totals || {};

  const info = await db.prepare(`
    INSERT INTO payroll_run_lines (
      payroll_run_id, snapshot_id, employee_id, legal_entity_id, calc_status,
      gross_sen, taxable_base_sen, bpjs_base_sen, overtime_sen,
      bpjs_employee_sen, bpjs_employer_sen, tax_sen, other_deductions_sen,
      employee_deductions_sen, net_sen, employer_cost_sen,
      payroll_rule_set_id, jkk_rate_version_id, ter_category,
      result_payload, result_hash, snapshot_hash, calculated_at
    ) VALUES (
      @payroll_run_id, @snapshot_id, @employee_id, @legal_entity_id, @calc_status,
      @gross_sen, @taxable_base_sen, @bpjs_base_sen, @overtime_sen,
      @bpjs_employee_sen, @bpjs_employer_sen, @tax_sen, @other_deductions_sen,
      @employee_deductions_sen, @net_sen, @employer_cost_sen,
      @payroll_rule_set_id, @jkk_rate_version_id, @ter_category,
      @result_payload, @result_hash, @snapshot_hash, kahe_now()
    ) RETURNING id
  `).run({
    payroll_run_id: run.id,
    snapshot_id: snapshot.id,
    employee_id: snapshot.employee_id,
    legal_entity_id: snapshot.legal_entity_id,
    calc_status: result.status,
    gross_sen: totals.gross_sen ?? null,
    taxable_base_sen: totals.taxable_base_sen ?? null,
    bpjs_base_sen: totals.bpjs_base_sen ?? null,
    overtime_sen: result.overtime ? result.overtime.total_sen : null,
    bpjs_employee_sen: result.bpjs ? result.bpjs.employee_total_sen : null,
    bpjs_employer_sen: result.bpjs ? result.bpjs.employer_total_sen : null,
    tax_sen: result.tax ? result.tax.amount_sen : null,
    other_deductions_sen: result.deductions ? result.deductions.other_sen : null,
    employee_deductions_sen: totals.employee_deductions_sen ?? null,
    net_sen: totals.net_sen ?? null,
    employer_cost_sen: totals.employer_cost_sen ?? null,
    payroll_rule_set_id: snapshot.payroll_rule_set_id,
    jkk_rate_version_id: snapshot.jkk_rate_version_id,
    ter_category: snapshot.ter_category,
    result_payload: JSON.stringify(result),
    result_hash: hashResult(result),
    snapshot_hash: snapshot.payload_hash,
  });

  const lineId = info.lastInsertRowid;
  if (result.status === calculator.CALC_STATUS.OK) {
    const insertComponent = db.prepare(`
      INSERT INTO payroll_run_line_components (
        payroll_run_line_id, sequence, component_code, component_group, paid_by,
        basis, quantity, rate, formula, rounding_rule, rule_version,
        source_snapshot_field, amount_sen
      ) VALUES (@payroll_run_line_id, @sequence, @component_code, @component_group, @paid_by,
        @basis, @quantity, @rate, @formula, @rounding_rule, @rule_version,
        @source_snapshot_field, @amount_sen)
    `);
    for (const row of buildComponentRows(result)) {
      await insertComponent.run({ payroll_run_line_id: lineId, ...row });
    }
  }

  return { outcome: 'CREATED', lineId, calcStatus: result.status, resultHash: hashResult(result) };
}

/** Employees still without a line — the restart set. */
async function getPendingSnapshots(db, run) {
  const done = new Set(
    (await db.prepare('SELECT employee_id FROM payroll_run_lines WHERE payroll_run_id = ?')
      .all(run.id)).map((r) => r.employee_id)
  );
  return (await db.prepare(`
    SELECT * FROM payroll_input_snapshots
    WHERE payroll_period_id = ? ORDER BY employee_id ASC
  `).all(run.payroll_period_id)).filter((s) => !done.has(s.employee_id));
}

/** Calculate a whole run in bounded chunks. */
async function calculateRun(db, run, { chunkSize = DEFAULT_CHUNK_SIZE, onChunk = null } = {}) {
  const pending = await getPendingSnapshots(db, run);
  const summary = { total: pending.length, created: 0, skipped: 0, blocked: 0, mismatched: 0, chunks: 0 };

  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    const chunk = pending.slice(offset, offset + chunkSize);
    await withRetry(async () => await withTransaction(db, async () => {
      for (const snapshot of chunk) {
        const r = await calculateOne(db, run, snapshot);
        if (r.outcome === 'CREATED') {
          summary.created += 1;
          if (r.calcStatus !== calculator.CALC_STATUS.OK) summary.blocked += 1;
        } else if (r.outcome === 'ENTITY_MISMATCH') summary.mismatched += 1;
        else summary.skipped += 1;
      }
    }), { label: `calculate run chunk ${offset}-${offset + chunk.length}` });
    summary.chunks += 1;
    if (onChunk) onChunk({ offset, size: chunk.length, summary });
  }
  return summary;
}

/** Aggregate totals for a run. Integer sen, so the sum reconciles exactly. */
async function getRunTotals(db, runId) {
  return await db.prepare(`
    SELECT COUNT(*) AS lines,
           SUM(CASE WHEN calc_status = 'OK' THEN 1 ELSE 0 END) AS ok_lines,
           COALESCE(SUM(gross_sen),0) AS gross_sen,
           COALESCE(SUM(net_sen),0) AS net_sen,
           COALESCE(SUM(bpjs_employee_sen),0) AS bpjs_employee_sen,
           COALESCE(SUM(bpjs_employer_sen),0) AS bpjs_employer_sen,
           COALESCE(SUM(tax_sen),0) AS tax_sen,
           COALESCE(SUM(employer_cost_sen),0) AS employer_cost_sen
    FROM payroll_run_lines WHERE payroll_run_id = ?
  `).get(runId);
}

module.exports = {
  DEFAULT_CHUNK_SIZE, hashResult, buildComponentRows,
  calculateOne, calculateRun, getPendingSnapshots, getRunTotals,
};
