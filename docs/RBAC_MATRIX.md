# RBAC Matrix

RBAC is enforced **server-side** (`middleware/permissions.js`). Hiding a sidebar
item is UX only and is never treated as authorization. Unauthorized protected
actions/endpoints return `403 Forbidden`. Unauthenticated protected page/API
access returns a redirect to `/login.html` (pages) or `401` (API).

## Modules (permission codes)
home, command_center, intelligence_planning, talent_readiness,
workforce_operations, performance_employment, payroll_bpjs, hrd_kontrak,
timesheet_absensi, attendance_config, attendance_correction, attendance_void,
attendance_late_correction, attendance_exception, attendance_payroll_impact,
attendance_audit, attendance_sensitive_override, attendance_period, attendance_closing_policy, attendance_readiness, payroll_config, worker_services, occupational_health, hse_compliance,
equipment_resource, contractor_control, customer_control, commercial,
reports_analytics, documents, demobilization, settings, users, roles, audit

## Actions
VIEW, CREATE, EDIT, APPROVE, REJECT, EXPORT, ADMIN

## Roles → module access (Phase 1 seed)

### Operations Director (`operations_director`)
Full access, all modules, all actions — except the override modules and the two pinned A4 modules
(see *Attendance A4 CP1 — pinned grants*). Project scope: `ALL_PROJECTS`.

### Workforce Manager (`workforce_manager`)
Operational workforce access; **no** Payroll & BPJS, Commercial, Settings,
Users, Roles, or Audit.
- VIEW: home, command_center, intelligence_planning, occupational_health, hse_compliance
- VIEW/CREATE/EDIT/APPROVE/REJECT/EXPORT: workforce_operations, hrd_kontrak, timesheet_absensi
- VIEW: payroll_config (read-only — payroll rules aren't Workforce Manager's domain)
- VIEW/CREATE/EDIT/EXPORT: talent_readiness, worker_services, equipment_resource
- VIEW/EDIT/EXPORT: performance_employment, contractor_control
- VIEW/EXPORT: intelligence_planning, customer_control, reports_analytics
- VIEW/CREATE/EXPORT: documents
- VIEW/CREATE/EDIT: demobilization

Project scope: `PPB_BALONGAN`.

### HRD Officer (`hrd_officer`)
Employee database & contract administration; **no** contract approve/reject —
extending or terminating a contract goes to Workforce Manager / Operations
Director for decision (see routes/hrd.js `contract-action` → `decide` flow).
- VIEW: home, talent_readiness, worker_services
- VIEW/CREATE/EDIT/EXPORT: hrd_kontrak
- VIEW: timesheet_absensi
- VIEW: payroll_config (read-only)
- VIEW/CREATE/EXPORT: documents

Project scope: `PPB_BALONGAN`.

### Payroll Officer (`payroll_officer`)
- VIEW: home, workforce_operations (read-only)
- Full (VIEW/CREATE/EDIT/APPROVE/REJECT/EXPORT): payroll_bpjs
- VIEW: hrd_kontrak (read-only, fields narrowed to payroll-relevant columns
  only — see `FIELD_SCOPE` in routes/hrd.js; NIK, address, and BPJS numbers
  are withheld)
- VIEW: timesheet_absensi (read-only — needs work/overtime hours for
  payroll runs; full record, no field scoping applied)
- VIEW/CREATE/EDIT/EXPORT/ADMIN: payroll_config — owns Legal Entity, JKK,
  BPJS/PPh21/overtime Rule Set, Holiday Calendar, Work Patterns, and
  Employee Payroll Assignment (all 8 domains; ADMIN is required
  specifically to activate a new rule set or reprice a JKK class, since
  those change every employee's payroll at once — see
  `routes/payroll-config/rule-sets.js` and `jkk-risk-classes.js`)
- VIEW/EXPORT: reports_analytics (payroll-relevant reports only, by data scope)
- VIEW/CREATE/EXPORT: documents

Project scope: `PPB_BALONGAN`.

### Occupational Health (`occupational_health`)
- VIEW: home, worker_services (limited), hse_compliance (relevant compliance)
- Full: occupational_health
- VIEW: hrd_kontrak (read-only, fields narrowed to identity + BPJS Kesehatan
  only — see `FIELD_SCOPE` in routes/hrd.js)
- VIEW/EXPORT: reports_analytics
- VIEW/CREATE/EXPORT: documents

Project scope: `PPB_BALONGAN`.

### HSE Officer (`hse_officer`)
- VIEW: home, worker_services (limited), occupational_health (limited)
- Full: hse_compliance
- VIEW: hrd_kontrak (read-only, fields narrowed to identity + position only —
  see `FIELD_SCOPE` in routes/hrd.js)
- VIEW/EXPORT: reports_analytics
- VIEW/CREATE/EXPORT: documents

Project scope: `PPB_BALONGAN`.

## Attendance A4 CP1 — pinned grants
Unlike every other module, the two A4 modules are **pinned** for all roles, including Operations Director (never the
ALL_ACTIONS default). No EXPORT, APPROVE or REJECT exists yet (EXPORT arrives in CP6). Supervisor, Occupational Health
and HSE Officer have no access. Every read/write is additionally limited to the user's Legal Entity scope
(cross-entity → 404).

| Role | `attendance_period` | `attendance_closing_policy` |
|---|---|---|
| Operations Director | VIEW, CREATE, EDIT | VIEW, CREATE, EDIT, ADMIN |
| Workforce Manager | VIEW, CREATE, EDIT | VIEW |
| HRD Officer | VIEW | VIEW |
| Payroll Officer | VIEW | VIEW |
| Supervisor · Occupational Health · HSE Officer | — | — |

Actions: period CREATE = create; EDIT = OPEN ⇄ REVIEW and OPEN details. Policy CREATE = new DRAFT; EDIT = DRAFT header,
rules, discard; ADMIN = activate, end. `GET /api/attendance-periods/:id/payroll-periods` also requires `payroll_run:VIEW`.
A4 denials answer `{error: 'FORBIDDEN', detail: {module, action}}` (language-neutral).

## Attendance A4 CP2 — `attendance_readiness` (pinned)
| Role | VIEW | APPROVE |
|---|---|---|
| Operations Director | ✓ | ✓ |
| Workforce Manager | ✓ | ✓ |
| HRD Officer | ✓ | — |
| Payroll Officer | ✓ | — |
| Supervisor · Occupational Health · HSE Officer | — | — |

VIEW = readiness summary and issue detail (`attendance_period:VIEW` alone reveals no readiness codes or counts; readiness
detail exposes employee-day references, so grant it only with attendance read access). APPROVE = REVIEW → READY_TO_CLOSE
and READY_TO_CLOSE → REVIEW withdrawal. No Payroll permission changes.

## Demo accounts (password for all: `Kahe360Demo!2026`)
| Email | Display Name | Role |
|---|---|---|
| director@kahe360.local | Andi Dharma | operations_director |
| workforce@kahe360.local | Demo Workforce Manager | workforce_manager |
| hrd@kahe360.local | Demo HRD Officer | hrd_officer |
| payroll@kahe360.local | Demo Payroll Officer | payroll_officer |
| health@kahe360.local | Demo Occupational Health | occupational_health |
| hse@kahe360.local | Demo HSE Officer | hse_officer |

**DEMO CREDENTIALS ONLY. REMOVE BEFORE PRODUCTION.**

## Where enforcement lives
- `middleware/auth.js` — session presence (`requireAuth` for pages, `requireApiAuth` for APIs)
- `middleware/permissions.js` — `requirePermission(moduleCode, action)` loads the
  user's roles/permissions/scope fresh from SQLite on every call and returns
  `403` if the action isn't granted
- `routes/user.js` — worked examples: `/api/user/payroll-summary` (needs
  `payroll_bpjs:VIEW`), `/api/user/admin/users` (needs `users:ADMIN`)
- `routes/hrd.js` — worked example of per-role field scoping: three roles
  hold `hrd_kontrak:VIEW` but only see a narrowed field set (`FIELD_SCOPE`),
  while `workforce_manager`/`hrd_officer`/`operations_director` see the full
  employee record; contract extend/terminate is a two-step
  `EDIT` (request) → `APPROVE` (decide) flow, not a single action
- `routes/work-schedule.js` — Attendance A2 configuration (shifts, work
  patterns, roster dates, date overrides, employee schedule assignment) under
  the SEPARATE `attendance_config` module: recording attendance and changing
  everyone's working rhythm are different rights. Workforce Manager holds
  VIEW/CREATE/EDIT/EXPORT, HRD Officer and Payroll Officer VIEW only,
  Operations Director everything (blanket grant). Legal-entity scope applies to
  every read and write; global (entity-less) configuration rows are readable by
  all but writable only with an entity in scope.
- `routes/attendance-correction.js` — Attendance A3. Seven modules so that
  recording attendance, approving a correction, approving a LATE correction,
  resolving exceptions, approving the payroll consequence and reading the audit
  trail are separate rights. Defaults: Supervisor (new role) requests only;
  Workforce Manager reviews/approves/voids and approves late corrections;
  HRD Officer approves corrections but may only request a void; Payroll Officer
  owns `attendance_payroll_impact` and holds no attendance write right;
  Operations Director holds the modules but is NOT exempt from SoD.
  `attendance_sensitive_override` is granted to no role, Director included.
  Requester ≠ approver is checked on stable user ID and cannot be overridden.
  Audit VIEW never implies APPROVE: an actor without approval authority sees
  only their own activity.
- `routes/timesheet.js` — overtime request/approval follows the same
  two-step pattern as HRD & Kontrak's contract actions, inline on the same
  `timesheet_entries` row. Since Attendance A1 (2026-09-20):
  - approve requires `timesheet_absensi:APPROVE`, reject requires
    `timesheet_absensi:REJECT` (previously both used APPROVE; no role's grant
    changed — the roles holding one hold both);
  - **SoD:** the requester can never approve or reject their own request
    (`403 SOD_VIOLATION`), compared by immutable user id, never display name;
    no override exists for attendance;
  - decisions are terminal (no approved↔rejected flip, no re-request after a
    decision); history is kept in the append-only `attendance_events` table;
  - every read and write is legal-entity scoped via `lib/entityScope.js`
    (Phase 2I); a foreign or absent entry both answer `404`.
  See docs/ATTENDANCE_ARCHITECTURE.md.
- `routes/payroll-config/*` — 8 separate router files (one per domain,
  see docs/MASTER_SPEC.md), all sharing one permission module (`payroll_config`)
  but each with its own table and its own write logic. Every create/update/
  delete calls `lib/configAudit.js` to log a before/after snapshot to
  `config_audit_log` — this is the pattern to copy for any future config
  domain, rather than adding a bespoke audit table per domain.
- `public/app.js` — `renderSidebar()` only *hides/disables* menu items; it is
  not a security boundary

## Talent & Worker V1 — CP1 grants (isolated, 2026-09-22)
Talent permissions live in `talent.permission` / `talent.role_permission`, written only by `database/seed-talent.js`.
They are NOT in `database/seed.js`, so no role inherits them (the Operations Director's ALL_ACTIONS does not apply)
and re-running `npm run seed` never wipes them. Existing role records only; no new role in CP1.

| Role (existing code) | Talent grants |
|---|---|
| Workforce Manager (`workforce_manager`) | `tw_home` VIEW · `tw_registration` VIEW, CREATE, EDIT · `tw_talent_pool` VIEW, CREATE, EDIT · `tw_deployment` VIEW, CREATE, EDIT · `tw_contract_placement` VIEW, CREATE, EDIT · `tw_worker_passport` VIEW · `tw_reports` VIEW |
| HRD Officer (`hrd_officer`) | `tw_home` VIEW · `tw_registration` VIEW · `tw_verification` VIEW, EDIT, APPROVE, REJECT · `tw_talent_pool` VIEW · `tw_worker_passport` VIEW |
| Operations Director (`operations_director`) | VIEW only: `tw_home`, `tw_talent_pool`, `tw_deployment`, `tw_contract_placement`, `tw_worker_passport`, `tw_reports` |
| `payroll_officer`, `occupational_health`, `hse_officer`, `supervisor` | none |

Granted to nobody in CP1: `tw_passport_print`, `tw_passport_pdf`, `tw_document_download` (EXPORT-only, enforced by a
database trigger) and `tw_security_admin`. Field-level security, data scope and the Talent audit log:
`docs/TALENT_WORKER_V1_ARCHITECTURE.md` §5–§8. Enforcement: `modules/talent/lib/talentAuth.js` (server-side; the
Talent sidebar only disables items).

### Talent Emergency Registration V0 (2026-09-22, awaiting acceptance)
New Talent permission `tw_emergency_intake` (allowed actions VIEW, EXPORT): Workforce Manager VIEW + EXPORT, HRD Officer
VIEW + EXPORT; nobody else (Operations Director included). Requires Talent data scope ALL. CSV export is audited
(`EXPORT_CSV`). The public registration (`/register/*`, `/api/public/tw/register/*`) needs no login and grants no access
to any stored data.
