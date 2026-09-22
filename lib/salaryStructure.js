// lib/salaryStructure.js
// Phase 1A / B1 — THE single source of truth for "which salary components,
// at what amounts, apply to employee X on date Y".
//
// Mirrors the lib/employeeEligibility.js contract deliberately: the Payroll
// Calculation Engine, validation checks, and any report must call these
// functions rather than querying employee_salary_components directly. If the
// resolution rule changes, it changes here, once.
//
// SQLite cannot express a range-exclusion constraint, so the partial unique
// indexes in init-db.js prevent duplicate OPEN rows while
// findOverlappingAssignment() below guards against overlapping CLOSED ranges.
// Both layers are required; neither alone is sufficient.

const { rupiahToSen } = require('./money');

/**
 * The master component definition in force on a date.
 * Entity-scoped rows take precedence over global (NULL entity) rows.
 */
async function getComponentOn(db, componentId, date) {
  return await db.prepare(`
    SELECT * FROM salary_components
    WHERE id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
  `).get(componentId, date, date) || null;
}

/**
 * Every component an employee holds on a single date, joined to its master
 * definition, ordered by calculation_order so the engine evaluates
 * deterministically.
 * @returns {Array<{assignment_id, component_id, code, name, component_type,
 *   calculation_type, paid_by, is_taxable, is_bpjs_base, is_overtime_base,
 *   is_proratable, recurrence, calculation_order, amount_sen}>}
 */
async function getStructureOn(db, employeeId, date) {
  return await db.prepare(`
    SELECT
      esc.id            AS assignment_id,
      esc.component_id  AS component_id,
      esc.amount_sen    AS amount_sen,
      esc.effective_from AS assignment_from,
      esc.effective_to   AS assignment_to,
      sc.code, sc.name, sc.component_type, sc.calculation_type, sc.paid_by,
      sc.is_taxable, sc.tax_rule_ref, sc.is_bpjs_base, sc.is_overtime_base,
      sc.is_proratable, sc.recurrence, sc.calculation_order, sc.legal_entity_id
    FROM employee_salary_components esc
    JOIN salary_components sc ON sc.id = esc.component_id
    WHERE esc.employee_id = ?
      AND esc.effective_from <= ? AND (esc.effective_to IS NULL OR esc.effective_to >= ?)
      AND sc.effective_from <= ? AND (sc.effective_to IS NULL OR sc.effective_to >= ?)
    ORDER BY sc.calculation_order ASC, sc.code ASC
  `).all(employeeId, date, date, date, date);
}

/**
 * Derived bases the Calculation Engine needs. Computed from the per-component
 * flags — NOT from hardcoded assumptions about which Indonesian allowance is
 * or is not part of a base. All amounts are integer sen.
 */
async function getBasesOn(db, employeeId, date) {
  const structure = await getStructureOn(db, employeeId, date);
  const earnings = structure.filter((c) => c.component_type === 'earning' && c.paid_by === 'employee');

  const sum = (rows) => rows.reduce((total, c) => total + Number(c.amount_sen), 0);

  return {
    date,
    components: structure,
    grossEarningsSen: sum(earnings),
    taxableBaseSen: sum(earnings.filter((c) => c.is_taxable === 1)),
    bpjsBaseSen: sum(earnings.filter((c) => c.is_bpjs_base === 1)),
    overtimeBaseSen: sum(earnings.filter((c) => c.is_overtime_base === 1)),
    employeeDeductionsSen: sum(structure.filter((c) => c.component_type === 'deduction' && c.paid_by === 'employee')),
    employerCostSen: sum(structure.filter((c) => c.paid_by === 'employer')),
  };
}

/**
 * Segments across a period where the resolved structure is unchanged.
 * A mid-period salary change yields two segments, which is what lets the
 * engine prorate without any caller re-deriving the boundaries.
 */
async function getStructureSegments(db, employeeId, periodStart, periodEnd) {
  const { eachDate } = require('./employeeEligibility');
  const segments = [];
  let current = null;

  for (const date of eachDate(periodStart, periodEnd)) {
    const bases = await getBasesOn(db, employeeId, date);
    // Fingerprint = the set of (component, amount) pairs in force that day.
    const fingerprint = bases.components
      .map((c) => `${c.component_id}:${c.amount_sen}`)
      .join('|');

    if (current && current.fingerprint === fingerprint) {
      current.to = date;
      current.days += 1;
    } else {
      if (current) segments.push(current);
      current = { from: date, to: date, days: 1, fingerprint, bases };
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Does [from, to] overlap an existing assignment of the same component to the
 * same employee? Returns the offending row, or null.
 * `excludeId` lets an update skip its own row.
 */
async function findOverlappingAssignment(db, employeeId, componentId, from, to, excludeId = null) {
  // Two ranges overlap when each starts on or before the other ends.
  // An open-ended row (effective_to IS NULL) is treated as extending forever.
  return await db.prepare(`
    SELECT * FROM employee_salary_components
    WHERE employee_id = ? AND component_id = ?
      AND (?::bigint IS NULL OR id != ?)
      AND effective_from <= COALESCE(?::date, '9999-12-31')
      AND COALESCE(effective_to, '9999-12-31') >= ?
    LIMIT 1
  `).get(employeeId, componentId, excludeId, excludeId, to, from) || null;
}

/** Accept rupiah or sen from a client payload; always persist sen. */
function resolveAmountSen(body) {
  if (body.amount_sen !== undefined && body.amount_sen !== null && body.amount_sen !== '') {
    return Number(body.amount_sen);
  }
  return rupiahToSen(body.amount);
}

module.exports = {
  getComponentOn,
  getStructureOn,
  getBasesOn,
  getStructureSegments,
  findOverlappingAssignment,
  resolveAmountSen,
};
