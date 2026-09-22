// database/seed-talent.js
// Talent & Worker V1 — configuration seed (CP1). Idempotent. Runs as the SCHEMA OWNER
// (DATABASE_MIGRATION_URL), because the runtime role is read-only on Talent security tables.
//
// What it writes (schema `talent` only):
//   * talent.permission      — the Talent permission catalogue
//   * talent.role_permission — EXPLICIT grants for three EXISTING roles; no ALL_ACTIONS, no inheritance
//   * talent.field_catalog / talent.field_policy — field-level security (no row = HIDDEN)
//   * talent.user_scope      — scope ALL for the users who currently hold one of those three roles
// It reads public.roles / public.user_roles / public.users (authentication records) and writes
// nothing outside schema `talent`. It creates no worker, no candidate and no demo business data.
//
// Run order: npm run db:migrate && npm run seed && npm run db:migrate-talent && npm run seed:talent
// Re-running database/seed.js does not affect anything written here.
const path = require('path');
const { Client } = require('pg');

const PERMISSIONS = [
  ['tw_home', 'Talent home & dashboard', ['VIEW']],
  ['tw_registration', 'Candidate registration — internal intake (P05)', ['VIEW', 'CREATE', 'EDIT']],
  ['tw_verification', 'Verification & screening (P06)', ['VIEW', 'EDIT', 'APPROVE', 'REJECT']],
  ['tw_talent_pool', 'Talent pool, profile, readiness, matching (P07–P10)', ['VIEW', 'CREATE', 'EDIT', 'EXPORT']],
  ['tw_deployment', 'Mobilization, deployment & assignment control (P11–P13)', ['VIEW', 'CREATE', 'EDIT', 'APPROVE']],
  ['tw_contract_placement', 'Contract & placement (P14)', ['VIEW', 'CREATE', 'EDIT', 'APPROVE']],
  ['tw_worker_passport', 'Worker Passport — view (P15/P15A)', ['VIEW']],
  ['tw_passport_print', 'Worker Passport — print', ['EXPORT']],
  ['tw_passport_pdf', 'Worker Passport — export PDF', ['EXPORT']],
  ['tw_document_download', 'Worker documents — download', ['EXPORT']],
  ['tw_reports', 'Talent reports & analytics', ['VIEW', 'EXPORT']],
  ['tw_security_admin', 'Talent security & access settings (P16)', ['VIEW', 'EDIT', 'ADMIN']],
  ['tw_emergency_intake', 'Emergency Registration Intake V0 — list & CSV export (not P05)', ['VIEW', 'EXPORT']],
];

// Least privilege. Output permissions (print / PDF / download) and tw_security_admin are granted to
// NOBODY in CP1 — they are decided in the checkpoints that build those functions.
const ROLE_GRANTS = {
  workforce_manager: {   // Talent operational management
    tw_home: ['VIEW'],
    tw_registration: ['VIEW', 'CREATE', 'EDIT'],
    tw_talent_pool: ['VIEW', 'CREATE', 'EDIT'],
    tw_deployment: ['VIEW', 'CREATE', 'EDIT'],
    tw_contract_placement: ['VIEW', 'CREATE', 'EDIT'],
    tw_worker_passport: ['VIEW'],
    tw_reports: ['VIEW'],
    tw_emergency_intake: ['VIEW', 'EXPORT'],   // Emergency Registration V0
  },
  hrd_officer: {         // Talent verification / HR-related functions
    tw_home: ['VIEW'],
    tw_registration: ['VIEW'],
    tw_verification: ['VIEW', 'EDIT', 'APPROVE', 'REJECT'],
    tw_talent_pool: ['VIEW'],
    tw_worker_passport: ['VIEW'],
    tw_emergency_intake: ['VIEW', 'EXPORT'],   // Emergency Registration V0
  },
  operations_director: { // read-only overview / reporting
    tw_home: ['VIEW'],
    tw_talent_pool: ['VIEW'],
    tw_deployment: ['VIEW'],
    tw_contract_placement: ['VIEW'],
    tw_worker_passport: ['VIEW'],
    tw_reports: ['VIEW'],
  },
};

const FIELD_CATALOG = [
  ['worker_uuid', 'IDENTITY', 'INTERNAL', 'NONE', 'Canonical internal worker identity'],
  ['registration_id', 'IDENTITY', 'INTERNAL', 'NONE', 'Display ID KAHE-TAL-YYYY-NNNNNN'],
  ['talent_id', 'IDENTITY', 'INTERNAL', 'NONE', 'Display ID KAHE-T-NNNNNN'],
  ['worker_id', 'IDENTITY', 'INTERNAL', 'NONE', 'Display ID KAHE-W-NNNNNN'],
  ['full_name', 'PERSONAL', 'PERSONAL', 'REDACT', 'Full name'],
  ['nik', 'IDENTITY', 'RESTRICTED', 'LAST4', 'National identity number (NIK)'],
  ['birth_date', 'PERSONAL', 'PERSONAL', 'YEAR_ONLY', 'Date of birth'],
  ['gender', 'PERSONAL', 'PERSONAL', 'REDACT', 'Gender'],
  ['religion', 'PERSONAL', 'SENSITIVE', 'REDACT', 'Religion'],
  ['marital_status', 'PERSONAL', 'SENSITIVE', 'REDACT', 'Marital status'],
  ['phone', 'CONTACT', 'PERSONAL', 'PHONE', 'Phone / WhatsApp'],
  ['email', 'CONTACT', 'PERSONAL', 'EMAIL', 'Email'],
  ['address', 'CONTACT', 'PERSONAL', 'REDACT', 'Home address'],
  ['domicile_city', 'CONTACT', 'INTERNAL', 'REDACT', 'City of domicile'],
  ['bpjs_number', 'SOCIAL_SECURITY', 'RESTRICTED', 'LAST4', 'BPJS membership number'],
  ['bank_account_number', 'FINANCIAL', 'RESTRICTED', 'LAST4', 'Bank account number'],
  ['salary', 'FINANCIAL', 'RESTRICTED', 'REDACT', 'Salary / wage'],
  ['medical_status', 'MEDICAL', 'SENSITIVE', 'REDACT', 'Fit-to-work status'],
  ['medical_diagnosis', 'MEDICAL', 'RESTRICTED', 'REDACT', 'Medical diagnosis'],
  // Emergency Registration V0 — registration metadata shown in the intake list / CSV
  ['latest_position', 'EMPLOYMENT', 'INTERNAL', 'REDACT', 'Latest position (self-declared)'],
  ['registered_at', 'IDENTITY', 'INTERNAL', 'NONE', 'Registration date'],
  ['registration_status', 'IDENTITY', 'INTERNAL', 'NONE', 'Registration status'],
  ['duplicate_flag', 'IDENTITY', 'INTERNAL', 'NONE', 'Possible duplicate indicator (phone/email)'],
];

// No row = HIDDEN. Social security, financial and medical fields have no rows for any role in CP1.
const FIELD_POLICY = {
  workforce_manager: {
    worker_uuid: 'FULL', registration_id: 'FULL', talent_id: 'FULL', worker_id: 'FULL', full_name: 'FULL',
    nik: 'MASKED', birth_date: 'MASKED', gender: 'FULL', phone: 'FULL', email: 'FULL', address: 'MASKED', domicile_city: 'FULL',
    latest_position: 'FULL', registered_at: 'FULL', registration_status: 'FULL', duplicate_flag: 'FULL',
  },
  hrd_officer: {
    worker_uuid: 'FULL', registration_id: 'FULL', talent_id: 'FULL', worker_id: 'FULL', full_name: 'FULL',
    nik: 'MASKED', birth_date: 'FULL', gender: 'FULL', phone: 'FULL', email: 'FULL', address: 'FULL', domicile_city: 'FULL',
    latest_position: 'FULL', registered_at: 'FULL', registration_status: 'FULL', duplicate_flag: 'FULL',
  },
  operations_director: {
    worker_uuid: 'FULL', registration_id: 'FULL', talent_id: 'FULL', worker_id: 'FULL', full_name: 'FULL',
    phone: 'MASKED', domicile_city: 'FULL',
  },
};

const MANAGED_ROLES = Object.keys(ROLE_GRANTS);

async function seedTalent({ connectionString, log = console.log } = {}) {
  const url = connectionString || process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (schema owner) before running the Talent seed.');
  const c = new Client({ connectionString: url, application_name: 'kahe360-seed-talent' });
  await c.connect();
  try {
    const ready = (await c.query(`SELECT to_regclass('talent.role_permission') AS t`)).rows[0].t;
    if (!ready) throw new Error('Talent schema not migrated. Run: npm run db:migrate-talent');
    const rolesTable = (await c.query(`SELECT to_regclass('public.roles') AS t`)).rows[0].t;
    if (!rolesTable) throw new Error('Platform roles not found. Run: npm run db:migrate && npm run seed');
    const existing = (await c.query('SELECT code FROM public.roles WHERE code = ANY($1::text[])', [MANAGED_ROLES])).rows.map((r) => r.code);
    const missing = MANAGED_ROLES.filter((r) => !existing.includes(r));
    if (missing.length) throw new Error(`Existing role record(s) not found: ${missing.join(', ')}. Run: npm run seed`);

    await c.query('BEGIN');
    try {
      for (const [code, description, actions] of PERMISSIONS) {
        await c.query(`INSERT INTO talent.permission (code, description, allowed_actions) VALUES ($1, $2, $3)
          ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, allowed_actions = EXCLUDED.allowed_actions`,
        [code, description, actions]);
      }
      // Grants are REPLACED as a whole: the table holds exactly what this file declares.
      await c.query('DELETE FROM talent.role_permission');
      let grantRows = 0;
      for (const [role, perms] of Object.entries(ROLE_GRANTS)) {
        for (const [perm, actions] of Object.entries(perms)) {
          for (const action of actions) {
            await c.query('INSERT INTO talent.role_permission (role_code, permission_code, action) VALUES ($1, $2, $3)', [role, perm, action]);
            grantRows += 1;
          }
        }
      }
      await c.query(`DELETE FROM talent.permission WHERE code <> ALL($1::text[])`, [PERMISSIONS.map((p) => p[0])]);

      for (const [code, category, sensitivity, rule, description] of FIELD_CATALOG) {
        await c.query(`INSERT INTO talent.field_catalog (field_code, category, sensitivity, mask_rule, description)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (field_code) DO UPDATE SET category = EXCLUDED.category,
          sensitivity = EXCLUDED.sensitivity, mask_rule = EXCLUDED.mask_rule, description = EXCLUDED.description`,
        [code, category, sensitivity, rule, description]);
      }
      await c.query('DELETE FROM talent.field_policy');
      let policyRows = 0;
      for (const [role, fields] of Object.entries(FIELD_POLICY)) {
        for (const [field, visibility] of Object.entries(fields)) {
          await c.query('INSERT INTO talent.field_policy (role_code, field_code, visibility) VALUES ($1, $2, $3)', [role, field, visibility]);
          policyRows += 1;
        }
      }
      await c.query(`DELETE FROM talent.field_catalog WHERE field_code <> ALL($1::text[])`, [FIELD_CATALOG.map((f) => f[0])]);

      // Scope ALL for active users currently holding a managed role. Users added later get no scope
      // (fail-closed) until scope is granted — the scope administration UI is P16.
      const scoped = await c.query(`INSERT INTO talent.user_scope (user_id, scope_type)
        SELECT DISTINCT u.id, 'ALL' FROM public.users u
          JOIN public.user_roles ur ON ur.user_id = u.id JOIN public.roles r ON r.id = ur.role_id
         WHERE r.code = ANY($1::text[]) AND u.is_active = 1
           AND NOT EXISTS (SELECT 1 FROM talent.user_scope s WHERE s.user_id = u.id AND s.scope_type = 'ALL')`, [MANAGED_ROLES]);
      await c.query('COMMIT');
      log(`  Talent seed: ${PERMISSIONS.length} permissions, ${grantRows} grants (${MANAGED_ROLES.join(', ')}), `
        + `${FIELD_CATALOG.length} catalogued fields, ${policyRows} field policies, ${scoped.rowCount} new scope rows`);
      return { permissions: PERMISSIONS.length, grants: grantRows, fields: FIELD_CATALOG.length, policies: policyRows, newScopes: scoped.rowCount };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  } finally { await c.end(); }
}

module.exports = { seedTalent, PERMISSIONS, ROLE_GRANTS, FIELD_CATALOG, FIELD_POLICY, MANAGED_ROLES };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* optional */ }
  seedTalent()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`TALENT SEED FAILED: ${err.message}`); process.exit(1); });
}
