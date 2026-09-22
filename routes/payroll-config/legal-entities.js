// routes/payroll-config/legal-entities.js — Domain 1: Legal Entity Master
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange, getConfigHistory } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'legal_entity';

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare('SELECT * FROM legal_entities ORDER BY name ASC').all());
  } finally { db.close(); }
});

router.get('/:id/history', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await getConfigHistory(db, DOMAIN, req.params.id));
  } finally { db.close(); }
});

router.post('/', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.id || !b.name || !b.entity_type || !b.jkk_risk_class || !b.effective_date) {
      return res.status(400).json({ error: 'VALIDATION', message: 'id, name, entity_type, jkk_risk_class, effective_date wajib diisi.' });
    }
    await db.prepare(`
      INSERT INTO legal_entities (id, name, entity_type, npwp, jkk_risk_class, status, effective_date, created_by)
      VALUES (@id, @name, @entity_type, @npwp, @jkk_risk_class, @status, @effective_date, @created_by)
    `).run({
      id: b.id, name: b.name, entity_type: b.entity_type, npwp: b.npwp || null,
      jkk_risk_class: b.jkk_risk_class, status: b.status || 'active',
      effective_date: b.effective_date, created_by: req.userContext.displayName,
    });
    await logConfigChange(db, { domain: DOMAIN, recordId: b.id, action: 'create', changedBy: req.userContext.displayName, newValue: b });
    res.status(201).json({ id: b.id });
  } finally { db.close(); }
});

router.put('/:id', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const existing = await db.prepare('SELECT * FROM legal_entities WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
    const b = req.body;
    const fields = ['name', 'entity_type', 'npwp', 'jkk_risk_class', 'status', 'effective_date'];
    const sets = fields.map((f) => `${f} = @${f}`).join(', ');
    const params = { id: req.params.id };
    fields.forEach((f) => { params[f] = b[f] !== undefined && b[f] !== '' ? b[f] : existing[f]; });

    await db.prepare(`UPDATE legal_entities SET ${sets}, updated_at = kahe_now() WHERE id = @id`).run(params);
    await logConfigChange(db, { domain: DOMAIN, recordId: req.params.id, action: 'update', changedBy: req.userContext.displayName, oldValue: existing, newValue: params });
    res.json({ ok: true });
  } finally { db.close(); }
});

module.exports = router;
