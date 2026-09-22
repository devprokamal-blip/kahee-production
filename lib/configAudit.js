// lib/configAudit.js
// Generic audit trail for the 8 Payroll Configuration domains (and any
// future config domain). Each domain's routes call this instead of writing
// their own audit table, so every config change is traceable the same way:
// who changed it, when, and the before/after snapshot.

/**
 * @param {object} db - an OPEN canonical database handle (database/db.js); caller owns it (does not close here)
 * @param {{domain: string, recordId: string|number, action: 'create'|'update'|'delete', changedBy: string, oldValue?: object|null, newValue?: object|null}} entry
 */
async function logConfigChange(db, { domain, recordId, action, changedBy, oldValue = null, newValue = null }) {
  await db.prepare(`
    INSERT INTO config_audit_log (domain, record_id, action, changed_by, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    domain,
    String(recordId),
    action,
    changedBy,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null
  );
}

/** Fetch the audit history for one record, newest first. */
async function getConfigHistory(db, domain, recordId) {
  return await db.prepare(`
    SELECT * FROM config_audit_log WHERE domain = ? AND record_id = ? ORDER BY changed_at DESC
  `).all(domain, String(recordId));
}

module.exports = { logConfigChange, getConfigHistory };
