// routes/payroll-config/work-calendars.js — Domain 8: Work Calendar
// The calendar an employee follows. Scope resolution (assignment -> legal
// entity -> global) lives in lib/dayClassification.js, never here.
const express = require('express');
const { getDb, withTransaction } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange, getConfigHistory } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'work_calendar';

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sql = req.query.include_superseded === 'true'
      ? 'SELECT * FROM work_calendars ORDER BY code ASC, effective_from DESC'
      : 'SELECT * FROM work_calendars WHERE effective_to IS NULL ORDER BY code ASC';
    res.json(await db.prepare(sql).all());
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
    if (!b.code || !b.name || !b.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'code, name, effective_from wajib diisi.' });
    }
    const params = {
      code: String(b.code).trim().toUpperCase(),
      name: b.name,
      legal_entity_id: b.legal_entity_id || null,
      project_code: b.project_code || null,
      effective_from: b.effective_from,
      created_by: req.userContext.displayName,
    };
    const id = await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO work_calendars (code, name, legal_entity_id, project_code, effective_from, created_by)
        VALUES (@code, @name, @legal_entity_id, @project_code, @effective_from, @created_by) RETURNING id
      `).run(params);
      await logConfigChange(db, {
        domain: DOMAIN, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName, newValue: params,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id });
  } finally { db.close(); }
});

/** Revise: close the current version, open a new one. History is never mutated. */
router.post('/:id/revise', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const current = await db.prepare('SELECT * FROM work_calendars WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
    if (current.effective_to !== null) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Versi ini sudah ditutup.' });
    }
    const b = req.body;
    if (!b.effective_from || b.effective_from <= current.effective_from) {
      return res.status(400).json({
        error: 'VALIDATION',
        message: 'effective_from harus setelah ' + current.effective_from + '.',
      });
    }
    const merged = {
      code: current.code,
      name: b.name || current.name,
      legal_entity_id: b.legal_entity_id !== undefined ? (b.legal_entity_id || null) : current.legal_entity_id,
      project_code: b.project_code !== undefined ? (b.project_code || null) : current.project_code,
      effective_from: b.effective_from,
      created_by: req.userContext.displayName,
    };
    const id = await withTransaction(db, async () => {
      await db.prepare(`UPDATE work_calendars SET effective_to = kahe_date_add(?::date, -1), status = 'superseded' WHERE id = ?`)
        .run(b.effective_from, current.id);
      const info = await db.prepare(`
        INSERT INTO work_calendars (code, name, legal_entity_id, project_code, effective_from, created_by)
        VALUES (@code, @name, @legal_entity_id, @project_code, @effective_from, @created_by) RETURNING id
      `).run(merged);
      await logConfigChange(db, {
        domain: DOMAIN, recordId: info.lastInsertRowid, action: 'update',
        changedBy: req.userContext.displayName, oldValue: current, newValue: merged,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id });
  } finally { db.close(); }
});

module.exports = router;
