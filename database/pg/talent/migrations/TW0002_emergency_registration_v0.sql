-- TW0002 — Emergency Registration V0 (public candidate registration, P01–P04)
-- Schema `talent` only. Structure only: no rows are inserted. Runtime grants come from the explicit manifest in
-- database/pg/talent/migrate-talent.js.
--
-- Migration readiness: every row is stamped source_type = 'EMERGENCY_V0', status = 'NEW',
-- migration_status = 'PENDING' so Full CP2–CP4 can adopt it without the candidate registering again.
-- A registration is NOT a worker identity yet: worker_uuid stays NULL until verification (a later checkpoint) links or
-- creates the one talent.worker for that person. registration_id is issued from talent.seq_tal in the CP1 format and
-- becomes that worker's REGISTRATION display ID at that point.
-- CHECK constraints avoid BETWEEN inside a larger AND so pg_dump/pg_restore reproduces their definition text exactly.
-- Deliberately NOT collected: NIK, BPJS, bank account, payroll data, medical data, job family.

CREATE TABLE talent.registration (
  registration_uuid     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id       TEXT NOT NULL UNIQUE CHECK (registration_id ~ '^KAHE-TAL-[0-9]{4}-[0-9]{6}$'),
  source_type           TEXT NOT NULL DEFAULT 'EMERGENCY_V0' CHECK (source_type IN ('EMERGENCY_V0')),
  status                TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW')),
  migration_status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (migration_status IN ('PENDING')),
  worker_uuid           UUID REFERENCES talent.worker (worker_uuid),

  -- P01 profile
  full_name             TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 120),
  whatsapp_country_code TEXT NOT NULL CHECK (whatsapp_country_code ~ '^[0-9]{1,3}$'),
  whatsapp_number       TEXT NOT NULL CHECK (whatsapp_number ~ '^[0-9]{6,13}$'),
  whatsapp_normalized   TEXT NOT NULL CHECK (whatsapp_normalized ~ '^[0-9]{8,16}$'),
  email                 TEXT NOT NULL CHECK (length(email) BETWEEN 5 AND 254),
  email_normalized      TEXT NOT NULL CHECK (email_normalized = lower(email_normalized) AND length(email_normalized) <= 254),
  current_city          TEXT NOT NULL CHECK (length(current_city) BETWEEN 2 AND 80),
  birth_date            DATE NOT NULL,
  education_level       TEXT NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA_SMK', 'D1', 'D2', 'D3', 'D4_S1', 'S2', 'S3')),
  major                 TEXT CHECK (major IS NULL OR length(major) BETWEEN 1 AND 100),
  linkedin_url          TEXT CHECK (linkedin_url IS NULL OR (linkedin_url ~ '^https?://' AND length(linkedin_url) <= 200)),

  -- P02 experience & skills
  has_work_experience   BIGINT NOT NULL CHECK (has_work_experience IN (0, 1)),
  total_experience      TEXT CHECK (total_experience IS NULL OR total_experience IN ('LT_1', '1_3', '3_5', '5_10', 'GT_10')),
  latest_position       TEXT CHECK (latest_position IS NULL OR length(latest_position) BETWEEN 1 AND 100),
  latest_company        TEXT CHECK (latest_company IS NULL OR length(latest_company) BETWEEN 1 AND 100),
  previous_industry     TEXT CHECK (previous_industry IS NULL OR previous_industry IN ('OIL_GAS', 'PETROCHEMICAL', 'POWER',
                          'MINING', 'CONSTRUCTION', 'INFRASTRUCTURE', 'MANUFACTURING', 'OTHER')),
  has_epc_experience    BIGINT NOT NULL CHECK (has_epc_experience IN (0, 1)),
  skills                TEXT[] NOT NULL CHECK (cardinality(skills) >= 1 AND cardinality(skills) <= 14 AND skills <@ ARRAY['CIVIL', 'MECHANICAL',
                          'PIPING', 'ELECTRICAL', 'INSTRUMENT', 'HSE', 'QA_QC', 'WELDING', 'OPERATOR', 'LOGISTICS',
                          'ADMINISTRATION', 'DRIVER', 'MANDARIN', 'OTHER']::text[]),
  other_skills          TEXT CHECK (other_skills IS NULL OR length(other_skills) BETWEEN 2 AND 200),

  -- P03 availability
  current_work_status   TEXT NOT NULL CHECK (current_work_status IN ('EMPLOYED', 'NOT_EMPLOYED', 'FRESH_GRADUATE')),
  available_start_date  DATE NOT NULL,
  preferred_work_type   TEXT[] NOT NULL CHECK (cardinality(preferred_work_type) >= 1 AND cardinality(preferred_work_type) <= 2
                          AND preferred_work_type <@ ARRAY['SITE', 'OFFICE']::text[]),
  preferred_locations   TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(preferred_locations) <= 10),
  willing_out_of_town   BIGINT NOT NULL CHECK (willing_out_of_town IN (0, 1)),
  willing_shift         BIGINT NOT NULL CHECK (willing_shift IN (0, 1)),

  -- consent (both statements are required to submit)
  consent_accuracy      BIGINT NOT NULL CHECK (consent_accuracy = 1),
  consent_processing    BIGINT NOT NULL CHECK (consent_processing = 1),
  consent_version       TEXT NOT NULL CHECK (consent_version ~ '^[A-Z0-9_.-]{3,40}$'),
  consent_at            TIMESTAMPTZ NOT NULL,

  -- anti-abuse / duplicate signal (never merged automatically)
  submission_nonce      TEXT NOT NULL UNIQUE CHECK (submission_nonce ~ '^[0-9a-f]{32}$'),
  possible_duplicate    BIGINT NOT NULL DEFAULT 0 CHECK (possible_duplicate IN (0, 1)),
  duplicate_signals     TEXT[] NOT NULL DEFAULT '{}' CHECK (duplicate_signals <@ ARRAY['PHONE', 'EMAIL']::text[]),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT registration_experience_shape CHECK (has_work_experience = 1
    OR (total_experience IS NULL AND latest_position IS NULL AND latest_company IS NULL)),
  CONSTRAINT registration_experience_required CHECK (has_work_experience = 0 OR total_experience IS NOT NULL),
  CONSTRAINT registration_other_skill CHECK (NOT ('OTHER' = ANY (skills)) OR other_skills IS NOT NULL),
  CONSTRAINT registration_duplicate_shape CHECK ((possible_duplicate = 1) = (cardinality(duplicate_signals) > 0))
);
CREATE INDEX idx_registration_whatsapp ON talent.registration (whatsapp_normalized);
CREATE INDEX idx_registration_email ON talent.registration (email_normalized);
CREATE INDEX idx_registration_created ON talent.registration (created_at);
CREATE TRIGGER trg_registration_no_delete BEFORE DELETE ON talent.registration
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_registration_no_truncate BEFORE TRUNCATE ON talent.registration
  FOR EACH STATEMENT EXECUTE FUNCTION talent.forbid_change();

-- Uploaded files: metadata only. The file itself lives in private storage under a random storage_key;
-- the candidate's original file name is kept as metadata and never used on disk.
CREATE TABLE talent.registration_document (
  document_uuid     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_uuid UUID NOT NULL REFERENCES talent.registration (registration_uuid),
  document_kind     TEXT NOT NULL CHECK (document_kind IN ('CV', 'SUPPORTING')),
  storage_key       TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{32}\.(pdf|jpg|png)$'),
  original_filename TEXT NOT NULL CHECK (length(original_filename) >= 1 AND length(original_filename) <= 200 AND original_filename !~ '[/\\]'),
  content_type      TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT registration_document_cv_is_pdf CHECK (document_kind <> 'CV' OR content_type = 'application/pdf')
);
CREATE UNIQUE INDEX uq_registration_one_cv ON talent.registration_document (registration_uuid) WHERE document_kind = 'CV';
CREATE INDEX idx_registration_document_registration ON talent.registration_document (registration_uuid);
CREATE TRIGGER trg_registration_document_no_update BEFORE UPDATE ON talent.registration_document
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_registration_document_no_delete BEFORE DELETE ON talent.registration_document
  FOR EACH ROW EXECUTE FUNCTION talent.forbid_change();
CREATE TRIGGER trg_registration_document_no_truncate BEFORE TRUNCATE ON talent.registration_document
  FOR EACH STATEMENT EXECUTE FUNCTION talent.forbid_change();

-- A registration without exactly one CV cannot be committed (checked at COMMIT, so the registration row and its
-- documents are inserted in one transaction).
CREATE FUNCTION talent.registration_requires_cv() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM talent.registration_document d
                  WHERE d.registration_uuid = NEW.registration_uuid AND d.document_kind = 'CV') THEN
    RAISE EXCEPTION 'TALENT_REGISTRATION_CV_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER trg_registration_requires_cv AFTER INSERT ON talent.registration
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION talent.registration_requires_cv();

-- The CSV export of the emergency intake list is a security/access event: widen the approved event list by one.
ALTER TABLE talent.audit_event DROP CONSTRAINT audit_event_event_type_check;
ALTER TABLE talent.audit_event ADD CONSTRAINT audit_event_event_type_check CHECK (event_type IN ('VIEW_PASSPORT',
  'VIEW_SENSITIVE_FIELD', 'PRINT_PASSPORT', 'EXPORT_PDF', 'DOWNLOAD_DOCUMENT', 'PERMISSION_DENIED', 'EXPORT_CSV'));
