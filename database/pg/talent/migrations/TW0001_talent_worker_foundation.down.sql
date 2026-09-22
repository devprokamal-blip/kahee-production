-- TW0001 rollback — removes the whole Talent & Worker V1 bounded context.
-- NOT applied by the runner. Run deliberately, as the schema owner, only when rolling CP1 back:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f database/pg/talent/migrations/TW0001_talent_worker_foundation.down.sql
-- Nothing outside schema `talent` is touched, because nothing outside it depends on it.
-- WARNING: this also removes talent.audit_event and every Talent identity. Take a backup first
-- (npm run db:verify-backup-talent) — in CP1 the schema holds configuration only.
DROP SCHEMA IF EXISTS talent CASCADE;
