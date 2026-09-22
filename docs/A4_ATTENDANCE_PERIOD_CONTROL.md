# A4 — Attendance Period Control

Status: **CP1 accepted and locked; CP2 implemented** (readiness engine + READY_TO_CLOSE gate). CP3+ not started.
Approved contract: A4 CP1 Contract v3. Migration: `0006_attendance_period_foundation.sql`.

## 1. Scope of CP1
Attendance Period is a first-class operational object scoped by **Legal Entity**; Closing Policy is
its effective-dated rule surface. CP1 delivers: create, OPEN ⇄ REVIEW, OPEN details edit, policy
versions and rules, full append-only audit, derived Attendance ⇄ Payroll Period mapping (read-only).

CP1 does **not** touch `timesheet_entries`, Payroll files, Payroll semantics, or the app shell /
ID|EN switch, and adds no readiness, close, reopen, freeze, snapshot, import, export or UI.

## 2. Lifecycle (database-enforced)

| Transition | CP1 | Permission | Notes |
|---|---|---|---|
| create → OPEN | enabled | `attendance_period:CREATE` | overlap-guarded; CREATE event |
| OPEN → REVIEW | enabled | `attendance_period:EDIT` | TRANSITION event |
| REVIEW → OPEN | enabled | `attendance_period:EDIT` | reason required |
| OPEN details (dates, label) | enabled | `attendance_period:EDIT` | `last_transition_*` untouched; DETAILS_CHANGED event |
| REVIEW → READY_TO_CLOSE | `ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED` | — | enabled by CP2 |
| READY_TO_CLOSE → CLOSED · CLOSED → REVIEW (reopen) · CLOSED → FROZEN | `ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED` | — | enabled by CP5 |
| anything else | `ATTENDANCE_PERIOD_TRANSITION_INVALID` | — | FROZEN is terminal |

No reopen route and no reopen permission exist in CP1. Periods are never deleted (any status).
The API transition is compare-and-set: `{to_status, expected_status, reason}`; a stale
`expected_status` returns `ATTENDANCE_PERIOD_STATE_CHANGED` with the current status.

## 3. Overlap prevention (per Legal Entity)
Same dates in different Legal Entities are valid; within one entity, inclusive date ranges must not
overlap. The insert/date-edit trigger:
1. refuses any isolation other than READ COMMITTED (`ATTENDANCE_PERIOD_ISOLATION_UNSUPPORTED`);
2. `SELECT … FROM legal_entities WHERE id = $entity FOR NO KEY UPDATE`;
3. searches for an overlapping row → `ATTENDANCE_PERIOD_OVERLAP {conflicting_period_id}`.

`FOR NO KEY UPDATE` serialises A4 writers of the **same** entity (and edits of that master row) but
does not conflict with `FOR KEY SHARE`, so inserts into the 18 tables referencing `legal_entities`
are never blocked. Different entities lock different rows: no hash, no collision. `btree_gist` is
not used. Correctness does not depend on `middleware/writeSerializer` (the CP1 suite runs with it OFF).

## 4. Actor identity and audit
* Actor identity comes **only** from the authenticated session (`req.userContext`). Request bodies
  are allowlisted per endpoint; any other field (e.g. `actor_user_id`, `created_by_*`,
  `last_transition_*`, `permission`, `status`, `reopen_count`) → `400 REQUEST_FIELD_NOT_ALLOWED`.
* The library opens one transaction and sets a **transaction-local** action context:
  `set_config('kahe.actor_user_id' | 'kahe.actor_name' | 'kahe.actor_role' | 'kahe.permission' | 'kahe.reason', value, true)`.
  It vanishes at COMMIT/ROLLBACK, so a pooled connection never carries it into another request.
* Triggers write every actor column and every audit row from that context; a missing context →
  `ACTOR_CONTEXT_REQUIRED`; the wrong permission → `ACTOR_PERMISSION_MISMATCH`; an inactive user or
  one not holding the module/action → `ACTOR_NOT_AUTHORIZED` (defense in depth). Honest limit: a
  compromised runtime role could name another authorized user; the session is the authority.
* `last_transition_*` change only with a status transition (or creation). `reopen_count` never
  changes in CP1 and cannot be supplied. `created_*`, `legal_entity_id` are immutable.
* Audit tables `attendance_period_events` (CREATE · TRANSITION · DETAILS_CHANGED) and
  `attendance_closing_policy_events` (POLICY_CREATED · POLICY_UPDATED · POLICY_RULE_CHANGED ·
  POLICY_ACTIVATED · POLICY_ENDED · POLICY_DISCARDED) are append-only: direct INSERT is refused
  (only the audit triggers may insert, `pg_trigger_depth() >= 2`), UPDATE/DELETE always raise, and
  TRUNCATE is refused even for the schema owner.

## 5. Closing Policy
DRAFT (header + rules editable) → ACTIVE (immutable; activation overlap-checked under the entity
lock) → ENDED (`effective_to` set once, ≥ `effective_from`; terminal). DRAFT → DISCARDED (terminal).
No policy row is ever deleted. As-of resolution uses ACTIVE and ENDED versions:
`GET /api/attendance-closing-policies/resolve?legal_entity_id=…&date=…` → the version in force, or
`404 NO_CLOSING_POLICY`. No default policy is seeded.

Configurable issue codes (validated by the API; only states that exist today): the 10 A3 exception
types, `PENDING_OVERTIME_APPROVAL`, `PENDING_ATTENDANCE_CORRECTION`, `PENDING_PAYROLL_REVIEW`,
`MISSING_ATTENDANCE`, `UNRESOLVED_SCHEDULE`, `UNCLASSIFIED_DAY_TYPE`. Waiver/evidence flags are only
valid on BLOCKER rules. `TIMESHEET_LEGAL_ENTITY_UNRESOLVED` is a **fixed, non-waivable blocker**
(CP2) and is not configurable (API and database CHECK).

## 6. Attendance ⇄ Payroll Period (derived, N:M)
Nothing is stored in CP1. `GET /api/attendance-periods/:id/payroll-periods` (needs
`attendance_period:VIEW` and `payroll_run:VIEW`) lists Payroll Periods of the same Legal Entity whose
dates overlap, flagging `straddles`. `lib/attendancePeriod.coverageFor(payrollPeriodId)` returns the
covering Attendance Periods and the uncovered gaps. The persisted binding and the rule "Payroll
Period attendance-ready only when fully covered by FROZEN Attendance Periods" are CP5.

## 7. Bilingual contract
All A4 responses are `{ "error": <MACHINE_CODE>, "detail": {…} }` — including 401/403/404 inside the
two A4 namespaces. No human sentence is returned; the UI (CP6) translates codes through the existing
`public/translations/{id,en}.js` (Bahasa Indonesia default, English selectable). Database refusals
raise `KH001` with MESSAGE = the bare code and DETAIL = JSON. Catalogue: `lib/attendancePeriod.js`
(`ERRORS`).

## 8. Deferred decisions carried forward (locked)
* `timesheet_entries` lock trigger: CP5 (`ATTENDANCE_OPS_PERIOD_CLOSED` / `_FROZEN`), keyed on the
  row's own `legal_entity_id`; NULL-entity rows are never locked by another entity's period.
* NULL `legal_entity_id`: CP2 fixed blocker `TIMESHEET_LEGAL_ENTITY_UNRESOLVED`.
* Payroll compatibility (Option B), calendar/`dayClassification` detect-and-block: CP5. No frozen
  Payroll file is modified in any A4 checkpoint.
* Policy `effective_to` may currently be set to any date ≥ `effective_from`; CP5 close evidence
  records the policy id used, so a later retroactive end cannot rewrite a recorded close.

## 9. Rollback (owner role only)
1. Take `pg_dump -Fc` before `npm run db:migrate`. DB-M1 FINAL ZIP remains the code baseline.
2. Run the reverse script below as the **schema owner** (`DATABASE_MIGRATION_URL`).
3. Restore the 5 modified code/test/config files from the DB-M1 FINAL ZIP (`server.js`,
   `database/seed.js`, `database/pg/migrate-from-sqlite.js`, `tests/dbm1-foundation.test.js`,
   `package.json`), delete the 5 created code/test files (the migration, `lib/attendancePeriod.js`,
   `lib/attendanceClosingPolicy.js`, `routes/attendance-period.js`, `tests/attendance-a4-cp1.test.js`),
   and restore/delete the 6 documentation files the same way.

Proven on a scratch database: after this script the **unmodified** DB-M1 `dbm1-foundation` passes
45/45 and the schema equals a fresh 0001–0005 database.

```sql
-- A4 CP1 REVERSE (migration 0006). Owner role only. One transaction.
BEGIN;
DROP FUNCTION kahe_a4_period_snapshot(attendance_periods);
DROP FUNCTION kahe_a4_policy_snapshot(attendance_closing_policies);
DROP FUNCTION kahe_a4_rule_snapshot(attendance_closing_policy_rules);
-- dropping the tables drops their 27 triggers
DROP TABLE attendance_closing_policy_events;
DROP TABLE attendance_period_events;
DROP TABLE attendance_closing_policy_rules;
DROP TABLE attendance_closing_policies;
DROP TABLE attendance_periods;
DROP FUNCTION trg_attendance_periods_guard_insert_fn(), trg_attendance_periods_guard_update_fn(),
  trg_attendance_periods_no_delete_fn(), trg_attendance_periods_audit_insert_fn(), trg_attendance_periods_audit_update_fn(),
  trg_attendance_period_events_insert_guard_fn(), trg_closing_policies_guard_insert_fn(), trg_closing_policies_guard_update_fn(),
  trg_closing_policies_no_delete_fn(), trg_closing_policies_audit_insert_fn(), trg_closing_policies_audit_update_fn(),
  trg_closing_policy_rules_guard_fn(), trg_closing_policy_rules_audit_fn(), trg_closing_policy_events_insert_guard_fn(),
  kahe_a4_append_only_fn(), kahe_a4_no_truncate_fn(), kahe_a4_assert_policy_draft(bigint),
  kahe_a4_period_overlap_guard(text, date, date, bigint), kahe_a4_lock_entity(text), kahe_a4_actor(text),
  kahe_a4_ctx(text), kahe_a4_raise(text, jsonb);
DELETE FROM role_permissions WHERE permission_id IN
  (SELECT id FROM permissions WHERE code IN ('attendance_period', 'attendance_closing_policy'));
DELETE FROM permissions WHERE code IN ('attendance_period', 'attendance_closing_policy');
DELETE FROM schema_migrations WHERE version = '0006';
COMMIT;
```

---

# CP2 — Readiness engine and READY_TO_CLOSE gate (migration `0007_attendance_readiness.sql`)

## 10. What CP2 answers
"Is this Attendance Period ready for REVIEW → READY_TO_CLOSE, and if not, exactly what blocks it?" Readiness is computed
on demand in ONE `REPEATABLE READ` snapshot, from current A1–A3 state, by `lib/attendanceReadiness.js`. It writes nothing
except the successful gate evaluation. CP2 does **not** close, freeze, reopen, lock `timesheet_entries`, waive, snapshot,
export or add UI.

## 11. Result model (machine codes only)
`{ ready, summary: {blockers, warnings, informational}, policy: {policy_id, version_no, as_of_date} | null, engine_version,
fingerprint, groups[], evaluated_at, readiness_record | null, stale | null }`. Issue instances (detail endpoint):
`{issue_code, severity, waivable, evidence_required, rule_source (FIXED|POLICY|DEFAULT), level (ROW|REQUEST|EXCEPTION|EMPLOYEE_DAY|PERIOD),
source_type, source_id, employee_id, work_date, reference_exception_id, detail}`. Ordering: severity, issue_code, work_date,
employee_id, source_id. `ready` ⇔ `blockers = 0`. The SHA-256 fingerprint covers the sorted instance set, policy id/version,
period id/entity/dates and engine version — not timestamps and not the period status.

## 12. Fixed blockers (BLOCKER, non-waivable, not policy-configurable)
| Code | Condition |
|---|---|
| `NO_CLOSING_POLICY` | no ACTIVE/ENDED version covers `end_date` |
| `TIMESHEET_LEGAL_ENTITY_UNRESOLVED` | non-voided row with NULL entity attributed to this entity |
| `TIMESHEET_VOID_UNPROVEN` | VOIDED row attributable to this entity failing any accounted-void invariant |
| `TIMESHEET_ENTITY_CONFLICT` | A-side: foreign row on an expected day, or AMBIGUOUS attribution; B-side: stored-entity row with R ≠ own entity, AMBIGUOUS or NULL |

**Accounted void** (the employee-day was accounted for by an approved void decision — not "attendance was present"):
row `record_status='VOIDED'`, `void_correction_id = last_correction_id = c.id`; correction `request_type='VOID'`,
`status='VOIDED'`, `applied_to_source=1`, same row / employee / work_date, `legal_entity_id` = period entity; and a version
row `version_type='VOID'`, `correction_id=c.id`, `version_no=row.current_version`, `applied_to_source=1`.

## 13. Daily coverage (expected employee-days)
Expected day for entity A = frozen `isEligibleOn` eligible with assignment entity A, `resolveSchedule` status OK,
`dayStatus='WORK'`, `dayType='WORKDAY'`. OFF days, weekly rest days, holidays and ineligible days are not expected; an
undeterminable schedule → `UNRESOLVED_SCHEDULE`, OK + WORK + NULL day type → `UNCLASSIFIED_DAY_TYPE` (fail-safe).

| Key `(employee_id, work_date)` held by | Coverage | Issue (only this one) |
|---|---|---|
| non-voided row of A | covered | — |
| non-voided NULL-entity row attributed to A | covered | `TIMESHEET_LEGAL_ENTITY_UNRESOLVED` |
| accounted void (A) | accounted | — |
| unproven void (A) | not covered | `TIMESHEET_VOID_UNPROVEN` |
| row of another entity | not covered | `TIMESHEET_ENTITY_CONFLICT` |
| nothing | not covered | `MISSING_ATTENDANCE` |

## 14. Policy-driven issues
Population = non-voided rows attributed to the period entity. The 8 row-derived A3 types are evaluated **live** with the
unmodified `attendanceException.detectForEntry` (A3 correction-policy thresholds, cached per date as `/exceptions/scan`);
`findOverlap` is called only for the A3 cross-midnight precondition (`clock_out_date` set and ≠ `work_date`), otherwise
`duplicateOf = null`. A RESOLVED exception on the same row and type suppresses only when `resolved_at > row.updated_at`.
Open exception rows are references only. `LATE_CORRECTION` counts while its correction is pending
(`SUBMITTED, UNDER_REVIEW, APPROVED, VOID_REQUESTED, VOID_REVIEWED, VOID_APPROVED`); `PAYROLL_ADJUSTMENT_REQUIRED` while
pending or `PENDING_PAYROLL_REVIEW`; a NULL/dangling `correction_id` counts (fail-safe). Pending requests →
`PENDING_ATTENDANCE_CORRECTION`, `PENDING_PAYROLL_REVIEW`; `DRAFT` and `QUEUED_FOR_PAYROLL` do not block. Row states:
`PENDING_OVERTIME_APPROVAL`, `UNRESOLVED_SCHEDULE` (`day_status` NULL, or WORK without schedule), `UNCLASSIFIED_DAY_TYPE`.
No cross-code deduplication. A code without a rule in the applicable policy defaults to **BLOCKER, non-waivable**.
DUPLICATE detail reveals `overlaps_entry_id` only when that row belongs to the period entity (else `overlaps_entry_in_scope: false`).

## 15. Attribution R(e, d) — one batch query
Dated step = the frozen `getAssignmentOn` predicate; rows at the maximum `effective_date` with identical
K = (`legal_entity_id`, `work_pattern_id`, `work_calendar_id`) → that entity, divergent K → `AMBIGUOUS`. Otherwise the
fallback (`resolveResourceEntity('employee')`: latest `effective_date`): one entity → it, several → `AMBIGUOUS`, none →
`NULL`. Equivalence with `attendanceGuard.entityForEmployeeOn` and K equivalence with frozen `getAssignmentOn` are proven by
the CP2 suite. AMBIGUOUS pairs never reach a frozen per-pair helper, so readiness is independent of physical row order.

## 16. Policy resolution
As-of date = period `end_date`, ACTIVE/ENDED versions only (DRAFT and future versions never affect readiness). The gate
evaluation records policy id, version and as-of date.

## 17. Transitions
* `POST /api/attendance-periods/:id/ready-to-close` `{expected_status:"REVIEW", expected_fingerprint}` — `attendance_readiness:APPROVE`.
  One REPEATABLE READ transaction: lock period, recompute, refuse `ATTENDANCE_READINESS_NOT_READY` (blockers > 0) or
  `ATTENDANCE_READINESS_CHANGED` (fingerprint differs), insert the evaluation (every count/summary/policy field computed by
  the server; actor, time, txid set by the trigger), bind it via `kahe.readiness_evaluation_id`, compare-and-set UPDATE.
* `POST /api/attendance-periods/:id/withdraw-ready` `{expected_status:"READY_TO_CLOSE", reason}` — `attendance_readiness:APPROVE`,
  reason mandatory (`ATTENDANCE_PERIOD_REASON_REQUIRED`).
* The replaced CP1 guard allows REVIEW → READY_TO_CLOSE only with an evaluation of the same period, the same transaction
  (`txid_current()`) and `blocker_count = 0`; without evidence it stays `ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED` (CP1 generic
  path and raw SQL unchanged). READY_TO_CLOSE → REVIEW requires the WITHDRAW context. CLOSED, FROZEN, reopen remain not enabled.
* READY_TO_CLOSE is an as-of assertion, not a lock. Preview in READY_TO_CLOSE returns `readiness_record` — the evaluation
  referenced by the latest TRANSITION event (which must have entered READY_TO_CLOSE) — and `stale` = fingerprints differ.
  Missing/malformed linkage → `500 ATTENDANCE_READINESS_RECORD_INVALID`. Never auto-demoted.

## 18. RBAC
`attendance_readiness`: Operations Director VIEW, APPROVE · Workforce Manager VIEW, APPROVE · HRD Officer VIEW · Payroll
Officer VIEW · Supervisor, Occupational Health, HSE Officer none. VIEW is required for summary and detail;
`attendance_period:VIEW` alone reveals nothing. Entity scope via the CP1 period guard (cross-entity → 404).

## 19. Schema (0007)
1 table `attendance_readiness_evaluations` (policy id/version/as-of NOT NULL, `blocker_count = 0`, counts ≥ 0, hex
fingerprint), 2 FKs (periods, closing policies), 1 index (`period_id`), 3 row triggers + 1 no-truncate, 3 functions
(`kahe_rdy_guard_insert_fn`, `kahe_rdy_append_only_fn`, `kahe_rdy_no_truncate_fn`), 2 CP1 functions replaced
(`trg_attendance_periods_guard_update_fn`, `trg_attendance_periods_audit_update_fn`). No trigger on `timesheet_entries`;
0006 untouched.

## 20. CP2 rollback (owner role only)
1. Withdraw every READY_TO_CLOSE period through the authenticated withdraw endpoint with a reason (the script refuses otherwise).
2. Optionally keep history: `pg_dump -t attendance_readiness_evaluations`. Past period events stay as inert history.
3. Run the script below as the schema owner; then restore the 12 modified files from the A4_CP2_CP0_BASELINE tree and delete the 3 created files.

```sql
-- A4 CP2 REVERSE (migration 0007). Owner role only. One transaction.
-- Aborts while ANY period is READY_TO_CLOSE: withdraw each first through
-- POST /api/attendance-periods/:id/withdraw-ready (authenticated, mandatory reason). No status is rewritten here.
BEGIN;
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM attendance_periods WHERE status = 'READY_TO_CLOSE') THEN
    RAISE EXCEPTION USING ERRCODE = 'KH001', MESSAGE = 'A4_CP2_ROLLBACK_BLOCKED_READY_TO_CLOSE', DETAIL = '{}';
  END IF;
END $guard$;
DROP TABLE attendance_readiness_evaluations;
DROP FUNCTION kahe_rdy_guard_insert_fn(), kahe_rdy_append_only_fn(), kahe_rdy_no_truncate_fn();
-- restore the two CP1 functions verbatim from 0006
CREATE OR REPLACE FUNCTION trg_attendance_periods_guard_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  a record; v_perm text; v_reason text;
  v_status_changed boolean := NEW.status IS DISTINCT FROM OLD.status;
  v_details_changed boolean := NEW.start_date IS DISTINCT FROM OLD.start_date
    OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.label IS DISTINCT FROM OLD.label;
  v_field text;
BEGIN
  -- always immutable
  v_field := CASE
    WHEN NEW.id IS DISTINCT FROM OLD.id THEN 'id'
    WHEN NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id THEN 'legal_entity_id'
    WHEN NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN 'created_by_user_id'
    WHEN NEW.created_by_name IS DISTINCT FROM OLD.created_by_name THEN 'created_by_name'
    WHEN NEW.created_by_role IS DISTINCT FROM OLD.created_by_role THEN 'created_by_role'
    WHEN NEW.created_at IS DISTINCT FROM OLD.created_at THEN 'created_at'
    WHEN NEW.reopen_count IS DISTINCT FROM OLD.reopen_count THEN 'reopen_count'
  END;
  IF v_field IS NOT NULL THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_FIELD_IMMUTABLE', jsonb_build_object('field', v_field));
  END IF;
  IF OLD.status = 'FROZEN' THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_FIELD_IMMUTABLE', jsonb_build_object('field', 'status', 'status', OLD.status));
  END IF;

  IF NOT v_status_changed THEN
    -- transition metadata may change ONLY with a status transition
    v_field := CASE
      WHEN NEW.last_transition_by_user_id IS DISTINCT FROM OLD.last_transition_by_user_id THEN 'last_transition_by_user_id'
      WHEN NEW.last_transition_by_name IS DISTINCT FROM OLD.last_transition_by_name THEN 'last_transition_by_name'
      WHEN NEW.last_transition_role IS DISTINCT FROM OLD.last_transition_role THEN 'last_transition_role'
      WHEN NEW.last_transition_permission IS DISTINCT FROM OLD.last_transition_permission THEN 'last_transition_permission'
      WHEN NEW.last_transition_reason IS DISTINCT FROM OLD.last_transition_reason THEN 'last_transition_reason'
      WHEN NEW.last_transition_at IS DISTINCT FROM OLD.last_transition_at THEN 'last_transition_at'
    END;
    IF v_field IS NOT NULL THEN
      PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_FIELD_IMMUTABLE', jsonb_build_object('field', v_field));
    END IF;
    IF NOT v_details_changed THEN RETURN NEW; END IF;
    IF OLD.status <> 'OPEN' THEN
      PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_DETAILS_LOCKED', jsonb_build_object('status', OLD.status));
    END IF;
    PERFORM kahe_a4_actor('attendance_period:EDIT');
    IF NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date THEN
      PERFORM kahe_a4_period_overlap_guard(NEW.legal_entity_id, NEW.start_date, NEW.end_date, OLD.id);
    END IF;
    RETURN NEW;
  END IF;

  -- status transition: details must not change in the same statement
  IF v_details_changed THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_FIELD_IMMUTABLE', jsonb_build_object('field', 'details_during_transition'));
  END IF;
  IF (OLD.status, NEW.status) IN (('OPEN','REVIEW'), ('REVIEW','OPEN')) THEN
    v_perm := 'attendance_period:EDIT';
  ELSIF (OLD.status, NEW.status) IN (('REVIEW','READY_TO_CLOSE'), ('READY_TO_CLOSE','CLOSED'), ('CLOSED','REVIEW'), ('CLOSED','FROZEN')) THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_TRANSITION_NOT_ENABLED', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  ELSE
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_TRANSITION_INVALID', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  a := kahe_a4_actor(v_perm);
  v_reason := NULLIF(btrim(COALESCE(kahe_a4_ctx('reason'), '')), '');
  IF OLD.status = 'REVIEW' AND NEW.status = 'OPEN' AND v_reason IS NULL THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_REASON_REQUIRED', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  NEW.last_transition_by_user_id := a.user_id; NEW.last_transition_by_name := a.user_name;
  NEW.last_transition_role := a.user_role; NEW.last_transition_permission := v_perm;
  NEW.last_transition_reason := v_reason; NEW.last_transition_at := kahe_now();
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION trg_attendance_periods_audit_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO attendance_period_events (period_id, event_type, from_status, to_status, actor_user_id, actor_name,
      actor_role, permission, reason, old_values, new_values, created_at)
    VALUES (NEW.id, 'TRANSITION', OLD.status, NEW.status, NEW.last_transition_by_user_id, NEW.last_transition_by_name,
      NEW.last_transition_role, NEW.last_transition_permission, NEW.last_transition_reason,
      kahe_a4_period_snapshot(OLD), kahe_a4_period_snapshot(NEW), NEW.last_transition_at);
  ELSIF NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date
        OR NEW.label IS DISTINCT FROM OLD.label THEN
    a := kahe_a4_actor('attendance_period:EDIT');
    INSERT INTO attendance_period_events (period_id, event_type, from_status, to_status, actor_user_id, actor_name,
      actor_role, permission, reason, old_values, new_values, created_at)
    VALUES (NEW.id, 'DETAILS_CHANGED', OLD.status, NEW.status, a.user_id, a.user_name, a.user_role, a.permission,
      NULLIF(btrim(COALESCE(kahe_a4_ctx('reason'), '')), ''),
      kahe_a4_period_snapshot(OLD), kahe_a4_period_snapshot(NEW), kahe_now());
  END IF;
  RETURN NULL;
END
$fn$;

DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'attendance_readiness');
DELETE FROM permissions WHERE code = 'attendance_readiness';
DELETE FROM schema_migrations WHERE version = '0007';
COMMIT;
```
