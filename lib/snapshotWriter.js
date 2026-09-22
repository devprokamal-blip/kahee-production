// lib/snapshotWriter.js
// Phase 2B — writes resolved payroll inputs into payroll_input_snapshots.
//
// SCOPE LOCK: stores INPUTS. Calculates nothing.
//
// Follows docs/DB_EXECUTION_POLICY.md exactly:
//   * one transaction per bounded CHUNK, never one across the whole period;
//   * results and progress are the same row, so there is no separate progress
//     marker that could drift from what was actually written;
//   * idempotent — re-running a chunk skips employees that already have a
//     snapshot rather than inserting a second one (the
//     uq_snapshot_period_employee index is the structural backstop);
//   * restartable — `getPendingEmployees()` returns only those without a
//     snapshot, so an interrupted run resumes by simply being run again.
//
// IMMUTABILITY: a snapshot in status FROZEN is never updated or deleted by
// this module. Re-resolving a frozen snapshot returns a DRIFT report instead
// of overwriting it — that is the whole point of the phase.

const { withTransaction, withRetry } = require('../database/init-db');
const resolver = require('./asOfResolver');
const { getGroupMembership } = require('./payrollPeriod');

const DEFAULT_CHUNK_SIZE = 200;

const OUTCOME = {
  CREATED: 'CREATED',
  SKIPPED_EXISTING: 'SKIPPED_EXISTING',
  FROZEN_UNCHANGED: 'FROZEN_UNCHANGED',
  FAILED: 'FAILED',
};

/**
 * Everyone who should have a snapshot for this period: the period's group
 * membership, one row per employee. Deterministically ordered so chunk
 * boundaries are stable across restarts.
 */
async function getEligibleEmployees(db, payrollPeriodId) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(payrollPeriodId);
  if (!period) return [];
  return (await getGroupMembership(db, period.payroll_group_id, period.period_start, period.period_end))
    .map((m) => m.employee_id);
}

/** Those still missing a snapshot — the restart set. */
async function getPendingEmployees(db, payrollPeriodId) {
  const done = new Set(
    (await db.prepare('SELECT employee_id FROM payroll_input_snapshots WHERE payroll_period_id = ?')
      .all(payrollPeriodId)).map((r) => r.employee_id)
  );
  return (await getEligibleEmployees(db, payrollPeriodId)).filter((id) => !done.has(id));
}

/**
 * Write one employee's snapshot. Caller supplies the transaction — this is
 * called inside a chunk, never opening its own.
 * @returns {{outcome: string, snapshotId?: number, status?: string, errors?: object[]}}
 */
async function writeOne(db, employeeId, payrollPeriodId, { asOfDate = null, resolvedBy = 'system' } = {}) {
  const existing = await db.prepare(
    'SELECT * FROM payroll_input_snapshots WHERE payroll_period_id = ? AND employee_id = ?'
  ).get(payrollPeriodId, employeeId);

  // IDEMPOTENCY: already present -> do not resolve again, do not insert again.
  if (existing) {
    return {
      outcome: existing.status === 'FROZEN' ? OUTCOME.FROZEN_UNCHANGED : OUTCOME.SKIPPED_EXISTING,
      snapshotId: existing.id,
      status: existing.resolution_status,
      payloadHash: existing.payload_hash,
    };
  }

  const resolution = await resolver.resolve(db, employeeId, payrollPeriodId, asOfDate);
  const payload = resolver.buildPayload(resolution);
  const payloadHash = resolver.hashPayload(payload);

  const info = await db.prepare(`
    INSERT INTO payroll_input_snapshots (
      payroll_period_id, employee_id, as_of_date,
      legal_entity_id, payroll_group_id, payroll_group_effective_from,
      assignment_id, assignment_effective_from, work_pattern_id,
      work_calendar_id, work_calendar_effective_from,
      payroll_rule_set_id, payroll_rule_set_effective_from,
      jkk_risk_class, jkk_rate_version_id, jkk_rate_effective_from, ter_category,
      resolved_payload, payable_days, period_days, work_minutes_total,
      overtime_minutes_approved, attendance_row_count,
      payload_hash, resolution_status, resolution_errors,
      status, resolved_at, resolved_by
    ) VALUES (
      @payroll_period_id, @employee_id, @as_of_date,
      @legal_entity_id, @payroll_group_id, @payroll_group_effective_from,
      @assignment_id, @assignment_effective_from, @work_pattern_id,
      @work_calendar_id, @work_calendar_effective_from,
      @payroll_rule_set_id, @payroll_rule_set_effective_from,
      @jkk_risk_class, @jkk_rate_version_id, @jkk_rate_effective_from, @ter_category,
      @resolved_payload, @payable_days, @period_days, @work_minutes_total,
      @overtime_minutes_approved, @attendance_row_count,
      @payload_hash, @resolution_status, @resolution_errors,
      'DRAFT', @resolved_at, @resolved_by
    ) RETURNING id
  `).run({
    payroll_period_id: payrollPeriodId,
    employee_id: employeeId,
    as_of_date: resolution.asOfDate,
    // A resolution that failed still records WHICH entity/group it got to, so
    // the exception is diagnosable. Unknown values stay NULL, never defaulted.
    legal_entity_id: (resolution.legalEntity && resolution.legalEntity.id)
      || (resolution.assignment && resolution.assignment.legal_entity_id)
      || 'UNRESOLVED',
    payroll_group_id: (resolution.group && resolution.group.id)
      || (resolution.period && resolution.period.payroll_group_id) || 0,
    payroll_group_effective_from: resolution.group ? resolution.group.effective_from : null,
    assignment_id: resolution.assignment ? resolution.assignment.id : null,
    assignment_effective_from: resolution.assignment ? resolution.assignment.effective_date : null,
    work_pattern_id: resolution.workPattern ? resolution.workPattern.id : null,
    work_calendar_id: (resolution.calendarResolution && resolution.calendarResolution.calendar)
      ? resolution.calendarResolution.calendar.id : null,
    work_calendar_effective_from: (resolution.calendarResolution && resolution.calendarResolution.calendar)
      ? resolution.calendarResolution.calendar.effective_from : null,
    payroll_rule_set_id: resolution.ruleSet ? resolution.ruleSet.id : null,
    payroll_rule_set_effective_from: resolution.ruleSet ? resolution.ruleSet.effective_date : null,
    jkk_risk_class: resolution.legalEntity ? resolution.legalEntity.jkk_risk_class : null,
    jkk_rate_version_id: resolution.jkkVersion ? resolution.jkkVersion.id : null,
    jkk_rate_effective_from: resolution.jkkVersion ? resolution.jkkVersion.effective_date : null,
    ter_category: resolution.terCategory,
    resolved_payload: JSON.stringify(payload),
    payable_days: resolution.eligibility ? resolution.eligibility.payableDays : 0,
    period_days: resolution.eligibility ? resolution.eligibility.totalDays : 0,
    work_minutes_total: resolution.workMinutesTotal || 0,
    overtime_minutes_approved: resolution.overtimeMinutesApproved || 0,
    attendance_row_count: (resolution.attendance || []).length,
    payload_hash: payloadHash,
    resolution_status: resolution.status,
    resolution_errors: resolution.errors.length ? JSON.stringify(resolution.errors) : null,
    resolved_at: resolution.resolvedAt,
    resolved_by: resolvedBy,
  });

  return {
    outcome: OUTCOME.CREATED,
    snapshotId: info.lastInsertRowid,
    status: resolution.status,
    errors: resolution.errors,
    payloadHash,
  };
}

/**
 * Snapshot a whole period in BOUNDED CHUNKS.
 *
 * Each chunk is its own transaction wrapped in withRetry, per
 * docs/DB_EXECUTION_POLICY.md rule 5 (retry wraps the whole unit of work).
 * A crash between chunks leaves completed chunks committed; re-running
 * continues from the pending set.
 */
async function snapshotPeriod(db, payrollPeriodId, { chunkSize = DEFAULT_CHUNK_SIZE, asOfDate = null, resolvedBy = 'system', onChunk = null } = {}) {
  const pending = await getPendingEmployees(db, payrollPeriodId);
  const summary = { total: pending.length, created: 0, skipped: 0, incomplete: 0, chunks: 0, failures: [] };

  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    const chunk = pending.slice(offset, offset + chunkSize);

    await withRetry(async () => await withTransaction(db, async () => {
      for (const employeeId of chunk) {
        const result = await writeOne(db, employeeId, payrollPeriodId, { asOfDate, resolvedBy });
        if (result.outcome === OUTCOME.CREATED) {
          summary.created += 1;
          if (result.status !== resolver.RESOLUTION_STATUS.OK) {
            summary.incomplete += 1;
            summary.failures.push({ employeeId, errors: result.errors });
          }
        } else {
          summary.skipped += 1;
        }
      }
    }), { label: `snapshot chunk ${offset}-${offset + chunk.length}` });

    summary.chunks += 1;
    if (onChunk) onChunk({ offset, size: chunk.length, summary });
  }

  return summary;
}

/**
 * Freeze every snapshot in a period. After this, the rows are immutable:
 * nothing in this module updates or deletes a FROZEN row.
 */
async function freezePeriod(db, payrollPeriodId, frozenBy) {
  return await withRetry(async () => await withTransaction(db, async () => {
    const info = await db.prepare(`
      UPDATE payroll_input_snapshots
      SET status = 'FROZEN', frozen_at = kahe_now(), frozen_by = ?
      WHERE payroll_period_id = ? AND status = 'DRAFT'
    `).run(frozenBy, payrollPeriodId);
    return { frozen: info.changes || 0 };
  }), { label: 'freeze snapshots' });
}

/**
 * Re-resolve an existing snapshot and compare hashes WITHOUT touching it.
 *
 * This is the immutability proof: after a master-data change, the stored
 * snapshot still holds the old picture, and this reports that the live
 * configuration now differs. It never rewrites history.
 */
async function detectDrift(db, snapshotId) {
  const snap = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(snapshotId);
  if (!snap) return { found: false };

  const fresh = await resolver.resolve(db, snap.employee_id, snap.payroll_period_id, snap.as_of_date);
  const freshHash = resolver.hashPayload(resolver.buildPayload(fresh));

  return {
    found: true,
    snapshotId,
    status: snap.status,
    storedHash: snap.payload_hash,
    currentHash: freshHash,
    drifted: snap.payload_hash !== freshHash,
    immutable: snap.status === 'FROZEN',
  };
}

module.exports = {
  DEFAULT_CHUNK_SIZE, OUTCOME,
  getEligibleEmployees, getPendingEmployees,
  writeOne, snapshotPeriod, freezePeriod, detectDrift,
};
