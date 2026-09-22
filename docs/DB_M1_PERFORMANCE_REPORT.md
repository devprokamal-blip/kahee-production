# DB-M1 — Performance, Scale & Concurrency Report (CP5)

PostgreSQL 16.15 · Node 22 · `pg` 8 pool (`PGPOOL_MAX=10`) · ONE application process · server and database on the same sandbox VM
(`fsync=off` on this throw-away server: write numbers are optimistic for durability cost, read numbers are unaffected; no table is
UNLOGGED and no attendance data bypasses WAL). All workloads go through the REAL server: session, RBAC, legal-entity scope, runtime
role. Raw files: `docs/cp5-raw/`. Tools: `tools/scale/`. **No number here is a target; all are measurements.**

## 1. Datasets — synthetic, non-sensitive, deterministic (`tools/scale/generate-sqlite.js`), 12 months 2025-10-01..2026-09-30
Generated in the authoritative A3 SQLite shape and moved with the real CP4 migration tool, so every profile also exercised preflight,
load and reconciliation (row difference 0, content match on all 63 tables, 18/18 invariants, 0 orphans — all four profiles).
| Workers | Total rows | Attendance | OT rows | Corrections | Versions | Approval actions | Exceptions | Audit events | Payroll-related | DB size (tables + indexes) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 100 | 78,013 | 26,500 | 4,773 | 396 | 580 | 1,029 | 1,060 | 36,337 | 11,202 | 35 MB (idx 10) |
| 1,500 | 1,162,001 | 397,500 | ≈ 71,500 (18 %) | 5,961 | 8,742 | 15,498 | 15,900 | 545,071 | 166,602 | 313 MB (idx 117) |
| 4,000 | 3,097,719 | 1,060,000 | ≈ 190,800 (18 %) | 15,900 | 23,320 | 41,340 | 42,400 | 1,453,540 | 444,102 | 808 MB (idx 304) |
| 6,000 | 4,646,280 | 1,590,000 | 286,200 (251,640 approved) | 23,850 | 34,980 | 62,010 | 63,600 | 2,180,310 | 666,102 | 1,295 MB (idx 455) |
OT rows for 1,500 / 4,000 are derived from the generator's fixed 18 % rule (counted exactly only for 100 and 6,000). Sizes include the rush-hour rows and index 0005.
Content: 3 legal entities · schedules with 2 effective-dated versions · fixed-weekly, custom-weekly, 6-day and 21-day rotating, date-based roster · date overrides ·
status mix (present/late/sick/absent/leave/no_show) · OT requested/approved/rejected/pending · corrections + VOIDs with version chains and approval history · exceptions
open/resolved · audit events with actor + role snapshot · 36 payroll periods · frozen input snapshots · 33 finalized runs, lines, 6 components per line, payslips, payment batches + items.
**Limit:** the payroll rows are structurally valid history, not engine-calculated payroll (the engine needs full rule-set/salary configuration); engine cost is measured separately in §5.

## 2. Rush-hour clock-in (07:45–08:00 WIB peak) — 6,000-worker database, distinct workers, one new business day per run
`POST /api/timesheet/entries` = RBAC + entity scope + eligibility + payroll-stream/cutoff guard + schedule resolution + insert + immutable audit event, ≈ 33 SQL statements per clock-in.
| Run | Events | In flight | Duration | Events/s | DB inserts/s | p50 | p95 | p99 | max | Errors | Deadlocks | Lock-wait samples | Longest tx | Peak DB conns / pool |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| parallel writes | 1,500 | 50 | 16.5 s | 91 | 174 | 512 ms | 838 ms | 1,231 ms | 1,353 ms | 0 % | 0 | 0 / 167 | 83 ms | 10 / 10 |
| parallel writes | 4,000 | 100 | 42.9 s | 93 | 177 | 1,036 ms | 1,350 ms | 2,044 ms | 2,287 ms | 0 % | 0 | 0 / 437 | 58 ms | 10 / 10 |
| parallel writes | 6,000 | 200 | 64.7 s | 93 | 178 | 1,996 ms | 3,603 ms | 4,088 ms | 4,337 ms | 0 % | 0 | 0 / 647 | 110 ms | 10 / 10 |
| **serialized writes (shipped default)** | 1,500 | 50 | 15.8 s | 95 | 170 | 495 ms | 766 ms | 1,003 ms | 1,209 ms | 0 % | 0 | 0 / 164 | 10 ms | 10 / 10 |
| **serialized writes (shipped default)** | 4,000 | 100 | 39.2 s | 102 | 193 | 946 ms | 1,127 ms | 1,525 ms | 1,951 ms | 0 % | 0 | 0 / 405 | 19 ms | 10 / 10 |
| **serialized writes (shipped default)** | 6,000 | 200 | 55.6 s | 108 | 202 | 1,793 ms | 2,209 ms | 2,619 ms | 3,179 ms | 0 % | 0 | 0 / 579 | 6 ms | 10 / 10 |
| parallel, `PGPOOL_MAX=20` (first session) | 6,000 | 200 | 58.6 s | 102 | 196 | 1,924 ms | 2,229 ms | 3,731 ms | 4,311 ms | 0 % | 0 | not valid* | not valid* | 20 / 20 |
* **Reading:** every event accepted (201), exactly one attendance row and one audit event per event, 0 rollbacks. Duplicate replay (10 % resent): 100 % refused with `409 DUPLICATE`, 0 duplicate employee-days.
* **Capacity:** 6,000 clock-ins need 6.7 events/s if spread over 15 minutes; measured ≈ 95–108 events/s = **≈ 15× headroom**; all 6,000 arriving at once drain in < 1 minute.
* **Bottleneck = the single Node process (CPU + ≈ 33 sequential round trips per event), not PostgreSQL:** doubling the pool changed nothing, no lock waits, longest transaction 110 ms. Latency under burst is queueing time (≈ in-flight ÷ throughput).
* **Serialising writes costs nothing here** (95–108 vs 91–93 events/s) because the process was already the limit.
* *The first-session runs sampled `pg_stat_activity` as a non-privileged role, which hides other roles' `state`/`wait_event`/`xact_start`; their lock-wait and transaction-age figures were therefore INVALID and were re-measured through a monitoring role. Counts, latencies, deadlocks (from `pg_stat_database`) were valid.
* The connection pool never exceeded its maximum; the application does not open a connection per request/device.

## 3. Concurrency defect found and closed — the most important CP5 result
Through A3 the application ran on synchronous `node:sqlite`: each request ran to completion before the next began. Code of the form "load the row → check its status in JavaScript → `UPDATE … WHERE id = ?`" was safe **only because of that**. With asynchronous PostgreSQL access (since CP2) such requests can interleave.
**Measured** (`tools/scale/race-decide.js`, 12 simultaneous approve/reject decisions on ONE submitted correction, real server, fresh database clones):
| Code | HTTP 200 | HTTP 409 | Approval-history rows | Applied versions | Audit events | Exactly one winner |
|---|--:|--:|--:|--:|--:|---|
| CP2–CP5-in-progress | **12** | 0 | 18 (6 × approved+applied, 6 × rejected) | **6** | 26 | **NO** |
| CP5 final | 1 | 11 (`CORRECTION_STATE_CONFLICT`) | 2 | 1 | 5 | YES |
The 738 + 77 tests could not see this: they are sequential. A static scan finds **59 state-changing UPDATEs, 52 not conditional on the state they validated — 31 of them in FROZEN payroll files** (run transitions, payment batches/items, adjustments, billing, add-ons, periods), 21 in open code (exceptions, HR, payroll configuration, schedules).
Two layers, neither touching business rules or frozen files:
1. **`middleware/writeSerializer.js` (default ON):** mutating API requests run one at a time in arrival order — exactly A3's write concurrency — while reads stay concurrent on the pool. This covers ALL 52 sites, frozen ones included.
2. **State-guarded transitions in `routes/attendance-correction.js`:** every correction status UPDATE is now `… WHERE id = ? AND status = <validated status>`; the loser gets 409 and its transaction (audit rows included) rolls back — the pattern A1 already used for OT decisions. Defence in depth for multi-process deployments.
**Residual risk (must be decided before any multi-process / clustered deployment):** the serializer is per process. Frozen payroll transitions have no statement-level guard; some are backstopped by triggers and unique indexes (finalized run immutable, single finalized ORIGINAL per period, one live payment item per employee/period) but not all. A long write (a 1,500-employee payroll calculation, §5) delays other writes while it runs — as it did on SQLite.

## 4. Workload benchmark — after optimisation, p50 / p99 in ms (25 iterations each, sequential client, idle machine)
| Workload | 100 | 1,500 | 4,000 | 6,000 | SQL stmts | Rows @6,000 |
|---|--:|--:|--:|--:|--:|--:|
| Daily attendance retrieval | 9.9 / 34.1 | 44.8 / 120.1 | 104 / 220.5 | 144.8 / 269.7 | 6 | 3600 |
| Daily attendance summary | 8.2 / 26.3 | 12.3 / 19.7 | 29.8 / 41.8 | 39.7 / 53.3 | 10 | 9 |
| Schedule resolution (fixed weekly, effective-dated) | 11.8 / 22.3 | 11.4 / 25.1 | 11 / 22.9 | 10.8 / 23.3 | 23 | 17 |
| Rotating roster resolution (21-day cycle) | 9 / 41.7 | 9.1 / 22.4 | 9 / 23.1 | 12 / 25.3 | 22 | 17 |
| Date-based roster resolution | 8.2 / 14.2 | 8.9 / 15.9 | 8.3 / 18.9 | 9.1 / 18.7 | 21 | 17 |
| Overtime lookup (pending queue) | 8.6 / 18.3 | 41.8 / 66.2 | 102.5 / 119.8 | 153.5 / 215.9 | 6 | 5940 |
| Exception Center (open) | 11.1 / 26.1 | 88.7 / 154.4 | 273.2 / 305.7 | 403 / 494.9 | 6 | 27384 |
| Correction requests | 13.1 / 30.6 | 163.3 / 203.2 | 417.8 / 463.2 | 550.6 / 618.8 | 6 | 23850 |
| Correction approval inbox | 5.7 / 22.5 | 21.1 / 58.1 | 55 / 110.1 | 61.5 / 109.9 | 6 | 3180 |
| Record history (version chain) | 5 / 12.3 | 6.3 / 11 | 9 / 18.3 | 5.3 / 11.4 | 11 | 4 |
| Actor Activity History | 9.8 / 24.5 | 15.7 / 46.9 | 21.3 / 34.4 | 25.7 / 47.7 | 8 | 4 |
| Audit Center | 9.5 / 27.8 | 5.8 / 17.1 | 5.4 / 17.7 | 11.2 / 29.2 | 6 | 200 |
| Audit Center filtered by employee | 5.2 / 15.4 | 6.4 / 11.5 | 5 / 9.3 | 5 / 9.1 | 6 | 200 |
| Record audit trail | 4.1 / 16.8 | 5.7 / 12.6 | 4.1 / 20.1 | 3.9 / 11.8 | 7 | 2 |
| Payroll periods | 4.3 / 8.8 | 4.7 / 14.8 | 4.3 / 9.9 | 4.1 / 18.1 | 6 | 48 |
| Payroll period detail (closing reads) | 4 / 8.1 | 4.2 / 5.6 | 4.2 / 10 | 3.8 / 4.6 | 7 | 18 |
| Payment reconciliation of a period (closing reads) | 5.7 / 10.9 | 9.7 / 18.5 | 20.3 / 42.4 | 21.7 / 41.3 | 10 | 8 |
| Payroll runs | 3.9 / 14.5 | 3.7 / 23.9 | 4.8 / 14.1 | 3.8 / 12.3 | 6 | 33 |
| Finalized run lines (one entity, one period) | 4.4 / 6.6 | 6.5 / 8.9 | 9.8 / 38.1 | 10.3 / 27.5 | 7 | 200 |
| Payslips of a run | 4.5 / 21.8 | 6.9 / 13.7 | 12.4 / 25.5 | 10.7 / 19.4 | 7 | 200 |
| Payslips of one employee (12 months) | 3.7 / 6.4 | 3.6 / 11.9 | 5 / 8.8 | 3.6 / 6.2 | 6 | 11 |
| Payment batch detail | 5 / 8.3 | 11.1 / 23.3 | 30.1 / 51.3 | 31.3 / 52.1 | 9 | 3600 |
| Exception scan — one business day (WRITES) | 16 / 21.9 | 144.8 / 208.3 | 572.4 / 590 | 571.2 / 601.6 | 1953 | 3 |
* **Flat with scale (index-driven, < 30 ms p99 at 6,000):** schedule / rotating / date-roster resolution, record history, audit trail, Audit Center (both forms), payroll periods / detail / runs / lines / payslips.
* **Grow linearly because the endpoint returns the WHOLE list:** Exception Center (27,384 rows, 403 ms), Correction requests (23,850 rows, 551 ms, sort spills 899 temp blocks), OT queue (5,940 rows), daily attendance (3,600 rows), payment batch detail (3,600 rows). The SQL is 30–130 ms; the rest is JSON for thousands of rows. These need server-side pagination/filters — a functional change to list endpoints, **not done in DB-M1**; recommended for A4.
* p99 = slowest of 25 requests, so it is sensitive to a single cold-cache hit.
* **Not benchmarked because they do not exist yet (A4):** monthly attendance recap, bulk import, attendance closing/freeze workflow, export files. `GET /entries/summary` (daily) is the only recap-like endpoint.

## 5. N+1 / repeated-query evidence (`KAHE_DB_QUERY_STATS=1`; statistics are OFF by default)
| Workflow | SQL statements | Distinct | Time | Most repeated | Avoidable? |
|---|--:|--:|--:|---|---|
| Clock-in (one `POST /entries`) | ≈ 33 | — | ≈ 10 ms DB | RBAC/session (6) + eligibility + schedule resolution (≈ 17) | partly; not needed at measured headroom |
| Any read endpoint | 6–23 | 6–23 | 4–25 ms | 6 RBAC/session statements per request | cacheable per session; not done (authorization stays authoritative per request) |
| Exception scan, one day @ 6,000 — BEFORE | 8,922 | — | 1,927 ms | 6,000 × identical correction-policy lookup | yes |
| Exception scan, one day @ 6,000 — **AFTER** | **1,953** | — | **571 ms** | policy resolved once per (entity, date); remaining ≈ 1 overlap probe per row + upserts | further batching possible; not needed |
| **Payroll engine, 1,500 employees (`tests/phase2d`, unmodified)** | **524,735** | 80 | 262 s | 146,900 × `employees WHERE id` · 146,899 × salary-component as-of · 146,730 × payroll-assignment as-of (≈ once per employee per DAY; 84 % of all statements) | **yes — but inside FROZEN payroll libraries: measured, documented, NOT fixed in CP5** |
The payroll N+1 is why the payroll regression takes 11–13 min on PostgreSQL (≈ 0.17–0.34 ms per round trip × 0.5 M). Fix = per-employee memoisation inside `employeeEligibility` / `salaryStructure` / `asOfResolver`; it requires approval, a full golden-parity rerun and a second freeze re-baseline. Proposed as a separate step.

## 6. Indexes
**Added (1), on evidence — migration `0005`: `idx_attendance_events_employee (employee_id, id)`.**
| Audit Center filtered by employee @ 6,000 (2.18 M audit rows) | Plan | Rows returned / discarded | Execution | Buffers hit / read | p50 | p99 |
|---|---|--:|--:|--:|--:|--:|
| before | backward `attendance_events_pkey` scan + filter | 200 / 2,179,950 | 283 ms | 6,047 / 40,375 | 339 ms | 1,403 ms |
| after | `Index Scan(idx_attendance_events_employee)`, no sort | 200 / 0 | 0.12 ms | 22 / 0 | 5 ms | 9 ms |
Cost: 85 MB at 6,000 workers; rush-hour insert throughput unchanged (91–93 → 95–108 events/s).
**Validated, no change needed** (index → used by): `timesheet_entries (employee_id, work_date)` UNIQUE → duplicate guard, schedule/eligibility (12,650 scans) · `(legal_entity_id, work_date)` + `(work_date)` → daily retrieval, scan · `(overtime_status)` → OT queue, summary ·
`attendance_corrections (status, legal_entity_id)` → inbox · `(employee_id, work_date)`, `(timesheet_entry_id)` → history · `attendance_exceptions (status, legal_entity_id, work_date)` → Exception Center · partial `uq_exception_open` → scan upsert ·
`attendance_schedule_assignments (employee_id, effective_from)` → effective-date resolution (11,650 scans) · `attendance_events (timesheet_entry_id, id)` → record trail · `(legal_entity_id, work_date)` → Audit Center ·
`payroll_input_snapshots (payroll_period_id, status)`, UNIQUE `(payroll_period_id, employee_id)`, `(employee_id)` → frozen-source trigger (11,350 scans) · `payroll_run_lines (payroll_run_id)` · `payroll_payslips (employee_id, payroll_period_id)`, `(payroll_run_id)` · `payroll_payment_items (batch_id, status)`, `(employee_id, payroll_period_id)`.
**No exact duplicate index exists** (catalogue check). Prefix-redundant A3 indexes left in place deliberately (small; removing them is a schema change with no measured benefit): `idx_timesheet_employee (employee_id)` ⊂ UNIQUE `(employee_id, work_date)`; `idx_run_line_run (payroll_run_id)` ⊂ UNIQUE `(payroll_run_id, employee_id)`.
**Not indexed, deliberately:** `workfront` / `project_code` — no existing query filters on them at volume and Project/Workfront scope is PARTIAL / NOT ENFORCED; index when that security phase defines the access path. Actor Activity History is 26 ms p50 at 6,000 without a dedicated actor index — none added.
No partitioning: 1.59 M attendance and 2.18 M audit rows are served by ordinary b-trees in single-digit milliseconds.

## 7. EXPLAIN (ANALYZE, BUFFERS) — slowest statement of each workload, 6,000-worker database
A `Seq Scan` on `employees` (6,000 rows), `role_permissions` (429), `user_roles`, `work_schedule_breaks` is the correct plan for a small table that is joined in full.
| Workload | Plan nodes | Rows returned / removed by filter | Exec ms | Buffers hit / read | Sort/hash spill |
|---|---|--:|--:|--:|---|
| Daily attendance retrieval | Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_timesheet_date) → Hash → Seq Scan(employees) | 4800 / 0 | 54.08 | 75 / 4805 | no |
| Daily attendance summary | Aggregate → Index Scan(idx_timesheet_overtime_status) | 1 / 0 | 6.91 | 5102 / 0 | no |
| Schedule resolution (fixed weekly, effective-dated) | Sort → Seq Scan(work_schedule_breaks) | 1 / 5 | 0.03 | 4 / 0 | no |
| Rotating roster resolution (21-day cycle) | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.45 | 5 / 0 | no |
| Date-based roster resolution | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.27 | 5 / 0 | no |
| Overtime lookup (pending queue) | Sort → Hash Join → Index Scan(idx_timesheet_overtime_status) → Hash → Seq Scan(employees) | 5940 / 0 | 29.24 | 5176 / 0 | no |
| Exception Center (open) | Gather Merge → Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_exception_status) → Hash → Seq Scan(employees) | 27384 / 0 | 127.36 | 738 / 0 | no |
| Correction requests | Sort → Hash Join → Seq Scan(attendance_corrections) → Hash → Seq Scan(employees) | 23850 / 0 | 56.84 | 1009 / 0 | yes (899 temp blocks) |
| Correction approval inbox | Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_correction_status) → Hash → Seq Scan(employees) | 3180 / 0 | 7.53 | 196 / 0 | no |
| Record history (version chain) | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.28 | 5 / 0 | no |
| Actor Activity History | Limit → Index Scan(attendance_events_pkey) | 500 / 31944 | 13.64 | 28575 / 0 | no |
| Audit Center | Limit → Index Scan(attendance_events_pkey) | 200 / 0 | 0.18 | 201 / 0 | no |
| Audit Center filtered by employee | Limit → Index Scan(idx_attendance_events_employee) | 200 / 0 | 0.12 | 22 / 0 | no |
| Record audit trail | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.27 | 5 / 0 | no |
| Payroll periods | Seq Scan(users) | 1 / 17 | 0.02 | 1 / 0 | no |
| Payroll period detail (closing reads) | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.28 | 5 / 0 | no |
| Payment reconciliation of a period (closing reads) | Aggregate → Sort → Hash Join → Nested Loop → Seq Scan(payroll_runs) → Bitmap Heap Scan → Bitmap Index Scan(idx_run_line_run) → Hash → Seq Scan(employees) | 3600 / 32 | 14.18 | 1814 / 0 | no |
| Payroll runs | Aggregate → Hash Join → Seq Scan(role_permissions) → Hash → Seq Scan(user_roles) → Seq Scan(permissions) | 245 / 17 | 0.28 | 5 / 0 | no |
| Finalized run lines (one entity, one period) | Limit → Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_run_line_run) → Hash → Seq Scan(employees) | 200 / 0 | 6.24 | 1813 / 0 | no |
| Payslips of a run | Limit → Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_payslip_run) → Hash → Seq Scan(employees) | 200 / 0 | 6.23 | 2178 / 0 | no |
| Payslips of one employee (12 months) | Seq Scan(users) | 1 / 17 | 0.02 | 1 / 0 | no |
| Payment batch detail | Sort → Hash Join → Bitmap Heap Scan → Bitmap Index Scan(idx_payment_item_batch) → Hash → Seq Scan(employees) | 3600 / 0 | 15.18 | 1298 / 0 | no |
| Exception scan — one business day (WRITES) | Sort → Bitmap Heap Scan → Bitmap Index Scan(idx_timesheet_date) | 6000 / 0 | 27.35 | 1 / 6006 | no |

Only spill: Correction requests (sorts 23,850 full rows on `created_at DESC, id DESC`; 899 temp blocks) — a consequence of the unpaginated list, see §4.

## 8. Reconciliation at scale (chunked: 20,000 rows, primary-key order, every row and column, no sampling)
| Workers | Rows | Values compared | Preflight | Load | Reconcile | Peak RSS |
|---|--:|--:|--:|--:|--:|--:|
| 100 | 78,013 | 2,624,318 | 1.2 s | 3.1 s | 1.2 s | 352 MB |
| 1,500 | 1,162,001 | 39,275,372 | 13.4 s | 42.1 s | 20.3 s | 556 MB |
| 4,000 | 3,097,719 | 104,724,223 | 36.3 s | 116.9 s | 47.7 s | 561 MB |
| 6,000 | 4,646,280 | 157,083,031 | 54.4 s | 214.3 s | 160.1 s | 559 MB |
Memory is flat from 1.16 M to 4.65 M rows. Proven equal to a one-pass whole-table hash, and to locate a changed value on the first/last row of a chunk and a missing row inside one (`tests/dbm1-cp5.test.js`). 4,000/6,000 timings were taken while other jobs shared the machine.

## 9. Pool & PgBouncer readiness
* One `pg.Pool` per process (`PGPOOL_MAX`, default 10); `getDb()` hands out a facade, never a new connection; a transaction pins ONE client and always releases it (destroyed if its rollback failed). 300 concurrent queries on a pool of 5 peaked at ≤ 5 server connections; exhaustion fails fast (`connectionTimeoutMillis`) and recovers — both tested.
* Sizing: Σ(processes × `PGPOOL_MAX`) well under `max_connections`. At the measured profile one process saturates its CPU before it saturates 10 connections; a larger pool bought nothing.
* **PgBouncer (transaction pooling) compatibility of the canonical layer:** no named prepared statements (unnamed extended protocol only) ✓ · no `LISTEN/NOTIFY` ✓ · no session-level advisory locks in request paths ✓ · no temp tables ✓ · transactions are explicit `BEGIN…COMMIT` on one client ✓ · `SET LOCAL` only inside transactions ✓.
  Two items need deployment care: (1) session settings (`timezone=UTC`, `lock_timeout`, `statement_timeout`) are sent as start-up `options`; with PgBouncer set them per ROLE/DATABASE (`ALTER ROLE kahe360_app SET timezone='UTC'; … SET lock_timeout='5s'`) or list them in `ignore_startup_parameters` + role defaults — **the UTC setting is REQUIRED for correct timestamp rendering**; (2) the migrator and the data-migration tool use a session advisory lock / long transaction and must connect DIRECTLY to PostgreSQL, not through a transaction-pooling PgBouncer.
  PgBouncer was not deployed or benchmarked (infrastructure concern; not needed for an honest single-process benchmark).

## 10. Unresolved production-scale risks
1. **Write serialisation is per process** (§3). Multi-process/clustered deployment requires statement-level guards or advisory locks on the 31 frozen payroll transition sites — a payroll-change decision.
2. **Payroll engine N+1** (§5): correct but slow; 1,500-employee calculation ≈ minutes and, with write serialisation, it delays other writes while it runs. Run payroll off-peak until fixed.
3. **Unpaginated list endpoints** (§4) grow linearly; at 6,000 workers the largest responses are several MB.
4. Single Node process ≈ 100 clock-ins/s ceiling (≈ 15× the need). Device/biometric ingestion (not built) would need a lighter ingestion path, not a bigger pool.
5. Benchmarks ran with app and database on one VM, `fsync=off`, loopback latency ≈ 0.2 ms. A real LAN adds ≈ 0.3–1 ms per round trip: a 33-statement clock-in gains ≈ 10–30 ms, the 0.5 M-statement payroll run gains minutes. Durable-write cost must be re-measured on production hardware.
6. Synthetic data: uniform distributions; real skew (one huge project, month-end correction bursts) is not represented. Payroll history rows are structural, not engine-produced.
7. `pg_dump`/`pg_restore` verification was NOT executed in CP5 (not in the CP5 brief; originally planned) — still open for CP6.
8. Transaction-failure injection tests for correction apply / payroll impact (original DB-M1 §31) are covered only indirectly (rollback-on-conflict in the race test, foundation atomicity tests) — open.

## 11. Final regression after all CP5 changes (clean extracted copy, `npm ci`, PostgreSQL 16.15, one uninterrupted run, runtime role)
| Check | Result |
|---|---|
| `check:payroll-freeze` | INTACT — `PAYROLL_CORE_STABLE_V1_POSTGRES` (shared-file NOTE for `database/db.js`, `server.js`) |
| Pure formula files vs preserved V1 SQLite lock | 4/4 byte-identical |
| DB-M1 foundation / data migration / CP5 | 45 / 32 / 16 passed, 0 failed |
| Attendance A1 / A2 / A3 (real server, write serializer ON, guarded transitions) | 55 / 83 / 55 = 193 passed, 0 failed |
| Payroll (16 suites) | 545 passed, 0 failed |
| Test databases left behind | 0 |
BUSINESS OUTPUT DIFF = ZERO (CP3) stands: no frozen payroll file, formula, or payroll SQL changed in CP5. PAYROLL BUSINESS LOGIC CHANGED = NO.
