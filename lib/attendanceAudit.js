// lib/attendanceAudit.js
// Attendance A3 — append-only audit writing and reading.
//
// There is ONE audit trail: A1's `attendance_events` (protected by
// trg_attendance_events_no_update / _no_delete). A3 widens it with the context
// an investigator needs — role snapshot, permission used, target, result,
// delta — instead of starting a second, competing log.
//
// ROLE SNAPSHOT: the actor's authority is stored AS IT WAS. If Rudi approves a
// correction as Workforce Manager in 2026 and becomes Operations Director in
// 2027, the 2026 event must still read "Workforce Manager".

const EVENTS = {
  CORRECTION_CREATED: 'CORRECTION_CREATED',
  CORRECTION_SUBMITTED: 'CORRECTION_SUBMITTED',
  CORRECTION_REVIEWED: 'CORRECTION_REVIEWED',
  CORRECTION_APPROVED: 'CORRECTION_APPROVED',
  CORRECTION_REJECTED: 'CORRECTION_REJECTED',
  CORRECTION_CANCELLED: 'CORRECTION_CANCELLED',
  CORRECTION_APPLIED: 'CORRECTION_APPLIED',
  CORRECTION_REVERSED: 'CORRECTION_REVERSED',
  LATE_CORRECTION_APPROVED: 'LATE_CORRECTION_APPROVED',
  VOID_REQUESTED: 'VOID_REQUESTED',
  VOID_REVIEWED: 'VOID_REVIEWED',
  VOID_APPROVED: 'VOID_APPROVED',
  VOID_REJECTED: 'VOID_REJECTED',
  ENTRY_VOIDED: 'ENTRY_VOIDED',
  ENTRY_VERSION_SUPERSEDED: 'ENTRY_VERSION_SUPERSEDED',
  EXCEPTION_CREATED: 'EXCEPTION_CREATED',
  EXCEPTION_ASSIGNED: 'EXCEPTION_ASSIGNED',
  EXCEPTION_RESOLVED: 'EXCEPTION_RESOLVED',
  EXCEPTION_REOPENED: 'EXCEPTION_REOPENED',
  PAYROLL_IMPACT_DETECTED: 'PAYROLL_IMPACT_DETECTED',
  PAYROLL_REVIEW_REQUESTED: 'PAYROLL_REVIEW_REQUESTED',
  PAYROLL_IMPACT_APPROVED: 'PAYROLL_IMPACT_APPROVED',
  PAYROLL_IMPACT_REJECTED: 'PAYROLL_IMPACT_REJECTED',
  PAYROLL_ADJUSTMENT_QUEUED: 'PAYROLL_ADJUSTMENT_QUEUED',
  SENSITIVE_OVERRIDE_USED: 'SENSITIVE_OVERRIDE_USED',
};

/** The actor's authority as it is RIGHT NOW — stored, then never updated. */
function roleSnapshot(userContext) {
  if (!userContext) return null;
  if (Array.isArray(userContext.roleNames) && userContext.roleNames.length) return userContext.roleNames.join(', ');
  if (Array.isArray(userContext.roles) && userContext.roles.length) {
    return userContext.roles.map((r) => (typeof r === 'string' ? r : (r.name || r.code))).join(', ');
  }
  return userContext.roleName || userContext.role || null;
}

function entityScopeSnapshot(userContext) {
  const scope = userContext && (userContext.entityScope || userContext.legalEntityScope);
  return Array.isArray(scope) ? scope.join(',') : (scope || null);
}

/**
 * Append one audit event. Never updates, never deletes — reversing a decision
 * means appending CORRECTION_REVERSED, not erasing CORRECTION_APPROVED.
 */
async function record(db, {
  entryId = null, employeeId, workDate, legalEntityId = null, eventType, user,
  source = null, oldValues = null, newValues = null, delta = null, reason = null, reasonCode = null,
  permission = null, targetType = null, targetId = null, correctionId = null, exceptionId = null,
  result = null,
}) {
  await db.prepare(`INSERT INTO attendance_events (
      timesheet_entry_id, employee_id, work_date, legal_entity_id, event_type,
      actor_user_id, actor_name, source, old_values, new_values, reason,
      actor_role_snapshot, actor_entity_scope, permission_used, target_type, target_id,
      correction_id, exception_id, reason_code, result, delta_values
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    entryId, employeeId, workDate, legalEntityId, eventType,
    user ? user.id : null, user ? user.displayName : null, source,
    oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, reason,
    roleSnapshot(user), entityScopeSnapshot(user), permission, targetType, targetId,
    correctionId, exceptionId, reasonCode, result, delta ? JSON.stringify(delta) : null,
  );
}

/** One step of a workflow, for the approval-history view. Append-only. */
async function recordAction(db, correctionId, { action, result = null, user, permission = null,
  reasonCode = null, reason = null, fromStatus = null, toStatus = null }) {
  await db.prepare(`INSERT INTO attendance_correction_actions
    (correction_id, action, result, actor_user_id, actor_name, actor_role, permission_used,
     reason_code, reason, from_status, to_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    correctionId, action, result, user ? user.id : null, user ? user.displayName : null,
    roleSnapshot(user), permission, reasonCode, reason, fromStatus, toStatus);
}

module.exports = { EVENTS, record, recordAction, roleSnapshot, entityScopeSnapshot };
