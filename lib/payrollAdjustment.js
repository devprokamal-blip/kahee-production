// lib/payrollAdjustment.js
// Phase 2G — Adjustments, Retroactive Payroll & Reversal.
//
// ============================================================
// HARD CONTRACT
// ============================================================
// A FINALIZED payroll is immutable. Nothing in this module edits a finalized
// run, line, component, snapshot or payslip. Every correction is:
//   1. an entry in the payroll_adjustments ledger, referencing the original
//      FINALIZED run, then
//   2. applied through a CORRECTION run (deltas only) or a REVERSAL run
//      (full negation) that references that original run.
//
// STATUTORY RULES COME FROM THE ORIGINAL SNAPSHOT, NEVER LIVE CONFIG.
// A correction raised in September for June payroll is computed under June's
// BPJS rates, June's JKK version and June's TER table — the versions frozen
// into the original line. That is the whole point of Phase 2B, carried
// forward here. A test greps this file for live rule-table names.

const crypto = require('crypto');
const { applyBp, roundHalfUp } = require('./money');
const { overtimePaySen, hourlyRateSen } = require('./time');
const { stableStringify } = require('./asOfResolver');

const STATUS = { DRAFT: 'DRAFT', APPROVED: 'APPROVED', APPLIED: 'APPLIED', VOID: 'VOID' };
const DIRECTION = { CREDIT: 'CREDIT', DEBIT: 'DEBIT' };   // CREDIT adds pay, DEBIT reduces it
const RUN_TYPE = { ORIGINAL: 'ORIGINAL', CORRECTION: 'CORRECTION', REVERSAL: 'REVERSAL' };

const TYPE = {
  RETRO_EARNING: 'RETRO_EARNING',
  RETRO_DEDUCTION: 'RETRO_DEDUCTION',
  LATE_OVERTIME: 'LATE_OVERTIME',
  ATTENDANCE_CORRECTION: 'ATTENDANCE_CORRECTION',
  TAX_CORRECTION: 'TAX_CORRECTION',
  BPJS_CORRECTION: 'BPJS_CORRECTION',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
};

const ERROR = {
  SOURCE_NOT_FINALIZED: 'SOURCE_NOT_FINALIZED',
  SOURCE_LINE_NOT_FOUND: 'SOURCE_LINE_NOT_FOUND',
  NOT_APPROVED: 'NOT_APPROVED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  NOTHING_TO_APPLY: 'NOTHING_TO_APPLY',
  INVALID_STATE: 'INVALID_STATE',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  VALIDATION: 'VALIDATION',
};

class AdjustmentError extends Error {
  constructor(code, message, detail = null) { super(message); this.code = code; this.detail = detail; }
}

/**
 * Signed value of an adjustment, from the EMPLOYEE'S point of view:
 *   CREDIT = the employee receives MORE  (+)
 *   DEBIT  = the employee receives LESS  (-)
 *
 * This is the only definition of direction in the system, and it holds
 * regardless of which side of the payslip the adjustment lands on. For an
 * EARNINGS adjustment the signed value moves gross directly. For a
 * DEDUCTION-side adjustment (retro deduction, tax correction, BPJS
 * correction) the deduction moves in the OPPOSITE direction to the pay, so
 * callers use deductionSide() below rather than flipping signs by hand.
 */
function signedAmount(adj) {
  return adj.direction === DIRECTION.CREDIT ? Number(adj.amount_sen) : -Number(adj.amount_sen);
}

/**
 * The value to ADD TO THE DEDUCTION TOTAL for a deduction-side adjustment.
 *
 * A DEBIT means the employee is paid less, which means the deduction goes UP.
 * Returning `-signedAmount` keeps "CREDIT increases pay, DEBIT decreases pay"
 * true on both sides of the payslip.
 *
 * (Phase 2H found this: a DEBIT retro deduction was increasing net pay,
 * because the signed value was added straight to the deduction total.)
 */
function deductionSide(adj) {
  return -signedAmount(adj);
}

/**
 * Create a ledger entry. Does NOT change payroll — it records an intent that
 * must be approved and then applied through a correction run.
 */
async function createAdjustment(db, input, userContext) {
  const required = ['source_run_id', 'employee_id', 'adjustment_type', 'component_code', 'direction', 'reason'];
  for (const f of required) {
    if (!input[f]) throw new AdjustmentError(ERROR.VALIDATION, `${f} wajib diisi.`);
  }
  if (!Object.values(TYPE).includes(input.adjustment_type)) {
    throw new AdjustmentError(ERROR.VALIDATION, `adjustment_type tidak dikenal: ${input.adjustment_type}`);
  }
  if (!Object.values(DIRECTION).includes(input.direction)) {
    throw new AdjustmentError(ERROR.VALIDATION, `direction harus CREDIT atau DEBIT.`);
  }

  const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(input.source_run_id);
  if (!run) throw new AdjustmentError(ERROR.VALIDATION, 'Payroll run sumber tidak ditemukan.');
  if (run.status !== 'FINALIZED') {
    throw new AdjustmentError(ERROR.SOURCE_NOT_FINALIZED,
      `Penyesuaian hanya bisa dibuat terhadap run FINALIZED (status: ${run.status}).`);
  }

  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id = ? AND employee_id = ?')
    .get(run.id, input.employee_id);
  if (!line) {
    throw new AdjustmentError(ERROR.SOURCE_LINE_NOT_FOUND,
      `Karyawan ${input.employee_id} tidak ada dalam run ${run.id}.`);
  }

  if (input.external_reference) {
    const dupe = await db.prepare('SELECT id FROM payroll_adjustments WHERE external_reference = ?').get(input.external_reference);
    if (dupe) {
      throw new AdjustmentError(ERROR.DUPLICATE_REFERENCE,
        `external_reference ${input.external_reference} sudah dipakai oleh penyesuaian #${dupe.id}.`,
        { existing_id: dupe.id });
    }
  }

  // LATE_OVERTIME is priced here, at creation, using the ORIGINAL line's
  // frozen overtime rate and the frozen multiplier table — never live rules.
  let amountSen = input.amount_sen;
  let overtimeMinutes = input.overtime_minutes ?? null;
  if (input.adjustment_type === TYPE.LATE_OVERTIME) {
    if (!overtimeMinutes || overtimeMinutes <= 0) {
      throw new AdjustmentError(ERROR.VALIDATION, 'overtime_minutes wajib diisi untuk LATE_OVERTIME.');
    }
    amountSen = priceLateOvertime(line, overtimeMinutes, input.overtime_day_type || 'WORKDAY');
  }
  if (amountSen === undefined || amountSen === null || !Number.isInteger(Number(amountSen))) {
    throw new AdjustmentError(ERROR.VALIDATION, 'amount_sen harus bilangan bulat (sen).');
  }
  if (Number(amountSen) < 0) {
    throw new AdjustmentError(ERROR.VALIDATION, 'amount_sen tidak boleh negatif; gunakan direction DEBIT.');
  }

  const info = await db.prepare(`
    INSERT INTO payroll_adjustments (
      source_run_id, source_period_id, employee_id, legal_entity_id,
      adjustment_type, component_code, direction, amount_sen,
      overtime_minutes, overtime_day_type, work_date,
      is_taxable, is_bpjs_base, reason, external_reference,
      status, created_by, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, kahe_now()) RETURNING id
  `).run(
    run.id, run.payroll_period_id, input.employee_id, line.legal_entity_id,
    input.adjustment_type, input.component_code, input.direction, Number(amountSen),
    overtimeMinutes, input.overtime_day_type || null, input.work_date || null,
    input.is_taxable === 0 ? 0 : 1, input.is_bpjs_base === 1 ? 1 : 0,
    input.reason, input.external_reference || null, userContext.displayName
  );
  return await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Price late overtime using the ORIGINAL line's frozen hourly rate and
 * multiplier table. Progressive within the day, exactly as Phase 2C.
 */
function priceLateOvertime(line, minutes, dayType) {
  const result = JSON.parse(line.result_payload);
  const snapshotRules = result.overtime && result.overtime.hourly_rate_sen !== null
    ? result.overtime.hourly_rate_sen
    : null;

  // The frozen rate: prefer the one already computed on the original line;
  // fall back to deriving it from the frozen overtime base and divisor.
  const rate = snapshotRules !== null && snapshotRules !== undefined
    ? snapshotRules
    : hourlyRateSen(result.overtime.base_sen, result.rule_versions ? 173 : 173);

  const band = dayType === 'WORKDAY' ? 'workday' : 'rest_or_holiday_5day';
  const rules = (result.overtime_rules_frozen || []).length
    ? result.overtime_rules_frozen
    : null;

  // The original result does not carry the multiplier table itself, so the
  // bands are taken from the per-day segments it DID record when available;
  // otherwise fall back to the statutory progression the original used.
  const fallback = band === 'workday'
    ? [{ hour_from: 1, hour_to: 1, multiplier_bp: 15000 }, { hour_from: 2, hour_to: null, multiplier_bp: 20000 }]
    : [{ hour_from: 1, hour_to: 8, multiplier_bp: 20000 }];
  const bands = rules || fallback;

  let remaining = Number(minutes);
  let hour = 1;
  let total = 0;
  while (remaining > 0) {
    const rule = bands.find((r) => hour >= r.hour_from && (r.hour_to === null || hour <= r.hour_to))
      || bands[bands.length - 1];
    const slice = Math.min(remaining, 60);
    total += overtimePaySen(rate, slice, rule.multiplier_bp);
    remaining -= slice;
    hour += 1;
  }
  return total;
}

async function approveAdjustment(db, adjustmentId, userContext, note) {
  const adj = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adjustmentId);
  if (!adj) throw new AdjustmentError(ERROR.VALIDATION, 'Penyesuaian tidak ditemukan.');
  if (adj.status !== STATUS.DRAFT) {
    throw new AdjustmentError(ERROR.INVALID_STATE, `Hanya penyesuaian DRAFT yang bisa disetujui (status: ${adj.status}).`);
  }
  // Segregation of duties: the creator may not approve their own adjustment
  // unless they hold the explicit override, mirroring the run-level control.
  const hasOverride = ((userContext.permissions || {}).payroll_sod_override || []).length > 0;
  if (!hasOverride && adj.created_by === userContext.displayName) {
    throw new AdjustmentError(ERROR.NOT_AUTHORIZED,
      `Pemisahan tugas: ${userContext.displayName} yang membuat penyesuaian ini tidak boleh menyetujuinya sendiri.`,
      { created_by: adj.created_by });
  }
  await db.prepare(`UPDATE payroll_adjustments SET status='APPROVED', approved_by=?, approved_at=kahe_now(),
              reason = reason || ? WHERE id = ?`)
    .run(userContext.displayName, note ? ` | disetujui: ${note}` : '', adj.id);
  return await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adj.id);
}

async function voidAdjustment(db, adjustmentId, userContext, reason) {
  const adj = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adjustmentId);
  if (!adj) throw new AdjustmentError(ERROR.VALIDATION, 'Penyesuaian tidak ditemukan.');
  if (adj.status === STATUS.APPLIED) {
    throw new AdjustmentError(ERROR.ALREADY_APPLIED,
      'Penyesuaian yang sudah diterapkan tidak bisa dibatalkan; buat penyesuaian balik (reversing entry).');
  }
  if (!reason) throw new AdjustmentError(ERROR.VALIDATION, 'Alasan pembatalan wajib diisi.');
  await db.prepare(`UPDATE payroll_adjustments SET status='VOID', voided_by=?, voided_at=kahe_now(), void_reason=? WHERE id=?`)
    .run(userContext.displayName, reason, adj.id);
  return await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adj.id);
}

/**
 * Compute one employee's correction DELTA from their approved adjustments,
 * using the statutory rules FROZEN in the original line.
 *
 * Returns integer sen throughout, with a full trace.
 */
async function computeDelta(db, sourceLine, adjustments) {
  const original = JSON.parse(sourceLine.result_payload);
  const bpjsRule = original.rule_versions || {};
  const snapshot = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(sourceLine.snapshot_id);
  const frozen = JSON.parse(snapshot.resolved_payload);
  const rules = frozen.bpjs_rule;
  const jkk = frozen.jkk;
  const trace = [];

  const add = (component, basis, quantity, rate, formula, amount, ruleVersion = null) =>
    trace.push({ component, basis, quantity, rate, formula, amount_sen: amount,
      rounding_rule: 'half_up_to_sen', rule_version: ruleVersion });

  let grossDelta = 0;
  let deductionDelta = 0;
  let taxableDelta = 0;
  let bpjsBaseDelta = 0;
  let explicitTaxDelta = 0;
  let explicitBpjsEmployeeDelta = 0;

  for (const a of adjustments) {
    const signed = signedAmount(a);   // employee-facing sign, for the trace
    add(a.component_code, `${a.adjustment_type} (${a.direction})`,
      a.overtime_minutes ? `${a.overtime_minutes} menit` : '1',
      null, 'adjustment amount', signed, `adjustment:${a.id}`);

    if (a.adjustment_type === TYPE.TAX_CORRECTION) {
      // An explicit tax correction replaces recomputation: the amount IS the
      // tax delta, entered deliberately. DEBIT = withhold more = net down.
      explicitTaxDelta += deductionSide(a);
      continue;
    }
    if (a.adjustment_type === TYPE.BPJS_CORRECTION) {
      explicitBpjsEmployeeDelta += deductionSide(a);
      continue;
    }
    if (a.adjustment_type === TYPE.RETRO_DEDUCTION) {
      // Deduction side: DEBIT raises the deduction, so net pay falls.
      deductionDelta += deductionSide(a);
      continue;
    }
    // Everything else is an earnings-side delta.
    grossDelta += signed;
    if (a.is_taxable === 1) taxableDelta += signed;
    if (a.is_bpjs_base === 1) bpjsBaseDelta += signed;
  }

  // --- statutory recomputation on the DELTA, under the FROZEN rules ---
  // Caps are deliberately NOT re-applied here: the original already consumed
  // the cap, and re-applying it to a delta in isolation would over-contribute.
  // A cap interaction on a retro payment is a TAX_CORRECTION / BPJS_CORRECTION
  // decision, entered explicitly, which is why those types exist.
  let bpjsEmployeeDelta = explicitBpjsEmployeeDelta;
  let bpjsEmployerDelta = 0;
  if (bpjsBaseDelta !== 0) {
    const kes = applyBp(bpjsBaseDelta, rules.bpjs_kesehatan_rate_employee_bp);
    const jht = applyBp(bpjsBaseDelta, rules.jht_rate_employee_bp);
    const jp = applyBp(bpjsBaseDelta, rules.jp_rate_employee_bp);
    bpjsEmployeeDelta += kes + jht + jp;
    add('BPJS_EMPLOYEE_DELTA', 'delta bpjs base (frozen rates)', `${bpjsBaseDelta} sen`,
      `${rules.bpjs_kesehatan_rate_employee_bp}+${rules.jht_rate_employee_bp}+${rules.jp_rate_employee_bp} bp`,
      'delta_base * rate_bp / 10000', kes + jht + jp, `rule_set:${rules.rule_set_id}`);

    const kesC = applyBp(bpjsBaseDelta, rules.bpjs_kesehatan_rate_company_bp);
    const jhtC = applyBp(bpjsBaseDelta, rules.jht_rate_company_bp);
    const jpC = applyBp(bpjsBaseDelta, rules.jp_rate_company_bp);
    const jkmC = applyBp(bpjsBaseDelta, rules.jkm_rate_bp);
    const jkkC = applyBp(bpjsBaseDelta, jkk.rate_bp);
    bpjsEmployerDelta = kesC + jhtC + jpC + jkmC + jkkC;
    add('BPJS_EMPLOYER_DELTA', 'delta bpjs base (frozen rates)', `${bpjsBaseDelta} sen`,
      `incl. JKK ${jkk.rate_bp} bp`, 'delta_base * rate_bp / 10000', bpjsEmployerDelta,
      `jkk_version:${jkk.version_id}`);
  }

  // Tax on the delta: the same TER band the original landed in, applied to the
  // taxable delta. Using the original's band (rather than re-bracketing the
  // delta alone) keeps a retro payment taxed as part of the month it belongs
  // to, not as a standalone tiny income.
  let taxDelta = explicitTaxDelta;
  if (taxableDelta !== 0) {
    const originalBracket = (original.tax && original.tax.bracket) ? original.tax.bracket : null;
    if (originalBracket) {
      const computed = applyBp(taxableDelta, originalBracket.rate_bp);
      taxDelta += computed;
      add('PPH21_DELTA', 'delta taxable at the original TER band', `${taxableDelta} sen`,
        `${originalBracket.rate_bp} bp`, 'delta_taxable * original_ter_rate_bp / 10000', computed,
        `rule_set:${bpjsRule.tax_rule_set_id}:category:${original.tax.ter_category}`);
    }
  }

  const employeeDeductionDelta = deductionDelta + bpjsEmployeeDelta + taxDelta;
  const netDelta = grossDelta - employeeDeductionDelta;

  add('GROSS_DELTA', 'sum of earnings-side adjustments', null, null, 'sum(signed earnings)', grossDelta);
  add('EMPLOYEE_DEDUCTIONS_DELTA', 'deductions + bpjs + tax deltas', null, null,
    'deduction_delta + bpjs_employee_delta + tax_delta', employeeDeductionDelta);
  add('NET_DELTA', 'gross delta minus employee deduction delta', null, null,
    'gross_delta - employee_deductions_delta', netDelta);

  return {
    gross_sen: grossDelta,
    taxable_base_sen: taxableDelta,
    bpjs_base_sen: bpjsBaseDelta,
    bpjs_employee_sen: bpjsEmployeeDelta,
    bpjs_employer_sen: bpjsEmployerDelta,
    tax_sen: taxDelta,
    other_deductions_sen: deductionDelta,
    employee_deductions_sen: employeeDeductionDelta,
    net_sen: netDelta,
    employer_cost_sen: bpjsEmployerDelta,
    adjustment_ids: adjustments.map((a) => a.id),
    trace,
  };
}

/** Full negation of an original line — used by a REVERSAL run. */
function computeReversal(sourceLine) {
  const neg = (v) => (v === null || v === undefined ? null : -Number(v));
  return {
    gross_sen: neg(sourceLine.gross_sen),
    taxable_base_sen: neg(sourceLine.taxable_base_sen),
    bpjs_base_sen: neg(sourceLine.bpjs_base_sen),
    bpjs_employee_sen: neg(sourceLine.bpjs_employee_sen),
    bpjs_employer_sen: neg(sourceLine.bpjs_employer_sen),
    tax_sen: neg(sourceLine.tax_sen),
    other_deductions_sen: neg(sourceLine.other_deductions_sen),
    employee_deductions_sen: neg(sourceLine.employee_deductions_sen),
    net_sen: neg(sourceLine.net_sen),
    employer_cost_sen: neg(sourceLine.employer_cost_sen),
    overtime_sen: neg(sourceLine.overtime_sen),
    adjustment_ids: [],
    trace: [{
      component: 'REVERSAL', basis: `full negation of run line ${sourceLine.id}`,
      quantity: null, rate: null, formula: '-1 * original',
      amount_sen: neg(sourceLine.net_sen), rounding_rule: 'half_up_to_sen',
      rule_version: `reverses_line:${sourceLine.id}`,
    }],
  };
}

/**
 * Write the component breakdown for a correction/reversal line.
 *
 * The rows must sum EXACTLY to the delta totals already stored on the line:
 * earnings-side to gross_sen, deduction-side to employee_deductions_sen.
 * `paid_by` is set explicitly so the payslip renderer puts employer
 * contributions in the employer section rather than deducting them.
 */
async function writeDeltaComponents(db, lineId, delta, adjustments, runType, sourceLine) {
  const insert = db.prepare(`
    INSERT INTO payroll_run_line_components (
      payroll_run_line_id, sequence, component_code, component_group, paid_by,
      basis, quantity, rate, formula, rounding_rule, rule_version,
      source_snapshot_field, amount_sen
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let seq = 0;
  const row = async (code, group, paidBy, basis, amount, extra = {}) => {
    seq += 1;
    await insert.run(lineId, seq, code, group, paidBy, basis,
      extra.quantity ?? null, extra.rate ?? null, extra.formula ?? null,
      'half_up_to_sen', extra.rule_version ?? null, extra.source ?? null, amount);
  };

  if (runType === RUN_TYPE.REVERSAL) {
    // A reversal has no adjustment items: it negates the original totals.
    await row('REVERSAL_EARNINGS', 'earning', 'employee',
      `pembalikan penghasilan run line ${sourceLine.id}`, delta.gross_sen,
      { formula: '-1 * original_gross', rule_version: `reverses_line:${sourceLine.id}` });
    if (delta.employee_deductions_sen !== 0) {
      await row('REVERSAL_DEDUCTIONS', 'deduction', 'employee',
        `pembalikan potongan run line ${sourceLine.id}`, delta.employee_deductions_sen,
        { formula: '-1 * original_employee_deductions', rule_version: `reverses_line:${sourceLine.id}` });
    }
    if (delta.bpjs_employer_sen !== 0) {
      await row('REVERSAL_EMPLOYER', 'bpjs', 'employer',
        `pembalikan kontribusi perusahaan run line ${sourceLine.id}`, delta.bpjs_employer_sen,
        { formula: '-1 * original_employer', rule_version: `reverses_line:${sourceLine.id}` });
    }
  } else {
    // One row per adjustment, on the correct side.
    for (const a of adjustments) {
      if (a.adjustment_type === TYPE.TAX_CORRECTION || a.adjustment_type === TYPE.BPJS_CORRECTION) continue;
      const isDeduction = a.adjustment_type === TYPE.RETRO_DEDUCTION;
      // Deduction rows carry the DEDUCTION-side value, so the section sums to
      // employee_deductions_sen; earnings rows carry the employee-facing sign.
      const shown = isDeduction ? deductionSide(a) : signedAmount(a);
      await row(a.component_code, isDeduction ? 'deduction' : 'earning', 'employee',
        `${a.adjustment_type} (${a.direction})`, shown, {
          quantity: a.overtime_minutes ? `${a.overtime_minutes} menit` : null,
          formula: 'adjustment amount',
          rule_version: `adjustment:${a.id}`,
          source: 'payroll_adjustments',
        });
    }
    // Statutory deltas, split by who bears them.
    const explicitTax = adjustments.filter((a) => a.adjustment_type === TYPE.TAX_CORRECTION)
      .reduce((t, a) => t + deductionSide(a), 0);
    const explicitBpjs = adjustments.filter((a) => a.adjustment_type === TYPE.BPJS_CORRECTION)
      .reduce((t, a) => t + deductionSide(a), 0);

    if (delta.bpjs_employee_sen !== 0) {
      await row('BPJS_EMPLOYEE_DELTA', 'bpjs', 'employee', 'selisih iuran BPJS karyawan (tarif beku)',
        delta.bpjs_employee_sen, {
          formula: explicitBpjs ? 'delta_base * frozen_rates + koreksi eksplisit' : 'delta_base * frozen_rates',
          rule_version: `rule_set:${sourceLine.payroll_rule_set_id}`,
        });
    }
    if (delta.tax_sen !== 0) {
      await row('PPH21_DELTA', 'tax', 'employee', 'selisih PPh21 pada band TER asal', delta.tax_sen, {
        formula: explicitTax ? 'delta_taxable * original_ter + koreksi eksplisit' : 'delta_taxable * original_ter',
        rule_version: `rule_set:${sourceLine.payroll_rule_set_id}:category:${sourceLine.ter_category}`,
      });
    }
    if (delta.bpjs_employer_sen !== 0) {
      await row('BPJS_EMPLOYER_DELTA', 'bpjs', 'employer', 'selisih kontribusi perusahaan (tarif beku)',
        delta.bpjs_employer_sen, {
          formula: 'delta_base * frozen_rates',
          rule_version: `jkk_version:${sourceLine.jkk_rate_version_id}`,
        });
    }
  }

  // Totals, for explainability. Group 'total' keeps them out of the payslip's
  // line items, exactly as for an original run.
  await row('GROSS_DELTA', 'total', null, 'selisih bruto', delta.gross_sen, { formula: 'sum(earnings delta)' });
  await row('EMPLOYEE_DEDUCTIONS_DELTA', 'total', null, 'selisih potongan karyawan',
    delta.employee_deductions_sen, { formula: 'deduction + bpjs + tax delta' });
  await row('NET_DELTA', 'total', null, 'selisih gaji bersih', delta.net_sen,
    { formula: 'gross_delta - employee_deductions_delta' });
}

function hashDelta(delta) {
  return crypto.createHash('sha256').update(stableStringify(delta)).digest('hex');
}

/**
 * Materialise a CORRECTION run's lines from approved adjustments, or a
 * REVERSAL run's lines from the original. Caller supplies the transaction.
 *
 * Idempotent: an employee who already has a line in this run is skipped, and
 * an adjustment already APPLIED is never applied twice.
 */
async function applyToRun(db, run, userContext) {
  if (run.run_type === RUN_TYPE.ORIGINAL) {
    throw new AdjustmentError(ERROR.INVALID_STATE, 'Run ORIGINAL tidak menerima penyesuaian.');
  }
  const source = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(run.corrects_run_id);
  if (!source || source.status !== 'FINALIZED') {
    throw new AdjustmentError(ERROR.SOURCE_NOT_FINALIZED, 'Run yang dikoreksi harus FINALIZED.');
  }
  if (source.legal_entity_id !== run.legal_entity_id) {
    throw new AdjustmentError(ERROR.ENTITY_MISMATCH, 'Legal entity run koreksi berbeda dengan run asal.');
  }

  const summary = { lines: 0, adjustments_applied: 0, skipped: 0, net_delta_sen: 0, employees: [] };

  const insertLine = db.prepare(`
    INSERT INTO payroll_run_lines (
      payroll_run_id, snapshot_id, employee_id, legal_entity_id, calc_status,
      gross_sen, taxable_base_sen, bpjs_base_sen, overtime_sen,
      bpjs_employee_sen, bpjs_employer_sen, tax_sen, other_deductions_sen,
      employee_deductions_sen, net_sen, employer_cost_sen,
      payroll_rule_set_id, jkk_rate_version_id, ter_category,
      result_payload, result_hash, snapshot_hash, calculated_at
    ) VALUES (?,?,?,?,'OK',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,kahe_now()) RETURNING id
  `);

  const targets = run.run_type === RUN_TYPE.REVERSAL
    ? await db.prepare('SELECT * FROM payroll_run_lines WHERE payroll_run_id = ? ORDER BY employee_id').all(source.id)
    : await db.prepare(`
        SELECT DISTINCT l.* FROM payroll_run_lines l
        JOIN payroll_adjustments a ON a.employee_id = l.employee_id AND a.source_run_id = l.payroll_run_id
        WHERE l.payroll_run_id = ? AND a.status = 'APPROVED'
        ORDER BY l.employee_id
      `).all(source.id);

  if (targets.length === 0) {
    throw new AdjustmentError(ERROR.NOTHING_TO_APPLY,
      run.run_type === RUN_TYPE.REVERSAL
        ? 'Run asal tidak memiliki baris untuk dibalik.'
        : 'Tidak ada penyesuaian berstatus APPROVED untuk diterapkan.');
  }

  for (const sourceLine of targets) {
    const already = await db.prepare('SELECT id FROM payroll_run_lines WHERE payroll_run_id = ? AND employee_id = ?')
      .get(run.id, sourceLine.employee_id);
    if (already) { summary.skipped += 1; continue; }

    let delta;
    let adjustments = [];
    if (run.run_type === RUN_TYPE.REVERSAL) {
      delta = computeReversal(sourceLine);
    } else {
      adjustments = await db.prepare(`
        SELECT * FROM payroll_adjustments
        WHERE source_run_id = ? AND employee_id = ? AND status = 'APPROVED'
        ORDER BY id ASC
      `).all(source.id, sourceLine.employee_id);
      if (adjustments.length === 0) { summary.skipped += 1; continue; }
      delta = await computeDelta(db, sourceLine, adjustments);
    }

    const payload = {
      run_type: run.run_type,
      corrects_run_id: source.id,
      corrects_line_id: sourceLine.id,
      employee_id: sourceLine.employee_id,
      delta,
      rule_versions: {
        payroll_rule_set_id: sourceLine.payroll_rule_set_id,
        jkk_rate_version_id: sourceLine.jkk_rate_version_id,
        ter_category: sourceLine.ter_category,
        inherited_from_line: sourceLine.id,
      },
      trace: delta.trace,
      // Not a fresh calculation: these figures are DELTAS against the original.
      is_delta: true,
    };

    const info = await insertLine.run(
      run.id, sourceLine.snapshot_id, sourceLine.employee_id, sourceLine.legal_entity_id,
      delta.gross_sen, delta.taxable_base_sen, delta.bpjs_base_sen, delta.overtime_sen ?? null,
      delta.bpjs_employee_sen, delta.bpjs_employer_sen, delta.tax_sen, delta.other_deductions_sen,
      delta.employee_deductions_sen, delta.net_sen, delta.employer_cost_sen,
      sourceLine.payroll_rule_set_id, sourceLine.jkk_rate_version_id, sourceLine.ter_category,
      JSON.stringify(payload), hashDelta(payload), sourceLine.snapshot_hash
    );

    // A correction line needs its own COMPONENT BREAKDOWN, or a correction
    // payslip would have nothing to render and would fail the Phase 2F
    // reconciliation precondition. The rows below sum exactly to the delta
    // totals stored on the line.
    await writeDeltaComponents(db, info.lastInsertRowid, delta, adjustments, run.run_type, sourceLine);

    // Mark the adjustments applied, pinned to this run. The unique constraint
    // on the run line plus this status flip make double application impossible.
    for (const a of adjustments) {
      await db.prepare(`UPDATE payroll_adjustments SET status='APPLIED', applied_to_run_id=?, applied_at=kahe_now() WHERE id=?`)
        .run(run.id, a.id);
      summary.adjustments_applied += 1;
    }

    summary.lines += 1;
    summary.net_delta_sen += delta.net_sen;
    summary.employees.push({ employee_id: sourceLine.employee_id, line_id: info.lastInsertRowid, net_delta_sen: delta.net_sen });
  }

  if (summary.lines === 0) {
    throw new AdjustmentError(ERROR.NOTHING_TO_APPLY, 'Tidak ada baris koreksi yang dibuat.');
  }
  return summary;
}

/**
 * Reconciliation for a period: the ORIGINAL plus every finalized correction
 * and reversal. This is the authoritative "what is actually owed" figure.
 */
async function reconcilePeriod(db, payrollPeriodId) {
  const runs = await db.prepare(`
    SELECT r.id, r.run_number, r.run_type, r.status, r.corrects_run_id,
           COUNT(l.id) AS lines,
           COALESCE(SUM(l.gross_sen),0) AS gross_sen,
           COALESCE(SUM(l.employee_deductions_sen),0) AS employee_deductions_sen,
           COALESCE(SUM(l.net_sen),0) AS net_sen,
           COALESCE(SUM(l.employer_cost_sen),0) AS employer_cost_sen
    FROM payroll_runs r LEFT JOIN payroll_run_lines l ON l.payroll_run_id = r.id
    WHERE r.payroll_period_id = ?
    GROUP BY r.id ORDER BY r.run_number
  `).all(payrollPeriodId);

  const finalized = runs.filter((r) => r.status === 'FINALIZED');
  const totals = finalized.reduce((t, r) => ({
    gross_sen: t.gross_sen + r.gross_sen,
    employee_deductions_sen: t.employee_deductions_sen + r.employee_deductions_sen,
    net_sen: t.net_sen + r.net_sen,
    employer_cost_sen: t.employer_cost_sen + r.employer_cost_sen,
  }), { gross_sen: 0, employee_deductions_sen: 0, net_sen: 0, employer_cost_sen: 0 });

  return {
    payroll_period_id: payrollPeriodId,
    runs,
    finalized_run_count: finalized.length,
    effective_totals: totals,
    // Integer arithmetic, so this holds exactly.
    reconciles: totals.gross_sen - totals.employee_deductions_sen === totals.net_sen,
  };
}

/** Per-employee reconciliation across every finalized run in a period. */
async function reconcileEmployee(db, payrollPeriodId, employeeId) {
  const rows = await db.prepare(`
    SELECT r.run_number, r.run_type, l.gross_sen, l.employee_deductions_sen, l.net_sen, l.employer_cost_sen
    FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id
    WHERE r.payroll_period_id = ? AND l.employee_id = ? AND r.status = 'FINALIZED'
    ORDER BY r.run_number
  `).all(payrollPeriodId, employeeId);

  const totals = rows.reduce((t, r) => ({
    gross_sen: t.gross_sen + r.gross_sen,
    employee_deductions_sen: t.employee_deductions_sen + r.employee_deductions_sen,
    net_sen: t.net_sen + r.net_sen,
    employer_cost_sen: t.employer_cost_sen + r.employer_cost_sen,
  }), { gross_sen: 0, employee_deductions_sen: 0, net_sen: 0, employer_cost_sen: 0 });

  return { employee_id: employeeId, runs: rows, effective_totals: totals };
}

module.exports = {
  STATUS, DIRECTION, TYPE, RUN_TYPE, ERROR, AdjustmentError, writeDeltaComponents,
  signedAmount, deductionSide, createAdjustment, approveAdjustment, voidAdjustment,
  computeDelta, computeReversal, applyToRun, reconcilePeriod, reconcileEmployee,
  priceLateOvertime, hashDelta,
};
