// lib/billingCalculator.js
// Phase 3B — draft billing calculation.
//
// ============================================================
// LOCKS
// ============================================================
// * Produces a DRAFT BILLING STATEMENT, never an invoice.
// * NEVER recalculates or mutates payroll. It may READ finalized payroll when
//   a PAYROLL_COST rate card explicitly configures a billable basis. A test
//   greps this file for writes to any payroll table.
// * Integer sen throughout. No floating-point money.
// * A missing rate is reported as NOT_CONFIGURED and SKIPPED. No fake Rp0 row
//   is ever produced to represent an unconfigured price.
// * Fixed and package models price the period; they never require a quantity.
// * Every line records enough to answer: what, why billable, how much, from
//   where, verified by whom, at which rate version, under which configuration
//   version, for which client and entity.

const money = require('./money');
const addonLib = require('./workerServiceAddon');
const rateLib = require('./billingRate');
const qtyLib = require('./billingQuantity');

const ENGINE_VERSION = 'billing-calc-3b.1';

const SKIP_REASON = {
  NOT_CONFIGURED: 'ADDON_NOT_CONFIGURED',
  NOT_PROVIDED: 'ADDON_NOT_PROVIDED',
  NOT_BILLABLE: 'NOT_BILLABLE',
  CONDITIONAL_UNMET: 'CONDITIONAL_NOT_MET',
  NO_RATE_CARD: 'NO_RATE_CARD',
  RATE_NOT_CONFIGURED: 'RATE_NOT_CONFIGURED',
  NO_VERIFIED_QUANTITY: 'NO_VERIFIED_QUANTITY',
  ZERO_QUANTITY: 'ZERO_QUANTITY',
  MEAL_NOT_ENABLED: 'MEAL_NOT_ENABLED',
  NO_FINALIZED_PAYROLL: 'NO_FINALIZED_PAYROLL',
};

const ERROR = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_CALCULATED: 'ALREADY_CALCULATED',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
};

class BillingError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.name = 'BillingError'; this.code = code; this.detail = detail;
  }
}

/** Last day of a 'YYYY-MM' period — the as-of date for resolving configuration. */
function periodEnd(billingPeriod) {
  const [y, m] = billingPeriod.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function createRun(db, { legalEntityId, clientId, projectId = null, billingPeriod }, userContext) {
  if (!legalEntityId || !clientId || !billingPeriod) {
    throw new BillingError(ERROR.VALIDATION, 'legal_entity_id, client_id dan billing_period wajib diisi.');
  }
  if (!/^\d{4}-\d{2}$/.test(billingPeriod)) {
    throw new BillingError(ERROR.VALIDATION, 'billing_period harus dalam format YYYY-MM.');
  }
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new BillingError(ERROR.NOT_FOUND, 'Klien tidak ditemukan.');
  if (client.legal_entity_id && client.legal_entity_id !== legalEntityId) {
    throw new BillingError(ERROR.ENTITY_MISMATCH,
      `Klien ${client.code} milik entity ${client.legal_entity_id}, bukan ${legalEntityId}.`);
  }

  const prior = await db.prepare(`SELECT MAX(run_number) AS n FROM billing_runs
    WHERE legal_entity_id = ? AND client_id = ? AND billing_period = ?`)
    .get(legalEntityId, clientId, billingPeriod);
  const runNumber = Number(prior.n || 0) + 1;
  const ref = `BR-${legalEntityId}-${client.code}-${billingPeriod}-R${runNumber}`;

  const info = await db.prepare(`
    INSERT INTO billing_runs (run_reference, legal_entity_id, client_id, project_id,
      billing_period, run_number, status, created_by, created_at)
    VALUES (?,?,?,?,?,?, 'DRAFT', ?, kahe_now()) RETURNING id
  `).run(ref, legalEntityId, clientId, projectId, billingPeriod, runNumber, userContext.displayName);
  return await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Calculate a draft statement.
 *
 * The shape is always:
 *   BILLABLE ITEM x VERIFIED QUANTITY x EFFECTIVE RATE = LINE AMOUNT
 * except for the models that price the period, where it is simply the rate.
 */
async function calculateRun(db, run, userContext) {
  if (run.status === 'CALCULATED') {
    throw new BillingError(ERROR.ALREADY_CALCULATED,
      'Run ini sudah dihitung dan dibekukan. Buat run baru untuk perhitungan ulang.');
  }
  const asOf = periodEnd(run.billing_period);
  const scope = {
    legalEntityId: run.legal_entity_id,
    clientId: run.client_id,
    projectId: run.project_id,
    asOf,
  };

  const lines = [];
  const skipped = [];
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const push = (line) => lines.push({ ...line, calculation_timestamp: stamp });
  const skip = (addonType, reason, detail = {}) =>
    skipped.push({ addon_type: addonType, reason, ...detail });

  // ---- 1. the three add-on categories --------------------------------------
  for (const addonType of ['MEALS', 'TRANSPORT', 'ACCOMMODATION']) {
    const resolved = await addonLib.resolveAddon(db, { ...scope, addonType });

    if (!resolved) { skip(addonType, SKIP_REASON.NOT_CONFIGURED); continue; }
    const nature = addonLib.natureOf(resolved);
    if (nature === addonLib.NATURE.NOT_PROVIDED) {
      skip(addonType, SKIP_REASON.NOT_PROVIDED, { delivery_mode: resolved.delivery_mode });
      continue;
    }

    const billableMode = resolved.client_billable_mode
      || (Number(resolved.client_billable) === 1 ? 'YES' : 'NO');
    if (billableMode === 'NO' || resolved.billing_treatment === 'NON_BILLABLE') {
      // Rule: KAHE may still bear a real cost the client will not reimburse.
      // That is recorded as a skip with its bearer, not hidden.
      skip(addonType, SKIP_REASON.NOT_BILLABLE, {
        delivery_mode: resolved.delivery_mode, cost_bearer: resolved.cost_bearer, nature,
      });
      continue;
    }
    if (billableMode === 'CONDITIONAL') {
      skip(addonType, SKIP_REASON.CONDITIONAL_UNMET, {
        delivery_mode: resolved.delivery_mode,
        condition: resolved.billable_condition,
        note: 'Ditagihkan hanya bila syaratnya terpenuhi dan dikonfirmasi; tidak dihitung otomatis.',
      });
      continue;
    }

    if (addonType === 'MEALS') {
      await calculateMeals(db, run, scope, resolved, push, skip);
    } else {
      const rate = await rateLib.resolveRate(db, { ...scope, addonType });
      await calculateSimple(db, run, scope, resolved, rate, addonType, null, push, skip);
    }
  }

  // ---- 2. payroll-derived cost, only when explicitly configured -------------
  const payrollRate = await rateLib.resolveRate(db, { ...scope, addonType: 'PAYROLL_COST' });
  if (payrollRate) {
    await calculatePayrollCost(db, run, scope, payrollRate, push, skip);
  }

  // ---- 3. service fee, only when configured ---------------------------------
  const feeRate = await rateLib.resolveRate(db, { ...scope, addonType: 'SERVICE_FEE' });
  const subtotal = lines.reduce((t, l) => t + l.amount_sen, 0);
  if (!feeRate || feeRate.rate_status !== 'CONFIGURED') {
    // NOT_CONFIGURED is a legitimate state. No amount, and no fake Rp0 row.
    skip('SERVICE_FEE', feeRate ? SKIP_REASON.RATE_NOT_CONFIGURED : SKIP_REASON.NO_RATE_CARD, {
      note: 'Service fee belum dikonfigurasi. Tidak dihitung, dan tidak dibuatkan baris Rp0.',
    });
  } else {
    const amount = feeRate.pricing_model === 'PERCENTAGE'
      ? money.applyBp(subtotal, feeRate.rate_sen)   // rate_sen holds basis points for PERCENTAGE
      : feeRate.rate_sen;
    push({
      source_type: 'SERVICE_FEE', addon_type: 'SERVICE_FEE',
      pricing_model: feeRate.pricing_model, quantity_source: null, quantity: null,
      unit_of_measure: feeRate.unit_of_measure,
      effective_rate_sen: feeRate.rate_sen, amount_sen: amount,
      cost_bearer: 'CLIENT', billing_treatment: 'SEPARATE',
      rate_card_id: feeRate.id, rate_version: feeRate.version,
      calculation_note: feeRate.pricing_model === 'PERCENTAGE'
        ? `${feeRate.rate_sen} bp dari subtotal ${subtotal}` : 'tarif tetap',
    });
  }

  return { lines, skipped, asOf, engine_version: ENGINE_VERSION };
}

/**
 * Meals: one line per ENABLED meal type, each with its own rate and its own
 * verified consumption. Attendance is never substituted for consumption.
 */
async function calculateMeals(db, run, scope, addonRow, push, skip) {
  const plan = await rateLib.resolveMealPlan(db, scope);
  const planned = Object.values(plan);

  if (planned.length === 0) {
    skip('MEALS', SKIP_REASON.NOT_CONFIGURED, { note: 'Tidak ada rencana makan yang berlaku.' });
    return;
  }

  for (const item of planned) {
    if (Number(item.enabled) !== 1) {
      skip('MEALS', SKIP_REASON.MEAL_NOT_ENABLED, { meal_type: item.meal_type });
      continue;
    }
    const rate = await rateLib.resolveRate(db, { ...scope, addonType: 'MEALS', mealType: item.meal_type });
    await calculateSimple(db, run, scope, addonRow, rate, 'MEALS', item.meal_type, push, skip, {
      meal_plan_version: item.version, max_per_worker_per_day: item.max_per_worker_per_day,
    });
  }
}

/**
 * One billable line. Handles both quantity-driven and period-priced models.
 */
async function calculateSimple(db, run, scope, addonRow, rate, addonType, mealType, push, skip, extra = {}) {
  const label = mealType ? `${addonType}/${mealType}` : addonType;

  if (!rate) {
    skip(addonType, SKIP_REASON.NO_RATE_CARD, { meal_type: mealType,
      note: `Belum ada kartu tarif untuk ${label}.` });
    return;
  }
  if (rate.rate_status !== 'CONFIGURED' || rate.rate_sen === null) {
    // A rate card may exist with no price. Report it; never guess a number.
    skip(addonType, SKIP_REASON.RATE_NOT_CONFIGURED, { meal_type: mealType,
      rate_card_id: rate.id, pricing_model: rate.pricing_model,
      note: `Tarif ${label} belum diisi (NOT_CONFIGURED). Tidak dihitung.` });
    return;
  }

  const base = {
    source_type: 'ADDON',
    addon_type: addonType,
    meal_type: mealType,
    delivery_mode: addonRow.delivery_mode,
    pricing_model: rate.pricing_model,
    unit_of_measure: rate.unit_of_measure,
    effective_rate_sen: rate.rate_sen,
    cost_bearer: addonRow.cost_bearer,
    billing_treatment: addonRow.billing_treatment,
    addon_config_id: addonRow.id,
    addon_config_version: addonRow.version,
    rate_card_id: rate.id,
    rate_version: rate.version,
    ...extra,
  };

  // Period-priced models: the rate IS the amount. No quantity is invented.
  if (!rateLib.usesQuantity(rate.pricing_model)) {
    push({
      ...base,
      quantity_source: null, quantity: null,
      amount_sen: rate.rate_sen,
      source_reference: `${rate.pricing_model} ${run.billing_period}`,
      calculation_note: `${rate.pricing_model}: harga periode, bukan per kuantitas`,
    });
    return;
  }

  // Quantity-driven: only VERIFIED quantities from the configured source.
  const rows = (await qtyLib.getBillableQuantities(db, {
    legalEntityId: scope.legalEntityId, clientId: scope.clientId, projectId: scope.projectId,
    billingPeriod: run.billing_period, addonType, mealType,
  })).filter((r) => r.quantity_source === rate.quantity_source);

  if (rows.length === 0) {
    skip(addonType, SKIP_REASON.NO_VERIFIED_QUANTITY, { meal_type: mealType,
      expected_source: rate.quantity_source,
      note: `Tidak ada kuantitas terverifikasi bersumber ${rate.quantity_source} untuk ${label}.` });
    return;
  }

  const summed = qtyLib.sumQuantities(rows);
  if (summed.quantity === 0) {
    // Zero is legitimate — the service ran, nobody used it. It is reported,
    // not billed, and not turned into a Rp0 line.
    skip(addonType, SKIP_REASON.ZERO_QUANTITY, { meal_type: mealType,
      quantity_ids: summed.ids, note: 'Kuantitas terverifikasi nol; tidak ada yang ditagihkan.' });
    return;
  }

  push({
    ...base,
    quantity_source: rate.quantity_source,
    quantity: summed.quantity,
    unit_of_measure: summed.unit || rate.unit_of_measure,
    amount_sen: rate.rate_sen * summed.quantity,   // integer x integer
    quantity_ids: summed.ids,
    verified_by: summed.verifiers.join(', ') || null,
    source_reference: rows.map((r) => r.source_reference).filter(Boolean).slice(0, 5).join('; ') || null,
    calculation_note: `${summed.quantity} ${summed.unit || rate.unit_of_measure} x ${rate.rate_sen} sen`,
  });
}

/**
 * Payroll-derived cost. READS finalized payroll only — never recalculates,
 * never writes. Only the basis a rate card explicitly configures is billed.
 */
async function calculatePayrollCost(db, run, scope, rate, push, skip) {
  const COLUMN = {
    BASIC_SALARY: 'gross_sen',           // no separate basic column is persisted; documented below
    GROSS_EARNINGS: 'gross_sen',
    OVERTIME: 'overtime_sen',
    EMPLOYER_BPJS: 'bpjs_employer_sen',
    EMPLOYER_COST_TOTAL: 'employer_cost_sen',
    NET_PAY: 'net_sen',
  };
  const col = COLUMN[rate.payroll_basis];
  if (!col) {
    skip('PAYROLL_COST', SKIP_REASON.RATE_NOT_CONFIGURED, {
      note: `payroll_basis ${rate.payroll_basis} belum didukung sebagai kolom payroll final.` });
    return;
  }
  if (rate.rate_status !== 'CONFIGURED' && rate.pricing_model !== 'PASS_THROUGH') {
    skip('PAYROLL_COST', SKIP_REASON.RATE_NOT_CONFIGURED, { rate_card_id: rate.id });
    return;
  }

  // Finalized runs only, matched to the billing period by the payroll period.
  const row = await db.prepare(`
    SELECT COALESCE(SUM(l.${col}),0) AS total, COUNT(*) AS lines
    FROM payroll_run_lines l
    JOIN payroll_runs r ON r.id = l.payroll_run_id
    JOIN payroll_periods p ON p.id = r.payroll_period_id
    WHERE r.status = 'FINALIZED' AND l.calc_status = 'OK'
      AND r.legal_entity_id = ?
      AND to_char(p.period_start, 'YYYY-MM') = ?
  `).get(scope.legalEntityId, run.billing_period);

  if (!row.lines) {
    skip('PAYROLL_COST', SKIP_REASON.NO_FINALIZED_PAYROLL, {
      note: `Tidak ada payroll FINALIZED untuk ${run.billing_period}.` });
    return;
  }

  const base = Number(row.total);
  const amount = rate.pricing_model === 'PERCENTAGE_MARKUP'
    ? base + money.applyBp(base, rate.rate_sen)
    : base;

  push({
    source_type: 'PAYROLL_COST',
    addon_type: 'PAYROLL_COST',
    pricing_model: rate.pricing_model,
    quantity_source: null, quantity: null, unit_of_measure: 'UNIT',
    effective_rate_sen: rate.rate_sen,
    amount_sen: amount,
    cost_bearer: 'CLIENT', billing_treatment: 'SEPARATE',
    rate_card_id: rate.id, rate_version: rate.version,
    source_reference: `FINALIZED_PAYROLL:${rate.payroll_basis}:${run.billing_period}`,
    calculation_note: `${rate.payroll_basis} dari ${row.lines} baris payroll final`
      + (rate.pricing_model === 'PERCENTAGE_MARKUP' ? ` + markup ${rate.rate_sen} bp` : ' (pass-through)'),
  });
}

/**
 * Persist the calculation and FREEZE the run. Later rate or configuration
 * changes cannot alter a statement that has already been produced.
 */
async function persistRun(db, run, result, userContext) {
  const insert = db.prepare(`
    INSERT INTO billing_lines (billing_run_id, legal_entity_id, client_id, project_id, billing_period,
      source_type, source_reference, addon_type, meal_type, delivery_mode, pricing_model,
      quantity_source, quantity, unit_of_measure, effective_rate_sen, amount_sen,
      cost_bearer, billing_treatment, addon_config_version, addon_config_id,
      rate_version, rate_card_id, quantity_ids, verified_by, calculation_note, calculation_timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let total = 0;
  for (const l of result.lines) {
    await insert.run(run.id, run.legal_entity_id, run.client_id, run.project_id, run.billing_period,
      l.source_type, l.source_reference ?? null, l.addon_type, l.meal_type ?? null,
      l.delivery_mode ?? null, l.pricing_model, l.quantity_source ?? null,
      l.quantity ?? null, l.unit_of_measure ?? null, l.effective_rate_sen ?? null, l.amount_sen,
      l.cost_bearer, l.billing_treatment, l.addon_config_version ?? null, l.addon_config_id ?? null,
      l.rate_version ?? null, l.rate_card_id ?? null,
      l.quantity_ids ? JSON.stringify(l.quantity_ids) : null,
      l.verified_by ?? null, l.calculation_note ?? null, l.calculation_timestamp);
    total += l.amount_sen;

    // Mark the quantities consumed, so a second run cannot double-bill them.
    for (const qid of (l.quantity_ids || [])) {
      await db.prepare('UPDATE billing_quantities SET billed_in_run_id = ? WHERE id = ?').run(run.id, qid);
    }
  }

  await db.prepare(`UPDATE billing_runs SET status='CALCULATED', total_amount_sen=?, line_count=?,
              calculation_timestamp=kahe_now(), engine_version=? WHERE id=?`)
    .run(total, result.lines.length, ENGINE_VERSION, run.id);

  return {
    run: await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(run.id),
    total_amount_sen: total,
    line_count: result.lines.length,
    skipped: result.skipped,
  };
}

/** Everything needed to explain a statement, for reproducibility. */
async function explainRun(db, runId) {
  const run = await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(runId);
  if (!run) throw new BillingError(ERROR.NOT_FOUND, 'Billing run tidak ditemukan.');
  const lines = (await db.prepare('SELECT * FROM billing_lines WHERE billing_run_id = ? ORDER BY id').all(runId))
    .map((l) => ({ ...l, quantity_ids: l.quantity_ids ? JSON.parse(l.quantity_ids) : null }));
  return {
    run,
    lines,
    reconciles: lines.reduce((t, l) => t + l.amount_sen, 0) === run.total_amount_sen,
    is_invoice: false,
    note: 'Ini perhitungan tagihan DRAFT, bukan faktur. Penerbitan faktur adalah fase terpisah.',
  };
}

module.exports = {
  ENGINE_VERSION, SKIP_REASON, ERROR, BillingError,
  periodEnd, createRun, calculateRun, persistRun, explainRun,
  calculateMeals, calculateSimple, calculatePayrollCost,
};
