// database/attendance-schema.js
// Attendance Hardening A1 — additive, idempotent schema for Timesheet & Absensi.
//
// RULES (see docs/ATTENDANCE_ARCHITECTURE.md):
//  - ADDITIVE ONLY. No payroll-consumed column of timesheet_entries is renamed,
//    dropped or re-typed. Every new column is NULLable, so the Payroll Core's
//    direct INSERTs (tests + resolver reads) keep working unchanged.
//  - No payroll table is altered. Payroll tables are only READ by the trigger
//    below (payroll_input_snapshots / payroll_periods).
//  - Called at the end of initDb(), so fresh databases, test databases and
//    upgraded databases all converge on the same shape.

const A1_COLUMNS = [
  // Legal entity the row belonged to ON ITS WORK DATE (from the payroll
  // assignment in force that day). Snapshotted so read scope is a plain,
  // indexed SQL predicate and never depends on today's assignment.
  ['legal_entity_id', 'TEXT'],
  // Where the record came from. A1 writes MANUAL only; device sources are
  // reserved (see ATTENDANCE_SOURCES) and never accepted from the client.
  ['entry_source', 'TEXT'],
  // Stable identity. The legacy *_by columns stay as human-readable labels;
  // every security decision uses these integer user ids instead.
  ['recorded_by_user_id', 'INTEGER'],
  ['updated_by_user_id', 'INTEGER'],
  ['overtime_requested_by_user_id', 'INTEGER'],
  ['overtime_requested_at', 'TEXT'],
  ['overtime_decided_by_user_id', 'INTEGER'],
];

// Columns whose value reaches the payroll snapshot (lib/asOfResolver.js reads
// id, work_date, day_type, day_type_source, shift, work_minutes,
// overtime_minutes_approved, overtime_status, attendance_status) plus their
// direct inputs. A change to any of these under a FROZEN snapshot is refused
// by the database itself. Metadata (note, workfront, the A1 identity columns)
// stays writable so a backfill never trips the lock.
const PAYROLL_SOURCE_COLUMNS = [
  'employee_id', 'work_date', 'shift', 'clock_in', 'clock_out',
  'work_hours', 'work_minutes', 'attendance_status',
  'overtime_status', 'overtime_minutes_requested', 'overtime_minutes_approved',
  'overtime_hours_requested', 'overtime_hours_approved',
  'day_type', 'day_type_source',
];

const frozenCovers = (alias) => `EXISTS (
      SELECT 1 FROM payroll_input_snapshots s
      JOIN payroll_periods p ON p.id = s.payroll_period_id
      WHERE s.employee_id = ${alias}.employee_id AND s.status = 'FROZEN'
        AND p.period_start <= ${alias}.work_date AND p.period_end >= ${alias}.work_date)`;

function ensureAttendanceSchema(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(timesheet_entries)').all().map((c) => c.name));
  for (const [name, type] of A1_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE timesheet_entries ADD COLUMN ${name} ${type}`);
  }

  const changed = PAYROLL_SOURCE_COLUMNS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timesheet_entity_date ON timesheet_entries(legal_entity_id, work_date);

    -- Append-only attendance audit trail. Every create / update / overtime
    -- request / decision is one row, with old and new values. Decisions are
    -- therefore never "overwritten": the entry holds the current state, this
    -- table holds how it got there. No FK to timesheet_entries on purpose —
    -- the trail must outlive the row it describes.
    CREATE TABLE IF NOT EXISTS attendance_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      timesheet_entry_id  INTEGER,
      employee_id         TEXT NOT NULL,
      work_date           TEXT NOT NULL,
      legal_entity_id     TEXT,
      event_type          TEXT NOT NULL,
      actor_user_id       INTEGER,
      actor_name          TEXT,
      source              TEXT,
      old_values          TEXT,
      new_values          TEXT,
      reason              TEXT,
      occurred_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_events_entry ON attendance_events(timesheet_entry_id, id);
    CREATE INDEX IF NOT EXISTS idx_attendance_events_entity ON attendance_events(legal_entity_id, work_date);

    CREATE TRIGGER IF NOT EXISTS trg_attendance_events_no_update
    BEFORE UPDATE ON attendance_events
    BEGIN SELECT RAISE(ABORT, 'ATTENDANCE_EVENT_IMMUTABLE: attendance audit events are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attendance_events_no_delete
    BEFORE DELETE ON attendance_events
    BEGIN SELECT RAISE(ABORT, 'ATTENDANCE_EVENT_IMMUTABLE: attendance audit events are append-only'); END;

    -- Payroll-source attendance under a FROZEN payroll snapshot is immutable.
    -- Defence in depth behind the route guard: raw SQL is refused too.
    CREATE TRIGGER IF NOT EXISTS trg_attendance_frozen_update
    BEFORE UPDATE ON timesheet_entries
    WHEN (${frozenCovers('OLD')} OR ${frozenCovers('NEW')}) AND (${changed})
    BEGIN SELECT RAISE(ABORT, 'ATTENDANCE_SOURCE_FROZEN: attendance consumed by a frozen payroll snapshot cannot change'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attendance_frozen_delete
    BEFORE DELETE ON timesheet_entries
    WHEN ${frozenCovers('OLD')}
    BEGIN SELECT RAISE(ABORT, 'ATTENDANCE_SOURCE_FROZEN: attendance consumed by a frozen payroll snapshot cannot be deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attendance_frozen_insert
    BEFORE INSERT ON timesheet_entries
    WHEN ${frozenCovers('NEW')}
    BEGIN SELECT RAISE(ABORT, 'ATTENDANCE_SOURCE_FROZEN: cannot add attendance to a frozen payroll snapshot'); END;
  `);

  // Idempotent backfill of the entity snapshot for rows written before A1.
  // Resolved AS OF THE WORK DATE, never from the latest assignment. Rows with
  // no covering assignment stay NULL (visible only via the audited override)
  // rather than being guessed into an entity.
  db.exec(`
    UPDATE timesheet_entries SET legal_entity_id = (
      SELECT a.legal_entity_id FROM employee_payroll_assignments a
      WHERE a.employee_id = timesheet_entries.employee_id
        AND a.effective_date <= timesheet_entries.work_date
        AND (a.end_date IS NULL OR a.end_date >= timesheet_entries.work_date)
      ORDER BY a.effective_date DESC LIMIT 1)
    WHERE legal_entity_id IS NULL;
  `);
}

module.exports = { ensureAttendanceSchema, A1_COLUMNS, PAYROLL_SOURCE_COLUMNS };
