# KAHE 360 — Database Architecture (PostgreSQL)

_Final DB-M1 architecture. Evidence and decisions: `docs/DB_M1_FINAL_REPORT.md`, `docs/DB_M1_POSTGRES_MIGRATION.md`, `docs/DB_M1_PERFORMANCE_REPORT.md`. Operations: `docs/POSTGRES_MIGRATION_RUNBOOK.md`._

```
Route / Service  →  database/db.js (canonical layer)  →  pg.Pool  →  PostgreSQL  (single authority)
```
SQLite remains only as migration source, rollback package and schema reference
(`database/legacy-sqlite/`). There is no dual-write and no second authority.

## Canonical layer — `database/db.js`
* The only module that imports the driver (`pg` 8.x). No ORM.
* `db.prepare(sql).get/all/run(...)`, `db.exec(sql)`, `db.query(text, values)` — all async.
* `withTransaction(db, async () => …)`: checks out ONE client, `BEGIN … COMMIT`, `ROLLBACK` on any throw, always releases; a client whose rollback failed is destroyed, not reused. The active transaction is carried by `AsyncLocalStorage`, so code inside the callback keeps calling `db.prepare(…)` and lands on the transaction's client. Nested calls join the outer transaction. A query that fires after its transaction ended (a missing `await`) is refused.
* `withRetry(fn)`: bounded (4 attempts, 25/50/100 ms) and only for `40001`, `40P01`, `55P03`. It must wrap a WHOLE unit of work, never a fragment (rule 5 of `DB_EXECUTION_POLICY.md` is unchanged).
* Isolation: PostgreSQL default READ COMMITTED + constraints/row locks where needed. SERIALIZABLE is not used globally. (Race-specific locking: CP5.)
* While a transaction holds a client it also owns that client's connection errors (pg-pool only guards idle clients): a connection that dies mid-transaction rejects the statement, rolls back, is destroyed — and cannot crash the process (CP6).
* Errors carry `code`, `constraint`, `table` and a truncated statement — never parameters, credentials or connection strings.

## Pool
| Variable | Default | Note |
|---|--:|---|
| `PGPOOL_MAX` | 10 | per process. Σ(all processes) must stay well under server `max_connections`; size from the server, not the laptop |
| `PGPOOL_IDLE_TIMEOUT_MS` | 30000 | |
| `PGPOOL_CONNECTION_TIMEOUT_MS` | 5000 | fail instead of queueing forever when the pool is exhausted |
| `KAHE_DB_LOCK_TIMEOUT_MS` | 5000 | successor of SQLite `busy_timeout` |
| `KAHE_DB_STATEMENT_TIMEOUT_MS` | 0 (off) | recommend 30000 in production |
Session settings (`timezone=UTC`, `lock_timeout`, `statement_timeout`) are sent in the connection start-up packet.

## Time
* Session time zone is always UTC. `TIMESTAMPTZ` values render as `YYYY-MM-DD HH:MM:SS` (UTC), `DATE` as `YYYY-MM-DD` — exactly the strings A3 stored.
* `kahe_now()` = `date_trunc('second', clock_timestamp())`: statement-time, whole seconds — the semantics of SQLite `datetime('now')`.
* The business time zone (Asia/Jakarta) is application logic in `lib/businessTime.js`; `work_date` is a `DATE` and cannot be shifted by any session setting.

## Migrations — `database/pg/migrate.js`
`npm run db:migrate` · `npm run db:status`. Ordered `NNNN_name.sql`; one transaction per file with its ledger row (`schema_migrations`: version, name, checksum, applied_at, applied_by, execution_ms); advisory lock against concurrent deployers; applied files are checksum-pinned; unknown/out-of-order versions abort. The server only **verifies** the schema at start-up (`assertSchemaCurrent`) and never alters it. Migrations create structure only — seeds are explicit (`npm run seed`).

## Roles
Owner role migrates; runtime role has DML only (see the migration record). Production additions: TLS (`DATABASE_SSL=true`), credentials from the environment / a secret manager, network restriction to the app host, a separate read-only backup role.

## Collation
Databases are created `ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'` so text ordering equals SQLite's BINARY collation (the ordering all 738 baseline tests were verified under). The migrator refuses other collations unless `KAHE_DB_ALLOW_NON_C_COLLATION=true`.

## Write concurrency (CP5)
A3 executed every request synchronously, so writes were implicitly serialised and much code relies on "check in JavaScript, then UPDATE by id". `middleware/writeSerializer.js` keeps that guarantee on PostgreSQL: mutating `/api` requests (except `/api/auth`) run one at a time in arrival order; reads run concurrently on the pool. It is per process — before any multi-process deployment the remaining unguarded transitions (31 in frozen payroll files) need statement-level guards. Correction transitions and OT decisions already carry them. `KAHE_WRITE_SERIALIZATION=off` is for benchmarks only.

## Diagnostics
`KAHE_DB_QUERY_STATS=1` enables per-request SQL statistics (`X-DB-Stats` header, `runWithQueryStats`, `tools/scale/stats-preload.js`). Off by default; no parameters are retained except for the single slowest statement of a scope.

## Indexes, partitioning (CP5)
The 125 A3 indexes are unchanged and validated against the 6,000-worker / 4.6 M-row profile; one index was added on evidence (`0005`: `attendance_events (employee_id, id)`). No exact duplicates. No partitioning: not needed at 1.6 M attendance / 2.2 M audit rows. PgBouncer notes: `docs/DB_M1_PERFORMANCE_REPORT.md` §9.

## Backup, restore, recovery (CP6)
Logical backups with `pg_dump -Fc`; restore with `pg_restore --single-transaction --exit-on-error` into a NEW database created `TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`; both as the owner role, no superuser. `npm run db:verify-backup` proves a restore identical (structure, triggers enabled, sequences, privileges, every row) and re-checks the runtime-role protections. Procedure and measurements: runbook.

## PostgreSQL-native tables (A4 CP1, migration 0006)
`attendance_periods`, `attendance_period_events`, `attendance_closing_policies`, `attendance_closing_policy_rules`,
`attendance_closing_policy_events` have no A3 SQLite source. They are listed in the explicit allowlist
`PG_NATIVE_TABLES` (`database/pg/migrate-from-sqlite.js`), used only to keep them out of the A3 migration catalogue;
every A3 table stays mandatory and fully reconciled, and a SQLite source table without a PostgreSQL destination is
still reported. `tests/dbm1-foundation.test.js` keeps exact equality, extended by literal A4 allowlists
(5 tables, 5 FKs, 22 row triggers).
* **Refusal format** — triggers raise SQLSTATE `KH001`, MESSAGE = machine code, DETAIL = JSON.
* **Action context** — `set_config('kahe.actor_user_id' | 'kahe.actor_name' | 'kahe.actor_role' | 'kahe.permission' |
  'kahe.reason', v, true)`: transaction-local, gone at COMMIT/ROLLBACK; the triggers validate it against
  `users`/`role_permissions` and write every actor column themselves.
* **Per-entity serialization** — `SELECT … FROM legal_entities … FOR NO KEY UPDATE` (does not block FK `KEY SHARE`
  inserts); non-READ COMMITTED transactions are refused. No `btree_gist`, no advisory-lock hashing.
* **Append-only** — period/policy events: INSERT only from audit triggers, UPDATE/DELETE refused, TRUNCATE refused
  even for the owner. Periods and policies are never deleted.
* Flags are `BIGINT` 0/1 (the DB layer rejects boolean parameters). Rollback script:
  `docs/A4_ATTENDANCE_PERIOD_CONTROL.md` §9.

## A4 CP2 (migration 0007)
`attendance_readiness_evaluations` is PostgreSQL-native and listed in the separate exact allowlist `PG_NATIVE_TABLES_CP2`
(`PG_NATIVE_TABLES` stays the 5 CP1 tables). Append-only (UPDATE/DELETE refused, TRUNCATE refused even for the owner).
The insert guard verifies actor (`attendance_readiness:APPROVE`), period in REVIEW, entity, policy entity/version/as-of and
coverage, and writes actor, time and `txid_current()`. The replaced CP1 period guard accepts REVIEW → READY_TO_CLOSE only
with an evaluation bound to the same transaction. Readiness runs in `REPEATABLE READ` (read-only for previews); CP1's
per-entity lock (READ COMMITTED only) is not involved in these transitions. `dbm1-foundation` extends its literal lists
(+1 table, +2 FKs, +3 triggers).

## Data flow summary
```
browser ─HTTP─▶ Express (session in PostgreSQL · RBAC · entity scope)
                 ├─ reads  ───────────────▶ pg.Pool ──▶ PostgreSQL
                 └─ writes ─▶ write queue ─▶ withTransaction (1 client, BEGIN…COMMIT, bounded retry on 40001/40P01/55P03)
PostgreSQL: integrity triggers (append-only audit, frozen attendance, finalized payroll, version immutability) · FK/CHECK/partial-unique · owner vs runtime role
one-off:    A3 SQLite file ─(read-only)▶ migrate-from-sqlite: preflight ▶ load ▶ reconcile ▶ COMMIT + ledger
```
