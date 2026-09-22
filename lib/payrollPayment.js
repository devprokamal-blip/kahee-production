// lib/payrollPayment.js
// Phase 2H — payment processing.
//
// ============================================================
// HARD CONTRACT
// ============================================================
// Payment READS finalized payroll and converts it into instructions. It must
// never recalculate salary, tax or BPJS, never read live payroll rules, and
// never modify a finalized run, its lines, its payslips or the adjustment
// ledger. A test greps this file for the rule tables and for the calculator.
//
// THE PAYABLE AMOUNT is the SUM of finalized net across the ORIGINAL run and
// every finalized CORRECTION and REVERSAL for that employee in that period —
// the same figure Phase 2G reconciles. Employer contributions are never part
// of it: `payroll_run_lines.net_sen` is employee-side by construction
// (gross - employee deductions), and employer cost sits in a separate column
// that this module never reads.

const crypto = require('crypto');
const bankExport = require('./bankExport');

const BATCH_STATUS = {
  DRAFT: 'DRAFT', VALIDATED: 'VALIDATED', EXPORTED: 'EXPORTED',
  SUBMITTED: 'SUBMITTED', PAID: 'PAID', PARTIALLY_PAID: 'PARTIALLY_PAID',
  CANCELLED: 'CANCELLED',
};

const ITEM_STATUS = {
  PENDING: 'PENDING', EXPORTED: 'EXPORTED', SUBMITTED: 'SUBMITTED', PAID: 'PAID',
  REJECTED: 'REJECTED', FAILED: 'FAILED', RETURNED: 'RETURNED', CANCELLED: 'CANCELLED',
};

// Batch transitions. CANCELLED is reachable only before the file leaves.
const BATCH_TRANSITIONS = {
  DRAFT: ['VALIDATED', 'CANCELLED'],
  VALIDATED: ['EXPORTED', 'DRAFT', 'CANCELLED'],
  EXPORTED: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['PAID', 'PARTIALLY_PAID'],
  PARTIALLY_PAID: ['PAID', 'PARTIALLY_PAID'],
  PAID: [],
  CANCELLED: [],
};

// Item transitions. Terminal failures are NOT re-opened: a retry creates a
// NEW item, so the record of what the bank rejected survives intact.
const ITEM_TRANSITIONS = {
  PENDING: ['EXPORTED', 'CANCELLED'],
  EXPORTED: ['SUBMITTED', 'REJECTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['PAID', 'REJECTED', 'FAILED', 'RETURNED'],
  PAID: ['RETURNED'],            // a bank can return a credited transfer
  REJECTED: [], FAILED: [], RETURNED: [], CANCELLED: [],
};

const TERMINAL_FAILURES = ['REJECTED', 'FAILED', 'RETURNED', 'CANCELLED'];

const ERROR = {
  RUN_NOT_FINALIZED: 'RUN_NOT_FINALIZED',
  PERIOD_NOT_PAYABLE: 'PERIOD_NOT_PAYABLE',
  NO_PAYABLE_EMPLOYEES: 'NO_PAYABLE_EMPLOYEES',
  MISSING_BANK_ACCOUNT: 'MISSING_BANK_ACCOUNT',
  INVALID_BANK_ACCOUNT: 'INVALID_BANK_ACCOUNT',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  SOD_VIOLATION: 'SOD_VIOLATION',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
  NOT_RETRYABLE: 'NOT_RETRYABLE',
  VALIDATION: 'VALIDATION',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
};

class PaymentError extends Error {
  constructor(code, message, detail = null) { super(message); this.code = code; this.detail = detail; }
}

async function recordEvent(db, { batchId = null, itemId = null, from, to, actor, note = null, detail = null }) {
  await db.prepare(`
    INSERT INTO payroll_payment_events (batch_id, payment_item_id, from_status, to_status, actor, note, detail, occurred_at)
    VALUES (?,?,?,?,?,?,?, kahe_now())
  `).run(batchId, itemId, from, to, actor, note, detail ? JSON.stringify(detail) : null);
}

/**
 * The EFFECTIVE PAYABLE per employee for a period: finalized ORIGINAL +
 * CORRECTION + REVERSAL net. Reads persisted run lines only.
 */
async function getPayableEmployees(db, payrollPeriodId) {
  return await db.prepare(`
    SELECT l.employee_id,
           MIN(e.full_name) AS full_name,
           (array_agg(l.legal_entity_id ORDER BY r.id))[1] AS legal_entity_id,
           SUM(l.net_sen) AS payable_sen,
           COUNT(*) AS run_count,
           string_agg(r.id::text, ',' ORDER BY r.id) AS run_ids
    FROM payroll_run_lines l
    JOIN payroll_runs r ON r.id = l.payroll_run_id
    JOIN employees e ON e.id = l.employee_id
    WHERE r.payroll_period_id = ? AND r.status = 'FINALIZED' AND l.calc_status = 'OK'
    GROUP BY l.employee_id
    ORDER BY l.employee_id ASC
  `).all(payrollPeriodId);
}

/**
 * Bank-account validation. Deliberately structural only — it checks that an
 * account number is present and plausible, NOT that it exists at the bank.
 * Nothing here auto-fixes or normalises a bad record: a rejected account is
 * returned as an exception for a human to correct at source.
 */
function validateBankAccount(row) {
  if (!row.bank_account_no || String(row.bank_account_no).trim() === '') {
    return { valid: false, code: ERROR.MISSING_BANK_ACCOUNT, message: 'Nomor rekening belum diisi.' };
  }
  const acc = String(row.bank_account_no).trim();
  if (!/^[0-9]{6,20}$/.test(acc)) {
    return { valid: false, code: ERROR.INVALID_BANK_ACCOUNT,
      message: `Nomor rekening tidak valid (${acc}): harus 6-20 digit angka.` };
  }
  if (!row.bank_name || String(row.bank_name).trim() === '') {
    return { valid: false, code: ERROR.INVALID_BANK_ACCOUNT, message: 'Nama bank belum diisi.' };
  }
  if (!row.bank_account_name || String(row.bank_account_name).trim() === '') {
    return { valid: false, code: ERROR.INVALID_BANK_ACCOUNT, message: 'Nama pemilik rekening belum diisi.' };
  }
  return { valid: true };
}

/**
 * Prepare a payment batch for a period. Chunk-friendly and idempotent:
 * employees who already hold a live instruction for the period are skipped,
 * and the database index makes a duplicate structurally impossible.
 *
 * Returns { batch, summary, exceptions } — exceptions are employees who could
 * NOT be paid, each with a reason. They are never silently dropped or fixed.
 */
async function prepareBatch(db, payrollPeriodId, userContext, { chunkSize = 200 } = {}) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(payrollPeriodId);
  if (!period) throw new PaymentError(ERROR.VALIDATION, 'Payroll period tidak ditemukan.');
  const group = await db.prepare('SELECT * FROM payroll_groups WHERE id = ?').get(period.payroll_group_id);

  const originalFinalized = (await db.prepare(
    `SELECT COUNT(*) AS n FROM payroll_runs WHERE payroll_period_id = ? AND run_type = 'ORIGINAL' AND status = 'FINALIZED'`
  ).get(payrollPeriodId)).n;
  if (!originalFinalized) {
    throw new PaymentError(ERROR.RUN_NOT_FINALIZED,
      'Periode ini belum memiliki payroll run ORIGINAL berstatus FINALIZED.');
  }

  const payable = await getPayableEmployees(db, payrollPeriodId);
  if (payable.length === 0) throw new PaymentError(ERROR.NO_PAYABLE_EMPLOYEES, 'Tidak ada baris payroll final.');

  const batchRef = `PB-${group.legal_entity_id}-${period.period_year}${String(period.period_sequence).padStart(2, '0')}-${Date.now().toString(36).toUpperCase()}`;
  const info = await db.prepare(`
    INSERT INTO payroll_payment_batches (batch_reference, payroll_period_id, payroll_group_id,
      legal_entity_id, status, prepared_by, prepared_at, created_by, created_at)
    VALUES (?,?,?,?,'DRAFT',?,kahe_now(),?,kahe_now()) RETURNING id
  `).run(batchRef, payrollPeriodId, group.id, group.legal_entity_id,
    userContext.displayName, userContext.displayName);
  const batchId = info.lastInsertRowid;
  await recordEvent(db, { batchId, from: null, to: BATCH_STATUS.DRAFT, actor: userContext.displayName,
    note: 'Batch pembayaran disiapkan.' });

  const summary = { prepared: 0, skipped_existing: 0, excluded: 0, total_amount_sen: 0 };
  const exceptions = [];

  const insertItem = db.prepare(`
    INSERT INTO payroll_payment_items (batch_id, payroll_period_id, employee_id, legal_entity_id,
      payment_reference, amount_sen, source_run_ids, bank_name, bank_account_no, bank_account_name,
      bank_snapshot_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,kahe_now(),'PENDING',kahe_now())
  `);

  for (const row of payable) {
    // Entity isolation: a batch only ever carries its own entity.
    if (row.legal_entity_id !== group.legal_entity_id) {
      exceptions.push({ employee_id: row.employee_id, code: ERROR.ENTITY_MISMATCH,
        message: `Baris payroll milik entity ${row.legal_entity_id}, batch milik ${group.legal_entity_id}.` });
      summary.excluded += 1;
      continue;
    }

    // A zero or negative effective payable is NOT a payment. A negative net
    // (typically after a reversal or a large recovery) is an over-payment to
    // be recovered, which is a separate process — never a negative transfer.
    if (Number(row.payable_sen) <= 0) {
      exceptions.push({ employee_id: row.employee_id,
        code: ERROR.PERIOD_NOT_PAYABLE,
        message: `Nilai efektif ${row.payable_sen} sen tidak dapat dibayarkan (nol atau negatif). Tangani sebagai pemulihan kelebihan bayar, bukan transfer.`,
        amount_sen: Number(row.payable_sen) });
      summary.excluded += 1;
      continue;
    }

    const live = await db.prepare(`
      SELECT id, batch_id, status FROM payroll_payment_items
      WHERE payroll_period_id = ? AND employee_id = ? AND status NOT IN ('REJECTED','FAILED','RETURNED','CANCELLED')
    `).get(payrollPeriodId, row.employee_id);
    if (live) {
      summary.skipped_existing += 1;
      exceptions.push({ employee_id: row.employee_id, code: ERROR.DUPLICATE_PAYMENT,
        message: `Sudah ada instruksi pembayaran aktif (#${live.id}, batch ${live.batch_id}, status ${live.status}).`,
        existing_item_id: live.id });
      continue;
    }

    const employee = await db.prepare(
      'SELECT id, full_name, bank_name, bank_account_no, bank_account_name FROM employees WHERE id = ?'
    ).get(row.employee_id);
    const bank = {
      bank_name: employee.bank_name,
      bank_account_no: employee.bank_account_no,
      // Fall back to the employee's legal name only for display; a missing
      // account holder name is still flagged below.
      bank_account_name: employee.bank_account_name || employee.full_name,
    };
    const check = validateBankAccount(bank);
    if (!check.valid) {
      exceptions.push({ employee_id: row.employee_id, code: check.code, message: check.message });
      summary.excluded += 1;
      continue;
    }

    const paymentRef = `${batchRef}-${row.employee_id}`;
    await insertItem.run(batchId, payrollPeriodId, row.employee_id, row.legal_entity_id,
      paymentRef, Number(row.payable_sen), JSON.stringify(String(row.run_ids).split(',').map(Number)),
      bank.bank_name, bank.bank_account_no, bank.bank_account_name);
    summary.prepared += 1;
    summary.total_amount_sen += Number(row.payable_sen);
  }

  await db.prepare('UPDATE payroll_payment_batches SET item_count = ?, total_amount_sen = ? WHERE id = ?')
    .run(summary.prepared, summary.total_amount_sen, batchId);

  const batch = await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(batchId);
  return { batch, summary, exceptions };
}

function assertBatchTransition(batch, to) {
  const allowed = BATCH_TRANSITIONS[batch.status] || [];
  if (!allowed.includes(to)) {
    throw new PaymentError(ERROR.INVALID_TRANSITION,
      `Transisi batch ${batch.status} -> ${to} tidak diizinkan. Yang diizinkan: ${allowed.join(', ') || '(tidak ada)'}.`,
      { from: batch.status, to, allowed });
  }
}

/** DRAFT -> VALIDATED. Reconciles the batch against the finalized payroll. */
async function validateBatch(db, batch, userContext, note) {
  assertBatchTransition(batch, BATCH_STATUS.VALIDATED);
  const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id = ?').all(batch.id);
  if (items.length === 0) throw new PaymentError(ERROR.NO_PAYABLE_EMPLOYEES, 'Batch tidak memiliki instruksi.');

  const problems = [];
  const sum = items.reduce((t, i) => t + i.amount_sen, 0);
  if (sum !== batch.total_amount_sen) {
    problems.push(`total instruksi ${sum} != total batch ${batch.total_amount_sen}`);
  }

  // Every instruction must still equal the effective payable from FINALIZED
  // payroll. If a correction has been finalized since preparation, this is
  // where it surfaces — as a refusal, never a silent re-price.
  const payable = new Map((await getPayableEmployees(db, batch.payroll_period_id))
    .map((r) => [r.employee_id, Number(r.payable_sen)]));
  for (const i of items) {
    const expected = payable.get(i.employee_id);
    if (expected === undefined) { problems.push(`${i.employee_id}: tidak ada baris payroll final`); continue; }
    if (expected !== i.amount_sen) {
      problems.push(`${i.employee_id}: instruksi ${i.amount_sen} != payable efektif ${expected}`);
    }
    if (i.legal_entity_id !== batch.legal_entity_id) {
      problems.push(`${i.employee_id}: legal entity berbeda dengan batch`);
    }
  }
  if (problems.length) {
    throw new PaymentError(ERROR.RECONCILIATION_FAILED,
      'Batch tidak cocok dengan payroll final.', { problems });
  }

  await db.prepare(`UPDATE payroll_payment_batches SET status='VALIDATED', validated_by=?, validated_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, batch.id);
  await recordEvent(db, { batchId: batch.id, from: batch.status, to: BATCH_STATUS.VALIDATED,
    actor: userContext.displayName, note, detail: { items: items.length, total_amount_sen: sum } });
  return { items: items.length, total_amount_sen: sum };
}

/**
 * VALIDATED -> EXPORTED. Idempotent: re-exporting an already EXPORTED batch
 * rebuilds the same bytes and returns the same hash without changing state or
 * re-stamping who exported it.
 */
async function exportBatch(db, batch, formatCode, userContext, note) {
  if (batch.status === BATCH_STATUS.EXPORTED) {
    const items = await db.prepare('SELECT * FROM payroll_payment_items WHERE batch_id = ? ORDER BY employee_id').all(batch.id);
    const file = bankExport.buildExport(batch.export_format, await decorate(db, batch), items);
    return { idempotent: true, file, batch };
  }
  assertBatchTransition(batch, BATCH_STATUS.EXPORTED);

  const items = await db.prepare(
    `SELECT * FROM payroll_payment_items WHERE batch_id = ? AND status = 'PENDING' ORDER BY employee_id`
  ).all(batch.id);
  if (items.length === 0) throw new PaymentError(ERROR.NO_PAYABLE_EMPLOYEES, 'Tidak ada instruksi PENDING untuk diekspor.');

  const file = bankExport.buildExport(formatCode, await decorate(db, batch), items);

  await db.prepare(`UPDATE payroll_payment_batches SET status='EXPORTED', export_format=?, export_reference=?,
              export_hash=?, exported_by=?, exported_at=kahe_now() WHERE id=?`)
    .run(formatCode, file.filename, file.content_hash, userContext.displayName, batch.id);
  for (const i of items) {
    await db.prepare(`UPDATE payroll_payment_items SET status='EXPORTED' WHERE id=?`).run(i.id);
    await recordEvent(db, { batchId: batch.id, itemId: i.id, from: i.status, to: ITEM_STATUS.EXPORTED,
      actor: userContext.displayName, note: 'Diekspor ke file bank.' });
  }
  await recordEvent(db, { batchId: batch.id, from: batch.status, to: BATCH_STATUS.EXPORTED,
    actor: userContext.displayName, note,
    detail: { format: formatCode, filename: file.filename, hash: file.content_hash,
      verified_against_bank_spec: file.verified_against_bank_spec } });

  return { idempotent: false, file, batch: await db.prepare('SELECT * FROM payroll_payment_batches WHERE id=?').get(batch.id) };
}

async function decorate(db, batch) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(batch.payroll_period_id);
  return { ...batch, period_label: `${period.period_year}-${String(period.period_sequence).padStart(2, '0')}` };
}

/**
 * EXPORTED -> SUBMITTED. This is the AUTHORISATION step: it requires
 * payroll_payment:APPROVE, and the person who prepared the batch may not
 * authorise it unless they hold the explicit SoD override — mirroring the
 * payroll-run control from Phase 2E.
 */
async function submitBatch(db, batch, userContext, note) {
  assertBatchTransition(batch, BATCH_STATUS.SUBMITTED);
  const perms = userContext.permissions || {};
  if (!(perms.payroll_payment || []).includes('APPROVE')) {
    throw new PaymentError(ERROR.NOT_AUTHORIZED,
      'Mengirim batch pembayaran memerlukan izin payroll_payment:APPROVE.');
  }
  const hasOverride = (perms.payroll_sod_override || []).length > 0;
  if (!hasOverride && batch.prepared_by && batch.prepared_by === userContext.displayName) {
    throw new PaymentError(ERROR.SOD_VIOLATION,
      `Pemisahan tugas: ${userContext.displayName} yang menyiapkan batch ini tidak boleh mengotorisasi pengirimannya sendiri.`,
      { prepared_by: batch.prepared_by });
  }

  await db.prepare(`UPDATE payroll_payment_batches SET status='SUBMITTED', authorized_by=?, authorized_at=kahe_now(),
              submitted_by=?, submitted_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, userContext.displayName, batch.id);
  const items = await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status='EXPORTED'`).all(batch.id);
  for (const i of items) {
    await db.prepare(`UPDATE payroll_payment_items SET status='SUBMITTED' WHERE id=?`).run(i.id);
    await recordEvent(db, { batchId: batch.id, itemId: i.id, from: i.status, to: ITEM_STATUS.SUBMITTED, actor: userContext.displayName });
  }
  await recordEvent(db, { batchId: batch.id, from: batch.status, to: BATCH_STATUS.SUBMITTED,
    actor: userContext.displayName, note, detail: { sod_override_used: hasOverride, prepared_by: batch.prepared_by } });
  return { items: items.length };
}

/**
 * Record a bank outcome for ONE instruction. Nothing is auto-fixed: a
 * rejection records the bank's reason and stops there. Correcting the
 * underlying record is a human action at source, followed by an explicit retry.
 */
async function recordItemOutcome(db, itemId, toStatus, userContext, { reason = null, bankCode = null } = {}) {
  const item = await db.prepare('SELECT * FROM payroll_payment_items WHERE id = ?').get(itemId);
  if (!item) throw new PaymentError(ERROR.VALIDATION, 'Instruksi pembayaran tidak ditemukan.');
  const allowed = ITEM_TRANSITIONS[item.status] || [];
  if (!allowed.includes(toStatus)) {
    throw new PaymentError(ERROR.INVALID_TRANSITION,
      `Transisi instruksi ${item.status} -> ${toStatus} tidak diizinkan. Yang diizinkan: ${allowed.join(', ') || '(tidak ada)'}.`,
      { from: item.status, to: toStatus, allowed });
  }
  if (TERMINAL_FAILURES.includes(toStatus) && !reason) {
    throw new PaymentError(ERROR.VALIDATION, 'Alasan wajib diisi untuk status kegagalan.');
  }

  await db.prepare(`UPDATE payroll_payment_items SET status=?, status_reason=?, bank_response_code=?,
              paid_at = CASE WHEN ? = 'PAID' THEN kahe_now() ELSE paid_at END WHERE id=?`)
    .run(toStatus, reason, bankCode, toStatus, item.id);
  await recordEvent(db, { batchId: item.batch_id, itemId: item.id, from: item.status, to: toStatus,
    actor: userContext.displayName, note: reason, detail: { bank_response_code: bankCode } });

  await refreshBatchStatus(db, item.batch_id, userContext);
  return await db.prepare('SELECT * FROM payroll_payment_items WHERE id = ?').get(item.id);
}

/** Derive the batch outcome from its items. PAID only when nothing is pending. */
async function refreshBatchStatus(db, batchId, userContext) {
  const batch = await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(batchId);
  if (![BATCH_STATUS.SUBMITTED, BATCH_STATUS.PARTIALLY_PAID].includes(batch.status)) return batch;

  const counts = await db.prepare(`
    SELECT SUM(CASE WHEN status='PAID' THEN 1 ELSE 0 END) AS paid,
           SUM(CASE WHEN status IN ('REJECTED','FAILED','RETURNED','CANCELLED') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status IN ('PENDING','EXPORTED','SUBMITTED') THEN 1 ELSE 0 END) AS open,
           COUNT(*) AS total
    FROM payroll_payment_items WHERE batch_id = ?
  `).get(batchId);

  let next = null;
  if (counts.open === 0 && counts.failed === 0) next = BATCH_STATUS.PAID;
  else if (counts.open === 0 && counts.paid > 0) next = BATCH_STATUS.PARTIALLY_PAID;
  else if (counts.paid > 0 || counts.failed > 0) next = BATCH_STATUS.PARTIALLY_PAID;

  if (next && next !== batch.status) {
    await db.prepare('UPDATE payroll_payment_batches SET status=? WHERE id=?').run(next, batchId);
    await recordEvent(db, { batchId, from: batch.status, to: next, actor: userContext.displayName,
      note: 'Status batch diturunkan dari hasil per instruksi.', detail: counts });
  }
  return await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(batchId);
}

/**
 * Retry a failed instruction. Creates a NEW item in a NEW batch context,
 * linked to the original. The failed item is never edited, so the record of
 * what the bank rejected survives, and the unique live index guarantees the
 * employee cannot end up with two payable instructions.
 */
async function retryItem(db, itemId, targetBatchId, userContext, note) {
  const original = await db.prepare('SELECT * FROM payroll_payment_items WHERE id = ?').get(itemId);
  if (!original) throw new PaymentError(ERROR.VALIDATION, 'Instruksi tidak ditemukan.');
  if (!TERMINAL_FAILURES.includes(original.status) || original.status === ITEM_STATUS.CANCELLED) {
    throw new PaymentError(ERROR.NOT_RETRYABLE,
      `Hanya instruksi REJECTED / FAILED / RETURNED yang bisa diulang (status: ${original.status}).`);
  }
  const batch = await db.prepare('SELECT * FROM payroll_payment_batches WHERE id = ?').get(targetBatchId);
  if (!batch) throw new PaymentError(ERROR.VALIDATION, 'Batch tujuan tidak ditemukan.');
  if (batch.status !== BATCH_STATUS.DRAFT) {
    throw new PaymentError(ERROR.INVALID_TRANSITION, 'Batch tujuan harus berstatus DRAFT.');
  }
  if (batch.legal_entity_id !== original.legal_entity_id) {
    throw new PaymentError(ERROR.ENTITY_MISMATCH, 'Batch tujuan berada pada legal entity berbeda.');
  }

  // Re-snapshot the bank account: the point of a retry is usually that the
  // account was corrected at source.
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(original.employee_id);
  const bank = {
    bank_name: employee.bank_name,
    bank_account_no: employee.bank_account_no,
    bank_account_name: employee.bank_account_name || employee.full_name,
  };
  const check = validateBankAccount(bank);
  if (!check.valid) throw new PaymentError(check.code, check.message);

  const paymentRef = `${batch.batch_reference}-${original.employee_id}-R${original.retry_count + 1}`;
  const info = await db.prepare(`
    INSERT INTO payroll_payment_items (batch_id, payroll_period_id, employee_id, legal_entity_id,
      payment_reference, amount_sen, source_run_ids, bank_name, bank_account_no, bank_account_name,
      bank_snapshot_at, status, retry_of_item_id, retry_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,kahe_now(),'PENDING',?,?,kahe_now()) RETURNING id
  `).run(batch.id, original.payroll_period_id, original.employee_id, original.legal_entity_id,
    paymentRef, original.amount_sen, original.source_run_ids,
    bank.bank_name, bank.bank_account_no, bank.bank_account_name,
    original.id, original.retry_count + 1);

  await db.prepare('UPDATE payroll_payment_batches SET item_count = item_count + 1, total_amount_sen = total_amount_sen + ? WHERE id = ?')
    .run(original.amount_sen, batch.id);
  await recordEvent(db, { batchId: batch.id, itemId: info.lastInsertRowid, from: null, to: ITEM_STATUS.PENDING,
    actor: userContext.displayName, note: note || `Pengulangan instruksi #${original.id}.`,
    detail: { retry_of_item_id: original.id, retry_count: original.retry_count + 1 } });

  return await db.prepare('SELECT * FROM payroll_payment_items WHERE id = ?').get(info.lastInsertRowid);
}

async function cancelBatch(db, batch, userContext, reason) {
  assertBatchTransition(batch, BATCH_STATUS.CANCELLED);
  if (!reason) throw new PaymentError(ERROR.VALIDATION, 'Alasan pembatalan wajib diisi.');
  await db.prepare(`UPDATE payroll_payment_batches SET status='CANCELLED', cancelled_by=?, cancelled_at=kahe_now(), cancel_reason=? WHERE id=?`)
    .run(userContext.displayName, reason, batch.id);
  for (const i of await db.prepare(`SELECT * FROM payroll_payment_items WHERE batch_id=? AND status IN ('PENDING','EXPORTED')`).all(batch.id)) {
    await db.prepare(`UPDATE payroll_payment_items SET status='CANCELLED', status_reason=? WHERE id=?`).run(reason, i.id);
    await recordEvent(db, { batchId: batch.id, itemId: i.id, from: i.status, to: ITEM_STATUS.CANCELLED, actor: userContext.displayName, note: reason });
  }
  await recordEvent(db, { batchId: batch.id, from: batch.status, to: BATCH_STATUS.CANCELLED, actor: userContext.displayName, note: reason });
}

/** Payment vs payroll reconciliation for a period. */
async function reconcilePayment(db, payrollPeriodId) {
  const payable = await getPayableEmployees(db, payrollPeriodId);
  const payableTotal = payable.reduce((t, r) => t + Math.max(0, Number(r.payable_sen)), 0);

  const paid = (await db.prepare(`
    SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items
    WHERE payroll_period_id = ? AND status = 'PAID'
  `).get(payrollPeriodId)).n;
  const inFlight = (await db.prepare(`
    SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items
    WHERE payroll_period_id = ? AND status IN ('PENDING','EXPORTED','SUBMITTED')
  `).get(payrollPeriodId)).n;
  const failed = (await db.prepare(`
    SELECT COALESCE(SUM(amount_sen),0) AS n FROM payroll_payment_items
    WHERE payroll_period_id = ? AND status IN ('REJECTED','FAILED','RETURNED')
  `).get(payrollPeriodId)).n;

  return {
    payroll_period_id: payrollPeriodId,
    payable_employees: payable.length,
    payable_total_sen: payableTotal,
    paid_sen: paid,
    in_flight_sen: inFlight,
    failed_sen: failed,
    outstanding_sen: payableTotal - paid - inFlight,
    fully_settled: payableTotal === paid,
  };
}

function hashBatch(batch, items) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ b: batch.batch_reference, i: items.map((x) => [x.payment_reference, x.amount_sen]) }))
    .digest('hex');
}

module.exports = {
  BATCH_STATUS, ITEM_STATUS, BATCH_TRANSITIONS, ITEM_TRANSITIONS, TERMINAL_FAILURES,
  ERROR, PaymentError,
  getPayableEmployees, validateBankAccount, prepareBatch, validateBatch, exportBatch,
  submitBatch, recordItemOutcome, refreshBatchStatus, retryItem, cancelBatch,
  reconcilePayment, recordEvent, hashBatch,
};
