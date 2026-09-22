// database/attendance-correction-schema.js
// Attendance A3 — correction, void, exception, payroll impact and immutable audit.
//
// RULES (unchanged from A1/A2):
//  - ADDITIVE ONLY. No payroll-consumed column renamed, dropped or re-typed.
//  - Nothing here holds money. Attendance records TIME deltas; the FROZEN
//    Payroll Core turns a delta into rupiah (see docs/ATTENDANCE_ARCHITECTURE.md).
//  - `timesheet_entries` keeps a UNIQUE(employee_id, work_date) — that is a
//    payroll invariant, so a corrected day CANNOT become a second row. The
//    version chain therefore lives in its own append-only table
//    (`attendance_entry_versions`): v1 is the original snapshot, every approved
//    correction appends the next version, and the timesheet row carries only
//    the EFFECTIVE values payroll reads.

const A3_TIMESHEET_COLUMNS = [
  ['record_status', "TEXT"],          // EFFECTIVE | VOIDED  (never deleted)
  ['current_version', 'INTEGER'],     // matches attendance_entry_versions.version_no
  ['last_correction_id', 'INTEGER'],
  ['void_correction_id', 'INTEGER'],
];

function ensureAttendanceCorrectionSchema(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(timesheet_entries)').all().map((c) => c.name));
  for (const [name, type] of A3_TIMESHEET_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE timesheet_entries ADD COLUMN ${name} ${type}`);
  }
  // A1's attendance_events is the canonical append-only audit trail; A3 widens
  // it rather than creating a second, competing audit system.
  const evCols = new Set(db.prepare('PRAGMA table_info(attendance_events)').all().map((c) => c.name));
  for (const [name, type] of [
    ['actor_role_snapshot', 'TEXT'],     // authority AT THE TIME of the action
    ['actor_entity_scope', 'TEXT'],
    ['permission_used', 'TEXT'],
    ['target_type', 'TEXT'],
    ['target_id', 'INTEGER'],
    ['correction_id', 'INTEGER'],
    ['exception_id', 'INTEGER'],
    ['reason_code', 'TEXT'],
    ['result', 'TEXT'],
    ['delta_values', 'TEXT'],
  ]) if (!evCols.has(name)) db.exec(`ALTER TABLE attendance_events ADD COLUMN ${name} ${type}`);

  db.exec(`
    -- ---- Correction policy (effective-dated, configurable) -------------------
    -- No correction window is hardcoded anywhere: 3/5/7 days are seed examples.
    CREATE TABLE IF NOT EXISTS attendance_correction_policies (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      code                   TEXT NOT NULL,
      name                   TEXT NOT NULL,
      legal_entity_id        TEXT REFERENCES legal_entities(id),
      project_code           TEXT REFERENCES projects(code),
      correction_window      INTEGER NOT NULL,
      window_unit            TEXT NOT NULL DEFAULT 'DAYS' CHECK (window_unit IN ('DAYS','WEEKS','MONTHS')),
      allow_late_correction  INTEGER NOT NULL DEFAULT 1,
      late_requires_approval INTEGER NOT NULL DEFAULT 1,
      evidence_requirement   TEXT NOT NULL DEFAULT 'OPTIONAL'
                               CHECK (evidence_requirement IN ('NONE','OPTIONAL','REQUIRED')),
      post_finalized_evidence_required INTEGER NOT NULL DEFAULT 1,
      additional_approval_required     INTEGER NOT NULL DEFAULT 0,
      -- Exception thresholds: relative to the RESOLVED schedule, never a
      -- hardcoded "more than 12 hours is wrong" (a 12-hour security shift is real).
      abnormal_duration_ratio_pct INTEGER NOT NULL DEFAULT 150,
      ot_grace_minutes            INTEGER NOT NULL DEFAULT 30,
      ot_mismatch_tolerance_minutes INTEGER NOT NULL DEFAULT 15,
      status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      effective_from         TEXT NOT NULL,
      effective_to           TEXT,
      note                   TEXT,
      created_by TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT, updated_by_user_id INTEGER, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_correction_policy_open_scoped
      ON attendance_correction_policies(legal_entity_id) WHERE effective_to IS NULL AND legal_entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_correction_policy_open_global
      ON attendance_correction_policies(code) WHERE effective_to IS NULL AND legal_entity_id IS NULL;

    -- ---- Correction / void requests -----------------------------------------
    CREATE TABLE IF NOT EXISTS attendance_corrections (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no         TEXT UNIQUE,
      request_type       TEXT NOT NULL CHECK (request_type IN ('CORRECTION','VOID')),
      timesheet_entry_id INTEGER REFERENCES timesheet_entries(id),
      employee_id        TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id    TEXT NOT NULL REFERENCES legal_entities(id),
      work_date          TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN (
                           'DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','CANCELLED','APPLIED','REVERSED',
                           'PENDING_PAYROLL_REVIEW','PAYROLL_REJECTED','QUEUED_FOR_PAYROLL',
                           'VOID_REQUESTED','VOID_REVIEWED','VOID_APPROVED','VOID_REJECTED','VOIDED')),
      policy_id          INTEGER REFERENCES attendance_correction_policies(id),
      policy_snapshot    TEXT,
      is_late_correction INTEGER NOT NULL DEFAULT 0,
      late_reason        TEXT,
      reason_code        TEXT NOT NULL,
      reason_text        TEXT,
      evidence_type      TEXT,
      evidence_ref       TEXT,
      evidence_note      TEXT,
      before_values      TEXT,           -- JSON snapshot of the record as found
      proposed_values    TEXT,           -- JSON: only the fields being corrected
      after_values       TEXT,           -- JSON snapshot once applied
      delta_values       TEXT,           -- JSON: TIME deltas only, never rupiah
      payroll_impact     TEXT CHECK (payroll_impact IS NULL OR payroll_impact IN
                           ('NO_PAYROLL_IMPACT','PAYROLL_IMPACT_OPEN_PERIOD',
                            'PAYROLL_IMPACT_FROZEN_PERIOD','PAYROLL_ADJUSTMENT_REQUIRED')),
      payroll_period_id  INTEGER REFERENCES payroll_periods(id),
      payroll_run_id     INTEGER REFERENCES payroll_runs(id),
      applied_to_source  INTEGER NOT NULL DEFAULT 0,
      applied_version_no INTEGER,
      requested_by_user_id INTEGER, requested_by_name TEXT, requested_by_role TEXT, requested_at TEXT,
      reviewed_by_user_id  INTEGER, reviewed_by_name TEXT, reviewed_by_role TEXT, reviewed_at TEXT,
      decided_by_user_id   INTEGER, decided_by_name TEXT, decided_by_role TEXT, decided_at TEXT,
      payroll_reviewed_by_user_id INTEGER, payroll_reviewed_by_name TEXT, payroll_reviewed_by_role TEXT,
      payroll_reviewed_at TEXT, payroll_review_result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_correction_status ON attendance_corrections(status, legal_entity_id);
    CREATE INDEX IF NOT EXISTS idx_correction_entry ON attendance_corrections(timesheet_entry_id);
    CREATE INDEX IF NOT EXISTS idx_correction_employee ON attendance_corrections(employee_id, work_date);

    -- ---- Approval history: every human step, append-only ---------------------
    CREATE TABLE IF NOT EXISTS attendance_correction_actions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_id    INTEGER NOT NULL REFERENCES attendance_corrections(id) ON DELETE CASCADE,
      action           TEXT NOT NULL,
      result           TEXT,
      actor_user_id    INTEGER,
      actor_name       TEXT,
      actor_role       TEXT,          -- role snapshot AT THE TIME of the action
      permission_used  TEXT,
      reason_code      TEXT,
      reason           TEXT,
      from_status      TEXT,
      to_status        TEXT,
      occurred_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_correction_actions ON attendance_correction_actions(correction_id, id);
    CREATE INDEX IF NOT EXISTS idx_correction_actions_actor ON attendance_correction_actions(actor_user_id, occurred_at);
    CREATE TRIGGER IF NOT EXISTS trg_correction_actions_no_update
    BEFORE UPDATE ON attendance_correction_actions BEGIN
      SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: approval history cannot be modified');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_correction_actions_no_delete
    BEFORE DELETE ON attendance_correction_actions BEGIN
      SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: approval history cannot be deleted');
    END;

    -- ---- Record version chain (append-only) ----------------------------------
    -- v1 = the record as originally written; each approved correction appends
    -- the next version. Nothing here is ever updated or deleted, so the whole
    -- history of a work day is reconstructable even after a void.
    CREATE TABLE IF NOT EXISTS attendance_entry_versions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      timesheet_entry_id INTEGER NOT NULL,
      employee_id        TEXT NOT NULL,
      work_date          TEXT NOT NULL,
      legal_entity_id    TEXT,
      version_no         INTEGER NOT NULL,
      version_type       TEXT NOT NULL CHECK (version_type IN ('ORIGINAL','CORRECTION','VOID')),
      correction_id      INTEGER REFERENCES attendance_corrections(id),
      payload            TEXT NOT NULL,      -- JSON snapshot of the record at this version
      applied_to_source  INTEGER NOT NULL DEFAULT 1,
      is_effective       INTEGER NOT NULL DEFAULT 1,
      actor_user_id      INTEGER, actor_name TEXT, actor_role TEXT,
      reason_code        TEXT, reason TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_entry_version ON attendance_entry_versions(timesheet_entry_id, version_no);
    CREATE INDEX IF NOT EXISTS idx_entry_version_emp ON attendance_entry_versions(employee_id, work_date);
    CREATE TRIGGER IF NOT EXISTS trg_entry_versions_no_update
    BEFORE UPDATE OF payload, version_no, version_type, correction_id, created_at ON attendance_entry_versions BEGIN
      SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: an attendance version snapshot cannot be modified');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_entry_versions_no_delete
    BEFORE DELETE ON attendance_entry_versions BEGIN
      SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: an attendance version snapshot cannot be deleted');
    END;

    -- ---- Exceptions ----------------------------------------------------------
    CREATE TABLE IF NOT EXISTS attendance_exceptions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      timesheet_entry_id INTEGER REFERENCES timesheet_entries(id),
      employee_id        TEXT NOT NULL,
      legal_entity_id    TEXT,
      work_date          TEXT NOT NULL,
      exception_type     TEXT NOT NULL,
      severity           TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
      status             TEXT NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN','ASSIGNED','RESOLVED','REOPENED')),
      detail             TEXT,
      correction_id      INTEGER REFERENCES attendance_corrections(id),
      assigned_to_user_id INTEGER, assigned_to_name TEXT, assigned_at TEXT,
      resolved_by_user_id INTEGER, resolved_by_name TEXT, resolved_by_role TEXT,
      resolved_at TEXT, resolution_note TEXT,
      detected_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    );
    -- One OPEN exception of a kind per record — re-scanning must not pile up duplicates.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_exception_open
      ON attendance_exceptions(employee_id, work_date, exception_type)
      WHERE status IN ('OPEN','ASSIGNED','REOPENED');
    CREATE INDEX IF NOT EXISTS idx_exception_status ON attendance_exceptions(status, legal_entity_id, work_date);

    -- ---- Payroll adjustment queue (INTERFACE, not a money engine) ------------
    -- The hand-off point to payroll. It carries TIME deltas and approvals only;
    -- the monetary payroll_adjustments row stays a PAYROLL action (frozen core).
    CREATE TABLE IF NOT EXISTS attendance_payroll_adjustments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_id       INTEGER NOT NULL REFERENCES attendance_corrections(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,
      work_date           TEXT NOT NULL,
      source_period_id    INTEGER REFERENCES payroll_periods(id),
      source_run_id       INTEGER REFERENCES payroll_runs(id),
      impact_category     TEXT NOT NULL,
      original_values     TEXT NOT NULL,     -- JSON: validated TIME before
      corrected_values    TEXT NOT NULL,     -- JSON: validated TIME after
      delta_work_minutes  INTEGER NOT NULL DEFAULT 0,
      delta_overtime_minutes INTEGER NOT NULL DEFAULT 0,
      attendance_approval_ref TEXT,
      payroll_review_status TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (payroll_review_status IN ('PENDING','APPROVED','REJECTED')),
      payroll_reviewed_by_user_id INTEGER, payroll_reviewed_by_name TEXT, payroll_reviewed_by_role TEXT,
      payroll_reviewed_at TEXT,
      queue_status        TEXT NOT NULL DEFAULT 'QUEUED'
                            CHECK (queue_status IN ('QUEUED','PROCESSED','CANCELLED')),
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_adj_queue
      ON attendance_payroll_adjustments(queue_status, legal_entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_adj_correction
      ON attendance_payroll_adjustments(correction_id);
  `);
}

module.exports = { ensureAttendanceCorrectionSchema, A3_TIMESHEET_COLUMNS };
