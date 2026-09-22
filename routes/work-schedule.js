// routes/work-schedule.js
// Attendance A2 — configuration API for work schedules (shifts), work
// patterns (weekly / custom weekly / rotating cycle / date roster), roster
// dates, date overrides and employee schedule assignments.
//
// Permission module: `attendance_config` (separate from `timesheet_absensi`,
// so recording attendance and changing everyone's working rhythm are separate
// rights). Legal-entity scope from Phase 2I applies to every read and write.
// Nothing here computes money; see lib/workSchedule.js scope lock.

const express = require('express');
const { getDb, withTransaction } = require('../database/init-db');
const { requirePermission } = require('../middleware/permissions');
const entityScope = require('../lib/entityScope');
const ws = require('../lib/workSchedule');
const bt = require('../lib/businessTime');
const g = require('../lib/attendanceGuard');

const router = express.Router();
const MODULE = 'attendance_config';

function handle(fn) {
  return async (req, res, next) => {
    const db = getDb();
    try { await fn(req, res, db); }
    catch (err) {
      if (err instanceof g.AttendanceError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      }
      if (err instanceof TypeError) return res.status(400).json({ error: 'VALIDATION', message: err.message });
      const m = String(err && err.message);
      if (m.includes('SCHEDULE_VERSION_IN_USE')) {
        return res.status(409).json({ error: 'SCHEDULE_VERSION_IN_USE', message: 'Versi jadwal ini sudah dipakai absensi; buat versi baru.' });
      }
      next(err);
    } finally { db.close(); }
  };
}
const bad = (code, message, detail) => { throw new g.AttendanceError(400, code, message, detail); };
const conflict = (code, message, detail) => { throw new g.AttendanceError(409, code, message, detail); };

/** Writes must target an entity the caller holds. Reads also see global rows. */
async function assertWritableEntity(db, req, entityId, resourceType) {
  if (!entityId) bad('VALIDATION', 'legal_entity_id wajib diisi.');
  await entityScope.assertEntityAccess(db, req.userContext, entityId, { resourceType, route: req.originalUrl });
  return entityId;
}
/** Scope filter that also lets through GLOBAL (entity-less) configuration rows. */
async function configScope(db, req, column, resourceType) {
  const sc = await entityScope.scopeClause(db, req.userContext, column, { resourceType, route: req.originalUrl });
  return { sql: `(${sc.sql} OR ${column} IS NULL)`, params: sc.params };
}
async function readableRow(db, req, row, resourceType) {
  if (!row) throw new entityScope.EntityAccessError(entityScope.ERROR.NOT_FOUND, 'Data tidak ditemukan.');
  if (row.legal_entity_id === null) return row;   // global configuration
  await entityScope.assertEntityAccess(db, req.userContext, row.legal_entity_id, { resourceType, resourceId: row.id, route: req.originalUrl });
  return row;
}
const actor = (req) => ({ by: req.userContext.displayName, uid: req.userContext.id });

function validateDateRange(from, to) {
  if (!g.isValidDate(from)) bad('INVALID_DATE', 'effective_from harus YYYY-MM-DD.');
  if (to !== null && to !== undefined && to !== '' && !g.isValidDate(to)) bad('INVALID_DATE', 'effective_to harus YYYY-MM-DD.');
  if (to && to < from) bad('INVALID_DATE_RANGE', 'effective_to tidak boleh sebelum effective_from.');
}

// =================== SCHEDULES ==============================================

function validateSchedule(b) {
  if (!b.code || !b.name) bad('VALIDATION', 'code dan name wajib diisi.');
  if (!bt.isValidTime(b.clock_in) || !bt.isValidTime(b.clock_out)) bad('INVALID_TIME', 'clock_in/clock_out harus HH:MM.');
  const rule = b.overtime_eligibility_rule || 'AFTER_SHIFT_END';
  if (!ws.OT_RULES.includes(rule)) bad('INVALID_OT_RULE', `overtime_eligibility_rule harus salah satu dari ${ws.OT_RULES.join(', ')}.`);
  if (rule === 'FIXED_TIME' && !bt.isValidTime(b.overtime_eligible_from)) {
    bad('INVALID_TIME', 'overtime_eligible_from wajib HH:MM untuk aturan FIXED_TIME.');
  }
  const cross = b.cross_midnight ? 1 : 0;
  const span = bt.elapsedMinutes(b.clock_in, b.clock_out, { crossMidnight: !!cross });
  if (span === null || span === 0) bad('INVALID_SHIFT_SPAN', 'Rentang shift tidak valid; untuk shift melewati tengah malam set cross_midnight.');
  if (!cross && bt.timeToMinutes(b.clock_out) <= bt.timeToMinutes(b.clock_in)) {
    bad('INVALID_SHIFT_SPAN', 'clock_out lebih awal dari clock_in tetapi cross_midnight tidak diset.');
  }
  const minutes = b.standard_work_minutes === undefined || b.standard_work_minutes === null || b.standard_work_minutes === ''
    ? span : Number(b.standard_work_minutes);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) bad('INVALID_WORK_MINUTES', 'standard_work_minutes harus 1–1440.');
  validateDateRange(b.effective_from, b.effective_to);
  return { rule, cross, minutes, span };
}

router.get('/schedules', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const sc = await configScope(db, req, 's.legal_entity_id', 'work_schedule');
  const params = [...sc.params];
  let sql = `SELECT s.* FROM work_schedules s WHERE ${sc.sql}`;
  if (req.query.code) { sql += ' AND s.code = ?'; params.push(req.query.code); }
  if (req.query.as_of) { sql += ' AND s.effective_from <= ? AND (s.effective_to IS NULL OR s.effective_to >= ?)'; params.push(req.query.as_of, req.query.as_of); }
  if (req.query.status) { sql += ' AND s.status = ?'; params.push(req.query.status); }
  sql += ' ORDER BY s.code ASC, s.effective_from DESC';
  const rows = await db.prepare(sql).all(...params);
  const brk = db.prepare('SELECT * FROM work_schedule_breaks WHERE work_schedule_id = ? AND is_active = 1 ORDER BY sequence, id');
  res.json(await Promise.all(rows.map(async (r) => ({ ...r, breaks: await brk.all(r.id), overtime_eligible_from_resolved: ws.overtimeEligibleFrom(r) }))));
}));

router.get('/schedules/:id', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const row = await readableRow(db, req, await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(req.params.id), 'work_schedule');
  res.json({ ...row, breaks: await db.prepare('SELECT * FROM work_schedule_breaks WHERE work_schedule_id = ? ORDER BY sequence, id').all(row.id),
    overtime_eligible_from_resolved: ws.overtimeEligibleFrom(row) });
}));

/** Create a schedule (first version of a code, or a standalone one). */
router.post('/schedules', requirePermission(MODULE, 'CREATE'), handle(async (req, res, db) => {
  const b = req.body || {};
  const v = validateSchedule(b);
  await assertWritableEntity(db, req, b.legal_entity_id, 'work_schedule');
  const open = await db.prepare(`SELECT id FROM work_schedules WHERE code = ? AND COALESCE(legal_entity_id,'') = COALESCE(?,'')
    AND effective_to IS NULL`).get(b.code, b.legal_entity_id);
  if (open) conflict('SCHEDULE_CODE_OPEN', 'Sudah ada versi terbuka untuk kode jadwal ini. Gunakan endpoint versi baru.');
  const a = actor(req);
  const id = await withTransaction(db, async () => {
    const info = await db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,project_code,schedule_type,clock_in,clock_out,
      standard_work_minutes,cross_midnight,overtime_eligibility_rule,overtime_delay_minutes,overtime_eligible_from,
      status,effective_from,effective_to,note,created_by,created_by_user_id,updated_by,updated_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
      b.code, b.name, b.legal_entity_id, b.project_code || null, b.schedule_type || 'CUSTOM', b.clock_in, b.clock_out,
      v.minutes, v.cross, v.rule, Number(b.overtime_delay_minutes || 0), b.overtime_eligible_from || null,
      b.status || 'ACTIVE', b.effective_from, b.effective_to || null, b.note || null, a.by, a.uid, a.by, a.uid);
    const newId = Number(info.lastInsertRowid);
    await insertBreaks(db, newId, b.breaks);
    return newId;
  });
  res.status(201).json({ id });
}));

async function insertBreaks(db, scheduleId, breaks) {
  if (!Array.isArray(breaks)) return;
  const ins = db.prepare(`INSERT INTO work_schedule_breaks (work_schedule_id,name,start_time,end_time,duration_minutes,is_paid,sequence,is_active)
    VALUES (?,?,?,?,?,?,?,1)`);
  for (const [i, brk] of breaks.entries()) {
    let duration = brk.duration_minutes;
    if ((duration === undefined || duration === null || duration === '') && bt.isValidTime(brk.start_time) && bt.isValidTime(brk.end_time)) {
      duration = bt.elapsedMinutes(brk.start_time, brk.end_time, { crossMidnight: true });
    }
    duration = Number(duration);
    if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) bad('INVALID_BREAK', 'duration_minutes istirahat harus 1–1440.');
    if (brk.start_time && !bt.isValidTime(brk.start_time)) bad('INVALID_TIME', 'start_time istirahat harus HH:MM.');
    if (brk.end_time && !bt.isValidTime(brk.end_time)) bad('INVALID_TIME', 'end_time istirahat harus HH:MM.');
    await ins.run(scheduleId, brk.name || `Istirahat ${i + 1}`, brk.start_time || null, brk.end_time || null,
      duration, brk.is_paid ? 1 : 0, Number(brk.sequence || i + 1));
  }
}

/**
 * New effective-dated VERSION of a schedule code: closes the open version the
 * day before the new one starts. History is preserved, never edited — a
 * timesheet row that referenced the old version still resolves it.
 */
router.post('/schedules/:id/versions', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const prev = await readableRow(db, req, await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(req.params.id), 'work_schedule');
  const b = { ...prev, ...req.body, id: undefined };
  const v = validateSchedule(b);
  if (prev.legal_entity_id) await assertWritableEntity(db, req, prev.legal_entity_id, 'work_schedule');
  if (b.effective_from <= prev.effective_from) {
    conflict('SCHEDULE_VERSION_OVERLAP', `Versi baru harus mulai setelah ${prev.effective_from}.`);
  }
  if (prev.effective_to && prev.effective_to >= b.effective_from) {
    conflict('SCHEDULE_VERSION_OVERLAP', 'Versi baru bertabrakan dengan versi yang sudah ditutup.');
  }
  const a = actor(req);
  const id = await withTransaction(db, async () => {
    if (!prev.effective_to) {
      await db.prepare(`UPDATE work_schedules SET effective_to = ?, updated_by = ?, updated_by_user_id = ?, updated_at = kahe_now() WHERE id = ?`)
        .run(bt.addDays(b.effective_from, -1), a.by, a.uid, prev.id);
    }
    const info = await db.prepare(`INSERT INTO work_schedules (code,name,legal_entity_id,project_code,schedule_type,clock_in,clock_out,
      standard_work_minutes,cross_midnight,overtime_eligibility_rule,overtime_delay_minutes,overtime_eligible_from,
      status,effective_from,effective_to,note,created_by,created_by_user_id,updated_by,updated_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
      prev.code, b.name, prev.legal_entity_id, b.project_code || null, b.schedule_type || 'CUSTOM', b.clock_in, b.clock_out,
      v.minutes, v.cross, v.rule, Number(b.overtime_delay_minutes || 0), b.overtime_eligible_from || null,
      b.status || 'ACTIVE', b.effective_from, b.effective_to || null, b.note || null, a.by, a.uid, a.by, a.uid);
    const newId = Number(info.lastInsertRowid);
    const carried = Array.isArray(req.body.breaks) ? req.body.breaks
      : await db.prepare('SELECT * FROM work_schedule_breaks WHERE work_schedule_id = ? AND is_active = 1 ORDER BY sequence').all(prev.id);
    await insertBreaks(db, newId, carried);
    return newId;
  });
  res.status(201).json({ id, previous_version_closed: bt.addDays(b.effective_from, -1) });
}));

/** Activate / deactivate. Times are never edited in place once used. */
router.post('/schedules/:id/status', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const row = await readableRow(db, req, await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(req.params.id), 'work_schedule');
  const status = req.body && req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) bad('VALIDATION', 'status harus ACTIVE atau INACTIVE.');
  const a = actor(req);
  await db.prepare(`UPDATE work_schedules SET status = ?, updated_by = ?, updated_by_user_id = ?, updated_at = kahe_now() WHERE id = ?`)
    .run(status, a.by, a.uid, row.id);
  res.json({ ok: true, status });
}));

// =================== PATTERNS ===============================================

router.get('/patterns', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const sc = await configScope(db, req, 'p.legal_entity_id', 'attendance_pattern');
  const rows = await db.prepare(`SELECT p.* FROM attendance_work_patterns p WHERE ${sc.sql} ORDER BY p.code, p.effective_from DESC`).all(...sc.params);
  const days = db.prepare('SELECT * FROM attendance_pattern_days WHERE pattern_id = ? ORDER BY day_index');
  res.json(await Promise.all(rows.map(async (r) => ({ ...r, days: await days.all(r.id) }))));
}));

router.get('/patterns/:id', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const row = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(req.params.id), 'attendance_pattern');
  res.json({
    ...row,
    days: await db.prepare('SELECT * FROM attendance_pattern_days WHERE pattern_id = ? ORDER BY day_index').all(row.id),
    roster_dates: await db.prepare('SELECT * FROM attendance_roster_dates WHERE pattern_id = ? ORDER BY work_date').all(row.id),
  });
}));

/**
 * Create a pattern. The SHAPE is data: `days` carries one row per weekday
 * (1=Mon..7=Sun) or per cycle slot (1..cycle_length_days), each WORK or OFF
 * with its own optional shift. 5/2, 6/1, 4/2, 14/7, 21/7, 2D-2N-2OFF and any
 * custom weekday mix are all the same code path.
 */
router.post('/patterns', requirePermission(MODULE, 'CREATE'), handle(async (req, res, db) => {
  const b = req.body || {};
  if (!b.code || !b.name) bad('VALIDATION', 'code dan name wajib diisi.');
  if (!ws.PATTERN_TYPES.includes(b.pattern_type)) bad('INVALID_PATTERN_TYPE', `pattern_type harus salah satu dari ${ws.PATTERN_TYPES.join(', ')}.`);
  validateDateRange(b.effective_from, b.effective_to);
  await assertWritableEntity(db, req, b.legal_entity_id, 'attendance_pattern');

  const days = Array.isArray(b.days) ? b.days : [];
  if (b.pattern_type === 'ROTATING_CYCLE') {
    const len = Number(b.cycle_length_days);
    if (!Number.isInteger(len) || len < 1 || len > 366) bad('INVALID_CYCLE', 'cycle_length_days harus 1–366.');
    // A rotating roster without an anchor cannot be resolved; we refuse
    // rather than guess which day of the cycle a worker is on.
    if (!g.isValidDate(b.cycle_start_date)) bad('MISSING_CYCLE_ANCHOR', 'cycle_start_date wajib untuk ROTATING_CYCLE.');
    if (days.length !== len) bad('INVALID_CYCLE', `Jumlah hari siklus (${days.length}) tidak sama dengan cycle_length_days (${len}).`);
  } else if (b.pattern_type === 'DATE_BASED_ROSTER') {
    if (days.length) bad('INVALID_PATTERN', 'DATE_BASED_ROSTER memakai roster tanggal, bukan days[].');
  } else if (days.length !== 7) {
    bad('INVALID_PATTERN', 'Pola mingguan wajib mendefinisikan 7 hari (1=Senin … 7=Minggu).');
  }
  for (const d of days) {
    if (!['WORK', 'OFF'].includes(d.day_status)) bad('INVALID_PATTERN', 'day_status harus WORK atau OFF.');
    if (d.work_schedule_id) await readableRow(db, req, await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(d.work_schedule_id), 'work_schedule');
  }
  const open = await db.prepare(`SELECT id FROM attendance_work_patterns WHERE code = ? AND COALESCE(legal_entity_id,'') = COALESCE(?,'') AND effective_to IS NULL`)
    .get(b.code, b.legal_entity_id);
  if (open) conflict('PATTERN_CODE_OPEN', 'Sudah ada versi terbuka untuk kode pola ini.');

  const a = actor(req);
  const id = await withTransaction(db, async () => {
    const info = await db.prepare(`INSERT INTO attendance_work_patterns (code,name,legal_entity_id,project_code,pattern_type,
      cycle_length_days,cycle_start_date,repeats,default_schedule_id,status,effective_from,effective_to,note,
      created_by,created_by_user_id,updated_by,updated_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
      b.code, b.name, b.legal_entity_id, b.project_code || null, b.pattern_type,
      b.cycle_length_days ? Number(b.cycle_length_days) : null, b.cycle_start_date || null,
      b.repeats === 0 || b.repeats === false ? 0 : 1, b.default_schedule_id || null, b.status || 'ACTIVE',
      b.effective_from, b.effective_to || null, b.note || null, a.by, a.uid, a.by, a.uid);
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO attendance_pattern_days (pattern_id,day_index,day_status,work_schedule_id,note) VALUES (?,?,?,?,?)');
    for (const [i, d] of days.entries()) await ins.run(pid, Number(d.day_index ?? i + 1), d.day_status, d.work_schedule_id || null, d.note || null);
    return pid;
  });
  res.status(201).json({ id });
}));

/** New effective-dated version of a pattern (closes the open one). */
router.post('/patterns/:id/versions', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const prev = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(req.params.id), 'attendance_pattern');
  const b = req.body || {};
  if (!g.isValidDate(b.effective_from)) bad('INVALID_DATE', 'effective_from harus YYYY-MM-DD.');
  if (b.effective_from <= prev.effective_from) conflict('PATTERN_VERSION_OVERLAP', `Versi baru harus mulai setelah ${prev.effective_from}.`);
  const days = Array.isArray(b.days) ? b.days
    : await db.prepare('SELECT day_index,day_status,work_schedule_id,note FROM attendance_pattern_days WHERE pattern_id = ? ORDER BY day_index').all(prev.id);
  const a = actor(req);
  const id = await withTransaction(db, async () => {
    await db.prepare(`UPDATE attendance_work_patterns SET effective_to = ?, updated_by = ?, updated_by_user_id = ?, updated_at = kahe_now() WHERE id = ?`)
      .run(bt.addDays(b.effective_from, -1), a.by, a.uid, prev.id);
    const info = await db.prepare(`INSERT INTO attendance_work_patterns (code,name,legal_entity_id,project_code,pattern_type,
      cycle_length_days,cycle_start_date,repeats,default_schedule_id,status,effective_from,effective_to,note,
      created_by,created_by_user_id,updated_by,updated_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
      prev.code, b.name || prev.name, prev.legal_entity_id, prev.project_code, b.pattern_type || prev.pattern_type,
      b.cycle_length_days !== undefined ? b.cycle_length_days : prev.cycle_length_days,
      b.cycle_start_date !== undefined ? b.cycle_start_date : prev.cycle_start_date,
      prev.repeats, b.default_schedule_id !== undefined ? b.default_schedule_id : prev.default_schedule_id,
      'ACTIVE', b.effective_from, b.effective_to || null, b.note || null, a.by, a.uid, a.by, a.uid);
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO attendance_pattern_days (pattern_id,day_index,day_status,work_schedule_id,note) VALUES (?,?,?,?,?)');
    for (const [i, d] of days.entries()) await ins.run(pid, Number(d.day_index ?? i + 1), d.day_status, d.work_schedule_id || null, d.note || null);
    return pid;
  });
  res.status(201).json({ id, previous_version_closed: bt.addDays(b.effective_from, -1) });
}));

// =================== ROSTER DATES (DATE_BASED_ROSTER) ========================

router.post('/patterns/:id/roster-dates', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const pattern = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(req.params.id), 'attendance_pattern');
  const rows = Array.isArray(req.body && req.body.dates) ? req.body.dates : [];
  if (!rows.length) bad('VALIDATION', 'dates[] wajib diisi.');
  const a = actor(req);
  await withTransaction(db, async () => {
    const upsert = db.prepare(`INSERT INTO attendance_roster_dates (pattern_id,work_date,day_status,work_schedule_id,note,created_by,created_by_user_id)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(pattern_id, work_date) WHERE pattern_id IS NOT NULL DO UPDATE SET day_status = excluded.day_status,
        work_schedule_id = excluded.work_schedule_id, note = excluded.note`);
    for (const r of rows) {
      if (!g.isValidDate(r.work_date)) bad('INVALID_DATE', `work_date tidak valid: ${r.work_date}`);
      if (!['WORK', 'OFF'].includes(r.day_status)) bad('VALIDATION', 'day_status harus WORK atau OFF.');
      await upsert.run(pattern.id, r.work_date, r.day_status, r.work_schedule_id || null, r.note || null, a.by, a.uid);
    }
  });
  res.status(201).json({ ok: true, count: rows.length });
}));

router.get('/patterns/:id/roster-dates', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const pattern = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(req.params.id), 'attendance_pattern');
  res.json(await db.prepare('SELECT * FROM attendance_roster_dates WHERE pattern_id = ? ORDER BY work_date').all(pattern.id));
}));

// =================== DATE OVERRIDES =========================================

router.get('/overrides', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'o.legal_entity_id', { resourceType: 'attendance_override', route: req.originalUrl });
  const params = [...sc.params];
  let sql = `SELECT o.*, e.full_name FROM attendance_date_overrides o
             LEFT JOIN employees e ON e.id = o.employee_id WHERE ${sc.sql}`;
  if (req.query.from) { sql += ' AND o.work_date >= ?'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND o.work_date <= ?'; params.push(req.query.to); }
  res.json(await db.prepare(`${sql} ORDER BY o.work_date DESC`).all(...params));
}));

/**
 * A date exception. It does NOT rewrite the base pattern, and it never
 * changes the day TYPE: a public holiday worked under an override stays a
 * public holiday for payroll. Employee-scoped or pattern-scoped.
 */
router.post('/overrides', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const b = req.body || {};
  if (!g.isValidDate(b.work_date)) bad('INVALID_DATE', 'work_date harus YYYY-MM-DD.');
  if (!['WORK', 'OFF'].includes(b.override_status)) bad('VALIDATION', 'override_status harus WORK atau OFF.');
  if (!b.reason) bad('VALIDATION', 'reason wajib diisi.');
  if (!b.employee_id && !b.pattern_id) bad('VALIDATION', 'employee_id atau pattern_id wajib diisi.');

  let entityId = b.legal_entity_id || null;
  if (b.employee_id) {
    entityId = await g.assertEmployeeInScope(db, req.userContext, b.employee_id, b.work_date, req.originalUrl) || entityId;
  } else {
    const pattern = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(b.pattern_id), 'attendance_pattern');
    entityId = entityId || pattern.legal_entity_id;
  }
  await assertWritableEntity(db, req, entityId, 'attendance_override');

  const a = actor(req);
  const id = Number((await db.prepare(`INSERT INTO attendance_date_overrides (employee_id,pattern_id,legal_entity_id,work_date,
    override_status,work_schedule_id,reason,created_by,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).run(
    b.employee_id || null, b.employee_id ? null : Number(b.pattern_id), entityId, b.work_date,
    b.override_status, b.work_schedule_id || null, b.reason, a.by, a.uid)).lastInsertRowid);
  res.status(201).json({ id });
}));

router.post('/overrides/:id/deactivate', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const row = await readableRow(db, req, await db.prepare('SELECT * FROM attendance_date_overrides WHERE id = ?').get(req.params.id), 'attendance_override');
  await db.prepare('UPDATE attendance_date_overrides SET is_active = 0 WHERE id = ?').run(row.id);
  res.json({ ok: true });
}));

// =================== EMPLOYEE ASSIGNMENTS ===================================

router.get('/assignments', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  const sc = await entityScope.scopeClause(db, req.userContext, 'a.legal_entity_id', { resourceType: 'attendance_assignment', route: req.originalUrl });
  const params = [...sc.params];
  let sql = `SELECT a.*, e.full_name, p.code AS pattern_code, p.pattern_type, s.code AS schedule_code
             FROM attendance_schedule_assignments a
             JOIN employees e ON e.id = a.employee_id
             LEFT JOIN attendance_work_patterns p ON p.id = a.pattern_id
             LEFT JOIN work_schedules s ON s.id = a.work_schedule_id
             WHERE ${sc.sql}`;
  if (req.query.employee_id) { sql += ' AND a.employee_id = ?'; params.push(req.query.employee_id); }
  res.json(await db.prepare(`${sql} ORDER BY e.full_name, a.effective_from DESC`).all(...params));
}));

/**
 * Assign a pattern / default shift to an employee from a date. A new
 * assignment CLOSES the open one the day before, so October keeps resolving
 * October's pattern after November's is assigned. Overlaps are rejected.
 */
router.post('/assignments', requirePermission(MODULE, 'EDIT'), handle(async (req, res, db) => {
  const b = req.body || {};
  if (!b.employee_id) bad('VALIDATION', 'employee_id wajib diisi.');
  if (!g.isValidDate(b.effective_from)) bad('INVALID_DATE', 'effective_from harus YYYY-MM-DD.');
  validateDateRange(b.effective_from, b.effective_to);
  if (!b.pattern_id && !b.work_schedule_id) bad('VALIDATION', 'pattern_id atau work_schedule_id wajib diisi.');

  const entityId = await g.assertEmployeeInScope(db, req.userContext, b.employee_id, b.effective_from, req.originalUrl);
  await assertWritableEntity(db, req, entityId, 'attendance_assignment');
  if (b.pattern_id) await readableRow(db, req, await db.prepare('SELECT * FROM attendance_work_patterns WHERE id = ?').get(b.pattern_id), 'attendance_pattern');
  if (b.work_schedule_id) await readableRow(db, req, await db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(b.work_schedule_id), 'work_schedule');

  // Overlap check (SQLite cannot express range exclusion — same compensating
  // control as payroll configuration). Exactly ONE overlap is legitimate: the
  // currently OPEN assignment that started earlier, which this one supersedes
  // (it gets closed the day before). Anything else is ambiguous and refused
  // rather than resolved by guesswork.
  const overlaps = await db.prepare(`SELECT * FROM attendance_schedule_assignments
    WHERE employee_id = ? AND effective_from <= COALESCE(?::date, '9999-12-31')
      AND (effective_to IS NULL OR effective_to >= ?)`)
    .all(b.employee_id, b.effective_to || null, b.effective_from);
  const blocking = overlaps.filter((r) => !(r.effective_to === null && r.effective_from < b.effective_from));
  if (blocking.length) {
    conflict('ASSIGNMENT_OVERLAP',
      `Penugasan jadwal bertabrakan dengan periode ${blocking[0].effective_from} → ${blocking[0].effective_to || 'terbuka'}.`);
  }

  const a = actor(req);
  const id = await withTransaction(db, async () => {
    const open = await db.prepare('SELECT * FROM attendance_schedule_assignments WHERE employee_id = ? AND effective_to IS NULL').get(b.employee_id);
    if (open) {
      if (open.effective_from >= b.effective_from) conflict('ASSIGNMENT_OVERLAP', 'Penugasan terbuka dimulai pada atau setelah tanggal ini.');
      await db.prepare('UPDATE attendance_schedule_assignments SET effective_to = ? WHERE id = ?').run(bt.addDays(b.effective_from, -1), open.id);
    }
    return Number((await db.prepare(`INSERT INTO attendance_schedule_assignments (employee_id,legal_entity_id,pattern_id,work_schedule_id,
      project_code,workfront,effective_from,effective_to,note,created_by,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
      b.employee_id, entityId, b.pattern_id || null, b.work_schedule_id || null, b.project_code || null, b.workfront || null,
      b.effective_from, b.effective_to || null, b.note || null, a.by, a.uid)).lastInsertRowid);
  });
  res.status(201).json({ id });
}));

// =================== RESOLUTION PREVIEW ======================================

/** What is this employee expected to work on this date, and why? */
router.get('/resolve/:employeeId/:date', requirePermission(MODULE, 'VIEW'), handle(async (req, res, db) => {
  if (!g.isValidDate(req.params.date)) bad('INVALID_DATE', 'Tanggal harus YYYY-MM-DD.');
  await g.assertEmployeeInScope(db, req.userContext, req.params.employeeId, req.params.date, req.originalUrl);
  const r = await ws.resolveSchedule(db, req.params.employeeId, req.params.date);
  res.json({
    date: r.date, employee_id: r.employeeId, status: r.status, reason: r.reason, source: r.source,
    day_status: r.dayStatus, day_type: r.dayType, day_type_source: r.dayTypeSource,
    cycle_day_index: r.cycleDayIndex ?? null,
    pattern: r.pattern ? { id: r.pattern.id, code: r.pattern.code, type: r.pattern.pattern_type } : null,
    schedule: r.schedule ? { id: r.schedule.id, code: r.schedule.code, clock_in: r.schedule.clock_in, clock_out: r.schedule.clock_out,
      cross_midnight: !!r.schedule.cross_midnight } : null,
    scheduled_minutes: r.scheduledMinutes, break_minutes_unpaid: r.breakMinutesUnpaid, break_minutes_paid: r.breakMinutesPaid,
    overtime_eligible_from: r.overtimeEligibleFrom, breaks: r.breaks, warnings: r.warnings,
  });
}));

/** Business-timezone context, so the UI never derives "today" itself. */
router.get('/context', requirePermission(MODULE, 'VIEW'), (req, res) => {
  res.json({ timezone: bt.BUSINESS_TIMEZONE, today: bt.businessToday(), now: bt.businessNowTime() });
});

module.exports = router;
