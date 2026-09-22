// routes/attendance-correction.js
// Attendance A3 — correction, void, exception, payroll impact and audit API.
//
// Permission modules (all enforced server-side, never by role name):
//   attendance_correction      VIEW / CREATE (request) / EDIT (review) / APPROVE / REJECT
//   attendance_void            VIEW / CREATE / APPROVE / REJECT
//   attendance_late_correction APPROVE            (a late correction needs this too)
//   attendance_exception       VIEW / EDIT
//   attendance_payroll_impact  VIEW / APPROVE / REJECT   (Payroll Officer gate)
//   attendance_audit           VIEW / EXPORT
//   attendance_sensitive_override  ADMIN — granted to NO role by default
//
// Locks: legal-entity scope on every read and write (A1); requester ≠ approver
// by stable user ID, not role name; finalized payroll is never edited,
// reopened or recalculated — it produces a TIME delta for a Payroll Officer.

const express = require('express');
const { getDb, withTransaction } = require('../database/init-db');
const { requirePermission, hasPermission } = require('../middleware/permissions');
const entityScope = require('../lib/entityScope');
const g = require('../lib/attendanceGuard');
const bt = require('../lib/businessTime');
const ac = require('../lib/attendanceCorrection');
const ex = require('../lib/attendanceException');
const audit = require('../lib/attendanceAudit');

const router = express.Router();
const M = {
  CORRECTION: 'attendance_correction',
  VOID: 'attendance_void',
  LATE: 'attendance_late_correction',
  EXCEPTION: 'attendance_exception',
  IMPACT: 'attendance_payroll_impact',
  AUDIT: 'attendance_audit',
  OVERRIDE: 'attendance_sensitive_override',
};

function handle(fn) {
  return async (req, res, next) => {
    const db = getDb();
    try { await fn(req, res, db); }
    catch (err) {
      if (err instanceof g.AttendanceError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      }
      if (err instanceof entityScope.EntityAccessError) {
        return res.status(err.code === entityScope.ERROR.NOT_FOUND ? 404 : 403).json({ error: err.code, message: err.message });
      }
      const m = String(err && err.message);
      if (m.includes('AUDIT_APPEND_ONLY')) return res.status(409).json({ error: 'AUDIT_APPEND_ONLY', message: m });
      const mapped = g.mapTriggerError ? g.mapTriggerError(err) : null;
      if (mapped) return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
      next(err);
    } finally { db.close(); }
  };
}
const bad = (code, message, detail) => { throw new g.AttendanceError(400, code, message, detail); };
const conflict = (code, message, detail) => { throw new g.AttendanceError(409, code, message, detail); };
const forbid = (code, message, detail) => { throw new g.AttendanceError(403, code, message, detail); };

// =================== POLICIES ===============================================

router.get('/policies', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'p.legal_entity_id', { resourceType: 'correction_policy', route: req.originalUrl });
  const rows = await db.prepare(`SELECT p.* FROM attendance_correction_policies p
    WHERE (${sc.sql} OR p.legal_entity_id IS NULL) ORDER BY p.legal_entity_id, p.effective_from DESC`).all(...sc.params);
  res.json(rows);
}));

function validatePolicy(b) {
  if (!b.code || !b.name) bad('VALIDATION', 'code dan name wajib diisi.');
  const w = Number(b.correction_window);
  if (!Number.isInteger(w) || w < 0 || w > 3650) bad('VALIDATION', 'correction_window harus bilangan bulat 0–3650.');
  if (!g.isValidDate(b.effective_from)) bad('INVALID_DATE', 'effective_from harus YYYY-MM-DD.');
  if (b.evidence_requirement && !['NONE', 'OPTIONAL', 'REQUIRED'].includes(b.evidence_requirement)) {
    bad('VALIDATION', 'evidence_requirement harus NONE/OPTIONAL/REQUIRED.');
  }
}
const POLICY_SQL = `INSERT INTO attendance_correction_policies
  (code,name,legal_entity_id,project_code,correction_window,window_unit,allow_late_correction,late_requires_approval,
   evidence_requirement,post_finalized_evidence_required,additional_approval_required,
   abnormal_duration_ratio_pct,ot_grace_minutes,ot_mismatch_tolerance_minutes,effective_from,note,created_by,created_by_user_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;
const bool = (v, dflt) => (v === undefined || v === null ? dflt : (v === false || v === 0 || v === '0' ? 0 : 1));
async function insertPolicy(db, b, user, { code, legalEntityId, projectCode }) {
  return Number((await db.prepare(POLICY_SQL).run(
    code, b.name, legalEntityId, projectCode || null,
    Number(b.correction_window), b.window_unit || 'DAYS',
    bool(b.allow_late_correction, 1), bool(b.late_requires_approval, 1),
    b.evidence_requirement || 'OPTIONAL', bool(b.post_finalized_evidence_required, 1),
    bool(b.additional_approval_required, 0),
    Number(b.abnormal_duration_ratio_pct || 150), Number(b.ot_grace_minutes ?? 30),
    Number(b.ot_mismatch_tolerance_minutes ?? 15),
    b.effective_from, b.note || null, user.displayName, user.id)).lastInsertRowid);
}

router.post('/policies', requirePermission(M.CORRECTION, 'EDIT'), handle(async (req, res, db) => {
  const b = req.body || {};
  validatePolicy(b);
  if (!b.legal_entity_id) bad('VALIDATION', 'legal_entity_id wajib diisi.');
  await entityScope.assertEntityAccess(db, req.userContext, b.legal_entity_id, { resourceType: 'correction_policy', route: req.originalUrl });
  const open = await db.prepare(`SELECT id FROM attendance_correction_policies
    WHERE legal_entity_id = ? AND effective_to IS NULL`).get(b.legal_entity_id);
  if (open) conflict('POLICY_OPEN_EXISTS', 'Sudah ada kebijakan terbuka untuk entitas ini. Buat versi baru.');
  const id = await insertPolicy(db, b, req.userContext,
    { code: b.code, legalEntityId: b.legal_entity_id, projectCode: b.project_code });
  res.status(201).json({ id });
}));

/** New effective-dated version; the open one closes the day before. */
router.post('/policies/:id/versions', requirePermission(M.CORRECTION, 'EDIT'), handle(async (req, res, db) => {
  const prev = await db.prepare('SELECT * FROM attendance_correction_policies WHERE id = ?').get(req.params.id);
  if (!prev) throw new g.AttendanceError(404, 'NOT_FOUND', 'Kebijakan tidak ditemukan.');
  if (prev.legal_entity_id) {
    await entityScope.assertEntityAccess(db, req.userContext, prev.legal_entity_id, { resourceType: 'correction_policy', route: req.originalUrl });
  }
  const b = { ...prev, ...req.body };
  validatePolicy(b);
  if (b.effective_from <= prev.effective_from) {
    conflict('POLICY_VERSION_OVERLAP', `Versi baru harus mulai setelah ${prev.effective_from}.`);
  }
  if (prev.effective_to && prev.effective_to >= b.effective_from) {
    conflict('POLICY_VERSION_OVERLAP', 'Versi baru bertabrakan dengan versi yang sudah ditutup.');
  }
  const id = await withTransaction(db, async () => {
    if (!prev.effective_to) {
      await db.prepare(`UPDATE attendance_correction_policies SET effective_to = ?, updated_by = ?, updated_by_user_id = ?,
        updated_at = kahe_now() WHERE id = ?`).run(bt.addDays(b.effective_from, -1), req.userContext.displayName, req.userContext.id, prev.id);
    }
    return await insertPolicy(db, b, req.userContext,
      { code: prev.code, legalEntityId: prev.legal_entity_id, projectCode: prev.project_code });
  });
  res.status(201).json({ id, previous_version_closed: bt.addDays(req.body.effective_from, -1) });
}));

router.get('/policies/resolve/:entity/:date', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  await entityScope.assertEntityAccess(db, req.userContext, req.params.entity, { resourceType: 'correction_policy', route: req.originalUrl });
  const r = await ac.resolvePolicy(db, req.params.entity, req.params.date);
  res.json({ status: r.status, policy: r.policy, timing: r.policy ? ac.classifyTiming(r.policy, req.params.date) : null });
}));

// =================== CORRECTION / VOID REQUESTS =============================

async function loadEntry(db, req, entryId) {
  const entry = await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(entryId);
  if (!entry) throw new g.AttendanceError(404, 'NOT_FOUND', 'Absensi tidak ditemukan.');
  await g.assertEmployeeInScope(db, req.userContext, entry.employee_id, entry.work_date, req.originalUrl);
  return entry;
}
const nextNo = async (db, type) => {
  const prefix = type === ac.REQUEST_TYPE.VOID ? 'VD' : 'CR';
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM attendance_corrections WHERE request_type = ?').get(type)).n + 1;
  return `${prefix}-${String(n).padStart(6, '0')}`;
};
const loadRequest = async (db, req, id, module = M.CORRECTION) => {
  const row = await db.prepare('SELECT * FROM attendance_corrections WHERE id = ?').get(id);
  if (!row) throw new g.AttendanceError(404, 'NOT_FOUND', 'Permintaan tidak ditemukan.');
  await entityScope.assertEntityAccess(db, req.userContext, row.legal_entity_id, { resourceType: module, resourceId: row.id, route: req.originalUrl });
  return row;
};

/**
 * Create a correction or void request.
 *
 * The request carries WHAT is proposed; the derived payroll-authoritative
 * values (worked minutes, OT) are projected server-side from the record's own
 * A2 schedule snapshot, never accepted from the client.
 */
router.post('/requests', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const b = req.body || {};
  const type = b.request_type === ac.REQUEST_TYPE.VOID ? ac.REQUEST_TYPE.VOID : ac.REQUEST_TYPE.CORRECTION;
  const needed = type === ac.REQUEST_TYPE.VOID ? M.VOID : M.CORRECTION;
  if (!hasPermission(req.userContext, needed, 'CREATE')) forbid('FORBIDDEN', `Access denied for ${needed}:CREATE.`);
  if (!b.reason_code || !ac.REASON_CODES.includes(b.reason_code)) {
    bad('INVALID_REASON_CODE', `reason_code harus salah satu dari ${ac.REASON_CODES.join(', ')}.`);
  }
  if (!b.timesheet_entry_id) bad('VALIDATION', 'timesheet_entry_id wajib diisi.');
  const entry = await loadEntry(db, req, b.timesheet_entry_id);
  if (entry.record_status === 'VOIDED') conflict('ENTRY_VOIDED', 'Absensi ini sudah dibatalkan (void).');

  const entity = entry.legal_entity_id || await g.entityForEmployeeOn(db, entry.employee_id, entry.work_date);
  const { policy, status: pstatus } = await ac.resolvePolicy(db, entity, entry.work_date);
  if (pstatus === 'AMBIGUOUS_POLICY') conflict('AMBIGUOUS_POLICY', 'Lebih dari satu kebijakan koreksi berlaku untuk tanggal ini.');
  if (!policy) conflict('NO_CORRECTION_POLICY', 'Belum ada kebijakan koreksi yang berlaku untuk entitas/tanggal ini.');

  const timing = ac.classifyTiming(policy, entry.work_date);
  if (timing.isLate && !policy.allow_late_correction) {
    conflict('LATE_CORRECTION_NOT_ALLOWED',
      `Kebijakan tidak mengizinkan koreksi setelah ${timing.deadline}.`, { deadline: timing.deadline });
  }
  if (timing.isLate && !b.late_reason) bad('LATE_REASON_REQUIRED', 'Alasan keterlambatan koreksi wajib diisi.');

  const proposed = type === ac.REQUEST_TYPE.VOID ? {} : (b.proposed_values || {});
  if (type === ac.REQUEST_TYPE.CORRECTION && !Object.keys(proposed).length) {
    bad('VALIDATION', 'proposed_values wajib diisi untuk koreksi.');
  }
  for (const k of Object.keys(proposed)) {
    if (!ac.CORRECTABLE_FIELDS.includes(k) && k !== 'work_minutes') {
      bad('FIELD_NOT_CORRECTABLE', `Field ${k} tidak dapat dikoreksi melalui alur ini.`);
    }
  }
  const projection = type === ac.REQUEST_TYPE.VOID ? ac.projectVoid(entry) : ac.projectCorrection(entry, proposed);
  if (projection.error) bad(projection.error, `Koreksi tidak dapat dihitung (${projection.error}).`);
  const before = ac.entrySnapshot(entry);
  const impact = await ac.classifyPayrollImpact(db, {
    employeeId: entry.employee_id, workDate: entry.work_date, legalEntityId: entity,
    before, after: projection.after,
  });

  // Evidence policy: required in general, and/or required once payroll is finalized.
  const evidenceNeeded = policy.evidence_requirement === 'REQUIRED'
    || (policy.post_finalized_evidence_required && impact.impact === ac.IMPACT.ADJUSTMENT);
  if (evidenceNeeded && !(b.evidence_ref || b.evidence_note)) {
    bad('EVIDENCE_REQUIRED', 'Kebijakan mewajibkan bukti pendukung untuk koreksi ini.');
  }

  const submit = b.submit !== false;
  const status = !submit ? ac.STATUS.DRAFT
    : (type === ac.REQUEST_TYPE.VOID ? ac.STATUS.VOID_REQUESTED : ac.STATUS.SUBMITTED);
  const user = req.userContext;
  const role = audit.roleSnapshot(user);

  const id = await withTransaction(db, async () => {
    const newId = Number((await db.prepare(`INSERT INTO attendance_corrections
      (request_no,request_type,timesheet_entry_id,employee_id,legal_entity_id,work_date,status,policy_id,policy_snapshot,
       is_late_correction,late_reason,reason_code,reason_text,evidence_type,evidence_ref,evidence_note,
       before_values,proposed_values,delta_values,payroll_impact,payroll_period_id,payroll_run_id,
       requested_by_user_id,requested_by_name,requested_by_role,requested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,kahe_now()) RETURNING id`).run(
      await nextNo(db, type), type, entry.id, entry.employee_id, entity, entry.work_date, status, policy.id,
      JSON.stringify({ ...policy, resolved_for: entry.work_date, timing }),
      timing.isLate ? 1 : 0, b.late_reason || null, b.reason_code, b.reason_text || null,
      b.evidence_type || null, b.evidence_ref || null, b.evidence_note || null,
      JSON.stringify(before), JSON.stringify(proposed),
      JSON.stringify(ac.timeDelta(before, projection.after)), impact.impact, impact.periodId, impact.runId,
      user.id, user.displayName, role)).lastInsertRowid);

    await audit.recordAction(db, newId, { action: 'CREATED', user, permission: `${needed}:CREATE`,
      reasonCode: b.reason_code, reason: b.reason_text, toStatus: status });
    await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
      legalEntityId: entity, eventType: audit.EVENTS.CORRECTION_CREATED, user, permission: `${needed}:CREATE`,
      targetType: type, targetId: newId, correctionId: newId, reasonCode: b.reason_code, reason: b.reason_text,
      oldValues: before, newValues: projection.after, delta: ac.timeDelta(before, projection.after), result: status });
    if (submit) {
      await audit.recordAction(db, newId, { action: type === ac.REQUEST_TYPE.VOID ? 'VOID_REQUESTED' : 'SUBMITTED',
        user, permission: `${needed}:CREATE`, fromStatus: ac.STATUS.DRAFT, toStatus: status });
      await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
        legalEntityId: entity, eventType: type === ac.REQUEST_TYPE.VOID ? audit.EVENTS.VOID_REQUESTED : audit.EVENTS.CORRECTION_SUBMITTED,
        user, permission: `${needed}:CREATE`, correctionId: newId, targetType: type, targetId: newId, result: status });
    }
    if (impact.impact !== ac.IMPACT.NONE) {
      await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
        legalEntityId: entity, eventType: audit.EVENTS.PAYROLL_IMPACT_DETECTED, user, correctionId: newId,
        targetType: type, targetId: newId, result: impact.impact, delta: ac.timeDelta(before, projection.after) });
    }
    if (timing.isLate) {
      await upsertException(db, {
        entry, entity, type: ex.TYPES.LATE_CORRECTION, severity: 'MEDIUM',
        detail: { correction_id: newId, deadline: timing.deadline, age_days: timing.ageDays, late_reason: b.late_reason },
        correctionId: newId, user,
      });
    }
    if (impact.impact === ac.IMPACT.ADJUSTMENT) {
      await upsertException(db, {
        entry, entity, type: ex.TYPES.PAYROLL_ADJUSTMENT_REQUIRED, severity: 'HIGH',
        detail: { correction_id: newId, payroll_run_id: impact.runId }, correctionId: newId, user,
      });
    }
    return newId;
  });

  res.status(201).json({
    id, request_no: (await db.prepare('SELECT request_no FROM attendance_corrections WHERE id = ?').get(id)).request_no,
    status, payroll_impact: impact.impact, is_late_correction: timing.isLate,
    deadline: timing.deadline, delta: ac.timeDelta(before, projection.after),
    projected: projection.after,
  });
}));

router.get('/requests', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'c.legal_entity_id', { resourceType: 'attendance_correction', route: req.originalUrl });
  const params = [...sc.params];
  let sql = `SELECT c.*, e.full_name FROM attendance_corrections c
             JOIN employees e ON e.id = c.employee_id WHERE ${sc.sql}`;
  if (req.query.status) { sql += ' AND c.status = ?'; params.push(req.query.status); }
  if (req.query.type) { sql += ' AND c.request_type = ?'; params.push(req.query.type); }
  if (req.query.employee_id) { sql += ' AND c.employee_id = ?'; params.push(req.query.employee_id); }
  if (req.query.impact) { sql += ' AND c.payroll_impact = ?'; params.push(req.query.impact); }
  if (req.query.late === '1') sql += ' AND c.is_late_correction = 1';
  // Approval inbox: only what this actor may actually act on, and never their own.
  if (req.query.inbox === '1') {
    const canApprove = hasPermission(req.userContext, M.CORRECTION, 'APPROVE');
    const canVoid = hasPermission(req.userContext, M.VOID, 'APPROVE');
    const canPayroll = hasPermission(req.userContext, M.IMPACT, 'APPROVE');
    const open = [];
    if (canApprove) open.push(`'${ac.STATUS.SUBMITTED}'`, `'${ac.STATUS.UNDER_REVIEW}'`);
    if (canVoid) open.push(`'${ac.STATUS.VOID_REQUESTED}'`, `'${ac.STATUS.VOID_REVIEWED}'`);
    if (canPayroll) open.push(`'${ac.STATUS.PENDING_PAYROLL_REVIEW}'`);
    if (!open.length) return res.json([]);
    sql += ` AND c.status IN (${open.join(',')}) AND (c.requested_by_user_id IS NULL OR c.requested_by_user_id != ?)`;
    params.push(req.userContext.id);
  }
  sql += ' ORDER BY c.created_at DESC, c.id DESC';
  res.json((await db.prepare(sql).all(...params)).map((r) => ({
    ...r, age_days: bt.daysBetween(r.work_date, bt.businessToday()),
  })));
}));

router.get('/requests/:id', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id);
  res.json({
    ...row,
    before_values: row.before_values ? JSON.parse(row.before_values) : null,
    proposed_values: row.proposed_values ? JSON.parse(row.proposed_values) : null,
    after_values: row.after_values ? JSON.parse(row.after_values) : null,
    delta_values: row.delta_values ? JSON.parse(row.delta_values) : null,
    approval_history: await db.prepare('SELECT * FROM attendance_correction_actions WHERE correction_id = ? ORDER BY id').all(row.id),
    exceptions: await db.prepare('SELECT * FROM attendance_exceptions WHERE correction_id = ?').all(row.id),
    payroll_queue: await db.prepare('SELECT * FROM attendance_payroll_adjustments WHERE correction_id = ?').all(row.id),
  });
}));

router.post('/requests/:id/submit', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id);
  const module = row.request_type === ac.REQUEST_TYPE.VOID ? M.VOID : M.CORRECTION;
  if (!hasPermission(req.userContext, module, 'CREATE')) forbid('FORBIDDEN', `Access denied for ${module}:CREATE.`);
  if (row.status !== ac.STATUS.DRAFT) conflict('INVALID_TRANSITION', `Hanya DRAFT yang dapat disubmit (status: ${row.status}).`);
  const to = row.request_type === ac.REQUEST_TYPE.VOID ? ac.STATUS.VOID_REQUESTED : ac.STATUS.SUBMITTED;
  await withTransaction(db, async () => {
    await setStatus(db, row, to);
    await audit.recordAction(db, row.id, { action: 'SUBMITTED', user: req.userContext, permission: `${module}:CREATE`,
      fromStatus: row.status, toStatus: to });
    await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
      legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.CORRECTION_SUBMITTED, user: req.userContext,
      permission: `${module}:CREATE`, correctionId: row.id, targetType: row.request_type, targetId: row.id, result: to });
  });
  res.json({ ok: true, status: to });
}));

router.post('/requests/:id/review', requirePermission(M.CORRECTION, 'EDIT'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id);
  const isVoid = row.request_type === ac.REQUEST_TYPE.VOID;
  const from = isVoid ? ac.STATUS.VOID_REQUESTED : ac.STATUS.SUBMITTED;
  const to = isVoid ? ac.STATUS.VOID_REVIEWED : ac.STATUS.UNDER_REVIEW;
  if (row.status !== from) conflict('INVALID_TRANSITION', `Status ${row.status} tidak dapat direview.`);
  await withTransaction(db, async () => {
    assertTransitioned(await db.prepare(`UPDATE attendance_corrections SET status = ?, reviewed_by_user_id = ?, reviewed_by_name = ?,
      reviewed_by_role = ?, reviewed_at = kahe_now(), updated_at = kahe_now() WHERE id = ? AND status = ?`)
      .run(to, req.userContext.id, req.userContext.displayName, audit.roleSnapshot(req.userContext), row.id, expectedStatus(row)), row, to);
    await audit.recordAction(db, row.id, { action: isVoid ? 'VOID_REVIEWED' : 'REVIEWED', user: req.userContext,
      permission: `${M.CORRECTION}:EDIT`, reason: req.body && req.body.note, fromStatus: row.status, toStatus: to });
    await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
      legalEntityId: row.legal_entity_id, eventType: isVoid ? audit.EVENTS.VOID_REVIEWED : audit.EVENTS.CORRECTION_REVIEWED,
      user: req.userContext, permission: `${M.CORRECTION}:EDIT`, correctionId: row.id, targetType: row.request_type,
      targetId: row.id, result: to });
  });
  res.json({ ok: true, status: to });
}));

router.post('/requests/:id/cancel', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id);
  if (row.requested_by_user_id !== req.userContext.id) forbid('NOT_REQUESTER', 'Hanya pengaju yang dapat membatalkan permintaan.');
  const cancellable = [ac.STATUS.DRAFT, ac.STATUS.SUBMITTED, ac.STATUS.UNDER_REVIEW, ac.STATUS.VOID_REQUESTED, ac.STATUS.VOID_REVIEWED];
  if (!cancellable.includes(row.status)) conflict('INVALID_TRANSITION', `Status ${row.status} tidak dapat dibatalkan.`);
  await withTransaction(db, async () => {
    await setStatus(db, row, ac.STATUS.CANCELLED);
    await audit.recordAction(db, row.id, { action: 'CANCELLED', user: req.userContext, reason: req.body && req.body.reason,
      fromStatus: row.status, toStatus: ac.STATUS.CANCELLED });
    await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
      legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.CORRECTION_CANCELLED, user: req.userContext,
      correctionId: row.id, targetType: row.request_type, targetId: row.id, result: ac.STATUS.CANCELLED });
  });
  res.json({ ok: true, status: ac.STATUS.CANCELLED });
}));

/**
 * Attendance decision. SoD: the requester can never approve their own request,
 * by stable user ID — renaming a role cannot bypass it, and no override
 * permission unlocks it.
 */
router.post('/requests/:id/decide', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id);
  const decision = req.body && req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) bad('VALIDATION', 'decision harus approved atau rejected.');
  const isVoid = row.request_type === ac.REQUEST_TYPE.VOID;
  const module = isVoid ? M.VOID : M.CORRECTION;
  const action = decision === 'approved' ? 'APPROVE' : 'REJECT';
  if (!hasPermission(req.userContext, module, action)) forbid('FORBIDDEN', `Access denied for ${module}:${action}.`);
  // A late correction needs the dedicated higher approval on top.
  if (row.is_late_correction && decision === 'approved') {
    const policy = row.policy_snapshot ? JSON.parse(row.policy_snapshot) : null;
    if ((!policy || policy.late_requires_approval) && !hasPermission(req.userContext, M.LATE, 'APPROVE')) {
      forbid('LATE_APPROVAL_REQUIRED', `Koreksi terlambat memerlukan ${M.LATE}:APPROVE.`);
    }
  }
  const openStates = isVoid ? [ac.STATUS.VOID_REQUESTED, ac.STATUS.VOID_REVIEWED] : [ac.STATUS.SUBMITTED, ac.STATUS.UNDER_REVIEW];
  if (!openStates.includes(row.status)) conflict('INVALID_TRANSITION', `Status ${row.status} tidak dapat diputuskan.`);
  if (row.requested_by_user_id === req.userContext.id) {
    forbid('SOD_VIOLATION', 'Pengaju tidak dapat menyetujui permintaannya sendiri.');
  }

  if (decision === 'rejected') {
    const to = isVoid ? ac.STATUS.VOID_REJECTED : ac.STATUS.REJECTED;
    await withTransaction(db, async () => {
      await decide(db, row, to, req.userContext);
      await audit.recordAction(db, row.id, { action: isVoid ? 'VOID_REJECTED' : 'REJECTED', result: 'rejected',
        user: req.userContext, permission: `${module}:REJECT`, reason: req.body.reason, fromStatus: row.status, toStatus: to });
      await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
        legalEntityId: row.legal_entity_id, eventType: isVoid ? audit.EVENTS.VOID_REJECTED : audit.EVENTS.CORRECTION_REJECTED,
        user: req.userContext, permission: `${module}:REJECT`, correctionId: row.id, targetType: row.request_type,
        targetId: row.id, reason: req.body.reason, result: to });
    });
    return res.json({ ok: true, status: to });
  }

  // Approved: re-project against the CURRENT record (it may have moved since
  // the request was raised) and re-classify the payroll impact.
  const entry = await db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(row.timesheet_entry_id);
  if (!entry) throw new g.AttendanceError(404, 'NOT_FOUND', 'Absensi sumber tidak ditemukan.');
  const proposed = row.proposed_values ? JSON.parse(row.proposed_values) : {};
  const projection = isVoid ? ac.projectVoid(entry) : ac.projectCorrection(entry, proposed);
  if (projection.error) bad(projection.error, `Koreksi tidak dapat dihitung (${projection.error}).`);
  const before = ac.entrySnapshot(entry);
  const impact = await ac.classifyPayrollImpact(db, {
    employeeId: entry.employee_id, workDate: entry.work_date, legalEntityId: row.legal_entity_id,
    before, after: projection.after,
  });
  const delta = ac.timeDelta(before, projection.after);
  const approvedStatus = isVoid ? ac.STATUS.VOID_APPROVED : ac.STATUS.APPROVED;

  const result = await withTransaction(db, async () => {
    await decide(db, row, approvedStatus, req.userContext);
    await db.prepare(`UPDATE attendance_corrections SET payroll_impact = ?, payroll_period_id = ?, payroll_run_id = ?,
      after_values = ?, delta_values = ?, updated_at = kahe_now() WHERE id = ?`)
      .run(impact.impact, impact.periodId, impact.runId, JSON.stringify(projection.after), JSON.stringify(delta), row.id);
    await audit.recordAction(db, row.id, { action: isVoid ? 'VOID_APPROVED' : 'APPROVED', result: 'approved',
      user: req.userContext, permission: `${module}:APPROVE`, reason: req.body.reason,
      fromStatus: row.status, toStatus: approvedStatus });
    await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
      legalEntityId: row.legal_entity_id, eventType: isVoid ? audit.EVENTS.VOID_APPROVED : audit.EVENTS.CORRECTION_APPROVED,
      user: req.userContext, permission: `${module}:APPROVE`, correctionId: row.id, targetType: row.request_type,
      targetId: row.id, oldValues: before, newValues: projection.after, delta, result: approvedStatus });
    if (row.is_late_correction) {
      await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
        legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.LATE_CORRECTION_APPROVED, user: req.userContext,
        permission: `${M.LATE}:APPROVE`, correctionId: row.id, targetId: row.id, reason: row.late_reason, result: approvedStatus });
    }

    // Finalized payroll (or a frozen source) must NOT be edited here. The
    // correction stops at a TIME delta awaiting the Payroll Officer.
    if (impact.impact === ac.IMPACT.ADJUSTMENT || impact.impact === ac.IMPACT.FROZEN) {
      await writeVersion(db, entry, {
        versionType: isVoid ? 'VOID' : 'CORRECTION', correctionId: row.id, payload: projection.after,
        appliedToSource: 0, isEffective: 0, user: req.userContext, reasonCode: row.reason_code, reason: row.reason_text,
      });
      await setStatus(db, row, ac.STATUS.PENDING_PAYROLL_REVIEW);
      await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
        legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.PAYROLL_REVIEW_REQUESTED, user: req.userContext,
        correctionId: row.id, targetId: row.id, delta, result: impact.impact });
      await upsertException(db, { entry, entity: row.legal_entity_id, type: ex.TYPES.PAYROLL_ADJUSTMENT_REQUIRED,
        severity: 'HIGH', detail: { correction_id: row.id, impact: impact.impact, delta }, correctionId: row.id, user: req.userContext });
      return { status: ac.STATUS.PENDING_PAYROLL_REVIEW, applied: false, impact: impact.impact, delta };
    }

    await applyToSource(db, { row, entry, after: projection.after, isVoid, user: req.userContext, delta, before });
    return { status: isVoid ? ac.STATUS.VOIDED : ac.STATUS.APPLIED, applied: true, impact: impact.impact, delta };
  });
  res.json({ ok: true, ...result });
}));

/** Payroll Officer gate. Cannot be reached before the attendance approval. */
router.post('/requests/:id/payroll-review', requirePermission(M.IMPACT, 'VIEW'), handle(async (req, res, db) => {
  const row = await loadRequest(db, req, req.params.id, M.IMPACT);
  const decision = req.body && req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) bad('VALIDATION', 'decision harus approved atau rejected.');
  const action = decision === 'approved' ? 'APPROVE' : 'REJECT';
  if (!hasPermission(req.userContext, M.IMPACT, action)) forbid('FORBIDDEN', `Access denied for ${M.IMPACT}:${action}.`);
  if (row.status !== ac.STATUS.PENDING_PAYROLL_REVIEW) {
    conflict('PAYROLL_REVIEW_NOT_PENDING',
      `Permintaan harus disetujui Attendance lebih dulu (status saat ini: ${row.status}).`);
  }
  if (row.requested_by_user_id === req.userContext.id) {
    forbid('SOD_VIOLATION', 'Pengaju tidak dapat menyetujui dampak payroll atas permintaannya sendiri.');
  }
  const delta = row.delta_values ? JSON.parse(row.delta_values) : {};
  const to = decision === 'approved' ? ac.STATUS.QUEUED_FOR_PAYROLL : ac.STATUS.PAYROLL_REJECTED;

  await withTransaction(db, async () => {
    assertTransitioned(await db.prepare(`UPDATE attendance_corrections SET status = ?, payroll_reviewed_by_user_id = ?, payroll_reviewed_by_name = ?,
      payroll_reviewed_by_role = ?, payroll_reviewed_at = kahe_now(), payroll_review_result = ?,
      updated_at = kahe_now() WHERE id = ? AND status = ?`).run(
      to, req.userContext.id, req.userContext.displayName, audit.roleSnapshot(req.userContext), decision, row.id, expectedStatus(row)), row, to);
    await audit.recordAction(db, row.id, { action: decision === 'approved' ? 'PAYROLL_IMPACT_APPROVED' : 'PAYROLL_IMPACT_REJECTED',
      result: decision, user: req.userContext, permission: `${M.IMPACT}:${action}`, reason: req.body.reason,
      fromStatus: row.status, toStatus: to });
    await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
      legalEntityId: row.legal_entity_id,
      eventType: decision === 'approved' ? audit.EVENTS.PAYROLL_IMPACT_APPROVED : audit.EVENTS.PAYROLL_IMPACT_REJECTED,
      user: req.userContext, permission: `${M.IMPACT}:${action}`, correctionId: row.id, targetId: row.id,
      delta, reason: req.body.reason, result: to });

    if (decision === 'approved') {
      // The hand-off: TIME only. The monetary payroll_adjustments row stays a
      // PAYROLL action performed by the frozen payroll core.
      await db.prepare(`INSERT INTO attendance_payroll_adjustments
        (correction_id,employee_id,legal_entity_id,work_date,source_period_id,source_run_id,impact_category,
         original_values,corrected_values,delta_work_minutes,delta_overtime_minutes,attendance_approval_ref,
         payroll_review_status,payroll_reviewed_by_user_id,payroll_reviewed_by_name,payroll_reviewed_by_role,payroll_reviewed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'APPROVED', ?,?,?, kahe_now())`).run(
        row.id, row.employee_id, row.legal_entity_id, row.work_date, row.payroll_period_id, row.payroll_run_id,
        row.payroll_impact, row.before_values, row.after_values,
        Number(delta.delta_work_minutes || 0), Number(delta.delta_overtime_minutes || 0), row.request_no,
        req.userContext.id, req.userContext.displayName, audit.roleSnapshot(req.userContext));
      await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
        legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.PAYROLL_ADJUSTMENT_QUEUED, user: req.userContext,
        correctionId: row.id, targetId: row.id, delta, result: 'QUEUED' });
    }
  });
  res.json({ ok: true, status: to, delta });
}));

// ---- helpers ---------------------------------------------------------------

// DB-M1 CP5 — lost-update guard. On SQLite every handler ran synchronously to completion, so "read the request, check its
// status, then update it" could never interleave with another request. On PostgreSQL handlers are asynchronous: two users
// deciding the same request at the same moment would BOTH pass the status check and both write (last writer wins, two
// approval-history rows, possibly two applied versions). Every status transition is therefore conditional on the status
// the handler actually validated — the same pattern A1 already uses for overtime decisions. The loser gets the 409 it
// would have received had it arrived a moment later, and its transaction (audit rows included) rolls back.
// `row` itself is never mutated: later audit calls still record the ORIGINAL from-status.
const validatedStatus = new WeakMap();
const expectedStatus = (row) => (validatedStatus.has(row) ? validatedStatus.get(row) : row.status);
function assertTransitioned(info, row, status) {
  if (Number(info.changes) !== 1) conflict('CORRECTION_STATE_CONFLICT', 'Permintaan ini baru saja diproses oleh pengguna lain. Muat ulang dan periksa status terbarunya.');
  validatedStatus.set(row, status);
}
async function setStatus(db, row, status) {
  assertTransitioned(await db.prepare(`UPDATE attendance_corrections SET status = ?, updated_at = kahe_now() WHERE id = ? AND status = ?`)
    .run(status, row.id, expectedStatus(row)), row, status);
}
async function decide(db, row, status, user) {
  assertTransitioned(await db.prepare(`UPDATE attendance_corrections SET status = ?, decided_by_user_id = ?, decided_by_name = ?,
    decided_by_role = ?, decided_at = kahe_now(), updated_at = kahe_now() WHERE id = ? AND status = ?`)
    .run(status, user.id, user.displayName, audit.roleSnapshot(user), row.id, expectedStatus(row)), row, status);
}

/** Materialise v1 (the record as originally written) the first time it is needed. */
async function ensureOriginalVersion(db, entry, user) {
  const has = await db.prepare('SELECT 1 FROM attendance_entry_versions WHERE timesheet_entry_id = ? AND version_no = 1').get(entry.id);
  if (has) return;
  await db.prepare(`INSERT INTO attendance_entry_versions
    (timesheet_entry_id,employee_id,work_date,legal_entity_id,version_no,version_type,payload,applied_to_source,is_effective,
     actor_user_id,actor_name,actor_role,reason)
    VALUES (?,?,?,?,1,'ORIGINAL',?,1,1,?,?,?,'Snapshot awal dibuat saat koreksi pertama')`).run(
    entry.id, entry.employee_id, entry.work_date, entry.legal_entity_id, JSON.stringify(ac.entrySnapshot(entry)),
    entry.recorded_by_user_id || null, entry.recorded_by || null, null);
}

async function writeVersion(db, entry, { versionType, correctionId, payload, appliedToSource, isEffective, user, reasonCode, reason }) {
  await ensureOriginalVersion(db, entry, user);
  const max = (await db.prepare('SELECT COALESCE(MAX(version_no),1) AS v FROM attendance_entry_versions WHERE timesheet_entry_id = ?').get(entry.id)).v;
  const next = max + 1;
  if (isEffective) {
    // is_effective is a pointer, not history: the snapshots themselves are immutable.
    await db.prepare('UPDATE attendance_entry_versions SET is_effective = 0 WHERE timesheet_entry_id = ?').run(entry.id);
  }
  await db.prepare(`INSERT INTO attendance_entry_versions
    (timesheet_entry_id,employee_id,work_date,legal_entity_id,version_no,version_type,correction_id,payload,
     applied_to_source,is_effective,actor_user_id,actor_name,actor_role,reason_code,reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    entry.id, entry.employee_id, entry.work_date, entry.legal_entity_id, next, versionType, correctionId,
    JSON.stringify(payload), appliedToSource, isEffective, user.id, user.displayName, audit.roleSnapshot(user),
    reasonCode || null, reason || null);
  return next;
}

/** Apply an approved correction/void to the live record (open period only). */
async function applyToSource(db, { row, entry, after, isVoid, user, delta, before }) {
  const versionNo = await writeVersion(db, entry, {
    versionType: isVoid ? 'VOID' : 'CORRECTION', correctionId: row.id, payload: after,
    appliedToSource: 1, isEffective: 1, user, reasonCode: row.reason_code, reason: row.reason_text,
  });
  if (isVoid) {
    await db.prepare(`UPDATE timesheet_entries SET record_status = 'VOIDED', work_minutes = 0, work_hours = 0,
      overtime_minutes_approved = 0, overtime_hours_approved = 0, current_version = ?, void_correction_id = ?,
      last_correction_id = ?, updated_by_user_id = ?, updated_at = kahe_now() WHERE id = ?`)
      .run(versionNo, row.id, row.id, user.id, entry.id);
  } else {
    await db.prepare(`UPDATE timesheet_entries SET clock_in = ?, clock_out = ?, clock_out_date = ?, attendance_status = ?,
      absence_reason = ?, workfront = ?, shift = ?, note = ?, work_minutes = ?, work_hours = ?, elapsed_minutes = ?,
      late_minutes = ?, early_leave_minutes = ?, worked_after_shift_minutes = ?, entry_source = ?,
      record_status = 'EFFECTIVE', current_version = ?, last_correction_id = ?, updated_by_user_id = ?,
      updated_at = kahe_now() WHERE id = ?`).run(
      after.clock_in, after.clock_out, after.clock_out_date, after.attendance_status, after.absence_reason,
      after.workfront, after.shift, after.note, after.work_minutes, after.work_hours, after.elapsed_minutes,
      after.late_minutes, after.early_leave_minutes, after.worked_after_shift_minutes, after.entry_source,
      versionNo, row.id, user.id, entry.id);
  }
  await setStatus(db, row, isVoid ? ac.STATUS.VOIDED : ac.STATUS.APPLIED);
  await db.prepare(`UPDATE attendance_corrections SET applied_to_source = 1, applied_version_no = ?,
    after_values = ?, updated_at = kahe_now() WHERE id = ?`).run(versionNo, JSON.stringify(after), row.id);
  await audit.recordAction(db, row.id, { action: isVoid ? 'VOIDED' : 'APPLIED', result: 'applied', user,
    toStatus: isVoid ? ac.STATUS.VOIDED : ac.STATUS.APPLIED });
  await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
    legalEntityId: row.legal_entity_id, eventType: isVoid ? audit.EVENTS.ENTRY_VOIDED : audit.EVENTS.CORRECTION_APPLIED,
    user, correctionId: row.id, targetType: 'timesheet_entry', targetId: entry.id,
    oldValues: before, newValues: after, delta, reasonCode: row.reason_code, result: `version:${versionNo}` });
  await audit.record(db, { entryId: entry.id, employeeId: entry.employee_id, workDate: entry.work_date,
    legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.ENTRY_VERSION_SUPERSEDED, user,
    correctionId: row.id, targetType: 'attendance_entry_version', targetId: versionNo,
    result: `v${versionNo - 1} -> v${versionNo}` });
}

async function upsertException(db, { entry, entity, type, severity, detail, correctionId = null, user = null }) {
  const open = await db.prepare(`SELECT id FROM attendance_exceptions WHERE employee_id = ? AND work_date = ?
    AND exception_type = ? AND status IN ('OPEN','ASSIGNED','REOPENED')`).get(entry.employee_id, entry.work_date, type);
  if (open) {
    await db.prepare(`UPDATE attendance_exceptions SET detail = ?, correction_id = COALESCE(?, correction_id),
      updated_at = kahe_now() WHERE id = ?`).run(JSON.stringify(detail), correctionId, open.id);
    return open.id;
  }
  const id = Number((await db.prepare(`INSERT INTO attendance_exceptions
    (timesheet_entry_id,employee_id,legal_entity_id,work_date,exception_type,severity,detail,correction_id)
    VALUES (?,?,?,?,?,?,?,?) RETURNING id`).run(entry.id || null, entry.employee_id, entity || entry.legal_entity_id,
    entry.work_date, type, severity, JSON.stringify(detail || {}), correctionId)).lastInsertRowid);
  await audit.record(db, { entryId: entry.id || null, employeeId: entry.employee_id, workDate: entry.work_date,
    legalEntityId: entity || entry.legal_entity_id, eventType: audit.EVENTS.EXCEPTION_CREATED, user,
    targetType: 'attendance_exception', targetId: id, exceptionId: id, correctionId, result: type });
  return id;
}

// =================== RECORD HISTORY =========================================

router.get('/entries/:id/history', requirePermission(M.CORRECTION, 'VIEW'), handle(async (req, res, db) => {
  const entry = await loadEntry(db, req, req.params.id);
  const versions = await db.prepare('SELECT * FROM attendance_entry_versions WHERE timesheet_entry_id = ? ORDER BY version_no').all(entry.id);
  res.json({
    entry: ac.entrySnapshot(entry),
    versions: versions.map((v) => ({ ...v, payload: JSON.parse(v.payload) })),
    corrections: await db.prepare(`SELECT id, request_no, request_type, status, reason_code, is_late_correction, payroll_impact,
      requested_by_name, requested_by_role, decided_by_name, decided_by_role, payroll_reviewed_by_name, created_at
      FROM attendance_corrections WHERE timesheet_entry_id = ? ORDER BY id`).all(entry.id),
    events: await db.prepare(`SELECT id, event_type, actor_user_id, actor_name, actor_role_snapshot, permission_used,
      reason, reason_code, result, occurred_at FROM attendance_events WHERE timesheet_entry_id = ? ORDER BY id`).all(entry.id),
  });
}));

// =================== EXCEPTIONS =============================================

router.get('/exceptions', requirePermission(M.EXCEPTION, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'x.legal_entity_id', { resourceType: 'attendance_exception', route: req.originalUrl });
  const params = [...sc.params];
  let sql = `SELECT x.*, e.full_name FROM attendance_exceptions x
             LEFT JOIN employees e ON e.id = x.employee_id WHERE ${sc.sql}`;
  if (req.query.status) { sql += ' AND x.status = ?'; params.push(req.query.status); }
  if (req.query.type) { sql += ' AND x.exception_type = ?'; params.push(req.query.type); }
  if (req.query.from) { sql += ' AND x.work_date >= ?'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND x.work_date <= ?'; params.push(req.query.to); }
  res.json((await db.prepare(`${sql} ORDER BY x.severity DESC, x.work_date DESC, x.id DESC`).all(...params))
    .map((r) => ({ ...r, age_days: bt.daysBetween(r.work_date, bt.businessToday()) })));
}));

/** Detect exceptions over a date range. Detection NEVER changes attendance. */
router.post('/exceptions/scan', requirePermission(M.EXCEPTION, 'EDIT'), handle(async (req, res, db) => {
  const b = req.body || {};
  if (!g.isValidDate(b.from) || !g.isValidDate(b.to)) bad('INVALID_DATE', 'from dan to harus YYYY-MM-DD.');
  const sc = await entityScope.scopeClause(db, req.userContext, 't.legal_entity_id', { resourceType: 'attendance_exception', route: req.originalUrl });
  const rows = await db.prepare(`SELECT t.* FROM timesheet_entries t
    WHERE ${sc.sql} AND t.work_date >= ? AND t.work_date <= ? ORDER BY t.work_date, t.id`)
    .all(...sc.params, b.from, b.to);
  const created = [];
  const policyCache = new Map();
  await withTransaction(db, async () => {
    for (const entry of rows) {
      const entity = entry.legal_entity_id || await g.entityForEmployeeOn(db, entry.employee_id, entry.work_date);
      // DB-M1 CP5: the policy depends only on (legal entity, work date); resolving it once per pair instead of once per
      // attendance row removes ~1 query per row (measured: 6,000 identical lookups for one business day at 6,000 workers).
      // Same function, same arguments, same transaction — the result for every row is unchanged.
      const policyKey = `${entity}|${entry.work_date}`;
      if (!policyCache.has(policyKey)) policyCache.set(policyKey, (await ac.resolvePolicy(db, entity, entry.work_date)).policy);
      const policy = policyCache.get(policyKey);
      const findings = ex.detectForEntry(entry, policy, { duplicateOf: await ex.findOverlap(db, entry) });
      for (const f of findings) {
        const id = await upsertException(db, { entry, entity, type: f.type, severity: f.severity, detail: f.detail, user: req.userContext });
        created.push({ id, employee_id: entry.employee_id, work_date: entry.work_date, type: f.type, severity: f.severity });
      }
    }
  });
  res.json({ scanned: rows.length, exceptions: created.length, detail: created.slice(0, 200) });
}));

router.post('/exceptions/:id/assign', requirePermission(M.EXCEPTION, 'EDIT'), handle(async (req, res, db) => {
  const row = await db.prepare('SELECT * FROM attendance_exceptions WHERE id = ?').get(req.params.id);
  if (!row) throw new g.AttendanceError(404, 'NOT_FOUND', 'Exception tidak ditemukan.');
  await entityScope.assertEntityAccess(db, req.userContext, row.legal_entity_id, { resourceType: 'attendance_exception', resourceId: row.id, route: req.originalUrl });
  const target = await db.prepare('SELECT id, display_name FROM users WHERE id = ? AND is_active = 1').get(req.body && req.body.user_id);
  if (!target) bad('VALIDATION', 'user_id tidak valid.');
  await db.prepare(`UPDATE attendance_exceptions SET status = 'ASSIGNED', assigned_to_user_id = ?, assigned_to_name = ?,
    assigned_at = kahe_now(), updated_at = kahe_now() WHERE id = ?`).run(target.id, target.display_name, row.id);
  await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
    legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.EXCEPTION_ASSIGNED, user: req.userContext,
    permission: `${M.EXCEPTION}:EDIT`, exceptionId: row.id, targetType: 'attendance_exception', targetId: row.id,
    result: `assigned:${target.id}` });
  res.json({ ok: true, status: 'ASSIGNED' });
}));

router.post('/exceptions/:id/resolve', requirePermission(M.EXCEPTION, 'EDIT'), handle(async (req, res, db) => {
  const row = await db.prepare('SELECT * FROM attendance_exceptions WHERE id = ?').get(req.params.id);
  if (!row) throw new g.AttendanceError(404, 'NOT_FOUND', 'Exception tidak ditemukan.');
  await entityScope.assertEntityAccess(db, req.userContext, row.legal_entity_id, { resourceType: 'attendance_exception', resourceId: row.id, route: req.originalUrl });
  if (row.status === 'RESOLVED') conflict('ALREADY_RESOLVED', 'Exception sudah diselesaikan.');
  if (!req.body || !req.body.note) bad('VALIDATION', 'note penyelesaian wajib diisi.');
  await db.prepare(`UPDATE attendance_exceptions SET status = 'RESOLVED', resolved_by_user_id = ?, resolved_by_name = ?,
    resolved_by_role = ?, resolved_at = kahe_now(), resolution_note = ?, correction_id = COALESCE(?, correction_id),
    updated_at = kahe_now() WHERE id = ?`).run(
    req.userContext.id, req.userContext.displayName, audit.roleSnapshot(req.userContext),
    req.body.note, req.body.correction_id || null, row.id);
  await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
    legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.EXCEPTION_RESOLVED, user: req.userContext,
    permission: `${M.EXCEPTION}:EDIT`, exceptionId: row.id, targetType: 'attendance_exception', targetId: row.id,
    reason: req.body.note, result: 'RESOLVED' });
  res.json({ ok: true, status: 'RESOLVED' });
}));

router.post('/exceptions/:id/reopen', requirePermission(M.EXCEPTION, 'EDIT'), handle(async (req, res, db) => {
  const row = await db.prepare('SELECT * FROM attendance_exceptions WHERE id = ?').get(req.params.id);
  if (!row) throw new g.AttendanceError(404, 'NOT_FOUND', 'Exception tidak ditemukan.');
  await entityScope.assertEntityAccess(db, req.userContext, row.legal_entity_id, { resourceType: 'attendance_exception', resourceId: row.id, route: req.originalUrl });
  await db.prepare(`UPDATE attendance_exceptions SET status = 'REOPENED', updated_at = kahe_now() WHERE id = ?`).run(row.id);
  await audit.record(db, { entryId: row.timesheet_entry_id, employeeId: row.employee_id, workDate: row.work_date,
    legalEntityId: row.legal_entity_id, eventType: audit.EVENTS.EXCEPTION_REOPENED, user: req.userContext,
    permission: `${M.EXCEPTION}:EDIT`, exceptionId: row.id, targetType: 'attendance_exception', targetId: row.id,
    reason: req.body && req.body.reason, result: 'REOPENED' });
  res.json({ ok: true, status: 'REOPENED' });
}));

// =================== PAYROLL IMPACT QUEUE ===================================

router.get('/payroll-queue', requirePermission(M.IMPACT, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'q.legal_entity_id', { resourceType: 'payroll_adjustment_queue', route: req.originalUrl });
  const params = [...sc.params];
  let sql = `SELECT q.*, c.request_no, c.status AS correction_status, c.reason_code, e.full_name
             FROM attendance_payroll_adjustments q
             JOIN attendance_corrections c ON c.id = q.correction_id
             JOIN employees e ON e.id = q.employee_id WHERE ${sc.sql}`;
  if (req.query.queue_status) { sql += ' AND q.queue_status = ?'; params.push(req.query.queue_status); }
  res.json(await db.prepare(`${sql} ORDER BY q.id DESC`).all(...params));
}));

/** Pending payroll review: corrections approved by attendance, awaiting the officer. */
router.get('/payroll-impact', requirePermission(M.IMPACT, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'c.legal_entity_id', { resourceType: 'payroll_impact', route: req.originalUrl });
  res.json(await db.prepare(`SELECT c.*, e.full_name FROM attendance_corrections c JOIN employees e ON e.id = c.employee_id
    WHERE ${sc.sql} AND c.payroll_impact IN ('PAYROLL_IMPACT_FROZEN_PERIOD','PAYROLL_ADJUSTMENT_REQUIRED')
    ORDER BY c.id DESC`).all(...sc.params));
}));

// =================== AUDIT & ACTIVITY CENTER ================================

/**
 * Append-only audit, filtered by entity scope. VIEW never implies APPROVE:
 * an actor who cannot approve corrections sees only their OWN activity — that
 * is the Supervisor default.
 */
async function auditQuery(req, db, extraWhere = [], extraParams = []) {
  const sc = await entityScope.scopeClause(db, req.userContext, 'ev.legal_entity_id', { resourceType: 'attendance_audit', route: req.originalUrl });
  const where = [`(${sc.sql} OR ev.legal_entity_id IS NULL)`, ...extraWhere];
  const params = [...sc.params, ...extraParams];
  const broad = hasPermission(req.userContext, M.CORRECTION, 'APPROVE')
    || hasPermission(req.userContext, M.IMPACT, 'APPROVE')
    || hasPermission(req.userContext, M.AUDIT, 'EXPORT');
  if (!broad) { where.push('ev.actor_user_id = ?'); params.push(req.userContext.id); }
  return { where, params, broad };
}

router.get('/audit', requirePermission(M.AUDIT, 'VIEW'), handle(async (req, res, db) => {
  const extraWhere = []; const extraParams = [];
  const q = req.query;
  if (q.from) { extraWhere.push('ev.work_date >= ?'); extraParams.push(q.from); }
  if (q.to) { extraWhere.push('ev.work_date <= ?'); extraParams.push(q.to); }
  if (q.actor_user_id) { extraWhere.push('ev.actor_user_id = ?'); extraParams.push(q.actor_user_id); }
  if (q.actor_role) { extraWhere.push('ev.actor_role_snapshot LIKE ?'); extraParams.push(`%${q.actor_role}%`); }
  if (q.employee_id) { extraWhere.push('ev.employee_id = ?'); extraParams.push(q.employee_id); }
  if (q.event_type) { extraWhere.push('ev.event_type = ?'); extraParams.push(q.event_type); }
  if (q.legal_entity_id) { extraWhere.push('ev.legal_entity_id = ?'); extraParams.push(q.legal_entity_id); }
  if (q.correction_id) { extraWhere.push('ev.correction_id = ?'); extraParams.push(q.correction_id); }
  if (q.result) { extraWhere.push('ev.result = ?'); extraParams.push(q.result); }
  const { where, params } = await auditQuery(req, db, extraWhere, extraParams);
  const limit = Math.min(Number(q.limit || 200), 1000);
  const rows = await db.prepare(`SELECT ev.* FROM attendance_events ev WHERE ${where.join(' AND ')}
    ORDER BY ev.id DESC LIMIT ?`).all(...params, limit);
  res.json(rows.map((r) => ({
    ...r,
    old_values: r.old_values ? JSON.parse(r.old_values) : null,
    new_values: r.new_values ? JSON.parse(r.new_values) : null,
    delta_values: r.delta_values ? JSON.parse(r.delta_values) : null,
  })));
}));

/** "What has this Workforce Manager done?" — actor activity history. */
router.get('/audit/actors/:userId', requirePermission(M.AUDIT, 'VIEW'), handle(async (req, res, db) => {
  const target = Number(req.params.userId);
  const broad = hasPermission(req.userContext, M.CORRECTION, 'APPROVE')
    || hasPermission(req.userContext, M.IMPACT, 'APPROVE') || hasPermission(req.userContext, M.AUDIT, 'EXPORT');
  if (!broad && target !== req.userContext.id) {
    forbid('AUDIT_SCOPE', 'Anda hanya dapat melihat aktivitas Anda sendiri.');
  }
  const sc = await entityScope.scopeClause(db, req.userContext, 'ev.legal_entity_id', { resourceType: 'attendance_audit', route: req.originalUrl });
  const events = await db.prepare(`SELECT ev.* FROM attendance_events ev
    WHERE ev.actor_user_id = ? AND (${sc.sql} OR ev.legal_entity_id IS NULL) ORDER BY ev.id DESC LIMIT 500`)
    .all(target, ...sc.params);
  const actions = await db.prepare(`SELECT a.*, c.request_no, c.request_type, c.employee_id, c.work_date, c.legal_entity_id
    FROM attendance_correction_actions a JOIN attendance_corrections c ON c.id = a.correction_id
    WHERE a.actor_user_id = ? ORDER BY a.id DESC LIMIT 500`).all(target);
  const summary = {};
  for (const e of events) summary[e.event_type] = (summary[e.event_type] || 0) + 1;
  const user = await db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(target);
  res.json({
    actor: user || { id: target },
    // The role shown per event is the SNAPSHOT taken at the time of the action,
    // not the actor's current role.
    summary, events, correction_actions: actions.filter((a) => !a.legal_entity_id || sc.params.includes(a.legal_entity_id) || sc.params.length === 0),
  });
}));

module.exports = router;
