# SQLite → PostgreSQL data migration — runbook (DB-M1)

One-way. The SQLite file is only ever READ. There is no dual-write, no merge mode and no sync back.

## 0. Before you start
1. **Stop the old application** so the SQLite file no longer changes. Copy `kahe360.db` (with `-wal`/`-shm` if present) to a safe place — that copy plus `KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3.zip` is the rollback.
2. The file must be at the **A3 shape**. An older file is upgraded first, with the A3 package and `database/legacy-sqlite/migrate-*.js` (SQLite-side tools).
3. Create a **fresh** PostgreSQL database and apply the schema: `npm run db:bootstrap` (dev) or your DBA's provisioning (UTF8, `LC_COLLATE 'C'`, owner role + runtime role), then `npm run db:migrate`.

## 1. Preflight — reads the source, writes nothing
```
DATABASE_MIGRATION_URL=postgresql://<owner>@<host>/<db>  npm run db:migrate-from-sqlite -- --source /path/kahe360.db --preflight --report preflight.json
```
Reports, with table · row identity · column · reason: malformed dates (`YYYY-MM-DD`, real calendar date), malformed timestamps (UTC `YYYY-MM-DD HH:MM:SS`), text/fraction/BLOB in integer columns, integers beyond the safe range, NULL in NOT NULL columns, orphan foreign keys, duplicates against every unique and PARTIAL unique index, tables/columns the destination does not have, broken version chains, audit/actor references to missing rows, payslip/run-line/snapshot mismatches, ids that cannot be preserved.
**Any finding BLOCKS the migration. Nothing is normalised, skipped or renumbered.** Correct the data at the source, through the old application, and run preflight again. If a row is genuinely unrecoverable, that is a business decision to record — not something the tool decides.

## 2. Dry run — full trial load, rolled back
`… --source /path/kahe360.db --dry-run` loads everything inside one transaction, reconciles it, and ROLLS BACK. It proves PostgreSQL accepts every row (CHECK constraints included) and leaves the destination untouched.

## 3. Migrate
`… --source /path/kahe360.db --report migration.json`
* order: topological, from the real foreign keys of the destination schema;
* one transaction, a savepoint per table; any error → **everything rolled back**, the message names the table and constraint, the destination is still fresh, and you simply rerun after fixing the cause;
* integrity triggers are disabled only inside that transaction (history must load as it is — e.g. attendance already covered by a frozen snapshot) and re-enabled before COMMIT; FK, CHECK, NOT NULL and unique constraints stay on;
* historical primary keys are inserted unchanged; each identity sequence is set to `GREATEST(max(id), sqlite_sequence)` so a new row can neither collide with nor reuse a historical id (future gaps are normal and harmless);
* reconciliation runs **before** COMMIT: row count per table (difference must be 0), sha256 of the canonical content of **every** table (not only the critical ones), 18 history invariants evaluated with the same SQL on both engines, orphan scan, all constraints validated, all triggers enabled. A mismatch rolls back;
* on success a `data_migrations` row records the source file name, its sha256, row/table counts and the content checksum. A second run is refused ("destination is not fresh").
`sessions` is not migrated: users sign in again.

## 4. Verify and cut over
```
DATABASE_URL=postgresql://<runtime role>@<host>/<db>  npm run db:smoke-migrated     # read workflows through the real server + RBAC
npm run seed        # ONLY if you want the demo fixtures; never required for migrated production data
```
Point `.env` `DATABASE_URL` at the new database and start the application. Keep the SQLite copy read-only as history.

## 5. If anything fails
PostgreSQL is not authoritative until step 3 reports `MIGRATED` and step 4 is green. Until then: drop the PostgreSQL database, keep running A3 on SQLite. The tool never modified the SQLite file (its sha256 is checked before and after and printed as `source untouched: true`).

## Backup / restore of the PostgreSQL database (verified in CP6)
**Backup** (any role that can read everything — the schema owner, or a dedicated read-only backup role):
```
pg_dump --format=custom --file kahe360_$(date +%F).dump  "postgresql://<owner>@<host>/<db>"
```
Custom format (`-Fc`) is compressed, carries schema + data + privileges, and lets `pg_restore` run in one transaction. Keep the dump's sha256 next to it. Schedule it (Windows Task Scheduler / cron), keep ≥ 7 daily + 4 weekly copies OFF the database host, and copy `uploads/` with it (documents live on disk).
**Restore — always into a NEW, empty database; never over the live one:**
```
createdb -T template0 -E UTF8 --lc-collate=C --lc-ctype=C -O <owner> kahe360_restored
pg_restore --single-transaction --exit-on-error --dbname "postgresql://<owner>@<host>/kahe360_restored"  kahe360_YYYY-MM-DD.dump
```
`--single-transaction --exit-on-error`: a restore either completes or leaves nothing. No superuser is needed: the owner role restores its own objects and the runtime role's grants (both roles must already exist on the server — `npm run db:bootstrap` or the DBA creates them).
**Prove the restore before trusting it** — one command does backup → fresh database → restore → full comparison:
```
SOURCE_URL=<owner url of the live db>  RESTORE_ADMIN_URL=<role with CREATEDB>  RUNTIME_PASSWORD=<runtime role password> \
  npm run db:verify-backup -- kahe360_restore_check --report restore.json          # add --keep to keep the restored database
```
It compares columns, constraints, every index and trigger definition (and that triggers are ENABLED), functions, sequence positions, runtime-role privileges, encoding/collation, the migration ledgers, and a chunked sha256 of every column of every row of every table; then, as the RUNTIME role on the restored database, it checks audit immutability, version-history protection, finalized-payroll protection, that TRUNCATE/DDL/ledger writes are refused, and that a new record gets an id above all restored ids. Exit code 0 = identical.
Measured: 8,094 rows — dump 0.2 s / restore 0.3 s · 49,223 rows — 1.4 s / 0.8 s · 4,731,892 rows (6,000 workers, 12 months, 1.3 GB) — dump 22 s (66 MB) / restore 36 s / verification 101 s. All three: identical. Evidence: `docs/backup-restore-evidence/`.
**To switch to a restored database:** stop the application, point `DATABASE_URL` / `DATABASE_MIGRATION_URL` at it, `npm run db:status` (must show every migration applied), start. `pg_dump` is a logical backup (restore point = time of the dump). Point-in-time recovery (WAL archiving / `pg_basebackup`) is a server-level option for production and is not configured by this project.

## Failure behaviour you can rely on (tested in `tests/dbm1-cp6.test.js`)
* A failure in the middle of a multi-step operation (attendance create, OT decision, correction approve → version → apply → audit) leaves NOTHING behind; the same request succeeds when repeated.
* A database connection that dies mid-transaction rolls back, is never reused, and does not crash the server; killing every server connection does not require a restart.
* A lost connection is not retried automatically (the outcome of the unit of work is unknown — the user sees an error and repeats the action; duplicate guards make the repeat safe). Only lock/serialisation conflicts are retried, at most 4 times.
* The server will not start without PostgreSQL, against an unmigrated schema, or against a schema older than the code. There is no SQLite fallback.
