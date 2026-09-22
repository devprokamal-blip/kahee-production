-- 0006_attendance_period_foundation.sql — Attendance A4 CP1
-- Attendance Period + effective-dated Closing Policy foundation (approved contract v3).
--
-- NEW OBJECTS ONLY. No existing table is altered, no trigger is added to an existing
-- table (timesheet_entries is untouched), no business row is inserted.
--
-- Conventions:
--   * Every refusal raises ERRCODE 'KH001' with MESSAGE = a language-neutral machine code
--     and DETAIL = a JSON object of parameters. No human sentence is part of the contract;
--     the UI translates codes (ID default, EN selectable).
--   * Actor identity is NEVER taken from a SQL statement. The application sets a
--     transaction-local action context (set_config('kahe.*', value, true)); the triggers
--     read it, validate it, and write every actor column and audit row themselves.
--   * Flags are BIGINT 0/1 (the DB layer rejects boolean parameters).

-- ============================================================================
-- helpers
-- ============================================================================
CREATE FUNCTION kahe_a4_raise(p_code text, p_detail jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'KH001', MESSAGE = p_code, DETAIL = COALESCE(p_detail, '{}'::jsonb)::text;
END
$fn$;

-- Transaction-local action context value, or NULL when absent/empty.
CREATE FUNCTION kahe_a4_ctx(p_name text) RETURNS text
LANGUAGE sql AS $fn$
  SELECT NULLIF(current_setting('kahe.' || p_name, true), '')
$fn$;

-- Validate the action context for an operation that requires p_permission ('module:ACTION').
-- The actor must be an active user who currently holds that module/action.
CREATE FUNCTION kahe_a4_actor(p_permission text,
  OUT user_id bigint, OUT user_name text, OUT user_role text, OUT permission text) RETURNS record
LANGUAGE plpgsql AS $fn$
DECLARE v_uid text := kahe_a4_ctx('actor_user_id');
BEGIN
  user_name := kahe_a4_ctx('actor_name');
  user_role := kahe_a4_ctx('actor_role');
  permission := kahe_a4_ctx('permission');
  IF v_uid IS NULL OR v_uid !~ '^[0-9]+$' OR user_name IS NULL OR user_role IS NULL OR permission IS NULL THEN
    PERFORM kahe_a4_raise('ACTOR_CONTEXT_REQUIRED', jsonb_build_object('required_permission', p_permission));
  END IF;
  IF permission <> p_permission THEN
    PERFORM kahe_a4_raise('ACTOR_PERMISSION_MISMATCH', jsonb_build_object('required_permission', p_permission, 'context_permission', permission));
  END IF;
  user_id := v_uid::bigint;
  IF NOT EXISTS (
    SELECT 1 FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.id = v_uid::bigint AND u.is_active = 1
      AND p.code = split_part(p_permission, ':', 1) AND rp.action = split_part(p_permission, ':', 2)
  ) THEN
    PERFORM kahe_a4_raise('ACTOR_NOT_AUTHORIZED', jsonb_build_object('required_permission', p_permission));
  END IF;
END
$fn$;

-- Serialize A4 writes of ONE legal entity by locking its legal_entities row.
-- FOR NO KEY UPDATE: conflicts with other A4 writers of the same entity and with edits of that
-- master row, but NOT with FOR KEY SHARE, so inserts into the tables that reference
-- legal_entities are never blocked. Different entities lock different rows: no hash, no collision.
-- READ COMMITTED is required: each following statement then takes a fresh snapshot and sees
-- whatever the previous lock holder committed. Under REPEATABLE READ it would not.
CREATE FUNCTION kahe_a4_lock_entity(p_entity text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_ISOLATION_UNSUPPORTED',
      jsonb_build_object('isolation', current_setting('transaction_isolation')));
  END IF;
  PERFORM 1 FROM legal_entities WHERE id = p_entity FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM kahe_a4_raise('LEGAL_ENTITY_NOT_FOUND', jsonb_build_object('legal_entity_id', p_entity));
  END IF;
END
$fn$;

CREATE FUNCTION kahe_a4_period_overlap_guard(p_entity text, p_start date, p_end date, p_self bigint) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE v_conflict bigint;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_INVALID_RANGE', jsonb_build_object('start_date', p_start, 'end_date', p_end));
  END IF;
  PERFORM kahe_a4_lock_entity(p_entity);
  SELECT id INTO v_conflict FROM attendance_periods
   WHERE legal_entity_id = p_entity AND (p_self IS NULL OR id <> p_self)
     AND start_date <= p_end AND end_date >= p_start
   ORDER BY id LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_OVERLAP', jsonb_build_object('conflicting_period_id', v_conflict));
  END IF;
END
$fn$;

-- ============================================================================
-- tables
-- ============================================================================
CREATE TABLE attendance_periods (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  legal_entity_id TEXT NOT NULL REFERENCES legal_entities(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEW','READY_TO_CLOSE','CLOSED','FROZEN')),
  created_by_user_id BIGINT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_by_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_transition_by_user_id BIGINT NOT NULL,
  last_transition_by_name TEXT NOT NULL,
  last_transition_role TEXT NOT NULL,
  last_transition_permission TEXT NOT NULL,
  last_transition_reason TEXT,
  last_transition_at TIMESTAMPTZ NOT NULL,
  reopen_count BIGINT NOT NULL DEFAULT 0,
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, start_date)
);
CREATE INDEX idx_attendance_periods_entity_range ON attendance_periods (legal_entity_id, start_date, end_date);

CREATE TABLE attendance_period_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  period_id BIGINT NOT NULL REFERENCES attendance_periods(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATE','TRANSITION','DETAILS_CHANGED')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id BIGINT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  permission TEXT NOT NULL,
  reason TEXT,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE attendance_closing_policies (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  legal_entity_id TEXT NOT NULL REFERENCES legal_entities(id),
  version_no BIGINT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ENDED','DISCARDED')),
  sod_waiver_blocks_freeze BIGINT NOT NULL DEFAULT 1 CHECK (sod_waiver_blocks_freeze IN (0,1)),
  require_waiver_reason BIGINT NOT NULL DEFAULT 1 CHECK (require_waiver_reason IN (0,1)),
  require_waiver_evidence BIGINT NOT NULL DEFAULT 0 CHECK (require_waiver_evidence IN (0,1)),
  created_by_user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  activated_by_user_id BIGINT,
  activated_at TIMESTAMPTZ,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((status = 'ENDED') = (effective_to IS NOT NULL)),
  UNIQUE (legal_entity_id, version_no)
);

CREATE TABLE attendance_closing_policy_rules (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  policy_id BIGINT NOT NULL REFERENCES attendance_closing_policies(id),
  issue_code TEXT NOT NULL CHECK (issue_code ~ '^[A-Z][A-Z0-9_]*$' AND issue_code <> 'TIMESHEET_LEGAL_ENTITY_UNRESOLVED'),
  severity TEXT NOT NULL CHECK (severity IN ('BLOCKER','WARNING','INFORMATIONAL')),
  waivable BIGINT NOT NULL DEFAULT 0 CHECK (waivable IN (0,1)),
  evidence_required BIGINT NOT NULL DEFAULT 0 CHECK (evidence_required IN (0,1)),
  CHECK (severity = 'BLOCKER' OR (waivable = 0 AND evidence_required = 0)),
  CHECK (evidence_required = 0 OR waivable = 1),
  UNIQUE (policy_id, issue_code)
);

CREATE TABLE attendance_closing_policy_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  policy_id BIGINT NOT NULL REFERENCES attendance_closing_policies(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('POLICY_CREATED','POLICY_UPDATED','POLICY_RULE_CHANGED',
    'POLICY_ACTIVATED','POLICY_ENDED','POLICY_DISCARDED')),
  actor_user_id BIGINT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  permission TEXT NOT NULL,
  reason TEXT,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- generic append-only / no-truncate functions
-- ============================================================================
CREATE FUNCTION kahe_a4_append_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM kahe_a4_raise('A4_AUDIT_APPEND_ONLY', jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP));
  RETURN NULL;
END
$fn$;

CREATE FUNCTION kahe_a4_no_truncate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM kahe_a4_raise('A4_TRUNCATE_FORBIDDEN', jsonb_build_object('table', TG_TABLE_NAME));
  RETURN NULL;
END
$fn$;

-- ============================================================================
-- attendance_periods
-- ============================================================================
CREATE FUNCTION kahe_a4_period_snapshot(p attendance_periods) RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('legal_entity_id', p.legal_entity_id, 'start_date', p.start_date,
    'end_date', p.end_date, 'label', p.label, 'status', p.status)
$fn$;

CREATE FUNCTION trg_attendance_periods_guard_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  IF NEW.status IS DISTINCT FROM 'OPEN' THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_INITIAL_STATUS_INVALID', jsonb_build_object('status', NEW.status));
  END IF;
  IF NEW.reopen_count IS DISTINCT FROM 0 THEN
    PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_FIELD_IMMUTABLE', jsonb_build_object('field', 'reopen_count'));
  END IF;
  a := kahe_a4_actor('attendance_period:CREATE');
  PERFORM kahe_a4_period_overlap_guard(NEW.legal_entity_id, NEW.start_date, NEW.end_date, NULL);
  -- identity and time are owned by the database, whatever the statement supplied
  NEW.created_by_user_id := a.user_id; NEW.created_by_name := a.user_name; NEW.created_by_role := a.user_role;
  NEW.created_at := kahe_now();
  NEW.last_transition_by_user_id := a.user_id; NEW.last_transition_by_name := a.user_name;
  NEW.last_transition_role := a.user_role; NEW.last_transition_permission := 'attendance_period:CREATE';
  NEW.last_transition_reason := NULL; NEW.last_transition_at := NEW.created_at;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_attendance_periods_guard_insert BEFORE INSERT ON attendance_periods
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_guard_insert_fn();

CREATE FUNCTION trg_attendance_periods_guard_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
CREATE TRIGGER trg_attendance_periods_guard_update BEFORE UPDATE ON attendance_periods
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_guard_update_fn();

CREATE FUNCTION trg_attendance_periods_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM kahe_a4_raise('ATTENDANCE_PERIOD_DELETE_FORBIDDEN', jsonb_build_object('period_id', OLD.id));
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_attendance_periods_no_delete BEFORE DELETE ON attendance_periods
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_no_delete_fn();

CREATE FUNCTION trg_attendance_periods_audit_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO attendance_period_events (period_id, event_type, from_status, to_status, actor_user_id, actor_name,
    actor_role, permission, reason, old_values, new_values, created_at)
  VALUES (NEW.id, 'CREATE', NULL, NEW.status, NEW.created_by_user_id, NEW.created_by_name, NEW.created_by_role,
    NEW.last_transition_permission, NULL, NULL, kahe_a4_period_snapshot(NEW), NEW.created_at);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_attendance_periods_audit_insert AFTER INSERT ON attendance_periods
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_audit_insert_fn();

CREATE FUNCTION trg_attendance_periods_audit_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
CREATE TRIGGER trg_attendance_periods_audit_update AFTER UPDATE ON attendance_periods
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_audit_update_fn();

CREATE TRIGGER trg_attendance_periods_no_truncate BEFORE TRUNCATE ON attendance_periods
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_a4_no_truncate_fn();

-- ============================================================================
-- attendance_period_events (append-only; rows only via the period audit triggers)
-- ============================================================================
CREATE FUNCTION trg_attendance_period_events_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_status text;
BEGIN
  -- depth 1 = a direct INSERT; the audit triggers insert at depth >= 2
  IF pg_trigger_depth() < 2 THEN
    PERFORM kahe_a4_raise('A4_AUDIT_DIRECT_INSERT_FORBIDDEN', jsonb_build_object('table', TG_TABLE_NAME));
  END IF;
  SELECT status INTO v_status FROM attendance_periods WHERE id = NEW.period_id;
  IF v_status IS NULL OR v_status IS DISTINCT FROM NEW.to_status THEN
    PERFORM kahe_a4_raise('A4_AUDIT_EVENT_INCONSISTENT', jsonb_build_object('period_id', NEW.period_id));
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_attendance_period_events_insert_guard BEFORE INSERT ON attendance_period_events
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_period_events_insert_guard_fn();
CREATE TRIGGER trg_attendance_period_events_no_update BEFORE UPDATE ON attendance_period_events
  FOR EACH ROW EXECUTE FUNCTION kahe_a4_append_only_fn();
CREATE TRIGGER trg_attendance_period_events_no_delete BEFORE DELETE ON attendance_period_events
  FOR EACH ROW EXECUTE FUNCTION kahe_a4_append_only_fn();
CREATE TRIGGER trg_attendance_period_events_no_truncate BEFORE TRUNCATE ON attendance_period_events
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_a4_no_truncate_fn();

-- ============================================================================
-- attendance_closing_policies
--   DRAFT (editable) -> ACTIVE (immutable) -> ENDED (effective_to set once; terminal)
--   DRAFT -> DISCARDED (terminal). No policy row is ever deleted.
-- ============================================================================
CREATE FUNCTION kahe_a4_policy_snapshot(p attendance_closing_policies) RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('legal_entity_id', p.legal_entity_id, 'version_no', p.version_no,
    'effective_from', p.effective_from, 'effective_to', p.effective_to, 'status', p.status,
    'sod_waiver_blocks_freeze', p.sod_waiver_blocks_freeze, 'require_waiver_reason', p.require_waiver_reason,
    'require_waiver_evidence', p.require_waiver_evidence)
$fn$;

CREATE FUNCTION trg_closing_policies_guard_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  IF NEW.status IS DISTINCT FROM 'DRAFT' OR NEW.effective_to IS NOT NULL
     OR NEW.activated_by_user_id IS NOT NULL OR NEW.activated_at IS NOT NULL THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_INITIAL_STATE_INVALID', jsonb_build_object('status', NEW.status));
  END IF;
  a := kahe_a4_actor('attendance_closing_policy:CREATE');
  PERFORM kahe_a4_lock_entity(NEW.legal_entity_id);
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO NEW.version_no
    FROM attendance_closing_policies WHERE legal_entity_id = NEW.legal_entity_id;
  NEW.created_by_user_id := a.user_id;
  NEW.created_at := kahe_now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_closing_policies_guard_insert BEFORE INSERT ON attendance_closing_policies
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policies_guard_insert_fn();

CREATE FUNCTION trg_closing_policies_guard_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record; v_field text; v_conflict bigint;
  v_header_changed boolean := NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.sod_waiver_blocks_freeze IS DISTINCT FROM OLD.sod_waiver_blocks_freeze
    OR NEW.require_waiver_reason IS DISTINCT FROM OLD.require_waiver_reason
    OR NEW.require_waiver_evidence IS DISTINCT FROM OLD.require_waiver_evidence;
BEGIN
  v_field := CASE
    WHEN NEW.id IS DISTINCT FROM OLD.id THEN 'id'
    WHEN NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id THEN 'legal_entity_id'
    WHEN NEW.version_no IS DISTINCT FROM OLD.version_no THEN 'version_no'
    WHEN NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN 'created_by_user_id'
    WHEN NEW.created_at IS DISTINCT FROM OLD.created_at THEN 'created_at'
    WHEN NEW.activated_by_user_id IS DISTINCT FROM OLD.activated_by_user_id THEN 'activated_by_user_id'
    WHEN NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN 'activated_at'
  END;
  IF v_field IS NOT NULL THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', v_field));
  END IF;

  IF OLD.status IN ('ENDED', 'DISCARDED') THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_IMMUTABLE', jsonb_build_object('status', OLD.status));
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.effective_to IS NOT NULL THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', 'effective_to'));
    END IF;
    IF v_header_changed THEN PERFORM kahe_a4_actor('attendance_closing_policy:EDIT'); END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
    IF v_header_changed OR NEW.effective_to IS NOT NULL THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', 'content_during_activation'));
    END IF;
    a := kahe_a4_actor('attendance_closing_policy:ADMIN');
    PERFORM kahe_a4_lock_entity(NEW.legal_entity_id);
    SELECT id INTO v_conflict FROM attendance_closing_policies
     WHERE legal_entity_id = NEW.legal_entity_id AND id <> NEW.id AND status IN ('ACTIVE', 'ENDED')
       AND effective_from <= 'infinity'::date AND COALESCE(effective_to, 'infinity'::date) >= NEW.effective_from
     ORDER BY id LIMIT 1;
    IF v_conflict IS NOT NULL THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_OVERLAP', jsonb_build_object('conflicting_policy_id', v_conflict));
    END IF;
    NEW.activated_by_user_id := a.user_id;
    NEW.activated_at := kahe_now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DISCARDED' THEN
    IF v_header_changed OR NEW.effective_to IS NOT NULL THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', 'content_during_discard'));
    END IF;
    PERFORM kahe_a4_actor('attendance_closing_policy:EDIT');
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACTIVE' AND NEW.status = 'ENDED' THEN
    IF v_header_changed THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', 'content_during_end'));
    END IF;
    IF NEW.effective_to IS NULL OR NEW.effective_to < NEW.effective_from THEN
      PERFORM kahe_a4_raise('CLOSING_POLICY_INVALID_EFFECTIVE_TO',
        jsonb_build_object('effective_from', NEW.effective_from, 'effective_to', NEW.effective_to));
    END IF;
    PERFORM kahe_a4_actor('attendance_closing_policy:ADMIN');
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_IMMUTABLE', jsonb_build_object('status', OLD.status));
  END IF;
  PERFORM kahe_a4_raise('CLOSING_POLICY_TRANSITION_INVALID', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_closing_policies_guard_update BEFORE UPDATE ON attendance_closing_policies
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policies_guard_update_fn();

CREATE FUNCTION trg_closing_policies_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM kahe_a4_raise('CLOSING_POLICY_DELETE_FORBIDDEN', jsonb_build_object('policy_id', OLD.id));
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_closing_policies_no_delete BEFORE DELETE ON attendance_closing_policies
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policies_no_delete_fn();

CREATE FUNCTION trg_closing_policies_audit_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  a := kahe_a4_actor('attendance_closing_policy:CREATE');
  INSERT INTO attendance_closing_policy_events (policy_id, event_type, actor_user_id, actor_name, actor_role, permission,
    reason, old_values, new_values, created_at)
  VALUES (NEW.id, 'POLICY_CREATED', a.user_id, a.user_name, a.user_role, a.permission,
    NULLIF(btrim(COALESCE(kahe_a4_ctx('reason'), '')), ''), NULL, kahe_a4_policy_snapshot(NEW), NEW.created_at);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_closing_policies_audit_insert AFTER INSERT ON attendance_closing_policies
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policies_audit_insert_fn();

CREATE FUNCTION trg_closing_policies_audit_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record; v_type text; v_perm text;
BEGIN
  IF kahe_a4_policy_snapshot(NEW) = kahe_a4_policy_snapshot(OLD) THEN RETURN NULL; END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN v_type := 'POLICY_UPDATED'; v_perm := 'attendance_closing_policy:EDIT';
  ELSIF NEW.status = 'ACTIVE' THEN v_type := 'POLICY_ACTIVATED'; v_perm := 'attendance_closing_policy:ADMIN';
  ELSIF NEW.status = 'ENDED' THEN v_type := 'POLICY_ENDED'; v_perm := 'attendance_closing_policy:ADMIN';
  ELSE v_type := 'POLICY_DISCARDED'; v_perm := 'attendance_closing_policy:EDIT';
  END IF;
  a := kahe_a4_actor(v_perm);
  INSERT INTO attendance_closing_policy_events (policy_id, event_type, actor_user_id, actor_name, actor_role, permission,
    reason, old_values, new_values, created_at)
  VALUES (NEW.id, v_type, a.user_id, a.user_name, a.user_role, a.permission,
    NULLIF(btrim(COALESCE(kahe_a4_ctx('reason'), '')), ''), kahe_a4_policy_snapshot(OLD), kahe_a4_policy_snapshot(NEW), kahe_now());
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_closing_policies_audit_update AFTER UPDATE ON attendance_closing_policies
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policies_audit_update_fn();

CREATE TRIGGER trg_closing_policies_no_truncate BEFORE TRUNCATE ON attendance_closing_policies
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_a4_no_truncate_fn();

-- ============================================================================
-- attendance_closing_policy_rules (writable only while the parent policy is DRAFT)
-- ============================================================================
CREATE FUNCTION kahe_a4_rule_snapshot(r attendance_closing_policy_rules) RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('issue_code', r.issue_code, 'severity', r.severity,
    'waivable', r.waivable, 'evidence_required', r.evidence_required)
$fn$;

-- FOR SHARE on the parent: a concurrent activation (a row UPDATE) waits for this rule write,
-- and a rule write that queues behind an activation re-reads the parent and sees ACTIVE.
CREATE FUNCTION kahe_a4_assert_policy_draft(p_policy_id bigint) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM attendance_closing_policies WHERE id = p_policy_id FOR SHARE;
  IF v_status IS NULL THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_NOT_FOUND', jsonb_build_object('policy_id', p_policy_id));
  END IF;
  IF v_status <> 'DRAFT' THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_IMMUTABLE', jsonb_build_object('status', v_status));
  END IF;
END
$fn$;

CREATE FUNCTION trg_closing_policy_rules_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
                            OR NEW.issue_code IS DISTINCT FROM OLD.issue_code) THEN
    PERFORM kahe_a4_raise('CLOSING_POLICY_FIELD_IMMUTABLE', jsonb_build_object('field', 'rule_identity'));
  END IF;
  PERFORM kahe_a4_assert_policy_draft(CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_id ELSE NEW.policy_id END);
  PERFORM kahe_a4_actor('attendance_closing_policy:EDIT');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_closing_policy_rules_guard_insert BEFORE INSERT ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_guard_fn();
CREATE TRIGGER trg_closing_policy_rules_guard_update BEFORE UPDATE ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_guard_fn();
CREATE TRIGGER trg_closing_policy_rules_guard_delete BEFORE DELETE ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_guard_fn();

CREATE FUNCTION trg_closing_policy_rules_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE a record; v_old jsonb; v_new jsonb; v_policy bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN v_old := NULL; v_new := kahe_a4_rule_snapshot(NEW); v_policy := NEW.policy_id;
  ELSIF TG_OP = 'UPDATE' THEN v_old := kahe_a4_rule_snapshot(OLD); v_new := kahe_a4_rule_snapshot(NEW); v_policy := NEW.policy_id;
    IF v_old = v_new THEN RETURN NULL; END IF;
  ELSE v_old := kahe_a4_rule_snapshot(OLD); v_new := NULL; v_policy := OLD.policy_id;
  END IF;
  a := kahe_a4_actor('attendance_closing_policy:EDIT');
  INSERT INTO attendance_closing_policy_events (policy_id, event_type, actor_user_id, actor_name, actor_role, permission,
    reason, old_values, new_values, created_at)
  VALUES (v_policy, 'POLICY_RULE_CHANGED', a.user_id, a.user_name, a.user_role, a.permission,
    NULLIF(btrim(COALESCE(kahe_a4_ctx('reason'), '')), ''), v_old, v_new, kahe_now());
  RETURN NULL;
END
$fn$;
CREATE TRIGGER trg_closing_policy_rules_audit_insert AFTER INSERT ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_audit_fn();
CREATE TRIGGER trg_closing_policy_rules_audit_update AFTER UPDATE ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_audit_fn();
CREATE TRIGGER trg_closing_policy_rules_audit_delete AFTER DELETE ON attendance_closing_policy_rules
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_rules_audit_fn();

CREATE TRIGGER trg_closing_policy_rules_no_truncate BEFORE TRUNCATE ON attendance_closing_policy_rules
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_a4_no_truncate_fn();

-- ============================================================================
-- attendance_closing_policy_events (append-only; rows only via the policy/rule audit triggers)
-- ============================================================================
CREATE FUNCTION trg_closing_policy_events_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    PERFORM kahe_a4_raise('A4_AUDIT_DIRECT_INSERT_FORBIDDEN', jsonb_build_object('table', TG_TABLE_NAME));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM attendance_closing_policies WHERE id = NEW.policy_id) THEN
    PERFORM kahe_a4_raise('A4_AUDIT_EVENT_INCONSISTENT', jsonb_build_object('policy_id', NEW.policy_id));
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_closing_policy_events_insert_guard BEFORE INSERT ON attendance_closing_policy_events
  FOR EACH ROW EXECUTE FUNCTION trg_closing_policy_events_insert_guard_fn();
CREATE TRIGGER trg_closing_policy_events_no_update BEFORE UPDATE ON attendance_closing_policy_events
  FOR EACH ROW EXECUTE FUNCTION kahe_a4_append_only_fn();
CREATE TRIGGER trg_closing_policy_events_no_delete BEFORE DELETE ON attendance_closing_policy_events
  FOR EACH ROW EXECUTE FUNCTION kahe_a4_append_only_fn();
CREATE TRIGGER trg_closing_policy_events_no_truncate BEFORE TRUNCATE ON attendance_closing_policy_events
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_a4_no_truncate_fn();
