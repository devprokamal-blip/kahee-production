// routes/payroll/payments.js — Phase 2H: payment processing & bank export.
//
// SCOPE: converts FINALIZED payroll into payment instructions. It never
// recalculates payroll and never modifies finalized results.
//
// PERMISSIONS:
//   prepare / retry      -> payroll_payment:CREATE
//   validate             -> payroll_payment:EDIT
//   export bank file     -> payroll_payment:EXPORT
//   submit (authorise)   -> payroll_payment:APPROVE, and not the preparer
//   record bank outcome  -> payroll_payment:EDIT
const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const pay = require('../../lib/payrollPayment');
const bankExport = require('../../lib/bankExport');

const router = express.Router();

/**
 * Phase 2I: cross-entity reads are refused with 404, never 403 — a 403 would
 * confirm the record exists in another entity, which is the basis of id
 * enumeration. The attempt is audited either way.
 */
async function guard(db, req, resourceType, resourceId) {
  return await scope.assertResourceAccess(db, req.userContext, resourceType, resourceId, req.originalUrl);
}
function sendScopeError(res, err) {
  if (!(err instanceof scope.EntityAccessError)) return false;
  res.status(404).json({ error: 'NOT_FOUND', message: err.message });
  return true;
}

function sendPayError(res, err) {
  if (!(err instanceof pay.PaymentError)) throw err;
  const status = {
    [pay.ERROR.NOT_AUTHORIZED]: 403,
    [pay.ERROR.SOD_VIOLATION]: 403,
    [pay.ERROR.ENTITY_MISMATCH]: 403,
    [pay.ERROR.RUN_NOT_FINALIZED]: 409,
    [pay.ERROR.DUPLICATE_PAYMENT]: 409,
    [pay.ERROR.RECONCILIATION_FAILED]: 409,
    [pay.ERROR.NO_PAYABLE_EMPLOYEES]: 409,
    [pay.ERROR.NOT_RETRYABLE]: 409,
    [pay.ERROR.INVALID_TRANSITION]: 400,
    [pay.ERROR.MISSING_BANK_ACCOUNT]: 400,
    [pay.ERROR.INVALID_BANK_ACCOUNT]: 400,
    [pay.ERROR.VALIDATION]: 400,
  }[err.code] || 400;
  return res.status(status).json({ error: err.code, message: err.message, detail: err.detail });
}

const loadBatch = async (db, id) => await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(id);

/** Available export formats, with an explicit verified-against-bank-spec flag. */
router.get('/payments/export-formats', requirePermission('payroll_payment', 'VIEW'), (req, res) => {
  res.json({
    formats: bankExport.listAdapters(),
    notice: 'Format generik belum diverifikasi terhadap spesifikasi bank mana pun. '
      + 'Tambahkan adapter khusus dan uji dengan validator bank sebelum dipakai produksi.',
  });
});

router.post('/periods/:periodId/payment-batches', requirePermission('payroll_payment', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await pay.prepareBatch(db, Number(req.params.periodId), req.userContext,
        { chunkSize: Number(req.body.chunk_size) || undefined })), { label: 'prepare payment batch' });
    res.status(201).json(out);
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

router.get('/payment-batches', requirePermission('payroll_payment', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { period_id, status } = req.query;
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'payment_batch', route: req.originalUrl });
    let sql = `SELECT * FROM payroll_payment_batches WHERE ${sc.sql}`;
    const params = [...sc.params];
    if (period_id) { sql += ' AND payroll_period_id = ?'; params.push(period_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY id DESC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

router.get('/payment-batches/:id', requirePermission('payroll_payment', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    await guard(db, req, 'payment_batch', req.params.id);
    const batch = await loadBatch(db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    batch.items = await db.prepare(`
      SELECT i.*, e.full_name FROM payroll_payment_items i JOIN employees e ON e.id = i.employee_id
      WHERE i.batch_id = ? ORDER BY e.full_name
    `).all(batch.id);
    batch.allowed_transitions = pay.BATCH_TRANSITIONS[batch.status] || [];
    res.json(batch);
  } finally { db.close(); }
});

router.get('/payment-batches/:id/events', requirePermission('payroll_payment', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    res.json((await db.prepare('SELECT * FROM payroll_payment_events WHERE batch_id = ? ORDER BY id ASC')
      .all(req.params.id)).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })));
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

router.post('/payment-batches/:id/validate', requirePermission('payroll_payment', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    const batch = await loadBatch(db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await pay.validateBatch(db, batch, req.userContext, req.body.note)), { label: 'validate batch' });
    res.json({ ok: true, status: pay.BATCH_STATUS.VALIDATED, ...out });
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

/** Export the bank file. `?download=1` streams the file itself. */
router.post('/payment-batches/:id/export', requirePermission('payroll_payment', 'EXPORT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    const batch = await loadBatch(db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    const format = req.body.format || batch.export_format || 'GENERIC_CSV';
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await pay.exportBatch(db, batch, format, req.userContext, req.body.note)), { label: 'export batch' });

    if (req.query.download === '1') {
      res.type(out.file.content_type)
        .set('Content-Disposition', `attachment; filename="${out.file.filename}"`)
        .send(out.file.content);
      return;
    }
    res.status(out.idempotent ? 200 : 201).json({
      idempotent: out.idempotent,
      format: out.file.format,
      filename: out.file.filename,
      content_hash: out.file.content_hash,
      byte_length: out.file.byte_length,
      verified_against_bank_spec: out.file.verified_against_bank_spec,
      content: req.body.include_content ? out.file.content : undefined,
    });
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

router.post('/payment-batches/:id/submit', requirePermission('payroll_payment', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    const batch = await loadBatch(db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    const out = await withRetry(async () => await withTransaction(db, async () =>
      await pay.submitBatch(db, batch, req.userContext, req.body.note)), { label: 'submit batch' });
    res.json({ ok: true, status: pay.BATCH_STATUS.SUBMITTED, ...out });
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

router.post('/payment-batches/:id/cancel', requirePermission('payroll_payment', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_batch', req.params.id);
    const batch = await loadBatch(db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    await withRetry(async () => await withTransaction(db, async () =>
      await pay.cancelBatch(db, batch, req.userContext, req.body.reason)), { label: 'cancel batch' });
    res.json({ ok: true, status: pay.BATCH_STATUS.CANCELLED });
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

/** Record a bank outcome for one instruction. Nothing is auto-fixed. */
router.post('/payment-items/:id/outcome', requirePermission('payroll_payment', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_item', req.params.id);
    const item = await withRetry(async () => await withTransaction(db, async () =>
      await pay.recordItemOutcome(db, Number(req.params.id), String(req.body.status || '').toUpperCase(),
        req.userContext, { reason: req.body.reason, bankCode: req.body.bank_response_code })),
    { label: 'record payment outcome' });
    res.json(item);
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

router.post('/payment-items/:id/retry', requirePermission('payroll_payment', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payment_item', req.params.id);
    const item = await withRetry(async () => await withTransaction(db, async () =>
      await pay.retryItem(db, Number(req.params.id), Number(req.body.target_batch_id), req.userContext, req.body.note)),
    { label: 'retry payment item' });
    res.status(201).json(item);
  } catch (err) { return sendPayError(res, err); } finally { db.close(); }
});

router.get('/periods/:periodId/payment-reconciliation', requirePermission('payroll_payment', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.periodId);
    res.json(await pay.reconcilePayment(db, Number(req.params.periodId)));
  } catch (err) { if (!sendScopeError(res, err)) throw err; } finally { db.close(); }
});

module.exports = router;
