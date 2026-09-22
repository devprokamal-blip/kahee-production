// lib/time.js
// Phase 0B / N1 — exact representation for payroll-relevant time quantities.
//
// WHY: hours were stored as REAL. They are the multiplicand in every overtime
// amount (rate_sen_per_hour x hours x multiplier), so a float hour contaminates
// the otherwise-exact integer chain won in Phase 0:
//   7.25h x rate = 33526008.25        (not an integer)
//   0.1h summed ten times = 0.9999999999999999
//
// POLICY (single source of truth — do not reimplement elsewhere):
//   * CANONICAL STORAGE is INTEGER MINUTES. Column naming: `<name>_minutes`.
//     Minutes were chosen over seconds because attendance is recorded to the
//     minute (clock_in/clock_out are HH:MM) — seconds would store precision
//     the source data does not have, and a coarser unit (quarter-hours) would
//     lose legitimate values like a 07:58 clock-in.
//   * The API may ACCEPT and DISPLAY hours for humans. Every payroll
//     calculation must use minutes.
//   * CONVERSION hours -> minutes is half-up at the minute
//     (0.1h = 6 min exactly; 7.25h = 435 min exactly). Half-up matches
//     lib/money.js so the whole system rounds one way, never two.
//   * Legacy REAL hours migrate deterministically: minutes = roundHalfUp(h*60).
//     Values expressible in whole minutes (every 0.25/0.5 step, and 0.1h)
//     survive a round trip exactly.
//
// PAY COMPUTATION (the reason this file exists). The engine must use
// overtimePaySen() below rather than multiplying hours itself: it stays in
// integer space and rounds exactly ONCE, at the end.

const { roundHalfUp } = require('./money');

const MINUTES_PER_HOUR = 60;

/** Hours (possibly fractional) -> integer minutes, half-up. */
function hoursToMinutes(hours) {
  if (hours === null || hours === undefined || hours === '') return null;
  const n = Number(hours);
  if (!Number.isFinite(n)) throw new TypeError(`hoursToMinutes: not a finite number: ${hours}`);
  return roundHalfUp(n * MINUTES_PER_HOUR);
}

/** Integer minutes -> hours as a Number. DISPLAY ONLY — never for maths. */
function minutesToHours(minutes) {
  if (minutes === null || minutes === undefined) return null;
  return Number(minutes) / MINUTES_PER_HOUR;
}

/** Integer minutes -> "7 jam 15 mnt" for the UI. */
function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  const total = Math.abs(Number(minutes));
  const h = Math.trunc(total / MINUTES_PER_HOUR);
  const m = total % MINUTES_PER_HOUR;
  const sign = Number(minutes) < 0 ? '-' : '';
  if (m === 0) return `${sign}${h} jam`;
  if (h === 0) return `${sign}${m} mnt`;
  return `${sign}${h} jam ${m} mnt`;
}

/**
 * Accept either `<field>` in hours or `<field>_minutes` in minutes from a
 * client payload and return canonical integer minutes. Having ONE function do
 * this is what prevents two competing sources of truth after the migration.
 */
function resolveMinutes(body, hoursField, minutesField = `${hoursField}_minutes`) {
  if (body[minutesField] !== undefined && body[minutesField] !== null && body[minutesField] !== '') {
    const n = Number(body[minutesField]);
    if (!Number.isInteger(n)) throw new TypeError(`${minutesField} must be an integer number of minutes`);
    return n;
  }
  return hoursToMinutes(body[hoursField]);
}

/**
 * Exact overtime pay, entirely in integer space, rounded once.
 *
 *   pay_sen = hourlyRateSen x minutes x multiplierBp / (60 x 10000)
 *
 * The engine must call THIS rather than assembling the expression itself —
 * that is how "rounded exactly once, half-up" stays true system-wide.
 *
 * @param {number} hourlyRateSen  integer sen per hour
 * @param {number} minutes        integer minutes of overtime
 * @param {number} multiplierBp   multiplier on the 1/10000 scale (1.5x = 15000)
 * @returns {number} integer sen
 */
function overtimePaySen(hourlyRateSen, minutes, multiplierBp) {
  if ([hourlyRateSen, minutes, multiplierBp].some((v) => v === null || v === undefined)) return null;
  const numerator = Number(hourlyRateSen) * Number(minutes) * Number(multiplierBp);
  if (!Number.isSafeInteger(numerator)) {
    // Loud failure beats a silently wrong payslip. If this ever fires the
    // inputs are implausible (or the scale changed) and must be inspected.
    throw new RangeError(
      `overtimePaySen: intermediate ${numerator} exceeds safe integer range ` +
      `(rate=${hourlyRateSen}, minutes=${minutes}, multiplierBp=${multiplierBp})`
    );
  }
  return roundHalfUp(numerator / (MINUTES_PER_HOUR * 10000));
}

/**
 * Hourly rate from a monthly amount and the configured divisor
 * (PP 35/2021 uses 1/173). Integer sen in, integer sen out, rounded once.
 */
function hourlyRateSen(monthlySalarySen, divisor) {
  if (monthlySalarySen === null || monthlySalarySen === undefined) return null;
  if (!divisor) throw new TypeError('hourlyRateSen: divisor is required (see payroll_rule_sets.overtime_hourly_divisor)');
  return roundHalfUp(Number(monthlySalarySen) / Number(divisor));
}

module.exports = {
  MINUTES_PER_HOUR,
  hoursToMinutes,
  minutesToHours,
  formatMinutes,
  resolveMinutes,
  overtimePaySen,
  hourlyRateSen,
};
