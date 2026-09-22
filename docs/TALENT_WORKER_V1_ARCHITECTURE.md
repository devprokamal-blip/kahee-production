# Talent & Worker Management V1 — Architecture (CP1 foundation)

Status: **CP1 implemented — awaiting acceptance (2026-09-22).** CP2 not started.
UI reference: `KAHE_TALENT_WORKER_V1_MOCKUP_MASTER.zip` (P01–P16, manifest-verified). P15 is the master Worker
Passport; P15A is a tab/subview of the same passport, never a second passport.

## 1. Bounded context

Talent & Worker V1 is a standalone, isolated bounded context inside the KAHE 360 codebase.

| Concern | Talent & Worker V1 | Shared with the platform? |
|---|---|---|
| Database objects | schema `talent` only | no |
| Migrations | `database/pg/talent/migrations/TW0001_*.sql`, runner `database/pg/talent/migrate-talent.js` | no — core stream `database/pg/migrations/` and number 0008 untouched |
| Migration ledger | `talent.schema_migrations` | no (`public.schema_migrations` untouched) |
| Runtime grants | explicit manifest in `migrate-talent.js` | no (`database/pg/migrate.js` untouched) |
| Authentication | existing login, `express-session`, `loadUserContext` | **yes, reused** — no second auth system |
| Authorization | `talent.role_permission` for EXISTING role codes | role records only |
| Audit | `talent.audit_event` (access/security events) | `public.config_audit_log` keeps configuration changes |
| Backup verification | `tools/talent/verify-backup-restore.js` | no (`tools/dbm1/verify-backup-restore.js` untouched) |
| API | `/api/tw/*` | — |
| Internal pages | `/tw/app/*` (views in `modules/talent/views`, outside `public/`) | — |
| UI shell | light KAHE GROUP INDONESIA shell (`public/tw-assets/`) | dark KAHE 360 portal unchanged |

Shared authentication does not mean shared operational data. Talent code does not read or write Attendance, OT,
Payroll, BPJS, the operational assignment tables or the operational contract tables, and no Talent table has a
foreign key to a `public` table. A future link to `public.employees` needs a separately approved Identity Bridge
checkpoint.

If schema `talent` is missing or not at the expected version, only `/api/tw/*` and `/tw/app/*` answer 503
`TALENT_SCHEMA_NOT_READY`; the rest of the portal keeps working. The check runs on every Talent request (no cache).

## 2. Identity

`worker_uuid` (UUID, `gen_random_uuid()`) is the canonical internal identity. One worker = one digital identity.
`talent.worker` deliberately has no employer, client, position, project or assignment column
(Person ≠ Employer ≠ Client ≠ Position ≠ Project ≠ Assignment).

Display IDs (`talent.worker_display_id`) are labels, issued at most once per type, immutable, globally unique:

| id_type | Format | Sequence |
|---|---|---|
| REGISTRATION | `KAHE-TAL-YYYY-NNNNNN` (YYYY = issue year in WIB) | `talent.seq_tal` |
| TALENT | `KAHE-T-NNNNNN` | `talent.seq_t` |
| WORKER | `KAHE-W-NNNNNN` | `talent.seq_w` |

Sequences are global (not reset per year), `MAXVALUE 999999 NO CYCLE`; exhaustion is an explicit error.

## 3. Database objects (TW0001)

`worker`, `worker_display_id`, `permission`, `role_permission`, `field_catalog`, `field_policy`, `user_scope`,
`audit_event`, sequences `seq_tal` / `seq_t` / `seq_w`, functions `forbid_change()`,
`jsonb_has_forbidden_content(jsonb)`, `role_permission_action_guard()`. TW0001 inserts no rows.
Immutability triggers: `worker` (no DELETE/TRUNCATE), `worker_display_id` (no UPDATE/DELETE/TRUNCATE),
`audit_event` (no UPDATE/DELETE/TRUNCATE — also for the owner). Rollback: `TW0001_talent_worker_foundation.down.sql`
(`DROP SCHEMA talent CASCADE`), never applied automatically.

## 4. Runtime grants (least privilege, explicit)

| Object | Runtime role |
|---|---|
| `worker`, `worker_display_id` | SELECT, INSERT |
| `permission`, `role_permission`, `field_catalog`, `field_policy`, `user_scope` | SELECT |
| `audit_event` | SELECT, INSERT |
| `schema_migrations` | SELECT |
| `seq_tal`, `seq_t`, `seq_w` | USAGE |
| `jsonb_has_forbidden_content(jsonb)` | EXECUTE (evaluated by an audit CHECK constraint) |
| schema `talent` | USAGE (no CREATE); PUBLIC has nothing |

The grant step revokes everything and re-grants the manifest on every run. A table or sequence in schema `talent`
that is not in the manifest makes the runner fail (fail-closed). No UPDATE on `worker` is granted in CP1; it is
added when a checkpoint needs a lifecycle transition.

## 5. Authorization

Permission catalogue (`talent.permission`; actions are the platform's seven):

| Code | Allowed actions | Covers |
|---|---|---|
| `tw_home` | VIEW | Home, Dashboard |
| `tw_registration` | VIEW, CREATE, EDIT | Candidate Registration (internal, P05) |
| `tw_verification` | VIEW, EDIT, APPROVE, REJECT | Verification & Screening (P06) |
| `tw_talent_pool` | VIEW, CREATE, EDIT, EXPORT | P07–P10 |
| `tw_deployment` | VIEW, CREATE, EDIT, APPROVE | P11–P13 |
| `tw_contract_placement` | VIEW, CREATE, EDIT, APPROVE | P14 |
| `tw_worker_passport` | VIEW | P15 / P15A |
| `tw_passport_print` | EXPORT | Print passport |
| `tw_passport_pdf` | EXPORT | Export PDF |
| `tw_document_download` | EXPORT | Download worker documents |
| `tw_reports` | VIEW, EXPORT | Reports & Analytics |
| `tw_security_admin` | VIEW, EDIT, ADMIN | Settings — Security & Access (P16) |

A database trigger refuses a grant whose action the permission does not declare. Grants are written only by
`database/seed-talent.js` (as the schema owner) and are replaced as a whole on each run; `database/seed.js` never
touches them, and no role inherits Talent rights automatically. See `docs/RBAC_MATRIX.md` for the CP1 grants.

Guards (`modules/talent/lib/talentAuth.js`): unauthenticated → 401 (API) / redirect to `/login.html` (page);
missing grant → 403 and a `PERMISSION_DENIED` audit event (route without query string).

## 6. Field-level security

`talent.field_catalog` (category, sensitivity, mask rule) + `talent.field_policy` (role × field → FULL / MASKED /
HIDDEN). Uncatalogued field → HIDDEN; no policy row → HIDDEN; MASKED always returns a derived value (LAST4, PHONE,
EMAIL, YEAR_ONLY, REDACT; NONE is treated as REDACT); several roles → most permissive. CP1: NIK MASKED for Workforce
Manager and HRD, HIDDEN for the Director; social security, financial and medical fields HIDDEN for everyone.

## 7. Data scope

`talent.user_scope`: no row = no data. CP1 honours `ALL` only; `ORGANIZATION` / `PROJECT` rows are validated but
fail closed (`SCOPE_TYPE_NOT_ENABLED`). The platform's `user_project_scope` is not reused (project scope enforcement
is still partial in the core). `seed-talent.js` grants `ALL` to active users currently holding a managed role;
users created later get no scope until it is granted (P16).

## 8. Audit

`talent.audit_event` event types: `VIEW_PASSPORT`, `VIEW_SENSITIVE_FIELD`, `PRINT_PASSPORT`, `EXPORT_PDF`,
`DOWNLOAD_DOCUMENT`, `PERMISSION_DENIED`. Payloads are metadata only: keys such as NIK, salary/gaji/wage, bank
account/rekening, diagnosis, BPJS number, password, and any 16-digit value are refused by the library and by the
database CHECK `talent.jsonb_has_forbidden_content`.

## 9. Worker Passport integrations

Until an approved integration checkpoint connects them, Attendance, OT, Payroll, BPJS, Accommodation, Mobility and
Meals are reported as `NOT_CONNECTED` (`GET /api/tw/integrations`). No operational data is invented.

## 10. Operations

```
npm run db:migrate          # core (unchanged)
npm run seed                # core roles/users (unchanged)
npm run db:migrate-talent   # Talent stream + explicit runtime grants (DATABASE_MIGRATION_URL, KAHE_DB_APP_ROLE)
npm run seed:talent         # Talent catalogue, grants, field policy, scope (DATABASE_MIGRATION_URL)
npm run test:talent-cp1     # Talent CP1 suite (TEST_DATABASE_ADMIN_URL)
SOURCE_URL=… RESTORE_ADMIN_URL=… RUNTIME_ROLE=kahe360_app RUNTIME_URL=… npm run db:verify-backup-talent -- <new_db>
```

## 11. Checkpoint plan

CP1 foundation (this) · CP2 P01–P04 public registration · CP3 P05–P06 · CP4 P07–P08 · CP5 P09–P10 · CP6 P11–P12 ·
CP7 P13–P14 (standalone) · CP8 P15/P15A + print/PDF · CP9 P16 + reports. Each checkpoint stops at a gate; the
protected regression floor (975) plus every Talent suite must pass.

## 12. Emergency Registration V0 (TW0002, 2026-09-22 — awaiting acceptance)
Public P01–P04 (`/register/*`, `/api/public/tw/register/*`) and a minimal EMERGENCY REGISTRATION INTAKE V0 list/CSV
(`/tw/emergency-intake`, `/api/tw/emergency-intake/*`, permission `tw_emergency_intake`). Adds `talent.registration`,
`talent.registration_document` (runtime INSERT/SELECT only) and the audit event `EXPORT_CSV`. Details:
`docs/TALENT_EMERGENCY_REGISTRATION_V0.md`.
