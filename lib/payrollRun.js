// lib/payrollRun.js
// Phase 2E — Payroll Run lifecycle: state machine, approval, finalization.
//
// SCOPE: controls WHEN a calculated result may progress to approved and
// finalized, and makes a finalized result immutable. NOT payment, bank export
// or payslip delivery.
//
// LIFECYCLE (validated against the existing architecture before implementing):
//
//   DRAFT ──► SNAPSHOT_READY ──► CALCULATED ──► VALIDATED ──► APPROVED ──► FINALIZED
//                                    ▲              │            │
//                                    └──────────────┘            │
//                                   (recalculate)                │
//                                    ▲                           │
//                                    └───────────────────────────┘
//                                          (un-approve)
//
// Why each state is necessary, rather than merged away:
//   DRAFT          — the run exists and is bound to a period; nothing else.
//   SNAPSHOT_READY — every eligible employee has a FROZEN snapshot. This is a
//                    real gate: calculating from DRAFT snapshots would let the
//                    inputs move underneath the result.
//   CALCULATED     — results are PERSISTED. Phases 2C/2D were dry-run; a
//                    number must be stored before it can be approved, because
//                    approving a figure recomputed on every read approves
//                    nothing.
//   VALIDATED      — exceptions have been evaluated for this run's lines.
//                    Distinct from CALCULATED because a run can be calculated
//                    and not yet validated, and re-validation is routine.
//   APPROVED       — authorised sign-off. Reversible (un-approve) because a
//                    problem found after approval must not force finalization.
//   FINALIZED      — terminal and immutable. Correction creates a NEW run.
//
// No intermediary state beyond these proved necessary.

const { withTransaction, withRetry } = require('../database/init-db');
const validation = require('./payrollValidation');

const STATUS = {
  DRAFT: 'DRAFT',
  SNAPSHOT_READY: 'SNAPSHOT_READY',
  CALCULATED: 'CALCULATED',
  VALIDATED: 'VALIDATED',
  APPROVED: 'APPROVED',
  FINALIZED: 'FINALIZED',
};

const ALLOWED_TRANSITIONS = {
  DRAFT: ['SNAPSHOT_READY'],
  SNAPSHOT_READY: ['CALCULATED', 'DRAFT'],
  CALCULATED: ['VALIDATED', 'CALCULATED'],      // self = recalculate
  VALIDATED: ['APPROVED', 'CALCULATED'],        // back to CALCULATED = recalculate
  APPROVED: ['FINALIZED', 'VALIDATED'],         // back to VALIDATED = un-approve
  FINALIZED: [],                                // terminal, enforced by DB trigger too
};

const TRANSITION_ERROR = {
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  BLOCKING_EXCEPTIONS: 'BLOCKING_EXCEPTIONS',
  UNACKNOWLEDGED_WARNINGS: 'UNACKNOWLEDGED_WARNINGS',
  SOD_VIOLATION: 'SOD_VIOLATION',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  SNAPSHOTS_NOT_READY: 'SNAPSHOTS_NOT_READY',
  NO_LINES: 'NO_LINES',
  ALREADY_FINALIZED: 'ALREADY_FINALIZED',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
};

class TransitionError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/** Record every transition: actor, timestamp, from, to, reason. */
async function recordEvent(db, runId, fromStatus, toStatus, actor, note, detail = null) {
  await db.prepare(`
    INSERT INTO payroll_run_events (payroll_run_id, from_status, to_status, actor, note, detail, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, kahe_now())
  `).run(runId, fromStatus, toStatus, actor, note || null, detail ? JSON.stringify(detail) : null);
}

/**
 * Is this actor allowed to approve this run?
 *
 * Two independent checks:
 *   1. RBAC — must hold payroll_run:APPROVE.
 *   2. Segregation of duties — the person who PREPARED (calculated) the run
 *      may not approve it, unless they explicitly hold
 *      payroll_sod_override:ADMIN. That permission is granted to no role by
 *      default, including Operations Director, so the control holds until
 *      someone deliberately grants it.
 */
function checkApprovalAuthority(run, userContext) {
  const perms = userContext.permissions || {};
  if (!(perms.payroll_run || []).includes('APPROVE')) {
    throw new TransitionError(TRANSITION_ERROR.NOT_AUTHORIZED,
      'Menyetujui payroll run memerlukan izin payroll_run:APPROVE.');
  }
  const hasOverride = (perms.payroll_sod_override || []).length > 0;
  if (!hasOverride && run.prepared_by && run.prepared_by === userContext.displayName) {
    throw new TransitionError(TRANSITION_ERROR.SOD_VIOLATION,
      `Pemisahan tugas: ${userContext.displayName} yang menyiapkan perhitungan ini tidak boleh menyetujuinya sendiri. Diperlukan penyetuju lain, atau izin payroll_sod_override.`,
      { prepared_by: run.prepared_by });
    }
  return { hasOverride };
}

/**
 * The approval gate. Blocking exceptions always stop approval; warnings stop
 * it only when the payroll group's configured policy requires acknowledgement.
 */
async function checkApprovalGate(db, run) {
  const summary = await validation.getBlockingSummary(db, run.payroll_period_id);
  if (summary.unresolved_blocking > 0) {
    throw new TransitionError(TRANSITION_ERROR.BLOCKING_EXCEPTIONS,
      `Ada ${summary.unresolved_blocking} exception BLOCKING yang belum diselesaikan.`,
      { unresolved_blocking: summary.unresolved_blocking });
  }

  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(run.payroll_period_id);
  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(period.payroll_group_id);
  if (group && Number(group.require_warning_acknowledgement) === 1 && summary.unacknowledged_warnings > 0) {
    throw new TransitionError(TRANSITION_ERROR.UNACKNOWLEDGED_WARNINGS,
      `Kebijakan grup ${group.code} mengharuskan seluruh WARNING di-acknowledge sebelum persetujuan (${summary.unacknowledged_warnings} belum).`,
      { unacknowledged_warnings: summary.unacknowledged_warnings, policy: 'require_warning_acknowledgement' });
  }
  return summary;
}

/**
 * Create a run for a period. Run numbers increment; duplicates are impossible.
 * Phase 2G: `options.runType` may be CORRECTION or REVERSAL, in which case
 * `options.correctsRunId` must name a FINALIZED run of the same entity. A
 * correction NEVER edits the original — it references it.
 */
async function createRun(db, payrollPeriodId, userContext, options = {}) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(payrollPeriodId);
  if (!period) throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION, 'Payroll period tidak ditemukan.');
  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(period.payroll_group_id);

  const last = await db.prepare('SELECT MAX(run_number) AS n FROM payroll_runs WHERE payroll_period_id = ?').get(payrollPeriodId);
  const runNumber = Number(last.n || 0) + 1;

  const runType = options.runType || 'ORIGINAL';
  let correctsRunId = options.correctsRunId || null;

  if (runType !== 'ORIGINAL') {
    if (!correctsRunId) {
      throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION,
        `Run ${runType} harus menyebutkan run asal yang dikoreksi (corrects_run_id).`);
    }
    const source = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(correctsRunId);
    if (!source) {
      throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION, 'Run asal tidak ditemukan.');
    }
    if (source.status !== STATUS.FINALIZED) {
      throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION,
        `Hanya run FINALIZED yang bisa dikoreksi (status asal: ${source.status}).`);
    }
    if (source.legal_entity_id !== group.legal_entity_id) {
      throw new TransitionError(TRANSITION_ERROR.ENTITY_MISMATCH,
        'Run koreksi harus berada pada legal entity yang sama dengan run asal.');
    }
    correctsRunId = source.id;
  }

  const info = await db.prepare(`
    INSERT INTO payroll_runs (payroll_period_id, legal_entity_id, run_number, status, run_type, corrects_run_id, created_by)
    VALUES (?, ?, ?, 'DRAFT', ?, ?, ?) RETURNING id
  `).run(payrollPeriodId, group.legal_entity_id, runNumber, runType, correctsRunId, userContext.displayName);

  await recordEvent(db, info.lastInsertRowid, null, STATUS.DRAFT, userContext.displayName,
    runType === 'ORIGINAL' ? 'Run dibuat.' : `Run ${runType} dibuat untuk mengoreksi run #${correctsRunId}.`,
    { run_type: runType, corrects_run_id: correctsRunId });
  return await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(info.lastInsertRowid);
}

/** DRAFT -> SNAPSHOT_READY: every eligible employee must have a FROZEN snapshot. */
async function markSnapshotReady(db, run, userContext, note) {
  assertTransition(run, STATUS.SNAPSHOT_READY);
  // A CORRECTION/REVERSAL run inherits the original's frozen snapshots — by
  // definition they are already FROZEN, and re-freezing would be meaningless.
  if (run.run_type && run.run_type !== 'ORIGINAL') {
    await db.prepare(`UPDATE payroll_runs SET status = 'SNAPSHOT_READY' WHERE id = ?`).run(run.id);
    await recordEvent(db, run.id, run.status, STATUS.SNAPSHOT_READY, userContext.displayName,
      note || 'Snapshot diwarisi dari run asal.', { inherited_from: run.corrects_run_id });
    return { total: null, frozen: null, inherited: true };
  }
  const counts = await db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'FROZEN' THEN 1 ELSE 0 END) AS frozen
    FROM payroll_input_snapshots WHERE payroll_period_id = ?
  `).get(run.payroll_period_id);

  if (!counts.total) {
    throw new TransitionError(TRANSITION_ERROR.SNAPSHOTS_NOT_READY, 'Belum ada snapshot untuk periode ini.');
  }
  if (Number(counts.frozen) !== Number(counts.total)) {
    throw new TransitionError(TRANSITION_ERROR.SNAPSHOTS_NOT_READY,
      `Snapshot belum seluruhnya FROZEN (${counts.frozen}/${counts.total}). Bekukan snapshot sebelum menghitung.`,
      { frozen: counts.frozen, total: counts.total });
  }

  await db.prepare(`UPDATE payroll_runs SET status = 'SNAPSHOT_READY' WHERE id = ?`).run(run.id);
  await recordEvent(db, run.id, run.status, STATUS.SNAPSHOT_READY, userContext.displayName, note, { snapshots: counts.total });
  return counts;
}

/** VALIDATED -> APPROVED. Idempotent: approving an APPROVED run is a no-op. */
async function approve(db, run, userContext, note) {
  if (run.status === STATUS.APPROVED) {
    // IDEMPOTENT by design: a retried request must not error, and must not
    // rewrite who approved it or when.
    return { idempotent: true, run };
  }
  assertTransition(run, STATUS.APPROVED);
  const authority = checkApprovalAuthority(run, userContext);
  const gate = await checkApprovalGate(db, run);

  await db.prepare(`UPDATE payroll_runs SET status = 'APPROVED', approved_by = ?, approved_at = kahe_now() WHERE id = ?`)
    .run(userContext.displayName, run.id);
  await recordEvent(db, run.id, run.status, STATUS.APPROVED, userContext.displayName, note, {
    gate, sod_override_used: authority.hasOverride, prepared_by: run.prepared_by,
  });
  return { idempotent: false, run: await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(run.id) };
}

/** APPROVED -> VALIDATED. An audited un-approve, so a late problem is fixable. */
async function unapprove(db, run, userContext, note) {
  assertTransition(run, STATUS.VALIDATED);
  if (!note) throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION, 'Alasan wajib diisi saat membatalkan persetujuan.');
  await db.prepare(`UPDATE payroll_runs SET status = 'VALIDATED', approved_by = NULL, approved_at = NULL WHERE id = ?`).run(run.id);
  await recordEvent(db, run.id, run.status, STATUS.VALIDATED, userContext.displayName, note, { action: 'un-approve' });
}

/**
 * APPROVED -> FINALIZED. Terminal.
 * Duplicate finalization is REJECTED (not idempotent like approval): a second
 * finalization is a sign something is wrong, and the partial unique index
 * `uq_payroll_run_single_finalized_original` makes two finalized ORIGINAL
 * runs per period impossible regardless. Phase 2G narrowed this so a
 * CORRECTION or REVERSAL run can still be finalized against the original.
 */
async function finalize(db, run, userContext, note) {
  if (run.status === STATUS.FINALIZED) {
    throw new TransitionError(TRANSITION_ERROR.ALREADY_FINALIZED,
      'Run ini sudah FINALIZED. Koreksi harus dibuat sebagai run baru, bukan menimpa yang lama.');
  }
  assertTransition(run, STATUS.FINALIZED);

  if (!(userContext.permissions.payroll_run || []).includes('APPROVE')) {
    throw new TransitionError(TRANSITION_ERROR.NOT_AUTHORIZED,
      'Finalisasi payroll memerlukan izin payroll_run:APPROVE.');
  }
  const lines = (await db.prepare('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE payroll_run_id = ?').get(run.id)).n;
  if (!lines) throw new TransitionError(TRANSITION_ERROR.NO_LINES, 'Run tidak memiliki baris hasil perhitungan.');

  // Re-check the gate at the last possible moment: an exception could have
  // been raised between approval and finalization.
  const gate = await checkApprovalGate(db, run);

  await db.prepare(`UPDATE payroll_runs SET status = 'FINALIZED', finalized_by = ?, finalized_at = kahe_now() WHERE id = ?`)
    .run(userContext.displayName, run.id);
  await recordEvent(db, run.id, run.status, STATUS.FINALIZED, userContext.displayName, note, { lines, gate });
  return { lines };
}

function assertTransition(run, to) {
  if (run.status === STATUS.FINALIZED) {
    throw new TransitionError(TRANSITION_ERROR.ALREADY_FINALIZED,
      'Run sudah FINALIZED dan tidak dapat diubah. Buat run koreksi baru.');
  }
  if (!canTransition(run.status, to)) {
    throw new TransitionError(TRANSITION_ERROR.INVALID_TRANSITION,
      `Transisi ${run.status} -> ${to} tidak diizinkan. Yang diizinkan: ${(ALLOWED_TRANSITIONS[run.status] || []).join(', ') || '(tidak ada)'}.`,
      { from: run.status, to, allowed: ALLOWED_TRANSITIONS[run.status] || [] });
  }
}

/** Full transition history for a run. */
async function getHistory(db, runId) {
  return (await db.prepare('SELECT * FROM payroll_run_events WHERE payroll_run_id = ? ORDER BY id ASC')
    .all(runId))
    .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
}

module.exports = {
  STATUS, ALLOWED_TRANSITIONS, TRANSITION_ERROR, TransitionError,
  canTransition, createRun, markSnapshotReady, approve, unapprove, finalize,
  checkApprovalAuthority, checkApprovalGate, recordEvent, getHistory,
};
