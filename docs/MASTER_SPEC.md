# KAHE 360° Internal Operations Portal — Master Spec

> **DB-M1 (2026-09) — approved architecture change:** persistence moved from SQLite (`node:sqlite`) to **PostgreSQL** (driver `pg`, canonical
> layer `database/db.js`, versioned migrations `database/pg/`, sessions in PostgreSQL via `middleware/pgSessionStore.js`). Frontend, Express,
> bcrypt, server-side sessions, RBAC and all UI locks are unchanged. Statements below about SQLite describe the build history.
> Source of truth for the database: `docs/DATABASE_ARCHITECTURE.md` · `docs/DB_M1_FINAL_REPORT.md`.

Status: **Phase 1 complete** (Login, Auth, RBAC, SQLite, Home, Local/LAN test mode).
Do not build Command Center or other detail modules without explicit approval.

## What this is
Internal operational execution system for KAHE 360° Workforce Solutions, separate
from the Wuhuan customer-facing portal. Architecture supports a future shared data
core with different access/visibility for internal KAHE users vs. customer users.

## Tech stack (locked — no framework changes without approval)
- Frontend: HTML5, CSS3, vanilla JavaScript (no React/Next/Vue/Tailwind)
- Backend: Node.js, Express
- Auth DB: SQLite via Node's **built-in** `node:sqlite` module (`DatabaseSync`)
  — no native addon, no node-gyp/compiler required on Windows/Node 24.
  Sessions stored in the same SQLite file via a small custom store
  (`middleware/sqliteSessionStore.js`). (Swapped in from `better-sqlite3` on
  2026-09-12 to remove the project's last native dependency.)
- Auth: bcrypt-compatible password hashes via `bcryptjs` (pure JS, no native
  compile step — swapped in from `bcrypt` on 2026-09-12 after native-module
  install failures on Windows/Node 24), express-session (server-side
  authority), helmet, express-rate-limit on login, express-validator on input
- File uploads (HRD & Kontrak documents): `multer`, files stored in
  `/uploads` (outside `/public`, gitignored), streamed through a
  permission-checked route rather than served as static assets

## Talent & Worker Management V1 (isolated bounded context)
- Standalone context in the same codebase: schema `talent`, own migration stream (`TW0001…`) and ledger
  (`talent.schema_migrations`), own explicit runtime grants, own access audit (`talent.audit_event`), own light
  KAHE GROUP INDONESIA shell. API `/api/tw/*`, pages `/tw/app/*`.
- Reuses the existing login/session and `loadUserContext` only. No reads/writes to Attendance, OT, Payroll, BPJS or
  the operational assignment/contract tables; no FK to `public`.
- CP1 (foundation) implemented 2026-09-22 — awaiting acceptance. Full design: `docs/TALENT_WORKER_V1_ARCHITECTURE.md`.
- Emergency Registration V0 (public P01–P04 + EMERGENCY REGISTRATION INTAKE V0 list/CSV) implemented 2026-09-22 —
  awaiting acceptance. `docs/TALENT_EMERGENCY_REGISTRATION_V0.md`.
- Internet Deployment Hardening for V0 (trusted proxy, secure cookies, readiness endpoint, scoped CSP, runbook)
  implemented 2026-09-22 — awaiting acceptance. `docs/DEPLOYMENT_INTERNET_V0.md`.

## Modules built beyond Phase 1
- **HRD & Kontrak** (2026-09-14) — employee database + contract lifecycle for
  4 worker types (internal, PKWT, harian, subkontraktor/mitra). New SQLite
  tables: `employees`, `employee_contract_history`, `employee_documents`.
  New role: `hrd_officer`. See docs/RBAC_MATRIX.md for permissions.
- **Timesheet & Absensi** (2026-09-14) — daily attendance per employee
  (workfront, shift, clock in/out, work hours, attendance status) with
  inline overtime request + approval on the same record. New SQLite table:
  `timesheet_entries`. Hardened in Attendance A1 (2026-09-20): cutoff and
  frozen-snapshot protection, terminal overtime decisions with requester≠
  approver SoD, eligibility on the work date, legal-entity scope, stable
  user-id identity and the append-only `attendance_events` trail — see
  docs/ATTENDANCE_ARCHITECTURE.md. Extended in Attendance A2 (2026-09-20) with
  a configurable Work Schedule / Shift master, work patterns (fixed weekly,
  custom weekly, rotating cycle, date roster), breaks, date overrides,
  effective-dated employee assignment, cross-midnight handling, an
  Asia/Jakarta timezone authority and derived worked minutes. New page:
  `public/jadwal-kerja.html` (module `attendance_config`). Extended again in
  Attendance A3 (2026-09-20) with correction and void workflows, a configurable
  effective-dated correction policy, an append-only record version chain,
  exception detection, payroll-impact classification with a mandatory Payroll
  Officer gate for finalized payroll, a payroll adjustment QUEUE interface (time
  only), and an immutable Audit & Activity Center with role snapshots. New page:
  `public/koreksi-absensi.html` (module `attendance_correction`). Deliberately does NOT yet feed the "Workforce Flow",
  "Gap Operasional", or "7 Hari ke Depan" panels on Operasi Tenaga Kerja —
  those need a separate Rencana Penugasan (manpower planning) module for the
  "planned" side of planned-vs-actual, which is not built yet (see below).
- **Payroll Configuration** (2026-09-14) — foundational, non-hardcoded rule
  engine for the future Payroll Calculation Engine. 8 modular domains, each
  its own table/route file: Legal Entity Master (`legal_entities`), JKK Risk
  Class rates (`jkk_risk_classes`, versioned), Payroll Rule Set
  (`payroll_rule_sets` + `ptkp_ter_rates` + `overtime_multiplier_rules`,
  versioned/activatable), Holiday Calendar (`holidays`), Work Patterns
  (`work_patterns`, 5-day/6-day week), and Employee Payroll Assignment
  (`employee_payroll_assignments`, links an HRD & Kontrak employee to a
  legal entity + work pattern + PTKP status). Every write goes through the
  shared `config_audit_log` table (see `lib/configAudit.js`). Default data
  seeded from PMK 168/2023 (PPh21 TER, categories A/B/C, 122 brackets), PP
  35/2021 Pasal 31 (overtime multipliers), 2026 BPJS Kesehatan/Ketenagakerjaan
  rates, and the 2026 SKB 3 Menteri holiday calendar (25 dates) — see
  `database/seed.js` for exact figures and inline source citations. This
  module does NOT calculate any payslip yet — it only holds the rules the
  future Payroll Calculation Engine will read.

## Phase 1 scope
- LOGIN page (public/login.html, login.css, login.js)
- HOME dashboard (public/index.html, styles.css, app.js) — protected route
- Auth API: POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me,
  GET /api/auth/permissions
- SQLite schema: users, roles, permissions, role_permissions, user_roles,
  projects, user_project_scope, audit_auth_events
- RBAC enforced server-side (see docs/RBAC_MATRIX.md) — hiding a sidebar item is
  UX only; the backend independently checks every protected route/endpoint
- Local/LAN test mode: START_KAHE360.bat / STOP_KAHE360.bat / OPEN_KAHE360.bat,
  server listens on 0.0.0.0, LAN IP auto-detected and printed at boot

## Seeded demo project
- Code: `PPB_BALONGAN` — PPB Balongan, Indramayu, Jawa Barat — status ACTIVE

## Seeded demo users
See docs/RBAC_MATRIX.md for role-to-module mapping. All demo users share the
password `Kahe360Demo!2026` (bcrypt-hashed in the DB). **Demo credentials only —
remove before production.**

## Design authority (locked assets)
See docs/UI_LOCKS.md.

## What's explicitly NOT built yet
- Command Center and all other sidebar modules beyond Home, HRD & Kontrak,
  and Timesheet & Absensi (they render a "Module sedang dikembangkan." toast
  if the user has permission, or are disabled in the sidebar if they don't)
- Rencana Penugasan (manpower planning) — the "planned" counterpart to
  Timesheet & Absensi's "actual" data; needed before Operasi Tenaga Kerja's
  Workforce Flow / Gap Operasional / 7 Hari ke Depan panels can go live
- Payroll Calculation Engine — the actual payslip generator. Payroll
  Configuration (legal entities, BPJS/PPh21/overtime rules, holiday
  calendar, work patterns, employee assignments) is built and seeded, but
  nothing yet reads it to produce a payroll run or payslip
- The Payroll Configuration UI covers create/view for all 8 domains but not
  full edit/deactivate flows (e.g. rule set activation is done via API,
  not yet a button in the Rule Set tab) — deliberately deferred to keep
  this increment shippable
- Real Google OAuth (login button is a wired placeholder — shows a toast)
- Full operational audit trail (only LOGIN_SUCCESS / LOGIN_FAILED / LOGOUT are
  logged today; architecture reserves CREATE/EDIT/APPROVE/REJECT/EXPORT/DELETE)
- Public/cloud deployment (local/LAN only by design in this phase)

## Next module (awaiting approval)
Command Center — not started.
