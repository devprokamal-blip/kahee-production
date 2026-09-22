# database/legacy-sqlite — historical, SQLite only

Byte-for-byte copies of the A3 (last SQLite) files. **Nothing in the running
application imports this directory.** It exists for three reasons only:

1. `init-db.js` + `attendance-*-schema.js` — the authoritative A3 schema, used as
   the reference the PostgreSQL schema is verified against (`tests/dbm1-*.test.js`)
   and by the one-way SQLite → PostgreSQL data migration tool.
2. `migrate-phase*.js` — the one-time upgrade scripts for OLD SQLite database
   files (ADD COLUMN / backfill via `PRAGMA`). An old SQLite file must be brought
   to the A3 shape with these BEFORE it is migrated to PostgreSQL. They have no
   PostgreSQL equivalent because the PostgreSQL baseline migration already
   contains the full A3 schema.
3. Rollback evidence, together with `KAHE360_INTERNAL_DEVELOPMENT_ATTENDANCE_A3.zip`.
