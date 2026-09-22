// lib/billingQuantity.js
// Phase 3B — verified quantity capture.
//
// ============================================================
// LOCKS
// ============================================================
// * ATTENDANCE IS NEVER ASSUMED TO BE CONSUMPTION. A worker present for 26
//   days did not necessarily eat 26 lunches or take 26 shuttle trips. If a
//   caller wants attendance as the source, they must say so explicitly by
//   choosing quantity_source = ATTENDANCE_DAY — and even then it is recorded
//   as a claim with a source reference, not as a fact.
// * Only VERIFIED quantities may be billed.
// * Corrections never edit. A correction is a NEW record that supersedes the
//   old one and carries a mandatory reason.
// * Zero is a legitimate quantity (the service ran, nobody used it).
//   Negative is refused unless it is an explicit adjustment against a prior
//   record.
//
// This module never reads or writes payroll.

const rateLib = require('./billingRate');

const VERIFICATION = { UNVERIFIED: 'UNVERIFIED', VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED', SUPERSEDED: 'SUPERSEDED' };

const ERROR = {
  VALIDATION: 'VALIDATION',
  DUPLICATE_QUANTITY: 'DUPLICATE_QUANTITY',
  NEGATIVE_QUANTITY: 'NEGATIVE_QUANTITY',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  ALREADY_BILLED: 'ALREADY_BILLED',
  SOD_VIOLATION: 'SOD_VIOLATION',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
};

class QuantityError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.name = 'QuantityError'; this.code = code; this.detail = detail;
  }
}

async function audit(db, quantityId, action, userContext, before, after, note) {
  await db.prepare(`INSERT INTO billing_quantity_audit (quantity_id, action, actor, before_json, after_json, note, occurred_at)
              VALUES (?,?,?,?,?,?, kahe_now())`)
    .run(quantityId, action, userContext.displayName,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note ?? null);
}

function validateQuantity(input) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!['TRANSPORT', 'MEALS', 'ACCOMMODATION'].includes(input.addon_type)) {
    add(ERROR.VALIDATION, `addon_type tidak dikenal: ${input.addon_type}`);
  }
  if (!input.legal_entity_id) add(ERROR.VALIDATION, 'legal_entity_id wajib diisi.');
  if (!input.billing_period || !/^\d{4}-\d{2}$/.test(input.billing_period)) {
    add(ERROR.VALIDATION, 'billing_period wajib diisi dalam format YYYY-MM.');
  }
  if (!rateLib.QUANTITY_SOURCE.includes(input.quantity_source)) {
    add(ERROR.VALIDATION, `quantity_source tidak dikenal: ${input.quantity_source}`);
  }
  if (!rateLib.UNIT_OF_MEASURE.includes(input.unit_of_measure)) {
    add(ERROR.VALIDATION, `unit_of_measure tidak dikenal: ${input.unit_of_measure}`);
  }
  if (!Number.isInteger(input.quantity)) {
    add(ERROR.VALIDATION, 'quantity harus bilangan bulat.');
  } else if (input.quantity < 0 && !input.is_adjustment) {
    // Zero is fine — the service ran and nobody used it. Negative is only
    // meaningful as a correction against something already recorded.
    add(ERROR.NEGATIVE_QUANTITY,
      'Kuantitas negatif hanya boleh sebagai penyesuaian eksplisit (is_adjustment = 1) '
      + 'dengan corrects_quantity_id dan alasan.');
  }
  if (input.is_adjustment) {
    if (!input.corrects_quantity_id) add(ERROR.VALIDATION, 'Penyesuaian harus menyebut corrects_quantity_id.');
    if (!input.adjustment_reason) add(ERROR.VALIDATION, 'Penyesuaian harus menyertakan adjustment_reason.');
  }
  if (input.addon_type === 'MEALS' && !input.meal_type) {
    add(ERROR.VALIDATION, 'meal_type wajib diisi untuk kuantitas MEALS.');
  }
  if (input.addon_type !== 'MEALS' && input.meal_type) {
    add(ERROR.VALIDATION, 'meal_type hanya berlaku untuk MEALS.');
  }
  if (errors.length) throw new QuantityError(errors[0].code, errors[0].message, { errors });
  return true;
}

/**
 * Record a quantity claim. Starts UNVERIFIED — capture and verification are
 * separate acts, because the person who counts should not be the only person
 * who vouches for the count.
 */
async function recordQuantity(db, input, userContext) {
  validateQuantity(input);

  // Duplicate prevention is also enforced by a partial unique index; this
  // check exists to return a useful error instead of a constraint message.
  if (input.service_date && !input.is_adjustment) {
    const dupe = await db.prepare(`
      SELECT id, quantity, verification_status FROM billing_quantities
      WHERE addon_type = ? AND COALESCE(meal_type,'-') = COALESCE(?,'-')
        AND legal_entity_id = ? AND COALESCE(client_id,-1) = COALESCE(?,-1)
        AND COALESCE(project_id,-1) = COALESCE(?,-1) AND COALESCE(employee_id,'-') = COALESCE(?,'-')
        AND service_date = ? AND quantity_source = ?
        AND verification_status IN ('UNVERIFIED','VERIFIED')
    `).get(input.addon_type, input.meal_type ?? null, input.legal_entity_id,
      input.client_id ?? null, input.project_id ?? null, input.employee_id ?? null,
      input.service_date, input.quantity_source);
    if (dupe) {
      throw new QuantityError(ERROR.DUPLICATE_QUANTITY,
        `Kuantitas untuk layanan ini pada ${input.service_date} sudah tercatat (#${dupe.id}, ${dupe.quantity} ${input.unit_of_measure}). `
        + 'Gunakan koreksi bila angkanya perlu diubah.',
        { existing_id: dupe.id, existing_quantity: dupe.quantity });
    }
  }

  const info = await db.prepare(`
    INSERT INTO billing_quantities (legal_entity_id, client_id, project_id, addon_id, addon_type,
      meal_type, billing_period, employee_id, service_date, service_period_start, service_period_end,
      quantity_source, quantity, unit_of_measure, source_reference, verification_status,
      version, corrects_quantity_id, adjustment_reason, is_adjustment,
      route_id, vehicle_id, vehicle_type, shift_id, pickup_point, drop_point,
      trip_reference, operator_reference, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'UNVERIFIED', ?,?,?,?,?,?,?,?,?,?,?,?,?, kahe_now()) RETURNING id
  `).run(input.legal_entity_id, input.client_id ?? null, input.project_id ?? null,
    input.addon_id ?? null, input.addon_type, input.meal_type ?? null, input.billing_period,
    input.employee_id ?? null, input.service_date ?? null,
    input.service_period_start ?? null, input.service_period_end ?? null,
    input.quantity_source, input.quantity, input.unit_of_measure, input.source_reference ?? null,
    input.version ?? 1, input.corrects_quantity_id ?? null, input.adjustment_reason ?? null,
    input.is_adjustment ? 1 : 0,
    input.route_id ?? null, input.vehicle_id ?? null, input.vehicle_type ?? null,
    input.shift_id ?? null, input.pickup_point ?? null, input.drop_point ?? null,
    input.trip_reference ?? null, input.operator_reference ?? null, userContext.displayName);

  const row = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(info.lastInsertRowid);
  await audit(db, row.id, 'RECORDED', userContext, null, row, input.source_reference);
  return row;
}

/**
 * Verify. Segregation of duties: the person who recorded a quantity may not
 * be the one who vouches for it, unless they hold the explicit override.
 */
async function verifyQuantity(db, quantityId, userContext, note) {
  const row = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(quantityId);
  if (!row) throw new QuantityError(ERROR.NOT_FOUND, 'Kuantitas tidak ditemukan.');
  if (row.verification_status !== VERIFICATION.UNVERIFIED) {
    throw new QuantityError(ERROR.INVALID_STATE,
      `Hanya kuantitas UNVERIFIED yang bisa diverifikasi (status: ${row.verification_status}).`);
  }
  const hasOverride = ((userContext.permissions || {}).payroll_sod_override || []).length > 0;
  if (!hasOverride && row.created_by === userContext.displayName) {
    throw new QuantityError(ERROR.SOD_VIOLATION,
      `Pemisahan tugas: ${userContext.displayName} yang mencatat kuantitas ini tidak boleh memverifikasinya sendiri.`,
      { created_by: row.created_by });
  }
  await db.prepare(`UPDATE billing_quantities SET verification_status='VERIFIED', verified_by=?, verified_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, row.id);
  const after = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(row.id);
  await audit(db, row.id, 'VERIFIED', userContext, row, after, note);
  return after;
}

async function rejectQuantity(db, quantityId, userContext, reason) {
  const row = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(quantityId);
  if (!row) throw new QuantityError(ERROR.NOT_FOUND, 'Kuantitas tidak ditemukan.');
  if (!reason) throw new QuantityError(ERROR.VALIDATION, 'Alasan penolakan wajib diisi.');
  if (row.billed_in_run_id) {
    throw new QuantityError(ERROR.ALREADY_BILLED, 'Kuantitas ini sudah masuk perhitungan tagihan; gunakan koreksi.');
  }
  await db.prepare(`UPDATE billing_quantities SET verification_status='REJECTED', rejection_reason=?, verified_by=?, verified_at=kahe_now() WHERE id=?`)
    .run(reason, userContext.displayName, row.id);
  const after = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(row.id);
  await audit(db, row.id, 'REJECTED', userContext, row, after, reason);
  return after;
}

/**
 * Correct a quantity. The original is SUPERSEDED, never edited, and a new
 * record carries the corrected figure plus the reason. History survives.
 */
async function correctQuantity(db, quantityId, newQuantity, userContext, reason) {
  const row = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(quantityId);
  if (!row) throw new QuantityError(ERROR.NOT_FOUND, 'Kuantitas tidak ditemukan.');
  if (!reason) throw new QuantityError(ERROR.VALIDATION, 'Alasan koreksi wajib diisi.');
  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    throw new QuantityError(ERROR.VALIDATION, 'Kuantitas koreksi harus bilangan bulat >= 0.');
  }
  if (row.verification_status === VERIFICATION.SUPERSEDED) {
    throw new QuantityError(ERROR.INVALID_STATE, 'Kuantitas ini sudah digantikan; koreksi versi terbarunya.');
  }

  // Close the old record first, so the partial unique index does not see two
  // live rows for the same service day.
  await db.prepare(`UPDATE billing_quantities SET verification_status='SUPERSEDED' WHERE id=?`).run(row.id);
  await audit(db, row.id, 'SUPERSEDED', userContext, row,
    { ...row, verification_status: 'SUPERSEDED' }, reason);

  const info = await db.prepare(`
    INSERT INTO billing_quantities (legal_entity_id, client_id, project_id, addon_id, addon_type,
      meal_type, billing_period, employee_id, service_date, service_period_start, service_period_end,
      quantity_source, quantity, unit_of_measure, source_reference, verification_status,
      version, corrects_quantity_id, adjustment_reason, is_adjustment,
      route_id, vehicle_id, vehicle_type, shift_id, pickup_point, drop_point,
      trip_reference, operator_reference, created_by, created_at)
    SELECT legal_entity_id, client_id, project_id, addon_id, addon_type,
      meal_type, billing_period, employee_id, service_date, service_period_start, service_period_end,
      quantity_source, ?, unit_of_measure, source_reference, 'UNVERIFIED',
      version + 1, ?, ?, 0,
      route_id, vehicle_id, vehicle_type, shift_id, pickup_point, drop_point,
      trip_reference, operator_reference, ?, kahe_now()
    FROM billing_quantities WHERE id = ? RETURNING id
  `).run(newQuantity, row.id, reason, userContext.displayName, row.id);

  const corrected = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(info.lastInsertRowid);
  await audit(db, corrected.id, 'CORRECTED', userContext, row, corrected, reason);
  return { superseded: await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(row.id), corrected };
}

/**
 * The VERIFIED quantities available to bill, for one scope and period.
 * Only VERIFIED rows are returned — an unverified claim is never billed.
 */
async function getBillableQuantities(db, { legalEntityId, clientId = null, projectId = null,
  billingPeriod, addonType = null, mealType = null, includeBilled = false }) {
  let sql = `SELECT * FROM billing_quantities
    WHERE legal_entity_id = ? AND billing_period = ? AND verification_status = 'VERIFIED'`;
  const params = [legalEntityId, billingPeriod];
  sql += ' AND COALESCE(client_id,-1) = COALESCE(?,-1)'; params.push(clientId);
  if (projectId !== null) { sql += ' AND COALESCE(project_id,-1) = COALESCE(?,-1)'; params.push(projectId); }
  if (addonType) { sql += ' AND addon_type = ?'; params.push(addonType); }
  if (mealType) { sql += ' AND meal_type = ?'; params.push(mealType); }
  if (!includeBilled) sql += ' AND billed_in_run_id IS NULL';
  sql += ' ORDER BY service_date, employee_id, id';
  return await db.prepare(sql).all(...params);
}

/** Sum verified quantities, keeping the contributing ids for traceability. */
function sumQuantities(rows) {
  return {
    quantity: rows.reduce((t, r) => t + Number(r.quantity), 0),
    ids: rows.map((r) => r.id),
    unit: rows.length ? rows[0].unit_of_measure : null,
    source: rows.length ? rows[0].quantity_source : null,
    verifiers: [...new Set(rows.map((r) => r.verified_by).filter(Boolean))],
  };
}

module.exports = {
  VERIFICATION, ERROR, QuantityError,
  validateQuantity, recordQuantity, verifyQuantity, rejectQuantity, correctQuantity,
  getBillableQuantities, sumQuantities, audit,
};
