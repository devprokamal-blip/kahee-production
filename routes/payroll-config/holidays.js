// routes/payroll-config/holidays.js — Domain 4: Holiday Calendar
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'holiday';

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { year } = req.query;
    // Soft-deleted rows are excluded by default but remain queryable so a
    // historical classification stays explainable (Phase 1B requirement 9).
    let sql = 'SELECT * FROM holidays WHERE (is_active = 1 OR ? = 1)';
    const params = [req.query.include_inactive === 'true' ? 1 : 0];
    if (year) { sql += ' AND date LIKE ?'; params.push(`${year}-%`); }
    sql += ' ORDER BY date ASC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

router.post('/', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const { date, name, scope, project_code, holiday_type, work_calendar_id, observed_for } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'VALIDATION', message: 'date dan name wajib diisi.' });

    const info = await db.prepare(`
      INSERT INTO holidays (date, name, scope, project_code, holiday_type, work_calendar_id, observed_for, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(
      date, name, scope || 'national', project_code || null,
      holiday_type || 'PUBLIC_HOLIDAY', work_calendar_id || null, observed_for || null,
      req.userContext.displayName
    );

    await logConfigChange(db, { domain: DOMAIN, recordId: info.lastInsertRowid, action: 'create', changedBy: req.userContext.displayName, newValue: req.body });
    res.status(201).json({ id: info.lastInsertRowid });
  } finally { db.close(); }
});

router.delete('/:id', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const existing = await db.prepare('SELECT * FROM holidays WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
    // Phase 1B: soft delete. A hard DELETE would make an already-classified
    // timesheet row unexplainable ("why was 17 August a holiday?").
    await db.prepare('UPDATE holidays SET is_active = 0 WHERE id = ?').run(req.params.id);
    await logConfigChange(db, { domain: DOMAIN, recordId: req.params.id, action: 'delete', changedBy: req.userContext.displayName, oldValue: existing });
    res.json({ ok: true });
  } finally { db.close(); }
});

module.exports = router;
