# KAHE 360 Payroll — Full End-to-End System Audit

_Audit date: 2026-09-14. Scope: the complete payroll workflow as one
integrated system, Phase 0 through Phase 2H. No new features were built; two
test fixtures were corrected and one new audit suite was added._

Evidence: **423 tests passing** across 13 suites, including a new
`tests/e2e.test.js` that runs one complete payroll cycle end to end (43
assertions), plus seven targeted probes run against the live schema and route
files (marked **[probed]** below — reproduced facts, not readings).

---

## A. END-TO-END STATUS

**PASS**

One complete cycle ran from employee setup through payment reconciliation:

```
Employee/Contract → Assignment → Salary Structure → Attendance
→ Day Classification → Overtime → Period → As-Of Resolver → Frozen Snapshot
→ Calculation → Validation/Exception → Approval → Finalization → Payslip
→ Correction/Retro/Reversal → Payment → Bank Export → Reconciliation
```

Final reconciliation for the June cycle:
`payable Rp55.474.194 | paid Rp55.474.194 | outstanding Rp0`

All ten required cases pass:

| # | Case | Result |
|---|---|---|
| 1 | Normal worker | Gross, BPJS, TER and net all exact; progressive overtime correct |
| 2 | Joiner | 15/30 days, Rp4.500.000 from Rp9.000.000 |
| 3 | Leaver | 20/30 days, Rp6.000.000 |
| 4 | Mid-period salary change | Segment-weighted: (8jt×14 + 9,5jt×16)/30 = Rp8.800.000 |
| 5 | Late overtime correction | Priced at the **original frozen** hourly rate, 1.5×+2× |
| 6 | Overpayment recovery | DEBIT **reduces** take-home by exactly Rp500.000 |
| 7 | Reversal | Exact negation; period nets to zero; original untouched |
| 8 | Bank rejection | Recorded with reason + bank code; master record **not** auto-fixed |
| 9 | Retry payment | New linked instruction; rejected record survives; one live instruction |
| 10 | Master config changed after finalization | June history **byte-identical**; live resolve shows the new values |

---

## B. CRITICAL BLOCKERS

**None.**

Every failure surfaced during the audit was either a defect in my own test
fixture or a correct system refusal. Specifically, the 1,500-employee cycle
initially failed with 1,500 BLOCKING exceptions — the audit fixture had
activated a replacement rule set **without overtime rules**, and the engine
correctly refused to calculate rather than silently paying zero overtime.
That is the system working. The fixture was completed; see C1 for the
underlying process gap it revealed.

---

## C. NON-BLOCKING ISSUES

**C1 — A rule set can be ACTIVATED while incomplete. [probed]**
A `payroll_rule_sets` row can be set `active` with zero TER brackets and zero
overtime rules. The gap is only detected at calculation time, as a BLOCKING
exception per employee. It fails safe (no wrong money), but the failure lands
on 1,500 employees at the worst moment instead of on one administrator at
activation time. *Recommendation: a completeness check in the rule-set
activation endpoint — no code change to the engine.*

**C2 — Payslip read access is not row-scoped. [probed]**
Every payslip route is permission-gated, but `payroll_run:VIEW` can read
**any** payslip; there is no filter by legal entity or by the requesting
employee. Acceptable while only payroll/HR roles hold that permission —
becomes a real exposure the moment employee self-service is introduced. See
E2.

**C3 — December Pasal 17 annual reconciliation is not implemented. [probed]**
Monthly PPh21 uses TER as an instalment and is explicitly flagged
`is_final_annual_tax: false` / `annual_reconciliation_required: true`, with an
INFORMATIONAL exception raised per employee per period. This is correct and
honest, but the annual true-up remains a manual process outside the system.
It must be done before the annual tax filing.

**C4 — `legal_entities` is not effective-dated. [probed]**
`effective_date` exists, `effective_to` does not; `PUT /legal-entities/:id`
mutates in place. Changing an entity's JKK risk class rewrites what "was"
true. The blast radius is contained — the snapshot stores the resolved JKK
rate and version id, so finalized payroll is unaffected — but a historical
re-derivation from live master data would be wrong. Carried forward from the
re-audit, still non-blocking.

**C5 — BPJS caps are not re-applied to retro deltas.**
Deliberate and documented: the original already consumed the cap, and
re-applying it to a delta in isolation would over-contribute. A cap
interaction on a retro payment must be entered as an explicit
`TAX_CORRECTION` / `BPJS_CORRECTION`. Correct design, but it depends on the
operator knowing to do it — worth a note in the operating procedure.

**C6 — No bank-specific export adapter exists.**
Only `GENERIC_CSV` and `GENERIC_JSON`, both flagged
`verified_against_bank_spec: false`. This is honest, not a defect, but it
means the pilot cannot transmit to a bank until a real specification is
obtained and its adapter tested against the bank's own validator.

---

## D. PERFORMANCE / SCALE FINDINGS

Measured on the 1,500-employee cycle, in-process against SQLite (WAL):

| Stage | Time |
|---|---|
| Snapshot + freeze | 5.7 s |
| Calculation (persisted lines + components) | 0.9 s |
| Validation + exceptions | 6.0 s |
| Payslip generation | 1.0 s |
| Payment batch + validate + export | 0.1 s |
| **Total** | **13.8 s** |

- Comfortably inside the 1,000–2,000 target. At 2,000 workers, expect ~18 s.
- Every stage runs in **bounded chunks** (200 rows/transaction) per
  `docs/DB_EXECUTION_POLICY.md`; no stage holds a single long transaction.
- Snapshot and validation dominate because both re-resolve per employee.
  If headcount grows past ~5,000, those two are the places to optimise first
  (batch the as-of lookups). Not needed at current scale.
- Exact aggregation verified at scale: the sum of 1,500 individual net
  figures equals the aggregate **exactly**, and the bank file trailer equals
  the batch total exactly.
- **Concurrency:** `busy_timeout` 5000 ms is set on every connection and a
  bounded retry (4 attempts, exponential backoff) surfaces a clean
  `SQLITE_BUSY_EXHAUSTED` rather than hanging. Two competing writers resolve.
  *Caveat: SQLite is single-writer. This is sized for one KAHE operating
  entity on a LAN, not for multi-site concurrent payroll runs.*

---

## E. SECURITY / RBAC FINDINGS

**E1 — Route coverage is complete. [probed]** All **60** payroll routes are
gated by `requirePermission`; zero ungated.

**E2 — No legal-entity scoping of users. [probed] — RESOLVED in Phase 2I.**
At audit time `user_project_scope` existed and `user_legal_entity_scope` did
not. It now does. Original finding preserved below for the record. A user with `payroll_run:VIEW`
can read **any** entity's payroll, payslips and payment batches. The *data*
is entity-isolated everywhere (runs, lines, payslips, adjustments, payment
items all carry and enforce `legal_entity_id`), but *read access* is not.
For a model where KAHE processes subcontractor payroll, this is a
confidentiality gap. **The single most important thing to close before a
multi-entity pilot.**

**E3 — Segregation of duties is enforced and proven at three levels:**
- Payroll run: the preparer cannot approve their own run — verified over the
  real API with the **Operations Director**, who holds every other
  permission, receiving **403 SOD_VIOLATION**.
- Adjustment: the creator cannot approve their own adjustment.
- Payment: the preparer cannot authorise the submission.
The override is a separate permission module (`payroll_sod_override`) granted
to **no role by default**, including the Director — and its use is audited
with actor, timestamp, reason and target.

**E4 — Authentication and session handling** (bcrypt, express-session,
server-side authority, helmet, rate limiting) are unchanged from Phase 1 and
were not re-audited in depth here.

**E5 — No audit of payroll READS.** Who changed a figure is fully recorded;
who *looked at* a salary is not. For payroll data that is often as
significant. Non-blocking for a controlled pilot with a handful of users.

---

## F. DATA INTEGRITY FINDINGS

**All clean.** Specific verifications:

- **Monetary precision:** every money column in every table holds integers
  (`payroll_run_lines`, `payroll_payment_items`, `payroll_payslips`,
  `employee_salary_components`, `payroll_adjustments`) — zero non-integer
  rows. Line sums equal aggregates exactly.
- **Time precision:** `work_minutes` is integer throughout; overtime is
  computed as `rate × minutes × multiplier_bp / (60 × 10000)`, rounded once.
- **Effective dating & rule pinning:** June resolves the June rule set, June
  JKK (127 bp) and the June TER table even after a new rule set is activated
  and JKK is repriced to 900 bp. A live resolve then returns 900 bp,
  confirming the world really moved.
- **Snapshot immutability:** finalized run lines, components, snapshots,
  payslips and applied adjustments are all locked by database triggers —
  raw SQL bypassing the application is rejected (`PAYROLL_FINALIZED`,
  `PAYSLIP_IMMUTABLE`, `ADJUSTMENT_APPLIED`, `PAYMENT_EXPORTED`).
- **Determinism:** the same snapshot calculated twice produces byte-identical
  JSON, and matches what was persisted at finalization.
- **Cross-stage reconciliation:** for every employee, `payroll effective net
  == payslip net == amount paid`, exactly.
- **Duplicate prevention:** one finalized ORIGINAL run per period; one
  snapshot per employee per period; one payslip per run line; one live
  payment instruction per employee per period — all database-enforced.
- **Rollback:** a simulated mid-cycle failure left zero runs, lines, batches,
  items or payslips behind.
- **Referential integrity:** zero orphan run lines, payslips, payment items
  or applied adjustments across the whole chain.
- **18 unique indexes and 15 triggers** enforce the invariants; all present.

---

## G. PRODUCTION READINESS

### READY WITH CONDITIONS

The payroll engine itself is sound. Money is exact, history is immutable by
construction rather than by convention, every rule version is pinned to the
period it belongs to, segregation of duties holds even against the
highest-privileged role, and a full 1,500-employee cycle reconciles to zero.

Three conditions must be met before real money moves:

**Condition 1 — Close the entity read-scoping gap (E2). — ✅ MET in Phase 2I.**
`user_legal_entity_scope` now exists and is enforced at query and direct-ID
level, with cross-entity attempts audited and answered 404 to prevent id
enumeration. An Operations Director holding every permission but no scope
sees nothing. See `PROJECT_CHECKPOINT.md` § Phase 2I.

**Condition 2 — Obtain and implement a real bank adapter (C6).**
The generic formats cannot be transmitted to a bank. Get the specification
from KAHE's bank, write the adapter beside the generic ones, and test it
against the bank's own validator before setting `verified: true`. Until
then, run the pilot with manual transfer against the exported file, reconciled
by hand.

**Condition 3 — Parallel run against the current process for at least one
full month.** Compute payroll both ways and reconcile every employee to the
rupiah before paying from this system alone. No amount of passing tests
substitutes for one real month.

**Strongly recommended before pilot:** rule-set completeness validation at
activation (C1), and a documented operating procedure covering the retro-cap
decision (C5) and the annual Pasal 17 true-up (C3).

### What is explicitly NOT ready
- Multi-site concurrent payroll (SQLite single-writer).
- Employee self-service (needs E2 plus row-level authorisation, C2).
- Annual tax filing (C3 is manual).
- Automated bank transmission (C6).

---

## Test inventory

| Suite | Tests |
|---|---|
| Phase 0 — money, transactions, invariants, eligibility | 27 |
| Phase 0B — exact time, write contention | 25 |
| Phase 1A — salary components | 21 |
| Phase 1B — day classification | 29 |
| Phase 2A — groups & periods | 35 |
| Phase 2B — as-of resolver & snapshots | 34 |
| Phase 2C — calculation core | 32 |
| Phase 2D — validation & exceptions | 37 |
| Phase 2E — approval & finalization | 38 |
| Phase 2F — payslips | 30 |
| Phase 2G — adjustments, retro, reversal | 37 |
| Phase 2H — payment & bank export | 35 |
| **E2E audit — full cycle, 10 cases** | **43** |
| **TOTAL** | **423** |
