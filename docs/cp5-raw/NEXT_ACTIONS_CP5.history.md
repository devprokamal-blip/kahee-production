# DB-M1 CP5 — COMPLETED (this hand-over is kept as history)

All eleven continuation steps below were executed in the following session; results: `docs/DB_M1_PERFORMANCE_REPORT.md`. One statement in this file proved WRONG and is corrected there: the first-session rush-hour files reported `peak_lock_waiters`, `peak_active_queries` and `longest_transaction_ms` as 0 because the monitoring role could not see other roles' session state; they were re-measured through a monitoring role.

---
# DB-M1 CP5 — RESUMABLE STATE & NEXT ACTIONS (written 2026-09-21)

**CP5 = IN PROGRESS, NOT PASS.** This file is the hand-over for the next session. Package: `KAHE360_INTERNAL_DEVELOPMENT_DBM1_CP5_INPROGRESS.zip`.

## Locks (unchanged — do not break)
- DO NOT modify frozen Payroll files. DO NOT fix the Payroll N+1 in CP5. DO NOT start CP6. DO NOT start A4.
- DB-M1 CP1–CP4 = completed. `BUSINESS OUTPUT DIFF = ZERO` (CP3) remains authoritative.
- Project/Workfront scope = PARTIAL / NOT ENFORCED.
- Malformed-date handling = CP4 SQLite-source preflight (report and block).

## Baseline (last full clean-copy run = end of CP4; NOT yet rerun after the CP5 code changes below)
Payroll 545/545 · Attendance 55+83+55 = 193/193 · DB-M1 Foundation 45/45 · DB-M1 Data Migration 32/32 (rerun during CP5 after the
reconciliation rewrite: 32/32) · pure formula files 4/4 byte-identical · `PAYROLL_CORE_STABLE_V1_POSTGRES` INTACT at end of CP4.
**Frozen Payroll files have NOT been modified in CP5.** `database/db.js` is a SHARED (warning-level) file in the freeze manifest and WAS
changed (opt-in statistics), so `check:payroll-freeze` prints a shared-file NOTE, not DRIFT. Verified at packaging time: `check:payroll-freeze` = INTACT (NOTE on `database/db.js`, `server.js`), `check:payroll-pure` = 4/4 byte-identical, every changed file passes `node --check`. The 545 / 193 / 45 suites have NOT been rerun since the CP5 changes.

## Files changed / new in CP5 (all non-frozen)
| File | Change |
|---|---|
| `database/db.js` (shared) | opt-in query statistics, OFF unless `KAHE_DB_QUERY_STATS=1`: `runWithQueryStats`, `statsStorage`, per-statement counters; no behaviour change when off |
| `middleware/dbStats.js` (new) | per-request statistics scope + `X-DB-Stats` header, no-op unless the env var is set |
| `server.js` (shared) | one line: mounts `middleware/dbStats` |
| `routes/attendance-correction.js` | Exception Scan: correction policy resolved once per (legal entity, work date) instead of once per row (memo inside the request; same function, same arguments, same transaction) |
| `database/pg/migrate-from-sqlite.js` | reconciliation is now CHUNKED (20,000 rows, primary-key order, every row and column, no sampling); preflight no longer keeps a primary-key set in memory (SQL duplicate check instead); report gains `performance` (timings, peak RSS) |
| `database/pg/migrations/0005_cp5_evidence_indexes.sql` (new) | `CREATE INDEX idx_attendance_events_employee ON attendance_events (employee_id, id)` |
| `tools/scale/generate-sqlite.js` (new) | deterministic synthetic A3-shape scale fixture (no real persons) |
| `tools/scale/bench-http.js` (new) | workload benchmark through the real server + SQL statistics + EXPLAIN (ANALYZE, BUFFERS) of the slowest statement |
| `tools/scale/rush-hour.js` (new) | 07:45–08:00 clock-in peak simulator + duplicate replay + pg_stat sampling |
| `tools/scale/stats-preload.js` (new) | measures SQL traffic of any unmodified script (`node -r`) |
| `docs/cp5-raw/*` (new) | raw result files listed below |
| `docs/NEXT_ACTIONS_CP5.md`, `PROJECT_CHECKPOINT.md` | this hand-over |
NOTE: migration 0005 changes the migration set, so the test template database is rebuilt automatically on the next test run.
NOTE: `tests/dbm1-foundation.test.js` asserts "all A3 indexes exist" (superset check) — expected to still pass with the extra index, NOT yet rerun.

## Scale datasets — generated, migrated with the CP4 tool, reconciled (row difference 0, content match on all 63 tables, 18/18 invariants)
12 months 2025-10-01..2026-09-30; schedules with 2 effective-dated versions; fixed-weekly / custom-weekly / 6-day + 21-day rotating /
date-based roster; date overrides; OT requests + decisions; corrections + version chains + approval history; exceptions; audit events with
actor + role snapshot; 36 payroll periods; frozen snapshots; 33 finalized runs with lines, components, payslips, payment batches + items.
| Workers | Total rows | Attendance | OT rows | Corrections | Versions | Approval actions | Exceptions | Audit events | Payroll-related | DB size |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 100 | 78,013 | 26,500 | 4,773 | 396 | 580 | 1,029 | 1,060 | 36,337 | 11,202 | 33 MB |
| 1,500 | 1,162,001 | 397,500 | not yet read | 5,961 | 8,742 | 15,498 | 15,900 | 545,071 | 166,602 | 291 MB |
| 4,000 | 3,097,719 | 1,060,000 | not yet read | 15,900 | 23,320 | 41,340 | 42,400 | 1,453,540 | 444,102 | 750 MB |
| 6,000 | 4,646,280 | 1,590,000 | 286,200 (251,640 approved) | 23,850 | 34,980 | 62,010 | 63,600 | 2,180,310 | 666,102 | 1,115 MB |
The PostgreSQL scale databases (`kahe360_scale_<W>`) and SQLite sources (`/tmp/scale/w<W>.db`) live only in the sandbox and will NOT survive
a new session. Rebuild: `node tools/scale/generate-sqlite.js <W> <file>` → fresh migrated DB → `npm run db:migrate-from-sqlite -- --source <file>`
(6,000 workers: generate 24 s, migrate+reconcile ≈ 7 min). Then `npm run seed` + grant entity scope to the seeded users (needed by the HTTP tools).

## Chunked reconciliation — results
| Workers | Rows | Values compared | Preflight | Load | Reconcile | Peak RSS |
|---|--:|--:|--:|--:|--:|--:|
| 100 | 78,013 | 2,624,318 | 1.2 s | 3.1 s | 1.2 s | 352 MB |
| 1,500 | 1,162,001 | 39,275,372 | 13.4 s | 42.1 s | 20.3 s | 556 MB |
| 4,000 | 3,097,719 | 104,724,223 | 36.3 s | 116.9 s | 47.7 s | 561 MB |
| 6,000 | 4,646,280 | 157,083,031 | 54.4 s | 214.3 s | 160.1 s | 559 MB |
Memory is flat from 1.16 M to 4.65 M rows (bounded). The 4,000/6,000 timings were taken while other jobs ran — pessimistic.

## Measured N+1 — Payroll (FROZEN code: measured, deliberately NOT fixed)
`KAHE_DB_QUERY_STATS=1 node -r ./tools/scale/stats-preload.js tests/phase2d.test.js` → 37/37 pass · wall 261.9 s · **524,735 statements** · 80 distinct.
146,900 × `SELECT * FROM employees WHERE id = $1` · 146,899 × employee salary-component as-of lookup · 146,730 × `employee_payroll_assignments` as-of lookup
(≈ once per employee per DAY; ≈ 84 % of all statements). Cause of the 11–13 min payroll regression. Fix = per-employee memoisation inside frozen
libs → needs explicit approval, full golden-parity rerun and a second freeze re-baseline. Proposed as its own step AFTER CP5.

## Measured N+1 — Exception Scan (non-frozen) — optimisation APPLIED, after-state NOT yet measured
Before (6,000 workers, one business day): 1.9 s · 8,922 statements · 6,000 of them the identical `attendance_correction_policies` lookup.
Applied: policy memo per (entity, date) in `routes/attendance-correction.js`. Remaining per-row work: `findOverlap` + exception upsert.
Must rerun `tests/attendance-a3.test.js` (covers the scan) — NOT yet rerun after this change.

## New index — after-state NOT yet measured
Before: Audit Center filtered by employee — p50 339 ms, p99 1.4 s; plan walked `attendance_events_pkey` backwards, 2,179,950 rows removed by filter for 200 returned,
283 ms, 40,375 block reads. `0005` applied ONLY to `kahe360_scale_6000` so far.

## 6,000-worker benchmark — BEFORE optimisation (raw: `docs/cp5-raw/bench_6000.before.json`; 25 iterations, real server, RBAC, runtime role)
p99 < 60 ms: schedule / rotating / date-roster resolution, record history, actor activity, Audit Center (unfiltered), record audit trail, payroll periods,
period detail, payment reconciliation, runs, run lines, payslips (run + employee), payment batch detail. Daily attendance p50 155 / p99 404 ms (3,600 rows).
OT pending p99 163 ms (5,940 rows). Exception Center open p99 347 ms (25,440 rows, unpaginated). Correction requests p99 558 ms (23,850 rows, unpaginated, sort spilled to disk: 899 temp blocks).
Monthly attendance recap: NOT BUILT (A4) — not benchmarked, must not be invented.
`bench_1500.json` and `bench_100.json` were produced AFTER the scan memo but BEFORE index 0005 on those databases; `bench_4000.before.json` = before both.

## Rush-hour result files — GENERATED, NOT YET READ (except the 100-event trial)
`docs/cp5-raw/rush_1500.json` (1,500 events, 50 in flight) · `rush_4000.json` (4,000, 100) · `rush_6000.json` (6,000, 200) · `rush_6000_pool20.json` (6,000, 200, PGPOOL_MAX=20)
— all against the 6,000-worker database, business dates 2025-09-22..25 (a date after "business today" is correctly refused with ATTENDANCE_DATE_IN_FUTURE).
Each file holds: events/s, p50/p95/p99/max, HTTP status histogram, error samples, rows + audit events created, DB inserts/s, commits/rollbacks, deadlocks,
peak DB connections vs pool max, peak active queries, peak lock waiters, longest transaction, duplicate-replay outcome, integrity flag.
Only result seen so far — `rush_100.json` (100 events, 20 in flight, machine busy): 100/100 accepted (201), 40 events/s, p50 454 / p95 764 / p99 827 ms, 100 rows + 100 audit events,
duplicates 10/10 refused with 409 DUPLICATE, 0 duplicate employee-days, 0 deadlocks, 0 rollbacks, peak connections 10 = pool max, ≈ 27 SQL statements per clock-in.

## EXACT CONTINUATION SEQUENCE
1. Read and report rush-hour 1,500 / 4,000 / 6,000 (and pool-20) results from `docs/cp5-raw/rush_*.json`.
2. Report throughput, p50/p95/p99, peak connections, error rate, lock waits, deadlocks, transaction duration, duplicate/idempotency behaviour.
3. Benchmark the new `attendance_events(employee_id, id)` index after-state (rebuild the 6,000 profile if the sandbox was reset; apply 0005; rerun `tools/scale/bench-http.js`).
4. Benchmark the optimised Exception Scan after-state (statement count + latency, same tool).
5. Complete the EXPLAIN (ANALYZE, BUFFERS) evidence table (index vs seq scan, rows scanned vs returned, execution time, buffer hits/reads, sort/hash spills) and the index validation list
   (employee+work_date · legal entity+work_date · payroll period · attendance status · correction status · exception status · actor+timestamp · workfront · effective-date resolution · audit/history); add/remove indexes only on evidence; no duplicates.
6. Complete the PgBouncer readiness note (transaction pooling vs this layer: session `options`, advisory lock in the migrator, no prepared-statement names, LISTEN not used) and the pool-exhaustion behaviour test.
7. Add a CP5 correctness suite (e.g. `tests/dbm1-cp5.test.js`): statistics are OFF by default and change no result; exception scan with memo == without (same exceptions); chunked reconcile == whole-table hash and detects a tampered row across a chunk boundary; index 0005 present; concurrent duplicate clock-in → exactly one row; pool never exceeds `PGPOOL_MAX`; deadlock retry.
8. Write `docs/DB_M1_PERFORMANCE_REPORT.md` (100 / 1,500 / 4,000 / 6,000 tables, rush hour, N+1, indexes, EXPLAIN, reconciliation, unresolved production-scale risks) and update `docs/DB_M1_POSTGRES_MIGRATION.md`, `docs/DATABASE_ARCHITECTURE.md`, `PROJECT_CHECKPOINT.md`.
9. Rerun final regressions on a clean copy: Payroll 545 · Attendance 193 · Foundation 45 · Data Migration 32 · new CP5 suite · `check:payroll-pure` 4/4 · `check:payroll-freeze` INTACT.
10. Create `KAHE360_INTERNAL_DEVELOPMENT_DBM1_CP5_WIP.zip`.
11. STOP for approval before CP6.

## Sandbox notes for the next session
Commands are killed after 300 s: run long jobs with `setsid nohup … &` and poll a log. PostgreSQL 16 must be reinstalled/started if the sandbox was reset
(`apt-get install postgresql-16`, initdb, scram auth, roles via `npm run db:bootstrap`). Tests need `TEST_DATABASE_ADMIN_URL`. The golden parity harness needs `KAHE_A3_ROOT` = extracted A3 package.
