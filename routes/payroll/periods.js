// routes/payroll/periods.js — Phase 2A: Payroll Group & Payroll Period
//
// SCOPE LOCK: no calculation. This module defines WHEN payroll happens and
// WHO is in which regime. Salary, BPJS, tax, overtime value, gross and net
// are all out of scope and belong to the future Payroll Run module.
//
// Permission module: `payroll_run` (new in Phase 2A). Deliberately separate
// from `payroll_config` so "may configure rules" and "may open/close a
// payroll cycle" can be held by different people — segregation of duties.

const express = require('express');
const { getDb, withTransaction, withRetry } = require('../../database/init-db');
const { requirePermission } = require('../../middleware/permissions');
const scope = require('../../lib/entityScope');
const { logConfigChange, getConfigHistory } = require('../../lib/configAudit');
const pp = require('../../lib/payrollPeriod');

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
const DOMAIN_GROUP = 'payroll_group';
const DOMAIN_PERIOD = 'payroll_period';

const GROUP_FIELDS = [
  'code', 'name', 'legal_entity_id', 'project_code', 'frequency', 'periods_per_year',
  'work_calendar_id', 'attendance_cutoff_offset_days', 'overtime_cutoff_offset_days',
  'adjustment_cutoff_offset_days', 'payment_offset_days',
];

// ============================================================
// PAYROLL GROUPS
// ============================================================

router.get('/groups', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const sc = await scope.scopeClause(db, req.userContext, 'legal_entity_id',
      { resourceType: 'payroll_group', route: req.originalUrl });
    const sql = req.query.include_superseded === 'true'
      ? `SELECT * FROM payroll_groups WHERE ${sc.sql} ORDER BY code ASC, effective_from DESC`
      : `SELECT * FROM payroll_groups WHERE effective_to IS NULL AND ${sc.sql} ORDER BY code ASC`;
    res.json(await db.prepare(sql).all(...sc.params));
  } finally { db.close(); }
});

router.get('/groups/:id/history', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try { res.json(await getConfigHistory(db, DOMAIN_GROUP, req.params.id)); } finally { db.close(); }
});

/** Who is in this group during a window — one row per employee, never per day. */
router.get('/groups/:id/membership', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'VALIDATION', message: 'from dan to wajib diisi.' });
    res.json(await pp.getGroupMembership(db, Number(req.params.id), from, to));
  } finally { db.close(); }
});

router.post('/groups', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.code || !b.name || !b.legal_entity_id || !b.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'code, name, legal_entity_id, effective_from wajib diisi.' });
    }
    if (!await db.prepare('SELECT id FROM legal_entities WHERE id = ?').get(b.legal_entity_id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Legal entity tidak ditemukan.' });
    }

    const params = {
      code: String(b.code).trim().toUpperCase(),
      name: b.name,
      legal_entity_id: b.legal_entity_id,
      project_code: b.project_code || null,
      frequency: b.frequency || 'monthly',
      periods_per_year: b.periods_per_year !== undefined ? Number(b.periods_per_year) : 12,
      work_calendar_id: b.work_calendar_id || null,
      attendance_cutoff_offset_days: Number(b.attendance_cutoff_offset_days ?? 0),
      overtime_cutoff_offset_days: Number(b.overtime_cutoff_offset_days ?? 0),
      adjustment_cutoff_offset_days: Number(b.adjustment_cutoff_offset_days ?? 2),
      payment_offset_days: Number(b.payment_offset_days ?? 5),
      effective_from: b.effective_from,
      created_by: req.userContext.displayName,
    };

    const id = await withRetry(async () => await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO payroll_groups (${GROUP_FIELDS.join(', ')}, effective_from, created_by)
        VALUES (${GROUP_FIELDS.map((f) => `@${f}`).join(', ')}, @effective_from, @created_by) RETURNING id
      `).run(params);
      await logConfigChange(db, {
        domain: DOMAIN_GROUP, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName, newValue: params,
      });
      return info.lastInsertRowid;
    }), { label: 'create payroll group' });

    res.status(201).json({ id });
  } finally { db.close(); }
});

/** Revise: close the current version, open a new one. History is never mutated. */
router.post('/groups/:id/revise', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const current = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
    if (current.effective_to !== null) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Versi ini sudah ditutup.' });
    }
    const b = req.body;
    if (!b.effective_from || b.effective_from <= current.effective_from) {
      return res.status(400).json({ error: 'VALIDATION', message: 'effective_from harus setelah ' + current.effective_from + '.' });
    }

    const merged = { created_by: req.userContext.displayName, effective_from: b.effective_from };
    for (const f of GROUP_FIELDS) merged[f] = (b[f] !== undefined && b[f] !== '') ? b[f] : current[f];
    merged.code = current.code;   // code identifies the group; never revised

    const id = await withRetry(async () => await withTransaction(db, async () => {
      await db.prepare(`UPDATE payroll_groups SET effective_to = kahe_date_add(?::date, -1), status = 'superseded' WHERE id = ?`)
        .run(b.effective_from, current.id);
      const info = await db.prepare(`
        INSERT INTO payroll_groups (${GROUP_FIELDS.join(', ')}, effective_from, created_by)
        VALUES (${GROUP_FIELDS.map((f) => `@${f}`).join(', ')}, @effective_from, @created_by) RETURNING id
      `).run(merged);
      await logConfigChange(db, {
        domain: DOMAIN_GROUP, recordId: info.lastInsertRowid, action: 'update',
        changedBy: req.userContext.displayName, oldValue: current, newValue: merged,
      });
      return info.lastInsertRowid;
    }), { label: 'revise payroll group' });

    res.status(201).json({ id });
  } finally { db.close(); }
});

// ============================================================
// PAYROLL PERIODS
// ============================================================

router.get('/periods', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { group_id, year, status } = req.query;
    const sc = await scope.scopeClause(db, req.userContext, 'g.legal_entity_id',
      { resourceType: 'payroll_period', route: req.originalUrl });
    let sql = `SELECT p.*, g.code AS group_code, g.legal_entity_id
               FROM payroll_periods p JOIN payroll_groups g ON g.id = p.payroll_group_id WHERE ${sc.sql}`;
    const params = [...sc.params];
    if (group_id) { sql += ' AND p.payroll_group_id = ?'; params.push(group_id); }
    if (year) { sql += ' AND p.period_year = ?'; params.push(year); }
    if (status) { sql += ' AND p.status = ?'; params.push(status); }
    sql += ' ORDER BY p.period_year DESC, p.period_sequence DESC';
    res.json(await db.prepare(sql).all(...params));
  } finally { db.close(); }
});

router.get('/periods/:id', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    await guard(db, req, 'payroll_period', req.params.id);
    const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
    if (!period) return res.status(404).json({ error: 'NOT_FOUND' });
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    period.streams = {
      attendance: pp.isStreamOpen(period, pp.STREAMS.ATTENDANCE, asOf),
      overtime: pp.isStreamOpen(period, pp.STREAMS.OVERTIME, asOf),
      adjustment: pp.isStreamOpen(period, pp.STREAMS.ADJUSTMENT, asOf),
    };
    period.allowed_transitions = pp.ALLOWED_TRANSITIONS[period.status] || [];
    res.json(period);
  } finally { db.close(); }
});

router.get('/periods/:id/history', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try { res.json(await getConfigHistory(db, DOMAIN_PERIOD, req.params.id)); } finally { db.close(); }
});

/**
 * Create a period. Dates are DERIVED from the group's offset policy unless
 * explicitly supplied, so no company-specific date is hardcoded anywhere.
 * Idempotent by design: re-creating the same group/year/sequence returns the
 * existing period rather than erroring or duplicating.
 */
router.post('/periods', requirePermission('payroll_run', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.payroll_group_id || !b.period_year || !b.period_sequence) {
      return res.status(400).json({ error: 'VALIDATION', message: 'payroll_group_id, period_year, period_sequence wajib diisi.' });
    }
    const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(b.payroll_group_id);
    if (!group) return res.status(404).json({ error: 'NOT_FOUND', message: 'Payroll group tidak ditemukan.' });

    // IDEMPOTENCY: the unique index would reject a duplicate, but returning
    // the existing row makes a retried request safe for the future engine.
    const existing = await db.prepare(
      'SELECT * FROM payroll_periods WHERE payroll_group_id = ? AND period_year = ? AND period_sequence = ?'
    ).get(b.payroll_group_id, b.period_year, b.period_sequence);
    if (existing) return res.status(200).json({ id: existing.id, idempotent: true, period: existing });

    let periodStart = b.period_start;
    let periodEnd = b.period_end;
    if (!periodStart || !periodEnd) {
      if (group.frequency !== 'monthly') {
        return res.status(400).json({
          error: 'VALIDATION',
          message: `period_start dan period_end wajib diisi untuk frekuensi ${group.frequency} (derivasi otomatis hanya untuk monthly).`,
        });
      }
      const w = pp.monthlyWindow(b.period_year, b.period_sequence);
      periodStart = w.periodStart; periodEnd = w.periodEnd;
    }
    if (periodEnd < periodStart) {
      return res.status(400).json({ error: 'VALIDATION', message: 'period_end tidak boleh sebelum period_start.' });
    }

    const clash = await pp.findOverlappingPeriod(db, group.id, periodStart, periodEnd);
    if (clash) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Periode bertumpang tindih dengan periode yang sudah ada (${clash.period_start} s/d ${clash.period_end}).`,
      });
    }

    const dates = pp.deriveDates(group, periodStart, periodEnd);
    const params = {
      payroll_group_id: group.id,
      period_year: Number(b.period_year),
      period_sequence: Number(b.period_sequence),
      period_month: group.frequency === 'monthly' ? Number(b.period_sequence) : (b.period_month ?? null),
      ...dates,
      // explicit overrides win over the derived policy, when supplied
      attendance_cutoff: b.attendance_cutoff || dates.attendance_cutoff,
      overtime_cutoff: b.overtime_cutoff || dates.overtime_cutoff,
      adjustment_cutoff: b.adjustment_cutoff || dates.adjustment_cutoff,
      payment_date: b.payment_date || dates.payment_date,
      created_by: req.userContext.displayName,
    };

    const id = await withRetry(async () => await withTransaction(db, async () => {
      const info = await db.prepare(`
        INSERT INTO payroll_periods (
          payroll_group_id, period_year, period_sequence, period_month,
          period_start, period_end, attendance_cutoff, overtime_cutoff,
          adjustment_cutoff, payment_date, created_by
        ) VALUES (
          @payroll_group_id, @period_year, @period_sequence, @period_month,
          @period_start, @period_end, @attendance_cutoff, @overtime_cutoff,
          @adjustment_cutoff, @payment_date, @created_by
        ) RETURNING id
      `).run(params);
      await logConfigChange(db, {
        domain: DOMAIN_PERIOD, recordId: info.lastInsertRowid, action: 'create',
        changedBy: req.userContext.displayName, newValue: params,
      });
      return info.lastInsertRowid;
    }), { label: 'create payroll period' });

    res.status(201).json({ id, ...params });
  } finally { db.close(); }
});

/**
 * Advance the administrative lifecycle. Explicit and audited — a period never
 * transitions itself by the clock. CLOSED requires APPROVE, not just EDIT:
 * closing a period is the gate the future engine finalises against.
 */
router.post('/periods/:id/transition', requirePermission('payroll_run', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
    if (!period) return res.status(404).json({ error: 'NOT_FOUND' });

    const to = String(req.body.to || '').toUpperCase();
    if (!pp.canTransition(period.status, to)) {
      return res.status(400).json({
        error: 'INVALID_TRANSITION',
        message: `Tidak bisa pindah dari ${period.status} ke ${to || '(kosong)'}. Transisi yang diizinkan: ${(pp.ALLOWED_TRANSITIONS[period.status] || []).join(', ') || '(tidak ada)'}.`,
      });
    }
    if (to === pp.PERIOD_STATUS.CLOSED
        && !(req.userContext.permissions.payroll_run || []).includes('APPROVE')) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Menutup payroll period memerlukan izin payroll_run:APPROVE.',
      });
    }

    await withRetry(async () => await withTransaction(db, async () => {
      if (to === pp.PERIOD_STATUS.CLOSED) {
        await db.prepare(`UPDATE payroll_periods SET status = ?, closed_at = kahe_now(), closed_by = ? WHERE id = ?`)
          .run(to, req.userContext.displayName, period.id);
      } else {
        await db.prepare(`UPDATE payroll_periods SET status = ?, closed_at = NULL, closed_by = NULL WHERE id = ?`)
          .run(to, period.id);
      }
      await logConfigChange(db, {
        domain: DOMAIN_PERIOD, recordId: period.id, action: 'update',
        changedBy: req.userContext.displayName,
        oldValue: { status: period.status }, newValue: { status: to },
      });
    }), { label: 'transition payroll period' });

    res.json({ ok: true, from: period.status, to });
  } finally { db.close(); }
});

/**
 * THE question, exposed: which period owns this date for this employee?
 * Read-only; the canonical logic lives in lib/payrollPeriod.js.
 */
router.get('/resolve/:employeeId/:date', requirePermission('payroll_run', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const result = await pp.resolvePeriodForDate(db, req.params.employeeId, req.params.date);
    if (result.period) {
      const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
      result.streams = {
        attendance: pp.isStreamOpen(result.period, pp.STREAMS.ATTENDANCE, asOf),
        overtime: pp.isStreamOpen(result.period, pp.STREAMS.OVERTIME, asOf),
        adjustment: pp.isStreamOpen(result.period, pp.STREAMS.ADJUSTMENT, asOf),
      };
    }
    res.json(result);
  } finally { db.close(); }
});

module.exports = router;
