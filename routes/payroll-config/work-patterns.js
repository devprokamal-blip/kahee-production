// routes/payroll-config/work-patterns.js — Domain 5: Work Patterns (5-day / 6-day week)
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'work_pattern';

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare(`SELECT * FROM work_patterns WHERE status = 'active' ORDER BY days_per_week DESC`).all());
  } finally { db.close(); }
});

router.post('/', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const { name, days_per_week, weekly_rest_day, effective_date } = req.body;
    if (!name || !days_per_week || !effective_date) {
      return res.status(400).json({ error: 'VALIDATION', message: 'name, days_per_week, effective_date wajib diisi.' });
    }
    const info = await db.prepare(`
      INSERT INTO work_patterns (name, days_per_week, weekly_rest_day, effective_date, created_by)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).run(name, days_per_week, weekly_rest_day || 'sunday', effective_date, req.userContext.displayName);

    await logConfigChange(db, { domain: DOMAIN, recordId: info.lastInsertRowid, action: 'create', changedBy: req.userContext.displayName, newValue: req.body });
    res.status(201).json({ id: info.lastInsertRowid });
  } finally { db.close(); }
});

module.exports = router;
