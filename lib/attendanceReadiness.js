// lib/attendanceReadiness.js — Attendance A4 CP2
// Readiness engine: "Is this Attendance Period ready for REVIEW -> READY_TO_CLOSE, and if not,
// exactly what blocks it?" plus the two gated transitions (ready-to-close, withdraw-ready).
//
// Contract (approved CP2 contract + amendments):
//   * Pure evaluation: reads A1–A3 state, WRITES NOTHING except the successful gate evaluation.
//   * One snapshot per evaluation (REPEATABLE READ); deterministic ordering and fingerprint.
//   * Existing logic is CALLED, never re-implemented or modified:
//       employeeEligibility.isEligibleOn (frozen), workSchedule.resolveSchedule,
//       attendanceException.detectForEntry / findOverlap, attendanceCorrection.resolvePolicy,
//       attendanceClosingPolicy.resolvePolicy.
//   * Employee/date -> Legal Entity attribution uses ONE set-based query (batchAttribution) whose
//     equivalence to attendanceGuard.entityForEmployeeOn is proven by the CP2 test suite.
//   * Responses carry machine codes only; no foreign entity identity or foreign row data.
const crypto = require('crypto');
const { withTransaction } = require('../database/db');
const { roleSnapshot } = require('./attendanceAudit');
const eligibility = require('./employeeEligibility');   // FROZEN — called only
const ws = require('./workSchedule');
const exceptionLib = require('./attendanceException');
const ac = require('./attendanceCorrection');
const ap = require('./attendancePeriod');
const cp = require('./attendanceClosingPolicy');

const { A4Error } = ap;
const ENGINE_VERSION = 'A4-CP2-1';

// Fixed blockers: BLOCKER, non-waivable, not configurable by any Closing Policy.
const FIXED = {
  NO_CLOSING_POLICY: 'NO_CLOSING_POLICY',
  TIMESHEET_LEGAL_ENTITY_UNRESOLVED: 'TIMESHEET_LEGAL_ENTITY_UNRESOLVED',
  TIMESHEET_VOID_UNPROVEN: 'TIMESHEET_VOID_UNPROVEN',
  TIMESHEET_ENTITY_CONFLICT: 'TIMESHEET_ENTITY_CONFLICT',
};
const FIXED_CODES = Object.values(FIXED);
const T = exceptionLib.TYPES;
const ROW_DETECTOR_TYPES = [T.MISSING_CLOCK_IN, T.MISSING_CLOCK_OUT, T.NO_SCHEDULE, T.OFF_DAY_ATTENDANCE,
  T.DUPLICATE_ATTENDANCE, T.ABNORMAL_DURATION, T.OT_WITHOUT_APPROVAL, T.APPROVED_OT_ACTUAL_MISMATCH];
const PENDING_CORRECTION = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'VOID_REQUESTED', 'VOID_REVIEWED', 'VOID_APPROVED'];
const OPEN_EXCEPTION = ['OPEN', 'ASSIGNED', 'REOPENED'];
const SEV_RANK = { BLOCKER: 0, WARNING: 1, INFORMATIONAL: 2 };
const ALL_CODES = [...FIXED_CODES, ...cp.ISSUE_CODES];
const PERMISSION = { VIEW: 'attendance_readiness:VIEW', APPROVE: 'attendance_readiness:APPROVE' };

function newStats() {
  return { employee_days_evaluated: 0, attendance_rows_processed: 0, frozen_pair_calls: 0, is_eligible_calls: 0,
    resolve_schedule_calls: 0, cross_midnight_candidates: 0, find_overlap_calls: 0, attribution_queries: 0, issues: 0 };
}

// ---------------------------------------------------------------------------
// Batch attribution R(e, d) — ONE query. Semantics (approved):
//   dated step  = frozen employeeEligibility.getAssignmentOn predicate; T = rows at max effective_date.
//                 identical K=(legal_entity_id, work_pattern_id, work_calendar_id) across T -> that entity,
//                 divergent K -> AMBIGUOUS.
//   fallback    = entityScope.resolveResourceEntity('employee') predicate (latest effective_date overall);
//                 one entity -> it, several -> AMBIGUOUS, none -> NULL.
// ---------------------------------------------------------------------------
const ATTRIBUTION_SQL = (pairsCte) => `
  WITH p AS (${pairsCte}),
  dated AS (
    SELECT p.employee_id, p.work_date, a.legal_entity_id, a.work_pattern_id, a.work_calendar_id,
           rank() OVER (PARTITION BY p.employee_id, p.work_date ORDER BY a.effective_date DESC) AS rk
    FROM p JOIN employee_payroll_assignments a
      ON a.employee_id = p.employee_id AND a.effective_date <= p.work_date
     AND (a.end_date IS NULL OR a.end_date >= p.work_date)),
  dtop AS (
    SELECT employee_id, work_date,
           count(DISTINCT legal_entity_id || '|' || work_pattern_id::text || '|' || COALESCE(work_calendar_id::text, '-')) AS k_variants,
           array_agg(DISTINCT legal_entity_id ORDER BY legal_entity_id) AS entities,
           min(legal_entity_id) AS entity, min(work_pattern_id) AS work_pattern_id, min(work_calendar_id) AS work_calendar_id
    FROM dated WHERE rk = 1 GROUP BY employee_id, work_date),
  emp AS (SELECT DISTINCT employee_id FROM p),
  fb AS (
    SELECT a.employee_id, a.legal_entity_id,
           rank() OVER (PARTITION BY a.employee_id ORDER BY a.effective_date DESC) AS rk
    FROM emp JOIN employee_payroll_assignments a ON a.employee_id = emp.employee_id),
  ftop AS (SELECT employee_id, array_agg(DISTINCT legal_entity_id ORDER BY legal_entity_id) AS entities
           FROM fb WHERE rk = 1 GROUP BY employee_id)
  SELECT p.employee_id, p.work_date, p.is_grid, d.k_variants, d.entities AS d_entities, d.entity AS d_entity,
         d.work_pattern_id, d.work_calendar_id, f.entities AS f_entities
  FROM p LEFT JOIN dtop d ON d.employee_id = p.employee_id AND d.work_date = p.work_date
         LEFT JOIN ftop f ON f.employee_id = p.employee_id`;

function toAttribution(r) {
  if (r.k_variants) {
    if (Number(r.k_variants) > 1) return { status: 'AMBIGUOUS', step: 'DATED', entities: r.d_entities };
    return { status: 'ENTITY', step: 'DATED', entity: r.d_entity, entities: [r.d_entity],
      k: { legal_entity_id: r.d_entity, work_pattern_id: r.work_pattern_id, work_calendar_id: r.work_calendar_id } };
  }
  if (r.f_entities && r.f_entities.length) {
    if (r.f_entities.length > 1) return { status: 'AMBIGUOUS', step: 'FALLBACK', entities: r.f_entities };
    return { status: 'ENTITY', step: 'FALLBACK', entity: r.f_entities[0], entities: r.f_entities };
  }
  return { status: 'NULL', step: null, entities: [] };
}
const keyOf = (e, d) => `${e}|${d}`;

/** Attribution for explicit (employee_id, work_date) pairs — the entry point the equivalence suite uses. */
async function batchAttribution(db, pairs, stats = null) {
  if (stats) stats.attribution_queries += 1;
  const rows = await db.query(ATTRIBUTION_SQL(`SELECT DISTINCT x.employee_id, x.work_date, false AS is_grid
      FROM unnest($1::text[], $2::date[]) AS x(employee_id, work_date)`),
  [pairs.map((p) => p.employee_id), pairs.map((p) => p.work_date)]);
  const out = new Map();
  for (const r of rows.rows) out.set(keyOf(r.employee_id, r.work_date), toAttribution(r));
  return out;
}

/** Evaluation form: the period grid (days of assignments to this entity) plus explicit pairs, same SQL. */
async function periodAttribution(db, period, extraPairs, stats) {
  stats.attribution_queries += 1;
  const res = await db.query(ATTRIBUTION_SQL(`
      SELECT employee_id, work_date, bool_or(is_grid) AS is_grid FROM (
        SELECT a.employee_id, g::date AS work_date, true AS is_grid
        FROM employee_payroll_assignments a
        CROSS JOIN LATERAL generate_series(GREATEST(a.effective_date, $4::date),
          LEAST(COALESCE(a.end_date, $5::date), $5::date), interval '1 day') g
        WHERE a.legal_entity_id = $3 AND a.effective_date <= $5::date AND (a.end_date IS NULL OR a.end_date >= $4::date)
        UNION ALL
        SELECT x.employee_id, x.work_date, false FROM unnest($1::text[], $2::date[]) AS x(employee_id, work_date)
      ) u GROUP BY employee_id, work_date`),
  [extraPairs.map((p) => p.employee_id), extraPairs.map((p) => p.work_date), period.legal_entity_id,
    period.start_date, period.end_date]);
  const map = new Map(); const grid = [];
  for (const r of res.rows) {
    const k = keyOf(r.employee_id, r.work_date);
    map.set(k, toAttribution(r));
    if (r.is_grid) grid.push({ employee_id: r.employee_id, work_date: r.work_date });
  }
  grid.sort((a, b) => (a.employee_id < b.employee_id ? -1 : a.employee_id > b.employee_id ? 1 : (a.work_date < b.work_date ? -1 : 1)));
  return { map, grid };
}

// ---------------------------------------------------------------------------
// Deterministic serialization + fingerprint
// ---------------------------------------------------------------------------
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function compareIssues(a, b) {
  return (SEV_RANK[a.severity] - SEV_RANK[b.severity])
    || (a.issue_code < b.issue_code ? -1 : a.issue_code > b.issue_code ? 1 : 0)
    || String(a.work_date || '').localeCompare(String(b.work_date || ''))
    || String(a.employee_id || '').localeCompare(String(b.employee_id || ''))
    || String(a.source_id).localeCompare(String(b.source_id), 'en', { numeric: true });
}

const ROW_COLUMNS = `t.id, t.employee_id, t.work_date, t.legal_entity_id, t.record_status, t.attendance_status, t.clock_in,
  t.clock_out, t.clock_out_date, t.work_minutes, t.scheduled_minutes, t.worked_after_shift_minutes, t.overtime_status,
  t.overtime_minutes_approved, t.work_schedule_id, t.schedule_source, t.day_status, t.day_type, t.updated_at,
  t.void_correction_id, t.last_correction_id, t.current_version`;

// ---------------------------------------------------------------------------
// Evaluation (caller supplies the REPEATABLE READ transaction)
// ---------------------------------------------------------------------------
async function evaluate(db, period, stats = newStats()) {
  const E = period.legal_entity_id; const S = period.start_date; const D = period.end_date;
  const issues = []; const conflictDays = new Set();
  const add = (code, level, sourceType, sourceId, employeeId, workDate, detail = {}, refExceptionId = null) => issues.push({
    issue_code: code, level, source_type: sourceType, source_id: String(sourceId), employee_id: employeeId,
    work_date: workDate, reference_exception_id: refExceptionId, detail });
  const addConflictDay = (e, d) => {
    const k = keyOf(e, d);
    if (conflictDays.has(k)) return;
    conflictDays.add(k);
    add(FIXED.TIMESHEET_ENTITY_CONFLICT, 'EMPLOYEE_DAY', 'employee_day', k, e, d);
  };

  // 1. Closing Policy in force on end_date (ACTIVE or ENDED only).
  const policy = await cp.resolvePolicy(db, E, D);
  if (!policy) add(FIXED.NO_CLOSING_POLICY, 'PERIOD', 'attendance_period', period.id, null, null);
  const rules = new Map((policy ? policy.rules : []).map((r) => [r.issue_code, r]));

  // 2. Attendance rows that can matter to this entity: stored E, stored NULL, or rows of employees
  //    assigned to E in the range (foreign rows are needed only to detect A-side conflicts).
  const rows = await db.prepare(`SELECT ${ROW_COLUMNS} FROM timesheet_entries t
    WHERE t.work_date >= @s AND t.work_date <= @d AND (t.legal_entity_id = @e OR t.legal_entity_id IS NULL
      OR t.employee_id IN (SELECT a.employee_id FROM employee_payroll_assignments a WHERE a.legal_entity_id = @e
        AND a.effective_date <= @d AND (a.end_date IS NULL OR a.end_date >= @s)))
    ORDER BY t.id`).all({ s: S, d: D, e: E });
  stats.attendance_rows_processed += rows.length;
  const rowByKey = new Map(); const rowById = new Map();
  for (const r of rows) { rowByKey.set(keyOf(r.employee_id, r.work_date), r); rowById.set(r.id, r); }

  // 3. Correction-linked exceptions (LATE_CORRECTION, PAYROLL_ADJUSTMENT_REQUIRED).
  const linked = await db.prepare(`SELECT x.id, x.exception_type, x.employee_id, x.work_date, x.correction_id,
      x.legal_entity_id AS x_entity, t.legal_entity_id AS t_entity, c.id AS c_id, c.status AS c_status
    FROM attendance_exceptions x
    LEFT JOIN timesheet_entries t ON t.id = x.timesheet_entry_id
    LEFT JOIN attendance_corrections c ON c.id = x.correction_id
    WHERE x.exception_type IN ('LATE_CORRECTION','PAYROLL_ADJUSTMENT_REQUIRED')
      AND x.status IN ('OPEN','ASSIGNED','REOPENED') AND x.work_date >= @s AND x.work_date <= @d
    ORDER BY x.id`).all({ s: S, d: D });

  // 4. ONE batch attribution query for the grid + every pair needing attribution.
  const extra = [];
  for (const r of rows) if (r.legal_entity_id === E || r.legal_entity_id === null) extra.push({ employee_id: r.employee_id, work_date: r.work_date });
  for (const x of linked) if (!x.x_entity && !x.t_entity) extra.push({ employee_id: x.employee_id, work_date: x.work_date });
  const { map: R, grid } = await periodAttribution(db, period, extra, stats);
  const attributedToE = (a) => a && a.status === 'ENTITY' && a.entity === E;

  // 5. Row ownership (B-side for stored E) and NULL-row attribution.
  const population = [];          // non-voided rows attributed to E
  const voidCandidates = [];      // voided rows attributed to E
  for (const r of rows) {
    const k = keyOf(r.employee_id, r.work_date); const a = R.get(k);
    let mine = false;
    if (r.legal_entity_id === E) {
      mine = true;
      if (!attributedToE(a)) { conflictDays.add(k); add(FIXED.TIMESHEET_ENTITY_CONFLICT, 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date); }
    } else if (r.legal_entity_id === null) {
      if (attributedToE(a)) mine = true;
      else if (a && a.status === 'AMBIGUOUS' && a.entities.includes(E)) addConflictDay(r.employee_id, r.work_date);
    }
    if (!mine) continue;
    if (r.record_status === 'VOIDED') { voidCandidates.push(r); continue; }
    population.push(r);
    if (r.legal_entity_id === null) add(FIXED.TIMESHEET_LEGAL_ENTITY_UNRESOLVED, 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date);
  }

  // 6. Accounted void: complete approved A3 provenance, all invariants in one query.
  const accounted = new Set();
  if (voidCandidates.length) {
    const ok = await db.query(`SELECT t.id FROM timesheet_entries t
      JOIN attendance_corrections c ON c.id = t.void_correction_id
      WHERE t.id = ANY($1::bigint[]) AND t.record_status = 'VOIDED' AND t.last_correction_id = c.id
        AND c.request_type = 'VOID' AND c.status = 'VOIDED' AND c.applied_to_source = 1 AND c.timesheet_entry_id = t.id
        AND c.employee_id = t.employee_id AND c.work_date = t.work_date AND c.legal_entity_id = $2
        AND EXISTS (SELECT 1 FROM attendance_entry_versions v WHERE v.timesheet_entry_id = t.id AND v.correction_id = c.id
          AND v.version_type = 'VOID' AND v.version_no = t.current_version AND v.applied_to_source = 1)`,
    [voidCandidates.map((r) => r.id), E]);
    for (const r of ok.rows) accounted.add(Number(r.id));
    for (const r of voidCandidates) {
      if (!accounted.has(r.id)) add(FIXED.TIMESHEET_VOID_UNPROVEN, 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date);
    }
  }

  // 7. Daily coverage over the expected-day grid (A-side).
  const scheduleCache = ws.makeCache();
  const expectation = async (e, d) => {
    stats.frozen_pair_calls += 1; stats.is_eligible_calls += 1;
    const el = await eligibility.isEligibleOn(db, e, d);
    if (!el.eligible || !el.assignment || el.assignment.legal_entity_id !== E) return { kind: 'NOT_EXPECTED' };
    stats.frozen_pair_calls += 1; stats.resolve_schedule_calls += 1;
    const rs = await ws.resolveSchedule(db, e, d, { cache: scheduleCache });
    if (rs.status !== 'OK') return { kind: 'UNRESOLVED', status: rs.status };
    if (rs.dayStatus !== 'WORK') return { kind: 'NOT_EXPECTED' };
    if (rs.dayType === null || rs.dayType === undefined) return { kind: 'UNCLASSIFIED' };
    if (rs.dayType !== 'WORKDAY') return { kind: 'NOT_EXPECTED' };
    return { kind: 'EXPECTED' };
  };
  stats.employee_days_evaluated += grid.length;
  for (const { employee_id: e, work_date: d } of grid) {
    const k = keyOf(e, d); const a = R.get(k);
    if (a.status === 'AMBIGUOUS' && a.step === 'DATED') {
      if (a.entities.includes(E)) addConflictDay(e, d);   // no frozen call: its pick would be arbitrary
      continue;
    }
    if (!(a.status === 'ENTITY' && a.step === 'DATED' && a.entity === E)) continue;   // not this entity's day
    const row = rowByKey.get(k);
    if (row && (row.legal_entity_id === E || row.legal_entity_id === null)) continue;   // covered / accounted / unproven handled above
    const x = await expectation(e, d);
    if (row) {   // foreign-entity row occupies the key
      if (x.kind !== 'NOT_EXPECTED') addConflictDay(e, d);
      continue;
    }
    if (x.kind === 'EXPECTED') add('MISSING_ATTENDANCE', 'EMPLOYEE_DAY', 'employee_day', k, e, d);
    else if (x.kind === 'UNRESOLVED') add('UNRESOLVED_SCHEDULE', 'EMPLOYEE_DAY', 'employee_day', k, e, d, { schedule_status: x.status });
    else if (x.kind === 'UNCLASSIFIED') add('UNCLASSIFIED_DAY_TYPE', 'EMPLOYEE_DAY', 'employee_day', k, e, d);
  }

  // 8. Row-level checks on the covered, non-voided population.
  const exRows = await db.prepare(`SELECT x.id, x.timesheet_entry_id, x.exception_type, x.status,
      (x.status = 'RESOLVED' AND x.resolved_at > t.updated_at) AS suppresses
    FROM attendance_exceptions x JOIN timesheet_entries t ON t.id = x.timesheet_entry_id
    WHERE x.work_date >= @s AND x.work_date <= @d ORDER BY x.id`).all({ s: S, d: D });
  const suppressed = new Set(); const openRef = new Map();
  for (const x of exRows) {
    const k = `${x.timesheet_entry_id}|${x.exception_type}`;
    if (x.suppresses) suppressed.add(k);
    if (OPEN_EXCEPTION.includes(x.status) && !openRef.has(k)) openRef.set(k, x.id);
  }
  const policyCache = new Map();
  const correctionPolicy = async (date) => {
    if (!policyCache.has(date)) policyCache.set(date, (await ac.resolvePolicy(db, E, date)).policy);
    return policyCache.get(date);
  };
  const foreignOverlapIds = [];
  for (const r of population) {
    if (r.overtime_status === 'pending') add('PENDING_OVERTIME_APPROVAL', 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date);
    if (r.day_status === null || (r.day_status === 'WORK' && r.work_schedule_id === null)) {
      add('UNRESOLVED_SCHEDULE', 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date);
    }
    if (r.day_type === null) add('UNCLASSIFIED_DAY_TYPE', 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date);
    // Approved optimization: the A3 cross-midnight precondition, verbatim from findOverlap's first line.
    let duplicateOf = null;
    if (r.clock_out_date && r.clock_out_date !== r.work_date) {
      stats.cross_midnight_candidates += 1; stats.find_overlap_calls += 1;
      duplicateOf = await exceptionLib.findOverlap(db, r);
    }
    const findings = exceptionLib.detectForEntry(r, await correctionPolicy(r.work_date), { duplicateOf });
    for (const f of findings) {
      if (!ROW_DETECTOR_TYPES.includes(f.type)) continue;
      const k = `${r.id}|${f.type}`;
      if (suppressed.has(k)) continue;
      const detail = { ...(f.detail || {}) };
      if (f.type === T.DUPLICATE_ATTENDANCE) foreignOverlapIds.push({ detail, id: detail.overlaps_entry_id });
      add(f.type, 'ROW', 'timesheet_entry', r.id, r.employee_id, r.work_date, detail, openRef.get(k) || null);
    }
  }
  // DUPLICATE redaction: reveal the overlapping row only when it belongs to this entity.
  if (foreignOverlapIds.length) {
    const unknown = foreignOverlapIds.map((f) => f.id).filter((id) => !rowById.has(id));
    const ent = new Map();
    if (unknown.length) {
      for (const r of (await db.query('SELECT id, legal_entity_id FROM timesheet_entries WHERE id = ANY($1::bigint[])', [unknown])).rows) {
        ent.set(Number(r.id), r.legal_entity_id);
      }
    }
    for (const f of foreignOverlapIds) {
      const entity = rowById.has(f.id) ? rowById.get(f.id).legal_entity_id : ent.get(f.id);
      if (entity !== E) { delete f.detail.overlaps_entry_id; f.detail.overlaps_entry_in_scope = false; }
    }
  }

  // 9. Correction-linked exceptions follow their correction's lifecycle.
  for (const x of linked) {
    const a = (!x.x_entity && !x.t_entity) ? R.get(keyOf(x.employee_id, x.work_date)) : null;
    const entity = x.x_entity || x.t_entity || (a && a.status === 'ENTITY' ? a.entity : null);
    const belongs = entity === E || (a && a.status === 'AMBIGUOUS' && a.entities.includes(E));
    if (!belongs) continue;
    let counts;
    if (x.correction_id === null || x.c_id === null) counts = true;   // fail-safe: unverifiable lifecycle
    else if (x.exception_type === T.LATE_CORRECTION) counts = PENDING_CORRECTION.includes(x.c_status);
    else counts = PENDING_CORRECTION.includes(x.c_status) || x.c_status === 'PENDING_PAYROLL_REVIEW';
    if (counts) add(x.exception_type, 'EXCEPTION', 'attendance_exception', x.id, x.employee_id, x.work_date, {}, x.id);
  }

  // 10. Pending correction requests.
  const reqs = await db.prepare(`SELECT id, employee_id, work_date, status FROM attendance_corrections
    WHERE legal_entity_id = @e AND work_date >= @s AND work_date <= @d
      AND status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','VOID_REQUESTED','VOID_REVIEWED','VOID_APPROVED','PENDING_PAYROLL_REVIEW')
    ORDER BY id`).all({ e: E, s: S, d: D });
  for (const c of reqs) {
    add(c.status === 'PENDING_PAYROLL_REVIEW' ? 'PENDING_PAYROLL_REVIEW' : 'PENDING_ATTENDANCE_CORRECTION',
      'REQUEST', 'attendance_correction', c.id, c.employee_id, c.work_date);
  }

  // 11. Severity: fixed > policy rule > default BLOCKER non-waivable.
  for (const i of issues) {
    if (FIXED_CODES.includes(i.issue_code)) Object.assign(i, { severity: 'BLOCKER', waivable: 0, evidence_required: 0, rule_source: 'FIXED' });
    else if (rules.has(i.issue_code)) {
      const r = rules.get(i.issue_code);
      Object.assign(i, { severity: r.severity, waivable: r.waivable, evidence_required: r.evidence_required, rule_source: 'POLICY' });
    } else Object.assign(i, { severity: 'BLOCKER', waivable: 0, evidence_required: 0, rule_source: 'DEFAULT' });
  }
  issues.sort(compareIssues);
  stats.issues += issues.length;

  const summary = { blockers: 0, warnings: 0, informational: 0 };
  const groupMap = new Map();
  for (const i of issues) {
    if (i.severity === 'BLOCKER') summary.blockers += 1; else if (i.severity === 'WARNING') summary.warnings += 1; else summary.informational += 1;
    const g = groupMap.get(i.issue_code) || { issue_code: i.issue_code, severity: i.severity, waivable: i.waivable,
      evidence_required: i.evidence_required, rule_source: i.rule_source, levels: [], count: 0 };
    g.count += 1; if (!g.levels.includes(i.level)) g.levels.push(i.level);
    groupMap.set(i.issue_code, g);
  }
  const groups = [...groupMap.values()].map((g) => ({ ...g, levels: g.levels.sort() }));
  const fingerprint = crypto.createHash('sha256').update(stable({
    engine: ENGINE_VERSION,
    period: { id: period.id, legal_entity_id: E, start_date: S, end_date: D },
    policy: policy ? { id: policy.id, version_no: policy.version_no } : null,
    issues: issues.map((i) => ({ c: i.issue_code, s: i.severity, l: i.level, t: i.source_type, i: i.source_id,
      e: i.employee_id, d: i.work_date, x: i.reference_exception_id, dt: i.detail })),
  })).digest('hex');
  return {
    period_id: period.id, legal_entity_id: E, period_status: period.status, ready: summary.blockers === 0, summary,
    policy: policy ? { policy_id: policy.id, version_no: policy.version_no, as_of_date: D } : null,
    engine_version: ENGINE_VERSION, fingerprint, groups, issues,
  };
}

// ---------------------------------------------------------------------------
// Transactions and context
// ---------------------------------------------------------------------------
async function inSnapshot(db, readOnly, fn) {
  return withTransaction(db, async () => {
    await db.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ${readOnly ? ' READ ONLY' : ''}`);
    return fn();
  });
}
async function setContext(db, userContext, permission, reason, extra = {}) {
  await db.query(`SELECT set_config('kahe.actor_user_id', $1, true), set_config('kahe.actor_name', $2, true),
    set_config('kahe.actor_role', $3, true), set_config('kahe.permission', $4, true), set_config('kahe.reason', $5, true),
    set_config('kahe.readiness_evaluation_id', $6, true), set_config('kahe.readiness_action', $7, true)`,
  [String(userContext.id), userContext.displayName || '', roleSnapshot(userContext) || '', permission, reason || '',
    extra.readiness_evaluation_id ? String(extra.readiness_evaluation_id) : '', extra.readiness_action || '']);
}

/** The evaluation bound to the latest TRANSITION event that entered the current READY_TO_CLOSE state. */
async function readinessRecord(db, period) {
  const bad = (reason) => new A4Error('ATTENDANCE_READINESS_RECORD_INVALID', { reason });
  const ev = await db.prepare(`SELECT id, to_status, new_values->>'readiness_evaluation_id' AS ref
    FROM attendance_period_events WHERE period_id = ? AND event_type = 'TRANSITION' ORDER BY id DESC LIMIT 1`).get(period.id);
  if (!ev) throw bad('TRANSITION_EVENT_MISSING');
  if (ev.to_status !== 'READY_TO_CLOSE') throw bad('LATEST_TRANSITION_MISMATCH');
  if (!ev.ref || !/^[0-9]+$/.test(ev.ref)) throw bad('EVALUATION_REFERENCE_MISSING');
  const e = await db.prepare(`SELECT id, period_id, blocker_count, fingerprint, evaluated_at, policy_id, policy_version_no
    FROM attendance_readiness_evaluations WHERE id = ?`).get(Number(ev.ref));
  if (!e || e.period_id !== period.id || e.blocker_count !== 0) throw bad('EVALUATION_INVALID');
  return { evaluation_id: e.id, fingerprint: e.fingerprint, evaluated_at: e.evaluated_at, policy_id: e.policy_id,
    policy_version_no: e.policy_version_no };
}

const publicIssue = (i) => ({ issue_code: i.issue_code, severity: i.severity, waivable: i.waivable,
  evidence_required: i.evidence_required, rule_source: i.rule_source, level: i.level, source_type: i.source_type,
  source_id: i.source_id, employee_id: i.employee_id, work_date: i.work_date,
  reference_exception_id: i.reference_exception_id, detail: i.detail });

// ---------------------------------------------------------------------------
// Public operations (entity scope first, then one snapshot)
// ---------------------------------------------------------------------------
async function preview(db, userContext, id, route = null, stats = newStats()) {
  const p0 = await ap.getPeriod(db, userContext, id, route);
  return ap.mapped(() => inSnapshot(db, true, async () => {
    const p = await db.prepare('SELECT * FROM attendance_periods WHERE id = ?').get(p0.id);
    const r = await evaluate(db, p, stats);
    const evaluatedAt = (await db.prepare('SELECT kahe_now() AS t').get()).t;
    const record = p.status === 'READY_TO_CLOSE' ? await readinessRecord(db, p) : null;
    const { issues, ...rest } = r;
    return { ...rest, evaluated_at: evaluatedAt, readiness_record: record,
      stale: record ? record.fingerprint !== r.fingerprint : null };
  }));
}

async function issueDetail(db, userContext, id, query = {}, route = null) {
  if (query.issue_code !== undefined && !ALL_CODES.includes(query.issue_code)) {
    throw new A4Error('REQUEST_FIELD_INVALID', { field: 'issue_code' });
  }
  const { limit, offset } = ap.paging(query);
  const p0 = await ap.getPeriod(db, userContext, id, route);
  return ap.mapped(() => inSnapshot(db, true, async () => {
    const p = await db.prepare('SELECT * FROM attendance_periods WHERE id = ?').get(p0.id);
    const r = await evaluate(db, p);
    const all = query.issue_code ? r.issues.filter((i) => i.issue_code === query.issue_code) : r.issues;
    return { period_id: p.id, fingerprint: r.fingerprint, total: all.length, limit, offset,
      items: all.slice(offset, offset + limit).map(publicIssue) };
  }));
}

async function readyToClose(db, userContext, id, body, route = null) {
  const b = ap.assertBody(body, ['expected_status', 'expected_fingerprint'], ['expected_status', 'expected_fingerprint']);
  if (b.expected_status !== 'REVIEW') throw new A4Error('REQUEST_FIELD_INVALID', { field: 'expected_status' });
  if (typeof b.expected_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(b.expected_fingerprint)) {
    throw new A4Error('REQUEST_FIELD_INVALID', { field: 'expected_fingerprint' });
  }
  const p0 = await ap.getPeriod(db, userContext, id, route);
  return ap.mapped(() => inSnapshot(db, false, async () => {
    await setContext(db, userContext, PERMISSION.APPROVE, null);
    const p = await db.prepare('SELECT * FROM attendance_periods WHERE id = ? FOR NO KEY UPDATE').get(p0.id);
    if (p.status !== 'REVIEW') throw new A4Error('ATTENDANCE_PERIOD_STATE_CHANGED', { expected_status: 'REVIEW', current_status: p.status });
    const r = await evaluate(db, p);
    if (r.summary.blockers > 0) {
      throw new A4Error('ATTENDANCE_READINESS_NOT_READY', { summary: r.summary, fingerprint: r.fingerprint,
        blocking_codes: [...new Set(r.issues.filter((i) => i.severity === 'BLOCKER').map((i) => i.issue_code))] });
    }
    if (r.fingerprint !== b.expected_fingerprint) {
      throw new A4Error('ATTENDANCE_READINESS_CHANGED', { expected_fingerprint: b.expected_fingerprint, current_fingerprint: r.fingerprint });
    }
    const ev = await db.prepare(`INSERT INTO attendance_readiness_evaluations (period_id, legal_entity_id, policy_id,
        policy_version_no, policy_as_of_date, blocker_count, warning_count, informational_count, summary, fingerprint,
        engine_version, evaluated_at, actor_user_id, actor_name, actor_role, permission, txid)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, kahe_now(), 0, '', '', '', 0) RETURNING *`).get(
      p.id, p.legal_entity_id, r.policy.policy_id, r.policy.version_no, r.policy.as_of_date, r.summary.blockers,
      r.summary.warnings, r.summary.informational, JSON.stringify({ summary: r.summary, groups: r.groups }),
      r.fingerprint, ENGINE_VERSION);
    await db.query(`SELECT set_config('kahe.readiness_evaluation_id', $1, true)`, [String(ev.id)]);
    const row = await db.prepare(`UPDATE attendance_periods SET status = 'READY_TO_CLOSE' WHERE id = ? AND status = 'REVIEW' RETURNING *`).get(p.id);
    return { period: row, evaluation: { evaluation_id: ev.id, fingerprint: ev.fingerprint, evaluated_at: ev.evaluated_at,
      policy_id: ev.policy_id, policy_version_no: ev.policy_version_no, summary: r.summary } };
  }));
}

async function withdrawReady(db, userContext, id, body, route = null) {
  const b = ap.assertBody(body, ['expected_status', 'reason'], ['expected_status']);
  if (b.expected_status !== 'READY_TO_CLOSE') throw new A4Error('REQUEST_FIELD_INVALID', { field: 'expected_status' });
  const reason = ap.optionalText(b.reason, 'reason', 1000);
  const p0 = await ap.getPeriod(db, userContext, id, route);
  return ap.mapped(() => withTransaction(db, async () => {
    await setContext(db, userContext, PERMISSION.APPROVE, reason, { readiness_action: 'WITHDRAW' });
    const row = await db.prepare(`UPDATE attendance_periods SET status = 'REVIEW' WHERE id = ? AND status = 'READY_TO_CLOSE' RETURNING *`).get(p0.id);
    if (row) return row;
    const now = await db.prepare('SELECT status FROM attendance_periods WHERE id = ?').get(p0.id);
    throw new A4Error('ATTENDANCE_PERIOD_STATE_CHANGED', { expected_status: 'READY_TO_CLOSE', current_status: now ? now.status : null });
  }));
}

module.exports = {
  ENGINE_VERSION, FIXED, FIXED_CODES, ALL_CODES, PERMISSION, PENDING_CORRECTION, newStats,
  batchAttribution, evaluate, inSnapshot, readinessRecord, preview, issueDetail, readyToClose, withdrawReady,
};
