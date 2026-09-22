# KAHE 360° INTERNAL OPERATIONS PORTAL — PROJECT CHECKPOINT

> ## STATUS BOARD (read this first)
>
> | | |
> |---|---|
> | **PAYROLL CORE STATUS** | **FROZEN / STABLE — `PAYROLL_CORE_STABLE_V1`** |
> | **PAYROLL LATEST COMPLETED PHASE** | **PHASE 3B** |
> | **PAYROLL REGRESSION BASELINE** | **545 PASS** (16 suites) |
> | **PAYROLL NEXT PHASE** | **DEFERRED** — do not start without explicit request |
> | **PORTAL DEVELOPMENT STATUS** | **ACTIVE** |
> | **CURRENT PORTAL PRIORITY** | **TIMESHEET & ATTENDANCE PRODUCTION HARDENING** |
> | **ATTENDANCE LATEST COMPLETED PHASE** | **A3 — Correction, Void, Exception, Payroll Impact & Immutable Audit (PASS, 2026-09-20)** |
> | **ATTENDANCE REGRESSION** | **193 PASS** — A1 55 + A2 83 + A3 55 (`npm run test:attendance`, real server over HTTP) |
> | **ATTENDANCE FREEZE** | **NOT declared** — further hardening phases pending |
> | **ATTENDANCE A4 (Period Control)** | **CP1 ACCEPTED AND LOCKED (2026-09-21); CP2 ACCEPTED AND LOCKED (2026-09-22)** (migrations `0006`, `0007`; CP3+ NOT STARTED) — protected regression floor **975** |
> | **A4 CP1 TESTS** | **71 PASS** (`npm run test:attendance-a4`); historical baseline stays **846** (never redefined); protected baseline **917 PASS** |
>
> The freeze covers the payroll and payroll-billing subsystem ONLY. Every other
> portal module remains in active development. The full contract — what is
> frozen, how other modules integrate with it, and what to do when a portal
> module needs a payroll change — is in **`docs/PAYROLL_CORE_FREEZE.md`**.
>
> **Before touching anything that feeds payroll** (employee assignment,
> attendance, overtime, worker services, payroll input, legal entity):
> ```
> npm run check:payroll-freeze       # has a frozen file drifted?
> npm run test:payroll-regression    # must stay at 545, zero failures
> npm run test:attendance            # attendance API suites (A1 55 + A2 83 + A3 55), zero failures
> ```
> If a portal change breaks payroll tests: **stop and report the regression.**
> Do not modify payroll or its tests to make the failure go away.
>
> **Deferred, do not start:** Invoice Generation · Billing Approval/Freeze ·
> Accounts Receivable · Tax Invoice · further payroll/billing phases.

---

_Last updated: 2026-09-20 (Attendance A3). This file exists so any session (human or AI) can
resume work without re-deriving project state from scratch. Update it
whenever a module's status changes — don't let it go stale._

## DONE — built, tested, working in this codebase

- **Phase 1** (2026-09-12): Login, Home dashboard, auth (bcryptjs +
  express-session), RBAC core (`middleware/permissions.js`), 17 static
  module-dashboard pages (mockup data, not yet functional).
- **HRD & Kontrak**: employee database (4 worker types: internal, PKWT,
  harian, subkontraktor), contract lifecycle with extend/terminate →
  approve/reject flow, document upload. Tables: `employees`,
  `employee_contract_history`, `employee_documents`. Role added:
  `hrd_officer`. Files: `routes/hrd.js`, `public/hrd-kontrak.html/.js`.
- **Timesheet & Absensi**: daily attendance (workfront, shift, clock in/out,
  work hours, status) with inline overtime request → approve/reject on the
  same row. Table: `timesheet_entries`. Files: `routes/timesheet.js`,
  `public/timesheet-absensi.html/.js`.
- **Payroll Configuration** — all 6 items below are DONE, tested via API
  (curl) and via real browser clicks (Playwright), including RBAC boundary
  checks (403s) and a full regression pass confirming HRD & Kontrak and
  Timesheet & Absensi still load and work after this module was added:
  1. Legal Entity Master (`legal_entities`) — CRUD via
     `routes/payroll-config/legal-entities.js`.
  2. JKK Risk Class rates (`jkk_risk_classes`), versioned by
     `effective_date`/`end_date`. Reprice, version history (current vs
     previous, per risk class), and audit trail (who/when/old→new) all have
     working UI in the "JKK Risk Class" tab.
  3. Payroll Rule Set (`payroll_rule_sets` + `ptkp_ter_rates` [122 PMK
     168/2023 TER brackets, categories A/B/C] + `overtime_multiplier_rules`
     [8 rows, PP 35/2021 Pasal 31: workday 1.5×/2×, rest-or-holiday 5-day
     and 6-day patterns]). Draft creation (clones current TER + overtime
     rows), full rule-set list with status, and an **Activate** button
     (supersedes the previous active rule set) — all working in the "BPJS /
     PPh21 / Lembur" tab.
  4. Holiday Calendar (`holidays`) — 25 dates seeded from the real 2026 SKB
     3 Menteri list, add/delete via UI.
  5. Work Patterns (`work_patterns`) — 5-day / 6-day week, add via UI.
  6. Employee Payroll Assignment (`employee_payroll_assignments`) — links an
     HRD & Kontrak employee to a legal entity + work pattern + PTKP status
     (marital status + dependents); TER category (A/B/C) is derived
     automatically and shown in the table.
  - Every domain writes to the shared `config_audit_log` table via
    `lib/configAudit.js` — this is the pattern for any future config
    domain, not a per-domain audit table.
  - Permission module: `payroll_config`. Payroll Officer has full
    CREATE/EDIT/EXPORT/ADMIN (ADMIN specifically gates rule-set activation
    and JKK repricing, since those affect every employee's payroll at
    once). Workforce Manager and HRD Officer have VIEW only.
  - UI: single page (`public/payroll-config.html/.js`), 6 tabs
    (`.pcfg-tabs`/`.pcfg-panel`), one generic modal form reused for every
    "+ Tambah" action across all 6 domains.
  - **This module does not calculate anything yet.** It is purely the rule
    surface the (not-yet-built) Payroll Calculation Engine will read.

## Phase 0 — Payroll Engine blocker remediation (2026-09-14) — **PASS**

Clears B3, B4, B5, B6 from `docs/PAYROLL_ENGINE_AUDIT.md`. No new features,
no engine code, no changes to areas the audit marked PASS.

- **B3 Monetary precision.** All money is integer **sen** (`*_sen`), all rates
  and multipliers are integer **basis points** (`*_bp`). New `lib/money.js` is
  the single conversion/rounding authority (half-up, symmetric for negatives).
  Converted: `employees.daily_rate_sen`,
  `employee_payroll_assignments.base_salary_sen`, `jkk_risk_classes.rate_bp`,
  all 10 `payroll_rule_sets` rate/cap columns, all 122 `ptkp_ter_rates` rows,
  all 8 `overtime_multiplier_rules` rows. APIs still accept rupiah/decimal
  from clients and convert on write, so the UI contract is unchanged.
- **B4 Transaction safety.** `withTransaction(db, fn)` added to
  `database/init-db.js`; nested calls join the outer boundary. Applied to every
  multi-statement write that existed: rule-set create (~130 rows), rule-set
  activate, JKK reprice, payroll-assignment supersession.
- **B5 Database-enforced invariants.** Four partial unique indexes replace
  application-only checks: one open assignment per employee, one active rule
  set, one open JKK version per risk class, one national holiday per date
  (the last was demonstrably violable — SQLite treats NULLs as distinct in a
  table-level UNIQUE, so `project_code IS NULL` let duplicates through).
  Constraint violations now surface as **409 CONFLICT** via the global error
  handler in `server.js`, not 500.
- **B6 Employee eligibility.** `lib/employeeEligibility.js` is now the ONLY
  answer to "is employee X payable on date Y". Adds `employees.termination_date`.
  `getEligibilityForPeriod()` returns contiguous payable segments, which is what
  the engine will prorate joiners, leavers, and mid-period changes from.
  **Nothing else may reimplement this logic.**
- **Migration.** `database/migrate-phase0.js` (`npm run migrate:phase0`)
  upgrades an existing database in place: adds new columns, converts every
  value, adds `termination_date`, creates the indexes — all in one transaction,
  idempotent, and non-destructive (old REAL columns are retained, not dropped).
  If existing data violates a new invariant the whole migration rolls back with
  a message rather than deleting rows.
- **Tests.** `tests/phase0.test.js` (`npm run test:phase0`) — 27 tests, all
  passing, against a throwaway database. Covers precision, deliberate rollback,
  duplicate rejection, and joiner/leaver boundary dates.

## Phase 1A — Salary Components / B1 (2026-09-14) — **PASS**

Removes the dependency on a single undifferentiated `base_salary_sen`.
Payroll inputs are now explicit, classified, versioned, and effective-dated.

- **Domain 7 (modular, same pattern as Domains 1–6).**
  `routes/payroll-config/salary-components.js`, mounted at
  `/api/payroll-config/salary`. Two surfaces: `/components` (master
  catalogue) and `/employee-structure` (per-employee assignment).
- **Tables.** `salary_components` (code, name, earning/deduction,
  fixed/variable, `paid_by` employee/employer, `is_taxable` + optional
  `tax_rule_ref`, `is_bpjs_base`, `is_overtime_base`, `is_proratable`,
  `recurrence`, `legal_entity_id` scope, `calculation_order`,
  `effective_from`/`effective_to`, `status`) and
  `employee_salary_components` (`amount_sen`, effective-dated).
- **Nothing Indonesian is hardcoded.** Taxability, BPJS-base inclusion,
  overtime-base inclusion and proration are per-component CONFIGURATION.
  A regulation change is a data change, not a code change. The derived
  bases in `lib/salaryStructure.js` are computed from these flags.
- **`lib/salaryStructure.js` is the single source of truth** for "which
  components, at what amounts, apply on date X" — mirrors the
  `lib/employeeEligibility.js` contract. `getStructureSegments()` returns
  contiguous segments so the engine can prorate mid-period changes.
  Nothing else may query `employee_salary_components` directly.
- **Versioning.** Component revisions and employee amount changes close the
  current row and open a new one inside a transaction. Historical payroll
  resolves the definition and amount that applied THEN, never today's.
- **Constraints (B5 discipline extended).** Three new partial unique
  indexes: one open version per component code per entity scope (two
  indexes, because SQLite treats NULLs as distinct — the same trap as the
  national-holiday bug), and no duplicate open assignment of one component
  to one employee. Range overlap on CLOSED windows is checked in
  `findOverlappingAssignment()` because SQLite cannot express range
  exclusion; both layers are required.
- **UI.** Seventh tab in the existing Payroll Configuration page. No new
  page, no new navigation entry. Reuses the generic modal form.
- **Migration.** `npm run migrate:phase1a` — idempotent, transactional,
  non-destructive. Backfills each `base_salary_sen` into a BASIC component
  with the same effective window; `base_salary_sen` is RETAINED for
  backward compatibility and should be retired only after the engine ships.
  Verified end-to-end against a real pre-Phase-1A database.
- **Tests.** `npm run test:phase1a` — 21 tests passing. Phase 0's 27 still
  pass (one Phase 0 assertion was corrected from "exactly 4 uq_ indexes" to
  "these 4 are present", since later phases legitimately add more).

### Operational note discovered during Phase 1A testing
The database runs in WAL mode. Copying `kahe360.db` **without** first running
`PRAGMA wal_checkpoint(TRUNCATE)` (or without also copying `-wal`/`-shm`)
silently loses recent committed data. Any backup procedure must checkpoint
first. This bit the migration test before it was corrected.

## Phase 1B — Day-Type & Overtime Day Classification / B2 (2026-09-14) — **PASS**

Every overtime date is now deterministically classifiable. Clears B2 from
`docs/PAYROLL_ENGINE_AUDIT.md`.

- **ARCHITECTURAL LOCK.** `lib/dayClassification.js` decides WHAT KIND OF DAY
  a date is. It never decides what a day is WORTH — no multiplier, rate, or
  money value may appear in it (asserted by a test). Multipliers stay in
  `overtime_multiplier_rules` (Domain 3c), keyed off the day type.
  `resolveOvertimeRuleDayType()` is a pure MAPPING to the rule band, holding
  no values of its own.
- **Canonical function: `classifyDay(db, employeeId, date)`.** Timesheet,
  Attendance and the future Engine all call it. Nothing else may re-derive a
  day type. Resolution chain: assignment -> work calendar -> work pattern ->
  weekly rest day -> holiday master -> specific date -> classification.
- **Day types:** WORKDAY, WEEKLY_REST_DAY, PUBLIC_HOLIDAY, plus
  COMPANY_HOLIDAY and SUBSTITUTED_HOLIDAY already supported. Adding a kind is
  a `holidays.holiday_type` data change — no classifier branching.
- **Precedence (deterministic, documented in `DAY_TYPE_PRECEDENCE`):**
  SUBSTITUTED > PUBLIC > COMPANY > WEEKLY_REST > WORKDAY. A holiday falling on
  the rest day resolves to the holiday, for every employee, always.
- **Domain 8: `work_calendars`** (code, name, legal_entity_id / project_code
  scope, effective_from/to, status) + `routes/payroll-config/work-calendars.js`
  with revise-by-supersession and audit. `employee_payroll_assignments` gains
  `work_calendar_id`. Scope precedence: explicit assignment calendar ->
  entity-scoped -> global.
- **Ambiguity is flagged, never guessed.** `MISSING_ASSIGNMENT`,
  `MISSING_WORK_PATTERN`, `AMBIGUOUS_CALENDAR`, `EMPLOYEE_NOT_FOUND` return
  `dayType: null`. An overtime request on an unclassifiable day is refused
  with **409 DAY_NOT_CLASSIFIED** rather than defaulting to the cheapest band.
  Once configuration is fixed, the next overtime request re-classifies and
  heals the snapshot.
- **Snapshot on `timesheet_entries`** (`day_type`, `day_type_source`,
  `day_type_calendar_id`, `day_type_pattern_id`, `day_classified_at`),
  written SERVER-SIDE only. Any `day_type`/`multiplier` in the request body is
  ignored — a user cannot pick a favourable day type. Verified: a holiday
  declared AFTER a row was recorded does not change that row.
- **Holidays gain** `holiday_type`, `work_calendar_id`, `observed_for`, and
  `is_active` (soft delete, so a past classification stays explainable).
  The Phase 0 duplicate-national-holiday index remains intact.
- **Migration.** `npm run migrate:phase1b` — idempotent, transactional,
  non-destructive; adds columns, seeds a DEFAULT global calendar, and
  backfills day types on existing timesheet rows. Rows that cannot be
  classified are left NULL deliberately, for the Exception Engine to surface.
  Verified against a real pre-1B database (3 legacy rows classified correctly).
- **Tests.** `npm run test:phase1b` — 29 passing, covering all 13 required
  scenarios. Phase 0 (27) and Phase 1A (21) still pass: **77 total**.

### Known model boundary (not a defect)
A shift crossing midnight is classified by its START date, because the model
is one row per (employee, work_date). A Saturday-night shift ending Sunday is
a WORKDAY, not a rest day. This is asserted by a test so a future change to
the convention breaks loudly rather than silently re-pricing overtime.

### Defect found and fixed during Phase 1B
Project-scoped holidays were not matching employees whose calendar was not
itself project-bound (the classifier passed the calendar's NULL project
instead of the employee's). Caught by the SUBSTITUTED_HOLIDAY test.

## Phase 0B — N1 & N2 remediation (2026-09-14) — **PASS**

Closes the two blockers found in the re-audit
(`docs/PAYROLL_ENGINE_REAUDIT.md`). **B3 and B4 are now CLOSED.**

- **N1 — exact time.** `lib/time.js` is the single authority. Canonical
  storage is INTEGER MINUTES (`work_minutes`, `overtime_minutes_requested`,
  `overtime_minutes_approved`). Minutes were chosen over seconds because
  attendance is captured to the minute (clock_in/out are HH:MM); anything
  finer would store precision the source data lacks. Conversion is half-up at
  the minute, matching `lib/money.js` so the system rounds ONE way.
  `overtimePaySen(rateSen, minutes, multiplierBp)` keeps the whole
  computation in integer space and rounds exactly once — the engine must use
  it rather than multiplying hours itself. The REAL hour columns are retained
  but are now a DISPLAY MIRROR rewritten from minutes, so the pair can never
  diverge; `resolveMinutes()` is the one place that accepts either input.
- **N2 — write contention.** `busy_timeout` is now 5000 ms on every
  connection (was 0 — a second writer failed instantly). `withRetry(fn)` adds
  a BOUNDED application retry (4 attempts, 25/50/100 ms backoff) for lock
  errors only; non-contention errors fail fast and are never retried.
  Exhaustion throws `SQLITE_BUSY_EXHAUSTED` with the original cause attached —
  clean failure, never an infinite hang. `withRetry` must wrap a whole
  `withTransaction`, never a fragment; retrying half a transaction is how
  partial financial state gets created.
- **`docs/DB_EXECUTION_POLICY.md`** records the five rules the future engine
  must follow: no single transaction across the whole run; chunk boundaries
  explicit and durable (results and progress in the SAME transaction);
  idempotency via `UNIQUE(run_id, employee_id)`; restartability from the last
  completed chunk; retry wraps the whole unit of work. Written now because
  these constrain how the engine may be built, not how it is later tuned.
- **Migration.** `npm run migrate:phase0b` — idempotent, transactional,
  non-destructive. Verified against a real pre-0B database: 7.25h -> 435 min,
  0.1h -> 6 min, 8h -> 480 min, second run a no-op.
- **Tests.** `npm run test:phase0b` — 25 passing. Phase 0 (27), 1A (21) and
  1B (29) still pass: **102 total**.

### Blocker status after Phase 0B
B1 CLOSED · B2 CLOSED · B3 **CLOSED** · B4 **CLOSED** · B5 CLOSED · B6 CLOSED.
No known blockers remain. Next step is **Phase 2A** (payroll groups and
periods) — awaiting approval, not started.

## Phase 2A — Payroll Groups & Payroll Periods (2026-09-14) — **PASS**

Engine FOUNDATION only. Nothing is calculated: no salary, BPJS, tax, overtime
value, gross or net appears in this domain (asserted by a scope-lock test that
scans both the code and the table DDL).

- **Domain 9a `payroll_groups`** — a processing regime. Required
  `legal_entity_id` (the isolation boundary), optional `project_code`,
  configurable `frequency` (monthly / semi_monthly / biweekly / weekly) +
  `periods_per_year`, optional `work_calendar_id` (falls back to the Phase 1B
  resolution chain), effective dating, status, audit trail.
  **Cutoff and pay-date policy are OFFSET DAYS, not dates** — nothing
  company-specific is hardcoded; change the offsets, not the code.
- **Domain 9b `payroll_periods`** — one exact cycle per group. Carries
  `period_year`, `period_sequence` (generalises "month" so weekly groups need
  no new columns), `period_month`, `period_start/end`, three independent
  cutoffs, `payment_date`, `status`, `created_at/by`, `closed_at/by`.
- **Lifecycle model — validated, then adjusted.** The suggested
  `DRAFT → OPEN → CUTOFF → CLOSED` was kept as the ADMINISTRATIVE lifecycle,
  but it cannot on its own express "attendance closed, adjustments still
  open" — the normal state of a period in the days before payment. Per-stream
  acceptance is therefore DERIVED from the three cutoff dates by
  `lib/payrollPeriod.isStreamOpen()`, rather than adding a combinatorial set
  of statuses. Transitions are explicit and audited; a period never closes
  itself by the clock. CLOSED is terminal in this phase. The period lifecycle
  is deliberately separate from the future run states (Draft/Calculated/…/Paid)
  — asserted by a test.
- **Membership is a COLUMN, not a table.** `employee_payroll_assignments`
  gains `payroll_group_id`, reusing the already-effective-dated row and the
  existing `uq_payroll_assignment_open_per_employee` invariant. This avoids a
  second source of truth about an employee's regime and means 2,000 workers
  are 2,000 rows total — never rows-per-period. Verified at 1,500 workers:
  still exactly ONE June period.
- **`lib/payrollPeriod.js` is the canonical resolver** for "which payroll
  period owns this date for employee X" — employee → assignment in force that
  day → its group → the group's period covering the date. An employee who
  changes group mid-month has each date resolved to the group that owned them
  THAT DAY. Missing/ambiguous configuration is flagged (`period: null` +
  status), never guessed.
- **Duplicate prevention at the database level:**
  `uq_payroll_period_group_cycle` (group+year+sequence) and
  `uq_payroll_period_group_start`, plus a `CHECK (period_end >= period_start)`
  and an application-level overlap guard (SQLite cannot express range
  exclusion — same compensating-control pattern as Phase 1A).
- **Timezone safety:** every boundary is a date-only string compared
  lexicographically; all arithmetic goes through UTC helpers. Tested under
  UTC, Asia/Jakarta, Pacific/Kiritimati and America/Los_Angeles — identical
  results.
- **New permission module `payroll_run`**, separate from `payroll_config` so
  "may configure rules" and "may open/close a cycle" can be held by different
  people. **Closing a period requires `payroll_run:APPROVE`** — Payroll
  Officer can open and cut off but cannot close; Operations Director signs the
  cycle off. Verified by API test (403 then 200).
- **Chunk/restart readiness** (per `docs/DB_EXECUTION_POLICY.md`):
  `getGroupMembership()` returns a deterministically ordered, one-row-per-
  employee list a future run can slice into chunks and resume from an offset.
  Verified: stable ordering across calls, non-overlapping chunks.
- **Migration.** `npm run migrate:phase2a [year]` — idempotent, transactional,
  non-destructive. Creates one default monthly group per legal entity that has
  none, materialises that year's periods, and links orphaned assignments.
  Verified against a real pre-2A database: 1 group, 12 periods, 1 assignment
  linked; second run a no-op.
- **Tests.** `npm run test:phase2a` — 35 passing. Phase 0 (27), 0B (25),
  1A (21) and 1B (29) still pass: **137 total**.

### Not built in Phase 2A (deliberate)
Payroll runs, snapshots, calculation, exceptions, approval of RESULTS,
payslips, payment. Next phase is **2B** (as-of resolver + snapshot writer,
still no calculation) per `docs/PAYROLL_ENGINE_REAUDIT.md` §E — awaiting
approval, not started.

## Phase 2B — As-Of Resolver & Snapshot Writer (2026-09-14) — **PASS**

Deterministic as-of resolution plus an immutable payroll-input foundation.
Still no monetary calculation: no gross, net, BPJS amount, tax amount,
overtime value or deduction is computed (asserted by a scope-lock test that
fails if the resolver so much as calls `applyBp`/`overtimePaySen`).

- **`lib/asOfResolver.js` — the canonical as-of layer.** For
  `employee_id + payroll_period_id + as_of_date` it resolves the exact
  version of: legal entity, payroll assignment, payroll group, employment/
  contract state, eligibility (with payable-day segments), salary structure
  and components (with mid-period segments), BPJS rule set, JKK class+rate
  version, tax/PPh21 TER rule set and bracket table, work calendar, day
  classification source, overtime rules, and the attendance/timesheet source
  rows. Composes the existing canonical libraries — nothing is re-derived.
- **NO "LATEST ROW" ANYWHERE.** Every lookup is bounded by
  `effective_from <= as_of AND (effective_to IS NULL OR effective_to >= as_of)`.
  Proven: with rule set v2 and JKK 135bp live, the June period still resolves
  v1 and 127bp.
- **Deterministic failure, never a guess.** Missing / ambiguous / overlapping
  / inconsistent configuration produces a named error
  (`MISSING_ASSIGNMENT`, `AMBIGUOUS_ASSIGNMENT`, `ENTITY_MISMATCH`,
  `MISSING_RULE_SET`, `AMBIGUOUS_JKK_RATE`, `CALENDAR_UNRESOLVED`,
  `UNCLASSIFIED_OVERTIME_DAY`, …) and leaves that slice null. Status becomes
  INCOMPLETE; the snapshot is still written WITH its errors so the future
  Exception Engine sees them rather than them being swallowed.
- **`payroll_input_snapshots` (Domain 10)** stores source ids, version ids,
  effective dates, the frozen rule VALUES (BPJS rates/caps, the whole TER
  bracket table, overtime multipliers, JKK rate), salary component values and
  segments, calendar/day-type references, attendance totals and source row
  ids, approved overtime minutes, resolution timestamp, and a **SHA-256
  payload hash** over a key-sorted stable serialisation.
- **Immutability, demonstrated end-to-end.** JKK was repriced to 200bp AFTER
  a snapshot was taken; the snapshot still reports 127bp, its hash is
  byte-identical, and `detectDrift()` reports the divergence **without
  rewriting anything**. Once FROZEN (requires `payroll_run:APPROVE`), the
  writer returns `FROZEN_UNCHANGED` rather than touching the row.
- **`lib/snapshotWriter.js` follows `docs/DB_EXECUTION_POLICY.md` exactly:**
  one transaction per bounded chunk (never one across the period), results
  and progress in the same row, `withRetry` wrapping the whole chunk
  transaction, and `getPendingEmployees()` for restart. Verified at 1,500
  employees: 8+ bounded chunks, rerun creates 0, zero duplicates; after
  deleting 25 rows to simulate a crash, exactly 25 were redone.
- **Duplicate prevention** at the database level:
  `uq_snapshot_period_employee`.
- **Tests.** `npm run test:phase2b` — 34 passing. Phase 0 (27), 0B (25),
  1A (21), 1B (29) and 2A (35) still pass: **171 total**.

### Defect found and fixed during Phase 2B
The JKK lookup used the wrong column names (`effective_from/to` instead of
`effective_date/end_date`), which failed loudly rather than silently — the
as-of predicate is applied uniformly, so a mismatch is a hard error, not a
wrong answer. Also worth recording: closing a salary-component row changes
its recorded window even when the amount is unchanged, and that legitimately
registers as drift. A test assumption had to be corrected, not the code.

### Not built in Phase 2B (deliberate)
Payroll runs, any monetary calculation, exceptions engine, approval of
RESULTS, payslips, payment. Next is **2C** (calculation core, dry-run only)
per `docs/PAYROLL_ENGINE_REAUDIT.md` §E — awaiting approval, not started.

## Phase 2C — Payroll Calculation Core, DRY-RUN ONLY (2026-09-14) — **PASS**

A deterministic, pure calculation core. **Nothing is persisted**: no payroll
record, payslip, approval, payment or bank file. Verified by a test that fails
if a `payroll_runs` / `payroll_run_lines` / `payslips` table ever appears.

- **`lib/payrollCalculator.js` is PURE.** It takes a frozen snapshot PAYLOAD
  (a plain object) and returns a result. It receives no `db` handle and
  imports **only** `./money` and `./time` — asserted by a test that parses the
  file's `require()` list and fails on `getDb`, `db.prepare`, `sqlite` or a
  resolver import. Querying live configuration mid-calculation is exactly how
  an August rule change would re-price June; the snapshot exists to prevent it.
- **No side effects.** The input payload is never mutated (asserted by a
  before/after JSON comparison).
- **Integer only.** Money in sen, rates in basis points, time in minutes.
  Every product goes through `applyBp` or `overtimePaySen`, so rounding
  happens exactly once per amount, half-up. Verified at 1,500 employees: the
  sum of individual net figures equals the aggregate **exactly**.
- **Calculated:** proration basis, salary components (fixed/variable split),
  overtime basis and amount, employee and employer BPJS (Kesehatan/JHT/JP/
  JKM/JKK, caps applied to the BASE not the contribution), taxable income
  basis, PPh21 via TER, deductions, gross, employee deductions, employer
  cost, net.
- **Overtime is progressive within the day** per PP 35/2021: minutes are
  allocated hour by hour so a partial hour lands in the correct band
  (90 minutes on a workday = 60 min @ 1.5x + 30 min @ 2x, proven by test).
  The band comes from the day type frozen in the snapshot, never from
  today's calendar.
- **Full traceability.** Every amount emits a trace entry with `component`,
  `source_snapshot_field`, `rule_version`, `basis`, `quantity`, `rate`,
  `formula`, `rounding_rule` and `amount`. `formatTrace()` renders it as an
  audit table; representative traces for a normal employee and an overtime
  case are printed by the test suite.
- **Exception, never guess.** Missing BPJS/tax/JKK/eligibility/structure,
  an INCOMPLETE snapshot (original resolution errors carried forward, not
  replaced), non-integer or negative component amounts, unknown component
  type, zero payable days, unpriceable overtime, and negative net pay all
  return BLOCKED with a named code and `totals: null` — except negative net,
  where the figure IS exposed so it can be diagnosed.
- **Determinism proven:** the same payload run twice produces byte-identical
  JSON. **Immutability proven:** after repricing JKK 127→300bp and raising a
  salary post-snapshot, the snapshot's result is unchanged while a live
  resolve genuinely shows 300bp — so the world really did move.
- **Legal entity isolation:** JKK resolves from the employee's own entity
  (MITRA 89bp, not KAHE 127bp).
- **API:** `GET /api/payroll/snapshots/:id/dry-run` (with `?trace=text`) and
  `GET /api/payroll/periods/:id/dry-run`, both read-only, both returning
  `persisted: false`. Verified end-to-end against the real 122-bracket TER
  table.
- **Tests.** `npm run test:phase2c` — 32 passing, covering all 20 required
  scenarios. Phase 0 (27), 0B (25), 1A (21), 1B (29), 2A (35) and 2B (34)
  still pass: **203 total**.

### Decisions recorded for Phase 2D
- **Mid-period salary change:** the snapshot preserves both segments
  (14 days at the old rate, 16 at the new). Phase 2C's flat calculation uses
  the as-of structure; whether to pay segment-weighted is a 2D policy
  decision, and the inputs are preserved either way.
- **Overtime taxability:** treated as taxable remuneration, added to the
  taxable base alongside taxable earnings.
- **December Pasal 17 annual reconciliation** is explicitly out of scope and
  flagged `annual_reconciliation_required: false` in the tax detail.

### Not built in Phase 2C (deliberate)
Payroll run persistence, run state machine, approval/finalisation, payslips,
payment, bank files. Next is **2D** (validation & exception engine) per
`docs/PAYROLL_ENGINE_REAUDIT.md` §E — awaiting approval, not started.

## Phase 2D — Validation & Exception Engine (2026-09-14) — **PASS**

Persists **exceptions only**. No payroll result, payslip, approval, payment
or bank file (asserted by a test that fails if `payroll_runs` /
`payroll_run_lines` / `payslips` ever appear).

### Three policy decisions locked and implemented
1. **Segment-based proration.** A mid-period salary change is now paid
   segment-weighted from the frozen snapshot:
   `(8.000.000 x 14 + 9.500.000 x 16) / 30 = 8.800.000`, rounded once.
   Single-segment employees take the simple path unchanged.
2. **Overtime taxability is CONFIGURATION.** New versioned fields
   `payroll_rule_sets.overtime_is_taxable` / `overtime_is_bpjs_base`, frozen
   into the snapshot. Flipping the config (not the code) changes the taxable
   base — proven by test.
3. **Monthly TER is never final annual tax.** The tax detail now carries
   `is_final_annual_tax: false`, `annual_reconciliation_required: true`,
   `annual_reconciliation_scope: 'OUT_OF_MVP_SCOPE'`, and every clean
   calculation raises an INFORMATIONAL
   `ANNUAL_TAX_RECONCILIATION_PENDING` exception. It is tracked, never
   silently assumed done.

### The engine
- **`lib/payrollValidation.js` is PURE** — snapshot + payload + result +
  context in, exceptions out, no I/O. Severity is declared in ONE table
  (`SEVERITY_OF`), so "is this blocking?" has exactly one answer per code, and
  a test fails if any code lacks a declared severity.
- **19 machine-readable codes** across BLOCKING / WARNING / INFORMATIONAL.
  Blocking: missing assignment, missing salary structure, ambiguous
  configuration, missing BPJS config, missing tax config, unclassified day
  type, unapproved overtime, invalid component, duplicate payroll candidate,
  outside eligibility, negative net pay, master-data drift, calculation
  blocked. Warning: suspicious overtime (PP 35/2021 4h/day and period
  thresholds), zero salary on an active employee, missing attendance,
  inconsistent payable days, missing bank details (forward-looking, becomes
  blocking at the payment stage). Informational: annual tax reconciliation
  pending, mid-period salary change.
- **Every exception carries all 12 required fields**, in the object and in
  the stored row.
- **Deterministic.** Same inputs → identical ordered set (severity, then
  code). Identity is `(snapshot_id, exception_code)` with a unique index, so
  re-validation refreshes the message and **preserves a human resolution**
  rather than wiping it. Verified: an ACKNOWLEDGED warning survives
  re-validation; re-running a whole period adds zero rows.
- **Never auto-fixes.** A test greps the module and fails if it writes to
  `employee_salary_components`, `timesheet_entries`,
  `employee_payroll_assignments` or `payroll_rule_sets`. It may only write to
  `payroll_exceptions`.
- **The gate.** `getBlockingSummary()` returns `may_progress`, which the
  future approval/finalisation state machine must consult. Unresolved
  blocking → closed.
- **Segregation of duties, verified over the API:** acknowledging a BLOCKING
  exception is refused outright; resolving one as Payroll Officer → **403**;
  as Operations Director → **200**, and the gate then opens.
  Warnings are acknowledgeable at `payroll_run:EDIT`.
- **`lib/validationRunner.js`** follows `docs/DB_EXECUTION_POLICY.md`: one
  transaction per bounded chunk, retry wrapping the whole chunk, restartable.
  Verified at 1,500 employees.
- **Tests.** `npm run test:phase2d` — 37 passing. All prior suites still
  pass: **240 total**.

### Defect found and fixed (real, in Phase 2B)
Resolving a LEAVER as of `period_end` found no assignment — theirs ended
mid-period — so they were blocked despite being owed 20 days' pay. The
resolver now uses an **effective as-of**: the last day the employee was
actually payable within the period, falling back to `period_end`. An
explicit `asOfDate` still wins, so diagnosis is unaffected. Also fixed: a
parameter-binding defect in `persistExceptions` (node:sqlite rejects an
object carrying named parameters the statement does not use).

### Schema added
`payroll_exceptions` (Domain 11) with `uq_exception_snapshot_code`;
`payroll_rule_sets.overtime_is_taxable` / `overtime_is_bpjs_base`;
`employees.bank_name` / `bank_account_no` / `bank_account_name` (required by
the missing-bank-details warning).

### Note on a superseded test
The Phase 2C test for mid-period salary change asserted the old flat as-of
figure (9.500.000). It now asserts the segment-weighted 8.800.000, with the
supersession recorded in the test itself.

### Not built in Phase 2D (deliberate)
Payroll run persistence, run state machine, approval/finalisation of RESULTS,
payslips, payment, bank export. Next is **2E** (approval + finalisation +
immutability lock) per `docs/PAYROLL_ENGINE_REAUDIT.md` §E — awaiting
approval, not started.

## Phase 2E — Approval, Finalization & Immutability Lock (2026-09-14) — **PASS**

Builds NO payment, bank export or payslip delivery (asserted by test).

### Lifecycle — validated, then implemented as proposed
`DRAFT → SNAPSHOT_READY → CALCULATED → VALIDATED → APPROVED → FINALIZED`,
with two reverse edges: `VALIDATED → CALCULATED` (recalculate) and
`APPROVED → VALIDATED` (audited un-approve, so a late problem does not force
finalization). No intermediary state proved necessary. Each state earns its
place: SNAPSHOT_READY is a real gate (calculating from unfrozen snapshots
would let inputs move under the result); CALCULATED is where results first
become PERSISTENT, because approving a figure recomputed on every read
approves nothing.

### Segregation of duties — the problem this phase started with
Operations Director holds every action on every module via a blanket grant,
so any approval permission would have been acquired implicitly. Fixed on two
levels:
- **`payroll_sod_override` is a separate permission module, granted to NO
  role by the seed** — the Director's blanket grant explicitly filters it out
  (`MODULES.filter(([m]) => m !== SOD_OVERRIDE_MODULE)`). A test asserts both
  the filter and that no role literally grants it.
- **The preparer may never approve their own run.** `payroll_runs.prepared_by`
  is recorded at calculation; approval compares against it. Proven over the
  real API: the **Operations Director**, holding every other permission, gets
  **403 SOD_VIOLATION** when approving a run they prepared.
- **Override use is fully audited**: actor, timestamp, reason, target run,
  `sod_override_used: true` and the `prepared_by` it overrode, all in
  `payroll_run_events`.

### Immutability — application AND database layer
Seven SQLite triggers make the lock structural rather than a convention a
future code path might forget: a FINALIZED run cannot change status, and its
lines, component breakdown and the snapshots behind them cannot be updated or
deleted — raw SQL bypassing the application is rejected with
`PAYROLL_FINALIZED`. Plus `uq_payroll_run_single_finalized`, a partial unique
index making two finalized runs per period impossible.
Verified: after finalization, repricing JKK 127→400bp and raising a salary
left the finalized gross and result hash byte-identical, while a live
recalculation genuinely showed 400bp — so the world really moved.

### Other guarantees
- **Approval gates:** unresolved BLOCKING exceptions always stop approval and
  finalization; WARNINGS stop it only when the payroll group's
  `require_warning_acknowledgement` policy says so (configuration, not code —
  both a strict and a permissive group are tested).
- **Duplicate approval is IDEMPOTENT** (no error, approver and timestamp not
  rewritten, no second event). **Duplicate finalization is REJECTED** — a
  second finalization signals something is wrong.
- **Correction after FINALIZED creates a NEW run** (run_number 2); the
  finalized run, its lines and its full transition history are untouched.
- **Every transition records** actor, timestamp, from, to and note.
- **Rollback** during a transition leaves the prior state intact, with no
  orphan event.
- **Legal entity isolation:** a run carries its entity; a snapshot from
  another entity is refused with ENTITY_MISMATCH.
- **1,500-employee run** traverses the whole lifecycle in bounded chunks
  (docs/DB_EXECUTION_POLICY.md), totals reconcile exactly in integer sen, and
  the whole cohort is locked on finalization.

### New schema
`payroll_runs`, `payroll_run_lines`, `payroll_run_line_components`
(the future payslip source), `payroll_run_events`;
`payroll_groups.require_warning_acknowledgement`;
permission module `payroll_sod_override`; 7 immutability triggers.

### Bugs found and fixed
1. **Bulk-cohort assertions were too coarse** in the 1,500-employee test:
   earlier fixtures share the same payroll group, so exact grand totals were
   wrong. Assertions now target the cohort — the extra lines were the engine
   working correctly, not a defect.
2. **Two superseded assertions** in Phase 2C/2D asserted that `payroll_runs`
   must not exist. Phase 2E is exactly when it should. They now assert what
   they always meant and still guard: the CALCULATOR writes no rows, and the
   VALIDATION engine writes exceptions only. Both verified by counting rows
   before and after running them.

### Tests
`npm run test:phase2e` — 38 passing. All prior suites pass: **278 total**
(27 + 25 + 21 + 29 + 35 + 34 + 32 + 37 + 38).

### Not built in Phase 2E (deliberate)
Payment, bank export, payslip delivery, reversal/correction workflow (the
architecture is prepared: correction = a new run, never an overwrite).

## Phase 2F — Finalized Payslip Generation (2026-09-14) — **PASS**

Builds NO payment, bank export or delivery (asserted by test).

### Architectural decision: generate-once, then frozen
A payslip is **generated once from a FINALIZED run and stored**, not
re-rendered on every read. The figures come from `payroll_run_lines`, already
immutable — but the human-readable context (employee name, position, entity
name) lives in live master tables, so render-on-demand would let a rename or
a reorganisation silently change a historical payslip. Freezing the whole
document makes "identical months later" true for the entire slip, not just
the numbers. Verified: after renaming both the employee and the legal entity,
the stored payslip still shows the original names and an identical hash.

### The contract, enforced by test
`lib/payslip.js` must never recalculate or read live rule tables. A test
greps the file and fails on `employee_salary_components`, `payroll_rule_sets`,
`ptkp_ter_rates`, `overtime_multiplier_rules`, `jkk_risk_classes`,
`timesheet_entries`, `payrollCalculator` or `calculate(`. A second test
snapshots the run line, its components, the input snapshot and the run before
and after generation, and fails on any difference.

### Reconciliation is a precondition, not a report
Before a document is accepted, the rendered line items must sum **exactly** to
the persisted `gross_sen`, `employee_deductions_sen` and `net_sen`, and no
employer contribution may also appear as an employee deduction. If any check
fails the payslip is refused rather than published — a slip that disagrees
with the payroll it came from is worse than no slip.

### Four clearly separated sections
`EMPLOYEE_EARNINGS`, `EMPLOYEE_DEDUCTIONS`, `EMPLOYER_CONTRIBUTIONS`
(carrying `reduces_net_pay: false`), `TAKE_HOME_PAY`. Net is
`gross - employee deductions`, asserted against the persisted net, with a
test that fails if employer money ever lands in the employee's deductions.
BPJS is split by suffix: `*_EMPLOYEE` deducts, `*_EMPLOYER` does not.

### Other guarantees
- **Finalization gate at both layers**: the application returns 409
  `RUN_NOT_FINALIZED`; a `trg_payslip_requires_finalized_run` trigger rejects
  a raw INSERT against a non-finalized run.
- **Payslips are immutable**: `trg_lock_payslip_update` / `_delete`. There is
  no state in which amending one is correct — a corrected figure means a
  correction RUN, which produces its own payslip alongside the original.
- **Idempotent generation**: one payslip per run line
  (`UNIQUE(payroll_run_line_id)`); a second call returns the stored document
  with the same `content_hash` and the original `generated_at`.
- **Integrity metadata**: run id, run line id, snapshot id, run number,
  finalized_at/by, approved_by, prepared_by, engine version, line result hash,
  snapshot hash, content hash, payslip version, quotable reference
  (`PS-<entity>-<YYYYMM>-R<run>-<employee>`).
- **Correction runs** produce a distinct payslip because the unique key is per
  run LINE, never overwriting the original.
- **Legal entity isolation** preserved; all routes gated by `payroll_run`
  permissions (a test parses the route file and fails on any ungated route).
  `idx_payslip_employee` is the basis for future employee self-service.
- **Printable rendering** (`?format=text`) produced from the frozen document.
- **1,500 employees**: generated in bounded chunks, payslip totals equal the
  run-line totals exactly, re-run creates nothing.

### Bugs found and fixed
1. **Real defect in Phase 2E's component grouping** (`lib/runCalculator.js`).
   Derived and subtotal trace rows were being stored as payslip line items:
   `OVERTIME_HOURLY_RATE` is a *rate*, not an amount, and `BPJS_BASE`,
   `TAXABLE_BASE`, `*_TOTAL`, `GROSS_PAY`, `NET_PAY` are subtotals of lines
   already listed. Rendering them would have **double-counted** — a sample
   payslip showed earnings of 804.624.277 against a real gross of
   800.000.000. Caught by the Phase 2F reconciliation precondition, not by
   reading the code. Fixed with an explicit derived/subtotal set and a strict
   `OVERTIME_<date>_H<n>` pattern for genuine overtime lines.
2. **Superseded assertion** in Phase 2E ("exactly 7 lock triggers") — Phase 2F
   legitimately adds two payslip locks. Now asserts the seven Phase 2E
   triggers are present, not that they are the only ones.

### Tests
`npm run test:phase2f` — 30 passing. All prior suites pass: **308 total**
(27 + 25 + 21 + 29 + 35 + 34 + 32 + 37 + 38 + 30).

### Not built in Phase 2F (deliberate)
Adjustments/retro/reversal workflow, payment, bank file export, payslip
delivery, employee self-service authentication.

## Phase 2G — Adjustments, Retroactive Payroll & Reversal (2026-09-14) — **PASS**

Builds NO payment or bank file (asserted by test).

### Architectural conflict found and resolved first
`uq_payroll_run_single_finalized` ("one finalized run per period") made a
correction run **impossible to finalize** — which would have forced
corrections to overwrite history, exactly what Phase 2E forbids. Narrowed to
`uq_payroll_run_single_finalized_original`: one finalized **ORIGINAL** run per
period, plus an explicit auditable chain of corrections. Added
`uq_payroll_reversal_single` so a run cannot be reversed twice.

### The model
- `payroll_runs.run_type` (`ORIGINAL` / `CORRECTION` / `REVERSAL`) +
  `corrects_run_id`. A correction **references** the original and carries
  **deltas only** — it never recalculates it.
- `payroll_adjustments` ledger: source run + period + employee + entity,
  seven adjustment types (retro earning/deduction, late overtime, attendance,
  tax, BPJS, manual), explicit `direction` (CREDIT/DEBIT) with
  `amount_sen >= 0` so a negative can never be entered by accident,
  per-entry `is_taxable`/`is_bpjs_base`, reason, external reference, and a
  DRAFT → APPROVED → APPLIED / VOID lifecycle with full audit columns.
- A CORRECTION/REVERSAL run **inherits the original's frozen snapshots**
  rather than re-freezing.

### Statutory rules come from the ORIGINAL snapshot, never live config
A correction raised in September for June payroll is computed under June's
BPJS rates, June's JKK version and June's TER band. A test greps the module
and fails if it so much as reads `payroll_rule_sets`, `ptkp_ter_rates`,
`overtime_multiplier_rules`, `jkk_risk_classes` or
`employee_salary_components`. Late overtime is priced from the original
line's frozen hourly rate with the same progressive bands as Phase 2C.
Caps are deliberately NOT re-applied to a delta in isolation — that
interaction is an explicit `TAX_CORRECTION` / `BPJS_CORRECTION`, which is why
those types exist.

### Immutability and duplicate prevention
- Finalized runs, lines, components, snapshots and payslips remain untouched;
  the Phase 2E/2F triggers still fire.
- `trg_adjustment_requires_finalized_source` — an adjustment may only ever
  reference a FINALIZED run, enforced by the database.
- `trg_lock_applied_adjustment` / `_delete` — an APPLIED adjustment is
  immutable; correcting it means a new reversing entry.
- `uq_adjustment_external_reference` — a caller's reference is single-use.
- Applied adjustments are pinned to their correction run, so re-applying
  finds nothing and creates no duplicate delta lines.

### Reconciliation
`reconcilePeriod` / `reconcileEmployee` sum the ORIGINAL plus every finalized
correction and reversal. Verified over the API:
`7.560.000 + 945.000 = 8.505.000`, with gross − deductions == net exactly. A
full REVERSAL brings a period to exactly zero.

### RBAC & segregation of duties
The **creator of an adjustment cannot approve it** (mirroring the run-level
control), unless they hold the explicit `payroll_sod_override`. Verified over
the API: 403 for the preparer, 200 for Operations Director. Correction runs
go through the same Phase 2E approval/finalization gates.

### Bugs found and fixed
1. **Correction lines had no component breakdown**, so a correction payslip
   failed the Phase 2F reconciliation precondition. Real gap, caught by that
   precondition rather than by reading the code. `writeDeltaComponents()` now
   emits per-adjustment rows plus statutory delta rows, with `paid_by` set
   explicitly so employer contributions never land in the employee's
   deductions. The rows sum exactly to the stored delta totals.
2. **Two coarse test assertions** (reversal line count, trigger count) assumed
   a period contained only its own fixtures / a fixed trigger set. Both now
   assert against the actual original and against presence rather than
   exclusivity.

### Tests
`npm run test:phase2g` — 37 passing. All prior suites pass: **345 total**.

### Not built in Phase 2G (deliberate)
Payment, bank file export, payslip delivery, employee self-service auth.

## Phase 2H — Payment Processing & Bank File Export (2026-09-14) — **PASS**

Builds NO client billing / service fee module (asserted by test).

### Lifecycle validated, then split in two
The suggested `DRAFT -> VALIDATED -> EXPORTED -> SUBMITTED -> PAID` is
BATCH-shaped, but a bank rejects INDIVIDUAL instructions — one bad account
must not fail 1,499 good payments. So there are two state machines: the batch
tracks the file (`+ PARTIALLY_PAID`, `CANCELLED`), each item tracks its own
outcome (`PENDING/EXPORTED/SUBMITTED/PAID` + `REJECTED/FAILED/RETURNED/
CANCELLED`), and the batch status is DERIVED from its items.

### The contract, enforced by test
`lib/payrollPayment.js` never recalculates and never writes finalized payroll.
A test greps it for `payroll_rule_sets`, `ptkp_ter_rates`,
`overtime_multiplier_rules`, `jkk_risk_classes`, `employee_salary_components`,
`timesheet_entries`, the calculator, and for any UPDATE/DELETE against
payroll, adjustment, payslip or snapshot tables.

### Bank format honesty
`lib/bankExport.js` is an adapter registry. Only `GENERIC_CSV` and
`GENERIC_JSON` are implemented, both flagged
`verified_against_bank_spec: false` with `bank: null`. **No BCA / Mandiri /
BNI / BRI format is implemented or claimed** — a test fails if those names
appear in the code at all. Indonesian host-to-host layouts are per bank and
often per corporate agreement; claiming compatibility without the actual
specification means a rejected file at best and a mis-paid employee at worst.

### Guarantees
- **Payable = finalized net** across ORIGINAL + CORRECTION + REVERSAL, the
  same figure Phase 2G reconciles. Employer contributions never enter it —
  the module does not even read those columns (asserted).
- **Zero or negative effective payable is REFUSED**, not paid as a negative
  transfer; it is surfaced as an exception for a recovery process.
- **Bank account is SNAPSHOTTED** at preparation; a later change cannot alter
  an exported instruction (`trg_lock_exported_payment_item`).
- **Duplicate payment** prevented by `uq_payment_item_live_per_period` — at
  most one live instruction per employee per period, with terminal failures
  excluded so a retry stays legal.
- **Retry creates a NEW linked instruction** and re-snapshots the corrected
  account; the rejected record survives untouched.
- **No silent auto-fix**: a missing/invalid account is excluded with a reason
  and the employee's master record is left exactly as it was.
- **Batch validation reconciles** every instruction against finalized payroll
  and refuses on any mismatch.
- **SoD**: preparing/exporting needs `payroll_payment:CREATE`/`EXPORT`;
  authorising the submission needs `APPROVE` **and** a different person.
- Legal-entity isolated, transactional, chunk-friendly, fully audited.

### Bugs found and fixed
1. **Real sign-semantics defect in Phase 2G**: a `RETRO_DEDUCTION` with
   direction `DEBIT` was *increasing* net pay, because the signed value was
   added straight to the deduction total. A 50-million recovery made someone
   richer. Found by the negative-payable test. Fixed with an explicit
   `deductionSide()` helper and one documented rule: **CREDIT increases what
   the employee receives, DEBIT decreases it**, on both sides of the payslip.
   The Phase 2G test that encoded the old behaviour was corrected with a note.
2. **`UNIQUE(batch_id, employee_id)` was too strict** — it made an explicit
   linked retry impossible when a cancelled instruction already existed in the
   batch. Narrowed to a partial index over live instructions only.
3. **Five superseded assertions** across 2C–2G asserted the payment tables
   must not exist. Phase 2H is when they should. They now assert what they
   always meant — that module writes no payment row — by counting rows.

### Tests
`npm run test:phase2h` — 35 passing. All prior suites pass: **380 total**.

### Not built in Phase 2H (deliberate)
Client billing / outsourcing service fee, bank-specific format adapters,
payslip delivery, employee self-service authentication.

## Full End-to-End System Audit (2026-09-14) — **PASS · READY WITH CONDITIONS**

No new features. Full report: `docs/E2E_AUDIT.md`.

- **One complete cycle verified** from employee setup to payment
  reconciliation, covering all ten required cases. June reconciled to
  `payable Rp55.474.194 = paid Rp55.474.194, outstanding Rp0`.
- **423 tests passing** across 13 suites, including a new
  `tests/e2e.test.js` (43 assertions, `npm run test:e2e`).
- **No critical blockers.** The only failures during the audit were my own
  fixture errors and one *correct* system refusal: a replacement rule set
  activated without overtime rules produced 1,500 BLOCKING exceptions rather
  than silently paying zero overtime.
- **Scale:** 1,500 employees through the whole cycle in **13.8 s**
  (snapshot 5.7 · calc 0.9 · validate 6.0 · payslip 1.0 · payment 0.1),
  all in bounded chunks, with exact aggregation.
- **Integrity:** zero non-integer money rows anywhere; June history
  byte-identical after JKK was repriced 127→900 bp, a new rule set activated,
  salaries raised and both the employee and entity renamed; zero orphans
  across the chain.
- **RBAC:** all 60 payroll routes gated; SoD holds against the Operations
  Director at run, adjustment and payment level.

### Conditions before real money moves
1. **Close entity read-scoping** — `user_legal_entity_scope` does not exist,
   so any `payroll_run:VIEW` holder can read any entity's payroll. Mandatory
   for a multi-entity pilot.
2. **Obtain and implement a real bank adapter** — only unverified generic
   formats exist; until then, manual transfer against the exported file.
3. **Parallel run for one full month** against the current process,
   reconciled per employee to the rupiah.

### Non-blocking findings recorded
Rule-set completeness is not validated at activation (fails safe, but late);
payslip reads are not row-scoped (matters at self-service);
December Pasal 17 annual true-up is out of scope and manual;
`legal_entities` is not effective-dated (contained by the snapshot);
BPJS caps are deliberately not re-applied to retro deltas (needs an SOP note);
payroll READS are not audited.

## Phase 2I — Legal Entity Read Scope / Tenant Isolation (2026-09-14) — **PASS**

Closes the audit's top security finding: data was isolated by legal entity
everywhere, but READ ACCESS was not.

### Policy (locked)
- **A VIEW permission alone NEVER grants cross-entity visibility.** RBAC
  answers "may this person read payroll at all"; `user_legal_entity_scope`
  answers "whose". Both must pass.
- **No implicit "sees everything"** — every role needs explicit rows,
  including Operations Director. Proven over the API: a Director holding
  **every** permission with no scope sees **0 groups, 0 periods**, and gets
  **404** on a direct id.
- **The only bypass is `payroll_entity_override`**, a separate permission
  module granted to no role by default and audited on every use.
- **Cross-entity direct-ID access returns 404, not 403.** A 403 confirms the
  record exists elsewhere, which is the basis of id enumeration. The denial
  is audited either way, so the attempt is still visible internally while the
  caller cannot distinguish "not yours" from "not there" — verified: both
  return the identical body.

### Implementation
- `lib/entityScope.js` is the single authority: `getUserEntities`,
  `canAccessEntity`, `assertEntityAccess`, `assertResourceAccess`,
  `scopeClause` (SQL fragment, so list queries are filtered **in SQL** rather
  than after the fact), plus grant/revoke. A `RESOURCE_ENTITY_SQL` map
  resolves the owning entity for run, run line, payslip, payment batch,
  payment item, snapshot, exception, adjustment, period, group and employee.
- `middleware/permissions.js` attaches `entityScope` to every request's
  `userContext`; `/api/auth/me` exposes it so the UI can show an explicit
  "no entity access" state instead of an empty payroll that looks like
  missing data.
- All 8 payroll route files guard direct-ID reads and filter list queries;
  mutating routes are guarded too. `server.js` maps `EntityAccessError` to
  404 as a safety net for any handler that doesn't catch it itself.
- `entity_access_audit` records actor, outcome (DENIED / OVERRIDE_ALLOWED),
  resource type and id, requested entity, the scope the user actually held,
  route and timestamp. A genuinely absent record is **not** logged as a
  cross-entity attempt — no false positives.
- `database/migrate-phase2i.js` is idempotent and deliberately **not
  permissive**: it does not grant everyone every entity (that would recreate
  the gap). It reports unscoped users so an administrator decides explicitly.
  `--grant-all-to-directors` is opt-in only.

### Verified
KAHE user cannot read any MITRA resource (run, line, payslip, payment batch,
payment item, snapshot, exception, adjustment, period, group) and vice versa;
a two-entity user reads both but still not a third; enumeration sweep over
every run id returns exactly the visible set; correction/reversal and payment
isolation hold; override and denial both audited with full context; SoD and
all prior RBAC unchanged; 1,500-worker cohort unaffected (authorised user
sees all 1,500, MITRA user sees none).

### Tests
`npm run test:phase2i` — 25 passing. All prior suites pass: **448 total**.

### Superseded assertion
The Phase 2E check that the Director's blanket grant excludes the SoD
override matched a single-module filter; Phase 2I added a second override, so
the pattern now matches the list form. The guarantee is unchanged.

### Audit condition status
Condition 1 of the end-to-end audit (**close entity read-scoping**) is now
**MET**. Conditions 2 (real bank adapter) and 3 (one-month parallel run)
remain open.

## Phase 3A — Add-on Benefit / Worker Service Model (2026-09-14) — **PASS**

Configuration foundation only. No invoice, no billing calculation, no payroll
mutation (all three asserted by test).

### Note on continuity
The instruction was to *continue* Phase 3A. Inspection found **no Phase 3A
artefacts at all** — no library, route, test or table — and no prior Service
Fee lock to preserve. The last completed phase was 2I. This phase was
therefore started, not resumed.

### Architecture lock, expressed as code
Transport, Meals and Accommodation are **optional configurable worker
services**, never mandatory allowances. Three states are kept strictly apart:
- **CASH_ALLOWANCE** — may become a payroll component, and only when
  explicitly configured with a named `payroll_component_code`.
- **BENEFIT_IN_KIND** — shuttle, catering, mess, camp, hotel. Real cost,
  possibly billable, **zero** payroll impact.
- **NOT_PROVIDED** — nothing. No component, and no zero-rupiah placeholder.

Of 18 delivery modes across the three categories, exactly **3 are cash**
(`CASH_ALLOWANCE` ×2, `HOUSING_ALLOWANCE`). Enforced over the real API:

| Attempt | Result |
|---|---|
| Cash mode without a component code | `CASH_REQUIRES_COMPONENT` |
| Shuttle carrying a payroll component | `COMPONENT_ON_NON_CASH` |
| NOT_PROVIDED carrying a rate | `NOT_PROVIDED_HAS_TERMS` |
| Meals delivered by SHUTTLE_SERVICE | `INVALID_MODE_FOR_TYPE` |

### Independent axes
Employee entitlement and client billability never imply each other. Verified:
a client-provided shuttle is neither payroll cost nor billable (Scenario A);
KAHE catering is billable with KAHE as initial bearer (Scenario B); KAHE mess
is billable with no housing allowance (Scenario C); a client refusing to
reimburse leaves KAHE as a recorded, visible cost bearer (rule 6); an
employee may be NOT_ENTITLED while the client is still billed.

### Versioning & history
Effective-dated, versioned, DRAFT → ACTIVE → SUPERSEDED. Approving a new
version closes the previous one the day before the new one starts, so "what
applied on date X" has exactly one answer. June resolves the old rate, July
the new, as two distinct preserved records. An ACTIVE version's commercial
terms are immutable (`trg_lock_active_addon_terms`); a backdated overlap is
refused; `uq_addon_open_per_scope` makes two open configurations impossible.
Every change is audited with actor, before and after.

### Other
- Scope precedence **project > client > legal entity**, with cross-client and
  cross-entity isolation verified.
- SoD: the creator cannot approve their own configuration. Payroll Officer
  holds `worker_services_config:VIEW/CREATE/EDIT` (maker); approval needs
  Director. Verified over the API: 403 then 200.
- Entity read scoping from Phase 2I applies throughout.
- **Service Fee** is optional and `NOT_CONFIGURED` is a valid resolved state —
  billing assembles without it rather than assuming a default percentage.
- `resolveBillingBasis()` returns the SHAPE for a future Client Billing run
  (finalized payroll cost + add-ons + service fee) with
  `amounts_calculated: false`. No amount is computed anywhere.
- New schema: `clients` (did not exist before), `worker_service_addons`,
  `worker_service_addon_audit`, `service_fee_config`.

### Bugs found and fixed
1. **Named-parameter binding** — `resolveAddon` / `resolveServiceFee` passed
   `@project_id` to tier queries that don't bind it; node:sqlite rejects
   unused named parameters. Same defect class as the Phase 2D one. Each tier
   now declares exactly the parameters its own SQL uses.
2. **Misleading validation order** — a NOT_PROVIDED add-on carrying a
   component code was reported as "this is a service, not cash", which
   NOT_PROVIDED is not. The NOT_PROVIDED rule now runs first so the message
   says what is actually wrong.
3. **A missing required field returned 404** — `legal_entity_id` absent hit
   the entity-scope guard and was answered as a cross-entity denial,
   indistinguishable from a real one and sending the caller after the wrong
   bug. Presence is now validated before the scope check, returning 400.

### Tests
`npm run test:phase3a` — 44 passing. All prior suites pass: **492 total**.

### Not built in Phase 3A (deliberate)
Client Billing calculation, invoice generation, per-worker add-on assignment,
add-on consumption/attendance capture, service fee pricing.

## Phase 3B — Client Billing Quantity & Calculation (2026-09-14) — **PASS**

Produces a DRAFT BILLING STATEMENT. No invoice, no AR, no tax invoice, no
fleet or dispatch module (all asserted by test).

### Separation of concerns
- Phase 3A `worker_service_addons` — WHAT is provided and its commercial
  posture. **Untouched** except for two additive columns
  (`client_billable_mode`, `billable_condition`) so CONDITIONAL becomes a
  real third state; the Phase 3A integer stays as the boolean projection.
- Phase 3B `billing_rate_cards` — HOW it is priced: pricing model, quantity
  source, unit, rate. Versioned and effective-dated separately from the
  service, so a price change never touches the service configuration.
- Phase 3B `billing_quantities` — HOW MUCH was actually consumed, verified.
- Phase 3B `billing_runs` / `billing_lines` — the draft statement.

Transport delivery modes were widened (DEDICATED_VEHICLE, POOL_VEHICLE, BUS,
MINIBUS, PICKUP_DROP_SERVICE, CUSTOM) purely in the library — the column has
no CHECK constraint, so no migration was needed and no 3A table was redesigned.

### Locks held
- **Nothing hardcoded** — a test greps the billing libraries for money-scale
  literals and for any assumed fee rate, and fails on either.
- **Not every model uses quantity × rate.** FIXED_MONTHLY, PACKAGE, ALL_IN,
  PASS_THROUGH, PERCENTAGE and PERCENTAGE_MARKUP price a period or a base;
  they are refused a quantity source and never invent one. FIXED_PER_WORKER
  genuinely multiplies by headcount and is deliberately NOT in that set.
- **Attendance is never assumed to be consumption.** Billing does not read
  `timesheet_entries` at all (test-enforced). ATTENDANCE_DAY exists as an
  explicit choice among fourteen quantity sources, not as a default. Verified:
  20 workers × 26 attendance days ≠ 520 lunches; 500 were eaten and 500 were
  billed. Five shuttle trips were billed for a month of full attendance.
- **NOT_CONFIGURED is a first-class state.** A rate card may exist with no
  price; billing reports `RATE_NOT_CONFIGURED` and skips it. No fake Rp0 row
  is ever produced — asserted directly.
- **Historical configuration is preserved.** June lunch Rp35.000, July
  Rp38.000, as two records. June shuttle Rp1.000.000/trip, July
  Rp1.200.000/trip. Enabling breakfast in July leaves June resolving
  lunch + dinner only.
- **Cash allowance discipline unchanged** — cash transport still requires an
  explicit payroll component; every in-kind mode (shuttle, bus, minibus,
  dedicated, pool, pickup-drop) is refused one. Payroll impact stays NONE.
- **Payroll is read, never written.** Only `status = 'FINALIZED'` rows, only
  the basis a PAYROLL_COST rate card names. A test fails on any write to a
  payroll table, on importing the payroll calculator, or if the FINALIZED
  restriction disappears.

### Quantity discipline
Capture and verification are separate acts, and the recorder cannot verify
their own count (403 over the API). Only VERIFIED quantities are billed.
Duplicates are blocked at both the service layer and a partial unique index.
Zero is legitimate and is reported, not billed. Negative is refused unless it
is an explicit adjustment against a prior record. A correction supersedes
rather than edits, keeping the original figure and a mandatory reason.
Consumed quantities are marked with their run, so a second run cannot
double-bill them.

### Reproducibility
Every line records what, why billable, how much, from which source, verified
by whom, at which rate version and card, under which add-on configuration
version, for which client, project and entity. A CALCULATED run is frozen by
trigger; a later rate change leaves every line byte-identical (verified).

### Bugs found and fixed
1. **PERCENTAGE was classified as a quantity-driven model**, so a service fee
   could not be configured without inventing a meaningless quantity source.
   Found while wiring the fee. PERCENTAGE / PERCENTAGE_MARKUP /
   FIXED_PER_MONTH now price a base, while FIXED_PER_WORKER correctly still
   requires a quantity.
2. **Two superseded assertions** in Phase 2H and 3A asserted the billing
   tables must not exist. Phase 3B is when they should. They now assert what
   they always meant — that module writes no billing row — by counting rows.

### Scale
1,500 workers × 22 lunches: **Rp1.155.000.000 in 386 ms**, exact integer
arithmetic, with all 1,500 contributing quantity ids traceable on the line.

### Tests
`npm run test:phase3b` — 53 passing. All prior suites pass: **545 total**.

### Not built in Phase 3B (deliberate)
Invoice generation, billing approval/freeze beyond the calculation freeze,
accounts receivable, tax invoice, fleet or dispatch management.

## PAYROLL CORE FREEZE — `PAYROLL_CORE_STABLE_V1` (2026-09-14)

Recorded after Phase 3B PASS. Full contract: `docs/PAYROLL_CORE_FREEZE.md`.

### The freeze is detectable, not just declared
`docs/PAYROLL_CORE_FREEZE.lock.json` holds a SHA-256 of all **48 frozen
files**. `npm run check:payroll-freeze` reports drift. Verified working: a
one-line edit to `lib/payrollCalculator.js` was detected as
`CHANGED`, and the check returned to `INTACT` once reverted.

`npm run test:payroll-regression` runs all 16 suites and fails if the total
drops below 545 or any suite fails — so a silently removed test is caught too.

### What is frozen
18 canonical payroll libraries, 4 billing libraries, 10 API route files and
the 16 regression suites. Four shared files (`init-db.js`, `seed.js`,
`permissions.js`, `server.js`) are NOT frozen wholesale — other modules will
add tables, permissions and routes to them — but changes there are reported as
a NOTE and must be followed by the payroll regression. The payroll-owned
regions inside them (37 tables, 18 unique indexes, 15 immutability triggers,
the zero-grant overrides, `entityScope`) remain protected in substance.

### Integration rule
Other modules FEED payroll through the documented tables
(`timesheet_entries`, `employees`, `employee_payroll_assignments`,
salary/rule configuration, `worker_service_addons`, `billing_quantities`) and
READ it through the entity-scoped APIs. Writing to a payroll table directly
from a new module is a freeze violation even if no frozen file changed.

If a portal module needs a payroll change: report the dependency, explain why
the existing interface is insufficient, and **wait for explicit approval**.

### Honest coverage statement
The freeze protects a BACKEND. Most of it has no UI yet — and building that UI
is portal work against the frozen APIs, which is allowed and is probably the
highest-value next step.

- **Functional (backend + UI):** auth/RBAC, HRD & Kontrak, Timesheet &
  Absensi (hardened in A1, not yet production-frozen), Payroll Configuration.
- **Backend complete, NO UI:** payroll periods, snapshots, dry-run,
  validation/exceptions, runs, approval/finalization, payslips,
  adjustments/reversal, payments and bank export, worker service add-ons,
  billing rates/quantities, draft billing calculation.
- **Static shells (markup only, zero fetch calls):** 18 pages including
  Pusat Kendali, Operasi Tenaga Kerja, Layanan Pekerja, Kesehatan Kerja,
  HSE & Kepatuhan, Laporan & Analitik, Penggajian & BPJS, Dokumen and
  Pengaturan. They are navigable, not implemented.

Recorded plainly so nobody plans against a capability that is not there.

### Baselines packaged
- `KAHE360_INTERNAL_DEMO_V1` — runnable demo: all portal pages, the stable
  payroll subsystem, current navigation and demo data. Frozen as a reference
  point; it does not block further development.
- `KAHE360_INTERNAL_DEVELOPMENT` — where portal work continues.

## ATTENDANCE HARDENING A1 — Critical Integrity, Security & Schedule Architecture Lock (2026-09-20) — **PASS**

Continued from the recovered state (freeze INTACT, 545 PASS, verified before
any change). Scope was the recovery audit's critical gaps only. Architecture
and locks: **`docs/ATTENDANCE_ARCHITECTURE.md`**.

### What changed
- **Cutoff / snapshot protection.** Create, edit, overtime request and
  decision now consult the canonical `payrollPeriod.resolvePeriodForDate` +
  `isStreamOpen` (attendance stream for entries, overtime stream for OT).
  `PERIOD_CLOSED` / `PAST_CUTOFF` → `409 ATTENDANCE_PERIOD_CLOSED` /
  `OVERTIME_PERIOD_CLOSED`. A FROZEN payroll snapshot covering the
  employee/date → `409 ATTENDANCE_SOURCE_FROZEN`, also enforced by three DB
  triggers so raw SQL cannot change payroll-source columns either.
  **Policy decision:** DRAFT periods and dates with no resolvable period stay
  writable (Phase 2A materialises DRAFT periods for the whole year; attendance
  precedes period opening). Flagged for confirmation.
- **Approved OT immutability.** Decisions require a pending request; the same
  decision again is an idempotent no-op; the opposite decision is
  `409 OVERTIME_DECISION_CONFLICT`; a new request after a decision is
  `409 OVERTIME_ALREADY_DECIDED`; a second pending request is refused;
  generic `PUT` cannot change status/clock/shift/minutes once a decision is
  terminal (`409 OVERTIME_DECISION_LOCKED`; note/workfront still editable).
  Decision UPDATEs are conditional on `overtime_status = 'pending'`, so two
  concurrent approvers cannot both win.
- **Overtime SoD.** Requester ≠ approver/rejecter by **user id** →
  `403 SOD_VIOLATION`. Approve needs `APPROVE`, reject now needs `REJECT`
  (no role grant changed). Legacy pending requests with no verifiable
  requester → `409 OVERTIME_REQUESTER_UNVERIFIED` until re-submitted.
- **Eligibility.** `employeeEligibility.isEligibleOn` on the WORK DATE →
  `409 EMPLOYEE_NOT_ELIGIBLE` with reason (NOT_STARTED, TERMINATED, INACTIVE,
  CONTRACT_NOT_COVERING, NO_PAYROLL_ASSIGNMENT). Former employees' history
  stays readable, and still-valid dates stay editable.
- **Legal-entity scope.** Every list, KPI summary, pending queue, direct-id
  access and write uses `lib/entityScope.js` (Phase 2I); lists filtered in SQL
  on the new `timesheet_entries.legal_entity_id` (entity ON THE WORK DATE).
  Foreign and absent ids answer the same `404`; denials audited.
- **Stable identity + audit.** User-id columns for recorder, editor, OT
  requester and decider; display-name columns kept as labels. New append-only
  `attendance_events` (actor id, old/new values) for every write.
- **Input integrity (needed to close the cutoff gap).** Strict `YYYY-MM-DD`
  real dates (a junk date resolved to no period and bypassed the cutoff);
  minutes bounded 0–1440; attendance status validated; OT only on present/late
  days; `entry_source = MANUAL` set server-side.
- **UI (minimal, no redesign).** The approval panel shows the server's refusal
  message and does not offer Approve/Reject on the viewer's own request (UX
  only; the server enforces it). Verified in a real browser at 1920×1080.

### Bugs found and fixed
1. Approved OT could be silently reversed (`PUT` to absent; approve↔reject
   flips; decide on rows with no request; re-request reset an approval).
2. Requester could approve their own overtime.
3. No cutoff / frozen-snapshot enforcement on any attendance write.
4. Junk or impossible dates (`"hello"`, `2026-02-30`) accepted — and they
   bypassed the cutoff because no period resolves for them.
5. Attendance recordable for not-yet-started / terminated / unassigned staff.
6. Every attendance reader saw every entity's workers; KPI summary and the
   pending queue were global.
7. Actor identity was a mutable display name.

### Database changes (additive, idempotent — `database/attendance-schema.js`)
- `timesheet_entries` + 7 nullable columns: `legal_entity_id`, `entry_source`,
  `recorded_by_user_id`, `updated_by_user_id`, `overtime_requested_by_user_id`,
  `overtime_requested_at`, `overtime_decided_by_user_id`. Nothing dropped,
  renamed or re-typed; every payroll-consumed column untouched.
- `idx_timesheet_entity_date`; new table `attendance_events` (+2 indexes,
  2 append-only triggers); 3 frozen-attendance triggers.
- Applied by `initDb()` (one hook line in the shared `init-db.js`), plus
  `npm run migrate:attendance-a1` for existing databases: backfills user ids
  only where a legacy label matches exactly one user, reports rows with no
  entity and rows with invalid legacy dates (reported, never deleted).
  Verified on a real pre-A1 database: 3 recorder ids, 1 decider id backfilled;
  second run a no-op.
- `init-db.js` also honours `KAHE360_DB_PATH` (unset in normal use) so the
  API suite can start the real server on a throwaway database.

### Tests
- New `tests/attendance-a1.test.js` (`npm run test:attendance`): **55 passing**,
  spawning the real `server.js`, real `seed.js` RBAC, real sessions over HTTP.
  Covers every required scenario (attendance, overtime, eligibility, entity
  isolation) plus integer minutes, DB-level locks, audit trail and migration.
- Sensitivity check: run against the ORIGINAL `routes/timesheet.js`, the
  suite fails **44 of 55** — it detects the defects it was written for.
- Payroll regression **545 / 545**, freeze **INTACT** (48 frozen files; NOTE on
  shared `init-db.js`, as the freeze contract expects).
- **Total project tests: 600** (545 payroll + 55 attendance).

### Frozen files changed
None. Payroll tables are read, never altered.

### Remaining attendance gaps (next phases)
Configurable work schedule / shift master (effective-dated, multi-break,
OT-eligibility boundary, tolerances) and its UI; cross-midnight calculation;
derivation / consistency of worked minutes from clock times (still a manual
figure); timezone normalisation (server "today" and `isStreamOpen` default are
UTC — between 00:00 and 07:00 WIB "today" is yesterday); future-date policy;
project / workfront scope (not enforceable until an assignment model exists);
hardcoded workfront list; full correction / void workflow on top of
`attendance_events`; bulk entry, CSV import, export, monthly recap; leave-type
master; device integrations (none exist). Also: the HRD employee dropdown
(`/api/hrd/employees`) is not entity-scoped — foreign employees appear in the
picker, though any attendance action on them answers 404; and legacy rows
with no entity on their date are visible only via the audited override.

## ATTENDANCE A2 — Configurable Work Schedule, Shift, Custom Pattern, Break & Time Engine (2026-09-20) — **PASS**

Continued from A1 (freeze INTACT, 545 payroll, 55 attendance — all re-verified
before any change). Architecture and locks: **`docs/ATTENDANCE_ARCHITECTURE.md`**.

### What was built
- **Work Schedule / Shift master** (`work_schedules`, `work_schedule_breaks`):
  effective-dated versions per code+entity, clock in/out, standard minutes,
  cross-midnight flag, OT-eligibility rule, and **zero, one or many** breaks
  with paid/unpaid flags. OFFICE / SITE-DAY / SITE-NIGHT / SECURITY exist only
  as test fixtures and an opt-in migration flag — never as defaults in code.
- **Work patterns** (`attendance_work_patterns`, `attendance_pattern_days`):
  `pattern_type` is the only enum (FIXED_WEEKLY, CUSTOM_WEEKLY,
  ROTATING_CYCLE, DATE_BASED_ROSTER); every SHAPE is data. 5/2, 6/1, 4/2,
  14/7, 21/7, 2 DAY/2 NIGHT/2 OFF and "Wednesday off, Saturday and Sunday on"
  are the same code path, and each day carries its own shift. A rotating
  roster with no `cycle_start_date` is refused, never guessed.
- **Date roster** (`attendance_roster_dates`) and **date override**
  (`attendance_date_overrides`): audited exceptions with a mandatory reason
  that never rewrite the base pattern.
- **Employee schedule assignment** (`attendance_schedule_assignments`),
  effective-dated and superseding; any other overlap is refused.
- **Resolution engine** `lib/workSchedule.js` with a documented, deterministic
  precedence (override → roster → cycle → weekly → legacy) and a resolved
  expectation SNAPSHOTTED on every attendance row.
- **Timezone authority** `lib/businessTime.js` (Asia/Jakarta, `KAHE360_TZ`),
  closing the UTC previous-day bug for 00:00–07:00 WIB.
- **Derived worked minutes** from actual clocks minus unpaid breaks, with
  late / early-leave / after-shift minutes, and **cross-midnight** shifts as
  one row with `clock_out_date`.
- **Configuration API** `routes/work-schedule.js` under the new
  `attendance_config` permission module, and a new page
  `public/jadwal-kerja.html` (6 tabs incl. per-weekday configuration, rotating
  cycle builder, roster, overrides, assignment, resolution check). The
  Timesheet & Absensi table now shows the expectation beside the actual.

### Locks held
- **Attendance supplies TIME; payroll computes money.** A test greps
  `lib/workSchedule.js` for money terms and fails on any hit.
- **Eligible ≠ payable.** A late clock-out yields
  `worked_after_shift_minutes` for review and `overtime_minutes_approved = 0`
  until the A1 request→decision workflow approves it. A `NOT_ELIGIBLE` shift
  refuses requests.
- **Day TYPE still comes from the frozen classifier.** A public holiday worked
  under an override stays PUBLIC_HOLIDAY, so attendance configuration can never
  soften a payroll band.
- **Historical immutability.** Rows re-derive against their own snapshot; a
  schedule version referenced by attendance cannot have its times or breaks
  changed (two new triggers) — correcting one means a new version.
- **Integer minutes** everywhere (0.1h=6 … 8h=480, asserted end to end).

### Bugs found and fixed during A2
1. **Roster-date upsert failed with a 500**: `ON CONFLICT(pattern_id, work_date)`
   targeted a PARTIAL unique index without repeating its predicate, so SQLite
   could not match the index.
2. **Assignment overlap was not detected** when a new range landed INSIDE an
   existing closed period — only ranges starting on/after the new date were
   checked. Now every overlap is refused except the one legitimate case: the
   open assignment being superseded.
3. Shift precedence was ambiguous between a pattern day's shift and the
   assignment's default shift; resolved, documented and test-pinned
   (date row → pattern day → assignment default → pattern default).

### Database changes (additive, idempotent — `database/attendance-schedule-schema.js`)
6 new tables (`work_schedules`, `work_schedule_breaks`,
`attendance_work_patterns`, `attendance_pattern_days`,
`attendance_roster_dates`, `attendance_date_overrides`,
`attendance_schedule_assignments`), 17 new timesheet columns (all nullable),
partial unique indexes for open versions and one open assignment, and 2
schedule-immutability triggers. Nothing dropped, renamed or re-typed; no
payroll table altered. `npm run migrate:attendance-a2` is idempotent and
**invents no schedule** for an existing workforce (`--seed-examples <ENTITY>`
optionally creates example shifts, assigned to nobody).

### Tests
- New `tests/attendance-a2.test.js` — **83 passing** against the real server:
  schedule master and versioning, custom/fixed weekly, 4/2 · 14/7 · 21/7 ·
  2D/2N/2OFF cycles, date roster, overrides (incl. on a public holiday),
  effective dating, breaks (0/1/paid/multiple), worked-minute derivation,
  overtime eligibility, cross-midnight (month + year boundary, no negative
  duration), day types, timezone, future-date policy, manual-entry guards,
  historical immutability, payroll contract, rejected/short overtime, mixed
  paid+unpaid breaks, employee-level roster precedence, terminated-worker
  eligibility, and migration.
- A1 suite unchanged: **55 passing**. Payroll regression **545 / 545**, freeze
  **INTACT** (NOTE on shared `init-db.js`, `seed.js`, `server.js`).
- **Total project tests: 683** (545 payroll + 55 A1 + 83 A2).
- Scale: schedule resolution for **100 employees in ~17–27 ms** and **1,500 in
  ~286–332 ms** on one cached pass (schedules/patterns read once, not per employee).

### Frozen files changed
None.

### Remaining attendance gaps (next phases)
Actual break punches (`attendance_break_events` is designed, not built);
consistency rules between actual clocks and tolerances (late/early are measured
but nothing acts on them); project/workfront as a SECURITY scope (A2 records
them descriptively — `user_project_scope` is still unenforced, and the HRD
employee dropdown is still unscoped); full correction/void workflow; bulk entry,
CSV import, export, monthly recap; leave-type master; device integrations
(MANUAL only — no biometric, GPS or RFID exists); a UI for editing an existing
pattern's days in place (today a new version is created); rotating-roster
templates; Attendance production freeze is NOT declared.

## ATTENDANCE A3 — Correction, Void, Exception, Payroll Impact & Immutable Audit (2026-09-20) — **PASS**

Continued from A2 (freeze INTACT, payroll 545, attendance 138 — all re-verified
before any change). Architecture: **`docs/ATTENDANCE_ARCHITECTURE.md` §3G**.

### What was built
- **Correction policy** (`attendance_correction_policies`): effective-dated per
  legal entity — correction window + unit, late-correction allowance and whether
  it needs the dedicated higher approval, evidence requirement (and extra
  evidence once payroll is finalized), plus exception thresholds. **No window is
  hardcoded**; 3/5/7 days exist only as fixtures and an opt-in migration flag.
- **Correction & void requests** (`attendance_corrections` +
  append-only `attendance_correction_actions`): DRAFT → SUBMITTED →
  UNDER_REVIEW → APPROVED → APPLIED, with REJECTED / CANCELLED, the
  VOID_REQUESTED → VOID_REVIEWED → VOID_APPROVED → VOIDED path, and
  PENDING_PAYROLL_REVIEW → QUEUED_FOR_PAYROLL / PAYROLL_REJECTED.
- **Record version chain** (`attendance_entry_versions`, append-only): v1 is the
  record as originally written, every approved correction appends the next
  version, a void appends a VOID version. `timesheet_entries` keeps
  UNIQUE(employee_id, work_date) — a payroll invariant — so the chain lives
  beside it rather than as extra rows.
- **Exception engine** (`attendance_exceptions`): ten detection types, all
  thresholds from policy and relative to the resolved A2 schedule. Detection
  never modifies attendance; re-scanning never duplicates an open exception.
- **Payroll impact + queue** (`attendance_payroll_adjustments`): four
  classifications, a mandatory Payroll Officer gate, and a hand-off row carrying
  TIME deltas only.
- **Immutable audit**: A1's `attendance_events` widened with role snapshot,
  permission used, target, result and delta — plus record history, approval
  history and actor activity history, all entity-scoped.
- **Seven permission modules** and a new **Supervisor** role; new page
  `public/koreksi-absensi.html` (inbox, requests, exception center, payroll
  impact, audit center, policy).

### Locks held
- **Finalized payroll is never edited, reopened or recalculated.** A financial
  correction over a FINALIZED run stops at a TIME delta that a Payroll Officer
  must approve into the queue; the frozen source row is untouched and
  attendance never writes the monetary `payroll_adjustments` row.
- **Requester ≠ approver**, on stable user ID. No override permission unlocks
  it; `attendance_sensitive_override` is granted to no role, Director included.
- **Nothing is hard-deleted.** Void keeps the row; cancelled and rejected
  requests are kept; audit rows, approval history and version snapshots are
  append-only at the database level.
- **Audit VIEW never implies APPROVE**, and role snapshots make history
  immune to later promotions.
- **No money in attendance**: a test greps the A3 libraries and the queue's own
  columns for monetary terms.

### Bugs found and fixed during A3
1. **A payroll guard test caught a seed edit**: `tests/phase2i.test.js` pins the
   exact Director-grant exclusion pattern for the payroll overrides. Adding the
   attendance override into that same array broke it; the exclusion is now a
   second, separate filter, so the payroll control stays literally intact.
2. **Post-approval refresh leaked a 403**: the correction page reloaded the
   payroll-impact panel after any action, so an HRD approver saw "Access denied"
   instead of their successful approval. Panels the actor cannot read are now
   neither loaded nor shown.
3. Test fixtures exposed that a correction on a **rest day** resolves with no
   schedule (worked minutes cannot be derived) — correct behaviour, documented,
   and the suite now uses real working days.

### Database changes (additive, idempotent)
6 new tables, 4 nullable `timesheet_entries` columns, 10 nullable
`attendance_events` columns, 6 append-only triggers, and the supporting
indexes. Nothing dropped, renamed or re-typed; no payroll table altered.
`npm run migrate:attendance-a3` is idempotent and **invents no correction
policy** (`--seed-policy <ENTITY> [days]` optionally creates one example).

### Tests
- New `tests/attendance-a3.test.js` — **55 passing** against the real server:
  policy versioning and historical resolution, the full correction and void
  lifecycles, SoD and the role matrix, late corrections and evidence, all four
  payroll-impact classifications, the finalized-payroll protection and Payroll
  Officer gate, exception detection and lifecycle, audit immutability, role
  snapshot across a promotion, approval/record/actor histories, audit scope,
  the money-free scope lock, and the migration.
- A1 55 and A2 83 unchanged. Payroll regression **545 / 545**, freeze **INTACT**
  (NOTE on shared `init-db.js`, `seed.js`, `server.js`).
- **Total attendance 193 · total project 738.**
- Scale (1,600 employees, ~1,700 audit rows): exception scan 100 rows ≈ 12 ms,
  1,500 rows ≈ 110–143 ms, approval inbox ≈ 19–36 ms, exception list ≈ 13 ms,
  audit list (500) ≈ 16–21 ms, actor history ≈ 13 ms.

### Frozen files changed
None.

### Remaining attendance gaps (next phases)
Evidence is metadata only — no file upload/storage; no ESS (a worker cannot
raise their own correction); project/workfront still not a security boundary
(`user_project_scope` unenforced, HRD employee dropdown unscoped); no bulk or
CSV correction import and no audit EXPORT file (the permission exists, the
export does not); actual break punches; tolerance enforcement; leave master;
device integrations (MANUAL only); the monetary side of a queued adjustment is
deliberately NOT built — it is a payroll action. Attendance freeze NOT declared.

## DB-M1 — SQLite → PostgreSQL (2026-09-21 → 22) — **PASS · CP1–CP6 DONE · new authoritative development baseline**

Living record: **`docs/DB_M1_POSTGRES_MIGRATION.md`**. Architecture: `docs/DATABASE_ARCHITECTURE.md`.

- A3 baseline re-verified on a clean unzip before any change: A1 55 · A2 83 · A3 55 ·
  payroll 545 · total 738 · freeze INTACT.
- **FROZEN PAYROLL DEPENDENCY DETECTED and reported**: 44 of 48 frozen files are bound to
  synchronous `node:sqlite`. Kamal approved **Option A — controlled infrastructure
  re-baseline** (persistence only; no sync shim, no dual-write, no split authority).
- Rollback baseline preserved: A3 zip sha256 `173fed1e…e6ba36`; the V1 SQLite freeze lock and
  manifest are kept read-only in `docs/freeze-history/`.
- 48 frozen files classified: 4 PURE FORMULA (must stay byte-identical — guarded by
  `npm run check:payroll-pure`), 28 DB-COUPLED, 16 TEST-ONLY.
- CP1 delivered: canonical async layer `database/db.js` (pg.Pool, AsyncLocalStorage
  transactions, bounded retry), versioned migrations `database/pg/` (63 tables + sessions,
  125 indexes incl. 31 partial-unique, 100 CHECKs, 117 FKs, 30 triggers + 4 TRUNCATE guards),
  owner/runtime role separation, isolated PG test harness, `tests/dbm1-foundation.test.js`
  **45/45 on PostgreSQL 16.15**.
- **CP2 (done):** the application, seed, sessions and all 19 suites now run on PostgreSQL only;
  no runtime file imports `node:sqlite`. 28 DB-coupled frozen files converted — 24 purely
  mechanically (async/await, `RETURNING id`, fixed dialect substitutions), 4 with 14 hand-edited
  SQL lines, two of which replace SQLite-only bare-column GROUP BY queries
  (`payrollPeriod.getGroupMembership`, `payrollPayment` payable query) and MUST be scrutinised
  by the CP3 parity harness. 16 payroll + 3 attendance suites ported mechanically; a
  numeric-literal comparison shows no expected business/monetary value changed.
  On PostgreSQL 16.15: payroll **545/545**, attendance **55 + 83 + 55 = 193/193**, DB-M1 **45/45**.
  Pure formula files: 4/4 byte-identical to the V1 SQLite lock.
- **CP3 (done): BUSINESS OUTPUT DIFF = ZERO.** Golden Payroll Parity Harness (`tools/parity/`):
  unmodified A3 suites on SQLite vs ported suites on PostgreSQL, complete final state compared —
  282,764 rows / 5,164,797 values / 40 tables, 7 regenerated bank files, 181 targeted fields: 0
  differences. The harness caught and I fixed three defects in my own CP2 SQL (earliest-assignment
  row in `getGroupMembership`, earliest-run entity in `getPayableEmployees`, missing ORDER BY in
  `getBlockingSummary`). Only wall-clock values and surrogate ids are masked; the list is in the
  migration record. Four unordered `LIMIT 1` probes reviewed: order cannot change any outcome.
- **Payroll freeze re-baselined AFTER zero diff:** `PAYROLL_CORE_STABLE_V1_POSTGRES`
  (`docs/PAYROLL_CORE_FREEZE.lock.json`). Logic UNCHANGED · persistence SQLITE→POSTGRESQL · pure
  formula files BYTE IDENTICAL · old SQLite freeze PRESERVED in `docs/freeze-history/`.
  `check:payroll-freeze` is meaningful again; `check:payroll-pure` stays as the permanent formula guard.
- **CP4 (done): one-way data migration** `database/pg/migrate-from-sqlite.js` — read-only source
  (sha256 verified), preflight that REPORTS AND BLOCKS (never normalises), FK-derived order, one
  transaction with per-table savepoints, historical ids preserved, identity reset to
  GREATEST(max(id), sqlite_sequence), reconciliation before COMMIT (row counts + sha256 of every
  table + 18 history invariants + orphan scan), ledger table `data_migrations` (migration 0004),
  rerun refused on a non-fresh destination. Three real A3 sources migrated: 8,083 / 48,673 /
  49,214 rows — difference 0 and content match on all 63 tables; smoke 25/25, 27/27, 6/6.
  New suite `tests/dbm1-datamigration.test.js` 32/32. Runbook: `docs/POSTGRES_MIGRATION_RUNBOOK.md`.
  No production SQLite file exists yet, so none was migrated — preflight + dry-run are mandatory on the real one.
- Pre-existing A3 behaviour preserved and flagged (not a DB-M1 change): with several assignment
  rows in one group and period, the members API shows only the earliest row's dates; payroll
  itself uses only the employee id and is unaffected.
- Malformed legacy dates: none found; the A1 malformed-date scan moves to the CP4 SQLite-source
  pre-flight (report + block, never normalise).
- Known cost: the 1,500-employee payroll suites are much slower over a client/server
  connection than in-process SQLite (full payroll regression ≈ 13 min here). CP5 item.
- Project/Workfront scope: unchanged — PARTIAL / NOT ENFORCED.
- **CP6 (done) — `docs/DB_M1_FINAL_REPORT.md`.** `pg_dump` → fresh database → `pg_restore` proven IDENTICAL on three databases (up to
  4,731,892 rows: structure, enabled triggers, sequences, privileges, every row; runtime-role protections re-checked) —
  `npm run db:verify-backup`. Failure injection through the real server: a fault at any late step of attendance create, OT decision or
  correction approve→version→apply→audit leaves NOTHING behind. **Defect found and fixed:** a connection dying inside a transaction
  crashed the Node process (pg-pool guards only idle clients) — `withTransaction` now owns the client's errors. Server survives the loss
  of every connection without restart. PostgreSQL-only runtime is test-enforced; no SQLite fallback. New suite `tests/dbm1-cp6.test.js` 15/15.
  `START_KAHE360.bat` made PostgreSQL-aware (NOT testable in the Linux sandbox — verify on Windows).
- **CP5 (done) — `docs/DB_M1_PERFORMANCE_REPORT.md`.** 12-month profiles 100 / 1,500 / 4,000 / 6,000 workers (6,000 = 4.65 M rows, 1.3 GB)
  generated, migrated with the CP4 tool and reconciled. Rush hour on the 6,000 profile: 1,500 / 4,000 / 6,000 clock-ins, ≈ 95–108 events/s,
  0 % errors, 0 deadlocks, 0 lock waits, duplicates refused, pool never above its max (≈ 15× the 15-minute need). Reads at 6,000 workers:
  index-driven endpoints < 30 ms p99; unpaginated lists grow linearly (A4 item). Reconciliation rewritten to chunked/bounded memory
  (≈ 560 MB flat). One evidence-based index (`0005`: audit by employee 339 → 5 ms p50). Exception scan 8,922 → 1,953 statements.
  **Concurrency defect found and closed:** async PostgreSQL had removed SQLite's implicit write serialisation (12 simultaneous correction
  decisions all accepted). `middleware/writeSerializer.js` (default ON) restores A3 write semantics for ALL write paths incl. frozen
  payroll, without editing them; correction transitions are additionally state-guarded. New suite `tests/dbm1-cp5.test.js` 16/16.
  Payroll N+1 measured (524,735 statements / 1,500 employees) — frozen code, deliberately NOT fixed. Frozen payroll files NOT modified.
  Project/Workfront = PARTIAL / NOT ENFORCED.
- **NEXT (needs explicit approval, NOT started): A4 — Attendance Operations.** Open decisions carried forward: payroll N+1 fix and
  statement-level guards for the 31 frozen payroll transitions (both = frozen-code changes), pagination of list endpoints, optional
  `ORDER BY id` on three example-row probes.
  (`BUSINESS OUTPUT DIFF = ZERO`) → only then the PostgreSQL freeze manifest.

## PARTIAL — intentionally deferred, not bugs

- Payroll Rule Set tab: no UI to edit a draft's individual TER/overtime
  rows one at a time (only whole-rule-set clone + top-level rate edit).
  Fine for now since draft creation already clones the correct current
  table; editing single brackets would go through the API directly if
  ever needed before the UI catches up.
- JKK Risk Class: no UI to edit a version's `source_note` after creation
  (only reprice, which is correct — history must never be mutated).

## NEXT — not started

- **Payroll Calculation Engine** — the actual payslip generator. Reads:
  `employee_payroll_assignments` (who, legal entity, work pattern, PTKP) +
  `payroll_rule_sets`/`ptkp_ter_rates`/`overtime_multiplier_rules` (active
  rule set) + `jkk_risk_classes` (via the employee's legal entity) +
  `timesheet_entries` (work hours, approved overtime hours, and — once
  overtime is properly day-typed — which of the employee's overtime hours
  fall on a workday vs weekly-rest/holiday) from Timesheet & Absensi +
  `employees`/contract data from HRD & Kontrak. Produces a payroll run +
  per-employee payslip, likely replacing the static "Penggajian & BPJS"
  mockup page with a live one.
  - Phase 0 (B3/B4/B5/B6), Phase 1A (B1) and Phase 1B (B2) are all DONE.
    **Next step is a architecture re-audit, NOT the engine.**
  - RESOLVED in Phase 1B: `timesheet_entries` now records — the Calculation Engine will need to derive this by joining
    `timesheet_entries.work_date` against `holidays` and the employee's
    `work_patterns.weekly_rest_day`, or Timesheet & Absensi needs a small
    addition first. Decide this at DISCUSS time for that module.
- **Rencana Penugasan** (manpower planning) — deferred earlier; needed
  before Operasi Tenaga Kerja's Workforce Flow / Gap Operasional / 7-day
  projection panels can go live with real data.

## Architecture locks (do not revisit without explicit approval)

- Node/Express/PostgreSQL via `pg` + the canonical layer `database/db.js` (DB-M1; was `node:sqlite` through A3), bcryptjs, express-session.
- One page per module (`public/<name>.html/.js`), shared shell via
  `page-shell.js`/`app.js`, permission-gated page route in `server.js`.
- Payroll Configuration specifically: one page + tabs for the UI, but every
  domain keeps its own table/route file on the backend — never collapse
  the 8 domains into one table or one router file.
- Every config-domain write goes through `lib/configAudit.js`
  (`config_audit_log`) — don't invent a second audit mechanism.
- Rules (BPJS %, PPh21 TER, overtime multipliers, JKK rates) live in the
  database, versioned by `effective_date`, never hardcoded in application
  code.
- JKK risk is set per Legal Entity, never per individual employee.
- Overtime multiplier is day-type- and pattern-aware (workday vs
  weekly-rest/holiday × 5-day vs 6-day week) per PP 35/2021 Pasal 31 — never
  a flat multiplier.

## Attendance A4 — CP1: Attendance Period + Closing Policy foundation (2026-09-21)
Status: **ACCEPTED AND LOCKED (2026-09-21)** — do not modify CP1. CP2 NOT STARTED. Full design: `docs/A4_ATTENDANCE_PERIOD_CONTROL.md`.
* Migration `0006_attendance_period_foundation.sql`: 5 PostgreSQL-native tables, 5 FKs, 22 row triggers + 5 no-truncate
  triggers; no existing table altered, no trigger on any existing table, `timesheet_entries` untouched.
* API: `/api/attendance-periods` (VIEW/CREATE/EDIT) and `/api/attendance-closing-policies` (VIEW/CREATE/EDIT/ADMIN);
  language-neutral `{error, detail}`; actor only from the session (transaction-local DB context).
* Lifecycle in CP1: create → OPEN ⇄ REVIEW only; READY_TO_CLOSE/CLOSED/FROZEN not enabled; no reopen.
* Regression rule: historical 846 (Payroll 545 + Attendance A1–A3 193 + DB-M1 108) all PASS + A4 CP1 71 PASS.
* Payroll freeze intact: 0/48 frozen files changed; Payroll semantics unchanged.
* **Locked evidence:** historical 846/846 + CP1 71/71 = **917/917 PASS, 0 FAIL**; Payroll freeze INTACT; pure Payroll 4/4
  byte-identical; frozen Payroll files changed 0/48; migrations 0001–0006 clean; 0006 checksum
  `7b5a675d55246ae292843db6fc4b809dd6b2ec2c97b8affd18b2b20fa5c276b4`; tree diff 6 created / 10 modified / 0 unexpected;
  PostgreSQL only, no SQLite fallback, no dual-write; rollback proof: unmodified DB-M1 foundation 45/45 on the reversed
  schema; ID | EN unchanged.
* **Approved amendments (part of the locked contract):**
  1. Contract BOOLEAN flags are `BIGINT` 0/1, NOT NULL, database-constrained to {0,1}.
  2. Defaults: `sod_waiver_blocks_freeze` 1, `require_waiver_reason` 1, `require_waiver_evidence` 0, `waivable` 0,
     `evidence_required` 0.
  3. Rule semantics: only BLOCKER rules take part in waivers — `severity = 'BLOCKER' OR (waivable = 0 AND
     evidence_required = 0)`; `evidence_required = 0 OR waivable = 1`.
  4. `GET /api/attendance-periods/:id/payroll-periods` also requires `payroll_run:VIEW`.
  5. A4 namespace catch-all 404 returns `{error: 'NOT_FOUND', detail: {}}` (A4 prefixes only).
  6. `database/pg/migrate-from-sqlite.js` line 90 (source-table detection) intentionally unchanged.

## Attendance A4 — CP2: Readiness engine + READY_TO_CLOSE gate (2026-09-22)
Status: **ACCEPTED AND LOCKED (2026-09-22)**. CP3 NOT STARTED. Design: `docs/A4_ATTENDANCE_PERIOD_CONTROL.md` §10–20.
* Migration `0007_attendance_readiness.sql`: 1 table, 2 FKs, 1 index, 3 row + 1 no-truncate trigger, 3 functions,
  2 CP1 functions replaced; 0006 untouched; no trigger on `timesheet_entries`.
* Day-level MISSING_ATTENDANCE; accounted-void provenance; entity conflict in both directions; batch attribution with a
  proven equivalence contract; live A3 detector evaluation; REVIEW ⇄ READY_TO_CLOSE gated by `attendance_readiness:APPROVE`.
* Regression rule: 917 protected (846 historical + 71 CP1) + all CP2 tests PASS; hard performance gates
  1,500 × 31 ≤ 30 s and 6,000 × 31 ≤ 60 s.
* Locked evidence: protected 917/917 + CP2 58/58 = **975/975 PASS, 0 FAIL** (new protected baseline and regression floor);
  batch equivalence 2310 evaluated / 2229 compared / 81 ambiguous / 0 mismatch, reordering → identical fingerprint;
  performance 1,500 × 31 lib 12,228 ms / HTTP 11,757 ms, 6,000 × 31 lib 49,159 ms / HTTP 46,658 ms (both PASS);
  Payroll freeze INTACT, pure 4/4, frozen 0/48; 0001–0007 CLEAN, 0007 checksum
  `7a49369f28e4ec93e5a42de3896fa5e8d3665af631bf8561c86a48bf3e4ff5fe`, 0006 unchanged
  (`7b5a675d55246ae292843db6fc4b809dd6b2ec2c97b8affd18b2b20fa5c276b4`); tree diff 3/12/0; PostgreSQL only, no SQLite
  fallback, no dual-write; rollback proof PASS; bilingual ID | EN unchanged.
* Technical debt (recorded, not scheduled): the 6,000 × 31 preview issues 309,100 SQL queries (frozen per-pair
  expected-day helpers dominate). Passes the approved ≤ 60 s gate; not to be optimized without a separate approval.

## TALENT & WORKER V1 — CP1 ACCEPTED AND LOCKED (2026-09-22)
Status: **ACCEPTED AND LOCKED (2026-09-22)** — do not modify CP1. CP2 NOT STARTED. Attendance A4 CP3 NOT STARTED.
Design: `docs/TALENT_WORKER_V1_ARCHITECTURE.md`.
* Isolated bounded context: schema `talent`; own migration stream `database/pg/talent/migrations/TW0001_*` with ledger
  `talent.schema_migrations` (core stream and number 0008 untouched); explicit least-privilege runtime grant manifest
  in `database/pg/talent/migrate-talent.js` (`database/pg/migrate.js` untouched); own backup verifier
  `tools/talent/verify-backup-restore.js` (`tools/dbm1/verify-backup-restore.js` untouched).
* Existing login/session reused; Talent grants in `talent.role_permission` via `database/seed-talent.js` for existing
  roles only (workforce_manager, hrd_officer, operations_director VIEW-only); no ALL_ACTIONS inheritance; print/PDF/
  download/security-admin granted to nobody. Field security FULL/MASKED/HIDDEN (fail-closed), data scope (ALL only),
  `talent.audit_event` (metadata only, append-only). No Payroll/Attendance/OT/BPJS integration — reported NOT_CONNECTED.
* Routes: `/api/tw/*`, `/tw/app/*`. Light KAHE GROUP INDONESIA shell; logo `public/tw-assets/kahe-group-indonesia-logo.png`
  byte-identical to the uploaded master (sha256 `68bd292b8728c0407f3cd5f8603a1a0beb952c68f4d21922fbe166f948940ed5`).
* **Regression floors:** protected **975** (DB-M1 108 · Attendance A1–A3 193 · A4 CP1 71 · A4 CP2 58 · Payroll 545);
  Talent CP1 **91** (`npm run test:talent-cp1`).
* **Locked evidence:** protected 975/975 + Talent CP1 91/91 = **1,066/1,066 PASS, 0 FAIL**; A4 CP2 performance gates
  PASS (1,500 × 31 lib 12,829 ms; 6,000 × 31 lib 48,570 ms); **Payroll freeze INTACT** (0/48 frozen files drifted),
  pure 4/4 byte-identical; **core migrations 0001–0007 checksums unchanged** (0006 `7b5a675d…`, 0007 `7a49369f…`),
  core ledger exactly 0001–0007; public schema objects identical with and without Talent; A4 CP1/CP2 files unchanged;
  dark portal `public/` files 39/39 unchanged; Talent backup/restore VERIFIED; rollback (TW0001.down.sql) proof PASS.
* Tree diff vs A4 CP2 locked baseline: 21 created / 7 modified (`server.js` mount only, `package.json` scripts only,
  `docs/MASTER_SPEC.md`, `docs/RBAC_MATRIX.md`, `docs/UI_LOCKS.md`, `README_DEVELOPMENT.md`, this file) / 0 deleted /
  0 unexpected. Shared-file freeze note for `server.js` is expected (mount only).

## EMERGENCY REGISTRATION V0 — ACCEPTED AND LOCKED (2026-09-22)
Status: **ACCEPTED AND LOCKED (2026-09-22)** — Talent public registration P01–P04 + EMERGENCY REGISTRATION INTAKE V0
(internal list/CSV, not P05). **Full CP2 NOT STARTED.** Attendance A4 CP3 NOT STARTED. Details:
`docs/TALENT_EMERGENCY_REGISTRATION_V0.md`.
* Routes: `/register/*`, `/api/public/tw/register/*` (public, mounted before the write serializer),
  `/tw/emergency-intake`, `/api/tw/emergency-intake/*` (permission `tw_emergency_intake` VIEW/EXPORT — Workforce Manager
  and HRD only; scope ALL; CSV audited `EXPORT_CSV`).
* Migrations: Talent stream TW0001 (unchanged, sha256 `bb4f51b6c4acf5c648a9cc3ef08901bea877521b6c8b7d4d64657a111d7851d6`) + TW0002
  (sha256 `e129e20d40a4f73ccb72722a2b63cfb87a3c5b4a61ee7183e0c97cdd60521968`): `talent.registration`, `talent.registration_document`
  (runtime INSERT/SELECT only), audit event `EXPORT_CSV`. Rows default `EMERGENCY_V0` / `NEW` / `PENDING`;
  `worker_uuid` NULL until verification. Rollback `TW0002…down.sql` refuses while data exists.
* Uploads: private `uploads/talent-registration/` (outside `public/`, git-ignored, dir 0700 / files 0600, random names,
  no download route) — back up with the database; never include in source snapshots.
* **Regression floors:** protected **975** (DB-M1 108 · Attendance A1–A3 193 · A4 CP1 71 · A4 CP2 58 · Payroll 545);
  Talent CP1 **91**; Emergency Registration V0 **51** (`npm run test:talent-registration-v0`).
* **Locked evidence:** protected 975/975 + Talent CP1 91/91 + V0 51/51 = **1,117/1,117 PASS, 0 FAIL**; final smoke
  15/15 PASS; **Payroll freeze INTACT** (0/48), pure 4/4; core migrations 0001–0007 checksums unchanged (0006 `7b5a675d…`,
  0007 `7a49369f…`); TW0001 unchanged; schema public identical to a core-only database; dark portal `public/` files
  39/39 unchanged; CP1 shell files unchanged; tree unchanged during the regression run.
* Tree diff vs Talent CP1 locked: 15 created / 11 modified (docs, `server.js` mounts, `package.json` script, and four
  CP1 files changed because V0 required them: grant manifest, seed-talent permission, audit event list, CP1 test
  version-pinned expectations — CP1 count still 91) / 0 deleted.
* Deployment note (not configured yet): rate limits key on the TCP peer. Direct/LAN single server: correct. Behind a
  reverse proxy / Cloudflare: must be re-keyed to the trusted client IP (exact `trust proxy` hops or proxy IP list)
  before internet exposure, together with HTTPS and secure cookies.

## EMERGENCY REGISTRATION V0 — INTERNET DEPLOYMENT HARDENING — ACCEPTED AND LOCKED (2026-09-22)
Status: **ACCEPTED AND LOCKED (2026-09-22)**. Deployment hardening only: no business field, page, migration or
permission changed. **Full CP2 NOT STARTED.** Responsive QA NOT STARTED. Attendance A4 CP3 NOT STARTED.
Guide + operator runbook: `docs/DEPLOYMENT_INTERNET_V0.md`.
* Trusted proxy: `KAHE_TRUST_PROXY` (unset/`off` = direct mode, no proxy trusted, X-Forwarded-* ignored; `<hops>`;
  or proxy IP/CIDR/keyword list; garbage refuses to start) replaces the hard-coded `trust proxy 1`
  (`lib/deploymentConfig.js`, `server.js`). Public rate limits key on the validated `req.ip` (IPv6 on /64); login
  limiter and audit IPs follow the same validated value.
* Sessions: HttpOnly + SameSite=Lax always; Secure forced in production (`KAHE_COOKIE_SECURE=false` refused), opt-in in
  development. Production refuses to start without a real ≥32-char `SESSION_SECRET` and an explicit `KAHE_TRUST_PROXY`.
* Readiness: `GET /api/public/tw/register/health` → `{ service, status }` only. P01–P04 send a scoped strict CSP
  (`register.html` has no inline script/style); portal-wide Helmet config unchanged. Proxy body limit documented 24 MB;
  application limits unchanged. Private storage, no download route, backup = database + upload directory (runbook §6).
* **Regression floors:** protected **975** (DB-M1 108 · Attendance A1–A3 193 · A4 CP1 71 · A4 CP2 58 · Payroll 545);
  Talent CP1 **91**; Emergency Registration V0 **51**; Internet Hardening **25** (`npm run test:talent-hardening-v0`).
* **Locked evidence:** 975/975 + 91/91 + 51/51 + 25/25 = **1,142/1,142 PASS, 0 FAIL**; Payroll freeze INTACT (0/48),
  pure 4/4; core migrations 0001–0007 unchanged (0006 `7b5a675d…`, 0007 `7a49369f…`); TW0001 (`bb4f51b6…`) and TW0002
  (`e129e20d…`) unchanged; no new migration; schema public identical to core-only; dark portal `public/` 39/39
  unchanged; CP1 shell files and V0 views/assets unchanged; tree unchanged during the run.
* Tree diff vs V0 accepted: 3 created (`lib/deploymentConfig.js`, `docs/DEPLOYMENT_INTERNET_V0.md`,
  `tests/talent-hardening-v0.test.js`) / 8 modified (`server.js` trust-proxy + cookie policy + production fail-fast;
  `modules/talent/routes/publicRegister.js` limiter key + `/health`; `publicRegisterPages.js` scoped CSP;
  `.env.example`, `package.json` script, `README_DEVELOPMENT.md`, `docs/MASTER_SPEC.md`,
  `docs/TALENT_EMERGENCY_REGISTRATION_V0.md`) / 0 deleted / 0 unexpected. Shared-file freeze note for `server.js` expected.
* Remaining before go-live (operator, not code): HTTPS certificate + proxy config per the guide, production `.env`,
  upload directory outside the web root, backup job for both parts, readiness monitoring; single app process for the
  public form (in-memory limit store).

## EMERGENCY REGISTRATION V0 — RESPONSIVE QA ACCEPTED AND LOCKED (2026-09-22)
Status: **ACCEPTED AND LOCKED (2026-09-22)**. Responsive layout/touch patch for public P01–P04 only. **Full CP2 NOT
STARTED.** Attendance A4 CP3 NOT STARTED.
* Implementation: **only `public/tw-assets/register.css` changed** (appended "Responsive QA patch" block, sha256
  `e592bb0feb02…`): touch targets ≥ 44 px on tablet/phone, mobile-first single column with compact hero (phone portrait and
  short landscape), 16 px form text on phones (no focus zoom), full-width actions, copyable registration ID, upload
  drop zone contains its hidden input. No HTML, JS, field, validation, upload/security, RBAC or schema change.
* Verification (real headless Chromium 131, real server + database, full P01→P04 flow incl. upload and submit):
  **14/14 viewports PASS, P01–P04 PASS on every viewport** — desktop 2560×1440, 1920×1080, 1440×900, 1366×768;
  tablet 1024×768, 768×1024; phone 430×932, 412×915, 390×844, 375×812, 360×800, 320×568; landscape 844×390, 932×430.
  Checks: no horizontal scroll, nothing clipped/outside viewport, one column on phones, hero ≤ 30 % of height,
  readable non-overlapping stepper, logo aspect exact, header controls not overlapping, ID/EN usable, touch targets,
  skill chips wrap, long file names wrap inside the drop zone, validation errors wrap, submit reachable with a
  simulated open keyboard, P04 registration ID readable/selectable, no hover-dependent content, no fixed positioning.
  **Desktop 4/4 sizes pixel-identical** to the Internet-Hardened baseline.
* **Regression floors:** protected **975** (DB-M1 108 · Attendance A1–A3 193 · A4 CP1 71 · A4 CP2 58 · Payroll 545);
  Talent CP1 **91**; Emergency Registration V0 **51**; Internet Hardening **25**.
* **Locked evidence:** 975/975 + 91/91 + 51/51 + 25/25 = **1,142/1,142 PASS, 0 FAIL**; Payroll freeze INTACT (0/48),
  pure 4/4; core migrations 0001–0007, TW0001 (`bb4f51b6…`) and TW0002 (`e129e20d…`) unchanged; schema public
  identical to core-only; dark portal `public/` 39/39 unchanged; CP1 shell files, V0 business/security files and
  hardening files unchanged; tree unchanged during the run.
* Tree diff vs Internet-Hardened locked: 0 created / 2 modified (`public/tw-assets/register.css`, this file) / 0 deleted.
* Known limits: verified in Chromium only (Safari/iOS and Firefox on real devices not yet checked); the on-screen
  keyboard is simulated by a reduced viewport height; native date/select pop-ups are drawn by the OS; long file names
  wrap rather than truncate; the P04 status pill wraps to two lines at ≤ 390 px; the hero photo is still not shipped
  (no approved hero asset).
