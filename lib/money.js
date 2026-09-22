// lib/money.js
// Phase 0 / B3 — exact monetary representation.
//
// WHY: JavaScript numbers are IEEE-754 doubles. 0.1 + 0.2 === 0.30000000000000004,
// and this project already hit a float artifact displaying a BPJS rate
// (3.6999999999999996%). Across thousands of payslips, float drift means the
// sum of payslip lines will not reconcile against the bank transfer total.
//
// POLICY (single source of truth — do not reimplement elsewhere):
//   * MONEY is stored and computed as INTEGER **sen** (1 rupiah = 100 sen).
//     Column naming convention: `<name>_sen`.
//   * RATES/PERCENTAGES are stored as INTEGER **basis points** (1 bp = 1/10000
//     = 0.01%). Column naming convention: `<name>_bp`.
//     Every statutory rate in use is exactly representable: 0.24% = 24 bp,
//     1.27% = 127 bp, 3.7% = 370 bp, 0.25% = 25 bp.
//   * MULTIPLIERS (overtime 1.5x/2x/3x/4x) use the same 1/10000 scale
//     (1.5x = 15000). Column naming convention: `<name>_bp`.
//   * ROUNDING is half-up, applied ONLY at the points named in
//     docs/PAYROLL_ENGINE_AUDIT.md section E. Intermediate results stay as
//     exact integers wherever possible; where a division is unavoidable,
//     round once, at the end, with roundHalfUp.

const SEN_PER_RUPIAH = 100;
const BP_SCALE = 10000; // basis points per unit (1.0 === 10000 bp)

/** Rupiah (number, possibly fractional) -> integer sen. Rounds half-up. */
function rupiahToSen(rupiah) {
  if (rupiah === null || rupiah === undefined || rupiah === '') return null;
  const n = Number(rupiah);
  if (!Number.isFinite(n)) throw new TypeError(`rupiahToSen: not a finite number: ${rupiah}`);
  return roundHalfUp(n * SEN_PER_RUPIAH);
}

/** Integer sen -> rupiah as a Number (for display only, never for maths). */
function senToRupiah(sen) {
  if (sen === null || sen === undefined) return null;
  return Number(sen) / SEN_PER_RUPIAH;
}

/** Integer sen -> "Rp1.234.567" for UI. */
function formatIDR(sen) {
  if (sen === null || sen === undefined) return '-';
  return 'Rp' + Math.round(Number(sen) / SEN_PER_RUPIAH).toLocaleString('id-ID');
}

/** Decimal rate (0.037) -> integer basis points (370). Rounds half-up. */
function rateToBp(rate) {
  if (rate === null || rate === undefined || rate === '') return null;
  const n = Number(rate);
  if (!Number.isFinite(n)) throw new TypeError(`rateToBp: not a finite number: ${rate}`);
  return roundHalfUp(n * BP_SCALE);
}

/** Integer basis points (370) -> decimal rate (0.037). Display/interop only. */
function bpToRate(bp) {
  if (bp === null || bp === undefined) return null;
  return Number(bp) / BP_SCALE;
}

/** Integer basis points (370) -> percentage string ("3.7"). No float artifacts. */
function bpToPercentString(bp) {
  if (bp === null || bp === undefined) return '-';
  const n = Number(bp);
  const whole = Math.trunc(n / 100);
  const frac = Math.abs(n % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** Integer basis points (15000) -> multiplier string ("1.5"). */
function bpToMultiplierString(bp) {
  if (bp === null || bp === undefined) return '-';
  const rate = Number(bp) / BP_SCALE;
  return Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(4)));
}

/**
 * Apply a basis-point rate to an integer sen amount, returning integer sen.
 * This is THE function payroll calculations must use — it keeps the whole
 * operation in integer space and rounds exactly once, half-up.
 *   applyBp(800000000, 370) === 29600000  (Rp8,000,000 x 3.7% = Rp296,000)
 */
function applyBp(amountSen, bp) {
  if (amountSen === null || amountSen === undefined) return null;
  return roundHalfUp((Number(amountSen) * Number(bp)) / BP_SCALE);
}

/**
 * Half-up rounding, symmetric for negatives (-2.5 -> -3).
 * Math.round() rounds -2.5 to -2, which is not what payroll expects.
 */
function roundHalfUp(n) {
  if (!Number.isFinite(n)) throw new TypeError(`roundHalfUp: not a finite number: ${n}`);
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

module.exports = {
  SEN_PER_RUPIAH,
  BP_SCALE,
  rupiahToSen,
  senToRupiah,
  formatIDR,
  rateToBp,
  bpToRate,
  bpToPercentString,
  bpToMultiplierString,
  applyBp,
  roundHalfUp,
};
