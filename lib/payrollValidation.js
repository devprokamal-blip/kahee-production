// lib/payrollValidation.js
// Phase 2D — Validation & Exception Engine.
//
// SCOPE LOCK: decides WHAT IS WRONG. It persists no payroll result, no
// payslip, no approval, no payment. It never auto-fixes payroll data — an
// exception is raised for a human, and only a human (with the right
// permission) can resolve it.
//
// PURITY: `evaluate()` is pure — it takes a frozen snapshot row, its parsed
// payload, the dry-run result, and a small `context` object, and returns an
// array of exceptions. It performs no I/O. Persistence lives in
// `persistExceptions()`, which is the only function here that touches a db.
//
// DETERMINISM: the same (snapshot, result, context) always yields the same
// exception set, in the same order. Exception identity is
// (snapshot_id, exception_code), so re-validating UPDATES the message and
// leaves any human resolution intact rather than wiping it.

const { withTransaction, withRetry } = require('../database/init-db');
const calculator = require('./payrollCalculator');
const resolverLib = require('./asOfResolver');

const SEVERITY = { BLOCKING: 'BLOCKING', WARNING: 'WARNING', INFORMATIONAL: 'INFORMATIONAL' };
const RESOLUTION = { OPEN: 'OPEN', ACKNOWLEDGED: 'ACKNOWLEDGED', RESOLVED: 'RESOLVED' };

// Machine-readable, stable codes. Adding one is additive; renaming one is a
// breaking change for anything that has stored a resolution against it.
const CODE = {
  MISSING_PAYROLL_ASSIGNMENT: 'MISSING_PAYROLL_ASSIGNMENT',
  MISSING_SALARY_STRUCTURE: 'MISSING_SALARY_STRUCTURE',
  AMBIGUOUS_CONFIGURATION: 'AMBIGUOUS_CONFIGURATION',
  MISSING_BPJS_CONFIGURATION: 'MISSING_BPJS_CONFIGURATION',
  MISSING_TAX_CONFIGURATION: 'MISSING_TAX_CONFIGURATION',
  UNCLASSIFIED_DAY_TYPE: 'UNCLASSIFIED_DAY_TYPE',
  UNAPPROVED_OVERTIME: 'UNAPPROVED_OVERTIME',
  INVALID_SALARY_COMPONENT: 'INVALID_SALARY_COMPONENT',
  DUPLICATE_PAYROLL_CANDIDATE: 'DUPLICATE_PAYROLL_CANDIDATE',
  OUTSIDE_ELIGIBILITY_PERIOD: 'OUTSIDE_ELIGIBILITY_PERIOD',
  NEGATIVE_NET_PAY: 'NEGATIVE_NET_PAY',
  SUSPICIOUS_OVERTIME: 'SUSPICIOUS_OVERTIME',
  ZERO_SALARY_ACTIVE_EMPLOYEE: 'ZERO_SALARY_ACTIVE_EMPLOYEE',
  MISSING_ATTENDANCE: 'MISSING_ATTENDANCE',
  INCONSISTENT_PAYABLE_DAYS: 'INCONSISTENT_PAYABLE_DAYS',
  MASTER_DATA_DRIFT: 'MASTER_DATA_DRIFT',
  MISSING_BANK_DETAILS: 'MISSING_BANK_DETAILS',
  CALCULATION_BLOCKED: 'CALCULATION_BLOCKED',
  ANNUAL_TAX_RECONCILIATION_PENDING: 'ANNUAL_TAX_RECONCILIATION_PENDING',
  MID_PERIOD_SALARY_CHANGE: 'MID_PERIOD_SALARY_CHANGE',
};

// Severity is policy, declared in one table rather than scattered through the
// rules, so "is this blocking?" has exactly one answer per code.
const SEVERITY_OF = {
  [CODE.MISSING_PAYROLL_ASSIGNMENT]: SEVERITY.BLOCKING,
  [CODE.MISSING_SALARY_STRUCTURE]: SEVERITY.BLOCKING,
  [CODE.AMBIGUOUS_CONFIGURATION]: SEVERITY.BLOCKING,
  [CODE.MISSING_BPJS_CONFIGURATION]: SEVERITY.BLOCKING,
  [CODE.MISSING_TAX_CONFIGURATION]: SEVERITY.BLOCKING,
  [CODE.UNCLASSIFIED_DAY_TYPE]: SEVERITY.BLOCKING,
  [CODE.UNAPPROVED_OVERTIME]: SEVERITY.BLOCKING,
  [CODE.INVALID_SALARY_COMPONENT]: SEVERITY.BLOCKING,
  [CODE.DUPLICATE_PAYROLL_CANDIDATE]: SEVERITY.BLOCKING,
  [CODE.OUTSIDE_ELIGIBILITY_PERIOD]: SEVERITY.BLOCKING,
  [CODE.NEGATIVE_NET_PAY]: SEVERITY.BLOCKING,
  [CODE.CALCULATION_BLOCKED]: SEVERITY.BLOCKING,
  [CODE.MASTER_DATA_DRIFT]: SEVERITY.BLOCKING,

  [CODE.SUSPICIOUS_OVERTIME]: SEVERITY.WARNING,
  [CODE.ZERO_SALARY_ACTIVE_EMPLOYEE]: SEVERITY.WARNING,
  [CODE.MISSING_ATTENDANCE]: SEVERITY.WARNING,
  [CODE.INCONSISTENT_PAYABLE_DAYS]: SEVERITY.WARNING,
  [CODE.MISSING_BANK_DETAILS]: SEVERITY.WARNING,

  [CODE.ANNUAL_TAX_RECONCILIATION_PENDING]: SEVERITY.INFORMATIONAL,
  [CODE.MID_PERIOD_SALARY_CHANGE]: SEVERITY.INFORMATIONAL,
};

// Thresholds are configuration-shaped, not magic numbers buried in a branch.
// PP 35/2021 Pasal 26 caps ordinary-workday overtime at 4h/day and 18h/week.
const DEFAULT_THRESHOLDS = {
  suspicious_overtime_minutes_per_period: 18 * 60,   // ~18h in a period
  suspicious_overtime_minutes_per_day: 4 * 60,       // legal daily cap
};

/**
 * Evaluate one employee's payroll inputs and dry-run result. PURE.
 *
 * @param {object} args
 *   snapshot   — the payroll_input_snapshots row (for ids/status/hash)
 *   payload    — parsed resolved_payload
 *   result     — output of payrollCalculator.calculate(payload)
 *   context    — { employee, driftDetected, duplicateCandidateIn, thresholds, detectedAt }
 * @returns {Array<object>} exceptions, sorted deterministically by code
 */
function evaluate({ snapshot, payload, result, context = {} }) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(context.thresholds || {}) };
  const detectedAt = context.detectedAt || '1970-01-01 00:00:00';
  const out = [];

  const raise = (code, source, message, detail = null) => {
    const severity = SEVERITY_OF[code];
    if (!severity) throw new Error(`payrollValidation: no severity declared for ${code}`);
    out.push({
      exception_code: code,
      severity,
      blocking: severity === SEVERITY.BLOCKING ? 1 : 0,
      employee_id: snapshot.employee_id,
      payroll_period_id: snapshot.payroll_period_id,
      snapshot_id: snapshot.id,
      legal_entity_id: snapshot.legal_entity_id,
      source,
      message,
      detail,
      detected_at: detectedAt,
      resolution_status: RESOLUTION.OPEN,
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
    });
  };

  const errs = Array.isArray(result.errors) ? result.errors : [];
  const hasCalcError = (code) => errs.some((e) => e.code === code);
  const resolutionErrs = Array.isArray(payload.resolution_errors) ? payload.resolution_errors : [];
  const hasResErr = (code) => resolutionErrs.some((e) => e.code === code);

  // ---- resolution-stage problems (from Phase 2B) ----------------------------
  if (hasResErr(resolverLib.ERROR.MISSING_ASSIGNMENT)) {
    raise(CODE.MISSING_PAYROLL_ASSIGNMENT, 'snapshot.resolution',
      'Tidak ada payroll assignment yang berlaku pada periode ini.');
  }
  if (hasResErr(resolverLib.ERROR.AMBIGUOUS_ASSIGNMENT)
      || hasResErr(resolverLib.ERROR.AMBIGUOUS_RULE_SET)
      || hasResErr(resolverLib.ERROR.AMBIGUOUS_JKK_RATE)
      || hasResErr(resolverLib.ERROR.CALENDAR_UNRESOLVED)) {
    raise(CODE.AMBIGUOUS_CONFIGURATION, 'snapshot.resolution',
      'Konfigurasi effective-dated ambigu atau tidak berlaku pada tanggal ini.',
      { resolution_errors: resolutionErrs });
  }
  if (hasResErr(resolverLib.ERROR.MISSING_SALARY_STRUCTURE) || hasCalcError(calculator.CALC_ERROR.MISSING_SALARY_STRUCTURE)) {
    raise(CODE.MISSING_SALARY_STRUCTURE, 'snapshot.salary_structure',
      'Karyawan tidak memiliki komponen gaji yang berlaku pada periode ini.');
  }
  if (hasResErr(resolverLib.ERROR.MISSING_RULE_SET) || hasCalcError(calculator.CALC_ERROR.MISSING_BPJS_RULE)
      || hasCalcError(calculator.CALC_ERROR.MISSING_JKK)) {
    raise(CODE.MISSING_BPJS_CONFIGURATION, 'snapshot.bpjs_rule',
      'Konfigurasi BPJS (rule set atau kelas risiko JKK) tidak tersedia untuk periode ini.');
  }
  if (hasResErr(resolverLib.ERROR.MISSING_TER_TABLE) || hasCalcError(calculator.CALC_ERROR.MISSING_TAX_RULE)
      || hasCalcError(calculator.CALC_ERROR.NO_TER_BRACKET)) {
    raise(CODE.MISSING_TAX_CONFIGURATION, 'snapshot.tax',
      'Konfigurasi pajak (tabel TER / kategori PTKP) tidak tersedia atau tidak mencakup penghasilan ini.');
  }
  if (hasResErr(resolverLib.ERROR.UNCLASSIFIED_OVERTIME_DAY)
      || hasCalcError(calculator.CALC_ERROR.UNPRICEABLE_OVERTIME)
      || hasCalcError(calculator.CALC_ERROR.MISSING_OVERTIME_RULE)) {
    raise(CODE.UNCLASSIFIED_DAY_TYPE, 'snapshot.attendance.day_type',
      'Ada lembur disetujui pada hari yang jenis harinya belum bisa ditentukan, sehingga tidak bisa dihitung.');
  }
  if (hasResErr(resolverLib.ERROR.NOT_ELIGIBLE) || hasCalcError(calculator.CALC_ERROR.ZERO_PAYABLE_DAYS)) {
    raise(CODE.OUTSIDE_ELIGIBILITY_PERIOD, 'snapshot.eligibility',
      'Karyawan tidak memiliki hari yang dapat dibayar dalam periode ini.',
      { ineligible_reasons: (payload.eligibility && payload.eligibility.ineligible_reasons) || [] });
  }
  if (hasCalcError(calculator.CALC_ERROR.INVALID_COMPONENT)) {
    raise(CODE.INVALID_SALARY_COMPONENT, 'calculation.salary_structure',
      'Konfigurasi komponen gaji tidak valid.',
      { errors: errs.filter((e) => e.code === calculator.CALC_ERROR.INVALID_COMPONENT) });
  }
  if (hasCalcError(calculator.CALC_ERROR.NEGATIVE_NET_PAY)) {
    raise(CODE.NEGATIVE_NET_PAY, 'calculation.net_pay',
      'Gaji bersih negatif: total potongan melebihi penghasilan bruto.',
      { net_sen: result.totals ? result.totals.net_sen : null });
  }

  // A blocked calculation with no more specific cause still gets one code, so
  // nothing is ever silently un-flagged.
  if (result.status === calculator.CALC_STATUS.BLOCKED && out.every((e) => e.blocking === 0)) {
    raise(CODE.CALCULATION_BLOCKED, 'calculation',
      'Perhitungan tidak dapat diselesaikan.', { errors: errs });
  }

  // ---- unapproved overtime ---------------------------------------------------
  const pendingOt = Number(context.pendingOvertimeMinutes || 0);
  if (pendingOt > 0) {
    raise(CODE.UNAPPROVED_OVERTIME, 'timesheet.overtime_status',
      `Ada ${pendingOt} menit lembur yang belum disetujui dalam periode ini.`,
      { pending_minutes: pendingOt });
  }

  // ---- duplicate payroll candidate -------------------------------------------
  if (context.duplicateCandidateIn) {
    raise(CODE.DUPLICATE_PAYROLL_CANDIDATE, 'payroll_input_snapshots',
      `Karyawan ini juga menjadi kandidat payroll pada periode lain yang tumpang tindih (period ${context.duplicateCandidateIn}).`,
      { other_period_id: context.duplicateCandidateIn });
  }

  // ---- master data drift ------------------------------------------------------
  if (context.driftDetected) {
    raise(CODE.MASTER_DATA_DRIFT, 'snapshot.payload_hash',
      'Data master berubah setelah snapshot diambil. Hasil perhitungan memakai snapshot lama; tinjau sebelum melanjutkan.',
      { stored_hash: context.storedHash, current_hash: context.currentHash });
  }

  // ---- warnings ---------------------------------------------------------------
  const attendance = payload.attendance || {};
  const eligibility = payload.eligibility || {};

  if (Number(attendance.row_count || 0) === 0 && Number(eligibility.payable_days || 0) > 0) {
    raise(CODE.MISSING_ATTENDANCE, 'snapshot.attendance',
      'Tidak ada catatan absensi pada periode ini padahal karyawan berstatus dapat dibayar.',
      { payable_days: eligibility.payable_days });
  }

  if (result.status === calculator.CALC_STATUS.OK && Number(result.earnings.total_sen) === 0) {
    raise(CODE.ZERO_SALARY_ACTIVE_EMPLOYEE, 'calculation.earnings',
      'Karyawan aktif dengan total penghasilan nol.');
  }

  const otMinutes = Number(attendance.overtime_minutes_approved || 0);
  if (otMinutes > thresholds.suspicious_overtime_minutes_per_period) {
    raise(CODE.SUSPICIOUS_OVERTIME, 'snapshot.attendance.overtime_minutes_approved',
      `Total lembur ${otMinutes} menit melampaui ambang kewajaran ${thresholds.suspicious_overtime_minutes_per_period} menit.`,
      { minutes: otMinutes, threshold: thresholds.suspicious_overtime_minutes_per_period });
  } else {
    const overLongDay = (attendance.overtime_by_day || [])
      .find((d) => Number(d.minutes) > thresholds.suspicious_overtime_minutes_per_day && d.overtime_rule_day_type === 'workday');
    if (overLongDay) {
      raise(CODE.SUSPICIOUS_OVERTIME, 'snapshot.attendance.overtime_by_day',
        `Lembur ${overLongDay.minutes} menit pada ${overLongDay.work_date} melebihi batas 4 jam/hari untuk hari kerja biasa (PP 35/2021 Pasal 26).`,
        { work_date: overLongDay.work_date, minutes: overLongDay.minutes });
    }
  }

  // Payable days must agree with the eligibility segments they came from.
  const segmentDays = (eligibility.segments || []).reduce((t, s) => t + Number(s.days), 0);
  if ((eligibility.segments || []).length > 0 && segmentDays !== Number(eligibility.payable_days)) {
    raise(CODE.INCONSISTENT_PAYABLE_DAYS, 'snapshot.eligibility',
      `Jumlah hari pada segmen (${segmentDays}) tidak sama dengan payable_days (${eligibility.payable_days}).`,
      { segment_days: segmentDays, payable_days: eligibility.payable_days });
  }
  if (Number(eligibility.payable_days || 0) > Number(eligibility.total_days || 0)) {
    raise(CODE.INCONSISTENT_PAYABLE_DAYS, 'snapshot.eligibility',
      'payable_days melebihi jumlah hari dalam periode.',
      { payable_days: eligibility.payable_days, total_days: eligibility.total_days });
  }

  // Forward-looking: payment is a later phase, so this is a WARNING now and
  // will become a BLOCKING check at the payment stage.
  const emp = context.employee || {};
  if (!emp.bank_account_no) {
    raise(CODE.MISSING_BANK_DETAILS, 'employees.bank_account_no',
      'Rekening bank belum diisi. Belum menghalangi payroll, tetapi akan menghalangi pembayaran.',
      { future_stage: 'payment' });
  }

  // ---- informational -----------------------------------------------------------
  if (result.status === calculator.CALC_STATUS.OK && result.tax && result.tax.annual_reconciliation_required) {
    raise(CODE.ANNUAL_TAX_RECONCILIATION_PENDING, 'calculation.tax',
      'PPh21 bulanan dihitung dengan TER sebagai angsuran, BUKAN pajak tahunan final. Rekonsiliasi tahunan (Pasal 17) belum termasuk dalam cakupan sistem dan harus dilakukan terpisah.',
      { method: 'TER', is_final_annual_tax: false, scope: result.tax.annual_reconciliation_scope });
  }

  const segments = payload.salary_structure_segments || [];
  if (segments.length > 1) {
    raise(CODE.MID_PERIOD_SALARY_CHANGE, 'snapshot.salary_structure_segments',
      `Struktur gaji berubah di tengah periode (${segments.length} segmen). Proration dihitung per segmen.`,
      { segments: segments.map((s) => ({ from: s.from, to: s.to, days: s.days })) });
  }

  // Deterministic ordering: severity first, then code.
  const severityRank = { BLOCKING: 0, WARNING: 1, INFORMATIONAL: 2 };
  return out.sort((a, b) =>
    (severityRank[a.severity] - severityRank[b.severity]) || a.exception_code.localeCompare(b.exception_code));
}

/**
 * Persist an exception set for one snapshot.
 *
 * UPSERT by (snapshot_id, exception_code): the message and detail are
 * refreshed, but an existing resolution_status / resolved_by / resolution_note
 * is PRESERVED — re-validating must not wipe a human decision. Codes that no
 * longer apply are deleted only when still OPEN; a resolved exception stays as
 * an audit record.
 *
 * Caller supplies the transaction.
 */
async function persistExceptions(db, snapshotId, exceptions) {
  const existing = await db.prepare('SELECT * FROM payroll_exceptions WHERE snapshot_id = ?').all(snapshotId);
  const byCode = new Map(existing.map((e) => [e.exception_code, e]));
  const nowCodes = new Set(exceptions.map((e) => e.exception_code));

  const insert = db.prepare(`
    INSERT INTO payroll_exceptions (
      snapshot_id, payroll_period_id, employee_id, legal_entity_id,
      exception_code, severity, blocking, source, message, detail, detected_at
    ) VALUES (@snapshot_id, @payroll_period_id, @employee_id, @legal_entity_id,
      @exception_code, @severity, @blocking, @source, @message, @detail, @detected_at)
  `);
  const refresh = db.prepare(`
    UPDATE payroll_exceptions SET severity = ?, blocking = ?, source = ?, message = ?, detail = ?
    WHERE id = ?
  `);

  let created = 0; let refreshed = 0; let removed = 0;
  for (const e of exceptions) {
    const prior = byCode.get(e.exception_code);
    if (prior) {
      await refresh.run(e.severity, e.blocking, e.source, e.message, e.detail ? JSON.stringify(e.detail) : null, prior.id);
      refreshed += 1;
    } else {
      // Bind ONLY the declared columns: node:sqlite rejects an object
      // carrying named parameters the statement does not use.
      await insert.run({
        snapshot_id: e.snapshot_id,
        payroll_period_id: e.payroll_period_id,
        employee_id: e.employee_id,
        legal_entity_id: e.legal_entity_id,
        exception_code: e.exception_code,
        severity: e.severity,
        blocking: e.blocking,
        source: e.source,
        message: e.message,
        detail: e.detail ? JSON.stringify(e.detail) : null,
        detected_at: e.detected_at,
      });
      created += 1;
    }
  }
  for (const prior of existing) {
    if (nowCodes.has(prior.exception_code)) continue;
    if (prior.resolution_status === RESOLUTION.OPEN) {
      await db.prepare('DELETE FROM payroll_exceptions WHERE id = ?').run(prior.id);
      removed += 1;
    }
    // A resolved/acknowledged exception that no longer fires is retained as
    // an audit trail of what was reviewed.
  }
  return { created, refreshed, removed };
}

/** Can this period progress past validation? Blocking + unresolved = no. */
async function getBlockingSummary(db, payrollPeriodId) {
  const rows = await db.prepare(`
    SELECT severity, resolution_status, COUNT(*) AS n
    FROM payroll_exceptions WHERE payroll_period_id = ?
    GROUP BY severity, resolution_status
    ORDER BY severity, resolution_status
  `).all(payrollPeriodId);

  const unresolvedBlocking = (await db.prepare(`
    SELECT COUNT(*) AS n FROM payroll_exceptions
    WHERE payroll_period_id = ? AND blocking = 1 AND resolution_status != 'RESOLVED'
  `).get(payrollPeriodId)).n;

  const unacknowledgedWarnings = (await db.prepare(`
    SELECT COUNT(*) AS n FROM payroll_exceptions
    WHERE payroll_period_id = ? AND severity = 'WARNING' AND resolution_status = 'OPEN'
  `).get(payrollPeriodId)).n;

  return {
    counts: rows,
    unresolved_blocking: unresolvedBlocking,
    unacknowledged_warnings: unacknowledgedWarnings,
    // The gate the future approval/finalisation state machine must consult.
    may_progress: unresolvedBlocking === 0,
  };
}

module.exports = {
  SEVERITY, RESOLUTION, CODE, SEVERITY_OF, DEFAULT_THRESHOLDS,
  evaluate, persistExceptions, getBlockingSummary,
};
