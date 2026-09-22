-- TW0002 rollback — removes Emergency Registration V0 structures only (TW0001 / CP1 stays).
-- NOT applied by the runner. Run deliberately, as the schema owner:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f database/pg/talent/migrations/TW0002_emergency_registration_v0.down.sql
-- REFUSES while any registration exists: V0 holds real candidate data and must be migrated, not dropped.
-- Uploaded files in private storage are not touched by this script.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM talent.registration) THEN
    RAISE EXCEPTION 'TW0002 rollback refused: talent.registration contains candidate registrations';
  END IF;
  IF EXISTS (SELECT 1 FROM talent.audit_event WHERE event_type = 'EXPORT_CSV') THEN
    RAISE EXCEPTION 'TW0002 rollback refused: talent.audit_event holds EXPORT_CSV events (audit history is immutable)';
  END IF;
END $$;
DROP TABLE talent.registration_document;
DROP TABLE talent.registration;
DROP FUNCTION talent.registration_requires_cv();
ALTER TABLE talent.audit_event DROP CONSTRAINT audit_event_event_type_check;
ALTER TABLE talent.audit_event ADD CONSTRAINT audit_event_event_type_check CHECK (event_type IN ('VIEW_PASSPORT',
  'VIEW_SENSITIVE_FIELD', 'PRINT_PASSPORT', 'EXPORT_PDF', 'DOWNLOAD_DOCUMENT', 'PERMISSION_DENIED'));
DELETE FROM talent.schema_migrations WHERE version = 'TW0002';
COMMIT;
