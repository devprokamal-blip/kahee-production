# Payroll Engine — Re-Audit After Phase 0 / 1A / 1B

_Re-audit date: 2026-09-14. Audit only — nothing was implemented._
_Supersedes the readiness verdict in `docs/PAYROLL_ENGINE_AUDIT.md`; that
document's architecture blueprint (sections C–I) still stands._

Evidence below is from reading `PROJECT_CHECKPOINT.md`, `database/init-db.js`,
`lib/{money,employeeEligibility,salaryStructure,dayClassification,configAudit}.js`,
all nine `routes/payroll-config/*` files, `routes/timesheet.js`, the three
migration scripts and the three test suites (77 tests, all passing), plus six
probes run against `node:sqlite` — marked **[verified]** where a claim is a
reproduced fact rather than a reading.

---

## A. B1–B6 CLOSURE STATUS

### B1 — Salary Components: **CLOSED**

| Requirement | Evidence |
|---|---|
| Explicit earning/deduction components | `salary_components.component_type` CHECK('earning','deduction'); invalid values rejected **[verified]** |
| BPJS base selection | `is_bpjs_base` flag; `getBasesOn().bpjsBaseSen` sums only flagged rows — test shows Rp9.5jt of Rp11.1jt gross |
| Overtime base selection | `is_overtime_base`, same mechanism, independently settable |
| Taxable configuration | `is_taxable` + optional `tax_rule_ref` pointer |
| Prorating | `is_proratable` per component |
| Effective dating | `effective_from`/`effective_to` on both master and assignment |
| Mid-period changes | `/change-amount` closes + reopens in one transaction; 14/16-day split **[verified]** |
| Employee salary structure | `employee_salary_components`, many components per employee, ordered by `calculation_order` |
| Historical safety | A March query still returns the March amount after a June raise **[verified]** |

Nothing Indonesian is hardcoded: every behavioural flag is per-component data.
`lib/salaryStructure.js` is the sole resolver.

### B2 — Day-Type Classification: **CLOSED**

| Requirement | Evidence |
|---|---|
| WORKDAY / WEEKLY_REST_DAY / PUBLIC_HOLIDAY | All three plus COMPANY_HOLIDAY and SUBSTITUTED_HOLIDAY |
| Precedence | `DAY_TYPE_PRECEDENCE` constant; holiday-on-rest-day → PUBLIC_HOLIDAY **[verified]** |
| 5-day / 6-day patterns | Both, plus a non-Sunday rest day, all tested |
| Effective-dated calendars | `work_calendars` with `effective_from`/`effective_to`; a superseded calendar is refused, not silently reused |
| Project / legal-entity calendars | Scope chain assignment → entity → global; entity holiday does not leak to other entities **[verified]** |
| Historical snapshot | `timesheet_entries.day_type*`; a holiday declared later does NOT alter an existing row **[verified]** |
| No multiplier hardcoding | A test greps `lib/dayClassification.js` and fails if any multiplier token appears |

Ambiguity is flagged (`dayType: null` + status), never defaulted. Overtime on an
unclassifiable day is refused with 409.

### B3 — Monetary Precision: **PARTIAL**

Closed for **money**: all amounts are integer sen, all rates/multipliers integer
basis points, `applyBp()` keeps operations in integer space and rounds half-up
exactly once, `roundHalfUp` is symmetric for negatives. Overflow headroom is
adequate — Rp1.5bn/month at the top TER band is 5.1e14 against a safe limit of
9.0e15 **[verified]**.

**Not closed for quantities that multiply into money.** `timesheet_entries`
still stores `work_hours`, `overtime_hours_requested` and
`overtime_hours_approved` as **REAL**. Overtime pay is
`hourly_rate_sen × hours × multiplier`, so a float hour contaminates an
otherwise-exact chain:

```
7.25h × rate = 33526008.25      not an integer
2.1h  × rate =  9710981.700000001
0.1h × 10    = 0.9999999999999999   (should be 1)     [verified]
```

The original audit scoped B3 to "money columns" and these were out of scope at
the time because nothing multiplied them. The engine will. See **N1**.

### B4 — Transaction Safety: **PARTIAL**

Closed for **atomicity within one connection**: `withTransaction(db, fn)` wraps
every multi-statement write (rule-set create ~130 rows, rule-set activate, JKK
reprice, assignment supersession, component revise, amount change). Rollback is
proven by deliberate-failure tests in all three suites. Nesting correctly joins
the outer boundary — an inner commit does not escape an outer rollback
**[verified]**, using `node:sqlite`'s native `db.isTransaction`.

**Not closed for concurrency.** `getDb()` never sets `busy_timeout`, so it is
**0** **[verified]**: a second writer fails *immediately* with
`ERR_SQLITE_ERROR` rather than waiting **[verified]**. Today that is nearly
invisible because writes are small and rare. A payroll run holding a write
transaction over thousands of rows would make every concurrent timesheet or
config write fail outright. There is also no retry anywhere. See **N2**.

### B5 — Database Invariants: **CLOSED**

Seven partial unique indexes now enforce what was application-only:
`uq_payroll_assignment_open_per_employee`, `uq_payroll_rule_set_single_active`,
`uq_jkk_open_per_risk_class`, `uq_holiday_national_per_date`,
`uq_emp_salary_component_open`, `uq_salary_component_open_global`,
`uq_salary_component_open_scoped`, plus `uq_work_calendar_open_code`.
All are proven violation-rejecting by test. Violations surface as **409
CONFLICT** through the global handler, not 500.

Range-overlap on *closed* windows is checked in application code
(`findOverlappingAssignment`) because SQLite cannot express range exclusion —
this is a documented and tested compensating control, not a gap.

Residual (non-blocking, carried forward): `legal_entities` still has no
`effective_to` **[verified]** — an entity's risk class is mutated in place by
`PUT`. This matters for historical re-derivation, but the engine's snapshot
(section C) records the resolved JKK rate at calculation time, which contains
the blast radius. Flagged, not blocking.

### B6 — Employee Eligibility: **CLOSED**

`lib/employeeEligibility.js` is the sole authority. Precedence is explicit and
tested: termination_date → start_date → status → PKWT contract window → payroll
assignment. Joiner boundary (not payable H-1, payable on start day), leaver
boundary (payable ON the termination date, not after), inactive-without-
termination, contract lapse, and missing assignment each return a *named*
reason the Exception Engine can map to a specific code.
`getEligibilityForPeriod()` returns contiguous payable segments — joiner 21/30,
leaver 20/30, mid-period assignment change → two segments **[verified]**.

---

## B. NEW BLOCKERS DISCOVERED

Only two. Both are narrow, both must be fixed before engine code is written,
and both would be expensive to retrofit afterwards.

### N1 — Time quantities are floating-point (extends B3)

`work_hours`, `overtime_hours_requested`, `overtime_hours_approved` are REAL.
They are the multiplicand in every overtime amount, so the exactness won in
Phase 0 stops at the moment hours enter the calculation. Storing **integer
minutes** (`*_minutes`) makes the whole chain integer:
`rate_sen_per_hour × minutes × multiplier_bp / (60 × 10000)`, rounded once.

Blocking because: fixing it after payslips exist means migrating financial
records, and because the 0.5h increments the UI offers today are exactly the
values that expose the problem at scale.

### N2 — No `busy_timeout`, no retry: concurrent writes fail hard

`busy_timeout` is 0 and nothing retries. A long payroll-run transaction would
cause immediate `SQLITE_BUSY` failures for any concurrent write — a supervisor
saving attendance during a payroll run would simply get an error.

Blocking because: it dictates how the engine must execute (chunked, bounded
transactions rather than one long one), which is an engine-architecture
decision, not a later optimisation.

**Explicitly NOT new blockers** (they are engine scope, listed in C/D):
payroll period/run tables, snapshots, exception model, bank details, entity
scoping. Those are things to *build*, not defects to *fix*.

---

## C. PAYROLL ENGINE READINESS

| Area | Status | Note |
|---|---|---|
| Payroll period model | **MISSING** | No `payroll_periods`, no cutoff, no open/closed state |
| Payroll run identity | **MISSING** | No `payroll_runs`, no run number |
| Employee eligibility snapshot | **READY (source)** | `getEligibilityForPeriod()` produces exactly what a snapshot needs; the snapshot table itself is engine scope |
| Salary structure snapshot | **READY (source)** | `getStructureSegments()` + per-component flags |
| Attendance/timesheet snapshot | **PARTIAL** | Rows exist and are day-classified, but hours are REAL (N1) and `work_hours` is frequently NULL in live data → must become an exception, not a zero |
| Overtime snapshot | **READY (source)** | day_type snapshot + approved hours + rule band mapping; blocked only by N1 |
| BPJS rule snapshot | **READY (source)** | Versioned rule set + JKK by entity, resolvable as-of |
| Tax rule snapshot | **READY (source)** | 122 TER brackets tied to a rule-set version; PTKP category derived |
| Calculation traceability | **MISSING** | No `payroll_snapshots` table yet — design is in the original audit §E |
| Recalculation strategy | **MISSING** | State machine designed (§F) but not modelled |
| Approval/finalization state machine | **MISSING** | Pattern proven twice (contract, overtime); not applied to runs |
| Duplicate payroll prevention | **MISSING** | Needs `UNIQUE(period_id, run_number)` and `UNIQUE(run_id, employee_id)` |
| Reversal / correction | **MISSING** | |
| Exception model | **MISSING** | Every input path now returns a *named* failure reason, which is the hard prerequisite and is DONE |
| Idempotency | **MISSING** | No run-level idempotency key |
| Concurrency | **RISK** | N2 |
| Payslip source data | **READY** | Component line items exist — this was the single biggest gap in the first audit and is now closed |
| Payment readiness | **MISSING** | No bank_name / account / account_name on `employees`; no payment batch |

Two further carry-forwards from the first audit, unchanged and still
non-blocking: multi-entity data isolation (`user_project_scope` scopes by
project, not legal entity) and the December Pasal 17 annual reconciliation.

---

## D. REQUIRED PRE-ENGINE CHANGES

**Must fix first (Phase 0B — small, mechanical):**

1. **N1.** Add `work_minutes`, `overtime_minutes_requested`,
   `overtime_minutes_approved` as INTEGER; migrate existing REAL hours
   (×60, rounded half-up); retain the old columns as Phase 0 did; route all
   reads through a helper. Add an `hoursToMinutes`/`minutesToHours` pair to
   `lib/money.js` or a sibling so the conversion has one owner.
2. **N2.** Set `PRAGMA busy_timeout` in `getDb()` (5000 ms is a reasonable
   start) and add a bounded retry for `SQLITE_BUSY` around write paths.
   Document that the engine must use **chunked** transactions per employee
   batch, never one transaction spanning a whole run.

**Then, as engine scope (not prerequisites):** `payroll_groups`,
`payroll_periods`, `payroll_runs`, `payroll_run_lines`,
`payroll_run_line_components`, `payroll_snapshots`, `payroll_adjustments`,
`payroll_exceptions`, `payroll_run_events`, payment batch tables, the
`payroll_run` / `payroll_payment` permission modules, `user_legal_entity_scope`,
and bank fields on `employees`. Schema detail is in the original audit §D.

---

## E. RECOMMENDED IMPLEMENTATION PHASES

| Phase | Scope | Why this order |
|---|---|---|
| **0B** | N1 + N2 only. No features. | Both are load-bearing for everything after; both are cheap now and expensive later. |
| **2A** | `payroll_groups` + `payroll_periods` + open/close + `payroll_run` permission module | Gives the engine something to anchor to; independently testable. |
| **2B** | As-of **resolver** + `payroll_snapshots` writer. **No calculation.** | Testable in isolation: feed a date, assert it returns the right rule-set/JKK/assignment/structure/day-type versions. This is the traceability guarantee. |
| **2C** | Calculation core, dry-run only: eligibility → attendance → overtime → earnings → BPJS → tax → gross/net. Writes Draft/Calculated. | No approval, no finalisation, no payment. Chunked execution per N2. |
| **2D** | Validation + Exception engine (codes from original audit §G) | Depends on 2C producing numbers to validate. |
| **2E** | Approval + Finalization + immutability lock | Reuses the proven two-step EDIT→APPROVE pattern. |
| **2F** | Payslip, rendered strictly from snapshot | |
| **2G** | Adjustments, retro, reversal | |
| **2H** | Payment batch + bank file (needs bank fields) | |
| **2I** | Scale hardening at 1k/5k employees; `user_legal_entity_scope` | |

---

## F. TEST GATES FOR EACH PHASE

Each gate must pass before the next phase starts. Every phase additionally
re-runs the existing 77 tests.

- **0B** — hours round-trip exactly (0.1h×10 == 1.0h in minutes); overtime pay
  from integer minutes is exact and reconciles; a second concurrent writer now
  *waits* instead of failing; migration of existing REAL hours is idempotent
  and lossless.
- **2A** — period cannot overlap within a group; a closed period rejects new
  runs; cutoff respected; RBAC 403 for non-payroll roles.
- **2B** — resolver returns the version in force for the period, **not** the
  latest; snapshot captures rule-set id, JKK rate, TER bracket, assignment,
  component set, day types; a config change after snapshot does not alter it.
- **2C** — the 7 normal + 14 edge cases from the original audit §I, notably:
  period straddling a rule-set activation uses the *period's* rules; mid-period
  salary change produces two prorated segments; overtime on each day type hits
  the right band; BPJS caps applied; each TER category correct.
- **2D** — every exception code fires on its trigger; BLOCKING codes stop
  progression past Validated; WARNING codes do not.
- **2E** — recalculation allowed in Calculated/Validated, refused in
  Finalized/Paid; un-approve is permissioned and audited; duplicate run and
  duplicate employee-in-run both rejected by constraint.
- **2F** — payslip line items sum exactly to stored gross/net; a finalized
  payslip is byte-identical after a later rule-set activation.
- **2G** — reversal creates a new run and preserves the original; retro from a
  closed period lands in the next open period.
- **2H** — sum of all net equals the bank batch total exactly; missing bank
  details blocks at payment only.
- **2I** — 1,000-employee run completes without timeout or event-loop
  starvation; entity-scoped user cannot read another entity's run.

---

## VERDICT

**NOT READY — BLOCKERS REMAIN**

The picture has changed substantially. Of the six original blockers, **four are
fully closed (B1, B2, B5, B6)** and the remaining two are closed for everything
they were originally scoped to cover. The single biggest structural gap in the
first audit — no salary component model, which would have forced an engine
rewrite — is gone, and payslip source data is now READY.

What remains are two narrow, mechanical defects (**N1** float hours, **N2** no
busy_timeout/retry), both found by probing rather than by reading, and both in
the same class as the original B3/B4: cheap to fix now, expensive to retrofit
once financial records exist. N2 in particular shapes how the engine must
execute, so it cannot be deferred to a later optimisation pass.

Recommendation: execute **Phase 0B only** — it should be materially smaller
than Phase 0 was — then proceed to 2A without a further full re-audit.
