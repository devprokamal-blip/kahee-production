// routes/client-billing.js — Phase 3B: rates, quantities, draft billing.
//
// SCOPE: quantity capture, commercial rates, and a DRAFT billing statement.
// No invoice, no billing approval/freeze beyond the calculation freeze, no AR.
// Entity and client isolation reuse the Phase 2I controls.
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../database/init-db');
const { requirePermission } = require('../middleware/permissions');
const scope = require('../lib/entityScope');
const rateLib = require('../lib/billingRate');
const qtyLib = require('../lib/billingQuantity');
const billing = require('../lib/billingCalculator');

const router = express.Router();

function sendError(res, err) {
  if (err instanceof scope.EntityAccessError) {
    return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
  }
  const named = err instanceof rateLib.RateError || err instanceof qtyLib.QuantityError
    || err instanceof billing.BillingError;
  if (!named) throw err;
  const status = {
    NOT_FOUND: 404, SOD_VIOLATION: 403, ENTITY_MISMATCH: 403,
    DUPLICATE_QUANTITY: 409, ALREADY_BILLED: 409, ALREADY_CALCULATED: 409,
    OVERLAPPING_VERSION: 409, INVALID_STATE: 409,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

/** Guard: the caller must hold the entity, and the client must belong to it. */
async function guardScope(db, req, legalEntityId, clientId) {
  if (!legalEntityId) {
    const e = new billing.BillingError(billing.ERROR.VALIDATION, 'legal_entity_id wajib diisi.');
    throw e;
  }
  await scope.assertEntityAccess(db, req.userContext, legalEntityId,
    { resourceType: 'billing', route: req.originalUrl });
  if (clientId) {
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) throw new billing.BillingError(billing.ERROR.NOT_FOUND, 'Klien tidak ditemukan.');
    if (client.legal_entity_id && client.legal_entity_id !== legalEntityId) {
      // Cross-entity client: answered as not-found, per the Phase 2I policy.
      throw new scope.EntityAccessError('NOT_FOUND', 'Data tidak ditemukan.');
    }
  }
}

router.get('/catalogue', requirePermission('client_billing', 'VIEW'), (req, res) => {
  res.json({
    pricing_models: rateLib.PRICING_MODELS,
    quantity_sources: rateLib.QUANTITY_SOURCE,
    units_of_measure: rateLib.UNIT_OF_MEASURE,
    meal_types: rateLib.MEAL_TYPES,
    payroll_bases: rateLib.PAYROLL_BASES,
    quantityless_models: [...rateLib.QUANTITYLESS_MODELS],
    notice: 'Tidak ada harga, jumlah makan, jumlah trip atau service fee yang di-hardcode. '
      + 'Tarif boleh tetap NOT_CONFIGURED, dan billing akan melewatinya, bukan mengarang angka.',
  });
});

// ---- rate cards ----------------------------------------------------------------
router.post('/rates', requirePermission('client_billing', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guardScope(db, req, req.body.legal_entity_id, req.body.client_id);
    const row = await withRetry(async () => await withTransaction(db, async () =>
      await rateLib.createRate(db, req.body, req.userContext)), { label: 'create rate' });
    res.status(201).json(row);
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.post('/rates/:id/approve', requirePermission('client_billing', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare('SELECT * FROM billing_rate_cards WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    await guardScope(db, req, row.legal_entity_id, row.client_id);
    res.json(await withRetry(async () => await withTransaction(db, async () =>
      await rateLib.approveRate(db, Number(req.params.id), req.userContext, req.body.note)),
    { label: 'approve rate' }));
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.get('/rates', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'billing', route: req.originalUrl });
    let sql = `SELECT * FROM billing_rate_cards WHERE ${sc.sql}`;
    const params = [...sc.params];
    for (const q of ['addon_type', 'client_id', 'project_id', 'status']) {
      if (req.query[q]) { sql += ` AND ${q} = ?`; params.push(req.query[q]); }
    }
    res.json(await db.prepare(`${sql} ORDER BY addon_type, meal_type, version DESC`).all(...params));
  } finally { db.close(); }
});

router.get('/rates/resolve', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { legal_entity_id, client_id, project_id, addon_type, meal_type, as_of } = req.query;
    if (!addon_type || !as_of) {
      return res.status(400).json({ error: 'VALIDATION', message: 'addon_type dan as_of wajib diisi.' });
    }
    await guardScope(db, req, legal_entity_id, client_id ? Number(client_id) : null);
    const rate = await rateLib.resolveRate(db, {
      addonType: addon_type, mealType: meal_type || null, legalEntityId: legal_entity_id,
      clientId: client_id ? Number(client_id) : null,
      projectId: project_id ? Number(project_id) : null, asOf: as_of,
    });
    res.json(rate || { resolved: null, rate_status: 'NO_RATE_CARD',
      note: 'Belum ada kartu tarif. Ini keadaan yang sah; billing akan melewatinya.' });
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

// ---- meal plan -------------------------------------------------------------------
router.post('/meal-plan', requirePermission('client_billing', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guardScope(db, req, req.body.legal_entity_id, req.body.client_id);
    res.status(201).json(await withRetry(async () => await withTransaction(db, async () =>
      await rateLib.createMealPlanItem(db, req.body, req.userContext)), { label: 'create meal plan' }));
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.post('/meal-plan/:id/approve', requirePermission('client_billing', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare('SELECT * FROM meal_plan_items WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    await guardScope(db, req, row.legal_entity_id, row.client_id);
    res.json(await withRetry(async () => await withTransaction(db, async () =>
      await rateLib.approveMealPlanItem(db, Number(req.params.id), req.userContext)),
    { label: 'approve meal plan' }));
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.get('/meal-plan/resolve', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { legal_entity_id, client_id, project_id, as_of } = req.query;
    if (!as_of) return res.status(400).json({ error: 'VALIDATION', message: 'as_of wajib diisi.' });
    await guardScope(db, req, legal_entity_id, client_id ? Number(client_id) : null);
    const s = { legalEntityId: legal_entity_id, clientId: client_id ? Number(client_id) : null,
      projectId: project_id ? Number(project_id) : null, asOf: as_of };
    res.json({ plan: await rateLib.resolveMealPlan(db, s), enabled: await rateLib.enabledMeals(db, s) });
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

// ---- quantities --------------------------------------------------------------------
router.post('/quantities', requirePermission('client_billing', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guardScope(db, req, req.body.legal_entity_id, req.body.client_id);
    res.status(201).json(await withRetry(async () => await withTransaction(db, async () =>
      await qtyLib.recordQuantity(db, req.body, req.userContext)), { label: 'record quantity' }));
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.get('/quantities', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'billing', route: req.originalUrl });
    let sql = `SELECT * FROM billing_quantities WHERE ${sc.sql}`;
    const params = [...sc.params];
    for (const q of ['billing_period', 'addon_type', 'client_id', 'project_id',
      'employee_id', 'verification_status']) {
      if (req.query[q]) { sql += ` AND ${q} = ?`; params.push(req.query[q]); }
    }
    res.json(await db.prepare(`${sql} ORDER BY service_date, id`).all(...params));
  } finally { db.close(); }
});

function quantityAction(action, permission, handler) {
  router.post(`/quantities/:id/${action}`, requirePermission('client_billing', permission), async (req, res) => {
    const db = getDb();
    try {
      const row = await db.prepare('SELECT * FROM billing_quantities WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      await guardScope(db, req, row.legal_entity_id, row.client_id);
      res.json(await withRetry(async () => await withTransaction(db, async () => await handler(db, req)), { label: action }));
    } catch (err) { return sendError(res, err); } finally { db.close(); }
  });
}
quantityAction('verify', 'APPROVE', async (db, req) =>
  await qtyLib.verifyQuantity(db, Number(req.params.id), req.userContext, req.body.note));
quantityAction('reject', 'APPROVE', async (db, req) =>
  await qtyLib.rejectQuantity(db, Number(req.params.id), req.userContext, req.body.reason));
quantityAction('correct', 'EDIT', async (db, req) =>
  await qtyLib.correctQuantity(db, Number(req.params.id), Number(req.body.quantity), req.userContext, req.body.reason));

// ---- draft billing runs ---------------------------------------------------------------
router.post('/runs', requirePermission('client_billing', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guardScope(db, req, req.body.legal_entity_id, req.body.client_id);
    const run = await withRetry(async () => await withTransaction(db, async () =>
      await billing.createRun(db, {
        legalEntityId: req.body.legal_entity_id, clientId: Number(req.body.client_id),
        projectId: req.body.project_id ? Number(req.body.project_id) : null,
        billingPeriod: req.body.billing_period,
      }, req.userContext)), { label: 'create billing run' });
    res.status(201).json(run);
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

/** Preview without persisting — nothing is frozen, nothing is consumed. */
router.get('/runs/:id/preview', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const run = await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    await guardScope(db, req, run.legal_entity_id, run.client_id);
    const result = await billing.calculateRun(db, run, req.userContext);
    res.json({ persisted: false, is_invoice: false, ...result,
      total_amount_sen: result.lines.reduce((t, l) => t + l.amount_sen, 0) });
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.post('/runs/:id/calculate', requirePermission('client_billing', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const run = await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    await guardScope(db, req, run.legal_entity_id, run.client_id);
    const out = await withRetry(async () => await withTransaction(db, async () => {
      const result = await billing.calculateRun(db, run, req.userContext);
      return await billing.persistRun(db, run, result, req.userContext);
    }), { label: 'calculate billing run' });
    res.status(201).json({ is_invoice: false, ...out });
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.get('/runs/:id', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const run = await db.prepare('SELECT * FROM billing_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
    await guardScope(db, req, run.legal_entity_id, run.client_id);
    res.json(await billing.explainRun(db, Number(req.params.id)));
  } catch (err) { return sendError(res, err); } finally { db.close(); }
});

router.get('/runs', requirePermission('client_billing', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'billing', route: req.originalUrl });
    let sql = `SELECT * FROM billing_runs WHERE ${sc.sql}`;
    const params = [...sc.params];
    for (const q of ['client_id', 'billing_period', 'status']) {
      if (req.query[q]) { sql += ` AND ${q} = ?`; params.push(req.query[q]); }
    }
    res.json(await db.prepare(`${sql} ORDER BY id DESC`).all(...params));
  } finally { db.close(); }
});

module.exports = router;
