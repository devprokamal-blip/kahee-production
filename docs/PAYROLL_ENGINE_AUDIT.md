# Payroll Calculation Engine — Architecture Audit & Blueprint

_Audit date: 2026-09-14. Audit only — no engine code written.
Scope: assess whether the existing KAHE 360 codebase is structurally ready
for a production-grade, multi-entity / multi-subcontractor payroll engine._

Findings below are based on reading `database/init-db.js`,
`routes/payroll-config/*`, `routes/hrd.js`, `routes/timesheet.js`,
`middleware/permissions.js`, `lib/configAudit.js`, and `PROJECT_CHECKPOINT.md`,
plus four empirical checks run against `node:sqlite` (noted inline as
**[verified]** — these are reproduced facts, not assumptions).

---

## A. CURRENT ARCHITECTURE STATUS

| # | Area | Status | Finding |
|---|---|---|---|
| 1 | Legal Entity / Subcontractor model | **RISK** | Table exists with `entity_type` and `jkk_risk_class`. But the entity's *own* attributes are mutated in place by `PUT /legal-entities/:id` — the row has a single `effective_date` and no `end_date`. Changing an entity's risk class silently rewrites history; a payroll recalculated for January would pick up a risk class set in June. |
| 2 | Employee Payroll Assignment | **RISK** | Supersession-on-insert is implemented correctly in `routes/payroll-config/employee-assignments.js`. But **[verified]** nothing at the DB level prevents two concurrently-open rows (`end_date IS NULL`) for the same employee — the invariant lives only in application code. One bad insert (or a concurrent request) silently yields an ambiguous assignment, and the engine would have no deterministic answer to "which assignment applies?". |
| 3 | Payroll Group | **MISSING** | No table. There is no concept of "this set of employees is paid on this cycle with this cutoff". Currently `employees.pay_cycle` exists only for `harian` workers and is not connected to any period definition. |
| 4 | Salary Components | **MISSING** | `employee_payroll_assignments.base_salary` is a single lump REAL described as "gaji pokok + tunjangan tetap". There is no component breakdown, so the engine cannot distinguish fixed vs variable allowances, cannot mark which components are BPJS-able vs taxable vs neither, and cannot produce a meaningful payslip line-item list. This is the single biggest structural gap. |
| 5 | BPJS Rule Set & JKK versioning | **PASS (with one RISK)** | `payroll_rule_sets` + `jkk_risk_classes` are properly versioned with `effective_date`/`end_date`, activation supersedes correctly, and history is preserved. RISK: no DB constraint stops two rows being `active`/open at once — the "only one active" rule is application-enforced only. |
| 6 | PPh21 / TER configuration | **PASS** | 122 brackets across categories A/B/C, tied to a `rule_set_id` so a PMK update creates a new rule set rather than mutating history. TER category derivation from PTKP status is a pure function. Correct design. Note: TER is the Jan–Nov method only; the December/final-period Pasal 17 recalculation is not modelled (see Blockers). |
| 7 | Overtime Rule Engine | **PASS (config) / RISK (input)** | The multiplier table is correctly day-type- and pattern-aware (workday, rest_or_holiday_5day, rest_or_holiday_6day) with hour ranges. The *rules* are right. The *input* is not — see #12. |
| 8 | Work & Holiday Calendar | **RISK** | Both tables exist. Two defects: (a) **[verified]** `UNIQUE(date, scope, project_code)` does **not** prevent duplicate national holidays, because SQLite treats NULLs as distinct in a UNIQUE constraint and `project_code` is NULL for all national rows — a double-seeded or double-entered holiday would double-count in day-type resolution. (b) `work_patterns` is a global list, not bound to an entity or project; the link to an employee exists only through the assignment row. |
| 9 | Effective dating & version history | **RISK** | Good on `jkk_risk_classes`, `payroll_rule_sets`, `employee_payroll_assignments`. Absent on `legal_entities` (see #1), `work_patterns` (has `effective_date` but no `end_date`/supersession), and `holidays` (no versioning at all — a deleted holiday is simply gone). |
| 10 | Audit trail | **PASS** | `config_audit_log` + `lib/configAudit.js` is a clean, reusable, domain-agnostic pattern with before/after JSON snapshots. Extend it for payroll-run events rather than inventing a second mechanism. |
| 11 | Permissions / role access | **PASS (with one gap)** | Server-side RBAC is properly enforced (`requirePermission`), never trusting frontend menu state; ADMIN correctly gates rule-set activation and JKK repricing. Gap: there is no `payroll_run` permission module yet, and no separation between "may calculate" and "may approve" — needed for segregation of duties (see #24). |
| 12 | Attendance / timesheet integration readiness | **RISK — this is a blocker** | `timesheet_entries` records `overtime_hours_approved` as a single number with **no day-type**. The overtime rule engine needs to know whether those hours fell on a workday, a weekly rest day, or a public holiday, and the multiplier is *progressive per hour within the day*. The engine can derive day_type by joining `work_date` against `holidays` + the employee's `work_patterns.weekly_rest_day`, but that derivation must be decided and pinned now, because it changes the snapshot contract. Secondary gap: `work_hours` is manually entered and frequently left NULL (observed in live use), so "hours actually worked" is not reliably present. |
| 13 | Contract / employment data dependency | **RISK** | `employees` + `employee_contract_history` give start/end dates and status. But `employees.status` is only `active`/`inactive` with no termination date field, and a contract that lapses does not automatically flip status. The engine needs an unambiguous "was this person employed on date X" predicate; today that requires inference across three places. |
| 14 | Payroll period & cutoff architecture | **MISSING** | No `payroll_periods` table, no cutoff dates, no concept of an open vs closed period. Nothing to anchor a run to. |
| 15 | Calculation traceability | **MISSING** | Nothing persists which rule set / JKK version / rate / input produced a given number. Without this, historical payslips would silently change whenever configuration changes — the exact failure mode this whole foundation was built to prevent. |
| 16 | Recalculation & retroactive adjustment | **MISSING** | No run states, no recalculation path, no retro mechanism. |
| 17 | Mid-period salary / contract changes | **MISSING** | Assignment rows are effective-dated, which is the right substrate, but there is no proration logic or segment model to apply two different salaries within one period. |
| 18 | Joiner / leaver prorating | **MISSING** | No proration basis is defined (calendar days vs working days), and no leaver final-pay path. |
| 19 | Manual adjustments | **MISSING** | No table for one-off additions/deductions. |
| 20 | Duplicate payroll prevention | **MISSING** | Nothing prevents the same employee being paid twice in a period, or the same period being run twice. |
| 21 | Payroll locking / finalization | **MISSING** | No lock state; nothing prevents a finalized run from being edited. |
| 22 | Reversal / correction | **MISSING** | No reversal model. |
| 23 | Exception handling | **MISSING** | No exception surface at all. The Home dashboard mockup already *displays* "31 Payroll Exceptions" — that number is currently fictional and must become real. |
| 24 | Approval workflow | **PARTIAL** | A proven two-step `EDIT`→`APPROVE` pattern exists twice in this codebase (contract actions, overtime). Reuse that pattern; it does not yet exist for payroll runs. |
| 25 | Payslip source data | **RISK** | Employee identity, BPJS numbers, and NPWP exist. Missing: the component breakdown (#4) that a payslip's line items *are*. |
| 26 | Payment / bank file readiness | **MISSING** | No bank account, account name, or bank code fields anywhere on `employees` or the assignment. No payment batch model. |
| 27 | Idempotency & concurrency risk | **RISK** | **[verified]** `getDb()` opens a fresh `DatabaseSync` connection per request with WAL and `foreign_keys = ON` — good. But **no route anywhere in the codebase uses a transaction** (no `BEGIN`/`COMMIT`). Existing multi-statement writes (rule-set activation, JKK reprice, assignment supersession) are already non-atomic; a failure between statements leaves inconsistent state. For a payroll run writing thousands of rows this moves from theoretical to serious. |
| 28 | Multi-entity data isolation | **RISK** | `user_project_scope` scopes by *project*, but payroll is organised by *legal entity*. A Payroll Officer scoped to one project can currently read every legal entity's configuration and, once the engine exists, would be able to read every entity's payroll. For a model where KAHE processes subcontractor payroll, this is a confidentiality gap, not just a tidiness one. |
| 29 | Security & payroll confidentiality | **RISK** | Auth, session, bcrypt, helmet, rate limiting, and server-side RBAC are all sound. Two payroll-specific gaps: no field-level protection for salary figures (the existing `FIELD_SCOPE` pattern in `routes/hrd.js` is the right precedent to extend), and no audit of payroll *reads* — for salary data, who looked is often as important as who changed. |
| 30 | Scalability for thousands of workers | **RISK** | Indexes on the hot lookup paths exist. Real concerns: (a) money is stored as REAL/float — **[verified]** float arithmetic produces artifacts (`0.1+0.2 = 0.30000000000000004`), and this codebase has *already* hit a float display bug on BPJS rates; rounding differences across thousands of payslips will not reconcile against bank totals; (b) a run over thousands of employees inside a single synchronous `DatabaseSync` request will block the event loop and exceed HTTP timeouts. |

**Tally:** PASS 4 · RISK 12 · MISSING 13 · PARTIAL 1

---

## B. BLOCKERS BEFORE PAYROLL ENGINE

These must be resolved *before* engine implementation starts. Everything
else in section A can be built as part of the engine phases.

**B1 — Salary Components model (from #4).**
The engine cannot be written against a single `base_salary` lump. Every
downstream step (BPJS base, taxable gross, proration, payslip lines) needs
to know *which* components exist and how each behaves. Building the engine
first and retrofitting components later would mean rewriting the engine.

**B2 — Overtime day-type resolution (from #12).**
Decide and pin: does `timesheet_entries` gain a stored `day_type`, or does
the engine derive it at calculation time from `holidays` + `work_patterns`?
Recommendation: **derive at calculation time and store the derived value in
the snapshot**, so that correcting a mis-entered holiday corrects future
runs without mutating attendance records. Either way the decision must be
made before the snapshot schema is fixed, because it determines what the
snapshot must capture.

**B3 — Monetary precision (from #30).**
Move money off floats before any money is persisted. Store integer minor
units (rupiah, `INTEGER`) or a fixed-scale integer. Retrofitting this after
payslips exist means migrating historical financial records — avoid.
Rates/percentages may stay REAL; *amounts* must not.

**B4 — Transaction boundaries (from #27).**
A payroll run must be atomic. Add transaction support to the existing db
layer (`getDb`) and wrap the already-existing non-atomic multi-statement
writes too. Small change, large blast radius if skipped.

**B5 — Uniqueness invariants (from #2, #5, #8).**
Three invariants currently live only in application code and are
**[verified]** violable at the DB level: one open payroll assignment per
employee, one active rule set, one national holiday per date. Enforce with
partial unique indexes before the engine starts depending on them.

**B6 — Employment-period predicate (from #13).**
Define one authoritative way to answer "was this employee payable on date
X, and for which segment of the period". Needs a termination date and a
clear precedence between `employees.status`, contract dates, and assignment
effective dates.

**Non-blocking but decide early:** legal-entity effective dating (#1),
entity-level data isolation (#28), and the December/final-period Pasal 17
tax reconciliation (#6) — the last can be deferred to a later phase but
should be acknowledged in the data model so it is not painful to add.

---

## C. TARGET PAYROLL ENGINE ARCHITECTURE

The requested flow, with the responsible module for each stage. Backend
domains stay modular (`routes/payroll/*`), UI stays unified.

```
Payroll Period            periods.js      — defines window + cutoff; must be OPEN
  ↓
Eligible Employees        eligibility.js  — employment predicate (B6) ∩ payroll group
  ↓
Contract & Assignment     resolver.js     — resolve effective-dated rows AS OF period
  ↓                                         (may return >1 segment → proration)
Attendance / Timesheet    inputs.js       — days present, work hours, absences
  ↓
Overtime                  overtime.js     — day_type resolution + progressive multipliers
  ↓
Earnings                  earnings.js     — base per segment, prorated
  ↓
Allowances                components.js   — fixed + variable, per component flags
  ↓
Deductions                components.js   — non-statutory (loans, mess, transport)
  ↓
BPJS                      statutory.js    — Kesehatan/JHT/JP/JKK/JKM, caps applied,
  ↓                                         JKK rate via employee → legal entity
Tax                       tax.js          — TER bracket lookup on taxable gross
  ↓
Adjustments               adjustments.js  — manual one-offs + retro from prior periods
  ↓
Gross Pay                 aggregate.js
  ↓
Net Pay                   aggregate.js
  ↓
Validation                validation.js   — rule checks producing exceptions
  ↓
Exception                 exceptions.js   — blocking vs warning
  ↓
Approval                  approval.js     — reuse existing EDIT→APPROVE pattern
  ↓
Finalization              finalize.js     — lock; writes become immutable
  ↓
Payslip                   payslip.js      — renders from the SNAPSHOT, never live config
  ↓
Payment                   payment.js      — batch + bank file export
```

Two architectural rules that govern the whole flow:

1. **Every stage reads configuration through one resolver** that takes an
   as-of date, and every value it returns is written into the snapshot.
   No stage queries a config table directly.
2. **Payslip and payment read only from the snapshot**, never from live
   configuration. This is what makes historical payroll immutable.

---

## D. DATABASE CHANGES REQUIRED

Extensions to the existing modular architecture. Nothing below replaces an
existing table.

**Blocker-clearing (before engine):**

- `salary_components` — component master per legal entity: `code`, `name`,
  `component_type` (earning/deduction), `calculation_type`
  (fixed/formula/variable), `is_bpjs_base`, `is_taxable`, `is_prorated`,
  `effective_date`/`end_date`.
- `employee_salary_components` — per-employee assigned components with
  `amount`, effective-dated. Replaces reliance on the single `base_salary`
  field (keep that column for backward compatibility, migrate reads).
- `employees`: add `termination_date`, `bank_name`, `bank_account_no`,
  `bank_account_name`.
- Partial unique indexes: one open `employee_payroll_assignments` per
  employee; one `active` `payroll_rule_sets`; one open `jkk_risk_classes`
  per risk class; national holiday uniqueness by date.
- Money columns: `INTEGER` minor units on all new amount fields.

**Engine core:**

- `payroll_groups` — pay cycle, cutoff rule, legal entity binding.
- `payroll_periods` — `group_id`, `period_start`, `period_end`,
  `cutoff_date`, `pay_date`, `status`, `UNIQUE(group_id, period_start)`.
- `payroll_runs` — `period_id`, `status` (see F), `run_number`,
  `calculated_at/by`, `approved_at/by`, `finalized_at/by`,
  `UNIQUE(period_id, run_number)`; prevents duplicate runs (#20).
- `payroll_run_lines` — one row per employee per run: gross, net, and the
  aggregate totals. `UNIQUE(run_id, employee_id)` — this is the structural
  guard against paying someone twice (#20).
- `payroll_run_line_components` — line items per employee (earnings,
  allowances, deductions, BPJS, tax), each with component code, amount, and
  which rule produced it. This *is* the payslip.
- `payroll_snapshots` — see section E.
- `payroll_adjustments` — manual one-offs and retro entries, with
  `source_run_id` when retro-originated (#19, #16).
- `payroll_exceptions` — `run_id`, `employee_id`, `code`, `severity`,
  `message`, `resolved_at/by` (#23).
- `payroll_payment_batches` + `payroll_payment_items` — bank file staging (#26).
- `payroll_run_events` — state transitions, reusing the `config_audit_log`
  shape/pattern (#10, #22).

**Access control:**

- New permission modules: `payroll_run` (VIEW/CREATE/EDIT/APPROVE/EXPORT)
  and `payroll_payment`. Keep calculate and approve as separate actions so
  segregation of duties is enforceable (#24).
- `user_legal_entity_scope` — mirrors the existing `user_project_scope`
  pattern to close the multi-entity isolation gap (#28).

---

## E. CALCULATION SNAPSHOT DESIGN

**Principle:** a finalized payroll line must be fully reproducible from
stored data alone, with zero reads of current configuration.

`payroll_snapshots` stores, per run line, a JSON document capturing:

- **Rule identity:** `rule_set_id` + its `effective_date`, `jkk_risk_class`
  row id + rate, `work_pattern_id`, TER `category` and the specific bracket
  row matched (min/max/rate).
- **Resolved rates:** every percentage and cap actually applied — not a
  pointer to them, the values themselves.
- **Inputs:** days present, work hours, overtime hours broken down by
  resolved `day_type` and hour band, the assignment (legal entity, PTKP
  status, components and amounts) as of the period.
- **Derivations:** hourly rate and the divisor used, proration factor and
  its basis, every intermediate subtotal.
- **Provenance:** engine version string, calculated_at, calculated_by.

Rules:

1. Snapshot is written at **Calculated**, rewritten on recalculation while
   the run is still recalculable, and becomes **immutable at Finalized**.
2. Payslip rendering and bank file generation read the snapshot only.
3. A configuration change never touches an existing snapshot. To change a
   finalized past result you must reverse and re-run, leaving both records.

This is the mechanism that makes "historical payroll does not change when
future configuration changes" a structural guarantee rather than a promise.

---

## F. RECALCULATION STRATEGY

```
Draft ──calculate──► Calculated ──validate──► Validated ──submit/approve──► Approved
                          ▲                        │                            │
                          └────── recalculate ─────┘                         finalize
                                                                                │
                                                                                ▼
                                                            Finalized ──pay──► Paid
                                                                 │
                                                          reverse│ (creates a NEW
                                                                 ▼  reversing run;
                                                            Reversed   never edits)
```

| State | Recalculable? | Notes |
|---|---|---|
| **Draft** | n/a | Run created, period + employee set fixed, nothing computed. |
| **Calculated** | **Yes** | Free recalculation. Snapshot overwritten each time. |
| **Validated** | **Yes** | Passed validation; recalculation drops it back to Calculated. |
| **Approved** | **No** | Requires explicit un-approve (permissioned, audited) → back to Calculated. |
| **Finalized** | **No — ever** | Immutable. Corrections only via reversal + new run. |
| **Paid** | **No — ever** | Payment executed. Corrections via retro adjustment in the next period. |

Retroactive changes to a Finalized/Paid period are **never** applied by
editing it. They generate a `payroll_adjustments` entry carrying
`source_run_id`, which flows into the *next* open period's Adjustments
stage. This keeps every historical period reconcilable against what was
actually paid.

---

## G. EXCEPTION ENGINE

Exceptions are produced by `validation.js` and written to
`payroll_exceptions`. Two severities: **BLOCKING** (cannot advance past
Validated) and **WARNING** (advance allowed with acknowledgement).

| Code | Severity | Trigger |
|---|---|---|
| `MISSING_ATTENDANCE` | BLOCKING | No timesheet rows for a payable working day in period. |
| `INCOMPLETE_ATTENDANCE` | WARNING | Rows exist but `work_hours` is NULL — currently common in live data. |
| `MISSING_CONTRACT` | BLOCKING | No valid employment/contract covering the period. |
| `CONTRACT_EXPIRED_MID_PERIOD` | WARNING | Contract lapsed mid-period; proration applied. |
| `MISSING_PAYROLL_ASSIGNMENT` | BLOCKING | No effective assignment as of period. |
| `CONFLICTING_SALARY_ASSIGNMENT` | BLOCKING | >1 open assignment (the invariant B5 protects). |
| `INVALID_BPJS_PROFILE` | BLOCKING | Missing BPJS number where the entity requires it; or no JKK rate resolvable for the entity's risk class as of period. |
| `MISSING_TAX_PROFILE` | BLOCKING | No PTKP status, or gross falls outside all TER brackets. |
| `NO_NPWP` | WARNING | Tax withheld at the higher non-NPWP rate. |
| `OVERTIME_NOT_APPROVED` | BLOCKING | Overtime hours present with `overtime_status != 'approved'`. |
| `OVERTIME_EXCEEDS_LEGAL_CAP` | WARNING | >4h/day or >18h/week on ordinary workdays (PP 35/2021 Pasal 26). |
| `DUPLICATE_PAYROLL` | BLOCKING | Employee already has a finalized line for this period. |
| `NEGATIVE_NET_PAY` | BLOCKING | Deductions exceed gross. |
| `MISSING_BANK_DETAILS` | BLOCKING at Payment only | No bank account for a payable employee. |
| `RATE_VERSION_AMBIGUOUS` | BLOCKING | >1 active rule set, or overlapping JKK versions, as of period. |

---

## H. IMPLEMENTATION ORDER

Small, independently testable phases. Each ends shippable; nothing later
forces a rewrite of anything earlier.

- **Phase 0 — Blocker remediation.** B3 (money as integer minor units),
  B4 (transactions in db layer), B5 (partial unique indexes), B6
  (employment predicate + `termination_date`). No new features. Regression
  pass over HRD & Kontrak, Timesheet, Payroll Configuration.
- **Phase 1 — Salary Components (B1).** `salary_components` +
  `employee_salary_components` + a 7th tab in the existing Payroll
  Configuration page. Reuses the existing modular route + audit pattern.
- **Phase 2 — Payroll Group & Period.** Tables, cutoff rules, period
  open/close. New `payroll_run` permission module.
- **Phase 3 — Resolver + Snapshot skeleton.** The as-of config resolver and
  snapshot writer, with **no** calculation yet. Testable in isolation: feed
  it a date, assert it returns the correct rule-set/JKK/assignment versions.
- **Phase 4 — Calculation core (dry-run only).** Eligibility → attendance →
  overtime (B2 decision applied) → earnings → BPJS → tax → gross/net.
  Writes Draft/Calculated runs. No approval, no finalization, no payment.
- **Phase 5 — Validation & Exception engine.** Section G codes.
- **Phase 6 — Approval & Finalization.** Reuse the existing two-step
  EDIT→APPROVE pattern; add immutability lock.
- **Phase 7 — Payslip.** Rendered strictly from snapshot.
- **Phase 8 — Adjustments, retro, reversal.**
- **Phase 9 — Payment batch & bank file export.**
- **Phase 10 — Scale hardening.** Batched/chunked run execution off the
  request thread; performance pass at 1k/5k employees.

---

## I. TEST MATRIX

**Normal cases**
1. Internal monthly employee, full attendance, no overtime.
2. PKWT employee with approved workday overtime (1.5×/2× progression).
3. Daily (`harian`) worker paid on a weekly cycle.
4. Subcontractor-entity employee — JKK rate resolves from *that* entity, not KAHE's.
5. Each TER category A, B, C produces the correct bracket and withholding.
6. BPJS Kesehatan cap applied (salary above Rp12,000,000).
7. JP cap applied (salary above the JP ceiling) while JHT stays uncapped.

**Edge cases**
8. Overtime on a weekly rest day, 6-day pattern → 2×/3×/4× bands.
9. Overtime on a public holiday, 5-day pattern → 2× (1–8h), 3× (9th), 4× (10–11th).
10. Overtime spanning midnight on a night shift.
11. Joiner mid-period → prorated by the defined basis.
12. Leaver mid-period → prorated + final pay.
13. Salary change mid-period → two segments, two rates, one payslip.
14. Employee moved between legal entities mid-period → JKK changes mid-period.
15. Period straddling a rule-set activation date → **must use the rule set effective for the period, not today's**.
16. Recalculate after a config change on a *Calculated* run → figures update.
17. Recalculate attempt on a *Finalized* run → rejected.
18. Finalized run re-read after a later rule-set activation → **figures unchanged** (the core snapshot guarantee).
19. Reversal of a finalized run → new reversing run, original preserved.
20. Retro adjustment from a closed period appearing in the next open period.
21. Employee with zero attendance → `MISSING_ATTENDANCE`, run blocked.
22. Deductions exceeding gross → `NEGATIVE_NET_PAY`, run blocked.
23. Two open assignments → `CONFLICTING_SALARY_ASSIGNMENT`, run blocked.
24. Unapproved overtime → `OVERTIME_NOT_APPROVED`, run blocked.
25. Duplicate run attempt for same period → rejected by `UNIQUE(period_id, run_number)`.
26. Same employee twice in one run → rejected by `UNIQUE(run_id, employee_id)`.
27. Concurrent calculate requests on one period → one wins, no partial writes (tests B4).
28. Payroll Officer scoped to entity A cannot read entity B's run (tests #28).
29. Non-approver role attempting approval → 403.
30. Rounding: sum of payslip line items equals stored gross/net exactly; sum of all net equals the bank batch total exactly (tests B3).
31. 1,000-employee run completes without timeout or event-loop starvation.

---

## VERDICT

**NOT READY — BLOCKERS MUST BE FIXED FIRST**

The *configuration foundation* is genuinely sound: versioning, audit trail,
modular domains, server-side RBAC, and the no-hardcoded-rules discipline are
all in place and are the hard parts to retrofit. That work holds up.

But six blockers (B1–B6) sit directly in the engine's dependency path, and
three of them — salary components, monetary precision, and transaction
boundaries — are the kind that cannot be added afterwards without rewriting
engine code and migrating financial records. Two of the six are not
theoretical: the uniqueness and float-arithmetic defects were reproduced
empirically during this audit.

Recommended next step: execute **Phase 0 and Phase 1** only, then re-audit
before opening Phase 2.
