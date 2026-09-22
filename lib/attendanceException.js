// lib/attendanceException.js
// Attendance A3 — exception DETECTION. It never changes attendance.
//
// Every threshold comes from the correction policy or from the record's own
// resolved schedule. There is no "more than 12 hours is wrong" rule here: a
// 12-hour security shift is a real, configured schedule.

const TYPES = {
  MISSING_CLOCK_IN: 'MISSING_CLOCK_IN',
  MISSING_CLOCK_OUT: 'MISSING_CLOCK_OUT',
  NO_SCHEDULE: 'NO_SCHEDULE',
  OFF_DAY_ATTENDANCE: 'OFF_DAY_ATTENDANCE',
  DUPLICATE_ATTENDANCE: 'DUPLICATE_ATTENDANCE',
  ABNORMAL_DURATION: 'ABNORMAL_DURATION',
  OT_WITHOUT_APPROVAL: 'OT_WITHOUT_APPROVAL',
  APPROVED_OT_ACTUAL_MISMATCH: 'APPROVED_OT_ACTUAL_MISMATCH',
  LATE_CORRECTION: 'LATE_CORRECTION',
  PAYROLL_ADJUSTMENT_REQUIRED: 'PAYROLL_ADJUSTMENT_REQUIRED',
};

const SEVERITY = {
  [TYPES.MISSING_CLOCK_IN]: 'HIGH',
  [TYPES.MISSING_CLOCK_OUT]: 'HIGH',
  [TYPES.NO_SCHEDULE]: 'MEDIUM',
  [TYPES.OFF_DAY_ATTENDANCE]: 'MEDIUM',
  [TYPES.DUPLICATE_ATTENDANCE]: 'HIGH',
  [TYPES.ABNORMAL_DURATION]: 'MEDIUM',
  [TYPES.OT_WITHOUT_APPROVAL]: 'MEDIUM',
  [TYPES.APPROVED_OT_ACTUAL_MISMATCH]: 'HIGH',
  [TYPES.LATE_CORRECTION]: 'MEDIUM',
  [TYPES.PAYROLL_ADJUSTMENT_REQUIRED]: 'HIGH',
};

const WORKING_STATUSES = ['present', 'late'];

/**
 * Detect exceptions on ONE attendance row. Pure: returns findings, writes nothing.
 * @param {object} entry   a timesheet_entries row (with its A2 snapshot columns)
 * @param {object} policy  the resolved correction policy (thresholds) or null
 * @param {object} ctx     { duplicateOf: number|null }
 */
function detectForEntry(entry, policy, ctx = {}) {
  const out = [];
  const add = (type, detail) => out.push({ type, severity: SEVERITY[type] || 'MEDIUM', detail });
  const working = WORKING_STATUSES.includes(entry.attendance_status);
  if (entry.record_status === 'VOIDED') return out;

  if (working && !entry.clock_in) add(TYPES.MISSING_CLOCK_IN, { attendance_status: entry.attendance_status });
  if (working && entry.clock_in && !entry.clock_out) add(TYPES.MISSING_CLOCK_OUT, { clock_in: entry.clock_in });
  if (working && !entry.work_schedule_id) {
    add(TYPES.NO_SCHEDULE, { schedule_source: entry.schedule_source, day_status: entry.day_status });
  }
  if (working && (entry.day_status === 'OFF' || (entry.day_type && entry.day_type !== 'WORKDAY'))
      && Number(entry.work_minutes || 0) > 0) {
    add(TYPES.OFF_DAY_ATTENDANCE, { day_status: entry.day_status, day_type: entry.day_type, work_minutes: entry.work_minutes });
  }
  if (ctx.duplicateOf) {
    add(TYPES.DUPLICATE_ATTENDANCE, { overlaps_entry_id: ctx.duplicateOf, clock_out_date: entry.clock_out_date });
  }
  // Abnormal duration is RELATIVE to the resolved schedule, from policy.
  const ratio = policy ? Number(policy.abnormal_duration_ratio_pct) : 150;
  if (entry.scheduled_minutes && entry.work_minutes
      && Number(entry.work_minutes) * 100 > Number(entry.scheduled_minutes) * ratio) {
    add(TYPES.ABNORMAL_DURATION, {
      work_minutes: entry.work_minutes, scheduled_minutes: entry.scheduled_minutes, ratio_pct: ratio,
    });
  }
  const grace = policy ? Number(policy.ot_grace_minutes) : 30;
  const after = Number(entry.worked_after_shift_minutes || 0);
  if (after > grace && entry.overtime_status === 'none') {
    add(TYPES.OT_WITHOUT_APPROVAL, { worked_after_shift_minutes: after, grace_minutes: grace });
  }
  const tolerance = policy ? Number(policy.ot_mismatch_tolerance_minutes) : 15;
  if (entry.overtime_status === 'approved'
      && Math.abs(after - Number(entry.overtime_minutes_approved || 0)) > tolerance) {
    add(TYPES.APPROVED_OT_ACTUAL_MISMATCH, {
      approved_minutes: entry.overtime_minutes_approved, worked_after_shift_minutes: after, tolerance_minutes: tolerance,
    });
  }
  return out;
}

/** A cross-midnight row whose end date collides with the next day's record. */
async function findOverlap(db, entry) {
  if (!entry.clock_out_date || entry.clock_out_date === entry.work_date) return null;
  const next = await db.prepare(`SELECT id, clock_in FROM timesheet_entries
    WHERE employee_id = ? AND work_date = ? AND id != ?`).get(entry.employee_id, entry.clock_out_date, entry.id);
  if (!next || !next.clock_in || !entry.clock_out) return null;
  return next.clock_in < entry.clock_out ? next.id : null;
}

module.exports = { TYPES, SEVERITY, detectForEntry, findOverlap };
