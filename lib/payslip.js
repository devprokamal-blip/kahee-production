// lib/payslip.js
// Phase 2F — payslip generation from FINALIZED payroll data.
//
// ============================================================
// HARD CONTRACT
// ============================================================
// This module RENDERS. It must never:
//   * recalculate payroll,
//   * read employee_salary_components, payroll_rule_sets, ptkp_ter_rates,
//     overtime_multiplier_rules, jkk_risk_classes or timesheet_entries,
//   * modify a payroll result, a snapshot, or a finalized run.
// A test greps this file and fails if any of those table names appear.
//
// Every monetary figure comes from payroll_run_lines and
// payroll_run_line_components — rows that are already immutable once the run
// is FINALIZED. The only live tables read are for non-financial CONTEXT
// (employee name, entity name, group code), and even those are FROZEN into
// the document at generation, so a later rename cannot alter a historical
// payslip.
//
// EMPLOYER CONTRIBUTIONS ARE PRESENTED SEPARATELY AND NEVER ENTER NET PAY.
// Net is computed as gross - employee deductions, and asserted against the
// persisted net_sen before the document is accepted.

const crypto = require('crypto');
const { stableStringify } = require('./asOfResolver');
const { formatIDR, senToRupiah } = require('./money');
const { formatMinutes, minutesToHours } = require('./time');

const PAYSLIP_VERSION = 1;

const SECTION = {
  EARNINGS: 'EMPLOYEE_EARNINGS',
  DEDUCTIONS: 'EMPLOYEE_DEDUCTIONS',
  EMPLOYER: 'EMPLOYER_CONTRIBUTIONS',
  TAKE_HOME: 'TAKE_HOME_PAY',
};

class PayslipError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.code = code; this.detail = detail;
  }
}

const ERROR = {
  RUN_NOT_FINALIZED: 'RUN_NOT_FINALIZED',
  LINE_NOT_FOUND: 'LINE_NOT_FOUND',
  LINE_NOT_PAYABLE: 'LINE_NOT_PAYABLE',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
};

/** Which payslip section a persisted component row belongs to. */
function sectionOf(row) {
  if (row.paid_by === 'employer') return SECTION.EMPLOYER;
  switch (row.component_group) {
    case 'earning':
    case 'overtime':
      return SECTION.EARNINGS;
    case 'deduction':
    case 'tax':
      return SECTION.DEDUCTIONS;
    case 'bpjs':
      // BPJS lines are split by who bears them. The code suffix is written by
      // the calculator and is stable.
      return /_EMPLOYER$/.test(row.component_code) ? SECTION.EMPLOYER : SECTION.DEDUCTIONS;
    default:
      return null;   // totals and subtotals are not payslip line items
  }
}

/**
 * Build the frozen payslip document for one FINALIZED run line.
 * Reads persisted rows only; performs no calculation beyond summing the
 * amounts that are already stored, and reconciles those sums against the
 * persisted totals before returning.
 */
async function buildDocument(db, runLineId, { generatedBy = 'system', generatedAt = null } = {}) {
  const line = await db.prepare('SELECT * FROM payroll_run_lines WHERE id = ?').get(runLineId);
  if (!line) throw new PayslipError(ERROR.LINE_NOT_FOUND, `payroll_run_line ${runLineId} tidak ditemukan.`);

  const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(line.payroll_run_id);
  if (run.status !== 'FINALIZED') {
    throw new PayslipError(ERROR.RUN_NOT_FINALIZED,
      `Payslip hanya bisa dibuat dari payroll run berstatus FINALIZED (status saat ini: ${run.status}).`,
      { run_id: run.id, status: run.status });
  }
  if (line.calc_status !== 'OK') {
    throw new PayslipError(ERROR.LINE_NOT_PAYABLE,
      `Baris payroll untuk ${line.employee_id} berstatus ${line.calc_status}; tidak ada payslip yang bisa diterbitkan.`,
      { calc_status: line.calc_status });
  }

  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(run.payroll_period_id);
  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(period.payroll_group_id);
  const entity = await db.prepare('SELECT * FROM legal_entities WHERE id = ?').get(line.legal_entity_id);
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(line.employee_id);
  const snapshot = await db.prepare('SELECT * FROM payroll_input_snapshots WHERE id = ?').get(line.snapshot_id);
  const snapshotPayload = JSON.parse(snapshot.resolved_payload);

  // The stored result. Used for context (proration, overtime minutes, tax
  // bracket) — NOT recomputed.
  const storedResult = JSON.parse(line.result_payload);

  const components = await db.prepare(
    'SELECT * FROM payroll_run_line_components WHERE payroll_run_line_id = ? ORDER BY sequence ASC'
  ).all(runLineId);

  const earnings = [];
  const deductions = [];
  const employer = [];
  for (const c of components) {
    if (c.amount_sen === null) continue;
    const item = {
      code: c.component_code,
      label: c.component_code,
      group: c.component_group,
      basis: c.basis,
      quantity: c.quantity,
      rate: c.rate,
      formula: c.formula,
      rule_version: c.rule_version,
      amount_sen: c.amount_sen,
      amount_display: formatIDR(c.amount_sen),
    };
    const section = sectionOf(c);
    if (section === SECTION.EARNINGS) earnings.push(item);
    else if (section === SECTION.DEDUCTIONS) deductions.push(item);
    else if (section === SECTION.EMPLOYER) employer.push(item);
  }

  const sum = (rows) => rows.reduce((t, r) => t + r.amount_sen, 0);
  const earningsTotal = sum(earnings);
  const deductionsTotal = sum(deductions);
  const employerTotal = sum(employer);

  // ---- RECONCILIATION -------------------------------------------------------
  // The rendered line items must add up to exactly what was persisted. If they
  // do not, the document is refused rather than published — a payslip that
  // disagrees with the payroll it came from is worse than no payslip.
  const problems = [];
  if (earningsTotal !== line.gross_sen) {
    problems.push(`earnings ${earningsTotal} != persisted gross ${line.gross_sen}`);
  }
  if (deductionsTotal !== line.employee_deductions_sen) {
    problems.push(`deductions ${deductionsTotal} != persisted employee deductions ${line.employee_deductions_sen}`);
  }
  const computedNet = earningsTotal - deductionsTotal;
  if (computedNet !== line.net_sen) {
    problems.push(`net ${computedNet} != persisted net ${line.net_sen}`);
  }
  // Employer contributions must NOT be inside the employee's deductions.
  for (const e of employer) {
    if (deductions.some((d) => d.code === e.code)) {
      problems.push(`employer contribution ${e.code} also appears as an employee deduction`);
    }
  }
  if (problems.length) {
    throw new PayslipError(ERROR.RECONCILIATION_FAILED,
      'Rincian payslip tidak cocok dengan hasil payroll yang tersimpan.', { problems });
  }

  const overtime = storedResult.overtime || {};
  const proration = storedResult.proration || {};
  const tax = storedResult.tax || {};

  const reference = `PS-${entity.id}-${period.period_year}${String(period.period_sequence).padStart(2, '0')}-R${run.run_number}-${line.employee_id}`;

  const document = {
    payslip_version: PAYSLIP_VERSION,
    payslip_reference: reference,

    // ---- integrity metadata ----
    integrity: {
      payroll_run_id: run.id,
      payroll_run_line_id: line.id,
      payroll_period_id: period.id,
      snapshot_id: snapshot.id,
      run_number: run.run_number,
      run_status: run.status,
      finalized_at: run.finalized_at,
      finalized_by: run.finalized_by,
      approved_by: run.approved_by,
      prepared_by: run.prepared_by,
      line_result_hash: line.result_hash,
      snapshot_hash: line.snapshot_hash,
      engine_version: run.engine_version,
      generated_at: generatedAt,
      generated_by: generatedBy,
    },

    // ---- employer ----
    employer: {
      legal_entity_id: entity.id,
      legal_entity_name: entity.name,
      entity_type: entity.entity_type,
      npwp: entity.npwp,
      payroll_group_code: group.code,
      payroll_group_name: group.name,
    },

    // ---- employee ----
    employee: {
      employee_id: employee.id,
      full_name: employee.full_name,
      nik: employee.nik,
      position: employee.position,
      department: employee.department,
      project_code: employee.project_code,
      // Employment context is taken from the SNAPSHOT, so it reflects the
      // period, not today's HR record.
      worker_type: snapshotPayload.employment ? snapshotPayload.employment.worker_type : employee.worker_type,
      employment_status: snapshotPayload.employment ? snapshotPayload.employment.status : null,
      start_date: snapshotPayload.employment ? snapshotPayload.employment.start_date : null,
      termination_date: snapshotPayload.employment ? snapshotPayload.employment.termination_date : null,
      contract_no: snapshotPayload.employment ? snapshotPayload.employment.contract_no : null,
      ptkp_status: snapshotPayload.assignment
        ? `${snapshotPayload.assignment.marital_status}/${snapshotPayload.assignment.dependents_count}`
        : null,
      ter_category: line.ter_category,
      npwp: snapshotPayload.assignment ? snapshotPayload.assignment.npwp : null,
      // Bank details are shown for reference only; payment is a later phase.
      bank_name: employee.bank_name,
      bank_account_no: employee.bank_account_no,
    },

    // ---- period ----
    period: {
      payroll_period_id: period.id,
      year: period.period_year,
      sequence: period.period_sequence,
      month: period.period_month,
      period_start: period.period_start,
      period_end: period.period_end,
      payment_date: period.payment_date,
      frequency: group.frequency,
    },

    // ---- work context ----
    work: {
      payable_days: proration.payable_days ?? null,
      period_days: proration.period_days ?? null,
      prorated: proration.prorated ?? false,
      overtime_minutes: overtime.minutes ?? 0,
      overtime_hours: minutesToHours(overtime.minutes ?? 0),
      overtime_display: formatMinutes(overtime.minutes ?? 0),
      overtime_hourly_rate_sen: overtime.hourly_rate_sen ?? null,
      overtime_by_day: (overtime.by_day || []).map((d) => ({
        work_date: d.work_date, day_type: d.day_type, band: d.band,
        minutes: d.minutes, display: formatMinutes(d.minutes), amount_sen: d.amount_sen,
      })),
    },

    // ---- the four clearly separated sections ----
    sections: {
      [SECTION.EARNINGS]: {
        label: 'Penghasilan Karyawan',
        items: earnings,
        total_sen: earningsTotal,
        total_display: formatIDR(earningsTotal),
      },
      [SECTION.DEDUCTIONS]: {
        label: 'Potongan Karyawan',
        items: deductions,
        total_sen: deductionsTotal,
        total_display: formatIDR(deductionsTotal),
      },
      [SECTION.EMPLOYER]: {
        label: 'Kontribusi Perusahaan (tidak mengurangi gaji bersih)',
        note: 'Ditanggung perusahaan. Tidak dipotong dari penghasilan karyawan.',
        items: employer,
        total_sen: employerTotal,
        total_display: formatIDR(employerTotal),
        reduces_net_pay: false,
      },
      [SECTION.TAKE_HOME]: {
        label: 'Gaji Bersih (Take Home Pay)',
        gross_sen: line.gross_sen,
        gross_display: formatIDR(line.gross_sen),
        employee_deductions_sen: line.employee_deductions_sen,
        employee_deductions_display: formatIDR(line.employee_deductions_sen),
        net_sen: line.net_sen,
        net_display: formatIDR(line.net_sen),
        formula: 'gross - employee_deductions',
      },
    },

    // ---- tax summary ----
    tax: {
      method: tax.method || 'TER',
      ter_category: tax.ter_category || line.ter_category,
      taxable_base_sen: tax.taxable_base_sen ?? line.taxable_base_sen,
      amount_sen: tax.amount_sen ?? line.tax_sen,
      amount_display: formatIDR(tax.amount_sen ?? line.tax_sen),
      rule_set_id: line.payroll_rule_set_id,
      // Carried through from the calculator: monthly TER is an instalment.
      is_final_annual_tax: tax.is_final_annual_tax === true,
      annual_reconciliation_required: tax.annual_reconciliation_required !== false,
      notice: 'PPh21 bulanan dihitung dengan metode TER sebagai angsuran, bukan pajak tahunan final.',
    },

    totals: {
      gross_sen: line.gross_sen,
      employee_deductions_sen: line.employee_deductions_sen,
      net_sen: line.net_sen,
      employer_contributions_sen: employerTotal,
      employer_cost_sen: line.employer_cost_sen,
    },
  };

  return { document, line, run, period, entity };
}

/**
 * The integrity hash covers the FINANCIAL content only — deliberately
 * excluding generated_at/generated_by, so two generations of the same
 * finalized line hash identically. That is what "financially identical months
 * later" is measured against.
 */
function contentHash(document) {
  const financial = {
    reference: document.payslip_reference,
    sections: document.sections,
    totals: document.totals,
    tax: { ...document.tax, notice: undefined },
    work: { ...document.work },
    period: document.period,
    employee_id: document.employee.employee_id,
    legal_entity_id: document.employer.legal_entity_id,
    line_result_hash: document.integrity.line_result_hash,
    snapshot_hash: document.integrity.snapshot_hash,
  };
  return crypto.createHash('sha256').update(stableStringify(financial)).digest('hex');
}

/**
 * Generate and PERSIST a payslip. Idempotent: if one already exists for this
 * run line, the stored document is returned unchanged — never regenerated,
 * so a later rename or reorganisation cannot alter a historical payslip.
 * Caller supplies the transaction.
 */
async function generate(db, runLineId, { generatedBy = 'system' } = {}) {
  const existing = await db.prepare('SELECT * FROM payroll_payslips WHERE payroll_run_line_id = ?').get(runLineId);
  if (existing) {
    return { created: false, payslip: existing, document: JSON.parse(existing.document) };
  }

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const { document, line, run, period } = await buildDocument(db, runLineId, { generatedBy, generatedAt });
  const hash = contentHash(document);

  const info = await db.prepare(`
    INSERT INTO payroll_payslips (
      payroll_run_id, payroll_run_line_id, payroll_period_id, employee_id, legal_entity_id,
      run_number, payslip_version, payslip_reference, document, content_hash,
      line_result_hash, snapshot_hash, gross_sen, employee_deductions_sen, net_sen,
      employer_cost_sen, finalized_at, generated_at, generated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
  `).run(
    run.id, line.id, period.id, line.employee_id, line.legal_entity_id,
    run.run_number, PAYSLIP_VERSION, document.payslip_reference,
    JSON.stringify(document), hash,
    line.result_hash, line.snapshot_hash,
    line.gross_sen, line.employee_deductions_sen, line.net_sen,
    line.employer_cost_sen, run.finalized_at, generatedAt, generatedBy
  );

  const payslip = await db.prepare('SELECT * FROM payroll_payslips WHERE id = ?').get(info.lastInsertRowid);
  return { created: true, payslip, document };
}

/** Plain-text printable rendering, from the FROZEN document only. */
function renderText(document) {
  const line = (label, value) => `${String(label).padEnd(42)}${String(value).padStart(20)}`;
  const rule = '='.repeat(62);
  const thin = '-'.repeat(62);
  const out = [];

  out.push(rule);
  out.push(document.employer.legal_entity_name.toUpperCase());
  out.push(`SLIP GAJI — ${document.period.period_start} s/d ${document.period.period_end}`);
  out.push(`Ref: ${document.payslip_reference}`);
  out.push(rule);
  out.push(line('Nama', document.employee.full_name));
  out.push(line('ID Karyawan', document.employee.employee_id));
  if (document.employee.position) out.push(line('Jabatan', document.employee.position));
  out.push(line('Status PTKP', `${document.employee.ptkp_status || '-'} (TER ${document.employee.ter_category || '-'})`));
  out.push(line('Grup Payroll', document.employer.payroll_group_code));
  out.push(line('Hari Dibayar', `${document.work.payable_days}/${document.work.period_days}`));
  out.push(line('Lembur', document.work.overtime_display));
  out.push(line('Tanggal Bayar', document.period.payment_date));
  out.push(thin);

  out.push('PENGHASILAN KARYAWAN');
  for (const i of document.sections.EMPLOYEE_EARNINGS.items) out.push(line(`  ${i.code}`, i.amount_display));
  out.push(line('  TOTAL PENGHASILAN (BRUTO)', document.sections.EMPLOYEE_EARNINGS.total_display));
  out.push(thin);

  out.push('POTONGAN KARYAWAN');
  for (const i of document.sections.EMPLOYEE_DEDUCTIONS.items) out.push(line(`  ${i.code}`, i.amount_display));
  out.push(line('  TOTAL POTONGAN', document.sections.EMPLOYEE_DEDUCTIONS.total_display));
  out.push(thin);

  out.push(line('GAJI BERSIH (TAKE HOME PAY)', document.sections.TAKE_HOME_PAY.net_display));
  out.push(rule);

  out.push('KONTRIBUSI PERUSAHAAN (tidak mengurangi gaji bersih)');
  for (const i of document.sections.EMPLOYER_CONTRIBUTIONS.items) out.push(line(`  ${i.code}`, i.amount_display));
  out.push(line('  TOTAL KONTRIBUSI PERUSAHAAN', document.sections.EMPLOYER_CONTRIBUTIONS.total_display));
  out.push(thin);
  out.push(document.tax.notice);
  out.push(`Run #${document.integrity.run_number} · final ${document.integrity.finalized_at} · hash ${document.integrity.line_result_hash.slice(0, 16)}…`);
  out.push(rule);
  return out.join('\n');
}

module.exports = {
  PAYSLIP_VERSION, SECTION, ERROR, PayslipError,
  sectionOf, buildDocument, contentHash, generate, renderText,
};
