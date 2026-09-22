// routes/worker-services.js — Phase 3A: worker service add-on configuration.
//
// SCOPE: configuration only. No invoice, no billing calculation, no payroll
// mutation. Entity-scoped reads per Phase 2I.
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../database/init-db');
const { requirePermission } = require('../middleware/permissions');
const scope = require('../lib/entityScope');
const addonLib = require('../lib/workerServiceAddon');

const router = express.Router();

function sendAddonError(res, err) {
  if (err instanceof scope.EntityAccessError) {
    return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
  }
  if (!(err instanceof addonLib.AddonError)) throw err;
  const status = {
    [addonLib.ERROR.NOT_FOUND]: 404,
    [addonLib.ERROR.SOD_VIOLATION]: 403,
    [addonLib.ERROR.ENTITY_MISMATCH]: 403,
    [addonLib.ERROR.OVERLAPPING_VERSION]: 409,
    [addonLib.ERROR.INVALID_STATE]: 409,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

/** The catalogue: every legal delivery mode per category, and which are cash. */
router.get('/addon-catalogue', requirePermission('worker_services_config', 'VIEW'), (req, res) => {
  res.json({
    addon_types: Object.values(addonLib.ADDON_TYPE),
    delivery_modes: addonLib.DELIVERY_MODES,
    cash_modes: [...addonLib.CASH_MODES],
    natures: addonLib.NATURE,
    cost_bearers: Object.values(addonLib.COST_BEARER),
    billing_treatments: Object.values(addonLib.BILLING_TREATMENT),
    entitlements: Object.values(addonLib.ENTITLEMENT),
    quantity_bases: addonLib.QUANTITY_BASIS,
    notice: 'Transport, makan dan akomodasi bersifat opsional. Hanya mode tunai yang '
      + 'dapat menjadi komponen gaji, dan hanya bila dikonfigurasi eksplisit.',
  });
});

router.get('/clients', requirePermission('worker_services_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'payroll_group', route: req.originalUrl });
    res.json(await db.prepare(`SELECT * FROM clients WHERE ${sc.sql} ORDER BY code`).all(...sc.params));
  } finally { db.close(); }
});

router.post('/clients', requirePermission('worker_services_config', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const { code, name, legal_entity_id, npwp } = req.body;
    if (!code || !name || !legal_entity_id) {
      return res.status(400).json({ error: 'VALIDATION', message: 'code, name dan legal_entity_id wajib diisi.' });
    }
    await scope.assertEntityAccess(db, req.userContext, legal_entity_id,
      { resourceType: 'client', route: req.originalUrl });
    const info = await withRetry(async () => await withTransaction(db, async () =>
      await db.prepare(`INSERT INTO clients (code,name,legal_entity_id,npwp,created_by) VALUES (?,?,?,?,?) RETURNING id`)
        .run(code, name, legal_entity_id, npwp || null, req.userContext.displayName)), { label: 'create client' });
    res.status(201).json(await db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

router.get('/addons', requirePermission('worker_services_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'addon', route: req.originalUrl });
    let sql = `SELECT * FROM worker_service_addons WHERE ${sc.sql}`;
    const params = [...sc.params];
    for (const [q, col] of [['addon_type', 'addon_type'], ['client_id', 'client_id'],
      ['project_id', 'project_id'], ['status', 'status']]) {
      if (req.query[q]) { sql += ` AND ${col} = ?`; params.push(req.query[q]); }
    }
    sql += ' ORDER BY addon_type, version DESC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

/** Resolve what is in force at a date — the read a future billing run uses. */
router.get('/addons/resolve', requirePermission('worker_services_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { legal_entity_id, client_id, project_id, as_of } = req.query;
    if (!legal_entity_id || !as_of) {
      return res.status(400).json({ error: 'VALIDATION', message: 'legal_entity_id dan as_of wajib diisi.' });
    }
    await scope.assertEntityAccess(db, req.userContext, legal_entity_id,
      { resourceType: 'addon', route: req.originalUrl });
    const s = {
      legalEntityId: legal_entity_id,
      clientId: client_id ? Number(client_id) : null,
      projectId: project_id ? Number(project_id) : null,
      asOf: as_of,
    };
    res.json({
      resolved: await addonLib.resolveAllAddons(db, s),
      payroll_impact: await addonLib.resolvePayrollImpact(db, s),
      billing: await addonLib.resolveBillingBasis(db, s),
    });
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

router.get('/addons/:id', requirePermission('worker_services_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    await scope.assertEntityAccess(db, req.userContext, row.legal_entity_id,
      { resourceType: 'addon', resourceId: row.id, route: req.originalUrl });
    row.nature = addonLib.natureOf(row);
    row.audit = await db.prepare('SELECT * FROM worker_service_addon_audit WHERE addon_id = ? ORDER BY id').all(row.id);
    res.json(row);
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

router.post('/addons', requirePermission('worker_services_config', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    // Validate presence BEFORE the scope check: a missing required field is a
    // 400, not a 404. Answering 404 here would be indistinguishable from a
    // cross-entity denial and would send the caller looking for the wrong bug.
    if (!req.body.legal_entity_id) {
      return res.status(400).json({ error: 'VALIDATION', message: 'legal_entity_id wajib diisi.' });
    }
    await scope.assertEntityAccess(db, req.userContext, req.body.legal_entity_id,
      { resourceType: 'addon', route: req.originalUrl });
    const row = await withRetry(async () => await withTransaction(db, async () =>
      await addonLib.createAddon(db, req.body, req.userContext)), { label: 'create addon' });
    res.status(201).json({ ...row, nature: addonLib.natureOf(row) });
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

router.post('/addons/:id/approve', requirePermission('worker_services_config', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    await scope.assertEntityAccess(db, req.userContext, row.legal_entity_id,
      { resourceType: 'addon', resourceId: row.id, route: req.originalUrl });
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await addonLib.approveAddon(db, Number(req.params.id), req.userContext, req.body.note)),
    { label: 'approve addon' });
    res.json(out);
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

router.post('/addons/:id/cancel', requirePermission('worker_services_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    await scope.assertEntityAccess(db, req.userContext, row.legal_entity_id,
      { resourceType: 'addon', resourceId: row.id, route: req.originalUrl });
    res.json(await withRetry(async () => await withTransaction(db, async () =>
      await addonLib.cancelAddon(db, Number(req.params.id), req.userContext, req.body.reason)),
    { label: 'cancel addon' }));
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

/** Service fee: optional, and NOT_CONFIGURED is a valid answer. */
router.get('/service-fee/resolve', requirePermission('worker_services_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { legal_entity_id, client_id, project_id, as_of } = req.query;
    if (!legal_entity_id || !as_of) {
      return res.status(400).json({ error: 'VALIDATION', message: 'legal_entity_id dan as_of wajib diisi.' });
    }
    await scope.assertEntityAccess(db, req.userContext, legal_entity_id,
      { resourceType: 'addon', route: req.originalUrl });
    res.json(await addonLib.resolveServiceFee(db, {
      legalEntityId: legal_entity_id,
      clientId: client_id ? Number(client_id) : null,
      projectId: project_id ? Number(project_id) : null,
      asOf: as_of,
    }));
  } catch (err) { return sendAddonError(res, err); } finally { db.close(); }
});

module.exports = router;
