-- 0003_integrity_triggers.sql — DB-M1
-- The 30 A3 SQLite integrity triggers, re-implemented natively. SQLite allowed
-- subqueries in the trigger WHEN clause; PostgreSQL does not, so each condition
-- lives inside its plpgsql function. `IS NOT` -> IS DISTINCT FROM, IFNULL -> COALESCE.
-- Messages are byte-identical to SQLite's RAISE(ABORT) text: the application
-- matches on them. SQLSTATE KH001 marks "KAHE integrity rule".
CREATE FUNCTION trg_lock_active_addon_terms_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.status = 'ACTIVE' AND (NEW.delivery_mode != OLD.delivery_mode OR NEW.rate_sen IS DISTINCT FROM OLD.rate_sen OR NEW.cost_bearer != OLD.cost_bearer OR NEW.billing_treatment != OLD.billing_treatment OR NEW.client_billable != OLD.client_billable OR NEW.quantity_basis != OLD.quantity_basis OR NEW.employee_entitlement != OLD.employee_entitlement OR NEW.effective_from != OLD.effective_from)) THEN
    RAISE EXCEPTION 'ADDON_ACTIVE: an active add-on version is immutable; create a new version instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_active_addon_terms BEFORE UPDATE ON worker_service_addons
  FOR EACH ROW EXECUTE FUNCTION trg_lock_active_addon_terms_fn();

CREATE FUNCTION trg_lock_active_rate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.status = 'ACTIVE' AND (NEW.rate_sen IS DISTINCT FROM OLD.rate_sen OR NEW.pricing_model != OLD.pricing_model OR NEW.quantity_source != OLD.quantity_source OR NEW.unit_of_measure != OLD.unit_of_measure OR NEW.effective_from != OLD.effective_from)) THEN
    RAISE EXCEPTION 'RATE_ACTIVE: an active rate version is immutable; create a new version instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_active_rate BEFORE UPDATE ON billing_rate_cards
  FOR EACH ROW EXECUTE FUNCTION trg_lock_active_rate_fn();

CREATE FUNCTION trg_lock_calculated_billing_line_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM billing_runs WHERE id = OLD.billing_run_id) = 'CALCULATED') THEN
    RAISE EXCEPTION 'BILLING_CALCULATED: a calculated billing line is immutable; create a new run' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_calculated_billing_line BEFORE UPDATE ON billing_lines
  FOR EACH ROW EXECUTE FUNCTION trg_lock_calculated_billing_line_fn();

CREATE FUNCTION trg_lock_calculated_billing_line_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM billing_runs WHERE id = OLD.billing_run_id) = 'CALCULATED') THEN
    RAISE EXCEPTION 'BILLING_CALCULATED: a calculated billing line cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_calculated_billing_line_delete BEFORE DELETE ON billing_lines
  FOR EACH ROW EXECUTE FUNCTION trg_lock_calculated_billing_line_delete_fn();

CREATE FUNCTION trg_lock_finalized_run_line_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_runs WHERE id = OLD.payroll_run_id) = 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: payroll_run_lines is immutable once the run is FINALIZED' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_run_line_update BEFORE UPDATE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_run_line_update_fn();

CREATE FUNCTION trg_lock_finalized_run_line_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_runs WHERE id = OLD.payroll_run_id) = 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: payroll_run_lines cannot be deleted once the run is FINALIZED' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_run_line_delete BEFORE DELETE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_run_line_delete_fn();

CREATE FUNCTION trg_lock_finalized_component_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT r.status FROM payroll_runs r JOIN payroll_run_lines l ON l.payroll_run_id = r.id WHERE l.id = OLD.payroll_run_line_id) = 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: component breakdown is immutable once the run is FINALIZED' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_component_update BEFORE UPDATE ON payroll_run_line_components
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_component_update_fn();

CREATE FUNCTION trg_lock_finalized_component_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT r.status FROM payroll_runs r JOIN payroll_run_lines l ON l.payroll_run_id = r.id WHERE l.id = OLD.payroll_run_line_id) = 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: component breakdown cannot be deleted once the run is FINALIZED' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_component_delete BEFORE DELETE ON payroll_run_line_components
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_component_delete_fn();

CREATE FUNCTION trg_lock_finalized_snapshot_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id WHERE l.snapshot_id = OLD.id AND r.status = 'FINALIZED')) THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: snapshot is immutable once used by a FINALIZED run' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_snapshot_update BEFORE UPDATE ON payroll_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_snapshot_update_fn();

CREATE FUNCTION trg_lock_finalized_snapshot_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id WHERE l.snapshot_id = OLD.id AND r.status = 'FINALIZED')) THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: snapshot cannot be deleted once used by a FINALIZED run' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_snapshot_delete BEFORE DELETE ON payroll_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_snapshot_delete_fn();

CREATE FUNCTION trg_lock_finalized_run_status_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.status = 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYROLL_FINALIZED: a finalized run cannot change status; create a correction run instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_finalized_run_status BEFORE UPDATE OF status ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION trg_lock_finalized_run_status_fn();

CREATE FUNCTION trg_lock_payslip_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'PAYSLIP_IMMUTABLE: a payslip cannot be modified; issue a correction run instead' USING ERRCODE = 'KH001';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_payslip_update BEFORE UPDATE ON payroll_payslips
  FOR EACH ROW EXECUTE FUNCTION trg_lock_payslip_update_fn();

CREATE FUNCTION trg_lock_payslip_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'PAYSLIP_IMMUTABLE: a payslip cannot be deleted' USING ERRCODE = 'KH001';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_payslip_delete BEFORE DELETE ON payroll_payslips
  FOR EACH ROW EXECUTE FUNCTION trg_lock_payslip_delete_fn();

CREATE FUNCTION trg_lock_applied_adjustment_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.status = 'APPLIED' AND (NEW.amount_sen != OLD.amount_sen OR NEW.direction != OLD.direction OR NEW.component_code != OLD.component_code OR NEW.adjustment_type != OLD.adjustment_type OR NEW.employee_id != OLD.employee_id OR NEW.source_run_id != OLD.source_run_id)) THEN
    RAISE EXCEPTION 'ADJUSTMENT_APPLIED: an applied adjustment is immutable; issue a new adjustment instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_applied_adjustment BEFORE UPDATE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION trg_lock_applied_adjustment_fn();

CREATE FUNCTION trg_lock_applied_adjustment_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.status = 'APPLIED') THEN
    RAISE EXCEPTION 'ADJUSTMENT_APPLIED: an applied adjustment cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_applied_adjustment_delete BEFORE DELETE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION trg_lock_applied_adjustment_delete_fn();

CREATE FUNCTION trg_lock_exported_payment_item_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_payment_batches WHERE id = OLD.batch_id) IN ('EXPORTED','SUBMITTED','PAID','PARTIALLY_PAID') AND (NEW.amount_sen != OLD.amount_sen OR COALESCE(NEW.bank_account_no,'') != COALESCE(OLD.bank_account_no,'') OR COALESCE(NEW.bank_name,'') != COALESCE(OLD.bank_name,'') OR COALESCE(NEW.bank_account_name,'') != COALESCE(OLD.bank_account_name,'') OR NEW.employee_id != OLD.employee_id)) THEN
    RAISE EXCEPTION 'PAYMENT_EXPORTED: amount and bank details are immutable once exported; create a retry instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_lock_exported_payment_item BEFORE UPDATE ON payroll_payment_items
  FOR EACH ROW EXECUTE FUNCTION trg_lock_exported_payment_item_fn();

CREATE FUNCTION trg_lock_exported_payment_item_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_payment_batches WHERE id = OLD.batch_id) IN ('EXPORTED','SUBMITTED','PAID','PARTIALLY_PAID')) THEN
    RAISE EXCEPTION 'PAYMENT_EXPORTED: an exported payment instruction cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_lock_exported_payment_item_delete BEFORE DELETE ON payroll_payment_items
  FOR EACH ROW EXECUTE FUNCTION trg_lock_exported_payment_item_delete_fn();

CREATE FUNCTION trg_adjustment_requires_finalized_source_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_runs WHERE id = NEW.source_run_id) != 'FINALIZED') THEN
    RAISE EXCEPTION 'ADJUSTMENT_SOURCE_NOT_FINALIZED: adjustments can only correct a FINALIZED payroll run' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_adjustment_requires_finalized_source BEFORE INSERT ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION trg_adjustment_requires_finalized_source_fn();

CREATE FUNCTION trg_payslip_requires_finalized_run_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT status FROM payroll_runs WHERE id = NEW.payroll_run_id) != 'FINALIZED') THEN
    RAISE EXCEPTION 'PAYSLIP_RUN_NOT_FINALIZED: payslips can only be generated from a FINALIZED payroll run' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_payslip_requires_finalized_run BEFORE INSERT ON payroll_payslips
  FOR EACH ROW EXECUTE FUNCTION trg_payslip_requires_finalized_run_fn();

CREATE FUNCTION trg_attendance_events_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ATTENDANCE_EVENT_IMMUTABLE: attendance audit events are append-only' USING ERRCODE = 'KH001';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_attendance_events_no_update BEFORE UPDATE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_events_no_update_fn();

CREATE FUNCTION trg_attendance_events_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ATTENDANCE_EVENT_IMMUTABLE: attendance audit events are append-only' USING ERRCODE = 'KH001';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_attendance_events_no_delete BEFORE DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_events_no_delete_fn();

CREATE FUNCTION trg_attendance_frozen_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((EXISTS ( SELECT 1 FROM payroll_input_snapshots s JOIN payroll_periods p ON p.id = s.payroll_period_id WHERE s.employee_id = OLD.employee_id AND s.status = 'FROZEN' AND p.period_start <= OLD.work_date AND p.period_end >= OLD.work_date) OR EXISTS ( SELECT 1 FROM payroll_input_snapshots s JOIN payroll_periods p ON p.id = s.payroll_period_id WHERE s.employee_id = NEW.employee_id AND s.status = 'FROZEN' AND p.period_start <= NEW.work_date AND p.period_end >= NEW.work_date)) AND (NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.shift IS DISTINCT FROM OLD.shift OR NEW.clock_in IS DISTINCT FROM OLD.clock_in OR NEW.clock_out IS DISTINCT FROM OLD.clock_out OR NEW.work_hours IS DISTINCT FROM OLD.work_hours OR NEW.work_minutes IS DISTINCT FROM OLD.work_minutes OR NEW.attendance_status IS DISTINCT FROM OLD.attendance_status OR NEW.overtime_status IS DISTINCT FROM OLD.overtime_status OR NEW.overtime_minutes_requested IS DISTINCT FROM OLD.overtime_minutes_requested OR NEW.overtime_minutes_approved IS DISTINCT FROM OLD.overtime_minutes_approved OR NEW.overtime_hours_requested IS DISTINCT FROM OLD.overtime_hours_requested OR NEW.overtime_hours_approved IS DISTINCT FROM OLD.overtime_hours_approved OR NEW.day_type IS DISTINCT FROM OLD.day_type OR NEW.day_type_source IS DISTINCT FROM OLD.day_type_source)) THEN
    RAISE EXCEPTION 'ATTENDANCE_SOURCE_FROZEN: attendance consumed by a frozen payroll snapshot cannot change' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_attendance_frozen_update BEFORE UPDATE ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_frozen_update_fn();

CREATE FUNCTION trg_attendance_frozen_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS ( SELECT 1 FROM payroll_input_snapshots s JOIN payroll_periods p ON p.id = s.payroll_period_id WHERE s.employee_id = OLD.employee_id AND s.status = 'FROZEN' AND p.period_start <= OLD.work_date AND p.period_end >= OLD.work_date)) THEN
    RAISE EXCEPTION 'ATTENDANCE_SOURCE_FROZEN: attendance consumed by a frozen payroll snapshot cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_attendance_frozen_delete BEFORE DELETE ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_frozen_delete_fn();

CREATE FUNCTION trg_attendance_frozen_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS ( SELECT 1 FROM payroll_input_snapshots s JOIN payroll_periods p ON p.id = s.payroll_period_id WHERE s.employee_id = NEW.employee_id AND s.status = 'FROZEN' AND p.period_start <= NEW.work_date AND p.period_end >= NEW.work_date)) THEN
    RAISE EXCEPTION 'ATTENDANCE_SOURCE_FROZEN: cannot add attendance to a frozen payroll snapshot' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_attendance_frozen_insert BEFORE INSERT ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_frozen_insert_fn();

CREATE FUNCTION trg_work_schedule_used_is_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM timesheet_entries t WHERE t.work_schedule_id = OLD.id) AND (NEW.clock_in IS DISTINCT FROM OLD.clock_in OR NEW.clock_out IS DISTINCT FROM OLD.clock_out OR NEW.standard_work_minutes IS DISTINCT FROM OLD.standard_work_minutes OR NEW.cross_midnight IS DISTINCT FROM OLD.cross_midnight OR NEW.overtime_eligibility_rule IS DISTINCT FROM OLD.overtime_eligibility_rule OR NEW.overtime_delay_minutes IS DISTINCT FROM OLD.overtime_delay_minutes OR NEW.overtime_eligible_from IS DISTINCT FROM OLD.overtime_eligible_from OR NEW.effective_from IS DISTINCT FROM OLD.effective_from)) THEN
    RAISE EXCEPTION 'SCHEDULE_VERSION_IN_USE: this schedule version is referenced by attendance; create a new version instead' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_work_schedule_used_is_immutable BEFORE UPDATE ON work_schedules
  FOR EACH ROW EXECUTE FUNCTION trg_work_schedule_used_is_immutable_fn();

CREATE FUNCTION trg_work_schedule_break_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM timesheet_entries t WHERE t.work_schedule_id = OLD.work_schedule_id) AND (NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes OR NEW.is_paid IS DISTINCT FROM OLD.is_paid OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.end_time IS DISTINCT FROM OLD.end_time)) THEN
    RAISE EXCEPTION 'SCHEDULE_VERSION_IN_USE: breaks of a schedule already used by attendance are immutable' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_work_schedule_break_immutable BEFORE UPDATE ON work_schedule_breaks
  FOR EACH ROW EXECUTE FUNCTION trg_work_schedule_break_immutable_fn();

CREATE FUNCTION trg_correction_actions_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: approval history cannot be modified' USING ERRCODE = 'KH001';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_correction_actions_no_update BEFORE UPDATE ON attendance_correction_actions
  FOR EACH ROW EXECUTE FUNCTION trg_correction_actions_no_update_fn();

CREATE FUNCTION trg_correction_actions_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: approval history cannot be deleted' USING ERRCODE = 'KH001';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_correction_actions_no_delete BEFORE DELETE ON attendance_correction_actions
  FOR EACH ROW EXECUTE FUNCTION trg_correction_actions_no_delete_fn();

CREATE FUNCTION trg_entry_versions_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: an attendance version snapshot cannot be modified' USING ERRCODE = 'KH001';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER trg_entry_versions_no_update BEFORE UPDATE OF payload, version_no, version_type, correction_id, created_at ON attendance_entry_versions
  FOR EACH ROW EXECUTE FUNCTION trg_entry_versions_no_update_fn();

CREATE FUNCTION trg_entry_versions_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: an attendance version snapshot cannot be deleted' USING ERRCODE = 'KH001';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER trg_entry_versions_no_delete BEFORE DELETE ON attendance_entry_versions
  FOR EACH ROW EXECUTE FUNCTION trg_entry_versions_no_delete_fn();

-- Defence in depth: TRUNCATE bypasses row triggers. The runtime role is never
-- granted TRUNCATE; these guards also stop an owner-level accident.
CREATE FUNCTION kahe_no_truncate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: % cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'KH001';
END
$fn$;
CREATE TRIGGER trg_attendance_events_no_truncate BEFORE TRUNCATE ON attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_no_truncate_fn();
CREATE TRIGGER trg_correction_actions_no_truncate BEFORE TRUNCATE ON attendance_correction_actions
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_no_truncate_fn();
CREATE TRIGGER trg_entry_versions_no_truncate BEFORE TRUNCATE ON attendance_entry_versions
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_no_truncate_fn();
CREATE TRIGGER trg_payslips_no_truncate BEFORE TRUNCATE ON payroll_payslips
  FOR EACH STATEMENT EXECUTE FUNCTION kahe_no_truncate_fn();
