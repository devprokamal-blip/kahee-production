// lib/employeeEligibility.js
// Phase 0 / B6 — THE single source of truth for payroll eligibility.
//
// WHY: "was this employee payable on date X" was previously answerable only by
// inferring across three places (employees.status, employees.start_date /
// termination_date, employee_contract_history dates, and the payroll
// assignment's effective window). Three call sites would have drifted into
// three subtly different answers, and payroll would disagree with itself.
//
// RULE: nothing else in this codebase may re-implement this logic. The Payroll
// Calculation Engine, validation/exception checks, and any report must call
// these functions. If the rule needs to change, it changes here, once.
//
// PRECEDENCE (highest to lowest):
//   1. employees.termination_date — if set and date > termination_date, NOT payable.
//   2. employees.start_date       — if set and date < start_date, NOT payable.
//   3. employees.status           — 'inactive' with no termination_date means
//                                   administratively deactivated: NOT payable.
//   4. PKWT contract window       — for worker_type = 'pkwt', the contract must
//                                   cover the date (contract_start..contract_end).
//   5. Payroll assignment         — an effective employee_payroll_assignments
//                                   row must cover the date.
// A failure at any level makes the employee ineligible, and the returned
// `reason` names which level failed so the Exception Engine can map it to a
// specific exception code rather than a generic "not eligible".

const INELIGIBLE = {
  NOT_STARTED: 'NOT_STARTED',
  TERMINATED: 'TERMINATED',
  INACTIVE: 'INACTIVE',
  CONTRACT_NOT_COVERING: 'CONTRACT_NOT_COVERING',
  NO_PAYROLL_ASSIGNMENT: 'NO_PAYROLL_ASSIGNMENT',
  NOT_FOUND: 'NOT_FOUND',
};

function isOnOrBefore(a, b) { return a <= b; }
function isOnOrAfter(a, b) { return a >= b; }

/**
 * Is this employee payable on a single calendar date?
 * @param {object} db   an OPEN db handle (caller owns it)
 * @param {string} employeeId
 * @param {string} date ISO 'YYYY-MM-DD'
 * @returns {{eligible: boolean, reason: string|null, employee: object|null, assignment: object|null}}
 */
async function isEligibleOn(db, employeeId, date) {
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return { eligible: false, reason: INELIGIBLE.NOT_FOUND, employee: null, assignment: null };

  if (employee.start_date && !isOnOrAfter(date, employee.start_date)) {
    return { eligible: false, reason: INELIGIBLE.NOT_STARTED, employee, assignment: null };
  }
  if (employee.termination_date && !isOnOrBefore(date, employee.termination_date)) {
    return { eligible: false, reason: INELIGIBLE.TERMINATED, employee, assignment: null };
  }
  // 'inactive' without a termination_date = administratively switched off.
  // With a termination_date, rule 1 above already governs, so a terminated
  // employee remains payable for days on or before their last day.
  if (employee.status === 'inactive' && !employee.termination_date) {
    return { eligible: false, reason: INELIGIBLE.INACTIVE, employee, assignment: null };
  }
  if (employee.worker_type === 'pkwt') {
    const startsOk = !employee.contract_start || isOnOrAfter(date, employee.contract_start);
    const endsOk = !employee.contract_end || isOnOrBefore(date, employee.contract_end);
    if (!startsOk || !endsOk) {
      return { eligible: false, reason: INELIGIBLE.CONTRACT_NOT_COVERING, employee, assignment: null };
    }
  }

  const assignment = await getAssignmentOn(db, employeeId, date);
  if (!assignment) {
    return { eligible: false, reason: INELIGIBLE.NO_PAYROLL_ASSIGNMENT, employee, assignment: null };
  }

  return { eligible: true, reason: null, employee, assignment };
}

/**
 * The payroll assignment in force on a given date (effective_date <= date,
 * and end_date is NULL or >= date). Returns null when none applies.
 */
async function getAssignmentOn(db, employeeId, date) {
  return await db.prepare(`
    SELECT * FROM employee_payroll_assignments
    WHERE employee_id = ?
      AND effective_date <= ?
      AND (end_date IS NULL OR end_date >= ?)
    ORDER BY effective_date DESC
    LIMIT 1
  `).get(employeeId, date, date) || null;
}

/**
 * Which days inside [periodStart, periodEnd] is this employee payable, and
 * under which assignment? Returns contiguous segments so the engine can
 * prorate mid-period joiners, leavers, and salary/entity changes without
 * each caller inventing its own day-walking logic.
 *
 * @returns {{payableDays: number, totalDays: number, segments: Array<{from,to,days,assignment}>, ineligibleReasons: string[]}}
 */
async function getEligibilityForPeriod(db, employeeId, periodStart, periodEnd) {
  const segments = [];
  const reasons = new Set();
  let payableDays = 0;
  let totalDays = 0;

  let current = null;
  for (const date of eachDate(periodStart, periodEnd)) {
    totalDays += 1;
    const result = await isEligibleOn(db, employeeId, date);

    if (!result.eligible) {
      reasons.add(result.reason);
      if (current) { segments.push(current); current = null; }
      continue;
    }

    payableDays += 1;
    const assignmentId = result.assignment.id;
    if (current && current.assignment.id === assignmentId) {
      current.to = date;
      current.days += 1;
    } else {
      if (current) segments.push(current);
      current = { from: date, to: date, days: 1, assignment: result.assignment };
    }
  }
  if (current) segments.push(current);

  return { payableDays, totalDays, segments, ineligibleReasons: Array.from(reasons) };
}

/** Inclusive date iterator over 'YYYY-MM-DD' strings, UTC-safe. */
function* eachDate(startDate, endDate) {
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

module.exports = { isEligibleOn, getAssignmentOn, getEligibilityForPeriod, eachDate, INELIGIBLE };
