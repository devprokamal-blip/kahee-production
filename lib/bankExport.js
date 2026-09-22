// lib/bankExport.js
// Phase 2H — bank file export abstraction.
//
// DELIBERATELY FORMAT-AGNOSTIC. Adapters are registered here; the payment
// layer knows nothing about any particular bank's layout.
//
// HONEST SCOPE STATEMENT — do not weaken this without a real specification:
//   The formats below are GENERIC. They are NOT BCA, Mandiri, BNI, BRI or any
//   other bank's transfer format. Indonesian bank host-to-host layouts are
//   specified per bank (and often per corporate agreement), and none has been
//   obtained or tested here. Claiming compatibility without the actual
//   specification would mean a rejected file at best and a mis-paid employee
//   at worst. When a real specification arrives, add an adapter beside these
//   and test it against the bank's own validator before enabling it.

const crypto = require('crypto');
const { senToRupiah } = require('./money');

const ADAPTERS = new Map();

/**
 * Register an export adapter.
 * @param {string} code    stable identifier stored on the batch
 * @param {object} adapter { label, contentType, extension, verified, build(batch, items) }
 */
function registerAdapter(code, adapter) {
  for (const f of ['label', 'contentType', 'extension', 'build']) {
    if (!adapter[f]) throw new Error(`bank export adapter ${code} is missing ${f}`);
  }
  ADAPTERS.set(code, {
    // `verified` means: tested against the bank's own specification/validator.
    // Generic formats are honest about being unverified against any bank.
    verified: false,
    bank: null,
    ...adapter,
  });
}

function getAdapter(code) {
  const a = ADAPTERS.get(code);
  if (!a) {
    throw new Error(`Format ekspor tidak dikenal: ${code}. Terdaftar: ${[...ADAPTERS.keys()].join(', ')}`);
  }
  return a;
}

function listAdapters() {
  return [...ADAPTERS.entries()].map(([code, a]) => ({
    code, label: a.label, extension: a.extension, contentType: a.contentType,
    bank: a.bank, verified_against_bank_spec: a.verified,
  }));
}

/** CSV escaping: quote when needed, double embedded quotes. */
function csvCell(value) {
  const v = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---- generic adapters --------------------------------------------------------

registerAdapter('GENERIC_CSV', {
  label: 'Generic CSV (tidak spesifik bank)',
  contentType: 'text/csv',
  extension: 'csv',
  build(batch, items) {
    const header = [
      'payment_reference', 'employee_id', 'beneficiary_name', 'bank_name',
      'account_number', 'amount_idr', 'amount_sen', 'currency', 'period', 'batch_reference',
    ];
    const lines = [header.join(',')];
    for (const i of items) {
      lines.push([
        i.payment_reference, i.employee_id, i.bank_account_name, i.bank_name,
        i.bank_account_no, senToRupiah(i.amount_sen), i.amount_sen, 'IDR',
        batch.period_label, batch.batch_reference,
      ].map(csvCell).join(','));
    }
    // Trailer so a truncated file is detectable by the receiver.
    lines.push(['#TOTAL', items.length, batch.total_amount_sen, senToRupiah(batch.total_amount_sen)].join(','));
    return lines.join('\n');
  },
});

registerAdapter('GENERIC_JSON', {
  label: 'Generic JSON (tidak spesifik bank)',
  contentType: 'application/json',
  extension: 'json',
  build(batch, items) {
    return JSON.stringify({
      batch_reference: batch.batch_reference,
      legal_entity_id: batch.legal_entity_id,
      period: batch.period_label,
      currency: 'IDR',
      item_count: items.length,
      total_amount_sen: batch.total_amount_sen,
      instructions: items.map((i) => ({
        payment_reference: i.payment_reference,
        employee_id: i.employee_id,
        beneficiary_name: i.bank_account_name,
        bank_name: i.bank_name,
        account_number: i.bank_account_no,
        amount_sen: i.amount_sen,
      })),
    }, null, 2);
  },
});

/** Build the file and its integrity hash. Pure — no I/O, no database. */
function buildExport(formatCode, batch, items) {
  const adapter = getAdapter(formatCode);
  const content = adapter.build(batch, items);
  return {
    format: formatCode,
    label: adapter.label,
    verified_against_bank_spec: adapter.verified,
    bank: adapter.bank,
    content_type: adapter.contentType,
    extension: adapter.extension,
    filename: `${batch.batch_reference}.${adapter.extension}`,
    content,
    content_hash: crypto.createHash('sha256').update(content).digest('hex'),
    byte_length: Buffer.byteLength(content, 'utf8'),
  };
}

module.exports = { registerAdapter, getAdapter, listAdapters, buildExport, csvCell };
