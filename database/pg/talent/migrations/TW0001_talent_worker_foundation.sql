-- TW0001 — Talent & Worker V1 foundation (CP1)
-- Isolated bounded context: every object lives in schema `talent`.
-- Rules for this stream (enforced by tests/talent-cp1.test.js):
--   * no reference to any object outside schema `talent` (no FK, trigger, view or function on `public`);
--   * structure only — no rows are inserted by a migration (catalogues and grants come from database/seed-talent.js);
--   * runtime privileges are NOT granted here; database/pg/talent/migrate-talent.js applies an explicit manifest.
-- The schema itself and talent.schema_migrations are created by the runner before this file runs.

-- ---------------------------------------------------------------- guards
CREATE FUNCTION talent.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'TALENT_IMMUTABLE: % on talent.% is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $f$;

-- Recursively reports whether a JSON document carries a key or value that must never be logged.
-- Keys are normalised (lower case, letters and digits only) before comparison.
CREATE FUNCTION talent.jsonb_has_forbidden_content(j jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $f$
DECLARE k text; v jsonb; nk text;
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
      nk := lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'));
      IF nk IN ('nik', 'noktp', 'ktp', 'ktpno', 'nomorktp', 'npwp', 'bpjs', 'bpjsno', 'bpjskesehatanno', 'bpjstkno',
                'password', 'passwordhash', 'value', 'rawvalue', 'oldvalue', 'newvalue', 'medical', 'mcuresult')
         OR nk LIKE '%salary%' OR nk LIKE '%gaji%' OR nk LIKE '%wage%' OR nk LIKE '%dailyrate%'
         OR nk LIKE '%bankaccount%' OR nk LIKE '%accountnumber%' OR nk LIKE '%rekening%'
         OR nk LIKE '%diagnos%' THEN
        RETURN true;
      END IF;
      IF talent.jsonb_has_forbidden_content(v) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(j) LOOP
      IF talent.jsonb_has_forbidden_content(v) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(j) = 'string' THEN
    -- A 16-digit run is the shape of an Indonesian NIK / card number: never allowed in an audit payload.
    IF (j #>> '{}') ~ '[0-9]{16}' THEN RETURN true; END IF;
  END IF;
  RETURN false;
END $f$;

-- ---------------------------------------------------------------- identity
-- One worker = one digital identity. No employer, project, position or contract column here:
-- those are separate facts attached to worker_uuid in later checkpoints.
CREATE TABLE talent.worker (
  worker_uuid        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_status   TEXT NOT NULL DEFAULT 'CANDIDATE'
                     CHECK (lifecycle_status IN ('CANDIDATE', 'TALENT', 'WORKER', 'INACTIVE')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id BIGINT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_worker_no_delete BEFORE DELETE ON talent.worker
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_worker_no_truncate BEFORE TRUNCATE ON talent.worker
  FOR EACH STATEMENT EXECUTE FUNCTION talent.forbid_change();

CREATE SEQUENCE talent.seq_tal AS BIGINT START 1 MINVALUE 1 MAXVALUE 999999 NO CYCLE;
CREATE SEQUENCE talent.seq_t   AS BIGINT START 1 MINVALUE 1 MAXVALUE 999999 NO CYCLE;
CREATE SEQUENCE talent.seq_w   AS BIGINT START 1 MINVALUE 1 MAXVALUE 999999 NO CYCLE;

-- Display IDs are labels for people, never keys. worker_uuid is the canonical identity.
CREATE TABLE talent.worker_display_id (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_uuid       UUID NOT NULL REFERENCES talent.worker (worker_uuid),
  id_type           TEXT NOT NULL CHECK (id_type IN ('REGISTRATION', 'TALENT', 'WORKER')),
  display_id        TEXT NOT NULL UNIQUE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by_user_id BIGINT,
  CONSTRAINT worker_display_id_one_per_type UNIQUE (worker_uuid, id_type),
  CONSTRAINT worker_display_id_format CHECK (
       (id_type = 'REGISTRATION' AND display_id ~ '^KAHE-TAL-[0-9]{4}-[0-9]{6}$')
    OR (id_type = 'TALENT'       AND display_id ~ '^KAHE-T-[0-9]{6}$')
    OR (id_type = 'WORKER'       AND display_id ~ '^KAHE-W-[0-9]{6}$'))
);
CREATE INDEX idx_worker_display_id_worker ON talent.worker_display_id (worker_uuid);
CREATE TRIGGER trg_worker_display_id_no_update BEFORE UPDATE ON talent.worker_display_id
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_worker_display_id_no_delete BEFORE DELETE ON talent.worker_display_id
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_worker_display_id_no_truncate BEFORE TRUNCATE ON talent.worker_display_id
  FOR EACH STATEMENT EXECUTE FUNCTION talent.forbid_change();

-- ---------------------------------------------------------------- authorization (Talent-owned)
-- Role codes are soft references to the platform's existing role records (public.roles.code);
-- there is deliberately no cross-schema foreign key.
CREATE TABLE talent.permission (
  code            TEXT PRIMARY KEY CHECK (code ~ '^tw_[a-z_]+$'),
  description     TEXT NOT NULL,
  allowed_actions TEXT[] NOT NULL CHECK (
    cardinality(allowed_actions) > 0
    AND allowed_actions <@ ARRAY['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT', 'ADMIN']::text[])
);

CREATE TABLE talent.role_permission (
  role_code       TEXT NOT NULL CHECK (role_code ~ '^[a-z_]+$'),
  permission_code TEXT NOT NULL REFERENCES talent.permission (code),
  action          TEXT NOT NULL CHECK (action IN ('VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT', 'ADMIN')),
  PRIMARY KEY (role_code, permission_code, action)
);

-- An action may only be granted if the permission declares it (e.g. print/PDF/download are EXPORT-only).
CREATE FUNCTION talent.role_permission_action_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE allowed text[];
BEGIN
  SELECT allowed_actions INTO allowed FROM talent.permission WHERE code = NEW.permission_code;
  IF allowed IS NULL OR NOT (NEW.action = ANY (allowed)) THEN
    RAISE EXCEPTION 'TALENT_ACTION_NOT_ALLOWED: % is not a valid action for %', NEW.action, NEW.permission_code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_role_permission_action_guard BEFORE INSERT OR UPDATE ON talent.role_permission
  FOR EACH ROW EXECUTE FUNCTION talent.role_permission_action_guard();

-- ---------------------------------------------------------------- field-level security
CREATE TABLE talent.field_catalog (
  field_code  TEXT PRIMARY KEY CHECK (field_code ~ '^[a-z_]+$'),
  category    TEXT NOT NULL CHECK (category IN ('IDENTITY', 'PERSONAL', 'CONTACT', 'SOCIAL_SECURITY',
                                                'FINANCIAL', 'MEDICAL', 'EMPLOYMENT', 'COMPETENCY', 'DOCUMENT')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('INTERNAL', 'PERSONAL', 'SENSITIVE', 'RESTRICTED')),
  mask_rule   TEXT NOT NULL CHECK (mask_rule IN ('NONE', 'LAST4', 'EMAIL', 'PHONE', 'YEAR_ONLY', 'REDACT')),
  description TEXT NOT NULL
);

-- No row = HIDDEN. Visibility is never inferred from a role's seniority.
CREATE TABLE talent.field_policy (
  role_code  TEXT NOT NULL CHECK (role_code ~ '^[a-z_]+$'),
  field_code TEXT NOT NULL REFERENCES talent.field_catalog (field_code),
  visibility TEXT NOT NULL CHECK (visibility IN ('FULL', 'MASKED', 'HIDDEN')),
  PRIMARY KEY (role_code, field_code)
);

-- ---------------------------------------------------------------- data scope
-- No row = no data. CP1 honours ALL only; ORGANIZATION / PROJECT are validated but fail closed.
CREATE TABLE talent.user_scope (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('ALL', 'ORGANIZATION', 'PROJECT')),
  scope_value TEXT,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_scope_value_shape CHECK (
       (scope_type = 'ALL' AND scope_value IS NULL)
    OR (scope_type <> 'ALL' AND scope_value IS NOT NULL AND length(btrim(scope_value)) > 0))
);
CREATE UNIQUE INDEX uq_user_scope ON talent.user_scope (user_id, scope_type, COALESCE(scope_value, ''));

-- ---------------------------------------------------------------- security & access audit
-- Talent/Worker access events only. Configuration changes stay in public.config_audit_log.
-- Payload is metadata: a forbidden key or a NIK-shaped value is rejected by the database itself.
CREATE TABLE talent.audit_event (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type       TEXT NOT NULL CHECK (event_type IN ('VIEW_PASSPORT', 'VIEW_SENSITIVE_FIELD', 'PRINT_PASSPORT',
                                                       'EXPORT_PDF', 'DOWNLOAD_DOCUMENT', 'PERMISSION_DENIED')),
  outcome          TEXT NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED')),
  actor_user_id    BIGINT,
  actor_role_codes TEXT[] NOT NULL DEFAULT '{}',
  worker_uuid      UUID REFERENCES talent.worker (worker_uuid),
  permission_code  TEXT,
  action           TEXT,
  route            TEXT CHECK (route IS NULL OR length(route) <= 300),
  ip_address       TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 64),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_event_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT audit_event_payload_metadata_only CHECK (NOT talent.jsonb_has_forbidden_content(payload)),
  CONSTRAINT audit_event_denied_shape CHECK (event_type <> 'PERMISSION_DENIED' OR outcome = 'DENIED')
);
CREATE INDEX idx_audit_event_occurred ON talent.audit_event (occurred_at);
CREATE INDEX idx_audit_event_worker ON talent.audit_event (worker_uuid) WHERE worker_uuid IS NOT NULL;
CREATE TRIGGER trg_audit_event_no_update BEFORE UPDATE ON talent.audit_event
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_audit_event_no_delete BEFORE DELETE ON talent.audit_event
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_audit_event_no_truncate BEFORE TRUNCATE ON talent.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION talent.forbid_change();
