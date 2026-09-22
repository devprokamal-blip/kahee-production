// lib/billingRate.js
// Phase 3B — commercial rate cards and meal plans.
//
// ============================================================
// LOCKS
// ============================================================
// * NOTHING is hardcoded: no meal price, no meal count, no transport price,
//   no trip count, no bed-night rate, no service fee percentage.
// * A rate may legitimately be NOT_CONFIGURED with rate_sen NULL. Billing must
//   report that and skip the line, never invent a number or a fake Rp0 row.
// * Not every pricing model uses quantity x rate. FIXED_MONTHLY and PACKAGE
//   price the period, not a count — they must never be forced to invent a
//   quantity.
// * Rates are versioned and effective-dated. June forever resolves June's
//   rate; a July price change closes June's version, it does not overwrite it.
//
// This module never reads or writes payroll.

const money = require('./money');

const RATE_ADDON_TYPES = ['TRANSPORT', 'MEALS', 'ACCOMMODATION', 'PAYROLL_COST', 'SERVICE_FEE'];

const MEAL_TYPES = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK', 'SHIFT_MEAL',
  'EXTRA_MEAL', 'RAMADAN_MEAL', 'CUSTOM'];

/** Quantity sources. Attendance is one option among many — never the default. */
const QUANTITY_SOURCE = ['FIXED_MONTHLY', 'PER_WORKER', 'WORKER_COUNT', 'ATTENDANCE_DAY',
  'SERVICE_DAY', 'MEAL_CONSUMPTION', 'BED_NIGHT', 'TRANSPORT_TRIP', 'VEHICLE_DAY',
  'ROUTE_TRIP', 'SHIFT_TRIP', 'MANUAL_APPROVED_QUANTITY', 'EXTERNAL_SOURCE', 'CUSTOM',
  'NOT_APPLICABLE'];

const UNIT_OF_MEASURE = ['WORKER', 'DAY', 'MEAL', 'PORTION', 'BED_NIGHT', 'ROOM_NIGHT',
  'TRIP', 'VEHICLE_DAY', 'MONTH', 'UNIT', 'CUSTOM'];

const PRICING_MODELS = {
  MEALS: ['PER_MEAL', 'PER_PORTION', 'PER_WORKER_DAY', 'PACKAGE', 'FIXED_MONTHLY', 'CUSTOM'],
  TRANSPORT: ['PER_TRIP', 'PER_SERVICE_DAY', 'PER_WORKER', 'PER_WORKER_DAY', 'PER_WORKER_MONTH',
    'PER_VEHICLE', 'PER_VEHICLE_DAY', 'PER_ROUTE', 'PER_SHIFT', 'FIXED_MONTHLY', 'PACKAGE', 'CUSTOM'],
  ACCOMMODATION: ['BED_NIGHT', 'ROOM_NIGHT', 'PER_WORKER', 'PER_WORKER_DAY', 'PER_WORKER_MONTH',
    'UNIT', 'FIXED_MONTHLY', 'PACKAGE', 'CUSTOM'],
  PAYROLL_COST: ['PASS_THROUGH', 'PERCENTAGE_MARKUP', 'CUSTOM'],
  SERVICE_FEE: ['PERCENTAGE', 'FIXED_PER_WORKER', 'FIXED_PER_MONTH', 'ALL_IN', 'CUSTOM'],
};

/**
 * Models that price something OTHER than a counted quantity — a period, a
 * package, or a base amount. Billing must not demand a quantity for these,
 * and must never fabricate one.
 *
 * PERCENTAGE and PERCENTAGE_MARKUP belong here: they price a SUBTOTAL, not a
 * count of units. (Found while wiring the service fee: requiring a quantity
 * source for a percentage fee is meaningless.)
 * FIXED_PER_WORKER is deliberately NOT here — it genuinely multiplies by a
 * worker count, so it needs a quantity source like any other.
 */
const QUANTITYLESS_MODELS = new Set(['FIXED_MONTHLY', 'PACKAGE', 'ALL_IN', 'PASS_THROUGH',
  'PERCENTAGE', 'PERCENTAGE_MARKUP', 'FIXED_PER_MONTH']);

/** Which finalized payroll figures may be configured as a billable basis. */
const PAYROLL_BASES = ['BASIC_SALARY', 'GROSS_EARNINGS', 'OVERTIME', 'EMPLOYER_BPJS',
  'EMPLOYER_COST_TOTAL', 'NET_PAY', 'SELECTED_COMPONENTS'];

const STATUS = { DRAFT: 'DRAFT', ACTIVE: 'ACTIVE', SUPERSEDED: 'SUPERSEDED', CANCELLED: 'CANCELLED' };

const ERROR = {
  VALIDATION: 'VALIDATION',
  INVALID_PRICING_MODEL: 'INVALID_PRICING_MODEL',
  INVALID_QUANTITY_SOURCE: 'INVALID_QUANTITY_SOURCE',
  QUANTITY_ON_FIXED_MODEL: 'QUANTITY_ON_FIXED_MODEL',
  MISSING_QUANTITY_SOURCE: 'MISSING_QUANTITY_SOURCE',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  OVERLAPPING_VERSION: 'OVERLAPPING_VERSION',
  SOD_VIOLATION: 'SOD_VIOLATION',
};

class RateError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.name = 'RateError'; this.code = code; this.detail = detail;
  }
}

const usesQuantity = (pricingModel) => !QUANTITYLESS_MODELS.has(pricingModel);

function validateRate(input) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!RATE_ADDON_TYPES.includes(input.addon_type)) {
    throw new RateError(ERROR.VALIDATION, `addon_type tidak dikenal: ${input.addon_type}`);
  }
  const models = PRICING_MODELS[input.addon_type];
  if (!models.includes(input.pricing_model)) {
    add(ERROR.INVALID_PRICING_MODEL,
      `pricing_model ${input.pricing_model} tidak berlaku untuk ${input.addon_type}. Yang berlaku: ${models.join(', ')}`);
  }
  if (input.addon_type === 'MEALS') {
    if (!input.meal_type) add(ERROR.VALIDATION, 'meal_type wajib diisi untuk tarif MEALS.');
    else if (!MEAL_TYPES.includes(input.meal_type)) add(ERROR.VALIDATION, `meal_type tidak dikenal: ${input.meal_type}`);
  } else if (input.meal_type) {
    add(ERROR.VALIDATION, 'meal_type hanya berlaku untuk MEALS.');
  }
  if (input.addon_type === 'PAYROLL_COST') {
    if (!input.payroll_basis) add(ERROR.VALIDATION, 'payroll_basis wajib diisi untuk PAYROLL_COST.');
    else if (!PAYROLL_BASES.includes(input.payroll_basis)) {
      add(ERROR.VALIDATION, `payroll_basis tidak dikenal: ${input.payroll_basis}`);
    }
  }

  const qs = input.quantity_source || 'NOT_APPLICABLE';
  if (!QUANTITY_SOURCE.includes(qs)) add(ERROR.INVALID_QUANTITY_SOURCE, `quantity_source tidak dikenal: ${qs}`);

  // The rule that keeps fixed pricing honest in both directions.
  if (usesQuantity(input.pricing_model)) {
    if (qs === 'NOT_APPLICABLE') {
      add(ERROR.MISSING_QUANTITY_SOURCE,
        `${input.pricing_model} dihitung dari kuantitas, jadi quantity_source wajib diisi.`);
    }
  } else if (qs !== 'NOT_APPLICABLE') {
    add(ERROR.QUANTITY_ON_FIXED_MODEL,
      `${input.pricing_model} menagih per periode, bukan per kuantitas. quantity_source harus NOT_APPLICABLE `
      + '— jangan mengarang kuantitas untuk harga tetap.');
  }

  if (input.unit_of_measure && !UNIT_OF_MEASURE.includes(input.unit_of_measure)) {
    add(ERROR.VALIDATION, `unit_of_measure tidak dikenal: ${input.unit_of_measure}`);
  }
  if (input.rate_sen !== undefined && input.rate_sen !== null) {
    if (!Number.isInteger(input.rate_sen)) add(ERROR.VALIDATION, 'rate_sen harus bilangan bulat (sen).');
    else if (input.rate_sen < 0) add(ERROR.VALIDATION, 'rate_sen tidak boleh negatif.');
  }
  if (!input.effective_from) add(ERROR.VALIDATION, 'effective_from wajib diisi.');
  if (!input.legal_entity_id) add(ERROR.VALIDATION, 'legal_entity_id wajib diisi.');

  if (errors.length) throw new RateError(errors[0].code, errors[0].message, { errors });
  return true;
}

async function createRate(db, input, userContext) {
  validateRate(input);
  const scopeWhere = `addon_type = ? AND COALESCE(meal_type,'-') = COALESCE(?,'-') AND legal_entity_id = ?
    AND COALESCE(client_id,-1) = COALESCE(?,-1) AND COALESCE(project_id,-1) = COALESCE(?,-1)`;
  const prior = await db.prepare(`SELECT MAX(version) AS v FROM billing_rate_cards WHERE ${scopeWhere}`)
    .get(input.addon_type, input.meal_type ?? null, input.legal_entity_id,
      input.client_id ?? null, input.project_id ?? null);
  const version = Number(prior.v || 0) + 1;

  // A rate with no amount is NOT_CONFIGURED — a real, supported state.
  const configured = input.rate_sen !== undefined && input.rate_sen !== null;

  const info = await db.prepare(`
    INSERT INTO billing_rate_cards (addon_type, meal_type, pricing_model, quantity_source,
      unit_of_measure, rate_sen, rate_status, payroll_basis, legal_entity_id, client_id, project_id,
      version, effective_from, effective_to, status, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, ?, kahe_now()) RETURNING id
  `).run(input.addon_type, input.meal_type ?? null, input.pricing_model,
    input.quantity_source || 'NOT_APPLICABLE', input.unit_of_measure || 'UNIT',
    configured ? input.rate_sen : null, configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    input.payroll_basis ?? null, input.legal_entity_id, input.client_id ?? null,
    input.project_id ?? null, version, input.effective_from, input.effective_to ?? null,
    input.note ?? null, userContext.displayName);

  return await db.prepare('SELECT * FROM billing_rate_cards WHERE id = ?').get(info.lastInsertRowid);
}

/** Approve and activate, closing the previous open version the day before. */
async function approveRate(db, rateId, userContext, note) {
  const row = await db.prepare('SELECT * FROM billing_rate_cards WHERE id = ?').get(rateId);
  if (!row) throw new RateError(ERROR.NOT_FOUND, 'Tarif tidak ditemukan.');
  if (row.status !== STATUS.DRAFT) {
    throw new RateError(ERROR.INVALID_STATE, `Hanya tarif DRAFT yang bisa disetujui (status: ${row.status}).`);
  }
  const hasOverride = ((userContext.permissions || {}).payroll_sod_override || []).length > 0;
  if (!hasOverride && row.created_by === userContext.displayName) {
    throw new RateError(ERROR.SOD_VIOLATION,
      `Pemisahan tugas: ${userContext.displayName} yang membuat tarif ini tidak boleh menyetujuinya sendiri.`,
      { created_by: row.created_by });
  }

  const prev = await db.prepare(`
    SELECT * FROM billing_rate_cards
    WHERE addon_type = ? AND COALESCE(meal_type,'-') = COALESCE(?,'-') AND legal_entity_id = ?
      AND COALESCE(client_id,-1) = COALESCE(?,-1) AND COALESCE(project_id,-1) = COALESCE(?,-1)
      AND status = 'ACTIVE' AND effective_to IS NULL AND id != ?
  `).get(row.addon_type, row.meal_type, row.legal_entity_id, row.client_id, row.project_id, row.id);

  if (prev) {
    if (prev.effective_from >= row.effective_from) {
      throw new RateError(ERROR.OVERLAPPING_VERSION,
        `Tarif aktif (#${prev.id}) berlaku sejak ${prev.effective_from}; versi baru harus setelahnya.`,
        { active_id: prev.id, active_effective_from: prev.effective_from });
    }
    await db.prepare(`UPDATE billing_rate_cards SET effective_to = ?, status = 'SUPERSEDED' WHERE id = ?`)
      .run(previousDay(row.effective_from), prev.id);
  }
  await db.prepare(`UPDATE billing_rate_cards SET status='ACTIVE', approved_by=?, approved_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, row.id);
  return await db.prepare('SELECT * FROM billing_rate_cards WHERE id = ?').get(row.id);
}

/**
 * Resolve the rate in force at a date. Scope precedence project > client >
 * legal entity, the same rule Phase 3A uses for add-ons.
 *
 * Returns null when no rate card exists at all, and a card with
 * rate_status NOT_CONFIGURED when one exists without a price. Both are
 * legitimate; neither is an error here.
 */
async function resolveRate(db, { addonType, mealType = null, legalEntityId, clientId = null, projectId = null, asOf }) {
  if (!asOf) throw new RateError(ERROR.VALIDATION, 'asOf wajib diisi — tarif bersifat effective-dated.');
  const dateBound = 'effective_from <= @as_of AND (effective_to IS NULL OR effective_to >= @as_of)';
  const tiers = [
    { sql: 'client_id = @client_id AND project_id = @project_id',
      extra: { client_id: clientId, project_id: projectId },
      ok: clientId !== null && projectId !== null, tier: 'PROJECT' },
    { sql: 'client_id = @client_id AND project_id IS NULL',
      extra: { client_id: clientId }, ok: clientId !== null, tier: 'CLIENT' },
    { sql: 'client_id IS NULL AND project_id IS NULL',
      extra: {}, ok: true, tier: 'LEGAL_ENTITY' },
  ];
  for (const t of tiers) {
    if (!t.ok) continue;
    const rows = await db.prepare(`
      SELECT * FROM billing_rate_cards
      WHERE addon_type = @addon_type AND COALESCE(meal_type,'-') = COALESCE(@meal_type,'-')
        AND legal_entity_id = @entity AND status IN ('ACTIVE','SUPERSEDED') AND ${dateBound} AND ${t.sql}
      ORDER BY version DESC
    `).all({ addon_type: addonType, meal_type: mealType, entity: legalEntityId, as_of: asOf, ...t.extra });
    if (rows.length > 1) {
      throw new RateError(ERROR.OVERLAPPING_VERSION,
        `${rows.length} tarif ${addonType}${mealType ? '/' + mealType : ''} berlaku bersamaan pada ${asOf}.`,
        { ids: rows.map((r) => r.id) });
    }
    if (rows.length === 1) return { ...rows[0], resolved_tier: t.tier, uses_quantity: usesQuantity(rows[0].pricing_model) };
  }
  return null;
}

// ---- meal plan ----------------------------------------------------------------

async function createMealPlanItem(db, input, userContext) {
  if (!MEAL_TYPES.includes(input.meal_type)) {
    throw new RateError(ERROR.VALIDATION, `meal_type tidak dikenal: ${input.meal_type}`);
  }
  if (!input.effective_from) throw new RateError(ERROR.VALIDATION, 'effective_from wajib diisi.');
  if (!input.legal_entity_id) throw new RateError(ERROR.VALIDATION, 'legal_entity_id wajib diisi.');
  if (input.max_per_worker_per_day !== undefined && input.max_per_worker_per_day !== null
      && (!Number.isInteger(input.max_per_worker_per_day) || input.max_per_worker_per_day < 0)) {
    throw new RateError(ERROR.VALIDATION, 'max_per_worker_per_day harus bilangan bulat >= 0.');
  }
  const prior = await db.prepare(`SELECT MAX(version) AS v FROM meal_plan_items
    WHERE meal_type = ? AND legal_entity_id = ?
      AND COALESCE(client_id,-1) = COALESCE(?,-1) AND COALESCE(project_id,-1) = COALESCE(?,-1)`)
    .get(input.meal_type, input.legal_entity_id, input.client_id ?? null, input.project_id ?? null);

  const info = await db.prepare(`
    INSERT INTO meal_plan_items (meal_type, enabled, planned_entitlement, max_per_worker_per_day,
      note, legal_entity_id, client_id, project_id, version, effective_from, effective_to,
      status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, kahe_now()) RETURNING id
  `).run(input.meal_type, input.enabled ?? 1, input.planned_entitlement || 'ENTITLED',
    input.max_per_worker_per_day ?? null, input.note ?? null, input.legal_entity_id,
    input.client_id ?? null, input.project_id ?? null, Number(prior.v || 0) + 1,
    input.effective_from, input.effective_to ?? null, userContext.displayName);
  return await db.prepare('SELECT * FROM meal_plan_items WHERE id = ?').get(info.lastInsertRowid);
}

async function approveMealPlanItem(db, itemId, userContext) {
  const row = await db.prepare('SELECT * FROM meal_plan_items WHERE id = ?').get(itemId);
  if (!row) throw new RateError(ERROR.NOT_FOUND, 'Item rencana makan tidak ditemukan.');
  if (row.status !== STATUS.DRAFT) {
    throw new RateError(ERROR.INVALID_STATE, `Hanya DRAFT yang bisa disetujui (status: ${row.status}).`);
  }
  const hasOverride = ((userContext.permissions || {}).payroll_sod_override || []).length > 0;
  if (!hasOverride && row.created_by === userContext.displayName) {
    throw new RateError(ERROR.SOD_VIOLATION,
      `Pemisahan tugas: pembuat tidak boleh menyetujui rencana makannya sendiri.`);
  }
  const prev = await db.prepare(`SELECT * FROM meal_plan_items
    WHERE meal_type = ? AND legal_entity_id = ? AND COALESCE(client_id,-1) = COALESCE(?,-1)
      AND COALESCE(project_id,-1) = COALESCE(?,-1) AND status='ACTIVE' AND effective_to IS NULL AND id != ?`)
    .get(row.meal_type, row.legal_entity_id, row.client_id, row.project_id, row.id);
  if (prev) {
    if (prev.effective_from >= row.effective_from) {
      throw new RateError(ERROR.OVERLAPPING_VERSION,
        `Rencana makan aktif (#${prev.id}) berlaku sejak ${prev.effective_from}.`);
    }
    await db.prepare(`UPDATE meal_plan_items SET effective_to=?, status='SUPERSEDED' WHERE id=?`)
      .run(previousDay(row.effective_from), prev.id);
  }
  await db.prepare(`UPDATE meal_plan_items SET status='ACTIVE', approved_by=?, approved_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, row.id);
  return await db.prepare('SELECT * FROM meal_plan_items WHERE id = ?').get(row.id);
}

/**
 * The meal plan in force at a date: which meals are on, and their caps.
 * Enabling breakfast in July cannot change what June resolves.
 */
async function resolveMealPlan(db, { legalEntityId, clientId = null, projectId = null, asOf }) {
  if (!asOf) throw new RateError(ERROR.VALIDATION, 'asOf wajib diisi.');
  const plan = {};
  for (const mealType of MEAL_TYPES) {
    const dateBound = 'effective_from <= @as_of AND (effective_to IS NULL OR effective_to >= @as_of)';
    const tiers = [
      { sql: 'client_id = @client_id AND project_id = @project_id',
        extra: { client_id: clientId, project_id: projectId },
        ok: clientId !== null && projectId !== null, tier: 'PROJECT' },
      { sql: 'client_id = @client_id AND project_id IS NULL',
        extra: { client_id: clientId }, ok: clientId !== null, tier: 'CLIENT' },
      { sql: 'client_id IS NULL AND project_id IS NULL', extra: {}, ok: true, tier: 'LEGAL_ENTITY' },
    ];
    let found = null;
    for (const t of tiers) {
      if (!t.ok) continue;
      const row = await db.prepare(`SELECT * FROM meal_plan_items
        WHERE meal_type = @meal_type AND legal_entity_id = @entity
          AND status IN ('ACTIVE','SUPERSEDED') AND ${dateBound} AND ${t.sql}
        ORDER BY version DESC LIMIT 1`)
        .get({ meal_type: mealType, entity: legalEntityId, as_of: asOf, ...t.extra });
      if (row) { found = { ...row, resolved_tier: t.tier }; break; }
    }
    if (found) plan[mealType] = found;
  }
  return plan;
}

/** Meals that are enabled at this date — the only ones that may be billed. */
async function enabledMeals(db, scope) {
  const plan = await resolveMealPlan(db, scope);
  return Object.values(plan).filter((m) => Number(m.enabled) === 1).map((m) => m.meal_type);
}

function previousDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  RATE_ADDON_TYPES, MEAL_TYPES, QUANTITY_SOURCE, UNIT_OF_MEASURE, PRICING_MODELS,
  QUANTITYLESS_MODELS, PAYROLL_BASES, STATUS, ERROR, RateError,
  usesQuantity, validateRate, createRate, approveRate, resolveRate,
  createMealPlanItem, approveMealPlanItem, resolveMealPlan, enabledMeals,
  previousDay,
};
