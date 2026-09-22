// database/attendance-schedule-schema.js
// Attendance A2 — configurable Work Schedule / Shift / Work Pattern model.
//
// RULES (unchanged from A1, see docs/ATTENDANCE_ARCHITECTURE.md):
//  - ADDITIVE ONLY. No payroll-consumed column is renamed, dropped or re-typed.
//  - The legacy `work_patterns` table stays exactly as payroll knows it
//    (days_per_week + weekly_rest_day, read by the FROZEN
//    lib/dayClassification.js). A2 patterns live in their own tables and are
//    resolved by lib/workSchedule.js; nothing here re-implements day typing.
//  - Nothing in these tables holds money. Times and minutes only.
//
// Naming: the A2 tables are prefixed `attendance_` so they can never be
// confused with the payroll-owned `work_patterns` / `work_calendars`.

const A2_TIMESHEET_COLUMNS = [
  // Resolved expectation, SNAPSHOTTED on the row at record time so a later
  // schedule change cannot re-interpret history (same discipline as day_type).
  ['work_schedule_id', 'INTEGER'],
  ['work_pattern_def_id', 'INTEGER'],
  ['schedule_code', 'TEXT'],
  ['scheduled_clock_in', 'TEXT'],
  ['scheduled_clock_out', 'TEXT'],
  ['scheduled_minutes', 'INTEGER'],
  ['schedule_cross_midnight', 'INTEGER'],
  ['break_minutes_unpaid', 'INTEGER'],
  ['break_minutes_paid', 'INTEGER'],
  ['day_status', 'TEXT'],              // WORK | OFF, from the A2 pattern engine
  ['schedule_source', 'TEXT'],         // which layer decided (override/roster/pattern/...)
  ['overtime_eligible_from', 'TEXT'],  // resolved HH:MM (may be > shift end)
  ['clock_out_date', 'TEXT'],          // actual end date; differs on a night shift
  ['elapsed_minutes', 'INTEGER'],      // actual clock-out minus clock-in
  ['late_minutes', 'INTEGER'],
  ['early_leave_minutes', 'INTEGER'],
  ['worked_after_shift_minutes', 'INTEGER'], // actual time past OT eligibility, NOT payable
  ['schedule_snapshot', 'TEXT'],       // JSON: the whole resolved expectation
];

function ensureAttendanceScheduleSchema(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(timesheet_entries)').all().map((c) => c.name));
  for (const [name, type] of A2_TIMESHEET_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE timesheet_entries ADD COLUMN ${name} ${type}`);
  }

  db.exec(`
    -- ---- Work Schedule / Shift master (effective-dated versions) -------------
    CREATE TABLE IF NOT EXISTS work_schedules (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      code                 TEXT NOT NULL,
      name                 TEXT NOT NULL,
      legal_entity_id      TEXT REFERENCES legal_entities(id),
      project_code         TEXT REFERENCES projects(code),
      schedule_type        TEXT NOT NULL DEFAULT 'CUSTOM',   -- free label: OFFICE/SITE/SECURITY/...
      clock_in             TEXT NOT NULL,                    -- HH:MM
      clock_out            TEXT NOT NULL,                    -- HH:MM (may be < clock_in)
      standard_work_minutes INTEGER NOT NULL,                -- configured expectation
      cross_midnight       INTEGER NOT NULL DEFAULT 0,
      overtime_eligibility_rule TEXT NOT NULL DEFAULT 'AFTER_SHIFT_END'
                             CHECK (overtime_eligibility_rule IN ('AFTER_SHIFT_END','AFTER_DELAY','FIXED_TIME','NOT_ELIGIBLE')),
      overtime_delay_minutes INTEGER NOT NULL DEFAULT 0,     -- for AFTER_DELAY
      overtime_eligible_from TEXT,                           -- for FIXED_TIME (HH:MM)
      status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      effective_from       TEXT NOT NULL,
      effective_to         TEXT,
      note                 TEXT,
      created_by           TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now')),
      updated_by           TEXT, updated_by_user_id INTEGER, updated_at TEXT DEFAULT (datetime('now'))
    );
    -- One OPEN version per code per scope. Two indexes because SQLite treats
    -- NULLs as distinct in a table-level UNIQUE (the Phase 1A / holiday trap).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_schedule_open_scoped
      ON work_schedules(code, legal_entity_id) WHERE effective_to IS NULL AND legal_entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_schedule_open_global
      ON work_schedules(code) WHERE effective_to IS NULL AND legal_entity_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_work_schedule_code ON work_schedules(code, effective_from);

    -- ---- Scheduled breaks: ZERO, ONE or MANY per schedule version -----------
    -- SCHEDULED breaks only. Actual break punches will be a separate event
    -- table (attendance_break_events) so the schedule model need not change.
    CREATE TABLE IF NOT EXISTS work_schedule_breaks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      work_schedule_id   INTEGER NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      start_time         TEXT,                 -- HH:MM (optional: a floating break)
      end_time           TEXT,
      duration_minutes   INTEGER NOT NULL,
      is_paid            INTEGER NOT NULL DEFAULT 0,
      sequence           INTEGER NOT NULL DEFAULT 1,
      is_active          INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_break ON work_schedule_breaks(work_schedule_id, sequence);

    -- ---- Work pattern definitions (A2) --------------------------------------
    -- pattern_type is the ONLY enum: the shapes (5/2, 6/1, 4/2, 14/7, 21/7,
    -- 2D/2N/2OFF, ...) are DATA in attendance_pattern_days, never enum values.
    CREATE TABLE IF NOT EXISTS attendance_work_patterns (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      code               TEXT NOT NULL,
      name               TEXT NOT NULL,
      legal_entity_id    TEXT REFERENCES legal_entities(id),
      project_code       TEXT REFERENCES projects(code),
      pattern_type       TEXT NOT NULL CHECK (pattern_type IN
                           ('FIXED_WEEKLY','CUSTOM_WEEKLY','ROTATING_CYCLE','DATE_BASED_ROSTER')),
      cycle_length_days  INTEGER,              -- ROTATING_CYCLE
      cycle_start_date   TEXT,                 -- ROTATING_CYCLE anchor; never guessed
      repeats            INTEGER NOT NULL DEFAULT 1,
      default_schedule_id INTEGER REFERENCES work_schedules(id),
      status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      effective_from     TEXT NOT NULL,
      effective_to       TEXT,
      note               TEXT,
      created_by         TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now')),
      updated_by         TEXT, updated_by_user_id INTEGER, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_pattern_open_scoped
      ON attendance_work_patterns(code, legal_entity_id) WHERE effective_to IS NULL AND legal_entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_pattern_open_global
      ON attendance_work_patterns(code) WHERE effective_to IS NULL AND legal_entity_id IS NULL;

    -- One row per day slot. day_index is 1..7 (1 = Monday) for weekly
    -- patterns, or 1..cycle_length_days for a rotating cycle. Each day carries
    -- its OWN schedule, so Friday can be a night shift and Saturday a short one.
    CREATE TABLE IF NOT EXISTS attendance_pattern_days (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_id         INTEGER NOT NULL REFERENCES attendance_work_patterns(id) ON DELETE CASCADE,
      day_index          INTEGER NOT NULL,
      day_status         TEXT NOT NULL CHECK (day_status IN ('WORK','OFF')),
      work_schedule_id   INTEGER REFERENCES work_schedules(id),
      note               TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pattern_day ON attendance_pattern_days(pattern_id, day_index);

    -- ---- DATE_BASED_ROSTER: explicit per-date assignment --------------------
    CREATE TABLE IF NOT EXISTS attendance_roster_dates (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_id         INTEGER REFERENCES attendance_work_patterns(id) ON DELETE CASCADE,
      employee_id        TEXT REFERENCES employees(id) ON DELETE CASCADE,
      work_date          TEXT NOT NULL,
      day_status         TEXT NOT NULL CHECK (day_status IN ('WORK','OFF')),
      work_schedule_id   INTEGER REFERENCES work_schedules(id),
      note               TEXT,
      created_by         TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_date_pattern
      ON attendance_roster_dates(pattern_id, work_date) WHERE pattern_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_date_employee
      ON attendance_roster_dates(employee_id, work_date) WHERE employee_id IS NOT NULL;

    -- ---- Date override / roster exception -----------------------------------
    -- An explicit, audited exception. It NEVER rewrites the base pattern, and
    -- it never changes the day TYPE (a holiday stays a holiday: see
    -- docs/ATTENDANCE_ARCHITECTURE.md precedence).
    CREATE TABLE IF NOT EXISTS attendance_date_overrides (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id        TEXT REFERENCES employees(id) ON DELETE CASCADE,
      pattern_id         INTEGER REFERENCES attendance_work_patterns(id) ON DELETE CASCADE,
      legal_entity_id    TEXT REFERENCES legal_entities(id),
      work_date          TEXT NOT NULL,
      override_status    TEXT NOT NULL CHECK (override_status IN ('WORK','OFF')),
      work_schedule_id   INTEGER REFERENCES work_schedules(id),
      reason             TEXT NOT NULL,
      is_active          INTEGER NOT NULL DEFAULT 1,
      created_by         TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_override_employee_date
      ON attendance_date_overrides(employee_id, work_date) WHERE employee_id IS NOT NULL AND is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_override_pattern_date
      ON attendance_date_overrides(pattern_id, work_date) WHERE employee_id IS NULL AND pattern_id IS NOT NULL AND is_active = 1;

    -- ---- Employee schedule / pattern assignment (effective-dated) -----------
    -- Separate from employee_payroll_assignments: that one answers "which
    -- payroll regime"; this one answers "which working rhythm". Overlaps are
    -- rejected by the service layer (SQLite cannot express range exclusion).
    CREATE TABLE IF NOT EXISTS attendance_schedule_assignments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id        TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      legal_entity_id    TEXT NOT NULL REFERENCES legal_entities(id),
      pattern_id         INTEGER REFERENCES attendance_work_patterns(id),
      work_schedule_id   INTEGER REFERENCES work_schedules(id),   -- default shift override
      project_code       TEXT REFERENCES projects(code),
      workfront          TEXT,
      effective_from     TEXT NOT NULL,
      effective_to       TEXT,
      note               TEXT,
      created_by         TEXT, created_by_user_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_assignment_open
      ON attendance_schedule_assignments(employee_id) WHERE effective_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attendance_assignment_emp
      ON attendance_schedule_assignments(employee_id, effective_from);

    -- Historical immutability: a schedule version already referenced by a
    -- timesheet row cannot have its TIMES changed. Correcting a schedule means
    -- a NEW version (close the old one), exactly as payroll configuration does.
    CREATE TRIGGER IF NOT EXISTS trg_work_schedule_used_is_immutable
    BEFORE UPDATE ON work_schedules
    WHEN EXISTS (SELECT 1 FROM timesheet_entries t WHERE t.work_schedule_id = OLD.id)
      AND (NEW.clock_in IS NOT OLD.clock_in OR NEW.clock_out IS NOT OLD.clock_out
        OR NEW.standard_work_minutes IS NOT OLD.standard_work_minutes
        OR NEW.cross_midnight IS NOT OLD.cross_midnight
        OR NEW.overtime_eligibility_rule IS NOT OLD.overtime_eligibility_rule
        OR NEW.overtime_delay_minutes IS NOT OLD.overtime_delay_minutes
        OR NEW.overtime_eligible_from IS NOT OLD.overtime_eligible_from
        OR NEW.effective_from IS NOT OLD.effective_from)
    BEGIN
      SELECT RAISE(ABORT, 'SCHEDULE_VERSION_IN_USE: this schedule version is referenced by attendance; create a new version instead');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_schedule_break_immutable
    BEFORE UPDATE ON work_schedule_breaks
    WHEN EXISTS (SELECT 1 FROM timesheet_entries t WHERE t.work_schedule_id = OLD.work_schedule_id)
      AND (NEW.duration_minutes IS NOT OLD.duration_minutes OR NEW.is_paid IS NOT OLD.is_paid
        OR NEW.start_time IS NOT OLD.start_time OR NEW.end_time IS NOT OLD.end_time)
    BEGIN
      SELECT RAISE(ABORT, 'SCHEDULE_VERSION_IN_USE: breaks of a schedule already used by attendance are immutable');
    END;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roster_dates_date ON attendance_roster_dates(work_date);
    CREATE INDEX IF NOT EXISTS idx_overrides_date ON attendance_date_overrides(work_date);
  `);
}

module.exports = { ensureAttendanceScheduleSchema, A2_TIMESHEET_COLUMNS };
