# KAHE360_INTERNAL_DEVELOPMENT

Active development of the KAHE 360 portal continues here.

## The one rule
The payroll and payroll-billing subsystem is frozen as
`PAYROLL_CORE_STABLE_V1`. Everything else is open.

Before and after any change that touches employee assignment, attendance,
overtime, worker services, payroll input or legal entity:
```
npm run check:payroll-freeze       # has a frozen file drifted?
npm run test:payroll-regression    # must stay at 545, zero failures
npm run test:attendance            # attendance API suite (real server), zero failures
```

Attendance data backfills / opt-in example seeds (the schema itself comes from
`npm run db:migrate`; the server never alters it):
```
npm run migrate:attendance-a1     # A1: identity, audit, entity snapshot
npm run migrate:attendance-a2     # A2: schedule/shift/pattern tables (report only)
npm run migrate:attendance-a3     # A3: correction/void/exception/audit tables (report only)
```
`migrate:attendance-a3 --seed-policy <LEGAL_ENTITY_ID> [window_days]` optionally
creates ONE example correction policy so the workflow is usable immediately; no
correction window is invented otherwise.

`migrate:attendance-a2 --seed-examples <LEGAL_ENTITY_ID>` optionally creates
EXAMPLE shifts (OFFICE / SITE-DAY / SITE-NIGHT) to start from; it assigns
nobody and invents no pattern.

Attendance rules and the schedule architecture lock: `docs/ATTENDANCE_ARCHITECTURE.md`.

If payroll tests fail because of a portal change: **stop and report it.**
Do not modify payroll or its tests to make the failure go away.

If a module genuinely needs a payroll change: report the dependency, explain
why the existing interface is insufficient, and wait for approval.

Full contract: `docs/PAYROLL_CORE_FREEZE.md`.

## Database — PostgreSQL (DB-M1 complete)
PostgreSQL 13+ (verified on 16.15) is the ONLY runtime database. SQLite survives
solely in `database/legacy-sqlite/` as schema reference and migration source.
```
cp .env.example .env              # fill in the placeholders
npm run db:bootstrap              # dev only: two roles + database (UTF8, LC_COLLATE 'C')
npm run db:migrate                # versioned schema, owner role   (npm run db:status to inspect)
npm run seed                      # explicit demo fixtures, idempotent, runtime role
npm start
```
Tests need a real server too: set `TEST_DATABASE_ADMIN_URL` (in `.env` or the
environment). Each suite creates and drops its own `kahe360_test_*` database and
runs as the least-privilege runtime role; nothing ever touches `DATABASE_URL`.
```
npm run test:dbm1                 # foundation 45 · data migration 32 · CP5 scale/concurrency 16 · CP6 failure injection 15
npm run test:everything           # freeze + pure + all of the above + attendance + payroll (≈ 17 min)
npm run db:verify-backup -- <new_db_name>   # pg_dump → fresh db → pg_restore → prove identical (see runbook)
npm run test:attendance           # A1 55 · A2 83 · A3 55, real server
npm run test:payroll-regression   # 545 — slow on PostgreSQL (≈ 13 min), see CP5
npm run check:payroll-pure        # the 4 formula files must equal the V1 SQLite lock
```
Moving an existing SQLite database: `docs/POSTGRES_MIGRATION_RUNBOOK.md`
(`npm run db:migrate-from-sqlite -- --source file.db --preflight | --dry-run`).

The payroll freeze is `PAYROLL_CORE_STABLE_V1_POSTGRES`, recorded only after the Golden
Payroll Parity Harness (`tools/parity/run-golden.sh`) showed zero business-output difference
against A3; the original SQLite freeze is preserved in `docs/freeze-history/`. Status, per-file reasons and every
behaviour difference: `docs/DB_M1_POSTGRES_MIGRATION.md`.

## Open for development
Beranda/Home · Pusat Kendali · Intelijen & Perencanaan · Talenta & Kesiapan ·
Operasi Tenaga Kerja · Kinerja & Ketenagakerjaan · HRD & Kontrak ·
Timesheet & Absensi · Layanan Pekerja · Kesehatan Kerja · HSE & Kepatuhan ·
Peralatan & Resource · Kendali Kontraktor · Kendali Pelanggan · Komersial ·
Dokumen · Demobilisasi · Pengaturan · dashboards · analytics · alerts ·
predictive intelligence · workforce planning · UI/UX — and the operational UI
for the payroll backend, built against the frozen APIs.

## Deferred — do not start without explicit request
Invoice Generation · Billing Approval/Freeze · Accounts Receivable ·
Tax Invoice · further payroll/billing phases.

## Attendance A4 — Attendance Period Control (CP1)
* Apply the schema: `npm run db:migrate` (adds `0006_attendance_period_foundation`); check with `npm run db:status`.
* Re-run the seed after migrating to add the `attendance_period` / `attendance_closing_policy` permissions:
  `npm run seed`.
* Tests: `npm run test:attendance-a4` (71 checks; real server over HTTP, write serializer OFF).
  `npm run test:attendance` remains the historical A1–A3 suite (193). `npm run test:everything` runs both.
* The CP1 API returns machine codes only (`{error, detail}`); UI text comes later (CP6) via the existing ID | EN files.
* Rollback: see `docs/A4_ATTENDANCE_PERIOD_CONTROL.md` §9 (owner-role reverse script).

## Attendance A4 — CP2 readiness
* `npm run db:migrate` applies `0007_attendance_readiness`; re-run `npm run seed` to add the `attendance_readiness` permission.
* `npm run test:attendance-a4-cp2` — CP2 suite incl. batch-attribution equivalence and the 1,500 / 6,000-worker performance
  gates (`A4_CP2_SKIP_PERF=1` skips the performance profiles during development only).
* Rollback: `docs/A4_ATTENDANCE_PERIOD_CONTROL.md` §20 (refuses while any period is READY_TO_CLOSE).

## Talent & Worker V1 — CP1 (isolated bounded context)
* After the core steps (`npm run db:migrate && npm run seed`): `npm run db:migrate-talent` (Talent stream + explicit
  runtime grants; needs `DATABASE_MIGRATION_URL` and `KAHE_DB_APP_ROLE`), then `npm run seed:talent` (as owner).
  `npm run db:status-talent` shows the Talent ledger. The core runner never touches schema `talent`.
* Pages: `http://<host>:3000/tw/app/` after signing in on the existing login page. API: `/api/tw/*`.
* `npm run test:talent-cp1` — Talent CP1 suite (real server over HTTP). `test:everything` is unchanged; run the
  Talent suite in addition to it.
* Backup proof for schema `talent`: `npm run db:verify-backup-talent -- <new_db>` (see
  `docs/TALENT_WORKER_V1_ARCHITECTURE.md` §10). Rollback: `database/pg/talent/migrations/TW0001_talent_worker_foundation.down.sql`.

## Talent Emergency Registration V0
* `npm run db:migrate-talent` applies `TW0002_emergency_registration_v0`; then `npm run seed:talent` (adds
  `tw_emergency_intake` for Workforce Manager and HRD).
* Public form: `http://<host>:3000/register` (no login). Internal list/CSV: `/tw/emergency-intake`.
* Uploads are stored privately in `uploads/talent-registration/` (override with `KAHE_TW_UPLOAD_DIR`; back this folder
  up together with the database).
* `npm run test:talent-registration-v0` — V0 suite. Details: `docs/TALENT_EMERGENCY_REGISTRATION_V0.md`.

## Internet deployment (Emergency Registration V0 hardening)
* Defaults keep LAN development unchanged: no proxy trusted, plain-HTTP session cookie.
* Production (`NODE_ENV=production`) refuses to start without a real `SESSION_SECRET` and an explicit
  `KAHE_TRUST_PROXY` (`off`, a hop count, or proxy addresses); session cookies are always Secure (HTTPS required).
* Readiness: `GET /api/public/tw/register/health`. Full guide + Nginx/Cloudflare config + backup runbook:
  `docs/DEPLOYMENT_INTERNET_V0.md`. Tests: `npm run test:talent-hardening-v0`.
