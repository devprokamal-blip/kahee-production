// lib/validationRunner.js
// Phase 2D — orchestration: gathers the context the pure validator needs,
// runs it per employee in BOUNDED CHUNKS, and persists the exception set.
// Follows docs/DB_EXECUTION_POLICY.md: one transaction per chunk, retry wraps
// the whole chunk, restartable, no giant transaction.
//
// Persists EXCEPTIONS only. No payroll result, payslip, approval or payment.

const { withTransaction, withRetry } = require('../database/init-db');
const calculator = require('./payrollCalculator');
const validation = require('./payrollValidation');
const snapshotWriter = require('./snapshotWriter');

const DEFAULT_CHUNK_SIZE = 200;

/** Build the non-pure context the validator needs, for one snapshot. */
async function buildContext(db, snapshot, { detectedAt, thresholds } = {}) {
  const employee = await db.prepare(
    'SELECT id, full_name, status, bank_account_no, bank_name FROM employees WHERE id = ?'
  ).get(snapshot.employee_id) || {};

  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(snapshot.payroll_period_id);

  // Overtime still pending approval inside the period window.
  const pending = await db.prepare(`
    SELECT COALESCE(SUM(overtime_minutes_requested),0) AS minutes
    FROM timesheet_entries
    WHERE employee_id = ? AND work_date >= ? AND work_date <= ? AND overtime_status = 'pending'
  `).get(snapshot.employee_id, period.period_start, period.period_end);

  // Another snapshot for the same employee in a DIFFERENT but date-overlapping
  // period — i.e. a genuine risk of being paid twice for the same days.
  const duplicate = await db.prepare(`
    SELECT s.payroll_period_id FROM payroll_input_snapshots s
    JOIN payroll_periods p ON p.id = s.payroll_period_id
    WHERE s.employee_id = ? AND s.payroll_period_id != ?
      AND p.period_start <= ? AND p.period_end >= ?
    LIMIT 1
  `).get(snapshot.employee_id, snapshot.payroll_period_id, period.period_end, period.period_start);

  const drift = await snapshotWriter.detectDrift(db, snapshot.id);

  return {
    employee,
    detectedAt,
    thresholds,
    pendingOvertimeMinutes: Number(pending.minutes || 0),
    duplicateCandidateIn: duplicate ? duplicate.payroll_period_id : null,
    driftDetected: !!(drift.found && drift.drifted),
    storedHash: drift.storedHash,
    currentHash: drift.currentHash,
  };
}

/** Validate ONE snapshot. Caller supplies the transaction. */
async function validateOne(db, snapshot, { detectedAt, thresholds } = {}) {
  const payload = JSON.parse(snapshot.resolved_payload);
  const result = calculator.calculate(payload);
  const context = await buildContext(db, snapshot, { detectedAt, thresholds });
  const exceptions = validation.evaluate({ snapshot, payload, result, context });
  const persisted = await validation.persistExceptions(db, snapshot.id, exceptions);
  return { result, exceptions, persisted };
}

/** Validate a whole period in bounded chunks. */
async function validatePeriod(db, payrollPeriodId, { chunkSize = DEFAULT_CHUNK_SIZE, thresholds, detectedAt } = {}) {
  const stamp = detectedAt || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const snapshots = (await db.prepare(
    'SELECT id FROM payroll_input_snapshots WHERE payroll_period_id = ? ORDER BY employee_id ASC'
  ).all(payrollPeriodId)).map((r) => r.id);

  const summary = { total: snapshots.length, chunks: 0, blocking: 0, warning: 0, informational: 0, employees_blocked: 0 };

  for (let offset = 0; offset < snapshots.length; offset += chunkSize) {
    const chunk = snapshots.slice(offset, offset + chunkSize);
    await withRetry(async () => await withTransaction(db, async () => {
      for (const id of chunk) {
        const snapshot = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(id);
        const { exceptions } = await validateOne(db, snapshot, { detectedAt: stamp, thresholds });
        let blockedThis = false;
        for (const e of exceptions) {
          if (e.severity === validation.SEVERITY.BLOCKING) { summary.blocking += 1; blockedThis = true; }
          else if (e.severity === validation.SEVERITY.WARNING) summary.warning += 1;
          else summary.informational += 1;
        }
        if (blockedThis) summary.employees_blocked += 1;
      }
    }), { label: `validate chunk ${offset}-${offset + chunk.length}` });
    summary.chunks += 1;
  }

  return { ...summary, gate: await validation.getBlockingSummary(db, payrollPeriodId) };
}

module.exports = { DEFAULT_CHUNK_SIZE, buildContext, validateOne, validatePeriod };
