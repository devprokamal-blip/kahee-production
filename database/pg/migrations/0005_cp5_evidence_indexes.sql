-- 0005_cp5_evidence_indexes.sql — DB-M1 CP5. Indexes added ONLY on measured evidence (docs/DB_M1_PERFORMANCE_REPORT.md).
--
-- Audit Center filtered by employee:
--   SELECT ev.* FROM attendance_events ev WHERE (legal entity scope) AND ev.employee_id = $n ORDER BY ev.id DESC LIMIT 200
-- At 6,000 workers / 2.18 M audit rows PostgreSQL walked attendance_events_pkey backwards and discarded 2,179,950 rows
-- to return 200 (283 ms, 40,375 block reads; p99 1.4 s). No existing index starts with employee_id
-- (idx_attendance_events_entry = timesheet_entry_id,id · idx_attendance_events_entity = legal_entity_id,work_date).
-- (employee_id, id) serves the filter AND the ORDER BY id DESC (backward scan), so no sort is needed.
CREATE INDEX idx_attendance_events_employee ON attendance_events (employee_id, id);
