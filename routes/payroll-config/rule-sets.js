// routes/payroll-config/rule-sets.js — Domain 3: Payroll Rule Set
// Bundles BPJS/salary-cap rates + the PTKP/TER bracket table + the
// PP 35/2021 overtime multiplier table into one versioned, activatable unit.
const express = require('express');
const { getDb, withTransaction } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const { logConfigChange, getConfigHistory } = require('../../lib/configAudit');

const router = express.Router();
const DOMAIN = 'payroll_rule_set';

// B3: *_bp = integer basis points, *_sen = integer sen. See lib/money.js.
const RULE_FIELDS = [
  'bpjs_kesehatan_rate_employee_bp', 'bpjs_kesehatan_rate_company_bp', 'bpjs_kesehatan_salary_cap_sen',
  'jht_rate_employee_bp', 'jht_rate_company_bp', 'jp_rate_employee_bp', 'jp_rate_company_bp', 'jp_salary_cap_sen',
  'jkm_rate_bp', 'overtime_hourly_divisor', 'overtime_is_taxable', 'overtime_is_bpjs_base',
];

router.get('/', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await db.prepare('SELECT * FROM payroll_rule_sets ORDER BY effective_date DESC').all());
  } finally { db.close(); }
});

router.get('/active', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const ruleSet = await db.prepare(`SELECT * FROM payroll_rule_sets WHERE status = 'active' AND end_date IS NULL ORDER BY effective_date DESC LIMIT 1`).get();
    if (!ruleSet) return res.status(404).json({ error: 'NOT_FOUND', message: 'Belum ada rule set aktif.' });
    ruleSet.ter_rates = await db.prepare('SELECT * FROM ptkp_ter_rates WHERE rule_set_id = ? ORDER BY category, income_min_sen').all(ruleSet.id);
    ruleSet.overtime_rules = await db.prepare('SELECT * FROM overtime_multiplier_rules WHERE rule_set_id = ? ORDER BY day_type, hour_from').all(ruleSet.id);
    res.json(ruleSet);
  } finally { db.close(); }
});

router.get('/:id', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const ruleSet = await db.prepare('SELECT * FROM payroll_rule_sets WHERE id = ?').get(req.params.id);
    if (!ruleSet) return res.status(404).json({ error: 'NOT_FOUND' });
    ruleSet.ter_rates = await db.prepare('SELECT * FROM ptkp_ter_rates WHERE rule_set_id = ? ORDER BY category, income_min_sen').all(ruleSet.id);
    ruleSet.overtime_rules = await db.prepare('SELECT * FROM overtime_multiplier_rules WHERE rule_set_id = ? ORDER BY day_type, hour_from').all(ruleSet.id);
    res.json(ruleSet);
  } finally { db.close(); }
});

router.get('/:id/history', requirePermission('payroll_config', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    res.json(await getConfigHistory(db, DOMAIN, req.params.id));
  } finally { db.close(); }
});

// Create a new DRAFT rule set. ter_rates and overtime_rules are optional
// arrays in the body — if omitted, the client is expected to add them via
// the dedicated sub-endpoints below before activating.
router.post('/', requirePermission('payroll_config', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.name || !b.effective_date) {
      return res.status(400).json({ error: 'VALIDATION', message: 'name dan effective_date wajib diisi.' });
    }
    for (const f of RULE_FIELDS) {
      if (b[f] === undefined) return res.status(400).json({ error: 'VALIDATION', message: `${f} wajib diisi.` });
    }

    // B4: the rule set header plus its ~130 bracket/multiplier rows are one
    // logical unit — a half-inserted TER table would silently mis-tax people.
    const ruleSetId = await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO payroll_rule_sets (
          name, status, effective_date, ${RULE_FIELDS.join(', ')}, created_by
        ) VALUES (
          @name, 'draft', @effective_date, ${RULE_FIELDS.map((f) => `@${f}`).join(', ')}, @created_by
        ) RETURNING id
      `).run({ name: b.name, effective_date: b.effective_date, created_by: req.userContext.displayName,
        ...Object.fromEntries(RULE_FIELDS.map((f) => [f, b[f]])) });

      const id = info.lastInsertRowid;

      if (Array.isArray(b.ter_rates)) {
        const insertTer = db.prepare('INSERT INTO ptkp_ter_rates (rule_set_id, category, income_min_sen, income_max_sen, rate_bp) VALUES (?, ?, ?, ?, ?)');
        for (const row of b.ter_rates) await insertTer.run(id, row.category, row.income_min_sen, row.income_max_sen ?? null, row.rate_bp);
      }
      if (Array.isArray(b.overtime_rules)) {
        const insertOt = db.prepare('INSERT INTO overtime_multiplier_rules (rule_set_id, day_type, hour_from, hour_to, multiplier_bp) VALUES (?, ?, ?, ?, ?)');
        for (const row of b.overtime_rules) await insertOt.run(id, row.day_type, row.hour_from, row.hour_to ?? null, row.multiplier_bp);
      }

      await logConfigChange(db, { domain: DOMAIN, recordId: id, action: 'create', changedBy: req.userContext.displayName, newValue: b });
      return id;
    });
    res.status(201).json({ id: ruleSetId });
  } finally { db.close(); }
});

// Activate a draft: closes out the previously active rule set (sets its
// end_date to the new one's effective_date minus 1 day) and flips status.
// Deliberately gated behind ADMIN, not just EDIT — this changes payroll
// calculations for every employee at once.
router.post('/:id/activate', requirePermission('payroll_config', 'ADMIN'), async (req, res) => {
  const db = getDb();
  try {
    const draft = await db.prepare('SELECT * FROM payroll_rule_sets WHERE id = ?').get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'NOT_FOUND' });
    if (draft.status !== 'draft') return res.status(400).json({ error: 'VALIDATION', message: 'Hanya rule set berstatus draft yang bisa diaktifkan.' });

    // B4: superseding the old rule set and activating the new one must be
    // atomic. Between the two statements the B5 unique index would otherwise
    // be satisfied by ZERO active rule sets — payroll with no rules at all.
    await withTransaction(db, async () => {
      const current = await db.prepare(`SELECT * FROM payroll_rule_sets WHERE status = 'active' AND end_date IS NULL`).get();
      if (current) {
        await db.prepare(`UPDATE payroll_rule_sets SET status = 'superseded', end_date = kahe_date_add(?::date, -1) WHERE id = ?`)
          .run(draft.effective_date, current.id);
      }
      await db.prepare(`UPDATE payroll_rule_sets SET status = 'active' WHERE id = ?`).run(draft.id);

      await logConfigChange(db, {
        domain: DOMAIN, recordId: draft.id, action: 'update', changedBy: req.userContext.displayName,
        oldValue: { ...draft, status: 'draft' }, newValue: { ...draft, status: 'active' },
      });
    });
    res.json({ ok: true });
  } finally { db.close(); }
});

module.exports = router;
