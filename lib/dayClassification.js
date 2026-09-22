// lib/dayClassification.js
// Phase 1B / B2 — THE single source of truth for "what kind of day is this,
// for this employee?".
//
// ARCHITECTURAL LOCK — read before changing anything here:
//   This module decides the DAY TYPE. It never decides what a day is WORTH.
//   No multiplier, rate, or money value may ever appear in this file. The
//   Overtime Rule configuration (overtime_multiplier_rules, Domain 3c) owns
//   that decision, keyed off the day type produced here. Keeping the two
//   apart is what lets a regulation change be a data change.
//
//   Timesheet, Attendance, and the future Payroll Calculation Engine must all
//   call classifyDay(). Three copies of this logic would drift into three
//   different answers about the same date, and payroll would disagree with
//   itself. Nothing else may re-derive a day type.
//
// RESOLUTION CHAIN (as specified):
//   employee -> payroll assignment -> work calendar -> work pattern
//     -> weekly rest day -> holiday master -> specific date -> classification

const DAY_TYPE = {
  WORKDAY: 'WORKDAY',
  WEEKLY_REST_DAY: 'WEEKLY_REST_DAY',
  PUBLIC_HOLIDAY: 'PUBLIC_HOLIDAY',
  // Extension points. Adding a kind here plus a row in holidays.holiday_type
  // is sufficient — no branching logic below needs to change.
  COMPANY_HOLIDAY: 'COMPANY_HOLIDAY',
  SUBSTITUTED_HOLIDAY: 'SUBSTITUTED_HOLIDAY',
};

// Deterministic precedence, highest first. A date matching several rules
// resolves to the FIRST match in this list, always, for every employee.
// Rationale: a holiday is a stronger statement about a date than the weekly
// rest pattern, and a substitution is a deliberate override of both.
// NOTE: under PP 35/2021 the weekly rest day and the public holiday currently
// map to the SAME overtime band, so this ordering matters for reporting and
// for future rules that distinguish them — not for today's multipliers.
const DAY_TYPE_PRECEDENCE = [
  DAY_TYPE.SUBSTITUTED_HOLIDAY,
  DAY_TYPE.PUBLIC_HOLIDAY,
  DAY_TYPE.COMPANY_HOLIDAY,
  DAY_TYPE.WEEKLY_REST_DAY,
  DAY_TYPE.WORKDAY,
];

const CLASSIFICATION_STATUS = {
  OK: 'OK',
  MISSING_ASSIGNMENT: 'MISSING_ASSIGNMENT',
  MISSING_WORK_PATTERN: 'MISSING_WORK_PATTERN',
  AMBIGUOUS_CALENDAR: 'AMBIGUOUS_CALENDAR',
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
};

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Weekday name for an ISO date, UTC-safe (no local-timezone drift). */
function weekdayOf(date) {
  return WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/**
 * Which calendar governs this employee on this date?
 * Most specific wins: the assignment's explicit calendar, then a calendar
 * scoped to the employee's legal entity, then the global calendar.
 * Returns { calendar, status } — status flags a genuinely ambiguous setup
 * rather than silently picking one.
 */
async function resolveCalendar(db, employeeId, date) {
  const assignment = await db.prepare(`
    SELECT * FROM employee_payroll_assignments
    WHERE employee_id = ? AND effective_date <= ? AND (end_date IS NULL OR end_date >= ?)
    ORDER BY effective_date DESC LIMIT 1
  `).get(employeeId, date, date);

  if (!assignment) return { calendar: null, assignment: null, status: CLASSIFICATION_STATUS.MISSING_ASSIGNMENT };

  // 1. explicit calendar on the assignment
  if (assignment.work_calendar_id) {
    const explicit = await db.prepare(`
      SELECT * FROM work_calendars
      WHERE id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    `).get(assignment.work_calendar_id, date, date);
    if (explicit) return { calendar: explicit, assignment, status: CLASSIFICATION_STATUS.OK };
    // Pointed at a calendar that isn't in force on this date — do not guess.
    return { calendar: null, assignment, status: CLASSIFICATION_STATUS.AMBIGUOUS_CALENDAR };
  }

  // 2. calendar scoped to the employee's legal entity
  const entityScoped = await db.prepare(`
    SELECT * FROM work_calendars
    WHERE legal_entity_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC
  `).all(assignment.legal_entity_id, date, date);
  if (entityScoped.length === 1) return { calendar: entityScoped[0], assignment, status: CLASSIFICATION_STATUS.OK };
  if (entityScoped.length > 1) return { calendar: null, assignment, status: CLASSIFICATION_STATUS.AMBIGUOUS_CALENDAR };

  // 3. global calendar (no entity, no project)
  const global = await db.prepare(`
    SELECT * FROM work_calendars
    WHERE legal_entity_id IS NULL AND project_code IS NULL
      AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC
  `).all(date, date);
  if (global.length === 1) return { calendar: global[0], assignment, status: CLASSIFICATION_STATUS.OK };
  if (global.length > 1) return { calendar: null, assignment, status: CLASSIFICATION_STATUS.AMBIGUOUS_CALENDAR };

  // No calendar at all is not an error: holidays with work_calendar_id NULL
  // still apply, and the work pattern still determines the rest day.
  return { calendar: null, assignment, status: CLASSIFICATION_STATUS.OK };
}

/** Active holidays covering this date for this calendar (or calendar-agnostic). */
async function findHolidays(db, date, calendarId, projectCode) {
  return await db.prepare(`
    SELECT * FROM holidays
    WHERE date = ? AND is_active = 1
      AND (work_calendar_id IS NULL OR work_calendar_id = ?)
      AND (scope != 'project' OR project_code IS NULL OR project_code = ?)
  `).all(date, calendarId ?? -1, projectCode ?? null);
}

/**
 * Classify one date for one employee.
 *
 * @returns {{
 *   date: string, employeeId: string,
 *   dayType: string|null, status: string, reason: string|null,
 *   source: string|null, calendarId: number|null, workPatternId: number|null,
 *   daysPerWeek: number|null, weeklyRestDay: string|null, matchedHolidays: object[]
 * }}
 * dayType is null whenever status !== OK — the caller must treat that as an
 * exception to surface, never as "probably a workday".
 */
async function classifyDay(db, employeeId, date) {
  const base = {
    date, employeeId, dayType: null, status: CLASSIFICATION_STATUS.OK, reason: null,
    source: null, calendarId: null, workPatternId: null,
    daysPerWeek: null, weeklyRestDay: null, matchedHolidays: [],
  };

  const employee = await db.prepare('SELECT id, project_code FROM employees WHERE id = ?').get(employeeId);
  if (!employee) {
    return { ...base, status: CLASSIFICATION_STATUS.EMPLOYEE_NOT_FOUND, reason: 'Karyawan tidak ditemukan.' };
  }

  const { calendar, assignment, status } = await resolveCalendar(db, employeeId, date);
  if (status !== CLASSIFICATION_STATUS.OK) {
    return {
      ...base,
      status,
      reason: status === CLASSIFICATION_STATUS.MISSING_ASSIGNMENT
        ? 'Tidak ada payroll assignment yang berlaku pada tanggal ini.'
        : 'Konfigurasi kalender kerja ambigu atau tidak berlaku pada tanggal ini.',
      calendarId: calendar ? calendar.id : null,
    };
  }

  const pattern = await db.prepare('SELECT * FROM work_patterns WHERE id = ?').get(assignment.work_pattern_id);
  if (!pattern) {
    return { ...base, status: CLASSIFICATION_STATUS.MISSING_WORK_PATTERN, reason: 'Pola kerja tidak ditemukan.' };
  }

  const calendarId = calendar ? calendar.id : null;
  // Project scope: a calendar bound to a project wins; otherwise fall back to
  // the employee's own project, so a project-scoped holiday still applies to
  // employees on a calendar that is not itself project-bound.
  const projectScope = (calendar && calendar.project_code) ? calendar.project_code : employee.project_code;
  const holidays = await findHolidays(db, date, calendarId, projectScope);

  // Collect every day type this date qualifies for, then apply precedence.
  const candidates = [];
  for (const h of holidays) candidates.push({ dayType: h.holiday_type, source: `holiday:${h.id}`, holiday: h });
  if (weekdayOf(date) === pattern.weekly_rest_day) {
    candidates.push({ dayType: DAY_TYPE.WEEKLY_REST_DAY, source: `work_pattern:${pattern.id}` });
  }
  candidates.push({ dayType: DAY_TYPE.WORKDAY, source: `work_pattern:${pattern.id}` });

  const winner = DAY_TYPE_PRECEDENCE
    .map((t) => candidates.find((c) => c.dayType === t))
    .find(Boolean);

  return {
    ...base,
    dayType: winner.dayType,
    source: winner.source,
    calendarId,
    workPatternId: pattern.id,
    daysPerWeek: pattern.days_per_week,
    weeklyRestDay: pattern.weekly_rest_day,
    matchedHolidays: holidays.map((h) => ({ id: h.id, name: h.name, holiday_type: h.holiday_type })),
  };
}

/**
 * Map a classification to the day_type key used by overtime_multiplier_rules.
 *
 * This is a MAPPING, not a rule: it contains no multiplier values and makes
 * no judgement about what a day is worth. It exists so the mapping lives in
 * exactly one place instead of being re-derived by every caller. Which
 * multiplier applies to the returned key is decided entirely by the
 * configured rows in overtime_multiplier_rules.
 *
 * Returns null when the classification failed — the caller must raise an
 * exception rather than fall back to a default band.
 */
function resolveOvertimeRuleDayType(classification) {
  if (!classification || classification.status !== CLASSIFICATION_STATUS.OK) return null;
  if (classification.dayType === DAY_TYPE.WORKDAY) return 'workday';
  // Every non-workday classification (rest day, public/company/substituted
  // holiday) currently shares the rest-or-holiday band, split by work pattern.
  return classification.daysPerWeek === 6 ? 'rest_or_holiday_6day' : 'rest_or_holiday_5day';
}

/** Classify a whole range. Used for period views and validation sweeps. */
async function classifyRange(db, employeeId, startDate, endDate) {
  const { eachDate } = require('./employeeEligibility');
  const out = [];
  for (const date of eachDate(startDate, endDate)) out.push(await classifyDay(db, employeeId, date));
  return out;
}

/** The snapshot fields a timesheet row stores. Written server-side only. */
function toSnapshot(classification) {
  return {
    day_type: classification.status === CLASSIFICATION_STATUS.OK ? classification.dayType : null,
    day_type_source: classification.status === CLASSIFICATION_STATUS.OK ? classification.source : classification.status,
    day_type_calendar_id: classification.calendarId,
    day_type_pattern_id: classification.workPatternId,
    day_classified_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
}

module.exports = {
  DAY_TYPE,
  DAY_TYPE_PRECEDENCE,
  CLASSIFICATION_STATUS,
  weekdayOf,
  resolveCalendar,
  classifyDay,
  classifyRange,
  resolveOvertimeRuleDayType,
  toSnapshot,
};
