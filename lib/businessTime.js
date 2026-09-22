// lib/businessTime.js
// Attendance A2 — THE single authority for "what date is it, in the business
// timezone", and for clock/minute arithmetic on HH:MM strings.
//
// WHY: `new Date().toISOString().slice(0,10)` is UTC. In WIB (UTC+7) that
// makes everything between 00:00 and 07:00 local resolve to YESTERDAY, so a
// night-shift supervisor recording attendance at 01:00 got the wrong work
// date and the wrong cutoff answer. Nothing outside this file may derive a
// business date, and the timezone name appears here ONCE.
//
// Storage strategy (documented in docs/ATTENDANCE_ARCHITECTURE.md):
//   - work_date, effective dates, cutoffs: date-only 'YYYY-MM-DD' strings,
//     compared lexicographically. No Date parsing at a boundary.
//   - clock_in / clock_out: 'HH:MM' local wall clock + clock_out_date for the
//     actual end date, so a cross-midnight shift is one row, never two.
//   - created_at / occurred_at audit stamps stay SQLite kahe_now() (UTC),
//     because an audit trail wants a monotonic absolute instant, not a local one.

const BUSINESS_TIMEZONE = process.env.KAHE360_TZ || 'Asia/Jakarta';
const MINUTES_PER_DAY = 1440;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Today's date in the business timezone, as 'YYYY-MM-DD'. */
function businessToday(now = new Date()) {
  return dateFormatter.format(now);            // en-CA formats as YYYY-MM-DD
}

/** Current wall-clock 'HH:MM' in the business timezone. */
function businessNowTime(now = new Date()) {
  return timeFormatter.format(now);
}

/** 'YYYY-MM-DD' + n days, UTC-safe (dates are calendar labels, not instants). */
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/** Whole days between two 'YYYY-MM-DD' labels (b - a). */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** ISO weekday index: 1 = Monday … 7 = Sunday. */
function isoWeekday(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  return d === 0 ? 7 : d;
}

const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const weekdayName = (date) => WEEKDAY_NAMES[isoWeekday(date) - 1];

function isValidTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

/** 'HH:MM' -> minutes since midnight (integer). */
function timeToMinutes(t) {
  if (!isValidTime(t)) throw new TypeError(`businessTime: invalid HH:MM "${t}"`);
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** minutes since midnight -> 'HH:MM' (wraps across a day boundary). */
function minutesToTime(min) {
  const v = ((Math.round(min) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * Elapsed minutes from `from` to `to`, where `to` may fall on the next day.
 * Never negative: when `to` <= `from` and the span is allowed to cross
 * midnight, a day is added. Returns null when it cannot be resolved.
 */
function elapsedMinutes(from, to, { crossMidnight = false, dayOffset = null } = {}) {
  const a = timeToMinutes(from);
  const b = timeToMinutes(to);
  const offset = dayOffset === null ? ((b <= a && crossMidnight) ? 1 : 0) : Number(dayOffset);
  const total = b + offset * MINUTES_PER_DAY - a;
  return total < 0 ? null : total;
}

module.exports = {
  BUSINESS_TIMEZONE, MINUTES_PER_DAY,
  businessToday, businessNowTime, addDays, daysBetween,
  isoWeekday, weekdayName, WEEKDAY_NAMES,
  isValidTime, timeToMinutes, minutesToTime, elapsedMinutes,
};
