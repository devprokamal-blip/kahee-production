# DB-M1 — SQLite → PostgreSQL — FINAL REPORT

**DB-M1 = PASS** (subject to the known production risks in §8, none of which blocks development).
Package: `KAHE360_INTERNAL_DEVELOPMENT_POSTGRES_DBM1_FINAL.zip` — the new authoritative development baseline.
Rollback baseline (untouched): `KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3.zip`, sha256 `173fed1e573aff420dda092b1703e16ddc19697e86b17263bb5468f0dbe6ba36`.
Detailed records: `docs/DB_M1_POSTGRES_MIGRATION.md` (CP1–CP5 decisions and evidence) · `docs/DB_M1_PERFORMANCE_REPORT.md` · `docs/DATABASE_ARCHITECTURE.md` · `docs/POSTGRES_MIGRATION_RUNBOOK.md`.

## 1. Checkpoints
| CP | Scope | Result |
|---|---|---|
| 1 | Canonical async layer, pool, versioned migrations, PostgreSQL-native schema (63 tables, 125 indexes, 100 CHECKs, 117 FKs, 30 triggers), owner/runtime roles, test harness | PASS |
| 2 | 28 DB-coupled frozen files + all open code converted; 19 suites ported mechanically | PASS |
| 3 | Golden Payroll Parity: 5,164,797 stored values + 7 bank files + 181 targeted fields vs unmodified A3 — **BUSINESS OUTPUT DIFF = ZERO**; freeze re-baselined `PAYROLL_CORE_STABLE_V1_POSTGRES` | PASS |
| 4 | One-way data migration: preflight (report + block), FK-derived order, ids preserved, identity reset, reconciliation before COMMIT, ledger | PASS |
| 5 | 100 / 1,500 / 4,000 / 6,000-worker 12-month profiles, rush hour, N+1 evidence, evidence-based index, chunked reconciliation, write-serialisation + state guards | PASS |
| 6 | Backup/restore verification, failure injection, connection loss, PostgreSQL-only runtime, final docs and package | PASS |

## 2. Backup (CP6)
`pg_dump` 16.15, custom format, as the schema-owner role (no superuser).
| Database | Rows | Dump | Size | TOC entries |
|---|--:|--:|--:|--:|
| migrated A3 attendance history | 8,094 | 0.2 s | 0.4 MB | 798 |
| migrated A3 payroll history + RBAC | 49,223 | 1.4 s | 1.1 MB | 798 |
| 6,000 workers × 12 months | 4,731,892 | 22 s | 65.8 MB | 799 |

## 3. Restore (CP6)
`pg_restore --single-transaction --exit-on-error` into a FRESH database (UTF8, `LC_COLLATE 'C'`), as the owner role. Errors: none. Restore time 0.3 s / 0.8 s / 36 s.

## 4. Post-restore reconciliation (CP6) — source vs restored, all three databases
| Compared | Result |
|---|---|
| Columns (type, nullability, default, identity) | 998 = 998, identical |
| Constraints (PK, FK, UNIQUE, CHECK, all validated) | 299 = 299, identical |
| Index definitions | 208 = 208 (209 = 209 with migration 0005), identical |
| Triggers — definition AND enabled state (30 integrity + 4 TRUNCATE guards) | 34 = 34, identical, 0 disabled |
| Functions | 33 = 33, identical bodies |
| Sequence positions | 58 = 58, identical |
| Runtime-role table privileges | 66 = 66, identical |
| Encoding / collation | identical |
| Rows | 8,094 = 8,094 · 49,223 = 49,223 · 4,731,892 = 4,731,892 |
| Content — chunked sha256 of every column of every row, all 66 tables | 0 tables differ |
| As the RUNTIME role on the restored database | audit UPDATE/DELETE blocked · version history blocked · finalized payroll blocked · TRUNCATE, DDL, DROP, ledger writes refused · new record id above all restored ids (2,222,777 → 2,222,778) |
Evidence: `docs/backup-restore-evidence/*.report.json`. Tool: `npm run db:verify-backup`.

## 5. Failure injection & connection loss (CP6) — `tests/dbm1-cp6.test.js`, 15/15, real server, runtime role
A trigger armed by the schema owner makes PostgreSQL fail at a LATE step of each operation:
| Operation | Fault injected at | Outcome |
|---|---|---|
| Attendance create | immutable audit insert | 5xx; no attendance row, no event; identical request then → 201, exactly 1 row + 1 event |
| Overtime decision | audit insert | 5xx; still `pending`, nothing approved; then approved exactly once; a second decision → 409 |
| Correction approve → version → apply → audit | version snapshot insert | 5xx; request still SUBMITTED, attendance row unchanged, 0 new version / history / audit / queue rows |
| same | approval-history insert | same — nothing survives |
| same | audit event insert (last step) | same — nothing survives |
| same, no fault | — | APPLIED atomically: version chain 1→2, attendance updated, history + audit written |
| Backend killed mid-transaction | — | error surfaces, 0 rows committed, dead connection never reused, pool heals |
| Lost connection inside `withRetry` | — | attempted once: a lost connection is NOT retried (outcome unknown); only `40001/40P01/55P03` are |
| Every server connection killed | — | server process stays up; 6/6 following reads succeed; a write succeeds — no restart |
| Connection killed DURING a write request | — | client gets 5xx, no partial row, the write queue is not stuck, the repeated request → 201 |
**Defect found by this work and fixed:** `pg-pool` listens for connection errors only on IDLE clients. A connection dying while a transaction held it emitted an unhandled `'error'` and **crashed the Node process** — i.e. a database restart or fail-over during a write would have taken the application down. `withTransaction` now owns the client's errors while it holds the client and destroys the dead connection (`database/db.js`, shared non-frozen file).
**Not covered at HTTP level:** payroll-impact queue creation failure (needs a finalized-payroll fixture); it runs inside the same transaction as the steps above and is covered by their all-or-nothing result only by construction. Frozen payroll flows keep the atomicity tests of the 545 suite (rollback tests in phase0/0b/e2e) — no new injection was added to frozen suites.

## 6. Regression — final, clean extracted copy, one uninterrupted run
Clean extracted copy of the final package · `npm ci` · PostgreSQL 16.15 · suites run as the least-privilege runtime role.
| Check | Result |
|---|---|
| `check:payroll-freeze` | **INTACT** — `PAYROLL_CORE_STABLE_V1_POSTGRES`, 48 frozen files (shared-file NOTE: `database/db.js`, `server.js`) |
| Pure formula files vs the preserved V1 SQLite lock | **4/4 byte-identical** |
| Payroll (16 suites) | **545 passed, 0 failed** |
| Attendance A1 / A2 / A3 (real server, write serializer ON) | **55 / 83 / 55 = 193 passed, 0 failed** |
| DB-M1 Foundation | **45 passed, 0 failed** |
| DB-M1 Data Migration | **32 passed, 0 failed** |
| DB-M1 CP5 correctness | **16 passed, 0 failed** |
| DB-M1 CP6 failure injection / connection loss / PostgreSQL-only | **15 passed, 0 failed** |
| **Total** | **846 passed, 0 failed** (738 A3 baseline + 108 DB-M1) |
| Test databases left behind by the regression | 0 (two orphans from two CRASHED development runs of the new CP6 suite — before its fixes — were removed with `dropStaleTestDatabases()`; a suite that ends normally drops its own database) |
| Clean-environment walk-through (bootstrap → migrate → status → seed → start) | 401 unauthenticated · login 200 · attendance / schedule / audit / payroll routes 200 · `/database/*` and `/.env` 404 · sessions stored in PostgreSQL · server banner shows the PostgreSQL target |
BUSINESS OUTPUT DIFF = ZERO (CP3) stands: no frozen payroll file, formula or payroll SQL changed after the CP3 re-baseline. Frozen files changed in CP4–CP6: NONE.

## 7. PostgreSQL-only runtime confirmation
* No file under `lib/`, `routes/`, `middleware/`, `scripts/`, nor `server.js`, `database/db.js`, `database/init-db.js`, `database/seed.js`, `database/pg/migrate.js`, `database/pg/bootstrap.js` loads SQLite (test-enforced). `package.json` has no SQLite dependency; the only driver is `pg`.
* The server refuses to start without `DATABASE_URL`, against an unmigrated schema, or against a schema older than the code (test-enforced). No SQLite fallback exists. No dual-write exists.
* SQLite remains ONLY in: `database/legacy-sqlite/` (A3 schema reference + old-file upgrade scripts), `database/pg/migrate-from-sqlite.js` (reads a source file read-only), DB-M1 tests/tools that build throw-away source files, and `tools/parity/` (runs the unmodified A3 package for comparison).

## 8. Remaining known production risks
1. **Write serialisation is per process.** `middleware/writeSerializer.js` restores A3's one-write-at-a-time guarantee for ALL write paths, but only inside one Node process. 52 state-changing UPDATEs are not conditional on the state they validated — 31 in FROZEN payroll files. Before any multi-process / clustered deployment these need statement-level guards (a payroll-change decision). Single-process LAN deployment (today's target) is safe.
2. **Payroll engine N+1** (524,735 statements per 1,500-employee run; ≈ 11–13 min regression). Correct, slow, and — with write serialisation — a long payroll calculation delays other writes while it runs. Run payroll off-peak. Documented, deliberately NOT fixed (frozen code; needs approval + parity rerun + freeze re-baseline).
3. **No production SQLite file has ever been migrated** — none exists yet. `--preflight` and `--dry-run` are mandatory on the real one.
4. **Unpaginated list endpoints** (Exception Center, Correction requests, OT queue, daily list) grow linearly: ≈ 0.4–0.55 s and several MB at 6,000 workers. A4 item.
5. **Benchmarks were single-VM, loopback, `fsync=off`.** Re-measure durable writes and LAN latency on production hardware; every extra 0.5 ms of round trip adds ≈ 15 ms to a clock-in and minutes to a payroll run.
6. **Project/Workfront scope = PARTIAL / NOT ENFORCED** (unchanged from A3; `workfront`/`project_code` deliberately unindexed until that phase defines the access path).
7. Backups are logical (`pg_dump`). Point-in-time recovery, replication, TLS, PgBouncer and secret management are documented recommendations, not configured by this project.
8. Four unordered `LIMIT 1` probes name an arbitrary example when several conflicts exist (decision unaffected) — optional `ORDER BY id` awaiting approval. Pre-existing A3 behaviour preserved: the group-membership API shows only the earliest assignment row's dates when an employee has several in one period (payroll unaffected).
9. PostgreSQL surrogate ids may have gaps after failed transactions (harmless; historical ids are preserved exactly by the migration).
10. Windows: `START_KAHE360.bat` now requires a running PostgreSQL service and a filled `.env`; it applies migrations and seeds demo data on every start as before. It was edited but could not be executed in this Linux sandbox — **untested on Windows**.

## 9. Is DB-M1 safe to become the new authoritative development baseline?
**Yes.** Every mandatory criterion of the DB-M1 brief is met with executed evidence: A3 baseline reproduced; real PostgreSQL throughout; versioned migrations; one-way data migration with zero-difference reconciliation on real A3 files; history, ids, audit immutability and role snapshots preserved; atomicity proven by fault injection; A1–A3 193/193 and payroll 545/545 on PostgreSQL; business output byte-identical to A3; freeze intact and pure formula files byte-identical; 100 / 1,500 / 4,000 / 6,000-worker scale and rush-hour concurrency measured; backup → restore proven identical; clean-package verification passed.
It is a DEVELOPMENT baseline. Production cut-over still requires: a real preflight/dry-run on the production SQLite file (if one exists by then), production-hardware measurements, a decision on risks 1–2, and a Windows start-up test.
**Next phase (only after explicit approval): A4 — Attendance Operations.** Not started.
