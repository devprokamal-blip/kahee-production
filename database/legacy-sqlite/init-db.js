// database/init-db.js
// Creates (idempotently) the SQLite schema for auth, RBAC, and project scope.
// Database file is intentionally kept OUTSIDE /public.
//
// Uses Node's BUILT-IN `node:sqlite` module (DatabaseSync) — ships inside the
// Node.js runtime itself, so there is no native addon to install, no
// node-gyp, no Visual Studio Build Tools / Python / C++ compiler required on
// Windows. Requires Node.js >= 22.5 (this project targets Node 24).
// Node currently flags this module experimental and prints a one-line
// warning to stderr at first use — that is expected and harmless.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// KAHE360_DB_PATH lets the attendance API regression suite start the REAL
// server against a throwaway database. Unset in normal use.
const DB_PATH = process.env.KAHE360_DB_PATH || path.join(__dirname, 'kahe360.db');

// Phase 0B / N2 — write-contention policy.
//
// busy_timeout was 0, so a second writer failed IMMEDIATELY with
// SQLITE_BUSY instead of waiting. With small, rare writes that was nearly
// invisible; a payroll run holding a write transaction would have made every
// concurrent timesheet save fail outright.
//
// Two layers, deliberately:
//   1. BUSY_TIMEOUT_MS — SQLite itself waits for a lock to clear. Handles the
//      common case (another writer finishing) without any application code.
//   2. withRetry() — a BOUNDED application-level retry for the cases SQLite's
//      own wait cannot cover (notably SQLITE_BUSY_SNAPSHOT under WAL, where
//      the transaction must be restarted, not merely waited on).
// Never an unbounded retry: a permanently-held lock must surface as a clean,
// explainable failure rather than a request that hangs forever.
const BUSY_TIMEOUT_MS = 5000;
const MAX_WRITE_ATTEMPTS = 4;        // 1 initial + 3 retries
const RETRY_BASE_DELAY_MS = 25;      // 25 / 50 / 100 ms, exponential

function getDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

/** Is this error a transient lock contention worth retrying? */
function isRetryableLockError(err) {
  const message = String(err && err.message);
  const code = String(err && err.code);
  return message.includes('SQLITE_BUSY')
    || message.includes('database is locked')
    || message.includes('database table is locked')
    || code === 'SQLITE_BUSY';
}

/** Synchronous sleep. node:sqlite is sync, so the retry backoff must be too. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` with a BOUNDED retry on lock contention.
 *
 * `fn` must be idempotent-on-retry: it is re-executed from the start, so it
 * has to be the whole unit of work (normally a withTransaction call), never a
 * fragment of one. Retrying half a transaction would be how partial financial
 * state gets created — the exact failure Phase 0 closed.
 *
 * After MAX_WRITE_ATTEMPTS the original error is re-thrown with context, so
 * the caller fails cleanly and the global handler can turn it into a 409/503
 * rather than an unexplained 500.
 */
function withRetry(fn, { maxAttempts = MAX_WRITE_ATTEMPTS, label = 'write' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return fn(attempt);
    } catch (err) {
      if (!isRetryableLockError(err)) throw err;   // not contention: fail fast
      lastError = err;
      if (attempt === maxAttempts) break;
      sleepSync(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  const exhausted = new Error(
    `Database sedang sibuk dan tidak bisa diakses setelah ${maxAttempts} percobaan (${label}). ` +
    `Coba lagi sesaat lagi. Penyebab asal: ${lastError && lastError.message}`
  );
  exhausted.code = 'SQLITE_BUSY_EXHAUSTED';
  exhausted.cause = lastError;
  throw exhausted;
}

/**
 * Phase 0 / B4 — atomic multi-statement writes.
 *
 * WHY: before this, no route in the codebase used a transaction. Operations
 * that write several rows (activating a rule set supersedes the old one AND
 * flips the new one; creating a rule set inserts 130+ bracket/multiplier rows;
 * superseding a payroll assignment closes one row and opens another) could
 * fail halfway and leave the database in a state the application believes is
 * impossible — e.g. zero active rule sets, or an employee with no open
 * assignment. For payroll that is an unacceptable partial financial state.
 *
 * Usage:
 *   const result = withTransaction(db, () => {
 *     db.prepare(...).run(...);
 *     db.prepare(...).run(...);
 *     return something;
 *   });
 * Any throw inside fn rolls back every statement and re-throws.
 *
 * Nested calls are safe: an inner withTransaction joins the outer one
 * (SQLite does not support true nested transactions, so the inner call
 * becomes a no-op wrapper and the outer boundary governs commit/rollback).
 */
function withTransaction(db, fn) {
  const alreadyInTransaction = db.isTransaction === true
    || (typeof db.isTransaction === 'undefined' && db.__kaheInTransaction === true);

  if (alreadyInTransaction) return fn();

  db.exec('BEGIN');
  db.__kaheInTransaction = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      // Surface the original failure, not the rollback failure, but don't
      // swallow the rollback problem entirely — it indicates a broken handle.
      console.error('[db] ROLLBACK failed after error:', rollbackErr.message);
    }
    throw err;
  } finally {
    db.__kaheInTransaction = false;
  }
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      action TEXT NOT NULL DEFAULT 'VIEW', -- VIEW, CREATE, EDIT, APPROVE, REJECT, EXPORT, ADMIN
      PRIMARY KEY (role_id, permission_id, action)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
    );

    -- ============================================================
    -- Phase 2I — Legal Entity Read Scope / Tenant Isolation (Domain 16)
    --
    -- The end-to-end audit found that DATA was isolated by legal entity
    -- everywhere, but READ ACCESS was not: any holder of payroll_run:VIEW
    -- could read any entity's payroll. For a model where KAHE processes
    -- subcontractor payroll, that is a confidentiality gap.
    --
    -- POLICY (locked):
    --   * A VIEW permission alone NEVER grants cross-entity visibility.
    --   * Access requires an explicit row here, for every role including
    --     Operations Director. There is no implicit "sees everything".
    --   * The only bypass is the payroll_entity_override permission module,
    --     granted to NO role by default and audited on every use.
    --   * A direct-ID request for another entity's record returns 404, not
    --     403 — confirming that an id exists is itself a disclosure. See
    --     lib/entityScope.js.
    -- ============================================================
    -- ============================================================
    -- Phase 3A — Add-on Benefit / Worker Service Model (Domain 17)
    --
    -- ARCHITECTURE LOCK: Transport, Meals and Accommodation are NOT mandatory
    -- payroll allowances. They are OPTIONAL, CONFIGURABLE worker services that
    -- may be delivered in several ways, only ONE of which is cash.
    --
    -- Three states are kept strictly distinct:
    --   CASH ALLOWANCE       — delivery_mode is a cash mode; this MAY become a
    --                          payroll salary component, and only then.
    --   BENEFIT / IN KIND    — shuttle, catering, mess, camp, hotel …
    --                          real cost, possibly billable, ZERO payroll impact.
    --   NOT PROVIDED         — no add-on at all. Creates NOTHING: not a payroll
    --                          component, not a zero-rupiah line, nothing.
    --
    -- Employee entitlement and client billability are INDEPENDENT axes. A
    -- client may refuse to reimburse something KAHE still pays for, and a
    -- client may provide something directly that never touches KAHE payroll.
    -- ============================================================

    -- Clients did not exist before Phase 3A. An add-on can be scoped to one,
    -- so the minimum model is introduced here. No billing logic lives here.
    CREATE TABLE IF NOT EXISTS clients (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      legal_entity_id   TEXT REFERENCES legal_entities(id),   -- the KAHE entity contracting with them
      npwp              TEXT,
      status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_by        TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clients_entity ON clients(legal_entity_id);

    CREATE TABLE IF NOT EXISTS worker_service_addons (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,

      addon_type            TEXT NOT NULL CHECK (addon_type IN ('TRANSPORT','MEALS','ACCOMMODATION')),
      enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),

      -- Validated against addon_type in lib/workerServiceAddon.js: a MEALS
      -- add-on cannot be delivered by SHUTTLE_SERVICE.
      delivery_mode         TEXT NOT NULL,

      -- Does the EMPLOYEE receive something? Independent of billing.
      employee_entitlement  TEXT NOT NULL DEFAULT 'ENTITLED'
                              CHECK (employee_entitlement IN ('ENTITLED','NOT_ENTITLED','OPTIONAL')),

      -- Is the CLIENT charged? Independent of who pays and of entitlement.
      client_billable       INTEGER NOT NULL DEFAULT 0 CHECK (client_billable IN (0,1)),
      -- Phase 3B: CONDITIONAL is a third real state (billable only once some
      -- condition is met, e.g. the client signs off the month's consumption).
      -- The integer above stays as the boolean projection so Phase 3A keeps
      -- its exact meaning.
      client_billable_mode  TEXT NOT NULL DEFAULT 'NO'
                              CHECK (client_billable_mode IN ('YES','NO','CONDITIONAL')),
      billable_condition    TEXT,
      cost_bearer           TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
                              CHECK (cost_bearer IN ('CLIENT','KAHE','SHARED','THIRD_PARTY','NOT_APPLICABLE')),
      cost_share_kahe_bp    INTEGER,                 -- basis points, only for SHARED
      billing_treatment     TEXT NOT NULL DEFAULT 'NON_BILLABLE'
                              CHECK (billing_treatment IN ('SEPARATE','BUNDLED','NON_BILLABLE')),

      -- How the quantity is counted when there IS a cost.
      quantity_basis        TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
                              CHECK (quantity_basis IN ('PER_WORKER_PER_DAY','PER_WORKER_PER_MONTH',
                                      'PER_WORKER_PER_TRIP','PER_ATTENDANCE_DAY','PER_HEADCOUNT','FLAT','NOT_APPLICABLE')),
      rate_sen              INTEGER CHECK (rate_sen IS NULL OR rate_sen >= 0),   -- integer sen, Phase 0 B3

      -- CASH ONLY: which payroll component this becomes. Required when the
      -- delivery mode is a cash mode, and forbidden otherwise — enforced in
      -- the library, because that is the rule this whole phase exists for.
      payroll_component_code TEXT,

      -- scope: most specific wins (project > client > legal entity)
      legal_entity_id       TEXT NOT NULL REFERENCES legal_entities(id),
      client_id             INTEGER REFERENCES clients(id),
      project_id            INTEGER REFERENCES projects(id),

      -- versioning & effective dating
      version               INTEGER NOT NULL DEFAULT 1,
      effective_from        TEXT NOT NULL,
      effective_to          TEXT,
      status                TEXT NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','CANCELLED')),

      note                  TEXT,
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      approved_by           TEXT,
      approved_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_addon_scope ON worker_service_addons(legal_entity_id, client_id, project_id, addon_type);
    CREATE INDEX IF NOT EXISTS idx_addon_effective ON worker_service_addons(addon_type, effective_from, effective_to);
    CREATE INDEX IF NOT EXISTS idx_addon_status ON worker_service_addons(status);

    -- One OPEN active configuration per (type, scope). A new version must
    -- close the previous one, exactly as payroll rule sets do — so "what
    -- applied in June" is always a single, unambiguous answer.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_addon_open_per_scope
      ON worker_service_addons(addon_type, legal_entity_id,
                               IFNULL(client_id,-1), IFNULL(project_id,-1))
      WHERE effective_to IS NULL AND status = 'ACTIVE';

    -- Full audit trail of every configuration change.
    CREATE TABLE IF NOT EXISTS worker_service_addon_audit (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      addon_id        INTEGER NOT NULL REFERENCES worker_service_addons(id) ON DELETE CASCADE,
      action          TEXT NOT NULL,        -- CREATED | APPROVED | SUPERSEDED | CANCELLED | UPDATED
      actor           TEXT NOT NULL,
      before_json     TEXT,
      after_json      TEXT,
      note            TEXT,
      occurred_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_addon_audit ON worker_service_addon_audit(addon_id, id);

    -- Once APPROVED and in force, the commercial terms of a version are
    -- immutable. Changing them means a NEW version — otherwise a finalized
    -- bill could be re-derived to a different number later.
    CREATE TRIGGER IF NOT EXISTS trg_lock_active_addon_terms
    BEFORE UPDATE ON worker_service_addons
    WHEN OLD.status = 'ACTIVE'
      AND (NEW.delivery_mode != OLD.delivery_mode
        OR NEW.rate_sen IS NOT OLD.rate_sen
        OR NEW.cost_bearer != OLD.cost_bearer
        OR NEW.billing_treatment != OLD.billing_treatment
        OR NEW.client_billable != OLD.client_billable
        OR NEW.quantity_basis != OLD.quantity_basis
        OR NEW.employee_entitlement != OLD.employee_entitlement
        OR NEW.effective_from != OLD.effective_from)
    BEGIN
      SELECT RAISE(ABORT, 'ADDON_ACTIVE: an active add-on version is immutable; create a new version instead');
    END;

    -- Phase 3B additive column: Phase 3A modelled billability as a boolean.
    -- CONDITIONAL is a third real state (billable only if some condition is
    -- met, e.g. the client approves the month's consumption). The integer is
    -- kept as the boolean projection so nothing in 3A changes meaning.
    -- Populated by database/migrate-phase3b.js for existing rows.

    -- ============================================================
    -- Phase 3B — Client Billing Quantity & Calculation (Domain 18)
    --
    -- SEPARATION OF CONCERNS, deliberately:
    --   Phase 3A worker_service_addons  = WHAT is provided, and the commercial
    --                                     posture (billable / bearer / treatment).
    --   Phase 3B billing_rate_cards     = HOW it is priced: pricing model,
    --                                     quantity source, unit, rate, versioned.
    --   Phase 3B billing_quantities     = HOW MUCH was actually consumed,
    --                                     verified, with provenance.
    --   Phase 3B billing_runs/_lines    = a DRAFT statement. Not an invoice.
    --
    -- Splitting rate from add-on means a price change is a new rate version
    -- and never touches the service configuration, and a service can exist
    -- with no rate at all (NOT_CONFIGURED is a legitimate state).
    --
    -- BILLING NEVER RECALCULATES OR MUTATES PAYROLL. It may READ finalized
    -- payroll when explicitly configured as a billable basis.
    -- ============================================================

    CREATE TABLE IF NOT EXISTS billing_rate_cards (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,

      addon_type            TEXT NOT NULL CHECK (addon_type IN ('TRANSPORT','MEALS','ACCOMMODATION','PAYROLL_COST','SERVICE_FEE')),
      -- MEALS only: which meal this rate prices. NULL for the other types.
      meal_type             TEXT,

      -- Pricing model and quantity source are validated per addon_type in
      -- lib/billingRate.js — NOT every model uses quantity x rate, so a fixed
      -- monthly or package price must never be forced to invent a quantity.
      pricing_model         TEXT NOT NULL,
      quantity_source       TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
      unit_of_measure       TEXT NOT NULL DEFAULT 'UNIT',

      -- Integer sen (Phase 0 B3). NULL is legitimate: NOT_CONFIGURED.
      rate_sen              INTEGER CHECK (rate_sen IS NULL OR rate_sen >= 0),
      rate_status           TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
                              CHECK (rate_status IN ('NOT_CONFIGURED','CONFIGURED')),

      -- PAYROLL_COST only: which finalized payroll figure is billable.
      payroll_basis         TEXT,

      legal_entity_id       TEXT NOT NULL REFERENCES legal_entities(id),
      client_id             INTEGER REFERENCES clients(id),
      project_id            INTEGER REFERENCES projects(id),

      version               INTEGER NOT NULL DEFAULT 1,
      effective_from        TEXT NOT NULL,
      effective_to          TEXT,
      status                TEXT NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','CANCELLED')),
      note                  TEXT,
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      approved_by           TEXT,
      approved_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rate_scope ON billing_rate_cards(addon_type, legal_entity_id, client_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_rate_effective ON billing_rate_cards(effective_from, effective_to);

    -- One open ACTIVE rate per (type, meal_type, scope). A new price is a new
    -- version that closes the previous one — June forever resolves June's rate.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_open_per_scope
      ON billing_rate_cards(addon_type, IFNULL(meal_type,'-'), legal_entity_id,
                            IFNULL(client_id,-1), IFNULL(project_id,-1))
      WHERE effective_to IS NULL AND status = 'ACTIVE';

    -- An ACTIVE rate version is commercially immutable. Changing a price means
    -- a NEW version, or a frozen billing line could be re-derived differently.
    CREATE TRIGGER IF NOT EXISTS trg_lock_active_rate
    BEFORE UPDATE ON billing_rate_cards
    WHEN OLD.status = 'ACTIVE'
      AND (NEW.rate_sen IS NOT OLD.rate_sen
        OR NEW.pricing_model != OLD.pricing_model
        OR NEW.quantity_source != OLD.quantity_source
        OR NEW.unit_of_measure != OLD.unit_of_measure
        OR NEW.effective_from != OLD.effective_from)
    BEGIN
      SELECT RAISE(ABORT, 'RATE_ACTIVE: an active rate version is immutable; create a new version instead');
    END;

    -- Which meals are on the plan, per period. Enabling breakfast in July must
    -- not change what June was billed, so this is versioned too.
    CREATE TABLE IF NOT EXISTS meal_plan_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_type             TEXT NOT NULL,
      enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      planned_entitlement   TEXT NOT NULL DEFAULT 'ENTITLED'
                              CHECK (planned_entitlement IN ('ENTITLED','NOT_ENTITLED','OPTIONAL')),
      max_per_worker_per_day INTEGER,           -- NULL = not capped
      note                  TEXT,

      legal_entity_id       TEXT NOT NULL REFERENCES legal_entities(id),
      client_id             INTEGER REFERENCES clients(id),
      project_id            INTEGER REFERENCES projects(id),

      version               INTEGER NOT NULL DEFAULT 1,
      effective_from        TEXT NOT NULL,
      effective_to          TEXT,
      status                TEXT NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','CANCELLED')),
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      approved_by           TEXT,
      approved_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meal_plan_scope ON meal_plan_items(legal_entity_id, client_id, project_id, meal_type);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_plan_open_per_scope
      ON meal_plan_items(meal_type, legal_entity_id, IFNULL(client_id,-1), IFNULL(project_id,-1))
      WHERE effective_to IS NULL AND status = 'ACTIVE';

    -- ============================================================
    -- VERIFIED QUANTITY
    --
    -- Attendance is NEVER assumed to be consumption. A worker present for 26
    -- days did not necessarily eat 26 lunches or take 26 shuttle trips. Every
    -- quantity carries its SOURCE and its VERIFICATION, so a billed figure can
    -- always be traced to who stood behind it.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS billing_quantities (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,

      legal_entity_id       TEXT NOT NULL REFERENCES legal_entities(id),
      client_id             INTEGER REFERENCES clients(id),
      project_id            INTEGER REFERENCES projects(id),
      addon_id              INTEGER REFERENCES worker_service_addons(id),
      addon_type            TEXT NOT NULL CHECK (addon_type IN ('TRANSPORT','MEALS','ACCOMMODATION')),
      meal_type             TEXT,

      billing_period        TEXT NOT NULL,        -- 'YYYY-MM'
      employee_id           TEXT REFERENCES employees(id),   -- NULL for pooled quantities
      service_date          TEXT,                 -- a single day, when applicable
      service_period_start  TEXT,
      service_period_end    TEXT,

      quantity_source       TEXT NOT NULL,
      quantity              INTEGER NOT NULL,     -- integer; fractional units are modelled by unit choice
      unit_of_measure       TEXT NOT NULL,
      source_reference      TEXT,                 -- catering slip, trip manifest, external id …

      verification_status   TEXT NOT NULL DEFAULT 'UNVERIFIED'
                              CHECK (verification_status IN ('UNVERIFIED','VERIFIED','REJECTED','SUPERSEDED')),
      verified_by           TEXT,
      verified_at           TEXT,
      rejection_reason      TEXT,

      -- Corrections never edit: a new version supersedes the old one, and the
      -- reason is mandatory.
      version               INTEGER NOT NULL DEFAULT 1,
      corrects_quantity_id  INTEGER REFERENCES billing_quantities(id),
      adjustment_reason     TEXT,
      is_adjustment         INTEGER NOT NULL DEFAULT 0 CHECK (is_adjustment IN (0,1)),

      -- Future mobility references. Recorded, never acted on: Phase 3B builds
      -- no fleet or dispatch management.
      route_id              TEXT,
      vehicle_id            TEXT,
      vehicle_type          TEXT,
      shift_id              TEXT,
      pickup_point          TEXT,
      drop_point            TEXT,
      trip_reference        TEXT,
      operator_reference    TEXT,

      billed_in_run_id      INTEGER,              -- set once consumed by a billing run
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qty_scope ON billing_quantities(legal_entity_id, client_id, project_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_qty_type ON billing_quantities(addon_type, billing_period, verification_status);
    CREATE INDEX IF NOT EXISTS idx_qty_employee ON billing_quantities(employee_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_qty_run ON billing_quantities(billed_in_run_id);

    -- DUPLICATE PREVENTION: the same service for the same worker on the same
    -- day from the same source cannot be captured twice while it is live.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_qty_live_per_service_day
      ON billing_quantities(addon_type, IFNULL(meal_type,'-'), legal_entity_id,
                            IFNULL(client_id,-1), IFNULL(project_id,-1),
                            IFNULL(employee_id,'-'), IFNULL(service_date,'-'), quantity_source)
      WHERE verification_status IN ('UNVERIFIED','VERIFIED') AND service_date IS NOT NULL;

    CREATE TABLE IF NOT EXISTS billing_quantity_audit (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      quantity_id     INTEGER NOT NULL REFERENCES billing_quantities(id) ON DELETE CASCADE,
      action          TEXT NOT NULL,
      actor           TEXT NOT NULL,
      before_json     TEXT,
      after_json      TEXT,
      note            TEXT,
      occurred_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qty_audit ON billing_quantity_audit(quantity_id, id);

    -- ============================================================
    -- DRAFT BILLING STATEMENT — explicitly not an invoice.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS billing_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_reference       TEXT NOT NULL UNIQUE,
      legal_entity_id     TEXT NOT NULL REFERENCES legal_entities(id),
      client_id           INTEGER NOT NULL REFERENCES clients(id),
      project_id          INTEGER REFERENCES projects(id),
      billing_period      TEXT NOT NULL,          -- 'YYYY-MM'
      run_number          INTEGER NOT NULL DEFAULT 1,

      status              TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','CALCULATED','CANCELLED')),

      total_amount_sen    INTEGER NOT NULL DEFAULT 0,
      line_count          INTEGER NOT NULL DEFAULT 0,
      calculation_timestamp TEXT,
      engine_version      TEXT,

      created_by          TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      cancelled_by        TEXT,
      cancelled_at        TEXT,
      cancel_reason       TEXT,

      UNIQUE (legal_entity_id, client_id, billing_period, run_number)
    );
    CREATE INDEX IF NOT EXISTS idx_billing_run_scope ON billing_runs(legal_entity_id, client_id, billing_period);

    CREATE TABLE IF NOT EXISTS billing_lines (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      billing_run_id        INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,

      legal_entity_id       TEXT NOT NULL,
      client_id             INTEGER NOT NULL,
      project_id            INTEGER,
      billing_period        TEXT NOT NULL,

      source_type           TEXT NOT NULL,        -- ADDON | PAYROLL_COST | SERVICE_FEE
      source_reference      TEXT,
      addon_type            TEXT NOT NULL,
      meal_type             TEXT,
      delivery_mode         TEXT,

      pricing_model         TEXT NOT NULL,
      quantity_source       TEXT,
      quantity              INTEGER,              -- NULL for models with no quantity
      unit_of_measure       TEXT,
      effective_rate_sen    INTEGER,
      amount_sen            INTEGER NOT NULL,     -- integer sen, always

      cost_bearer           TEXT NOT NULL,
      billing_treatment     TEXT NOT NULL,

      -- reproducibility: exactly which configuration produced this figure
      addon_config_version  INTEGER,
      addon_config_id       INTEGER,
      rate_version          INTEGER,
      rate_card_id          INTEGER,
      quantity_ids          TEXT,                 -- JSON array of billing_quantities.id
      verified_by           TEXT,
      calculation_note      TEXT,
      calculation_timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_line_run ON billing_lines(billing_run_id);
    CREATE INDEX IF NOT EXISTS idx_billing_line_type ON billing_lines(addon_type, billing_period);

    -- A CALCULATED run is frozen: later rate or configuration changes must not
    -- silently alter a statement that has already been produced.
    CREATE TRIGGER IF NOT EXISTS trg_lock_calculated_billing_line
    BEFORE UPDATE ON billing_lines
    WHEN (SELECT status FROM billing_runs WHERE id = OLD.billing_run_id) = 'CALCULATED'
    BEGIN
      SELECT RAISE(ABORT, 'BILLING_CALCULATED: a calculated billing line is immutable; create a new run');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_calculated_billing_line_delete
    BEFORE DELETE ON billing_lines
    WHEN (SELECT status FROM billing_runs WHERE id = OLD.billing_run_id) = 'CALCULATED'
    BEGIN
      SELECT RAISE(ABORT, 'BILLING_CALCULATED: a calculated billing line cannot be deleted');
    END;

    -- SERVICE FEE — optional, never hardcoded, and legitimately absent.
    -- A client with no row here is NOT_CONFIGURED, which is a valid state:
    -- billing must work without it rather than assume a default percentage.
    CREATE TABLE IF NOT EXISTS service_fee_config (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      legal_entity_id   TEXT NOT NULL REFERENCES legal_entities(id),
      client_id         INTEGER REFERENCES clients(id),
      project_id        INTEGER REFERENCES projects(id),

      fee_mode          TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
                          CHECK (fee_mode IN ('NOT_CONFIGURED','PERCENTAGE','FIXED_PER_WORKER','FIXED_PER_MONTH')),
      fee_rate_bp       INTEGER,            -- basis points, for PERCENTAGE
      fee_amount_sen    INTEGER,            -- integer sen, for the fixed modes
      fee_basis         TEXT,               -- what the percentage applies to; resolved in a later phase

      version           INTEGER NOT NULL DEFAULT 1,
      effective_from    TEXT NOT NULL,
      effective_to      TEXT,
      status            TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','CANCELLED')),
      note              TEXT,
      created_by        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      approved_by       TEXT,
      approved_at       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_service_fee_open_per_scope
      ON service_fee_config(legal_entity_id, IFNULL(client_id,-1), IFNULL(project_id,-1))
      WHERE effective_to IS NULL AND status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS user_legal_entity_scope (
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      legal_entity_id TEXT NOT NULL REFERENCES legal_entities(id),
      granted_by      TEXT,
      granted_at      TEXT DEFAULT (datetime('now')),
      note            TEXT,
      PRIMARY KEY (user_id, legal_entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_scope_user ON user_legal_entity_scope(user_id);
    CREATE INDEX IF NOT EXISTS idx_entity_scope_entity ON user_legal_entity_scope(legal_entity_id);

    -- Every cross-entity attempt is recorded: the denials, and the overrides
    -- that were allowed. This is the trail that shows whether the boundary is
    -- holding and who is stepping over it.
    CREATE TABLE IF NOT EXISTS entity_access_audit (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER,
      actor             TEXT NOT NULL,
      outcome           TEXT NOT NULL CHECK (outcome IN ('DENIED','OVERRIDE_ALLOWED')),
      resource_type     TEXT NOT NULL,     -- payroll_run | payslip | payment_batch | ...
      resource_id       TEXT,
      requested_entity  TEXT,              -- the entity the record belongs to
      authorized_scope  TEXT,              -- JSON array of the entities the user holds
      route             TEXT,
      occurred_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_audit_user ON entity_access_audit(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_entity_audit_outcome ON entity_access_audit(outcome, id);

    CREATE TABLE IF NOT EXISTS user_project_scope (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_code TEXT NOT NULL, -- 'ALL_PROJECTS' or a specific projects.code
      PRIMARY KEY (user_id, project_code)
    );

    CREATE TABLE IF NOT EXISTS audit_auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL, -- LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT
      email TEXT,
      user_id INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- express-session store lives in the "sessions" table, managed by
    -- middleware/sqliteSessionStore.js (same node:sqlite connection).

    -- ============================================================
    -- HRD & Kontrak module (added 2026-09-14)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS employees (
      id              TEXT PRIMARY KEY,            -- e.g. KAHE-2026-00123
      full_name       TEXT NOT NULL,
      nik             TEXT,
      photo_path      TEXT,
      birth_date      TEXT,
      gender          TEXT CHECK (gender IN ('L','P')),
      phone           TEXT,
      address         TEXT,

      worker_type     TEXT NOT NULL CHECK (worker_type IN ('internal','pkwt','harian','subkontraktor')),
      project_code    TEXT REFERENCES projects(code),
      position        TEXT,
      supervisor      TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      start_date      TEXT,
      termination_date TEXT,                       -- B6: last payable day; NULL = still employed

      bpjs_kesehatan_no TEXT,
      bpjs_tk_no        TEXT,

      -- Phase 2D: payment details. Validation raises a forward-looking
      -- WARNING when these are absent; they become a BLOCKING check at the
      -- payment stage (a later phase), not now.
      bank_name         TEXT,
      bank_account_no   TEXT,
      bank_account_name TEXT,

      -- worker_type = internal
      nip             TEXT,
      grade           TEXT,
      permanent_date  TEXT,

      -- worker_type = pkwt
      contract_no     TEXT,
      contract_start  TEXT,
      contract_end    TEXT,
      wage_scheme     TEXT,

      -- worker_type = harian
      daily_rate_sen  INTEGER,                     -- B3: integer sen (see lib/money.js)
      pay_cycle       TEXT CHECK (pay_cycle IS NULL OR pay_cycle IN ('mingguan','dua_mingguan','bulanan')),

      -- worker_type = subkontraktor
      partner_company TEXT,
      partner_npwp    TEXT,
      partner_pic     TEXT,
      pks_no          TEXT,
      work_scope      TEXT,
      worker_count    INTEGER,

      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_employees_worker_type ON employees(worker_type);
    CREATE INDEX IF NOT EXISTS idx_employees_project ON employees(project_code);
    CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
    CREATE INDEX IF NOT EXISTS idx_employees_contract_end ON employees(contract_end);

    -- Every extension/termination request is a new row, never overwritten.
    CREATE TABLE IF NOT EXISTS employee_contract_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      contract_no    TEXT,
      start_date     TEXT,
      end_date       TEXT,
      renewal_number INTEGER DEFAULT 0,
      action         TEXT NOT NULL CHECK (action IN ('new','extend','terminate')),
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      requested_by   TEXT,
      approved_by    TEXT,
      note           TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      decided_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_contract_history_employee ON employee_contract_history(employee_id);

    -- Uploaded documents (KTP, ijazah, sertifikat, dll). Files themselves live
    -- outside /public (see routes/hrd.js) and are streamed through a
    -- permission-checked route, not served as static assets.
    CREATE TABLE IF NOT EXISTS employee_documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      doc_type      TEXT NOT NULL CHECK (doc_type IN ('ktp','ijazah','sertifikat','lainnya')),
      doc_name      TEXT,
      file_path     TEXT NOT NULL,
      expiry_date   TEXT,
      uploaded_by   TEXT,
      uploaded_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_employee ON employee_documents(employee_id);
    CREATE INDEX IF NOT EXISTS idx_documents_expiry ON employee_documents(expiry_date);

    -- ============================================================
    -- Timesheet & Absensi module (added 2026-09-14)
    -- One row per employee per calendar day. Overtime is requested
    -- and approved inline on the same row (no separate history table --
    -- one decision per day is enough for this MVP).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date           TEXT NOT NULL,               -- YYYY-MM-DD
      workfront           TEXT,                        -- e.g. Main Civil, Piling, Mechanical
      shift               TEXT CHECK (shift IS NULL OR shift IN ('day','night')),
      clock_in            TEXT,                        -- HH:MM
      clock_out           TEXT,                        -- HH:MM
      -- Phase 0B / N1: canonical time is INTEGER MINUTES (see lib/time.js).
      -- The REAL columns below are retained read-only for backward
      -- compatibility and are NOT the source of truth for payroll.
      work_hours          REAL,
      work_minutes        INTEGER,
      attendance_status   TEXT NOT NULL DEFAULT 'present'
                            CHECK (attendance_status IN ('present','late','absent','leave','sick','no_show')),
      absence_reason      TEXT,                        -- only meaningful when status != present

      overtime_hours_requested REAL DEFAULT 0,
      overtime_hours_approved  REAL DEFAULT 0,
      overtime_minutes_requested INTEGER DEFAULT 0,
      overtime_minutes_approved  INTEGER DEFAULT 0,
      overtime_status          TEXT NOT NULL DEFAULT 'none'
                                 CHECK (overtime_status IN ('none','pending','approved','rejected')),
      overtime_requested_by    TEXT,
      overtime_approved_by     TEXT,
      overtime_decided_at      TEXT,

      -- Phase 1B / B2: day-classification SNAPSHOT.
      -- Written server-side at record time by lib/dayClassification.js and
      -- never accepted from the client (a user must not be able to pick a
      -- favourable day type, and therefore a favourable multiplier).
      -- Snapshotting means a later calendar correction cannot silently
      -- re-price overtime that has already been reviewed or paid.
      day_type            TEXT CHECK (day_type IS NULL OR day_type IN
                            ('WORKDAY','WEEKLY_REST_DAY','PUBLIC_HOLIDAY',
                             'COMPANY_HOLIDAY','SUBSTITUTED_HOLIDAY')),
      day_type_source     TEXT,                   -- why: 'work_pattern' | 'holiday:<id>' | ...
      day_type_calendar_id INTEGER,               -- calendar used at classification time
      day_type_pattern_id INTEGER,                -- work pattern used at classification time
      day_classified_at   TEXT,

      note                TEXT,
      recorded_by         TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now')),
      UNIQUE(employee_id, work_date)
    );

    CREATE INDEX IF NOT EXISTS idx_timesheet_date ON timesheet_entries(work_date);
    CREATE INDEX IF NOT EXISTS idx_timesheet_employee ON timesheet_entries(employee_id);
    CREATE INDEX IF NOT EXISTS idx_timesheet_overtime_status ON timesheet_entries(overtime_status);

    -- ============================================================
    -- Payroll Configuration foundation (added 2026-09-14)
    -- 8 modular domains, each its own table, all effective-dated.
    -- Every write goes through config_audit_log (see lib/configAudit.js).
    -- Nothing here is hardcoded in application code — the Payroll
    -- Calculation Engine (future module) reads these tables at run time.
    -- ============================================================

    -- Domain 1: Legal Entity Master
    -- jkk_risk_class is validated by CHECK, not a DB-level FK, because
    -- jkk_risk_classes rows are versioned (multiple rows share the same
    -- risk_class value over time) -- the current rate is resolved at
    -- calculation time by looking up the row whose effective_date/end_date
    -- window covers "now".
    CREATE TABLE IF NOT EXISTS legal_entities (
      id              TEXT PRIMARY KEY,          -- e.g. KAHE360, MITRA-JAYA
      name            TEXT NOT NULL,
      entity_type     TEXT NOT NULL CHECK (entity_type IN ('internal','subkontraktor')),
      npwp            TEXT,
      jkk_risk_class  TEXT NOT NULL CHECK (jkk_risk_class IN ('very_low','low','medium','high','very_high')),
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      effective_date  TEXT NOT NULL,
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Domain 2: JKK Risk Class rates (versioned; a class can be repriced
    -- over time without touching the legal_entities that reference it)
    CREATE TABLE IF NOT EXISTS jkk_risk_classes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      risk_class      TEXT NOT NULL CHECK (risk_class IN ('very_low','low','medium','high','very_high')),
      rate_bp         INTEGER NOT NULL,          -- B3: basis points, e.g. 24 = 0.24%
      effective_date  TEXT NOT NULL,
      end_date        TEXT,                      -- NULL = currently active
      source_note     TEXT,                      -- e.g. reference to the Kepmenaker decree
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jkk_risk_class_lookup ON jkk_risk_classes(risk_class, effective_date);

    -- Domain 3: Payroll Rule Set (BPJS %, salary caps, overtime hourly divisor)
    -- One row = one dated version of "the rules". Only one row may have
    -- end_date IS NULL per entity_type at a time (enforced in application code).
    CREATE TABLE IF NOT EXISTS payroll_rule_sets (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      name                        TEXT NOT NULL,
      status                      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
      effective_date              TEXT NOT NULL,
      end_date                    TEXT,
      -- B3: *_bp = integer basis points; *_sen = integer sen. See lib/money.js.
      bpjs_kesehatan_rate_employee_bp INTEGER NOT NULL,
      bpjs_kesehatan_rate_company_bp  INTEGER NOT NULL,
      bpjs_kesehatan_salary_cap_sen   INTEGER NOT NULL,
      jht_rate_employee_bp        INTEGER NOT NULL,
      jht_rate_company_bp          INTEGER NOT NULL,
      jp_rate_employee_bp         INTEGER NOT NULL,
      jp_rate_company_bp           INTEGER NOT NULL,
      jp_salary_cap_sen            INTEGER NOT NULL,
      jkm_rate_bp                 INTEGER NOT NULL,
      overtime_hourly_divisor      INTEGER NOT NULL DEFAULT 173,
      -- Phase 2D policy lock #2: whether overtime pay is taxable is
      -- CONFIGURATION on the versioned rule set, never hardcoded in the
      -- calculator. A regulation change is a new rule-set version.
      overtime_is_taxable          INTEGER NOT NULL DEFAULT 1 CHECK (overtime_is_taxable IN (0,1)),
      overtime_is_bpjs_base        INTEGER NOT NULL DEFAULT 0 CHECK (overtime_is_bpjs_base IN (0,1)),
      created_by                  TEXT,
      created_at                  TEXT DEFAULT (datetime('now'))
    );

    -- Domain 3b: PTKP / TER bracket table (~125 rows across A/B/C), tied to
    -- a specific rule_set version so a PMK update creates a new rule_set
    -- rather than mutating history.
    CREATE TABLE IF NOT EXISTS ptkp_ter_rates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_set_id   INTEGER NOT NULL REFERENCES payroll_rule_sets(id) ON DELETE CASCADE,
      category      TEXT NOT NULL CHECK (category IN ('A','B','C')),
      income_min_sen INTEGER NOT NULL,           -- B3: integer sen
      income_max_sen INTEGER,                    -- NULL = no upper bound
      rate_bp       INTEGER NOT NULL             -- B3: basis points
    );
    CREATE INDEX IF NOT EXISTS idx_ter_lookup ON ptkp_ter_rates(rule_set_id, category, income_min_sen);

    -- Domain 3c: Overtime multiplier table (PP 35/2021 Pasal 31), tied to a
    -- rule_set version. day_type distinguishes ordinary workdays from
    -- weekly-rest/public-holiday work under 5-day vs 6-day week patterns.
    CREATE TABLE IF NOT EXISTS overtime_multiplier_rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_set_id   INTEGER NOT NULL REFERENCES payroll_rule_sets(id) ON DELETE CASCADE,
      day_type      TEXT NOT NULL CHECK (day_type IN ('workday','rest_or_holiday_5day','rest_or_holiday_6day')),
      hour_from     INTEGER NOT NULL,             -- 1-based hour of overtime
      hour_to       INTEGER,                      -- NULL = unbounded
      multiplier_bp INTEGER NOT NULL           -- B3: 1/10000 scale, 1.5x = 15000
    );
    CREATE INDEX IF NOT EXISTS idx_overtime_multiplier_lookup ON overtime_multiplier_rules(rule_set_id, day_type, hour_from);

    -- Domain 4: Holiday calendar
    CREATE TABLE IF NOT EXISTS holidays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,
      name        TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'national' CHECK (scope IN ('national','project')),
      project_code TEXT,                          -- only meaningful when scope = 'project'
      -- Phase 1B: extensible classification. New kinds are added as data, not
      -- as code branches in the classifier.
      holiday_type TEXT NOT NULL DEFAULT 'PUBLIC_HOLIDAY'
                    CHECK (holiday_type IN ('PUBLIC_HOLIDAY','COMPANY_HOLIDAY','SUBSTITUTED_HOLIDAY')),
      work_calendar_id INTEGER REFERENCES work_calendars(id),  -- NULL = all calendars
      observed_for TEXT,                          -- SUBSTITUTED_HOLIDAY: date being substituted
      is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),  -- soft delete
      created_by  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(date, scope, project_code)
    );

    -- Domain 5: Work patterns (5-day vs 6-day week)
    CREATE TABLE IF NOT EXISTS work_patterns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      days_per_week   INTEGER NOT NULL CHECK (days_per_week IN (5, 6)),
      weekly_rest_day TEXT NOT NULL DEFAULT 'sunday',
      effective_date  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Domain 6: Employee <-> payroll configuration assignment
    -- One active row per employee (enforced in application code); history
    -- is kept by inserting a new row with a later effective_date rather
    -- than overwriting.
    CREATE TABLE IF NOT EXISTS employee_payroll_assignments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      legal_entity_id     TEXT NOT NULL REFERENCES legal_entities(id),
      work_pattern_id     INTEGER NOT NULL REFERENCES work_patterns(id),
      -- Phase 1B: explicit calendar. NULL falls back to entity-scoped, then
      -- global — resolution is in lib/dayClassification.js, never inline.
      work_calendar_id    INTEGER REFERENCES work_calendars(id),
      -- Phase 2A: payroll group membership. Deliberately a COLUMN on the
      -- already-effective-dated assignment rather than a separate
      -- membership table: it reuses the existing supersession flow and the
      -- uq_payroll_assignment_open_per_employee invariant, avoids a second
      -- source of truth about an employee's regime, and means 2,000 workers
      -- add 2,000 rows total, never rows-per-period.
      payroll_group_id    INTEGER REFERENCES payroll_groups(id),
      marital_status      TEXT NOT NULL CHECK (marital_status IN ('TK','K')),
      dependents_count    INTEGER NOT NULL DEFAULT 0 CHECK (dependents_count BETWEEN 0 AND 3),
      npwp                TEXT,
      base_salary_sen     INTEGER,                -- B3: integer sen (monthly gaji pokok + tunjangan tetap)
      effective_date      TEXT NOT NULL,
      end_date            TEXT,
      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_assignment_employee ON employee_payroll_assignments(employee_id, effective_date);

    -- Generic modular audit trail shared by all 8 domains above (and
    -- reusable by future config domains) — see lib/configAudit.js.
    CREATE TABLE IF NOT EXISTS config_audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      domain        TEXT NOT NULL,                -- e.g. 'legal_entity', 'payroll_rule_set'
      record_id     TEXT NOT NULL,
      action        TEXT NOT NULL CHECK (action IN ('create','update','delete')),
      changed_by    TEXT NOT NULL,
      changed_at    TEXT DEFAULT (datetime('now')),
      old_value     TEXT,                         -- JSON snapshot, NULL on create
      new_value     TEXT                          -- JSON snapshot, NULL on delete
    );
    CREATE INDEX IF NOT EXISTS idx_config_audit_domain ON config_audit_log(domain, record_id);

    -- ============================================================
    -- Phase 0 / B5 — invariants moved from application code into the
    -- database. Each of these was previously enforced only in a route
    -- handler and was demonstrably violable (see
    -- docs/PAYROLL_ENGINE_AUDIT.md section A #2, #5, #8).
    -- ============================================================

    -- At most ONE open payroll assignment per employee. Without this, the
    -- engine has no deterministic answer to "which assignment applies?".
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_assignment_open_per_employee
      ON employee_payroll_assignments(employee_id) WHERE end_date IS NULL;

    -- At most ONE active payroll rule set at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_rule_set_single_active
      ON payroll_rule_sets(status) WHERE status = 'active';

    -- At most ONE open rate version per JKK risk class.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_jkk_open_per_risk_class
      ON jkk_risk_classes(risk_class) WHERE end_date IS NULL;

    -- One national holiday per date. The table-level
    -- UNIQUE(date, scope, project_code) does NOT cover this: SQLite treats
    -- NULLs as distinct in a UNIQUE constraint, and project_code is NULL for
    -- every national row, so duplicates were accepted.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_national_per_date
      ON holidays(date) WHERE scope = 'national';

    -- ============================================================
    -- Phase 1A / B1 — Salary Components (Domain 7)
    --
    -- Replaces the dependency on a single undifferentiated
    -- employee_payroll_assignments.base_salary_sen. Every payroll input is
    -- now an explicit, classified, versioned component so the Calculation
    -- Engine can answer, per component: is it taxable? does it enter the
    -- BPJS base? the overtime base? is it prorated for a mid-month joiner?
    --
    -- Deliberately NOT hardcoded to Indonesian assumptions: taxability,
    -- BPJS inclusion, overtime inclusion and proration are per-component
    -- CONFIGURATION, not rules baked into code. A component that behaves
    -- differently under a future regulation is a data change, not a
    -- code change.
    -- ============================================================

    -- Domain 7a: Salary Component Master (the catalogue of what can be paid)
    CREATE TABLE IF NOT EXISTS salary_components (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT NOT NULL,              -- e.g. BASIC, ALLOW_SITE
      name                TEXT NOT NULL,

      -- classification
      component_type      TEXT NOT NULL CHECK (component_type IN ('earning','deduction')),
      calculation_type    TEXT NOT NULL CHECK (calculation_type IN ('fixed','variable')),
      -- Which side bears it. 'employee' = affects the worker's net pay.
      -- 'employer' = a company-borne cost (e.g. the employer share of a
      -- contribution) that must appear in cost reporting but never reduce net pay.
      paid_by             TEXT NOT NULL DEFAULT 'employee' CHECK (paid_by IN ('employee','employer')),

      -- behaviour flags consumed by the Calculation Engine (0/1)
      is_taxable          INTEGER NOT NULL DEFAULT 1 CHECK (is_taxable IN (0,1)),
      tax_rule_ref        TEXT,                       -- optional pointer to a specific tax treatment
      is_bpjs_base        INTEGER NOT NULL DEFAULT 0 CHECK (is_bpjs_base IN (0,1)),
      is_overtime_base    INTEGER NOT NULL DEFAULT 0 CHECK (is_overtime_base IN (0,1)),
      is_proratable       INTEGER NOT NULL DEFAULT 1 CHECK (is_proratable IN (0,1)),
      recurrence          TEXT NOT NULL DEFAULT 'recurring' CHECK (recurrence IN ('recurring','one_time')),

      -- scope: NULL legal_entity_id = available to every entity
      legal_entity_id     TEXT REFERENCES legal_entities(id),

      -- deterministic evaluation order; lower runs first
      calculation_order   INTEGER NOT NULL DEFAULT 100,

      -- versioning (same effective-dating discipline as every other domain)
      effective_from      TEXT NOT NULL,
      effective_to        TEXT,                       -- NULL = open/current
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),

      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_salary_component_lookup
      ON salary_components(code, effective_from);
    CREATE INDEX IF NOT EXISTS idx_salary_component_entity
      ON salary_components(legal_entity_id, status);

    -- One OPEN version per component code per entity scope. Two partial
    -- indexes are needed because SQLite treats NULLs as distinct, so a single
    -- index on (code, legal_entity_id) would not constrain the global-scope
    -- (NULL entity) rows — the same trap that let duplicate national holidays
    -- through before Phase 0.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_component_open_scoped
      ON salary_components(code, legal_entity_id)
      WHERE effective_to IS NULL AND legal_entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_component_open_global
      ON salary_components(code)
      WHERE effective_to IS NULL AND legal_entity_id IS NULL;

    -- Domain 7b: Employee Salary Structure — which components an employee
    -- actually has, at what amount, over which period.
    -- History is NEVER mutated: a mid-period change closes the current row
    -- (effective_to) and opens a new one, so a payroll already calculated for
    -- an earlier period still resolves the amount that applied THEN.
    CREATE TABLE IF NOT EXISTS employee_salary_components (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      component_id        INTEGER NOT NULL REFERENCES salary_components(id),
      -- B3: exact monetary representation, integer sen. Never REAL.
      amount_sen          INTEGER NOT NULL,
      effective_from      TEXT NOT NULL,
      effective_to        TEXT,                       -- NULL = open/current
      note                TEXT,
      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emp_salary_component_employee
      ON employee_salary_components(employee_id, effective_from);
    CREATE INDEX IF NOT EXISTS idx_emp_salary_component_component
      ON employee_salary_components(component_id);

    -- No duplicate ACTIVE assignment of the same component to one employee.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_salary_component_open
      ON employee_salary_components(employee_id, component_id)
      WHERE effective_to IS NULL;

    -- ============================================================
    -- Phase 1B / B2 — Work Calendar & Day Classification (Domain 8)
    --
    -- Makes every date deterministically classifiable so the Overtime Rule
    -- Engine never has to guess which multiplier band applies.
    --
    -- SEPARATION OF CONCERNS (locked): this domain decides WHAT KIND OF DAY
    -- a date is. It never decides what that day is worth. Multipliers stay
    -- in overtime_multiplier_rules (Domain 3c). No multiplier value may
    -- appear in this domain or in lib/dayClassification.js.
    -- ============================================================

    -- Domain 8a: Work Calendar — the calendar an employee follows.
    -- Resolution order (see lib/dayClassification.js): employee's payroll
    -- assignment -> its work_calendar_id -> else the calendar scoped to the
    -- employee's legal entity -> else the global calendar (all scopes NULL).
    CREATE TABLE IF NOT EXISTS work_calendars (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT NOT NULL,
      name            TEXT NOT NULL,
      legal_entity_id TEXT REFERENCES legal_entities(id),  -- NULL = any entity
      project_code    TEXT REFERENCES projects(code),      -- NULL = any project
      effective_from  TEXT NOT NULL,
      effective_to    TEXT,                                -- NULL = open/current
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_calendar_scope
      ON work_calendars(legal_entity_id, project_code, effective_from);
    -- One open calendar per code (NULL-safe: separate partial indexes, same
    -- reasoning as the salary-component and national-holiday indexes).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_calendar_open_code
      ON work_calendars(code) WHERE effective_to IS NULL;

    -- Domain 8b: Holiday Master extensions.
    -- The pre-Phase-1B holidays table is preserved as-is (scope,
    -- project_code and its UNIQUE constraint are untouched for backward
    -- compatibility); these columns are ADDED alongside.
    --   holiday_type    — extensible classification, not limited to statutory
    --   work_calendar_id— NULL = applies to every calendar
    --   observed_for    — for SUBSTITUTED_HOLIDAY: the date being substituted
    --   is_active       — soft delete, so a removed holiday stays auditable
    --                     and historical classification remains explainable

    -- Domain 8c: snapshot columns on timesheet_entries.
    -- Classification is recorded WITH the attendance row so a later calendar
    -- correction cannot silently re-price an overtime record that has already
    -- been reviewed or paid. These are added by the schema below for fresh
    -- databases and by database/migrate-phase1b.js for existing ones.

    CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);

    -- ============================================================
    -- Phase 2A — Payroll Group & Payroll Period (engine foundation)
    --
    -- SCOPE LOCK: this phase defines WHEN payroll happens and WHO is in which
    -- processing regime. It calculates nothing. No salary, BPJS, tax,
    -- overtime value, gross or net appears in this domain.
    --
    -- The period lifecycle here is deliberately SEPARATE from the future
    -- payroll-run calculation states (Draft/Calculated/Validated/Approved/
    -- Finalized/Paid, see docs/PAYROLL_ENGINE_REAUDIT.md). A period is a
    -- data-collection window; a run is one attempt to calculate from it.
    -- One period will own many runs over its life.
    -- ============================================================

    -- Domain 9a: Payroll Group — a processing regime.
    CREATE TABLE IF NOT EXISTS payroll_groups (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT NOT NULL,
      name                TEXT NOT NULL,

      -- scope. legal_entity_id is REQUIRED: payroll is always run for a legal
      -- entity, and this is the isolation boundary the engine will enforce.
      legal_entity_id     TEXT NOT NULL REFERENCES legal_entities(id),
      project_code        TEXT REFERENCES projects(code),   -- NULL = all projects

      -- frequency is configuration, not code. period_sequence below
      -- generalises "month" so weekly/biweekly groups need no new columns.
      frequency           TEXT NOT NULL DEFAULT 'monthly'
                            CHECK (frequency IN ('monthly','semi_monthly','biweekly','weekly')),
      periods_per_year    INTEGER NOT NULL DEFAULT 12,

      -- calendar association. NULL falls back to the Phase 1B resolution
      -- chain in lib/dayClassification.js — never re-derived here.
      work_calendar_id    INTEGER REFERENCES work_calendars(id),

      -- CUTOFF & PAY DATE POLICY, expressed as day offsets so no company
      -- specific date is hardcoded. Negative = days before period_end,
      -- positive = days after. NULL = same day as period_end.
      attendance_cutoff_offset_days INTEGER NOT NULL DEFAULT 0,
      overtime_cutoff_offset_days   INTEGER NOT NULL DEFAULT 0,
      adjustment_cutoff_offset_days INTEGER NOT NULL DEFAULT 2,
      payment_offset_days           INTEGER NOT NULL DEFAULT 5,

      -- Phase 2E approval policy. Configuration, not code: a group that
      -- requires every WARNING to be acknowledged before approval sets this
      -- to 1; a group that treats warnings as advisory sets it to 0.
      require_warning_acknowledgement INTEGER NOT NULL DEFAULT 1
                            CHECK (require_warning_acknowledgement IN (0,1)),

      effective_from      TEXT NOT NULL,
      effective_to        TEXT,
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_group_entity
      ON payroll_groups(legal_entity_id, status);
    -- One open version per code (NULL-safe partial index, same reasoning as
    -- the salary-component and holiday indexes).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_group_open_code
      ON payroll_groups(code) WHERE effective_to IS NULL;

    -- Domain 9b: Payroll Period — one exact cycle for one group.
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_group_id    INTEGER NOT NULL REFERENCES payroll_groups(id),
      period_year         INTEGER NOT NULL,
      -- sequence within the year: month 1-12 for monthly, 1-52 weekly, etc.
      period_sequence     INTEGER NOT NULL,
      period_month        INTEGER,                 -- convenience for monthly groups

      -- Boundaries are DATE-ONLY strings 'YYYY-MM-DD', compared
      -- lexicographically and iterated in UTC (lib/employeeEligibility.eachDate).
      -- No local-timezone Date parsing is used anywhere on a boundary, so a
      -- server in any timezone resolves the same period for the same date.
      period_start        TEXT NOT NULL,
      period_end          TEXT NOT NULL,

      -- Three independent cutoffs. A single CUTOFF status could not express
      -- "attendance closed, adjustments still open", so per-stream acceptance
      -- is DERIVED from these dates by lib/payrollPeriod.isStreamOpen().
      attendance_cutoff   TEXT NOT NULL,
      overtime_cutoff     TEXT NOT NULL,
      adjustment_cutoff   TEXT NOT NULL,
      payment_date        TEXT NOT NULL,

      -- Administrative lifecycle, advanced by an explicit audited action —
      -- never silently by the clock. Separate from run calculation states.
      status              TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','OPEN','CUTOFF','CLOSED')),
      closed_at           TEXT,
      closed_by           TEXT,
      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now')),

      CHECK (period_end >= period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_period_group_dates
      ON payroll_periods(payroll_group_id, period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_payroll_period_status
      ON payroll_periods(status);

    -- DUPLICATE PREVENTION at the database level: one period per group per
    -- cycle. This is the structural guard the engine will rely on before
    -- UNIQUE(period_id, run_number) exists.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_group_cycle
      ON payroll_periods(payroll_group_id, period_year, period_sequence);
    -- A group cannot have two periods starting on the same day either.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_group_start
      ON payroll_periods(payroll_group_id, period_start);

    -- ============================================================
    -- Phase 2B — Payroll Input Snapshots (Domain 10)
    --
    -- SCOPE LOCK: this domain stores RESOLVED INPUTS. It calculates nothing —
    -- no gross, net, BPJS amount, tax amount or overtime value. It records
    -- WHICH VERSION of every configuration applied, and the raw quantities,
    -- so a future Payroll Run can compute from a frozen picture.
    --
    -- WHY: without this, a rule-set activation or a salary revision in
    -- August would silently change what June's payroll "was". The snapshot
    -- is the mechanism that makes historical payroll immutable by
    -- construction rather than by promise.
    -- ============================================================

    CREATE TABLE IF NOT EXISTS payroll_input_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),

      -- as-of date the resolution was performed FOR (normally period_end).
      -- Stored because it is the key input to every version lookup below.
      as_of_date          TEXT NOT NULL,

      -- ---- resolved source entity + version identity ----
      legal_entity_id     TEXT NOT NULL,
      payroll_group_id    INTEGER NOT NULL,
      payroll_group_effective_from TEXT,
      assignment_id       INTEGER,                 -- employee_payroll_assignments row
      assignment_effective_from TEXT,
      work_pattern_id     INTEGER,
      work_calendar_id    INTEGER,
      work_calendar_effective_from TEXT,

      -- ---- rule versions ----
      payroll_rule_set_id INTEGER,                 -- BPJS % + caps + TER table + OT rules
      payroll_rule_set_effective_from TEXT,
      jkk_risk_class      TEXT,
      jkk_rate_version_id INTEGER,                 -- jkk_risk_classes row id
      jkk_rate_effective_from TEXT,
      ter_category        TEXT,                    -- A/B/C derived from PTKP status

      -- ---- resolved payload (JSON) ----
      -- Full component list with per-component flags, the BPJS/tax/overtime
      -- rule VALUES as they stood, day-type counts, and attendance totals.
      -- JSON because the shape must be frozen as-resolved, not normalised
      -- into tables that later migrations could reshape.
      resolved_payload    TEXT NOT NULL,

      -- ---- raw quantities (integers; Phase 0B canonical units) ----
      payable_days        INTEGER NOT NULL DEFAULT 0,
      period_days         INTEGER NOT NULL DEFAULT 0,
      work_minutes_total  INTEGER NOT NULL DEFAULT 0,
      overtime_minutes_approved INTEGER NOT NULL DEFAULT 0,
      attendance_row_count INTEGER NOT NULL DEFAULT 0,

      -- ---- integrity & lifecycle ----
      payload_hash        TEXT NOT NULL,           -- checksum of resolved_payload
      resolution_status   TEXT NOT NULL DEFAULT 'OK',
      resolution_errors   TEXT,                    -- JSON array when not OK
      status              TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','FROZEN')),
      resolved_at         TEXT NOT NULL,
      resolved_by         TEXT,
      frozen_at           TEXT,
      frozen_by           TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshot_period ON payroll_input_snapshots(payroll_period_id, status);
    CREATE INDEX IF NOT EXISTS idx_snapshot_employee ON payroll_input_snapshots(employee_id);
    CREATE INDEX IF NOT EXISTS idx_snapshot_entity ON payroll_input_snapshots(legal_entity_id);

    -- DUPLICATE PREVENTION: one snapshot per employee per period. This is the
    -- structural guard that stops a restarted or retried chunk from producing
    -- a second set of inputs for the same person.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshot_period_employee
      ON payroll_input_snapshots(payroll_period_id, employee_id);

    -- ============================================================
    -- Phase 2D — Validation & Exception Engine (Domain 11)
    --
    -- SCOPE LOCK: records WHAT IS WRONG with a dry-run result. It persists no
    -- payroll result, no payslip, no approval and no payment.
    --
    -- Exceptions are DETERMINISTIC: re-validating the same frozen snapshot
    -- produces the same set. Identity is (snapshot_id, exception_code), so a
    -- human resolution survives re-validation instead of being wiped by it.
    -- Nothing here auto-fixes payroll data.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS payroll_exceptions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id         INTEGER NOT NULL REFERENCES payroll_input_snapshots(id) ON DELETE CASCADE,
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,          -- isolation boundary, denormalised for scoping

      exception_code      TEXT NOT NULL,          -- machine-readable, stable
      severity            TEXT NOT NULL CHECK (severity IN ('BLOCKING','WARNING','INFORMATIONAL')),
      blocking            INTEGER NOT NULL CHECK (blocking IN (0,1)),
      source              TEXT NOT NULL,          -- which stage/field raised it
      message             TEXT NOT NULL,
      detail              TEXT,                   -- JSON, optional

      detected_at         TEXT NOT NULL,
      resolution_status   TEXT NOT NULL DEFAULT 'OPEN'
                            CHECK (resolution_status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
      resolved_by         TEXT,
      resolved_at         TEXT,
      resolution_note     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exception_period ON payroll_exceptions(payroll_period_id, severity);
    CREATE INDEX IF NOT EXISTS idx_exception_employee ON payroll_exceptions(employee_id);
    CREATE INDEX IF NOT EXISTS idx_exception_open ON payroll_exceptions(payroll_period_id, resolution_status);
    CREATE INDEX IF NOT EXISTS idx_exception_entity ON payroll_exceptions(legal_entity_id);

    -- One row per (snapshot, code). Re-validation UPDATES the message/detail
    -- and leaves the resolution alone; it never inserts a duplicate.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_exception_snapshot_code
      ON payroll_exceptions(snapshot_id, exception_code);

    -- ============================================================
    -- Phase 2E — Payroll Run, Approval, Finalization (Domain 12)
    --
    -- This is where calculation RESULTS first become persistent. Phases 2C/2D
    -- were deliberately dry-run; a result must be persisted before it can be
    -- approved, because approving a number that is recomputed on every read
    -- would approve nothing.
    --
    -- SCOPE: state machine + persisted results + immutability. NOT payment,
    -- bank export or payslip delivery.
    -- ============================================================

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      legal_entity_id     TEXT NOT NULL,          -- isolation boundary
      run_number          INTEGER NOT NULL,       -- 1, 2, ... per period

      -- Phase 2G: what kind of run this is.
      --   ORIGINAL   — the first authoritative payroll for the period
      --   CORRECTION — carries only ADJUSTMENT DELTAS against an ORIGINAL run
      --   REVERSAL   — negates an ORIGINAL run in full
      -- A correction never recalculates the original; it references it.
      run_type            TEXT NOT NULL DEFAULT 'ORIGINAL'
                            CHECK (run_type IN ('ORIGINAL','CORRECTION','REVERSAL')),
      corrects_run_id     INTEGER REFERENCES payroll_runs(id),

      status              TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','SNAPSHOT_READY','CALCULATED','VALIDATED','APPROVED','FINALIZED')),

      -- Segregation of duties: who prepared vs who approved. Recorded on the
      -- run so the check cannot be bypassed by editing an event row.
      prepared_by         TEXT,
      prepared_at         TEXT,
      validated_by        TEXT,
      validated_at        TEXT,
      approved_by         TEXT,
      approved_at         TEXT,
      finalized_by        TEXT,
      finalized_at        TEXT,

      engine_version      TEXT,
      created_by          TEXT,
      created_at          TEXT DEFAULT (datetime('now')),

      -- DUPLICATE RUN PREVENTION at the database level.
      UNIQUE (payroll_period_id, run_number)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_run_period ON payroll_runs(payroll_period_id, status);
    CREATE INDEX IF NOT EXISTS idx_payroll_run_entity ON payroll_runs(legal_entity_id);

    -- At most ONE run per period that is not superseded by a later one is NOT
    -- enforced here: reversal/correction (a future phase) will legitimately
    -- create run 2. What IS enforced is one FINALIZED run per period, so a
    -- period can never have two authoritative results.
    -- Phase 2G narrowed this from "one finalized run per period" to "one
    -- finalized ORIGINAL run per period". The original guarantee made a
    -- correction run impossible to finalize, which would have forced
    -- corrections to overwrite history — exactly what Phase 2E forbids.
    -- The authoritative-result guarantee is unchanged: a period still has
    -- exactly one ORIGINAL, plus an explicit, auditable chain of corrections.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_run_single_finalized_original
      ON payroll_runs(payroll_period_id)
      WHERE status = 'FINALIZED' AND run_type = 'ORIGINAL';

    -- At most ONE finalized REVERSAL per original run: a run cannot be
    -- reversed twice.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_reversal_single
      ON payroll_runs(corrects_run_id)
      WHERE status = 'FINALIZED' AND run_type = 'REVERSAL';

    -- One persisted result per employee per run. This is the structural guard
    -- against paying someone twice inside one run.
    CREATE TABLE IF NOT EXISTS payroll_run_lines (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_id      INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      snapshot_id         INTEGER NOT NULL REFERENCES payroll_input_snapshots(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,

      calc_status         TEXT NOT NULL,          -- OK | BLOCKED
      -- integer sen throughout (Phase 0 B3)
      gross_sen           INTEGER,
      taxable_base_sen    INTEGER,
      bpjs_base_sen       INTEGER,
      overtime_sen        INTEGER,
      bpjs_employee_sen   INTEGER,
      bpjs_employer_sen   INTEGER,
      tax_sen             INTEGER,
      other_deductions_sen INTEGER,
      employee_deductions_sen INTEGER,
      net_sen             INTEGER,
      employer_cost_sen   INTEGER,

      -- rule version references, copied from the snapshot so a finalized line
      -- is self-describing without a join to live configuration
      payroll_rule_set_id INTEGER,
      jkk_rate_version_id INTEGER,
      ter_category        TEXT,

      result_payload      TEXT NOT NULL,          -- full calculator result incl. trace
      result_hash         TEXT NOT NULL,          -- sha256 over the stable result
      snapshot_hash       TEXT NOT NULL,          -- the inputs it was computed from
      calculated_at       TEXT NOT NULL,

      UNIQUE (payroll_run_id, employee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_line_run ON payroll_run_lines(payroll_run_id);
    CREATE INDEX IF NOT EXISTS idx_run_line_employee ON payroll_run_lines(employee_id);

    -- Component-level breakdown: this is what a payslip will be rendered from.
    CREATE TABLE IF NOT EXISTS payroll_run_line_components (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_line_id INTEGER NOT NULL REFERENCES payroll_run_lines(id) ON DELETE CASCADE,
      sequence            INTEGER NOT NULL,
      component_code      TEXT NOT NULL,
      component_group     TEXT NOT NULL,          -- earning | deduction | bpjs | tax | overtime | total
      paid_by             TEXT,                   -- employee | employer | NULL for totals
      basis               TEXT,
      quantity            TEXT,
      rate                TEXT,
      formula             TEXT,
      rounding_rule       TEXT,
      rule_version        TEXT,
      source_snapshot_field TEXT,
      amount_sen          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_run_line_component ON payroll_run_line_components(payroll_run_line_id, sequence);

    -- Every transition, with actor, timestamp, from, to and reason.
    CREATE TABLE IF NOT EXISTS payroll_run_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_id      INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      from_status         TEXT,
      to_status           TEXT NOT NULL,
      actor               TEXT NOT NULL,
      note                TEXT,
      detail              TEXT,                   -- JSON
      occurred_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_event_run ON payroll_run_events(payroll_run_id, id);

    -- ============================================================
    -- DATABASE-LEVEL IMMUTABILITY LOCK
    --
    -- The application state machine refuses to mutate a FINALIZED run, but an
    -- application guard is only as good as every future code path remembering
    -- it. These triggers make the lock structural: once a run is FINALIZED,
    -- SQLite itself rejects any attempt to change or delete its results, its
    -- component breakdown, or the snapshots those results were computed from.
    -- ============================================================

    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_run_line_update
    BEFORE UPDATE ON payroll_run_lines
    WHEN (SELECT status FROM payroll_runs WHERE id = OLD.payroll_run_id) = 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: payroll_run_lines is immutable once the run is FINALIZED');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_run_line_delete
    BEFORE DELETE ON payroll_run_lines
    WHEN (SELECT status FROM payroll_runs WHERE id = OLD.payroll_run_id) = 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: payroll_run_lines cannot be deleted once the run is FINALIZED');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_component_update
    BEFORE UPDATE ON payroll_run_line_components
    WHEN (SELECT r.status FROM payroll_runs r
          JOIN payroll_run_lines l ON l.payroll_run_id = r.id
          WHERE l.id = OLD.payroll_run_line_id) = 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: component breakdown is immutable once the run is FINALIZED');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_component_delete
    BEFORE DELETE ON payroll_run_line_components
    WHEN (SELECT r.status FROM payroll_runs r
          JOIN payroll_run_lines l ON l.payroll_run_id = r.id
          WHERE l.id = OLD.payroll_run_line_id) = 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: component breakdown cannot be deleted once the run is FINALIZED');
    END;

    -- A snapshot referenced by a FINALIZED run is frozen too: the inputs must
    -- remain exactly what the approved figures were computed from.
    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_snapshot_update
    BEFORE UPDATE ON payroll_input_snapshots
    WHEN EXISTS (SELECT 1 FROM payroll_run_lines l
                 JOIN payroll_runs r ON r.id = l.payroll_run_id
                 WHERE l.snapshot_id = OLD.id AND r.status = 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: snapshot is immutable once used by a FINALIZED run');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_snapshot_delete
    BEFORE DELETE ON payroll_input_snapshots
    WHEN EXISTS (SELECT 1 FROM payroll_run_lines l
                 JOIN payroll_runs r ON r.id = l.payroll_run_id
                 WHERE l.snapshot_id = OLD.id AND r.status = 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: snapshot cannot be deleted once used by a FINALIZED run');
    END;

    -- A FINALIZED run may not be moved to any other status. Correction after
    -- finalization must create a NEW run (reversal workflow, a future phase),
    -- never rewrite the finalized one.
    CREATE TRIGGER IF NOT EXISTS trg_lock_finalized_run_status
    BEFORE UPDATE OF status ON payroll_runs
    WHEN OLD.status = 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYROLL_FINALIZED: a finalized run cannot change status; create a correction run instead');
    END;

    -- ============================================================
    -- Phase 2F — Payslips (Domain 13)
    --
    -- A payslip is GENERATED ONCE from a FINALIZED run and then frozen. It is
    -- not re-rendered on every read.
    --
    -- WHY generate-once rather than render-on-demand: the financial figures
    -- come from payroll_run_lines (already immutable), but the human-readable
    -- context — employee name, position, entity name — lives in live master
    -- tables. Rendering on demand would let a rename or a reorganisation
    -- silently change a historical payslip. Freezing the whole document at
    -- generation makes "identical months later" true for the entire
    -- document, not just the numbers.
    --
    -- SCOPE: rendering only. No payment, no bank file, no export delivery.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS payroll_payslips (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_id      INTEGER NOT NULL REFERENCES payroll_runs(id),
      payroll_run_line_id INTEGER NOT NULL REFERENCES payroll_run_lines(id),
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,          -- isolation boundary
      run_number          INTEGER NOT NULL,       -- correction runs get their own payslip

      payslip_version     INTEGER NOT NULL DEFAULT 1,
      payslip_reference   TEXT NOT NULL,          -- human-quotable audit id

      document            TEXT NOT NULL,          -- frozen JSON document
      content_hash        TEXT NOT NULL,          -- sha256 over the financial content
      line_result_hash    TEXT NOT NULL,          -- the run line it was rendered from
      snapshot_hash       TEXT NOT NULL,          -- the inputs behind that line

      -- headline figures, denormalised so a list view needs no JSON parsing
      gross_sen           INTEGER NOT NULL,
      employee_deductions_sen INTEGER NOT NULL,
      net_sen             INTEGER NOT NULL,
      employer_cost_sen   INTEGER NOT NULL,

      finalized_at        TEXT NOT NULL,          -- when the RUN was finalized
      generated_at        TEXT NOT NULL,
      generated_by        TEXT NOT NULL,

      -- One payslip per run line. A correction run produces a DIFFERENT line,
      -- and therefore its own payslip, without touching the original.
      UNIQUE (payroll_run_line_id),
      UNIQUE (payslip_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_run ON payroll_payslips(payroll_run_id);
    CREATE INDEX IF NOT EXISTS idx_payslip_employee ON payroll_payslips(employee_id, payroll_period_id);
    CREATE INDEX IF NOT EXISTS idx_payslip_entity ON payroll_payslips(legal_entity_id);

    -- A payslip is immutable from the moment it exists. There is no state in
    -- which amending one is correct: a corrected figure means a correction
    -- RUN, which produces its own payslip alongside the original.
    CREATE TRIGGER IF NOT EXISTS trg_lock_payslip_update
    BEFORE UPDATE ON payroll_payslips
    BEGIN
      SELECT RAISE(ABORT, 'PAYSLIP_IMMUTABLE: a payslip cannot be modified; issue a correction run instead');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_payslip_delete
    BEFORE DELETE ON payroll_payslips
    BEGIN
      SELECT RAISE(ABORT, 'PAYSLIP_IMMUTABLE: a payslip cannot be deleted');
    END;

    -- A payslip may only ever be created against a FINALIZED run.
    -- ============================================================
    -- Phase 2G — Adjustments, Retroactive Payroll & Reversal (Domain 14)
    --
    -- A finalized payroll is immutable. Every correction is an ENTRY IN THIS
    -- LEDGER, applied through a CORRECTION or REVERSAL run that references
    -- the original. Nothing here ever edits a finalized line.
    --
    -- Statutory recalculation on a delta uses the rule versions FROZEN in the
    -- original snapshot, never live configuration — so a correction issued in
    -- September for a June payroll is computed under June's rules.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS payroll_adjustments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      -- what is being corrected
      source_run_id       INTEGER NOT NULL REFERENCES payroll_runs(id),
      source_period_id    INTEGER NOT NULL REFERENCES payroll_periods(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,

      adjustment_type     TEXT NOT NULL CHECK (adjustment_type IN (
                            'RETRO_EARNING','RETRO_DEDUCTION','LATE_OVERTIME',
                            'ATTENDANCE_CORRECTION','TAX_CORRECTION','BPJS_CORRECTION',
                            'MANUAL_ADJUSTMENT')),
      component_code      TEXT NOT NULL,

      -- Direction is explicit rather than implied by the sign, so a negative
      -- amount can never be entered by accident. amount_sen is always >= 0.
      direction           TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
      amount_sen          INTEGER NOT NULL CHECK (amount_sen >= 0),

      -- For LATE_OVERTIME: the minutes being paid late (Phase 0B canonical).
      overtime_minutes    INTEGER,
      overtime_day_type   TEXT,
      work_date           TEXT,

      -- how the delta behaves statutorily; defaults mirror a normal earning
      is_taxable          INTEGER NOT NULL DEFAULT 1 CHECK (is_taxable IN (0,1)),
      is_bpjs_base        INTEGER NOT NULL DEFAULT 0 CHECK (is_bpjs_base IN (0,1)),

      reason              TEXT NOT NULL,
      external_reference  TEXT,                   -- idempotency key from a caller

      status              TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','APPROVED','APPLIED','VOID')),
      applied_to_run_id   INTEGER REFERENCES payroll_runs(id),
      applied_at          TEXT,

      created_by          TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      approved_by         TEXT,
      approved_at         TEXT,
      voided_by           TEXT,
      voided_at           TEXT,
      void_reason         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_adjustment_source ON payroll_adjustments(source_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_adjustment_employee ON payroll_adjustments(employee_id, source_period_id);
    CREATE INDEX IF NOT EXISTS idx_adjustment_applied ON payroll_adjustments(applied_to_run_id);
    CREATE INDEX IF NOT EXISTS idx_adjustment_entity ON payroll_adjustments(legal_entity_id);

    -- DUPLICATE PREVENTION: a caller-supplied reference can only be used once.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_external_reference
      ON payroll_adjustments(external_reference) WHERE external_reference IS NOT NULL;

    -- An APPLIED adjustment is part of a finalized-or-in-flight correction run
    -- and must not be edited. Voiding is only legal while it is still DRAFT or
    -- APPROVED, which the application enforces; this trigger is the backstop.
    CREATE TRIGGER IF NOT EXISTS trg_lock_applied_adjustment
    BEFORE UPDATE ON payroll_adjustments
    WHEN OLD.status = 'APPLIED'
      AND (NEW.amount_sen != OLD.amount_sen
        OR NEW.direction != OLD.direction
        OR NEW.component_code != OLD.component_code
        OR NEW.adjustment_type != OLD.adjustment_type
        OR NEW.employee_id != OLD.employee_id
        OR NEW.source_run_id != OLD.source_run_id)
    BEGIN
      SELECT RAISE(ABORT, 'ADJUSTMENT_APPLIED: an applied adjustment is immutable; issue a new adjustment instead');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_applied_adjustment_delete
    BEFORE DELETE ON payroll_adjustments
    WHEN OLD.status = 'APPLIED'
    BEGIN
      SELECT RAISE(ABORT, 'ADJUSTMENT_APPLIED: an applied adjustment cannot be deleted');
    END;

    -- An adjustment may only ever reference a FINALIZED source run: there is
    -- nothing to correct until the original is authoritative.
    -- ============================================================
    -- Phase 2H — Payment Processing & Bank File Export (Domain 15)
    --
    -- Payment READS finalized payroll and turns it into instructions. It never
    -- recalculates salary, tax or BPJS, never reads live payroll rules, and
    -- never modifies a finalized run, its lines, its payslips or the
    -- adjustment ledger.
    --
    -- TWO STATE MACHINES, deliberately. The suggested lifecycle
    -- (DRAFT -> VALIDATED -> EXPORTED -> SUBMITTED -> PAID) is BATCH-shaped,
    -- but a bank rejects INDIVIDUAL instructions: one bad account number must
    -- not fail 1,499 good payments. So the batch tracks the file's progress
    -- and each item tracks its own outcome, with the batch deriving
    -- PARTIALLY_PAID from its items.
    -- ============================================================

    CREATE TABLE IF NOT EXISTS payroll_payment_batches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_reference     TEXT NOT NULL,
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      payroll_group_id    INTEGER NOT NULL REFERENCES payroll_groups(id),
      legal_entity_id     TEXT NOT NULL,          -- isolation boundary

      status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                            'DRAFT','VALIDATED','EXPORTED','SUBMITTED',
                            'PAID','PARTIALLY_PAID','CANCELLED')),

      export_format       TEXT,                   -- see lib/bankExport.js registry
      export_reference    TEXT,
      exported_at         TEXT,
      exported_by         TEXT,
      export_hash         TEXT,                   -- sha256 of the exported payload
      submitted_at        TEXT,
      submitted_by        TEXT,

      item_count          INTEGER NOT NULL DEFAULT 0,
      total_amount_sen    INTEGER NOT NULL DEFAULT 0,

      prepared_by         TEXT,
      prepared_at         TEXT,
      validated_by        TEXT,
      validated_at        TEXT,
      authorized_by       TEXT,
      authorized_at       TEXT,
      cancelled_by        TEXT,
      cancelled_at        TEXT,
      cancel_reason       TEXT,

      created_by          TEXT NOT NULL,
      created_at          TEXT NOT NULL,

      UNIQUE (batch_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_payment_batch_period ON payroll_payment_batches(payroll_period_id, status);
    CREATE INDEX IF NOT EXISTS idx_payment_batch_entity ON payroll_payment_batches(legal_entity_id);

    CREATE TABLE IF NOT EXISTS payroll_payment_items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id            INTEGER NOT NULL REFERENCES payroll_payment_batches(id) ON DELETE CASCADE,
      payroll_period_id   INTEGER NOT NULL REFERENCES payroll_periods(id),
      employee_id         TEXT NOT NULL REFERENCES employees(id),
      legal_entity_id     TEXT NOT NULL,

      payment_reference   TEXT NOT NULL,

      -- The payable amount, taken from the SUM of finalized ORIGINAL +
      -- CORRECTION + REVERSAL net for this employee in this period. Never
      -- recomputed from salary.
      amount_sen          INTEGER NOT NULL,
      source_run_ids      TEXT NOT NULL,          -- JSON array, for traceability

      -- BANK ACCOUNT SNAPSHOT, frozen at preparation. A later change to the
      -- employee's master record must not alter an instruction already sent.
      bank_name           TEXT,
      bank_account_no     TEXT,
      bank_account_name   TEXT,
      bank_snapshot_at    TEXT NOT NULL,

      status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                            'PENDING','EXPORTED','SUBMITTED','PAID',
                            'REJECTED','FAILED','RETURNED','CANCELLED')),
      status_reason       TEXT,
      bank_response_code  TEXT,
      paid_at             TEXT,

      -- Retry chain: a rejected/returned item is never edited; a NEW item is
      -- created that points back at it.
      retry_of_item_id    INTEGER REFERENCES payroll_payment_items(id),
      retry_count         INTEGER NOT NULL DEFAULT 0,

      created_at          TEXT NOT NULL,

      UNIQUE (payment_reference)
    );

    -- One LIVE instruction per employee per batch. A CANCELLED row is history
    -- (typically replaced by an explicit linked retry), so it is excluded —
    -- a table-level UNIQUE(batch_id, employee_id) would have made that
    -- replacement impossible.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_item_live_per_batch
      ON payroll_payment_items(batch_id, employee_id)
      WHERE status != 'CANCELLED';
    CREATE INDEX IF NOT EXISTS idx_payment_item_batch ON payroll_payment_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_payment_item_employee ON payroll_payment_items(employee_id, payroll_period_id);
    CREATE INDEX IF NOT EXISTS idx_payment_item_entity ON payroll_payment_items(legal_entity_id);

    -- DUPLICATE PAYMENT PREVENTION at the database level: an employee may have
    -- at most ONE live instruction per period. Terminal-failure states are
    -- excluded so a retry after a rejection is legal, while a second
    -- concurrent instruction for the same period is impossible.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_item_live_per_period
      ON payroll_payment_items(payroll_period_id, employee_id)
      WHERE status NOT IN ('REJECTED','FAILED','RETURNED','CANCELLED');

    CREATE TABLE IF NOT EXISTS payroll_payment_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id            INTEGER REFERENCES payroll_payment_batches(id) ON DELETE CASCADE,
      payment_item_id     INTEGER REFERENCES payroll_payment_items(id) ON DELETE CASCADE,
      from_status         TEXT,
      to_status           TEXT NOT NULL,
      actor               TEXT NOT NULL,
      note                TEXT,
      detail              TEXT,
      occurred_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_event_batch ON payroll_payment_events(batch_id, id);
    CREATE INDEX IF NOT EXISTS idx_payment_event_item ON payroll_payment_events(payment_item_id, id);

    -- Once a batch has been EXPORTED, its instructions are a record of what
    -- was sent to the bank. Amount and bank snapshot become immutable: a
    -- correction means a new item (retry), never an edit of the sent one.
    CREATE TRIGGER IF NOT EXISTS trg_lock_exported_payment_item
    BEFORE UPDATE ON payroll_payment_items
    WHEN (SELECT status FROM payroll_payment_batches WHERE id = OLD.batch_id)
           IN ('EXPORTED','SUBMITTED','PAID','PARTIALLY_PAID')
      AND (NEW.amount_sen != OLD.amount_sen
        OR IFNULL(NEW.bank_account_no,'') != IFNULL(OLD.bank_account_no,'')
        OR IFNULL(NEW.bank_name,'') != IFNULL(OLD.bank_name,'')
        OR IFNULL(NEW.bank_account_name,'') != IFNULL(OLD.bank_account_name,'')
        OR NEW.employee_id != OLD.employee_id)
    BEGIN
      SELECT RAISE(ABORT, 'PAYMENT_EXPORTED: amount and bank details are immutable once exported; create a retry instead');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lock_exported_payment_item_delete
    BEFORE DELETE ON payroll_payment_items
    WHEN (SELECT status FROM payroll_payment_batches WHERE id = OLD.batch_id)
           IN ('EXPORTED','SUBMITTED','PAID','PARTIALLY_PAID')
    BEGIN
      SELECT RAISE(ABORT, 'PAYMENT_EXPORTED: an exported payment instruction cannot be deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_adjustment_requires_finalized_source
    BEFORE INSERT ON payroll_adjustments
    WHEN (SELECT status FROM payroll_runs WHERE id = NEW.source_run_id) != 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'ADJUSTMENT_SOURCE_NOT_FINALIZED: adjustments can only correct a FINALIZED payroll run');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payslip_requires_finalized_run
    BEFORE INSERT ON payroll_payslips
    WHEN (SELECT status FROM payroll_runs WHERE id = NEW.payroll_run_id) != 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'PAYSLIP_RUN_NOT_FINALIZED: payslips can only be generated from a FINALIZED payroll run');
    END;
  `);

  // Attendance Hardening A1: additive attendance columns, audit trail and the
  // frozen-snapshot attendance lock. Runs last so every table it reads exists.
  require('./attendance-schema').ensureAttendanceSchema(db);
  // Attendance A2: configurable work schedule / shift / pattern model.
  require('./attendance-schedule-schema').ensureAttendanceScheduleSchema(db);
  // Attendance A3: correction / void / exception / payroll impact / audit.
  require('./attendance-correction-schema').ensureAttendanceCorrectionSchema(db);
}

if (require.main === module) {
  const db = getDb();
  initDb(db);
  console.log('KAHE 360: database schema ready at', DB_PATH);
  db.close();
}

module.exports = {
  getDb, initDb, withTransaction, withRetry, isRetryableLockError,
  BUSY_TIMEOUT_MS, MAX_WRITE_ATTEMPTS, DB_PATH,
};
