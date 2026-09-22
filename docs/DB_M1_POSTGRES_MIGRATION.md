# DB-M1 — SQLite → PostgreSQL Migration (living record)

**Status: DB-M1 = PASS — checkpoints 1–6 complete. Final summary: `docs/DB_M1_FINAL_REPORT.md`.**
Since CP2 the application, the seed and all 19 regression suites run on PostgreSQL
only; no runtime file imports `node:sqlite`. CP3 proved **BUSINESS OUTPUT DIFF = ZERO** against the preserved A3 SQLite baseline, and only
then was the payroll freeze re-baselined as `PAYROLL_CORE_STABLE_V1_POSTGRES` (see the CP3 section).

Approved approach (2026-09-21): **Option A — controlled infrastructure re-baseline.**
Persistence only. No payroll rule, formula, validation, permission, state
transition or expected monetary value may change. No dual-write, no synchronous
compatibility shim, no split authority (payroll on SQLite / attendance on PG).

## Rollback baseline (immutable)
| Item | Value |
|---|---|
| Last SQLite authoritative package | `KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3.zip` |
| sha256 | `173fed1e573aff420dda092b1703e16ddc19697e86b17263bb5468f0dbe6ba36` |
| Verified on clean unzip | A1 55 · A2 83 · A3 55 · Payroll 545 · total 738 · freeze INTACT |
| Preserved SQLite freeze lock | `docs/freeze-history/PAYROLL_CORE_STABLE_V1.sqlite.lock.json` (read-only) |
| Preserved SQLite freeze manifest | `docs/freeze-history/PAYROLL_CORE_STABLE_V1.sqlite.manifest.js` (read-only) |
| Legacy SQLite schema (reference + migration source only) | `database/legacy-sqlite/` (byte copies of the A3 files) |

## Checkpoint plan
| CP | Scope | State |
|---|---|---|
| **CP1** | Baseline preservation · 48-file classification · canonical async DB layer + pool · versioned PG migrations · PG-native schema (63 tables, 125 indexes, 30 triggers) · role separation · isolated PG test harness · foundation suite | **DONE — 45/45 on PostgreSQL 16.15** |
| **CP2** | Convert non-frozen + the 28 DB-coupled frozen files to the async layer; SQL dialect edits only where required; port the 3 attendance + 16 payroll suites mechanically | **DONE — 545 + 193 + 45 on PostgreSQL 16.15** |
| **CP3** | Golden Payroll Parity Harness (A3/SQLite vs DB-M1/PG) → `BUSINESS OUTPUT DIFF = ZERO`; then 545 + 193 on PG; PG freeze manifest created ONLY after zero diff | **DONE — 5,164,797 values, 0 differences** |
| **CP4** | One-way SQLite→PG data migration tool, dry-run, dependency order, PK preservation, sequence reset, row-count + checksum reconciliation, FK-orphan audit | **DONE — 3 real A3 sources, 105,970 rows, difference 0, content match on every table** |
| **CP5** | Scale 100 / 1,500 / 4,000 / 6,000 × 12 months; rush hour; N+1 evidence; EXPLAIN (ANALYZE, BUFFERS); evidence-based index; pool; chunked reconciliation; race control | **DONE — see `docs/DB_M1_PERFORMANCE_REPORT.md`**. Open for CP6: pg_dump/restore, transaction-failure injection |
| **CP6** | Backup/restore verification, failure injection, connection loss, PostgreSQL-only runtime, runbook, architecture, clean-environment verification, final package | **DONE — `docs/DB_M1_FINAL_REPORT.md`** |

## Classification of the 48 frozen files
* **PURE BUSINESS / FORMULA (4)** — no database access; hold every monetary formula. **Must stay byte-identical to the V1 SQLite lock forever.** Enforced by `npm run check:payroll-pure`, which reads the *preserved* lock so a later re-baseline cannot mask a change.
* **DB-COUPLED INFRASTRUCTURE (28)** — 18 libs + 10 routes. May change only: `await`/`async`, the DB-layer import, and SQL dialect where PostgreSQL requires it. Each changed file gets a per-file reason in this document at CP2/CP3.
* **TEST-ONLY (16)** — ported mechanically: PG harness, `await`, `information_schema`/`pg_catalog` instead of `PRAGMA`/`sqlite_master`. Every business assertion and expected value preserved.

Counts are occurrences in the A3 source (what CP2 must address).

| File | Class | prepare | withTx | lastInsertRowid | date/time SQL | other dialect | SQLite introspection | V1 sha256 (first 12) |
|---|---|--:|--:|--:|--:|--:|--:|---|
| `lib/money.js` | PURE | 0 | 0 | 0 | 0 | 0 | 0 | `256f5c49e488` |
| `lib/time.js` | PURE | 0 | 0 | 0 | 0 | 0 | 0 | `84e04bd32f95` |
| `lib/employeeEligibility.js` | DB-COUPLED | 2 | 0 | 0 | 0 | 0 | 0 | `b53205fb3172` |
| `lib/salaryStructure.js` | DB-COUPLED | 3 | 0 | 0 | 0 | 0 | 0 | `a97bfeda396c` |
| `lib/dayClassification.js` | DB-COUPLED | 7 | 0 | 0 | 0 | 0 | 0 | `9e399b100e56` |
| `lib/payrollPeriod.js` | DB-COUPLED | 5 | 0 | 0 | 0 | 0 | 0 | `57a48ad1dc3b` |
| `lib/asOfResolver.js` | DB-COUPLED | 11 | 0 | 0 | 0 | 0 | 0 | `a56fb5d00957` |
| `lib/snapshotWriter.js` | DB-COUPLED | 6 | 2 | 1 | 1 | 0 | 0 | `cc5fab84014b` |
| `lib/payrollCalculator.js` | PURE | 0 | 0 | 0 | 0 | 0 | 0 | `042176c90751` |
| `lib/payrollValidation.js` | DB-COUPLED | 7 | 0 | 0 | 0 | 0 | 0 | `82ef4cd9f5aa` |
| `lib/validationRunner.js` | DB-COUPLED | 6 | 1 | 0 | 0 | 0 | 0 | `91b7952ada61` |
| `lib/payrollRun.js` | DB-COUPLED | 18 | 0 | 2 | 3 | 0 | 0 | `a1c505a32720` |
| `lib/runCalculator.js` | DB-COUPLED | 6 | 1 | 1 | 1 | 0 | 0 | `a3c812730fac` |
| `lib/payslip.js` | DB-COUPLED | 11 | 0 | 1 | 0 | 0 | 0 | `1a6cdb4b7954` |
| `lib/payrollAdjustment.js` | DB-COUPLED | 22 | 0 | 3 | 5 | 0 | 0 | `dbdf7ea5d7ee` |
| `lib/payrollPayment.js` | DB-COUPLED | 41 | 0 | 3 | 13 | 0 | 0 | `7eab59377b39` |
| `lib/bankExport.js` | PURE | 0 | 0 | 0 | 0 | 0 | 0 | `213f14726148` |
| `lib/entityScope.js` | DB-COUPLED | 5 | 0 | 0 | 1 | 1 | 0 | `43b949490e3e` |
| `lib/workerServiceAddon.js` | DB-COUPLED | 14 | 0 | 1 | 3 | 8 | 0 | `b2f7438df828` |
| `lib/billingRate.js` | DB-COUPLED | 18 | 0 | 2 | 4 | 22 | 0 | `014a0d0b9460` |
| `lib/billingQuantity.js` | DB-COUPLED | 16 | 0 | 2 | 5 | 12 | 0 | `673691695bb9` |
| `lib/billingCalculator.js` | DB-COUPLED | 11 | 0 | 1 | 3 | 0 | 0 | `a81f12aea748` |
| `routes/payroll/periods.js` | DB-COUPLED | 14 | 4 | 6 | 2 | 0 | 0 | `56b36f4e3d7a` |
| `routes/payroll/snapshots.js` | DB-COUPLED | 3 | 0 | 0 | 0 | 0 | 0 | `f3944c750973` |
| `routes/payroll/dryrun.js` | DB-COUPLED | 2 | 0 | 0 | 0 | 0 | 0 | `883ad3893ace` |
| `routes/payroll/exceptions.js` | DB-COUPLED | 6 | 2 | 0 | 2 | 0 | 0 | `0e01daa97aea` |
| `routes/payroll/runs.js` | DB-COUPLED | 6 | 7 | 0 | 2 | 0 | 0 | `88f4450d333c` |
| `routes/payroll/payslips.js` | DB-COUPLED | 5 | 2 | 0 | 0 | 0 | 0 | `20811fd17c37` |
| `routes/payroll/adjustments.js` | DB-COUPLED | 4 | 5 | 0 | 1 | 0 | 0 | `90942588e60e` |
| `routes/payroll/payments.js` | DB-COUPLED | 4 | 7 | 0 | 0 | 0 | 0 | `35bd1c964485` |
| `routes/worker-services.js` | DB-COUPLED | 8 | 4 | 1 | 0 | 0 | 0 | `82ba813547b5` |
| `routes/client-billing.js` | DB-COUPLED | 10 | 8 | 0 | 0 | 0 | 0 | `cb6ab0d230f6` |
| `tests/phase0.test.js` | TEST-ONLY | 38 | 5 | 0 | 0 | 1 | 6 | `58a734b309e6` |
| `tests/phase0b.test.js` | TEST-ONLY | 31 | 5 | 1 | 0 | 0 | 16 | `30f01d6402dc` |
| `tests/phase1a.test.js` | TEST-ONLY | 27 | 4 | 2 | 0 | 0 | 6 | `280d1133f8c8` |
| `tests/phase1b.test.js` | TEST-ONLY | 26 | 0 | 9 | 0 | 0 | 6 | `c2dffcc4f96c` |
| `tests/phase2a.test.js` | TEST-ONLY | 41 | 5 | 5 | 1 | 0 | 8 | `09789b56fcad` |
| `tests/phase2b.test.js` | TEST-ONLY | 58 | 12 | 12 | 1 | 0 | 6 | `090b34e80ee7` |
| `tests/phase2c.test.js` | TEST-ONLY | 34 | 4 | 7 | 0 | 0 | 7 | `ab7847ea6a55` |
| `tests/phase2d.test.js` | TEST-ONLY | 49 | 13 | 6 | 1 | 0 | 7 | `5950438745b2` |
| `tests/phase2e.test.js` | TEST-ONLY | 85 | 36 | 6 | 6 | 0 | 8 | `58b6e286ff75` |
| `tests/phase2f.test.js` | TEST-ONLY | 68 | 17 | 6 | 5 | 0 | 9 | `e469f9690522` |
| `tests/phase2g.test.js` | TEST-ONLY | 69 | 52 | 6 | 5 | 0 | 8 | `168e008b1692` |
| `tests/phase2h.test.js` | TEST-ONLY | 81 | 76 | 6 | 6 | 0 | 8 | `d498de4472b7` |
| `tests/phase2i.test.js` | TEST-ONLY | 65 | 14 | 9 | 2 | 1 | 7 | `1cc2cca568fd` |
| `tests/e2e.test.js` | TEST-ONLY | 126 | 59 | 8 | 9 | 0 | 12 | `ef16a8dad029` |
| `tests/phase3a.test.js` | TEST-ONLY | 25 | 6 | 1 | 3 | 0 | 8 | `8b6ff8a7878f` |
| `tests/phase3b.test.js` | TEST-ONLY | 28 | 38 | 1 | 2 | 0 | 8 | `21f15d1aa85d` |

## SQLite compatibility inventory (whole project, A3 source)
| Construct | Count | PostgreSQL treatment |
|---|--:|---|
| `node:sqlite` `DatabaseSync`, synchronous `prepare().get/all/run` | 586 call sites (src) + 851 (payroll tests) | async canonical layer `database/db.js`; same statement shape, `await`ed |
| `?` positional parameters | all statements | normalised to `$n` by the layer (WHERE clauses are built dynamically, so they cannot be numbered statically) — the ONLY runtime SQL normalisation |
| `lastInsertRowid` | 60 src / 85 tests | `INSERT … RETURNING id` written in the source SQL; `run()` surfaces it |
| `datetime('now')` / `date('now')` | 125 | `kahe_now()` — UTC, whole seconds, statement time (exact `datetime('now')` semantics; `now()` would freeze at transaction start) |
| `date(?, '-1 day')` (effective-date supersession) and `date('now','+30 day')` | 7 + 2 | `kahe_date_add(?::date, -1)` |
| `strftime('%Y-%m', …)` | 1 | `to_char(…, 'YYYY-MM')` |
| `INSERT OR IGNORE` | 7 | `ON CONFLICT DO NOTHING` (same semantics). **No `INSERT OR REPLACE` exists**, so no hidden DELETE+INSERT behaviour to preserve |
| `ON CONFLICT … DO UPDATE` | 6 | already PostgreSQL-compatible; `excluded` works identically |
| `IFNULL` | 50 | `COALESCE` |
| `LIKE` (case-insensitive in SQLite) | 8 | `ILIKE` for the user-facing searches; `LIKE` kept for id/date prefixes |
| `AUTOINCREMENT` | 57 tables | `BIGINT GENERATED BY DEFAULT AS IDENTITY` (explicit historical ids allowed; sequence reset after import) |
| `PRAGMA foreign_keys/WAL/busy_timeout` | 13 | FKs always on; MVCC replaces WAL; `lock_timeout` 5 s + bounded `withRetry` on 40001/40P01/55P03 replaces busy_timeout |
| Triggers with `RAISE(ABORT, …)` | 30 | plpgsql functions, identical message text, SQLSTATE `KH001` |
| Partial unique indexes | 31 (of 38 unique) | native partial indexes, predicates verified equal |
| Expression indexes (`IFNULL(col,-1)`) | 5 | `COALESCE` expression indexes |
| CHECK constraints | 100 | carried verbatim |
| Foreign keys | 117 (31 `ON DELETE CASCADE`) | carried verbatim, verified equal |
| Boolean as INTEGER 0/1 | 28 columns | kept as `BIGINT` 0/1 with the same CHECKs — API output and frozen expectations stay byte-identical |
| Loose typing / text dates | 68 date cols, 99 timestamp cols | `DATE` / `TIMESTAMPTZ`, rendered back as the exact A3 strings |
| Text ordering (SQLite BINARY collation) | every `ORDER BY` on text | database created with `LC_COLLATE 'C'`; migrator refuses another collation unless explicitly overridden |
| JSON functions, `COLLATE NOCASE`, `rowid`, temp tables, `INSERT OR REPLACE`, `julianday` | 0 | not used |

## Type mapping (deliberate, verified by the foundation suite)
| SQLite | PostgreSQL | Columns | Reason |
|---|---|--:|---|
| INTEGER | BIGINT | 320 | SQLite INTEGER is 64-bit. Monthly amounts in sen exceed int32 (Rp 21.5 jt = 2.15e9 sen). Rendered as JS numbers; a value beyond 2^53 throws rather than rounds |
| TEXT `*_at`, `*_timestamp` | TIMESTAMPTZ | 99 | real instants; session TZ forced to UTC; rendered `YYYY-MM-DD HH:MM:SS` exactly as A3 stored them |
| TEXT business dates (`work_date`, `effective_*`, `period_*`, cutoffs…) | DATE | 68 | no time zone can shift a business date; rendered `YYYY-MM-DD`. The Asia/Jakarta business clock stays in `lib/businessTime.js` |
| REAL | DOUBLE PRECISION | 3 | legacy display hours on `timesheet_entries`; **integer minutes remain authoritative** |
| TEXT (everything else, incl. `HH:MM` clock strings, `billing_period` `YYYY-MM`, hashes, JSON payloads) | TEXT | 488 | unchanged |
No money, rate or minute column is floating point or NUMERIC.

## Trigger mapping
All 30 A3 triggers are re-implemented 1:1 in `0003_integrity_triggers.sql` with the same name, table, event and timing. SQLite allowed sub-queries in `WHEN`; PostgreSQL does not, so each condition sits inside its function. `IS NOT` → `IS DISTINCT FROM`, `IFNULL` → `COALESCE`; nothing else changes. Four `BEFORE TRUNCATE` guards are added (TRUNCATE bypasses row triggers).

| Group | Triggers | Protects |
|---|---|---|
| Append-only audit | `trg_attendance_events_no_update/_no_delete`, `trg_correction_actions_no_update/_no_delete`, `trg_entry_versions_no_update/_no_delete` | immutable audit events, approval history, record version chain |
| Frozen attendance source | `trg_attendance_frozen_insert/_update/_delete` | attendance consumed by a FROZEN payroll snapshot |
| Schedule version immutability | `trg_work_schedule_used_is_immutable`, `trg_work_schedule_break_immutable` | schedule versions referenced by attendance |
| Finalized payroll | `trg_lock_finalized_run_line_update/_delete`, `…_component_update/_delete`, `…_snapshot_update/_delete`, `trg_lock_finalized_run_status` | finalized runs, lines, components, snapshots |
| Payslip / adjustment / payment | `trg_lock_payslip_update/_delete`, `trg_payslip_requires_finalized_run`, `trg_lock_applied_adjustment(_delete)`, `trg_adjustment_requires_finalized_source`, `trg_lock_exported_payment_item(_delete)` | payslips, applied adjustments, exported payment instructions |
| Billing | `trg_lock_active_addon_terms`, `trg_lock_active_rate`, `trg_lock_calculated_billing_line(_delete)` | active commercial terms, calculated billing |

## Roles / least privilege
| Role | Used by | Rights |
|---|---|---|
| owner (`DATABASE_MIGRATION_URL`) | `npm run db:migrate` only | owns schema, DDL |
| runtime (`DATABASE_URL`) | the application and the test suites | SELECT/INSERT/UPDATE/DELETE, sequence usage. **No** TRUNCATE, DDL, trigger disable, function replace, `session_replication_role`, or write access to `schema_migrations` — all verified by raw SQL as the runtime role |
No Row Level Security is introduced; RBAC semantics are untouched.

## One intentional, equivalent schema simplification
`uq_qty_live_per_service_day` indexed `IFNULL(service_date,'-')`. With `service_date` now a DATE, `'-'` is not a valid value; the index predicate already requires `service_date IS NOT NULL`, so the COALESCE was dead code. The index uses `service_date` directly — identical uniqueness rule.

## Known behavioural edge to watch in CP2 (not yet decided, will be reported)
A DATE column rejects a malformed date that SQLite's TEXT column would have stored verbatim. Every write path found so far validates dates in application code first; any path that does not will surface as a test failure in CP2 and will be **reported, not silently patched**.

## CP1 evidence
* PostgreSQL **16.15** (Ubuntu 16.15-0ubuntu0.24.04.1), real server, scram-sha-256, separate owner/runtime roles. Driver: `pg` 8.x (node-postgres), `pg.Pool`.
* `npm run test:dbm1` → **45 passed, 0 failed** (runtime role): real-PG proof, layer behaviour, migration versioning (double-apply, failure rollback, edited-migration refusal, dry-run, verify-only start-up check, no invented data), full structural parity against the A3 SQLite schema (tables, column order, nullability, types, identity, defaults, PKs, 117 FKs, 125 indexes incl. 31 partial predicates, 100 CHECKs, 30 triggers), DB-level audit immutability by raw SQL, privilege escalation attempts, partial-unique behaviour side-by-side with SQLite, explicit-id + sequence advance, transaction atomicity, nested join, connection affinity, no dirty read, stray-query guard, pool leak test (60 failing tx on a pool of 4), real deadlock retry, lock timeout.
* Baseline after CP1 (still SQLite runtime, untouched): A1 55 · A2 83 · A3 55 · Payroll 545 · freeze INTACT · pure formulas 4/4 identical.
* CP2 feasibility scan (AST, read-only): 96 files parse; 159 named functions issue SQL directly; 248 top-level statements (tests/scripts) need an async wrapper; 90 cached prepared statements; 1 constructor with DB access (session store); 0 array callbacks issuing SQL directly.

---
# CP2 — async conversion & mechanical suite port (2026-09-21)

## Method (reproducible, tools kept in `tools/dbm1/`)
| Tool | What it does |
|---|---|
| `async-codemod.js` | Whole-program AST pass: every function that (transitively) issues SQL becomes `async`, every such call gets `await`. Touches nothing else. 5,199 `await`, 1,660 functions. The four PURE files received **zero** edits. |
| `returning-id.js` | For each `.lastInsertRowid` read, appends ` RETURNING id` to the INSERT it belongs to (152 statements; 2 resolved by hand). |
| `check-floating.js`, `check-unawaited.js` | Safety nets: un-awaited async IIFEs, async callbacks in array methods, un-awaited statement calls. Final state: 0 findings. |
| `verify-mechanical.js` | Strips the mechanical transformations from old and new text and prints the residual hand edits per file. |
Fixed dialect substitutions: `datetime('now')`→`kahe_now()` (129) · `IFNULL`→`COALESCE` (50) · `date(?, '-1 day')`→`kahe_date_add(?::date, -1)` (7) · `INSERT OR IGNORE`→`… ON CONFLICT DO NOTHING` (18) · `strftime('%Y-%m',x)`→`to_char(x,'YYYY-MM')` (1) · `date('now','+30 day')`→`kahe_now()::date + 30` (2).

## DB-coupled frozen files — why each changed
**24 of 28 are purely mechanical** (`verify-mechanical.js`: residual +0/−0): async/await, `RETURNING id`, and the fixed substitutions above — nothing else.
`lib/employeeEligibility.js, dayClassification.js, asOfResolver.js, snapshotWriter.js, payrollValidation.js, validationRunner.js, payrollRun.js, runCalculator.js, payslip.js, payrollAdjustment.js, entityScope.js, workerServiceAddon.js, billingRate.js, billingQuantity.js` · `routes/payroll/{periods,snapshots,dryrun,exceptions,runs,payslips,adjustments,payments}.js` · `routes/worker-services.js` · `routes/client-billing.js`.

**4 files carry 14 hand-edited lines in total — every one a SQL dialect necessity:**
| File | Edit | Why PostgreSQL requires it |
|---|---|---|
| `lib/salaryStructure.js` | `?::bigint IS NULL`, `COALESCE(?::date, '9999-12-31')` | an untyped parameter has no inferable type in `? IS NULL`; `COALESCE(unknown,'literal')` resolves to text and `date <= text` has no operator |
| `lib/payrollPeriod.js` | same `?::bigint IS NULL`; **`getGroupMembership` rewritten** | see "SQLite-only GROUP BY" below |
| `lib/payrollPayment.js` | **payable-per-employee query** | see below |
| `lib/billingCalculator.js` | `to_char(p.period_start,'YYYY-MM')` | `strftime` does not exist |

### ⚠ SQLite-only GROUP BY — the two edits CP3 must scrutinise
Both queries used SQLite's non-standard "bare column" GROUP BY (selecting non-grouped columns; SQLite silently takes them from an arbitrary row of the group). PostgreSQL rejects that. The implicit choice had to be made explicit:
1. `payrollPeriod.getGroupMembership` — `GROUP BY a.employee_id` + scalar `MAX(a,b)`/`MIN(a,b)` → `SELECT DISTINCT ON (employee_id) … ORDER BY employee_id, a.id DESC` with `GREATEST`/`LEAST`. One row per employee is preserved; when an employee has several assignment rows in the same group and period, the **latest assignment row** is now used, deterministically (SQLite's de-facto behaviour was the last row visited).
2. `payrollPayment` payable query — `GROUP BY l.employee_id` selecting `e.full_name`, `l.legal_entity_id`, `GROUP_CONCAT(r.id)` → `MIN(e.full_name)`, `MIN(l.legal_entity_id)`, `string_agg(r.id::text, ',' ORDER BY r.id)`. Sums and counts are untouched. `full_name` is functionally dependent on the employee; `legal_entity_id` is identical across an employee's runs of one period in every fixture.
Identical results in all 545 tests. These are the only places where a judgement was made inside frozen code; the golden parity harness must cover multi-assignment and multi-run employees explicitly.

## Non-frozen conversion
Converted: every other lib, route and middleware, `server.js`, `database/seed.js`, `migrate-attendance-a1/a2/a3.js`, `migrate-phase2i.js`. New: `middleware/pgSessionStore.js` (replaces `sqliteSessionStore.js`; sessions now live in PostgreSQL), `middleware/asyncErrors.js` (Express 4 does not catch rejected promises; this forwards them to the error handler so async handlers fail exactly as sync ones did). `database/init-db.js` keeps its name and export surface but is now a thin PostgreSQL module: `getDb()` hands out a pooled facade whose per-request `close()` is a no-op (the A3 `try { … } finally { db.close(); }` shape is unchanged in 138 places); `initDb()` VERIFIES the schema version and never alters it.
Moved to `database/legacy-sqlite/` unconverted (SQLite-only by nature — `PRAGMA`/`ADD COLUMN` upgrades of old SQLite files): `migrate-phase0, 0b, 1a, 1b, 2a, 3b.js`. Removed from the runtime: `database/attendance-*-schema.js` (their DDL is in migration 0001–0003; originals preserved in `legacy-sqlite/`).
**Files not converted: none.** No runtime file imports `node:sqlite` (only `tests/dbm1-foundation.test.js`, `tools/dbm1/gen-pg-schema.js` and `database/legacy-sqlite/` do, as reference).

## Suite port — what changed besides async/await
Harness: `new DatabaseSync(file)` + PRAGMAs → `createTestDatabase(<suite>)` (isolated database, **runtime role**); attendance suites start the REAL server and seed with `DATABASE_URL` of that database. Introspection: `sqlite_master` / `PRAGMA table_info` → `tests/helpers/pgIntrospect.js` (same result shape; storage classes reported in the vocabulary of the assertions — bigint→INTEGER, float→REAL, text→TEXT; DATE/TIMESTAMPTZ are reported as themselves, never as TEXT).
`verify-mechanical.js` residual: 7–10 lines per suite (header, footer, introspection calls), 27 in `phase0b` and 15 in `e2e` (the SQLite lock tests). A numeric-literal multiset comparison of all 19 suites against A3 shows **no expected monetary or business value changed**: the only differences are `process.exit(1)` in the wrapper, the removed `busy_timeout = 5000`, PostgreSQL error codes and one fixture timestamp.
Infrastructure assertions that had to be translated (none is a business rule):
| Suite | A3 (SQLite) | DB-M1 (PostgreSQL) |
|---|---|---|
| phase0b, e2e | `PRAGMA busy_timeout` = BUSY_TIMEOUT_MS | `SHOW lock_timeout` = BUSY_TIMEOUT_MS |
| phase0b, e2e | two `BEGIN IMMEDIATE` writers on one file | two pooled handles, `withTransaction` each |
| phase0b, e2e | simulated `SQLITE_BUSY` → `SQLITE_BUSY_EXHAUSTED` | simulated `55P03` → `DB_BUSY_EXHAUSTED` |
| phase0b | `isRetryableLockError` by message text | by SQLSTATE (`55P03`, `40P01` true; `23505`, `42703` false) |
| phase0, phase0b, e2e | scratch `CREATE TABLE` by the test connection | created through the OWNER role (`__t.ddl`), because the runtime role has no DDL |
| phase3b, e2e | `CAST(x AS INTEGER)` | `CAST(x AS BIGINT)` — PostgreSQL INTEGER is 32-bit, sen amounts overflow it |
| phase3b | `… WHERE vehicle_id IS NOT NULL LIMIT 1` | `… ORDER BY id LIMIT 1` — relied on SQLite rowid order |
| phase2b | `HAVING n > 1` (alias) | `HAVING COUNT(*) > 1` |
| phase2f | payslip fixture used `'x'` for `finalized_at`/`generated_at` | a valid timestamp — PostgreSQL validates the column type BEFORE the trigger under test can fire; the asserted trigger error is unchanged |
| phase2i | source-grep `/INSERT OR IGNORE INTO user_legal_entity_scope/` | `/INSERT INTO user_legal_entity_scope…ON CONFLICT DO NOTHING/` |
| phase2a, phase2f | `SELECT sql FROM sqlite_master` | `pgx.tableSql` / `pgx.indexNames` |

## PostgreSQL behaviour differences found (all handled, all listed)
1. Bare-column GROUP BY, scalar `MAX/MIN(a,b)`, `GROUP_CONCAT` — above.
2. Untyped parameters: `? IS NULL`, `COALESCE(?, 'date literal')` need a cast.
3. 32-bit `INTEGER` casts overflow on sen amounts.
4. Type validation precedes BEFORE-triggers (garbage in a typed column fails with `22007`, not with the trigger's message).
5. No implicit row order: an unordered `LIMIT 1` is arbitrary. Four remain in source and are pure existence probes (`attendanceGuard`, `payrollPeriod.findOverlappingPeriod`, `salaryStructure`, `validationRunner`) — any row is a correct answer.
6. `@named` parameters (used in 20 files — **missed in the CP1 inventory**) are bound by the canonical layer; a missing name throws.
7. Express 4 + async handlers → `middleware/asyncErrors.js`.
8. Speed: see timings. Serial round trips make the 1,500-employee suites much slower than in-process SQLite. Correctness is unaffected; batching is CP5 work, on evidence.

## Malformed legacy dates
**None found** — every fixture, seed and test value is a valid ISO date, and no test depended on storing an invalid one. `migrate-attendance-a1.js` used to COUNT malformed `work_date` strings (`NOT GLOB … OR date(x) IS NOT x`). Under a `DATE` column that state cannot exist, so the script now reports `invalid_date = 0` with an explanatory comment. **The scan is not dropped: it moves to the CP4 SQLite-source pre-flight, where a malformed date is reported and blocks the migration — never normalised.**

## CP2 evidence (clean extracted copy, `npm ci`, PostgreSQL 16.15, suites run as the runtime role)
| Check | Result |
|---|---|
| Pure formula files vs preserved V1 SQLite lock | 4/4 byte-identical |
| DB-M1 foundation | 45 passed, 0 failed |
| Attendance A1 / A2 / A3 (real server on PostgreSQL) | 55 / 83 / 55 = 193 passed, 0 failed |
| Payroll phase0 … phase3b (16 suites) | 27·25·21·29·35·34·32·37·38·30·37·35·25·43·44·53 = **545 passed, 0 failed** |
| Test databases left behind after a completed run | 0 |
| Live server smoke (bootstrap → migrate → seed ×2 → start) | 401 unauthenticated · login · routes 200 · RBAC 403 · sessions in PostgreSQL · `/database/*` not served |
The clean run was executed in two sittings because the sandbox stops any command after
300 s; the first sitting was killed mid-suite and left 7 orphan `kahe360_test_*` databases,
removed with `dropStaleTestDatabases()` before the second sitting. A suite that finishes
normally always drops its own database.
Timings: attendance ≈ 35 s each; payroll suites with 1,500-employee runs 34–107 s each;
full payroll regression ≈ 11–13 min (layer round trip ≈ 0.17 ms in-transaction, 0.32 ms pooled).
Project/Workfront scope: unchanged — PARTIAL / NOT ENFORCED. PostgreSQL freeze manifest: NOT created (CP3 gate).

---
# CP3 — Golden Payroll Parity (2026-09-21)

## Result
```
BUSINESS OUTPUT DIFF = ZERO
```
| Part | Scope | Compared | Differences |
|---|---|--:|--:|
| Full-state parity | 16 scenario groups (the 16 frozen suites = 545 business checks), 40 populated tables | 282,764 rows · **5,164,797 values** · 704,209 of them money / rate / minutes / quantity / hash | **0** |
| Bank export parity | every exported bank file (7) regenerated and compared byte for byte; Rp 14.38 billion of instructions | 3,051 file lines · stored hash reproduced 7/7 on SQLite and 7/7 on PostgreSQL | **0** |
| Hand-edited queries | 9 targeted cases, both engines driven by one scenario | 181 fields | **0** |
Pass counts are equal on both engines for every suite (545 = 545). Machine-readable evidence: `docs/parity/GOLDEN_PARITY_RESULT.json`.

## Method (`tools/parity/`, rerun with `tools/parity/run-golden.sh`; needs `KAHE_A3_ROOT` = the extracted, unmodified A3 package)
1. **Full-state parity.** The UNMODIFIED A3 suite runs on SQLite (`-r a3-keep-db.js` only copies its database aside before the suite deletes it). The mechanically ported suite runs on PostgreSQL. `dump-state.js` writes the complete final state of all 63 A3 tables in one canonical form and `compare-state.js` compares value by value. This covers period resolution (`payroll_periods`, 56 rows), assignment resolution (`employee_payroll_assignments` 15,131 · resolved inside 13,758 `payroll_input_snapshots` payloads and their hashes), attendance/normal time/overtime (`timesheet_entries` 10,579 + snapshot payloads), employee run results (`payroll_run_lines` 9,219: gross, net, BPJS, PPh21, result payload + hash), earning/deduction lines (`payroll_run_line_components` 178,249), payslips (3,018 documents + 3 hashes each), adjustments (1,513), payments (19 batches · 3,065 instructions), billing (25 runs, lines, quantities, rate cards, audit), validation exceptions, run/payment events, config audit.
2. **Bank export parity** (`dump-bank-export.js`, `compare-bank-export.js`).
3. **Targeted parity** of the two re-expressed queries (`parity-handedited.js`, `engines.js`).

## What is masked — the complete list (nothing else)
| Masked | Why it is not business output |
|---|---|
| Columns that are wall-clock instants (`*_at`, `*_timestamp`; the 99 TIMESTAMPTZ columns) and the same keys inside JSON → `'T'`/null (presence is still compared) | the time the test happened to run |
| The 8–9 character suffix of `PB-<entity>-<yyyymm>-XXXXXXXX` | it is literally `Date.now().toString(36)` (`lib/payrollPayment.js:152`) |
| `payroll_payment_batches.export_hash` and the `hash` inside the export event | it hashes file content that contains that clock token, so it differs between ANY two runs, SQLite vs SQLite included. **Not ignored:** the file is regenerated on each engine with that engine's own pure `bankExport.js`, shown to reproduce the STORED hash (7/7 and 7/7), then compared byte for byte with only the clock token masked |
| Surrogate `id` values and the foreign keys that point at them → the row's ordinal in its table | see next section |
**Not masked, compared raw:** every amount, rate, basis point, minute, quantity, date, period, employee id, assignment, status, reference, payload, document and every other hash.

## Surrogate ids — a real PostgreSQL difference, neutralised only inside the parity database
A PostgreSQL sequence is not rolled back with a failed transaction; SQLite AUTOINCREMENT is. After any rolled-back insert the two engines hand out different ids, and payroll embeds ids in payloads that are hashed (`rule_version: "adjustment:5"` vs `"adjustment:6"`). Pass 1 showed exactly this and nothing else: equal row counts, ids off by one, ~15,000 dependent string/hash differences. To compare byte for byte, the parity database (and only it — `KAHE_PARITY_GAPLESS_IDS`, `tests/helpers/pgTestDb.js`) replaces identity defaults with a transactional counter that has SQLite's exact semantics. Application code is untouched. With it, all payloads and hashes are identical.
**Consequence for production (documented, harmless):** PostgreSQL ids can have gaps after failed transactions. Ids are surrogate; no rule depends on them being contiguous. The CP4 data migration preserves historical ids exactly.

## Defects the harness found in my own CP2 edits (all fixed; this is what the harness is for)
| # | File (frozen) | CP2 edit | What A3 actually does | Fix |
|---|---|---|---|---|
| 1 | `lib/payrollPeriod.js` `getGroupMembership` | chose the LATEST assignment row (`a.id DESC`) | SQLite scans `idx_payroll_assignment_employee (employee_id, effective_date)` and keeps the FIRST row of each group = the **earliest** assignment | `ORDER BY a.employee_id, a.effective_date ASC, a.id ASC` |
| 2 | `lib/payrollPayment.js` `getPayableEmployees` | `MIN(l.legal_entity_id)` | the entity of the line of the **earliest run** | `(array_agg(l.legal_entity_id ORDER BY r.id))[1]` |
| 3 | `lib/payrollValidation.js` `getBlockingSummary` | untouched `GROUP BY` without `ORDER BY` | SQLite returns groups sorted; the array is PERSISTED in run-event JSON | `ORDER BY severity, resolution_status` (and the same for the HRD worker-type summary, non-frozen) |
None of the 545 tests could see 1–2: the fixtures never have two assignment rows in one group and period, nor differing entities between runs. Targeted cases now cover: whole period · join mid-period · leave mid-period · two rows with chronological ids · two rows with REVERSED ids · G→H→G · three rows · start on the period's last day · end on its first day · ended before / starts after (excluded) · one-day period on a boundary · empty period · unknown group · case/punctuation ordering · another legal entity · three finalized runs + one open run with lines inserted out of run order · ERROR lines · zero and net-zero amounts · an employee present only in a correction run · other period · period without runs · unknown period · differing entity between runs in both insertion orders.
**Pre-existing A3 behaviour, preserved on purpose, flagged for a payroll decision:** when an employee has several assignment rows in one group within one period, `member_from/member_to` describe only the earliest row. Payroll is NOT affected — `snapshotWriter.getEligibleEmployees` consumes only `employee_id`; the dates surface only in `GET /api/payroll/groups/:id/members`. DB-M1 reproduces A3 exactly and changes nothing here.

## The four unordered `LIMIT 1` queries — no code changed
| Query | Business meaning | Is "any row" valid? |
|---|---|---|
| `attendanceGuard.isPayrollSourceFrozen` | "is there ANY frozen snapshot over this employee/date?" → `!!row` | **Yes.** `SELECT 1`; only existence is used |
| `payrollPeriod.findOverlappingPeriod` | refuse a period that overlaps an existing one (HTTP 409) | **Yes for the decision.** The row's dates appear only in the explanatory message; with several overlapping periods the message may name a different one — each is a true overlap |
| `salaryStructure.findOverlappingAssignment` | refuse an overlapping salary-component assignment (409) | **Yes**, same reasoning |
| `validationRunner.buildContext` duplicate candidate | raise `DUPLICATE_PAYROLL_CANDIDATE` when the employee has a snapshot in another overlapping period | **Yes for the outcome** (same exception, severity and blocking effect). `other_period_id` in the exception detail names one of several true duplicates; with exactly one duplicate — every existing fixture — it is identical on both engines |
Row order cannot change any accept/reject, amount or state. Where several conflicts exist, the EXAMPLE named can differ (it could already differ in SQLite if the plan changed). Recommended later, with approval, not done here: `ORDER BY id` on the last three for deterministic messages.

## Frozen files changed during CP3
`lib/payrollPeriod.js` (1 line) · `lib/payrollPayment.js` (1 line) · `lib/payrollValidation.js` (+1 line). Hand-edited SQL lines in frozen files, cumulative: 15 in 5 files (`verify-mechanical.js`); the other 23 DB-coupled files remain purely mechanical. Pure formula files: untouched, 4/4 byte-identical.

## Freeze re-baseline (performed only after the zero-diff result)
```
PAYROLL BUSINESS LOGIC      — UNCHANGED            (5,164,797 stored values + 7 bank files + 181 targeted fields identical to A3)
PAYROLL PERSISTENCE LAYER   — SQLITE → POSTGRESQL  (28 DB-coupled files: async + dialect; 16 suites ported mechanically)
PURE FORMULA FILES          — BYTE IDENTICAL       (money.js, time.js, payrollCalculator.js, bankExport.js vs the V1 SQLite lock)
OLD SQLITE FREEZE           — PRESERVED            (docs/freeze-history/PAYROLL_CORE_STABLE_V1.sqlite.lock.json + manifest, read-only)
NEW POSTGRESQL FREEZE       — CREATED AFTER ZERO-DIFF PARITY  (PAYROLL_CORE_STABLE_V1_POSTGRES, docs/PAYROLL_CORE_FREEZE.lock.json)
```

## Unresolved parity risks (honest list)
1. Parity is proven for everything the 16 suites and the targeted cases produce. It is not a proof over all possible inputs; a future query that depends on implicit row order would not be caught unless a scenario exercises it. Mitigation: `run-golden.sh` is kept and rerunnable; the three unordered example-row queries above are documented.
2. HTTP response bodies of the payroll routes are compared only indirectly (they serialise the compared rows). Attendance API behaviour is covered by the 193 API tests, which assert the same expectations as on SQLite, but was not state-diffed against A3.
3. Surrogate-id gaps exist in real PostgreSQL databases (see above).

## CP3 regression evidence (clean extracted copy, `npm ci`, PostgreSQL 16.15, one uninterrupted run, runtime role)
| Check | Result |
|---|---|
| Pure formula files vs preserved V1 SQLite lock | 4/4 byte-identical |
| DB-M1 foundation | 45 passed, 0 failed |
| Attendance A1 / A2 / A3 | 55 / 83 / 55 = 193 passed, 0 failed |
| Payroll (16 suites) | 27·25·21·29·35·34·32·37·38·30·37·35·25·43·44·53 = **545 passed, 0 failed** |
| `check:payroll-freeze` after re-baseline | INTACT (`PAYROLL_CORE_STABLE_V1_POSTGRES`, 48 frozen files) |
| Code of the verified copy vs the packaged tree (`lib routes middleware database tests server.js`) | identical (sha256 of sha256 list) |
Project/Workfront scope: unchanged — PARTIAL / NOT ENFORCED. Malformed legacy dates: still assigned to the CP4 SQLite-source pre-flight (report and block, never normalise).

---
# CP4 — SQLite → PostgreSQL data migration, preflight & reconciliation (2026-09-21)

Tool: `database/pg/migrate-from-sqlite.js` (`npm run db:migrate-from-sqlite`). Procedure: `docs/POSTGRES_MIGRATION_RUNBOOK.md`. Evidence: `docs/migration-evidence/*.report.json` (full per-table reconciliation). Schema addition: migration `0004_data_migration_ledger.sql` (`data_migrations`).

## Sources migrated (all real A3 SQLite files produced by the UNMODIFIED A3 code)
| Source | How it was produced | Rows | Non-empty tables |
|---|---|--:|--:|
| attendance-a3 | A3 seed + the complete A3 attendance API suite against the real A3 server: schedules, patterns, rosters, OT, corrections, voids, exceptions, payroll-impact queue, 2,038 audit events, a finalized run, frozen snapshots | 8,083 | 38 |
| payroll-e2e | the A3 end-to-end payroll suite: 5 runs, 1,526 lines, 33,422 components, 1,508 payslips, payment batches, adjustments | 48,673 | 27 |
| payroll-e2e + seeded RBAC | the same file after the A3 `seed.js` was run on it (users, roles, 429 grants) — so payroll history can be read through HTTP + RBAC | 49,214 | 34 |
The original `e2e.test.db` was correctly **BLOCKED** by preflight: it contains the suite's scratch table `_e2e_probe`, which the destination does not have. The migrated file is a copy with only that test artefact dropped.

## Result (identical for all three)
| Check | Result |
|---|---|
| Preflight | 0 findings · 1,899,789 values inspected in total |
| Source tables / migrated tables | 63 / 63 |
| Source rows / destination rows | 8,083 / 8,083 · 48,673 / 48,673 · 49,214 / 49,214 — **difference 0 on every table** |
| Content reconciliation | sha256 of the canonical content equal on **all 63 tables** (every column, nothing excluded) — 1,899,789 values |
| History invariants (same SQL on both engines) | 18 / 18 equal: attendance per status · duplicate logical attendance (0) · OT per status + approved minutes · corrections per type/status · version chains + VOID versions · approval history · audit events per type with first/last id · role snapshots · exceptions · payroll adjustment queue with time deltas · schedule effective dating · legal-entity links · payroll runs · finalized gross/net · snapshots · payslips · payments · RBAC counts |
| Primary keys | preserved exactly (they are part of the compared content; nothing renumbered) |
| Identity reset | every identity sequence at `GREATEST(max(id), sqlite_sequence)`; new-record probe: attendance_events 2038 → 2039, timesheet_entries 1621 → 1622, payroll_runs 5 → 6 |
| FK / orphan scan | 0 orphans on 117 declared FKs · 0 on 19 undeclared audit/actor/history references · 0 unvalidated constraints · 0 disabled triggers |
| Source file | sha256 identical before and after (`source untouched: true`), opened read-only |
| Duration | 3 s for 48,673 rows here |

## What preflight blocks (each covered by a test with a deliberately damaged copy)
impossible calendar date · date in another format · ISO `T…Z` timestamp · out-of-range time · orphan FK · duplicate against a partial unique index · NULL in a NOT NULL column (SQLite permits NULL in a TEXT primary key) · text in an INTEGER column · fraction in an INTEGER column · integer beyond the safe range · BLOB in a TEXT column · non-positive id · broken version chain · audit event pointing at a missing attendance row · audit event by a missing user · unknown table · source not at the A3 shape.
Side finding: A3's own SQLite triggers refused my attempts to damage audit history in the test copies — they had to be dropped in the throwaway copy first. The A3 immutability was real.
**Not modelled in preflight, on purpose:** CHECK constraints. They are enforced by PostgreSQL during `--dry-run`/load; a violation rolls back everything and names the table and constraint (tested).

## Post-migration smoke (`tools/dbm1/smoke-migrated.js`, real server, runtime role, RBAC on)
attendance source 25/25 · payroll + RBAC source 27/27 · payroll source (no users → library level) 6/6. Covered: sign-in with a migrated bcrypt hash · attendance day list · record audit trail · schedule/roster resolution · schedules/patterns · date overrides · OT queue · correction requests, detail and approval history · record version chain · Actor Activity History · Audit Center · Exception Center · Payroll Adjustment Queue · finalized-payroll impact references · payroll periods, runs, run detail, lines, payslips, payment reconciliation, payment batches · 401 without a session · migrated FINALIZED payroll still immutable · attendance under a migrated FROZEN snapshot loaded as history and still protected · a new record gets an id above all history (probe rolled back). All expectations are derived from the migrated data itself.

## Decisions
* **One transaction, savepoint per table** rather than a transaction per table: a half-migrated database is the one state that must never exist. Per-table error reporting is kept through the savepoints.
* **Strict timestamp format.** Only `YYYY-MM-DD HH:MM:SS` is accepted. An ISO string would load, but would be returned in a different representation — that is a silent normalisation, so it blocks.
* **`sessions` not migrated** (ephemeral). **`sqlite_sequence` honoured** so a deleted historical id is never reissued.
* The runtime role cannot run the migration (it cannot disable triggers) — tested.

## Unresolved migration risks
1. **No production SQLite file has been migrated — none exists in this project yet.** The three sources are genuine A3 databases but were generated by the A3 suites/seed. A real file may carry data shapes the suites never produce; that is exactly what `--preflight` and `--dry-run` are for, and they must be run on it before cut-over.
2. Preflight and reconciliation read a table into memory for hashing. Fine at the sizes here (largest table 33k rows); a multi-million-row production table should be verified at CP5 scale and, if needed, hashed in key ranges.
3. Employee documents / uploaded files (`uploads/`) live on disk, not in the database; they must be copied alongside (paths are preserved as text).
4. Invariant list is representative, not exhaustive — the exhaustive guarantee is the per-table content checksum.

## CP4 regression evidence (clean extracted copy, `npm ci`, PostgreSQL 16.15, one uninterrupted run, runtime role)
| Check | Result |
|---|---|
| `check:payroll-freeze` | INTACT — `PAYROLL_CORE_STABLE_V1_POSTGRES` |
| Pure formula files vs preserved V1 SQLite lock | 4/4 byte-identical |
| DB-M1 foundation / data migration | 45 / 32 passed, 0 failed |
| Attendance A1 / A2 / A3 | 55 / 83 / 55 = 193 passed, 0 failed |
| Payroll (16 suites) | **545 passed, 0 failed** |
| Test databases left behind | 0 |
CP3 parity fixes, the preserved A3 earliest-assignment behaviour and the four unordered `LIMIT 1` probes are unchanged. Project/Workfront scope: unchanged — PARTIAL / NOT ENFORCED.

---
# CP5 — performance, scale, concurrency (2026-09-21/22)
Full report: **`docs/DB_M1_PERFORMANCE_REPORT.md`**. Raw results: `docs/cp5-raw/` (`final/` = idle-machine after-state, `after/` = first after-runs incl. monitored parallel-write rush hour, root = before-state).
**Headline:** the asynchronous migration (CP2) had silently removed the write serialisation that synchronous SQLite gave every request. 12 simultaneous decisions on one correction were ALL accepted. Closed in CP5 with `middleware/writeSerializer.js` (default ON; covers all 52 unguarded state transitions incl. the 31 in frozen payroll files, without editing them) plus state-guarded correction transitions. Exactly one winner now; rush-hour throughput unchanged.
Changes: `database/db.js` + `middleware/dbStats.js` (opt-in statistics) · `middleware/writeSerializer.js` · `server.js` (2 mounts) · `routes/attendance-correction.js` (policy memo in the exception scan; guarded status transitions, new 409 `CORRECTION_STATE_CONFLICT`) · `database/pg/migrate-from-sqlite.js` (chunked reconciliation, SQL duplicate-PK check, timings/peak RSS) · migration `0005` (one evidence-based index) · `tools/scale/*` · `tests/dbm1-cp5.test.js` (16).
Frozen payroll files: NOT modified. Payroll N+1 (524,735 statements per 1,500-employee run): measured, documented, NOT fixed. Project/Workfront: PARTIAL / NOT ENFORCED.
