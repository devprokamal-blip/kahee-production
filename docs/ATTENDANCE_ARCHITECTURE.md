# KAHE 360 — Timesheet & Attendance Architecture

_Established in Attendance Hardening A1, extended by A2 and A3 — Configurable
Work Schedule, Shift, Custom Work Pattern, Break & Time Engine (2026-09-20).
Attendance is NOT production-frozen; this document records the locks every
later attendance phase must respect._

---

## 1. The pipeline (locked)

```
WORK PATTERN           weekly / custom weekly / rotating cycle / date roster
      ↓                (configurable, effective-dated — A2)
WORK SCHEDULE (SHIFT)  expected period, breaks, normal minutes, OT boundary
      ↓                (configurable, effective-dated, versioned — A2)
EMPLOYEE ASSIGNMENT    pattern + default shift + project/workfront, as-of date
      ↓
ACTUAL ATTENDANCE      clock-in / clock-out / presence events   → timesheet_entries
      ↓
OVERTIME WORKFLOW      request → approve / reject (terminal)    → timesheet_entries.overtime_*
      ↓
ATTENDANCE VALIDATION  authoritative INTEGER MINUTES             (A1: guards; full engine later)
      ↓
PAYROLL SNAPSHOT       lib/asOfResolver.js reads timesheet_entries   [FROZEN core]
      ↓
PAYROLL CORE           converts validated minutes into money          [FROZEN core]
```

- **Attendance supplies time, never money.** No multiplier, rate or rupiah
  value may appear in attendance code. Monetary overtime stays in the frozen
  Payroll Core (`lib/time.overtimePaySen`, `overtime_multiplier_rules`).
- **Payroll never reconstructs attendance from schedule clock times.** It
  consumes the validated minutes Attendance hands it.
- Example hand-off: `work_minutes = 480`, `overtime_minutes_approved = 120`,
  `day_type = WORKDAY`.

## 2. Integer time (locked)

Canonical time is **integer minutes** (`lib/time.js`, frozen). Hour columns
are display mirrors rewritten from minutes. Verified by the A1 suite:
0.1 h = 6, 0.25 h = 15, 0.5 h = 30, 7.25 h = 435, 8 h = 480. A1 bounds a
single day's minutes to 0–1440.

## 3. Configurable schedules — IMPLEMENTED in A2

Nothing about working hours is hardcoded. A schedule is a row, not a constant.

### 3.1 Work Schedule / Shift master — `work_schedules`
Effective-dated versions per `code` + legal entity (one OPEN version each,
enforced by two partial unique indexes — SQLite treats NULLs as distinct).
Fields: code, name, legal entity, project, free-text `schedule_type`,
`clock_in`, `clock_out`, `standard_work_minutes`, `cross_midnight`,
`overtime_eligibility_rule` + `overtime_delay_minutes` /
`overtime_eligible_from`, status, `effective_from` / `effective_to`, and full
created/updated audit columns.

OFFICE 08:00–17:00, SITE-DAY 07:00–16:00, SITE-NIGHT 20:00–05:00,
SECURITY 07:00–19:00 / 19:00–07:00 are **fixtures in tests and an opt-in
migration flag**, never defaults in code. `npm run migrate:attendance-a2`
invents no schedule for an existing workforce.

### 3.2 Breaks — `work_schedule_breaks`
**Zero, one or many** per schedule version. Each has a name, optional
start/end, `duration_minutes`, `is_paid`, sequence and active flag. Unpaid
breaks are deducted from worked time; paid breaks are not. No break duration
appears anywhere in code. Actual break PUNCHES are a later phase: they will be
a separate `attendance_break_events` table, so the schedule model does not
change when they arrive (`SCHEDULED BREAK` vs `ACTUAL BREAK EVENT`).

### 3.3 Work patterns — `attendance_work_patterns` + `attendance_pattern_days`
`pattern_type` is the ONLY enum: `FIXED_WEEKLY`, `CUSTOM_WEEKLY`,
`ROTATING_CYCLE`, `DATE_BASED_ROSTER`. Every SHAPE is data in
`attendance_pattern_days`, one row per slot:

| Pattern type | `day_index` | Shape comes from |
|---|---|---|
| FIXED_WEEKLY / CUSTOM_WEEKLY | 1–7 (1 = Monday) | seven rows, each WORK or OFF with its own optional shift |
| ROTATING_CYCLE | 1..`cycle_length_days` | `cycle_length_days` rows + `cycle_start_date` anchor + `repeats` |
| DATE_BASED_ROSTER | — | explicit rows in `attendance_roster_dates` |

So 5/2, 6/1, 4/2, 6/2, 7/7, 14/7, 21/7, 2 DAY / 2 NIGHT / 2 OFF, "Wednesday
off but Saturday and Sunday on", and any arbitrary cycle are the same code
path. **No enum value is ever added for a roster shape.** Each working day
references its own shift, so Friday can be a night shift and Saturday a short
one.

**A rotating roster without `cycle_start_date` is REFUSED** (400
`MISSING_CYCLE_ANCHOR`). Without an anchor the cycle day cannot be known, and
guessing it would mis-roster a whole crew.

### 3.4 Date roster and date override
- `attendance_roster_dates` — explicit per-date assignment, for a pattern or
  for one employee. A `DATE_BASED_ROSTER` date with no row resolves to OFF
  (reported as a warning) rather than silently becoming a workday.
- `attendance_date_overrides` — an audited exception with a mandatory reason:
  a normally OFF day becomes WORK (with a shift), or a working day becomes
  OFF. It **never rewrites the base pattern** (proven by test: other employees
  on the same pattern are unaffected) and is reversible by deactivation.

### 3.5 Employee assignment — `attendance_schedule_assignments`
Effective-dated per employee: pattern, optional default shift, project,
workfront. A new assignment CLOSES the open one the day before, so October
keeps resolving October's pattern after November's is assigned. Any other
overlap (a range landing inside an existing closed period) is refused with
`ASSIGNMENT_OVERLAP` rather than resolved by guesswork.

This is deliberately separate from `employee_payroll_assignments`: that one
answers "which payroll regime", this one answers "which working rhythm".

## 3A. RESOLUTION PRECEDENCE (locked, deterministic)

`lib/workSchedule.resolveSchedule(db, employee, date)`:

```
1. DATE OVERRIDE (employee)          -> WORK/OFF + shift   [audited, has a reason]
2. DATE OVERRIDE (pattern)
3. ROSTER DATE (employee)
4. ROSTER DATE (pattern)
5. ROTATING_CYCLE slot               (from cycle_start_date; never guessed)
6. FIXED_WEEKLY / CUSTOM_WEEKLY day  (ISO weekday 1..7)
7. LEGACY fallback: payroll work_patterns.weekly_rest_day
```
Which SHIFT applies, in order: the date-level row's shift (override / roster)
→ the pattern DAY's shift → the assignment's default shift → the pattern's
default shift.

**Day TYPE is never decided here.** It comes from the canonical (frozen)
`lib/dayClassification.js`; the pattern only tightens WORKDAY vs
WEEKLY_REST_DAY. A PUBLIC / COMPANY / SUBSTITUTED holiday always wins, so a
holiday worked under an override stays a holiday — an attendance setting can
never soften a payroll multiplier. Ambiguity is reported
(`AMBIGUOUS_ASSIGNMENT`, `MISSING_CYCLE_ANCHOR`, `MISSING_PATTERN_DAY`,
`MISSING_SCHEDULE`), never guessed; a configuration defect refuses the
attendance write with `SCHEDULE_NOT_RESOLVED`.

## 3B. Worked minutes, cross-midnight and overtime eligibility

- **Derivation** (`deriveWorkedMinutes`): elapsed = clock-out − clock-in
  (crossing midnight when the schedule allows it); worked = elapsed − unpaid
  breaks; plus `late_minutes`, `early_leave_minutes` and
  `worked_after_shift_minutes`. All integers, all minutes.
- Worked minutes are DERIVED whenever a schedule is resolved; a supplied
  `work_hours` is then ignored and reported back as
  `supplied_work_minutes_ignored`. With no schedule (legacy employees) the
  recorded figure is used, because there are no break rules to apply.
- **Cross-midnight**: one row per shift, keyed on the START date (the Phase 1B
  model boundary). `clock_out_date` records the actual end date. A negative
  span is refused (`NEGATIVE_DURATION`); month and year boundaries are tested.
- **Overtime eligibility is configuration**: `AFTER_SHIFT_END`,
  `AFTER_DELAY` (shift end + n minutes), `FIXED_TIME`, or `NOT_ELIGIBLE`.
  **Eligible is not payable.** Clocking out late produces
  `worked_after_shift_minutes` for review and `overtime_minutes_approved = 0`
  until the A1 request → decision workflow approves it. A `NOT_ELIGIBLE`
  shift refuses overtime requests outright.

## 3C. Timezone authority

`lib/businessTime.js` is the only place the business timezone exists
(`Asia/Jakarta`, overridable with `KAHE360_TZ`). It provides `businessToday()`,
clock arithmetic and UTC-safe date maths. The old UTC bug — between 00:00 and
07:00 WIB everything resolved to *yesterday* — is closed: default list/summary
dates, the future-date guard and the UI's "today" all come from here, and
`/api/work-schedule/context` exposes it so no page derives its own.

Storage: `work_date`, effective dates and cutoffs are date-only strings
compared lexicographically; clocks are local `HH:MM` plus `clock_out_date`;
audit stamps stay UTC `datetime('now')` because an audit trail wants an
absolute instant.

## 3D. Historical immutability

Each attendance row snapshots its resolved expectation (`work_schedule_id`,
`schedule_code`, scheduled clocks and minutes, break minutes, day status,
resolution source, OT boundary, and a full `schedule_snapshot` JSON). Editing
a row re-derives against ITS OWN snapshot, never today's configuration. A
schedule version already referenced by attendance cannot have its times or
breaks changed (`trg_work_schedule_used_is_immutable` /
`trg_work_schedule_break_immutable`); correcting a schedule means a new
version, exactly as payroll configuration works.

## 3E. Payroll interface (unchanged contract, richer inputs)

`payrollTimeContract()` hands payroll TIME only: `work_date`, `day_type`,
`work_schedule_id`, `schedule_code`, `scheduled_minutes`, `work_minutes`,
`overtime_minutes_approved` (0 unless approved). A test greps
`lib/workSchedule.js` for money terms and fails on any hit. Payroll keeps
every monetary rule — multipliers, BPJS, PPh21, salary, deductions — and never
reconstructs attendance from schedule clock times.

## 3F. The original A1 architecture lock (now implemented — kept for the record)

No working hours are hardcoded anywhere in attendance. `08:00–17:00` or any
other schedule is **data**, never code. The model is effective-dated and
supports, without code changes:

| Concern | Must be configurable |
|---|---|
| Times | scheduled clock-in / clock-out, standard daily minutes |
| Breaks | **zero, one or many** breaks per schedule; each with start, end, duration, paid/unpaid, effective date |
| Overtime | `overtime_eligible_from` (may equal shift end, or later — e.g. 16:00 vs 16:30), grace / waiting period |
| Tolerance | late-arrival and early-departure tolerance |
| Shape | cross-midnight / overnight shifts, rotating patterns, 5-day / 6-day patterns, weekly rest day, holiday treatment |
| Assignment | employee, project and workfront assignment, `effective_from` / `effective_to` |

Examples such as OFFICE 08:00–17:00, SITE NIGHT 20:00–05:00 (cross-midnight)
or SECURITY 07:00–19:00 are **illustrations, not defaults**.

**History is never re-priced:** assigning SHIFT-B from 1 Nov must not change
October. The same versioning discipline as payroll configuration applies
(close the old version, open the new, never edit history).

**Eligible ≠ payable.** Being past `overtime_eligible_from` makes minutes
*eligible*. Only the workflow makes them *payable*:
`ELIGIBLE → REQUESTED → APPROVED/REJECTED → actual attendance → VALIDATED minutes → payroll`.

Existing building blocks A2 reuses rather than duplicating:
`work_patterns`, `work_calendars`, `holidays`, `lib/dayClassification.js`
(day TYPE only, never value). A cross-midnight shift is currently classified
by its START date (Phase 1B model boundary, asserted by test).

## 3G. A3 — CORRECTION, VOID, EXCEPTION, PAYROLL IMPACT, AUDIT

### 3G.1 The principle
**Nothing historical is ever silently overwritten, and nothing is ever hard-deleted.**
A wrong record is corrected through a request that is reviewed, decided by
someone other than the requester, and applied as a NEW version — or voided,
which keeps the row and stops it counting.

```
ATTENDANCE RECORD -> exception / error spotted
  -> CORRECTION or VOID REQUEST (reason code + reason, evidence per policy)
  -> RBAC + entity scope + SoD
  -> REVIEW -> DECISION
  -> NEW EFFECTIVE VERSION            (open period)
  -> PAYROLL IMPACT ASSESSMENT
       finalized payroll + financial change
         -> TIME DELTA -> PAYROLL OFFICER APPROVAL -> ADJUSTMENT QUEUE
```

### 3G.2 Correction policy — configurable, effective-dated
`attendance_correction_policies`. No correction window exists in code: 3, 5 or
7 days are seed examples. Per legal entity (optionally project): window +
unit, whether late corrections are allowed, whether they need the dedicated
higher approval, evidence requirement, extra evidence once payroll is
finalized, and the exception thresholds (abnormal-duration ratio, OT grace,
OT mismatch tolerance). Versions are effective-dated and resolved AS OF the
work date — a January policy never re-judges a December correction, and two
policies covering the same date are reported `AMBIGUOUS_POLICY`, never guessed.

### 3G.3 Versioning — why the chain is a separate table
`timesheet_entries` carries `UNIQUE(employee_id, work_date)`: a payroll
invariant. A corrected day therefore cannot become a second row. The chain
lives in append-only `attendance_entry_versions` (v1 = the record as
originally written, materialised on first correction; each approved
correction appends the next version; a void appends a VOID version). The
timesheet row keeps only the EFFECTIVE values payroll reads, plus
`record_status`, `current_version`, `last_correction_id`, `void_correction_id`.
Version snapshots cannot be updated or deleted — two triggers enforce it.

### 3G.4 What may be corrected
`clock_in`, `clock_out`, `clock_out_date`, `attendance_status`,
`absence_reason`, `workfront`, `shift`, `entry_source`, `note`. Derived
payroll-authoritative values (`work_minutes`, elapsed, late/early, OT) are
NEVER accepted from the client: they are recomputed from the corrected source
values against the row's OWN A2 schedule snapshot. Overtime remains the A1
workflow — a correction never rewrites a terminal OT decision; it produces a
delta to be assessed.

### 3G.5 Lifecycle
Correction: `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → APPLIED`, with
`REJECTED` / `CANCELLED`, and `PENDING_PAYROLL_REVIEW → QUEUED_FOR_PAYROLL` /
`PAYROLL_REJECTED` when payroll is involved.
Void: `VOID_REQUESTED → VOID_REVIEWED → VOID_APPROVED → VOIDED`, or
`VOID_REJECTED`. Cancelled and rejected requests are kept, never deleted.

### 3G.6 Late correction
Past the configured window a request is flagged `is_late_correction`, needs a
`late_reason`, raises a LATE_CORRECTION exception, and — when the policy says
so — its approval additionally requires `attendance_late_correction:APPROVE`.
A policy may forbid late corrections outright (`LATE_CORRECTION_NOT_ALLOWED`).

### 3G.7 Permissions and SoD
Modules: `attendance_correction` (VIEW/CREATE/EDIT/APPROVE/REJECT),
`attendance_void`, `attendance_late_correction` (APPROVE),
`attendance_exception` (VIEW/EDIT), `attendance_payroll_impact`
(VIEW/APPROVE/REJECT), `attendance_audit` (VIEW/EXPORT), and
`attendance_sensitive_override` — granted to NO role, Operations Director
included.

Defaults: Supervisor requests and approves nothing; Workforce Manager reviews,
approves, approves late corrections and voids; HRD Officer reviews and
approves corrections and late corrections but may only REQUEST a void;
Payroll Officer cannot edit raw attendance or approve an attendance
correction, and owns the payroll-impact gate; Operations Director holds the
modules but is not exempt from SoD.

**The requester can never decide their own request** — checked on stable user
ID, so renaming a role changes nothing, and no override permission unlocks it.
The approval inbox only lists what the actor may act on, and never their own.

### 3G.8 Payroll impact
`NO_PAYROLL_IMPACT` (nothing payroll reads changed: `work_minutes`,
`overtime_minutes_approved`, `day_type`, `attendance_status`),
`PAYROLL_IMPACT_OPEN_PERIOD` (apply to the live record),
`PAYROLL_IMPACT_FROZEN_PERIOD` (a frozen snapshot exists: the source is NOT
touched), `PAYROLL_ADJUSTMENT_REQUIRED` (a FINALIZED payroll run covers the
day).

For the last two the correction stops at `PENDING_PAYROLL_REVIEW`: the
corrected version is recorded but not applied, and a Payroll Officer must
approve. On approval a row lands in `attendance_payroll_adjustments` carrying
TIME only — `delta_work_minutes`, `delta_overtime_minutes`, the source period
and run, the attendance approval reference. **Finalized payroll is never
edited, reopened or recalculated by attendance, and attendance never writes
the monetary `payroll_adjustments` row — that stays a payroll action in the
frozen core.** The Payroll Officer cannot act before the attendance approval;
attendance cannot bypass the Payroll Officer.

### 3G.9 Exception engine
Detection only — it never modifies attendance. Types: MISSING_CLOCK_IN,
MISSING_CLOCK_OUT, NO_SCHEDULE, OFF_DAY_ATTENDANCE, DUPLICATE_ATTENDANCE (a
cross-midnight row colliding with the next day), ABNORMAL_DURATION,
OT_WITHOUT_APPROVAL, APPROVED_OT_ACTUAL_MISMATCH, LATE_CORRECTION,
PAYROLL_ADJUSTMENT_REQUIRED. Thresholds are policy values relative to the
resolved schedule — there is no "over 12 hours is wrong" rule, because a
12-hour security shift is a real configured schedule. Lifecycle:
OPEN → ASSIGNED → RESOLVED → REOPENED, resolution note mandatory, every step
audited; re-scanning never duplicates an open exception.

### 3G.10 Immutable audit and role snapshot
One trail: A1's `attendance_events`, widened with `actor_role_snapshot`,
`actor_entity_scope`, `permission_used`, `target_type`/`target_id`,
`correction_id`, `exception_id`, `reason_code`, `result`, `delta_values`.
Append-only (A1 triggers), plus append-only `attendance_correction_actions`
for the approval history. Reversing a decision appends a new event; it never
erases the old one.

The actor's authority is stored AS IT WAS: an approval made as Workforce
Manager still reads "Workforce Manager" after that person becomes Operations
Director. Audit VIEW never implies approval, and an actor without approval
authority sees only their OWN activity — the Supervisor default. Everything
is entity-scoped.

Views: record history (`/entries/:id/history`), actor activity
(`/audit/actors/:userId`), approval history (per request), and the filtered
Audit & Activity Center.

## 4. Write rules enforced since A1

All in `routes/timesheet.js` + `lib/attendanceGuard.js`, which **compose**
the canonical authorities and re-implement none of them.

| Rule | Authority reused | Result |
|---|---|---|
| Period cutoff | `payrollPeriod.resolvePeriodForDate` + `isStreamOpen` | `409 ATTENDANCE_PERIOD_CLOSED` / `OVERTIME_PERIOD_CLOSED` |
| Frozen payroll input | `payroll_input_snapshots.status = 'FROZEN'` (read only) | `409 ATTENDANCE_SOURCE_FROZEN` + DB triggers |
| Eligibility on the work date | `employeeEligibility.isEligibleOn` | `409 EMPLOYEE_NOT_ELIGIBLE` (+ reason) |
| Entity scope | `entityScope.scopeClause` / `assertEntityAccess` | lists filtered in SQL; foreign id → `404` (audited) |
| OT decisions terminal | route + conditional UPDATE | `409 OVERTIME_DECISION_CONFLICT`, `OVERTIME_ALREADY_DECIDED`, `NO_PENDING_OVERTIME_REQUEST` |
| Generic edit cannot undo a decision | route | `409 OVERTIME_DECISION_LOCKED` |
| Requester ≠ decider (by user id) | route | `403 SOD_VIOLATION` |
| Approve vs reject | `timesheet_absensi:APPROVE` / `:REJECT` | `403 FORBIDDEN` |

**Cutoff policy on `isStreamOpen` answers:** `PERIOD_CLOSED` and
`PAST_CUTOFF` refuse. `PERIOD_NOT_OPEN` (DRAFT) and "no period resolvable"
remain writable — attendance happens daily, before payroll opens the period,
and Phase 2A materialises a year of DRAFT periods. A FROZEN snapshot refuses
regardless of period status, because a period can be reopened after freezing.

**Frozen lock is structural.** Triggers `trg_attendance_frozen_update /
_delete / _insert` refuse any change to a payroll-source column
(`PAYROLL_SOURCE_COLUMNS` in `database/attendance-schema.js`) of a row covered
by a FROZEN snapshot, even via raw SQL. Metadata (note, workfront, identity
columns) stays writable so backfills never trip it.

## 5. Identity and audit

- New nullable columns on `timesheet_entries`: `legal_entity_id` (entity ON
  THE WORK DATE), `entry_source`, `recorded_by_user_id`, `updated_by_user_id`,
  `overtime_requested_by_user_id`, `overtime_requested_at`,
  `overtime_decided_by_user_id`. Legacy `*_by` columns remain as readable
  labels; **no security decision reads them.**
- `attendance_events` is append-only (update/delete triggers): every create,
  update, OT request and decision with actor id, old and new values.
  It is the foundation for the future correction workflow (old value, new
  value, who, when, reason, source, approval).

## 6. Sources (reserved, not integrated)

`MANUAL, WEB, QR, RFID, FINGERPRINT, FACE, MOBILE, API_IMPORT`. A1 writes
`MANUAL` only, set by the server — a client cannot claim a device source.
**No device, biometric, GPS or RFID integration exists.**

## 7. Project / workfront scope — honest status

`user_project_scope` exists and is loaded into `userContext.projectScope`,
but no module enforces it and attendance has no project assignment model
(workfront is a free-text label from a hardcoded list). A1, A2 and A3 enforce
**legal-entity** scope only.

A2 adds `project_code` and `workfront` COLUMNS to
`attendance_schedule_assignments`, so an assignment can record where the
worker is rostered — but they are descriptive, not a security boundary: no
route filters by them, and `user_project_scope` is still unenforced. Making
project a real scope means scoping employees, attendance, schedules and the
HRD employee list together; that is a phase of its own and was deliberately
not faked here.

## 8. A4 — Attendance Period Control (CP1 foundation)
Design and contract: `docs/A4_ATTENDANCE_PERIOD_CONTROL.md`. Summary:
* **Attendance Period** (`attendance_periods`) — scoped by Legal Entity; non-overlapping inclusive ranges per entity
  (guarded under a `legal_entities` row lock, READ COMMITTED only); statuses OPEN · REVIEW · READY_TO_CLOSE · CLOSED ·
  FROZEN, of which CP1 enables only create → OPEN and OPEN ⇄ REVIEW (REVIEW → OPEN requires a reason).
* **Closing Policy** (`attendance_closing_policies` + `_rules`) — effective-dated per entity; DRAFT → ACTIVE → ENDED,
  DRAFT → DISCARDED; never deleted; as-of resolution; no default policy.
* **Audit** — `attendance_period_events`, `attendance_closing_policy_events`: append-only, written only by triggers,
  actor from the transaction-local session context.
* **Relationship to A1–A3** — CP1 reads nothing from and writes nothing to `timesheet_entries`, corrections or
  exceptions; A1 entry, A3 correction/void/exception behave exactly as before. The period lock on attendance rows
  arrives in CP5, keyed on each row's own `legal_entity_id`.
* **Relationship to Payroll** — derived N:M mapping only (same entity, overlapping dates, `straddles` flag,
  coverage gaps); no Payroll file or Payroll semantics change. Frozen `lib/asOfResolver.js` continues to read
  `timesheet_entries` directly.

## 9. A4 CP2 — Readiness engine
Readiness reads A1–A3 state and never writes it: expected employee-days from frozen eligibility + A2 `resolveSchedule`,
live A3 detection (`detectForEntry` / `findOverlap`, unmodified), correction and exception lifecycles, and entity attribution
through one batch query equivalent to `attendanceGuard.entityForEmployeeOn`. A1 creates rows only manually, so there is no
dense-row invariant: day-level MISSING_ATTENDANCE is required. A3 never auto-closes exceptions (only manual resolve), so
open exception rows are references, not blockers; RESOLVED suppresses a live finding only when resolved after the row's
last change. READY_TO_CLOSE is an as-of assertion; attendance remains editable until the CP5 lock. Full contract:
`docs/A4_ATTENDANCE_PERIOD_CONTROL.md` §10–20.
