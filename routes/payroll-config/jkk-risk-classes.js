// routes/payroll-config/jkk-risk-classes.js — Domain 2: JKK Risk Class rates
const express = require('express');
const { getDb } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange } = require('../../lib/configAudit');
const { withTransaction } = require('../../database/init-db');
const { rateToBp } = require('../../lib/money');

const router = express.Router();
const DOMAIN = 'jkk_risk_class';

// Only the currently-active row per risk_class (end_date IS NULL, or the
// most recent effective_date <= today with no later row superseding it).
router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare(`
      SELECT * FROM jkk_risk_classes
      WHERE end_date IS NULL
      ORDER BY risk_class ASC, effective_date DESC
    `).all());
  } finally { db.close(); }
});

router.get('/all-versions', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare('SELECT * FROM jkk_risk_classes ORDER BY risk_class ASC, effective_date DESC').all());
  } finally { db.close(); }
});

// Audit trail for one risk class across every version row it has ever had —
// reuses config_audit_log directly (same table logConfigChange writes to
// below); no separate audit mechanism is introduced.
router.get('/:riskClass/history', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const versionIds = (await db.prepare('SELECT id FROM jkk_risk_classes WHERE risk_class = ?').all(req.params.riskClass)).map((r) => r.id);
    if (!versionIds.length) return res.json([]);
    const placeholders = versionIds.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT * FROM config_audit_log WHERE domain = 'jkk_risk_class' AND record_id IN (${placeholders})
      ORDER BY changed_at DESC
    `).all(...versionIds.map(String));
    res.json(rows);
  } finally { db.close(); }
});

// Reprice a risk class: close out the current active row (set end_date)
// and insert a new one — never overwrite history.
router.post('/', requirePermission('payroll_config', 'ADMIN'), async (req, res) => {
  const db = getDb();
  try {
    const { risk_class, rate, rate_bp, effective_date, source_note } = req.body;
    if (!risk_class || (rate === undefined && rate_bp === undefined) || !effective_date) {
      return res.status(400).json({ error: 'VALIDATION', message: 'risk_class, rate, effective_date wajib diisi.' });
    }
    // B3: accept a decimal rate (0.0127) from the client, persist basis points (127).
    const rateBp = rate_bp !== undefined ? Number(rate_bp) : rateToBp(rate);

    // B4: closing the old version and opening the new one must be atomic —
    // a failure between them would leave the class with zero open versions,
    // which the B5 index makes unrepresentable but a crash could still strand.
    const newId = await withTransaction(db, async () => {
      const current = await db.prepare(`SELECT * FROM jkk_risk_classes WHERE risk_class = ? AND end_date IS NULL`).get(risk_class);
      if (current) {
        await db.prepare(`UPDATE jkk_risk_classes SET end_date = kahe_date_add(?::date, -1) WHERE id = ?`).run(effective_date, current.id);
      }
      const info = await db.prepare(`
        INSERT INTO jkk_risk_classes (risk_class, rate_bp, effective_date, source_note, created_by)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).run(risk_class, rateBp, effective_date, source_note || null, req.userContext.displayName);

      await logConfigChange(db, {
        domain: DOMAIN, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName, oldValue: current || null,
        newValue: { risk_class, rate_bp: rateBp, effective_date, source_note },
      });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id: newId });
  } finally { db.close(); }
});

module.exports = router;
