// lib/payrollCalculator.js
// Phase 2C — the payroll calculation core. DRY-RUN ONLY.
//
// ============================================================
// HARD CONTRACT — read before changing anything here
// ============================================================
// 1. PURE. This module takes a frozen snapshot PAYLOAD (a plain object) and
//    returns a result object. It receives no `db` handle, requires no
//    database module, and performs no I/O. That is enforced by a test which
//    fails if this file contains `require('../database` or the token `db.`.
//    Querying live configuration during calculation is precisely how a rule
//    activated in August would re-price June — the snapshot exists so this
//    never happens.
// 2. NO SIDE EFFECTS. The input payload is never mutated. Nothing is
//    persisted. Phase 2C deliberately produces no payroll records.
// 3. INTEGER ONLY. Money is integer sen, rates are integer basis points,
//    time is integer minutes (Phase 0 / 0B). Every product goes through
//    lib/money.applyBp or lib/time.overtimePaySen so rounding happens
//    exactly ONCE per amount, half-up. No floating-point money anywhere.
// 4. DETERMINISTIC. Same payload in, byte-identical result out, always.
//    No Date.now(), no random, no iteration over unordered structures.
// 5. EXCEPTION, NEVER GUESS. A missing or invalid input produces a named
//    error and a null amount — never a default, never a zero that looks
//    like a real figure.
//
// Every amount carries a trace entry: component, source_snapshot_field,
// rule_version, basis, quantity, rate, formula, rounding_rule, amount.

const { applyBp, roundHalfUp } = require('./money');
const { overtimePaySen, hourlyRateSen } = require('./time');

const CALC_STATUS = { OK: 'OK', BLOCKED: 'BLOCKED' };

const CALC_ERROR = {
  SNAPSHOT_INCOMPLETE: 'SNAPSHOT_INCOMPLETE',
  MISSING_SALARY_STRUCTURE: 'MISSING_SALARY_STRUCTURE',
  MISSING_BPJS_RULE: 'MISSING_BPJS_RULE',
  MISSING_TAX_RULE: 'MISSING_TAX_RULE',
  MISSING_JKK: 'MISSING_JKK',
  MISSING_ELIGIBILITY: 'MISSING_ELIGIBILITY',
  MISSING_OVERTIME_RULE: 'MISSING_OVERTIME_RULE',
  INVALID_COMPONENT: 'INVALID_COMPONENT',
  NO_TER_BRACKET: 'NO_TER_BRACKET',
  ZERO_PAYABLE_DAYS: 'ZERO_PAYABLE_DAYS',
  NEGATIVE_NET_PAY: 'NEGATIVE_NET_PAY',
  UNPRICEABLE_OVERTIME: 'UNPRICEABLE_OVERTIME',
};

const ROUNDING = 'half_up_to_sen';

/**
 * @param {object} payload  payroll_input_snapshots.resolved_payload (parsed)
 * @param {object} [opts]   { engineVersion }
 * @returns {object} dry-run result — never persisted by this module
 */
function calculate(payload, opts = {}) {
  const engineVersion = opts.engineVersion || 'payroll-calc-2c.1';
  const errors = [];
  const trace = [];
  const addError = (code, detail) => errors.push({ code, detail });
  const addTrace = (entry) => trace.push({ rounding_rule: ROUNDING, ...entry });

  if (!payload || typeof payload !== 'object') {
    return blocked([{ code: CALC_ERROR.SNAPSHOT_INCOMPLETE, detail: 'payload is not an object' }], engineVersion);
  }
  // A snapshot that failed resolution cannot be calculated. Its errors are
  // carried forward so the caller sees the original cause, not a new symptom.
  if (Array.isArray(payload.resolution_errors) && payload.resolution_errors.length) {
    return blocked(
      [{ code: CALC_ERROR.SNAPSHOT_INCOMPLETE, detail: 'snapshot resolution was INCOMPLETE' },
        ...payload.resolution_errors],
      engineVersion
    );
  }

  // ---- required slices -------------------------------------------------------
  const bpjsRule = payload.bpjs_rule;
  const jkk = payload.jkk;
  const tax = payload.tax;
  const eligibility = payload.eligibility;
  const structure = Array.isArray(payload.salary_structure) ? payload.salary_structure : null;

  if (!bpjsRule) addError(CALC_ERROR.MISSING_BPJS_RULE, 'payload.bpjs_rule');
  if (!jkk) addError(CALC_ERROR.MISSING_JKK, 'payload.jkk');
  if (!tax || !Array.isArray(tax.ter_brackets) || tax.ter_brackets.length === 0) {
    addError(CALC_ERROR.MISSING_TAX_RULE, 'payload.tax.ter_brackets');
  }
  if (!eligibility) addError(CALC_ERROR.MISSING_ELIGIBILITY, 'payload.eligibility');
  if (!structure || structure.length === 0) addError(CALC_ERROR.MISSING_SALARY_STRUCTURE, 'payload.salary_structure');
  if (errors.length) return blocked(errors, engineVersion);

  // ---- component validation (exception, never guess) -------------------------
  for (const c of structure) {
    if (!Number.isInteger(c.amount_sen)) {
      addError(CALC_ERROR.INVALID_COMPONENT, `${c.code}: amount_sen must be an integer sen value, got ${c.amount_sen}`);
    }
    if (c.amount_sen < 0) {
      addError(CALC_ERROR.INVALID_COMPONENT, `${c.code}: negative amount_sen (${c.amount_sen}); use a deduction component instead`);
    }
    if (!['earning', 'deduction'].includes(c.component_type)) {
      addError(CALC_ERROR.INVALID_COMPONENT, `${c.code}: unknown component_type ${c.component_type}`);
    }
    if (!['employee', 'employer'].includes(c.paid_by)) {
      addError(CALC_ERROR.INVALID_COMPONENT, `${c.code}: unknown paid_by ${c.paid_by}`);
    }
  }
  if (errors.length) return blocked(errors, engineVersion);

  // ---- 1. proration basis ----------------------------------------------------
  const payableDays = Number(eligibility.payable_days);
  const periodDays = Number(eligibility.total_days);
  if (!periodDays) return blocked([{ code: CALC_ERROR.MISSING_ELIGIBILITY, detail: 'total_days is zero' }], engineVersion);
  if (payableDays <= 0) {
    return blocked([{ code: CALC_ERROR.ZERO_PAYABLE_DAYS, detail: (eligibility.ineligible_reasons || []).join(', ') }], engineVersion);
  }
  const isProrated = payableDays < periodDays;

  addTrace({
    component: 'PRORATION_BASIS',
    source_snapshot_field: 'eligibility.payable_days / eligibility.total_days',
    rule_version: null,
    basis: 'calendar days in period',
    quantity: `${payableDays}/${periodDays}`,
    rate: null,
    formula: 'payable_days / total_days',
    amount: null,
  });

  // ---- 2. earnings ------------------------------------------------------------
  // Phase 2D policy lock #1: SEGMENT-BASED PRORATION. When the frozen snapshot
  // contains more than one salary-structure segment (a mid-period change), each
  // segment is weighted by its own days rather than applying one as-of amount
  // across the whole period. Single-segment employees take the simple path, so
  // the common case is unchanged.
  const segments = Array.isArray(payload.salary_structure_segments)
    ? payload.salary_structure_segments : [];
  const useSegments = segments.length > 1;

  // Components are sorted by calculation_order (already frozen in the
  // snapshot) so evaluation order is deterministic and configurable.
  const ordered = [...structure].sort((a, b) =>
    (a.calculation_order - b.calculation_order) || a.code.localeCompare(b.code));

  const earnings = [];
  const deductions = [];
  const employerComponents = [];

  for (const c of ordered) {
    const prorate = c.is_proratable === 1;
    let amount;
    let quantity;
    let formula;

    if (prorate && useSegments) {
      // Sum this component across the segments it actually appears in,
      // each weighted by that segment's days. Rounded ONCE, at the end.
      let weighted = 0;
      const parts = [];
      for (const seg of segments) {
        const inSeg = (seg.components || []).find((sc) => sc.component_id === c.component_id);
        if (!inSeg) continue;
        weighted += inSeg.amount_sen * seg.days;
        parts.push(`${inSeg.amount_sen}x${seg.days}d`);
      }
      amount = roundHalfUp(weighted / periodDays);
      quantity = parts.join(' + ') || '0';
      formula = 'sum(segment_amount_sen * segment_days) / total_days';
    } else if (prorate && isProrated) {
      amount = roundHalfUp((c.amount_sen * payableDays) / periodDays);
      quantity = `${payableDays}/${periodDays} days`;
      formula = 'amount_sen * payable_days / total_days';
    } else {
      amount = c.amount_sen;
      quantity = '1 period';
      formula = 'amount_sen';
    }

    addTrace({
      component: c.code,
      source_snapshot_field: useSegments && prorate
        ? 'salary_structure_segments[].components[].amount_sen'
        : `salary_structure[${c.code}].amount_sen`,
      rule_version: `component:${c.component_id}`,
      basis: c.component_type === 'earning' ? 'salary component (earning)' : 'salary component (deduction)',
      quantity,
      rate: null,
      formula,
      amount,
      flags: {
        is_taxable: c.is_taxable, is_bpjs_base: c.is_bpjs_base,
        is_overtime_base: c.is_overtime_base, is_proratable: c.is_proratable,
        calculation_type: c.calculation_type, paid_by: c.paid_by,
      },
    });

    const row = { ...c, computed_sen: amount, prorated: prorate };
    if (c.paid_by === 'employer') employerComponents.push(row);
    else if (c.component_type === 'earning') earnings.push(row);
    else deductions.push(row);
  }

  const sum = (rows) => rows.reduce((t, r) => t + r.computed_sen, 0);

  const fixedEarningsSen = sum(earnings.filter((c) => c.calculation_type === 'fixed'));
  const variableEarningsSen = sum(earnings.filter((c) => c.calculation_type === 'variable'));
  const earningsSen = fixedEarningsSen + variableEarningsSen;

  // Bases come from per-component FLAGS, never from a hardcoded component list.
  const bpjsBaseSen = sum(earnings.filter((c) => c.is_bpjs_base === 1));
  const overtimeBaseSen = sum(earnings.filter((c) => c.is_overtime_base === 1));

  addTrace({
    component: 'EARNINGS_SUBTOTAL', source_snapshot_field: 'salary_structure[]',
    rule_version: null, basis: 'employee-side earning components',
    quantity: `${earnings.length} components`, rate: null,
    formula: 'sum(fixed) + sum(variable)', amount: earningsSen,
    detail: { fixed: fixedEarningsSen, variable: variableEarningsSen },
  });
  addTrace({
    component: 'BPJS_BASE', source_snapshot_field: 'salary_structure[].is_bpjs_base',
    rule_version: null, basis: 'components flagged is_bpjs_base',
    quantity: `${earnings.filter((c) => c.is_bpjs_base === 1).length} components`,
    rate: null, formula: 'sum(earning where is_bpjs_base = 1)', amount: bpjsBaseSen,
  });

  // ---- 3. overtime -----------------------------------------------------------
  const overtime = calculateOvertime(payload, overtimeBaseSen, bpjsRule, addTrace, addError);
  if (errors.length) return blocked(errors, engineVersion);
  const overtimeSen = overtime.totalSen;

  // ---- 4. gross --------------------------------------------------------------
  const grossSen = earningsSen + overtimeSen;
  addTrace({
    component: 'GROSS_PAY', source_snapshot_field: null, rule_version: null,
    basis: 'earnings + overtime', quantity: null, rate: null,
    formula: 'earnings_sen + overtime_sen', amount: grossSen,
  });

  // ---- 5. BPJS ---------------------------------------------------------------
  const bpjs = calculateBpjs(bpjsRule, jkk, bpjsBaseSen, addTrace);

  // ---- 6. tax (PPh21 via TER) -------------------------------------------------
  // Phase 2D policy lock #2: whether overtime enters the taxable base is
  // CONFIGURATION on the frozen rule set, not a hardcoded assumption here.
  const overtimeTaxable = Number(bpjsRule.overtime_is_taxable ?? 1) === 1;
  const taxableEarningsSen = sum(earnings.filter((c) => c.is_taxable === 1));
  const taxableBaseSen = taxableEarningsSen + (overtimeTaxable ? overtimeSen : 0);
  addTrace({
    component: 'TAXABLE_BASE', source_snapshot_field: 'bpjs_rule.overtime_is_taxable',
    rule_version: `rule_set:${bpjsRule.rule_set_id}`,
    basis: overtimeTaxable ? 'taxable earnings + overtime' : 'taxable earnings only (overtime configured non-taxable)',
    quantity: `${taxableEarningsSen} + ${overtimeTaxable ? overtimeSen : 0}`,
    rate: null, formula: 'sum(taxable earnings) + (overtime if overtime_is_taxable)',
    amount: taxableBaseSen,
  });
  const taxResult = calculateTax(tax, taxableBaseSen, addTrace, addError);
  if (errors.length) return blocked(errors, engineVersion);

  // ---- 7. deductions & net ----------------------------------------------------
  const otherDeductionsSen = sum(deductions);
  addTrace({
    component: 'OTHER_DEDUCTIONS', source_snapshot_field: 'salary_structure[] where component_type = deduction',
    rule_version: null, basis: 'employee-side deduction components',
    quantity: `${deductions.length} components`, rate: null,
    formula: 'sum(deduction where paid_by = employee)', amount: otherDeductionsSen,
  });

  const employeeDeductionsSen = bpjs.employeeTotalSen + taxResult.amountSen + otherDeductionsSen;
  addTrace({
    component: 'EMPLOYEE_DEDUCTIONS_TOTAL', source_snapshot_field: null, rule_version: null,
    basis: 'BPJS employee + PPh21 + other deductions', quantity: null, rate: null,
    formula: 'bpjs_employee + pph21 + other_deductions', amount: employeeDeductionsSen,
  });

  const netSen = grossSen - employeeDeductionsSen;
  addTrace({
    component: 'NET_PAY', source_snapshot_field: null, rule_version: null,
    basis: 'gross minus employee deductions', quantity: null, rate: null,
    formula: 'gross_sen - employee_deductions_sen', amount: netSen,
  });

  if (netSen < 0) {
    addError(CALC_ERROR.NEGATIVE_NET_PAY,
      `net ${netSen} sen: deductions (${employeeDeductionsSen}) exceed gross (${grossSen})`);
  }

  const employerCostSen = bpjs.employerTotalSen + sum(employerComponents);

  const result = {
    engine_version: engineVersion,
    status: errors.length ? CALC_STATUS.BLOCKED : CALC_STATUS.OK,
    errors,
    // rule versions this result was produced under, echoed from the snapshot
    rule_versions: {
      bpjs_rule_set_id: bpjsRule.rule_set_id,
      bpjs_rule_set_effective_date: bpjsRule.effective_date,
      jkk_version_id: jkk.version_id,
      jkk_rate_bp: jkk.rate_bp,
      tax_rule_set_id: tax.rule_set_id,
      ter_category: tax.ter_category,
      overtime_rule_count: (payload.overtime_rules || []).length,
    },
    proration: { payable_days: payableDays, period_days: periodDays, prorated: isProrated },
    earnings: {
      fixed_sen: fixedEarningsSen,
      variable_sen: variableEarningsSen,
      total_sen: earningsSen,
      components: earnings.map(publicComponent),
    },
    overtime: {
      base_sen: overtimeBaseSen,
      hourly_rate_sen: overtime.hourlyRateSen,
      divisor: bpjsRule.overtime_hourly_divisor,
      minutes: overtime.totalMinutes,
      total_sen: overtimeSen,
      by_day: overtime.byDay,
    },
    bpjs: bpjs.detail,
    tax: taxResult.detail,
    deductions: {
      other_sen: otherDeductionsSen,
      components: deductions.map(publicComponent),
      employee_total_sen: employeeDeductionsSen,
    },
    employer: {
      bpjs_sen: bpjs.employerTotalSen,
      components: employerComponents.map(publicComponent),
      total_cost_sen: employerCostSen,
    },
    totals: {
      gross_sen: grossSen,
      taxable_base_sen: taxableBaseSen,
      bpjs_base_sen: bpjsBaseSen,
      employee_deductions_sen: employeeDeductionsSen,
      net_sen: netSen,
      employer_cost_sen: employerCostSen,
    },
    trace,
  };
  return result;
}

// ---- overtime ----------------------------------------------------------------
function calculateOvertime(payload, overtimeBaseSen, bpjsRule, addTrace, addError) {
  const byDayInput = (payload.attendance && payload.attendance.overtime_by_day) || [];
  const rules = payload.overtime_rules || [];

  const rate = hourlyRateSen(overtimeBaseSen, bpjsRule.overtime_hourly_divisor);
  addTrace({
    component: 'OVERTIME_HOURLY_RATE',
    source_snapshot_field: 'salary_structure[].is_overtime_base + bpjs_rule.overtime_hourly_divisor',
    rule_version: `rule_set:${bpjsRule.rule_set_id}`,
    basis: 'overtime base', quantity: `1/${bpjsRule.overtime_hourly_divisor}`,
    rate: null, formula: 'overtime_base_sen / divisor', amount: rate,
  });

  if (byDayInput.length === 0) {
    addTrace({
      component: 'OVERTIME_TOTAL', source_snapshot_field: 'attendance.overtime_by_day',
      rule_version: null, basis: 'no approved overtime', quantity: '0 minutes',
      rate: null, formula: 'n/a', amount: 0,
    });
    return { totalSen: 0, totalMinutes: 0, hourlyRateSen: rate, byDay: [] };
  }

  // Deterministic order: by date, then by the band key.
  const sortedDays = [...byDayInput].sort((a, b) => a.work_date.localeCompare(b.work_date));
  const byDay = [];
  let totalSen = 0;
  let totalMinutes = 0;

  for (const day of sortedDays) {
    const band = day.overtime_rule_day_type;
    if (!band) {
      addError(CALC_ERROR.UNPRICEABLE_OVERTIME, `${day.work_date}: no overtime rule band (day_type ${day.day_type})`);
      continue;
    }
    const bandRules = rules.filter((r) => r.day_type === band)
      .sort((a, b) => a.hour_from - b.hour_from);
    if (bandRules.length === 0) {
      addError(CALC_ERROR.MISSING_OVERTIME_RULE, `${day.work_date}: no rules configured for band ${band}`);
      continue;
    }

    // PP 35/2021 bands are PROGRESSIVE within the day: hour 1 at one
    // multiplier, later hours at another. Minutes are allocated hour by hour
    // so a partial hour lands in the correct band.
    let remaining = Number(day.minutes);
    let hourIndex = 1;
    let dayTotal = 0;
    const segments = [];

    while (remaining > 0) {
      const rule = bandRules.find((r) => hourIndex >= r.hour_from && (r.hour_to === null || hourIndex <= r.hour_to));
      if (!rule) {
        addError(CALC_ERROR.MISSING_OVERTIME_RULE,
          `${day.work_date}: band ${band} has no rule covering hour ${hourIndex} (${remaining} minutes unpriced)`);
        break;
      }
      const minutesThisHour = Math.min(remaining, 60);
      const amount = overtimePaySen(rate, minutesThisHour, rule.multiplier_bp);
      dayTotal += amount;
      segments.push({ hour: hourIndex, minutes: minutesThisHour, multiplier_bp: rule.multiplier_bp, amount_sen: amount });

      addTrace({
        component: `OVERTIME_${day.work_date}_H${hourIndex}`,
        source_snapshot_field: `attendance.overtime_by_day[${day.work_date}].minutes`,
        rule_version: `overtime_rule:${band}:h${rule.hour_from}-${rule.hour_to === null ? 'n' : rule.hour_to}`,
        basis: `${day.day_type} -> band ${band}`,
        quantity: `${minutesThisHour} minutes (hour ${hourIndex})`,
        rate: `${rule.multiplier_bp} bp (${rule.multiplier_bp / 10000}x)`,
        formula: 'hourly_rate_sen * minutes * multiplier_bp / (60 * 10000)',
        amount,
      });

      remaining -= minutesThisHour;
      hourIndex += 1;
    }

    totalSen += dayTotal;
    totalMinutes += Number(day.minutes);
    byDay.push({
      work_date: day.work_date, day_type: day.day_type, band,
      minutes: Number(day.minutes), amount_sen: dayTotal, segments,
    });
  }

  addTrace({
    component: 'OVERTIME_TOTAL', source_snapshot_field: 'attendance.overtime_by_day',
    rule_version: null, basis: 'sum of per-day overtime',
    quantity: `${totalMinutes} minutes across ${byDay.length} days`,
    rate: null, formula: 'sum(per-hour amounts)', amount: totalSen,
  });

  return { totalSen, totalMinutes, hourlyRateSen: rate, byDay };
}

// ---- BPJS ---------------------------------------------------------------------
function calculateBpjs(rule, jkk, baseSen, addTrace) {
  // Caps are applied to the BASE, not to the resulting contribution.
  const kesBase = Math.min(baseSen, rule.bpjs_kesehatan_salary_cap_sen);
  const jpBase = Math.min(baseSen, rule.jp_salary_cap_sen);
  const ruleRef = `rule_set:${rule.rule_set_id}`;

  const line = (component, field, basis, base, bp, ref) => {
    const amount = applyBp(base, bp);
    addTrace({
      component, source_snapshot_field: field, rule_version: ref,
      basis, quantity: `${base} sen`, rate: `${bp} bp (${bp / 100}%)`,
      formula: 'base_sen * rate_bp / 10000', amount,
    });
    return amount;
  };

  const kesEmp = line('BPJS_KESEHATAN_EMPLOYEE', 'bpjs_rule.bpjs_kesehatan_rate_employee_bp',
    `bpjs base capped at ${rule.bpjs_kesehatan_salary_cap_sen}`, kesBase, rule.bpjs_kesehatan_rate_employee_bp, ruleRef);
  const kesCom = line('BPJS_KESEHATAN_EMPLOYER', 'bpjs_rule.bpjs_kesehatan_rate_company_bp',
    `bpjs base capped at ${rule.bpjs_kesehatan_salary_cap_sen}`, kesBase, rule.bpjs_kesehatan_rate_company_bp, ruleRef);
  const jhtEmp = line('JHT_EMPLOYEE', 'bpjs_rule.jht_rate_employee_bp', 'bpjs base (uncapped)', baseSen, rule.jht_rate_employee_bp, ruleRef);
  const jhtCom = line('JHT_EMPLOYER', 'bpjs_rule.jht_rate_company_bp', 'bpjs base (uncapped)', baseSen, rule.jht_rate_company_bp, ruleRef);
  const jpEmp = line('JP_EMPLOYEE', 'bpjs_rule.jp_rate_employee_bp', `bpjs base capped at ${rule.jp_salary_cap_sen}`, jpBase, rule.jp_rate_employee_bp, ruleRef);
  const jpCom = line('JP_EMPLOYER', 'bpjs_rule.jp_rate_company_bp', `bpjs base capped at ${rule.jp_salary_cap_sen}`, jpBase, rule.jp_rate_company_bp, ruleRef);
  const jkmCom = line('JKM_EMPLOYER', 'bpjs_rule.jkm_rate_bp', 'bpjs base (uncapped)', baseSen, rule.jkm_rate_bp, ruleRef);
  const jkkCom = line('JKK_EMPLOYER', 'jkk.rate_bp', `bpjs base, risk class ${jkk.risk_class}`, baseSen, jkk.rate_bp, `jkk_version:${jkk.version_id}`);

  const employeeTotalSen = kesEmp + jhtEmp + jpEmp;
  const employerTotalSen = kesCom + jhtCom + jpCom + jkmCom + jkkCom;

  addTrace({
    component: 'BPJS_EMPLOYEE_TOTAL', source_snapshot_field: null, rule_version: ruleRef,
    basis: 'Kesehatan + JHT + JP (employee share)', quantity: null, rate: null,
    formula: 'kesehatan_emp + jht_emp + jp_emp', amount: employeeTotalSen,
  });
  addTrace({
    component: 'BPJS_EMPLOYER_TOTAL', source_snapshot_field: null, rule_version: ruleRef,
    basis: 'Kesehatan + JHT + JP + JKM + JKK (employer share)', quantity: null, rate: null,
    formula: 'kesehatan_com + jht_com + jp_com + jkm + jkk', amount: employerTotalSen,
  });

  return {
    employeeTotalSen, employerTotalSen,
    detail: {
      base_sen: baseSen,
      kesehatan: { base_sen: kesBase, employee_sen: kesEmp, employer_sen: kesCom, cap_sen: rule.bpjs_kesehatan_salary_cap_sen, capped: baseSen > rule.bpjs_kesehatan_salary_cap_sen },
      jht: { base_sen: baseSen, employee_sen: jhtEmp, employer_sen: jhtCom },
      jp: { base_sen: jpBase, employee_sen: jpEmp, employer_sen: jpCom, cap_sen: rule.jp_salary_cap_sen, capped: baseSen > rule.jp_salary_cap_sen },
      jkm: { employer_sen: jkmCom },
      jkk: { employer_sen: jkkCom, risk_class: jkk.risk_class, rate_bp: jkk.rate_bp },
      employee_total_sen: employeeTotalSen,
      employer_total_sen: employerTotalSen,
    },
  };
}

// ---- tax (PPh21 via TER) --------------------------------------------------------
function calculateTax(tax, taxableBaseSen, addTrace, addError) {
  const category = tax.ter_category;
  const brackets = tax.ter_brackets
    .filter((b) => b.category === category)
    .sort((a, b) => a.income_min_sen - b.income_min_sen);

  if (brackets.length === 0) {
    addError(CALC_ERROR.NO_TER_BRACKET, `no TER brackets for category ${category}`);
    return { amountSen: 0, detail: null };
  }

  // TER is a FLAT effective rate on gross for the matched band — not a
  // progressive stack. Bracket boundaries are (min, max]: a value exactly on
  // a max belongs to that bracket.
  const bracket = brackets.find((b) =>
    taxableBaseSen > b.income_min_sen && (b.income_max_sen === null || taxableBaseSen <= b.income_max_sen))
    || (taxableBaseSen === 0 ? brackets[0] : null);

  if (!bracket) {
    addError(CALC_ERROR.NO_TER_BRACKET,
      `taxable base ${taxableBaseSen} sen falls outside every bracket of category ${category}`);
    return { amountSen: 0, detail: null };
  }

  const amount = applyBp(taxableBaseSen, bracket.rate_bp);
  addTrace({
    component: 'PPH21_TER', source_snapshot_field: 'tax.ter_brackets',
    rule_version: `rule_set:${tax.rule_set_id}:category:${category}:bracket:${bracket.income_min_sen}-${bracket.income_max_sen === null ? 'n' : bracket.income_max_sen}`,
    basis: 'taxable earnings + overtime',
    quantity: `${taxableBaseSen} sen`,
    rate: `${bracket.rate_bp} bp (${bracket.rate_bp / 100}%)`,
    formula: 'taxable_base_sen * ter_rate_bp / 10000',
    amount,
  });

  return {
    amountSen: amount,
    detail: {
      method: 'TER',
      ter_category: category,
      taxable_base_sen: taxableBaseSen,
      bracket: { income_min_sen: bracket.income_min_sen, income_max_sen: bracket.income_max_sen, rate_bp: bracket.rate_bp },
      amount_sen: amount,
      // Phase 2D policy lock #3: monthly TER is an INSTALMENT, never the
      // final annual tax. The December Pasal 17 reconciliation is out of MVP
      // scope but is tracked explicitly here and raised as an INFORMATIONAL
      // exception by the validation engine — never silently assumed done.
      is_final_annual_tax: false,
      annual_reconciliation_required: true,
      annual_reconciliation_scope: 'OUT_OF_MVP_SCOPE',
    },
  };
}

function publicComponent(c) {
  return {
    code: c.code, name: c.name, component_type: c.component_type,
    calculation_type: c.calculation_type, paid_by: c.paid_by,
    configured_sen: c.amount_sen, computed_sen: c.computed_sen, prorated: c.prorated,
    is_taxable: c.is_taxable, is_bpjs_base: c.is_bpjs_base, is_overtime_base: c.is_overtime_base,
  };
}

function blocked(errors, engineVersion) {
  return {
    engine_version: engineVersion,
    status: CALC_STATUS.BLOCKED,
    errors,
    totals: null,
    trace: [],
  };
}

/** Human-readable trace for one result — used in dry-run reports. */
function formatTrace(result) {
  if (!result.trace || result.trace.length === 0) return '(no trace — calculation was blocked)';
  const pad = (v, n) => String(v === null || v === undefined ? '-' : v).padEnd(n);
  const lines = [
    `${pad('COMPONENT', 34)}${pad('BASIS', 34)}${pad('QTY', 22)}${pad('RATE', 18)}AMOUNT (sen)`,
    '-'.repeat(126),
  ];
  for (const t of result.trace) {
    lines.push(`${pad(t.component, 34)}${pad(t.basis, 34)}${pad(t.quantity, 22)}${pad(t.rate, 18)}${t.amount === null ? '-' : t.amount}`);
  }
  return lines.join('\n');
}

module.exports = { CALC_STATUS, CALC_ERROR, ROUNDING, calculate, formatTrace };
