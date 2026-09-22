// lib/asOfResolver.js
// Phase 2B — THE canonical as-of resolution layer.
//
// SCOPE LOCK: resolves VERSIONS and raw QUANTITIES. Calculates nothing —
// no gross, net, BPJS amount, tax amount or overtime value appears here.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
//   Never "latest row". Every lookup is bounded by the as-of date:
//       effective_from <= as_of AND (effective_to IS NULL OR effective_to >= as_of)
//   A query that orders by id DESC or takes the newest row without a date
//   bound is a defect, not a shortcut — it is exactly how a rule activated in
//   August would silently re-price June.
//
// FAILURE POLICY: missing, ambiguous, overlapping or inconsistent
// configuration returns a named error in `errors[]` and leaves the affected
// slice null. The resolver never guesses and never substitutes a default.
// Callers must treat a non-OK status as an exception to surface.
//
// Composes the existing canonical libraries rather than re-deriving anything:
//   lib/employeeEligibility.js  — who is payable, and for which days
//   lib/salaryStructure.js      — which components, at what amounts
//   lib/dayClassification.js    — what kind of day each date is
//   lib/payrollPeriod.js        — which period owns a date

const crypto = require('crypto');
const eligibility = require('./employeeEligibility');
const salary = require('./salaryStructure');
const dayClass = require('./dayClassification');
const period = require('./payrollPeriod');

const RESOLUTION_STATUS = { OK: 'OK', INCOMPLETE: 'INCOMPLETE' };

const ERROR = {
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  PERIOD_NOT_FOUND: 'PERIOD_NOT_FOUND',
  MISSING_ASSIGNMENT: 'MISSING_ASSIGNMENT',
  AMBIGUOUS_ASSIGNMENT: 'AMBIGUOUS_ASSIGNMENT',
  MISSING_PAYROLL_GROUP: 'MISSING_PAYROLL_GROUP',
  GROUP_NOT_EFFECTIVE: 'GROUP_NOT_EFFECTIVE',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
  MISSING_LEGAL_ENTITY: 'MISSING_LEGAL_ENTITY',
  MISSING_RULE_SET: 'MISSING_RULE_SET',
  AMBIGUOUS_RULE_SET: 'AMBIGUOUS_RULE_SET',
  MISSING_JKK_RATE: 'MISSING_JKK_RATE',
  AMBIGUOUS_JKK_RATE: 'AMBIGUOUS_JKK_RATE',
  MISSING_TER_TABLE: 'MISSING_TER_TABLE',
  MISSING_OVERTIME_RULES: 'MISSING_OVERTIME_RULES',
  MISSING_SALARY_STRUCTURE: 'MISSING_SALARY_STRUCTURE',
  MISSING_WORK_PATTERN: 'MISSING_WORK_PATTERN',
  CALENDAR_UNRESOLVED: 'CALENDAR_UNRESOLVED',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  UNCLASSIFIED_OVERTIME_DAY: 'UNCLASSIFIED_OVERTIME_DAY',
};

/** Standard as-of predicate. Every version lookup in this file uses it. */
const AS_OF = (col = 'effective_from', end = 'effective_to') =>
  `${col} <= @as_of AND (${end} IS NULL OR ${end} >= @as_of)`;

/**
 * Resolve every configuration version and raw quantity that applies to one
 * employee for one payroll period.
 *
 * @param {object} db     open handle (caller owns it)
 * @param {string} employeeId
 * @param {number} payrollPeriodId
 * @param {string} [asOfDate] defaults to the period's period_end — the date
 *        the whole period's configuration is pinned to. Passing an explicit
 *        date lets a caller resolve "as it stood mid-period" for diagnosis.
 * @returns {object} resolution result; `status` is INCOMPLETE when `errors`
 *          is non-empty. Never throws for a data problem.
 */
async function resolve(db, employeeId, payrollPeriodId, asOfDate = null) {
  const errors = [];
  const addError = (code, detail) => errors.push({ code, detail });

  const per = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(payrollPeriodId);
  if (!per) {
    return finalise({ employeeId, payrollPeriodId, asOfDate, errors: [{ code: ERROR.PERIOD_NOT_FOUND, detail: `payroll_period ${payrollPeriodId}` }] });
  }
  const requestedAsOf = asOfDate || per.period_end;
  let as_of = requestedAsOf;

  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) {
    return finalise({ employeeId, payrollPeriodId, asOfDate: as_of, period: per, errors: [{ code: ERROR.EMPLOYEE_NOT_FOUND, detail: employeeId }] });
  }

  // ---- 0. effective as-of date ------------------------------------------------
  // DEFECT FIX (found in Phase 2D): resolving a LEAVER as of period_end finds
  // no assignment, because theirs ended mid-period — they would be blocked
  // despite being owed 20 days' pay. The effective as-of is therefore the last
  // day the employee was actually payable within the period, falling back to
  // period_end for everyone still employed. An explicitly supplied asOfDate
  // always wins, so diagnosis is unaffected.
  const eligPreview = await eligibility.getEligibilityForPeriod(db, employeeId, per.period_start, per.period_end);
  const lastPayableDate = eligPreview.segments.length
    ? eligPreview.segments[eligPreview.segments.length - 1].to
    : null;
  const effectiveAsOf = asOfDate || (lastPayableDate && lastPayableDate < as_of ? lastPayableDate : as_of);
  as_of = effectiveAsOf;

  // ---- 1. Employee Payroll Assignment (as of) ------------------------------
  const assignments = await db.prepare(`
    SELECT * FROM employee_payroll_assignments
    WHERE employee_id = @employee_id AND ${AS_OF('effective_date', 'end_date')}
  `).all({ employee_id: employeeId, as_of });

  let assignment = null;
  if (assignments.length === 0) addError(ERROR.MISSING_ASSIGNMENT, `no assignment effective on ${as_of}`);
  else if (assignments.length > 1) addError(ERROR.AMBIGUOUS_ASSIGNMENT, `${assignments.length} assignments effective on ${as_of}`);
  else [assignment] = assignments;

  // ---- 2. Payroll Group (as of) --------------------------------------------
  let group = null;
  if (assignment) {
    if (!assignment.payroll_group_id) addError(ERROR.MISSING_PAYROLL_GROUP, 'assignment has no payroll_group_id');
    else {
      const groups = await db.prepare(`
        SELECT * FROM payroll_groups WHERE id = @id AND ${AS_OF()}
      `).all({ id: assignment.payroll_group_id, as_of });
      if (groups.length === 0) addError(ERROR.GROUP_NOT_EFFECTIVE, `payroll_group ${assignment.payroll_group_id} not effective on ${as_of}`);
      else [group] = groups;
    }
  }

  // Legal entity isolation: the snapshot's period must belong to the same
  // group the employee is in. A mismatch means someone is being paid out of
  // another entity's cycle — always an error, never reconciled silently.
  if (group && group.id !== per.payroll_group_id) {
    addError(ERROR.ENTITY_MISMATCH, `employee is in group ${group.code} but the period belongs to group ${per.payroll_group_id}`);
  }

  // ---- 3. Legal Entity ------------------------------------------------------
  let legalEntity = null;
  if (assignment) {
    legalEntity = await db.prepare('SELECT * FROM legal_entities WHERE id = ?').get(assignment.legal_entity_id) || null;
    if (!legalEntity) addError(ERROR.MISSING_LEGAL_ENTITY, assignment.legal_entity_id);
  }

  // ---- 4. Employment / contract state + eligibility -------------------------
  const elig = eligPreview;
  if (elig.payableDays === 0) {
    addError(ERROR.NOT_ELIGIBLE, `no payable days in ${per.period_start}..${per.period_end}: ${elig.ineligibleReasons.join(', ')}`);
  }
  const employment = {
    worker_type: employee.worker_type,
    status: employee.status,
    start_date: employee.start_date,
    termination_date: employee.termination_date,
    contract_no: employee.contract_no,
    contract_start: employee.contract_start,
    contract_end: employee.contract_end,
  };

  // ---- 5. Work pattern & calendar (as of) -----------------------------------
  let workPattern = null;
  let calendarResolution = null;
  if (assignment) {
    workPattern = await db.prepare('SELECT * FROM work_patterns WHERE id = ?').get(assignment.work_pattern_id) || null;
    if (!workPattern) addError(ERROR.MISSING_WORK_PATTERN, `work_pattern ${assignment.work_pattern_id}`);
    calendarResolution = await dayClass.resolveCalendar(db, employeeId, as_of);
    if (calendarResolution.status !== dayClass.CLASSIFICATION_STATUS.OK) {
      addError(ERROR.CALENDAR_UNRESOLVED, calendarResolution.status);
    }
  }

  // ---- 6. Salary structure & components (as of) -----------------------------
  const structure = await salary.getStructureOn(db, employeeId, as_of);
  if (structure.length === 0) addError(ERROR.MISSING_SALARY_STRUCTURE, `no salary components effective on ${as_of}`);
  // Segments capture mid-period changes so a future run can prorate without
  // re-deriving boundaries. Resolved, not calculated.
  const structureSegments = (await salary.getStructureSegments(db, employeeId, per.period_start, per.period_end))
    .map((seg) => ({
      from: seg.from, to: seg.to, days: seg.days,
      components: seg.bases.components.map(componentSnapshot),
    }));

  // ---- 7. Payroll rule set: BPJS + TER + overtime (as of) -------------------
  const ruleSets = await db.prepare(`
    SELECT * FROM payroll_rule_sets
    WHERE status IN ('active','superseded') AND ${AS_OF('effective_date', 'end_date')}
  `).all({ as_of });
  let ruleSet = null;
  if (ruleSets.length === 0) addError(ERROR.MISSING_RULE_SET, `no payroll_rule_set effective on ${as_of}`);
  else if (ruleSets.length > 1) addError(ERROR.AMBIGUOUS_RULE_SET, `${ruleSets.length} rule sets effective on ${as_of}`);
  else [ruleSet] = ruleSets;

  let terBrackets = [];
  let overtimeRules = [];
  if (ruleSet) {
    terBrackets = await db.prepare('SELECT * FROM ptkp_ter_rates WHERE rule_set_id = ? ORDER BY category, income_min_sen').all(ruleSet.id);
    if (terBrackets.length === 0) addError(ERROR.MISSING_TER_TABLE, `rule_set ${ruleSet.id} has no TER brackets`);
    overtimeRules = await db.prepare('SELECT * FROM overtime_multiplier_rules WHERE rule_set_id = ? ORDER BY day_type, hour_from').all(ruleSet.id);
    if (overtimeRules.length === 0) addError(ERROR.MISSING_OVERTIME_RULES, `rule_set ${ruleSet.id} has no overtime rules`);
  }

  // ---- 8. JKK rate via the employee's legal entity (as of) ------------------
  let jkkVersion = null;
  if (legalEntity) {
    const jkkRows = await db.prepare(`
      SELECT * FROM jkk_risk_classes WHERE risk_class = @risk_class AND ${AS_OF('effective_date', 'end_date')}
    `).all({ risk_class: legalEntity.jkk_risk_class, as_of });
    if (jkkRows.length === 0) addError(ERROR.MISSING_JKK_RATE, `no JKK rate for class ${legalEntity.jkk_risk_class} on ${as_of}`);
    else if (jkkRows.length > 1) addError(ERROR.AMBIGUOUS_JKK_RATE, `${jkkRows.length} open JKK versions for ${legalEntity.jkk_risk_class}`);
    else [jkkVersion] = jkkRows;
  }

  // ---- 9. Tax profile (PTKP -> TER category) --------------------------------
  const terCategory = assignment ? deriveTerCategory(assignment.marital_status, assignment.dependents_count) : null;

  // ---- 10. Attendance / timesheet source (raw quantities only) --------------
  const attendance = await db.prepare(`
    SELECT id, work_date, day_type, day_type_source, shift,
           COALESCE(work_minutes,0) AS work_minutes,
           COALESCE(overtime_minutes_approved,0) AS overtime_minutes_approved,
           overtime_status, attendance_status
    FROM timesheet_entries
    WHERE employee_id = ? AND work_date >= ? AND work_date <= ?
    ORDER BY work_date ASC
  `).all(employeeId, per.period_start, per.period_end);

  const workMinutesTotal = attendance.reduce((t, r) => t + Number(r.work_minutes), 0);
  const overtimeMinutesApproved = attendance
    .filter((r) => r.overtime_status === 'approved')
    .reduce((t, r) => t + Number(r.overtime_minutes_approved), 0);

  // An approved overtime row whose day was never classified cannot be priced
  // by any rule — flag it here rather than letting the run pick a band.
  for (const row of attendance) {
    if (row.overtime_status === 'approved' && Number(row.overtime_minutes_approved) > 0 && !row.day_type) {
      addError(ERROR.UNCLASSIFIED_OVERTIME_DAY, `timesheet ${row.id} on ${row.work_date} has approved overtime but no day_type`);
    }
  }

  // Day-type counts, and the overtime rule band each overtime day maps to.
  // The mapping comes from lib/dayClassification — no multiplier is read here.
  const dayTypeCounts = {};
  const overtimeByDay = [];
  for (const row of attendance) {
    if (row.day_type) dayTypeCounts[row.day_type] = (dayTypeCounts[row.day_type] || 0) + 1;
    if (row.overtime_status === 'approved' && Number(row.overtime_minutes_approved) > 0) {
      const classification = await dayClass.classifyDay(db, employeeId, row.work_date);
      overtimeByDay.push({
        work_date: row.work_date,
        minutes: Number(row.overtime_minutes_approved),
        // day_type from the SNAPSHOT on the row (what applied when recorded),
        // not from today's calendar.
        day_type: row.day_type,
        overtime_rule_day_type: dayClass.resolveOvertimeRuleDayType(classification),
        days_per_week: classification.daysPerWeek,
      });
    }
  }

  return finalise({
    employeeId, payrollPeriodId, asOfDate: as_of, errors,
    period: per, employee, employment, assignment, group, legalEntity,
    workPattern, calendarResolution, eligibility: elig,
    structure: structure.map(componentSnapshot), structureSegments,
    ruleSet, terBrackets, overtimeRules, jkkVersion, terCategory,
    attendance, workMinutesTotal, overtimeMinutesApproved, dayTypeCounts, overtimeByDay,
  });
}

/** Freeze a component row into the snapshot shape (values + behaviour flags). */
function componentSnapshot(c) {
  return {
    component_id: c.component_id, code: c.code, name: c.name,
    component_type: c.component_type, calculation_type: c.calculation_type,
    paid_by: c.paid_by, amount_sen: c.amount_sen,
    is_taxable: c.is_taxable, is_bpjs_base: c.is_bpjs_base,
    is_overtime_base: c.is_overtime_base, is_proratable: c.is_proratable,
    recurrence: c.recurrence, calculation_order: c.calculation_order,
    assignment_from: c.assignment_from, assignment_to: c.assignment_to,
  };
}

/** PTKP status -> TER category (PMK 168/2023). Pure function, no rates. */
function deriveTerCategory(maritalStatus, dependents) {
  const d = Number(dependents || 0);
  if (maritalStatus === 'K' && d >= 3) return 'C';
  if (maritalStatus === 'TK' && d >= 2) return 'B';
  if (maritalStatus === 'K' && d >= 1) return 'B';
  return 'A';
}

function finalise(result) {
  const errors = result.errors || [];
  return {
    ...result,
    errors,
    status: errors.length ? RESOLUTION_STATUS.INCOMPLETE : RESOLUTION_STATUS.OK,
    resolvedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
}

/**
 * The frozen payload written to payroll_input_snapshots.resolved_payload.
 * Deliberately excludes the resolution timestamp so the SAME configuration
 * always hashes identically — that is what makes an idempotent re-run
 * detectable and a drift detectable too.
 */
function buildPayload(resolution) {
  return {
    as_of_date: resolution.asOfDate,
    period: resolution.period && {
      id: resolution.period.id,
      period_start: resolution.period.period_start,
      period_end: resolution.period.period_end,
      attendance_cutoff: resolution.period.attendance_cutoff,
      overtime_cutoff: resolution.period.overtime_cutoff,
      adjustment_cutoff: resolution.period.adjustment_cutoff,
      payment_date: resolution.period.payment_date,
    },
    legal_entity: resolution.legalEntity && {
      id: resolution.legalEntity.id, name: resolution.legalEntity.name,
      entity_type: resolution.legalEntity.entity_type,
      jkk_risk_class: resolution.legalEntity.jkk_risk_class,
    },
    payroll_group: resolution.group && {
      id: resolution.group.id, code: resolution.group.code,
      frequency: resolution.group.frequency,
      effective_from: resolution.group.effective_from,
      attendance_cutoff_offset_days: resolution.group.attendance_cutoff_offset_days,
      overtime_cutoff_offset_days: resolution.group.overtime_cutoff_offset_days,
      adjustment_cutoff_offset_days: resolution.group.adjustment_cutoff_offset_days,
      payment_offset_days: resolution.group.payment_offset_days,
    },
    assignment: resolution.assignment && {
      id: resolution.assignment.id,
      effective_date: resolution.assignment.effective_date,
      end_date: resolution.assignment.end_date,
      legal_entity_id: resolution.assignment.legal_entity_id,
      work_pattern_id: resolution.assignment.work_pattern_id,
      work_calendar_id: resolution.assignment.work_calendar_id,
      marital_status: resolution.assignment.marital_status,
      dependents_count: resolution.assignment.dependents_count,
      npwp: resolution.assignment.npwp,
    },
    employment: resolution.employment,
    eligibility: resolution.eligibility && {
      payable_days: resolution.eligibility.payableDays,
      total_days: resolution.eligibility.totalDays,
      segments: (resolution.eligibility.segments || []).map((s) => ({
        from: s.from, to: s.to, days: s.days, assignment_id: s.assignment.id,
      })),
      ineligible_reasons: resolution.eligibility.ineligibleReasons,
    },
    work_pattern: resolution.workPattern && {
      id: resolution.workPattern.id, days_per_week: resolution.workPattern.days_per_week,
      weekly_rest_day: resolution.workPattern.weekly_rest_day,
    },
    work_calendar: resolution.calendarResolution && resolution.calendarResolution.calendar && {
      id: resolution.calendarResolution.calendar.id,
      code: resolution.calendarResolution.calendar.code,
      effective_from: resolution.calendarResolution.calendar.effective_from,
    },
    salary_structure: resolution.structure,
    salary_structure_segments: resolution.structureSegments,
    bpjs_rule: resolution.ruleSet && {
      rule_set_id: resolution.ruleSet.id,
      name: resolution.ruleSet.name,
      effective_date: resolution.ruleSet.effective_date,
      bpjs_kesehatan_rate_employee_bp: resolution.ruleSet.bpjs_kesehatan_rate_employee_bp,
      bpjs_kesehatan_rate_company_bp: resolution.ruleSet.bpjs_kesehatan_rate_company_bp,
      bpjs_kesehatan_salary_cap_sen: resolution.ruleSet.bpjs_kesehatan_salary_cap_sen,
      jht_rate_employee_bp: resolution.ruleSet.jht_rate_employee_bp,
      jht_rate_company_bp: resolution.ruleSet.jht_rate_company_bp,
      jp_rate_employee_bp: resolution.ruleSet.jp_rate_employee_bp,
      jp_rate_company_bp: resolution.ruleSet.jp_rate_company_bp,
      jp_salary_cap_sen: resolution.ruleSet.jp_salary_cap_sen,
      jkm_rate_bp: resolution.ruleSet.jkm_rate_bp,
      overtime_hourly_divisor: resolution.ruleSet.overtime_hourly_divisor,
      // Phase 2D policy lock #2: taxability of overtime is configuration.
      overtime_is_taxable: resolution.ruleSet.overtime_is_taxable,
      overtime_is_bpjs_base: resolution.ruleSet.overtime_is_bpjs_base,
    },
    jkk: resolution.jkkVersion && {
      version_id: resolution.jkkVersion.id,
      risk_class: resolution.jkkVersion.risk_class,
      rate_bp: resolution.jkkVersion.rate_bp,
      effective_date: resolution.jkkVersion.effective_date,
      end_date: resolution.jkkVersion.end_date,
    },
    tax: {
      ter_category: resolution.terCategory,
      rule_set_id: resolution.ruleSet && resolution.ruleSet.id,
      ter_bracket_count: (resolution.terBrackets || []).length,
      // The full bracket table is frozen: a PMK change must not alter a
      // snapshot that has already been taken.
      ter_brackets: (resolution.terBrackets || []).map((b) => ({
        category: b.category, income_min_sen: b.income_min_sen,
        income_max_sen: b.income_max_sen, rate_bp: b.rate_bp,
      })),
    },
    overtime_rules: (resolution.overtimeRules || []).map((r) => ({
      day_type: r.day_type, hour_from: r.hour_from, hour_to: r.hour_to, multiplier_bp: r.multiplier_bp,
    })),
    attendance: {
      row_count: (resolution.attendance || []).length,
      work_minutes_total: resolution.workMinutesTotal || 0,
      overtime_minutes_approved: resolution.overtimeMinutesApproved || 0,
      day_type_counts: resolution.dayTypeCounts || {},
      overtime_by_day: resolution.overtimeByDay || [],
      // Source row ids so any figure can be traced back to its record.
      source_row_ids: (resolution.attendance || []).map((r) => r.id),
    },
    resolution_errors: resolution.errors,
  };
}

/** Stable JSON: keys sorted at every level, so the hash is order-independent. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** SHA-256 of the stable payload. Detects drift and proves immutability. */
function hashPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

module.exports = {
  RESOLUTION_STATUS, ERROR,
  resolve, buildPayload, hashPayload, stableStringify,
  deriveTerCategory,
};
