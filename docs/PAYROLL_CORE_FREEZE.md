# PAYROLL_CORE_STABLE_V1 — Freeze Contract

_Recorded 2026-09-14, after Phase 3B PASS._

This freezes the **Payroll and Payroll-Billing subsystem only**. The rest of
the KAHE 360 Internal Operations Portal remains in active development.

**Regression baseline: 545 tests across 16 suites.**

---

## 1. What is frozen

48 files, verified by checksum in `docs/PAYROLL_CORE_FREEZE.lock.json`.
Run `npm run check:payroll-freeze` at any time — it reports drift rather than
trusting that nobody edited anything.

| Area | Files |
|---|---|
| Canonical payroll libraries | `lib/money`, `time`, `employeeEligibility`, `salaryStructure`, `dayClassification`, `payrollPeriod`, `asOfResolver`, `snapshotWriter`, `payrollCalculator`, `payrollValidation`, `validationRunner`, `payrollRun`, `runCalculator`, `payslip`, `payrollAdjustment`, `payrollPayment`, `bankExport`, `entityScope` |
| Commercial / billing foundation | `lib/workerServiceAddon`, `billingRate`, `billingQuantity`, `billingCalculator` |
| API surface | `routes/payroll/*` (8 files), `routes/worker-services.js`, `routes/client-billing.js` |
| Regression suites | 16 test files — the baseline is itself part of the freeze |

### Shared files — changed carefully, not frozen wholesale
`database/init-db.js`, `database/seed.js`, `middleware/permissions.js` and
`server.js` are shared with the whole portal. Other modules will legitimately
add tables, permissions and routes to them. The freeze check reports changes
here as a **NOTE, not a failure** — but any change must be followed by
`npm run test:payroll-regression`.

The payroll-owned regions inside those files are still protected in substance:
- **`init-db.js`** — 37 payroll/billing tables, 18 unique indexes, 15 triggers
  (finalization locks, payslip locks, adjustment locks, payment export locks,
  rate locks, billing-calculation locks). Adding a new table is fine.
  **Altering a payroll table or dropping a trigger is a payroll change.**
- **`seed.js`** — the payroll permission modules and, critically, the fact
  that `payroll_sod_override` and `payroll_entity_override` are granted to
  **no role by default**, including Operations Director.
- **`permissions.js`** — `entityScope` on every `userContext`.

---

## 2. What is protected in behaviour

These are the invariants the 545 tests exist to defend. Breaking any of them
is a defect regardless of whether a file changed:

- **Monetary precision** — integer sen everywhere, basis points for rates,
  integer minutes for time. No floating-point money.
- **Effective dating & rule pinning** — June resolves June's BPJS rule set,
  JKK version, TER table, overtime rules, salary structure and add-on rates,
  forever, no matter what is activated later.
- **Snapshot immutability** — finalized runs, lines, components, snapshots,
  payslips, applied adjustments and exported payment instructions are locked
  by database trigger, not by convention.
- **Determinism** — the same snapshot always produces the same result.
- **Correction, never overwrite** — corrections and reversals create new runs
  referencing the original; the original is untouched.
- **Segregation of duties** — the preparer cannot approve; the creator cannot
  approve their own adjustment, rate or quantity; the preparer cannot
  authorise a payment. Overrides are separate permissions held by nobody.
- **Legal entity isolation** — `VIEW` alone never grants cross-entity access;
  cross-entity direct-ID reads return 404 and are audited.
- **Add-on architecture** — transport, meals and accommodation stay optional.
  Only a cash mode may become a payroll component, and only when explicitly
  configured. `NOT_PROVIDED` creates nothing, not even a zero-rupiah row.
- **Billing discipline** — attendance is never assumed to be consumption;
  only verified quantities are billed; `NOT_CONFIGURED` is a real state;
  billing reads finalized payroll and never writes it.

---

## 3. Integration — how other modules connect

Other modules **feed** and **read** payroll through the existing interfaces.
They must not reach into payroll internals.

| Feeding module | Interface | Consumed by |
|---|---|---|
| Timesheet & Absensi | `timesheet_entries` (approved minutes, day type snapshot) | As-of resolver → snapshot |
| HRD & Kontrak | `employees`, `employee_contract_history` | Eligibility, snapshot |
| Workforce assignment | `employee_payroll_assignments` | Eligibility, entity resolution |
| Payroll configuration | `salary_components`, `payroll_rule_sets`, `jkk_risk_classes`, `work_patterns`, `work_calendars`, `holidays` | As-of resolver |
| Worker Services | `worker_service_addons`, `billing_rate_cards`, `meal_plan_items` | Client billing |
| Service consumption | `billing_quantities` | Client billing |

**Read interfaces available to any module** (all entity-scoped and RBAC-gated):
`/api/payroll/periods`, `/runs`, `/runs/:id/lines`, `/snapshots`,
`/exceptions`, `/payslips`, `/payment-batches`, `/adjustments`,
`/periods/:id/reconciliation`, `/api/worker-services/*`,
`/api/client-billing/*`.

**Attendance A1 (2026-09-20):** `timesheet_entries` rows covered by a FROZEN
`payroll_input_snapshots` row are now immutable at the database level
(`trg_attendance_frozen_*`, payroll-source columns only), and attendance writes
respect `isStreamOpen()` cutoffs. Both READ payroll tables; neither alters one.
No frozen file changed. See `docs/ATTENDANCE_ARCHITECTURE.md`.

**Rule:** writing to a payroll table directly from a new module is a freeze
violation even if no frozen file changed. Use the API or the documented
feeding tables.

---

## 4. Procedure when a portal module needs a payroll change

Do **not** change payroll to unblock portal work. Instead:

1. **Report the dependency** — which module, which payroll behaviour, why the
   existing interface is insufficient.
2. **Wait for explicit approval.**
3. If approved: make the change, run `npm run test:payroll-regression` (must
   stay at or above 545 with zero failures), re-baseline with
   `npm run baseline:payroll-freeze`, and record what changed and why in
   `PROJECT_CHECKPOINT.md`.

If a portal change makes payroll tests fail: **stop and report the
regression.** Do not adjust payroll or its tests to make the failure go away.

---

## 5. Honest statement of current coverage

The freeze protects a **backend**. The operational UI for most of it does not
exist yet, and building that UI is *portal* work that reads the frozen APIs —
explicitly allowed, and probably the highest-value next step.

**Functional today (backend + working UI):** authentication/RBAC,
HRD & Kontrak, Timesheet & Absensi, Payroll Configuration.

**Backend complete, NO UI yet:** payroll periods, snapshots, dry-run,
validation/exceptions, payroll runs, approval/finalization, payslips,
adjustments/reversal, payments and bank export, worker service add-ons,
billing rates and quantities, draft billing calculation. All of this is
driven by API only.

**Static shells (markup, zero `fetch` calls, no backend):** Beranda/Home,
Pusat Kendali, Intelijen & Perencanaan, Talenta & Kesiapan, Operasi Tenaga
Kerja, Kinerja & Ketenagakerjaan, Layanan Pekerja, Kesehatan Kerja,
HSE & Kepatuhan, Peralatan & Resource, Kendali Kontraktor, Kendali Pelanggan,
Komersial, Penggajian & BPJS, Laporan & Analitik, Dokumen, Demobilisasi,
Pengaturan — 18 pages.

These pages exist and are navigable; they are not implemented modules. The
checkpoint says so plainly so nobody plans against a capability that isn't
there.

---

## 6. Deferred — do not start without explicit request

Invoice Generation · Billing Approval/Freeze · Accounts Receivable ·
Tax Invoice · any further payroll or billing phase.

---

## 7. Commands

```
npm run check:payroll-freeze       # has any frozen file drifted?
npm run test:payroll-regression    # full 545-test payroll regression
npm run baseline:payroll-freeze    # re-record after an approved change
```


---
## DB-M1 — controlled infrastructure re-baseline: `PAYROLL_CORE_STABLE_V1_POSTGRES` (2026-09-21)

The freeze SCOPE is unchanged: the same 48 files, the same 545-test baseline, the same rules above.
What changed is the persistence platform, approved by Kamal as "Option A — controlled
infrastructure re-baseline", and only after the Golden Payroll Parity Harness proved
`BUSINESS OUTPUT DIFF = ZERO` (5,164,797 stored values, 7 bank files, 181 targeted fields — 0 differences).

```
PAYROLL BUSINESS LOGIC      — UNCHANGED
PAYROLL PERSISTENCE LAYER   — SQLITE → POSTGRESQL
PURE FORMULA FILES          — BYTE IDENTICAL
OLD SQLITE FREEZE           — PRESERVED
NEW POSTGRESQL FREEZE       — CREATED AFTER ZERO-DIFF PARITY
```
| | |
|---|---|
| Pure formula files (4) | `lib/money.js`, `lib/time.js`, `lib/payrollCalculator.js`, `lib/bankExport.js` — byte-identical to the V1 SQLite lock; enforced forever by `npm run check:payroll-pure`, which reads the PRESERVED lock, so no re-baseline can hide a formula change |
| DB-coupled files (28) | async/await, `RETURNING id`, fixed dialect substitutions; 15 hand-edited SQL lines in 5 files, each justified in `docs/DB_M1_POSTGRES_MIGRATION.md` |
| Suites (16) | ported mechanically; no expected business or monetary value changed (numeric-literal comparison against A3) |
| Old freeze | `docs/freeze-history/PAYROLL_CORE_STABLE_V1.sqlite.lock.json` + `.manifest.js` (read-only) and `KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3.zip` (sha256 `173fed1e…e6ba36`) — the rollback baseline |
| New freeze | `docs/PAYROLL_CORE_FREEZE.lock.json`, version `PAYROLL_CORE_STABLE_V1_POSTGRES` |
| Re-verify parity | `tools/parity/run-golden.sh` |
No payroll scope was added or removed. Everything listed as deferred above stays deferred.
