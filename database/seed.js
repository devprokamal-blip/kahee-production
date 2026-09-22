(async () => {
// database/seed.js
// Idempotent seed: roles, permissions, role_permissions, demo project, demo users + scope.
// Run with: npm run seed

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* optional */ }

const bcrypt = require('bcryptjs');
const { getDb, initDb } = require('./init-db');

const BCRYPT_ROUNDS = 12;
const DEMO_PASSWORD = 'Kahe360Demo!2026';

// Modules == sidebar / permission surface (matches docs/RBAC_MATRIX.md)
const SOD_OVERRIDE_MODULE = 'payroll_sod_override';
const ENTITY_OVERRIDE_MODULE = 'payroll_entity_override';
const ATTENDANCE_OVERRIDE_MODULE = 'attendance_sensitive_override';

const MODULES = [
  ['home', 'Home'],
  ['command_center', 'Command Center'],
  ['intelligence_planning', 'Intelligence & Planning'],
  ['talent_readiness', 'Talent & Readiness'],
  ['workforce_operations', 'Workforce Operations'],
  ['performance_employment', 'Performance & Employment'],
  ['payroll_bpjs', 'Payroll & BPJS'],
  ['hrd_kontrak', 'HRD & Kontrak'],
  ['timesheet_absensi', 'Timesheet & Absensi'],
  // Attendance A2: work schedule / shift / work pattern configuration. Kept
  // separate from timesheet_absensi so "may record attendance" and "may change
  // everyone's working rhythm" can be held by different people.
  ['attendance_config', 'Jadwal & Pola Kerja'],
  // Attendance A3: correction / void / exception / payroll-impact / audit.
  // Deliberately SEPARATE modules so "may record attendance", "may approve a
  // correction", "may approve a LATE correction" and "may approve the payroll
  // consequence" can be held by four different people.
  ['attendance_correction', 'Koreksi Absensi'],
  ['attendance_void', 'Pembatalan (Void) Absensi'],
  ['attendance_late_correction', 'Persetujuan Koreksi Terlambat'],
  ['attendance_exception', 'Exception Absensi'],
  ['attendance_payroll_impact', 'Dampak Payroll Absensi'],
  ['attendance_audit', 'Audit & Aktivitas Absensi'],
  // Attendance A4 CP1: Attendance Period and Closing Policy. Their actions are PINNED for every
  // role below (including Operations Director) — never the ALL_ACTIONS default.
  ['attendance_period', 'Periode Absensi'],
  ['attendance_closing_policy', 'Kebijakan Penutupan Absensi'],
  // Attendance A4 CP2: readiness gate (VIEW summary/detail, APPROVE ready-to-close / withdraw). Pinned below.
  ['attendance_readiness', 'Kesiapan Penutupan Absensi'],
  // Like the payroll SoD override: granted to NO role by default. Holding it
  // relaxes an evidence requirement, never the requester-≠-approver rule,
  // which no permission can unlock.
  ['attendance_sensitive_override', 'Attendance Sensitive Override'],
  ['payroll_config', 'Payroll Configuration'],
  ['payroll_run', 'Payroll Run & Periods'],
  ['payroll_payment', 'Payroll Payment & Bank File'],
  ['worker_services_config', 'Worker Service Add-ons & Service Fee'],
  ['client_billing', 'Client Billing Quantity & Calculation'],
  // Phase 2E: segregation-of-duties override. Deliberately granted to NO
  // role by default — see SOD_OVERRIDE_MODULE below. Holding it lets one
  // person both prepare and approve the same payroll run, which is exactly
  // the control this module exists to make deliberate rather than implicit.
  ['payroll_sod_override', 'Payroll SoD Override'],
  // Phase 2I: cross-entity read override. Like the SoD override, granted to
  // NO role by default — including Operations Director — so stepping across
  // the tenant boundary is always a deliberate, auditable decision.
  ['payroll_entity_override', 'Cross-Entity Read Override'],
  ['worker_services', 'Worker Services'],
  ['occupational_health', 'Occupational Health'],
  ['hse_compliance', 'HSE & Compliance'],
  ['equipment_resource', 'Equipment & Resource'],
  ['contractor_control', 'Contractor Control'],
  ['customer_control', 'Customer Control'],
  ['commercial', 'Commercial'],
  ['reports_analytics', 'Reports & Analytics'],
  ['documents', 'Documents'],
  ['demobilization', 'Demobilization'],
  ['settings', 'Settings'],
  ['users', 'User Administration'],
  ['roles', 'Role Administration'],
  ['audit', 'Audit Log'],
];

const ROLES = [
  ['operations_director', 'Operations Director'],
  ['workforce_manager', 'Workforce Manager'],
  ['hrd_officer', 'HRD Officer'],
  ['payroll_officer', 'Payroll Officer'],
  ['occupational_health', 'Occupational Health'],
  ['hse_officer', 'HSE Officer'],
  // Attendance A3: the front-line role that spots a wrong clock and raises a
  // correction. It can REQUEST, never approve its own request, and its audit
  // visibility is limited to its own activity (no correction APPROVE).
  ['supervisor', 'Supervisor'],
];

// role_code -> { module_code: [actions] }
const ALL_ACTIONS = ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT', 'ADMIN'];

const ROLE_PERMISSIONS = {
  // Operations Director holds every action on every module EXCEPT the SoD
  // override. Without this exclusion the Director would silently be able to
  // approve payroll they prepared themselves, defeating the control.
  // Granting the override is an explicit, auditable RBAC decision.
  operations_director: {
    ...Object.fromEntries(
    // The two payroll overrides are excluded here; the attendance override
    // (A3) is excluded by the second filter for exactly the same reason — an
    // override must always be an explicit, auditable RBAC decision, never a
    // side effect of seniority.
    MODULES.filter(([m]) => ![SOD_OVERRIDE_MODULE, ENTITY_OVERRIDE_MODULE].includes(m))
      .filter(([m]) => m !== ATTENDANCE_OVERRIDE_MODULE)
      .map(([m]) => [m, ALL_ACTIONS])
  ),
    // A4 CP1: pinned, never ALL_ACTIONS (no APPROVE/REJECT/EXPORT until a checkpoint needs them).
    attendance_period: ['VIEW', 'CREATE', 'EDIT'],
    attendance_closing_policy: ['VIEW', 'CREATE', 'EDIT', 'ADMIN'],
    attendance_readiness: ['VIEW', 'APPROVE'],   // A4 CP2: pinned
  },

  workforce_manager: {
    home: ['VIEW'],
    command_center: ['VIEW'],
    intelligence_planning: ['VIEW', 'EXPORT'],
    talent_readiness: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    workforce_operations: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    performance_employment: ['VIEW', 'EDIT', 'EXPORT'],
    hrd_kontrak: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    timesheet_absensi: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    attendance_config: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    // A3: may request, review and approve corrections, approve LATE ones, and
    // approve a void — but never the payroll consequence, and never their own
    // request (SoD is enforced by stable user ID, not by role).
    attendance_correction: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT'],
    attendance_void: ['VIEW', 'CREATE', 'APPROVE', 'REJECT'],
    attendance_late_correction: ['APPROVE'],
    attendance_exception: ['VIEW', 'EDIT'],
    attendance_payroll_impact: ['VIEW'],
    attendance_audit: ['VIEW', 'EXPORT'],
    attendance_period: ['VIEW', 'CREATE', 'EDIT'],   // A4 CP1
    attendance_closing_policy: ['VIEW'],              // A4 CP1
    attendance_readiness: ['VIEW', 'APPROVE'],        // A4 CP2
    payroll_config: ['VIEW'],
    payroll_run: ['VIEW'],
    payroll_payment: ['VIEW'],
    worker_services_config: ['VIEW'],
    client_billing: ['VIEW'],
    worker_services: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    occupational_health: ['VIEW'],
    hse_compliance: ['VIEW'],
    equipment_resource: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    contractor_control: ['VIEW', 'EDIT', 'EXPORT'],
    customer_control: ['VIEW', 'EXPORT'],
    reports_analytics: ['VIEW', 'EXPORT'],
    documents: ['VIEW', 'CREATE', 'EXPORT'],
    demobilization: ['VIEW', 'CREATE', 'EDIT'],
  },

  hrd_officer: {
    home: ['VIEW'],
    hrd_kontrak: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'], // no APPROVE/REJECT — contract
    // extend/terminate approval stays with Workforce Manager / Operations Director
    timesheet_absensi: ['VIEW'],
    attendance_config: ['VIEW'],
    attendance_correction: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT'],
    attendance_void: ['VIEW', 'CREATE'],      // may request a void, not approve one
    attendance_late_correction: ['APPROVE'],
    attendance_exception: ['VIEW', 'EDIT'],
    attendance_audit: ['VIEW'],
    attendance_period: ['VIEW'],                      // A4 CP1
    attendance_closing_policy: ['VIEW'],              // A4 CP1
    attendance_readiness: ['VIEW'],                   // A4 CP2
    payroll_config: ['VIEW'],
    payroll_run: ['VIEW'],
    payroll_payment: ['VIEW'],
    talent_readiness: ['VIEW'],
    worker_services: ['VIEW'],
    documents: ['VIEW', 'CREATE', 'EXPORT'],
  },

  // A3: front-line supervisor. Requests corrections; approves nothing.
  supervisor: {
    home: ['VIEW'],
    workforce_operations: ['VIEW'],
    timesheet_absensi: ['VIEW', 'CREATE'],
    attendance_config: ['VIEW'],
    attendance_correction: ['VIEW', 'CREATE'],
    attendance_void: ['VIEW', 'CREATE'],
    attendance_exception: ['VIEW'],
    attendance_audit: ['VIEW'],   // own activity only — see routes/attendance-correction.js
  },

  payroll_officer: {
    home: ['VIEW'],
    workforce_operations: ['VIEW'], // read-only
    payroll_bpjs: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    hrd_kontrak: ['VIEW'], // read-only, fields scoped in routes/hrd.js
    timesheet_absensi: ['VIEW'], // read-only — needs work/overtime hours for payroll runs
    attendance_config: ['VIEW'],  // read-only: payroll reads schedules, never sets them
    // A3: the Payroll Officer never edits raw attendance. They review the
    // FINANCIAL consequence of a correction that attendance already approved.
    attendance_correction: ['VIEW'],
    attendance_exception: ['VIEW'],
    attendance_payroll_impact: ['VIEW', 'APPROVE', 'REJECT'],
    attendance_audit: ['VIEW'],
    attendance_period: ['VIEW'],                      // A4 CP1
    attendance_closing_policy: ['VIEW'],              // A4 CP1
    attendance_readiness: ['VIEW'],                   // A4 CP2
    payroll_config: ['VIEW', 'CREATE', 'EDIT', 'EXPORT', 'ADMIN'], // owns BPJS/PPh21/overtime rule setup
    // Phase 2A: may open/cut-off a period and create groups, but NOT close a
    // period — closing requires APPROVE, held by Operations Director.
    // Segregation of duties: the person running payroll is not the person
    // who signs the cycle off.
    payroll_run: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    // Phase 2H: Payroll Officer PREPARES and EXPORTS the bank file but cannot
    // AUTHORIZE the submission — that is the payment-side segregation of
    // duties, mirroring the payroll-run control.
    payroll_payment: ['VIEW', 'CREATE', 'EDIT', 'EXPORT'],
    // Phase 3A: Payroll Officer CONFIGURES worker service add-ons but cannot
    // APPROVE them — the commercial terms need a second pair of eyes, the
    // same control as payroll runs and payment batches.
    worker_services_config: ['VIEW', 'CREATE', 'EDIT'],
    // Phase 3B: Payroll Officer captures quantities and runs draft billing
    // calculations, but cannot APPROVE rates or VERIFY quantities — the
    // figures a client is charged need a second pair of eyes.
    client_billing: ['VIEW', 'CREATE', 'EDIT'],
    reports_analytics: ['VIEW', 'EXPORT'], // relevant reports only, enforced by data scope
    documents: ['VIEW', 'CREATE', 'EXPORT'],
  },

  occupational_health: {
    home: ['VIEW'],
    worker_services: ['VIEW'], // limited
    occupational_health: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    hse_compliance: ['VIEW'], // relevant compliance
    hrd_kontrak: ['VIEW'], // read-only, fields scoped in routes/hrd.js
    reports_analytics: ['VIEW', 'EXPORT'],
    documents: ['VIEW', 'CREATE', 'EXPORT'],
  },

  hse_officer: {
    home: ['VIEW'],
    worker_services: ['VIEW'], // limited
    hse_compliance: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'REJECT', 'EXPORT'],
    occupational_health: ['VIEW'], // limited
    hrd_kontrak: ['VIEW'], // read-only, fields scoped in routes/hrd.js
    reports_analytics: ['VIEW', 'EXPORT'],
    documents: ['VIEW', 'CREATE', 'EXPORT'],
  },
};

const PROJECT = {
  code: 'PPB_BALONGAN',
  name: 'PPB Balongan',
  location: 'Indramayu, Jawa Barat',
  status: 'ACTIVE',
};

const DEMO_USERS = [
  {
    email: 'director@kahe360.local',
    display_name: 'Andi Dharma',
    role: 'operations_director',
    scope: 'ALL_PROJECTS',
  },
  {
    email: 'workforce@kahe360.local',
    display_name: 'Demo Workforce Manager',
    role: 'workforce_manager',
    scope: 'PPB_BALONGAN',
  },
  {
    email: 'hrd@kahe360.local',
    display_name: 'Demo HRD Officer',
    role: 'hrd_officer',
    scope: 'PPB_BALONGAN',
  },
  {
    email: 'payroll@kahe360.local',
    display_name: 'Demo Payroll Officer',
    role: 'payroll_officer',
    scope: 'PPB_BALONGAN',
  },
  {
    email: 'health@kahe360.local',
    display_name: 'Demo Occupational Health',
    role: 'occupational_health',
    scope: 'PPB_BALONGAN',
  },
  {
    email: 'hse@kahe360.local',
    display_name: 'Demo HSE Officer',
    role: 'hse_officer',
    scope: 'PPB_BALONGAN',
  },
];

async function upsertRole(db, code, name) {
  await db.prepare('INSERT INTO roles (code, name) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name').run(code, name);
  return (await db.prepare('SELECT id FROM roles WHERE code = ?').get(code)).id;
}

async function upsertPermission(db, code, description) {
  await db.prepare('INSERT INTO permissions (code, description) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET description = excluded.description').run(code, description);
  return (await db.prepare('SELECT id FROM permissions WHERE code = ?').get(code)).id;
}

async function seed() {
  const db = getDb();
  await initDb(db);

  const roleIds = {};
  for (const [code, name] of ROLES) roleIds[code] = await upsertRole(db, code, name);

  const permIds = {};
  for (const [code, name] of MODULES) permIds[code] = await upsertPermission(db, code, name);

  const clearRolePerms = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
  const insertRolePerm = db.prepare(
    'INSERT INTO role_permissions (role_id, permission_id, action) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
  );

  for (const [roleCode, modules] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIds[roleCode];
    await clearRolePerms.run(roleId);
    for (const [moduleCode, actions] of Object.entries(modules)) {
      const permId = permIds[moduleCode];
      if (!permId) continue;
      for (const action of actions) {
        await insertRolePerm.run(roleId, permId, action);
      }
    }
  }

  await db.prepare(
    `INSERT INTO projects (code, name, location, status)
     VALUES (@code, @name, @location, @status)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, location = excluded.location, status = excluded.status`
  ).run(PROJECT);

  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS);

  const upsertUser = db.prepare(
    `INSERT INTO users (email, display_name, password_hash, is_active)
     VALUES (@email, @display_name, @password_hash, 1)
     ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash, is_active = 1`
  );
  const getUserId = db.prepare('SELECT id FROM users WHERE email = ?');
  const clearUserRoles = db.prepare('DELETE FROM user_roles WHERE user_id = ?');
  const insertUserRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
  const clearUserScope = db.prepare('DELETE FROM user_project_scope WHERE user_id = ?');
  const insertUserScope = db.prepare('INSERT INTO user_project_scope (user_id, project_code) VALUES (?, ?) ON CONFLICT DO NOTHING');

  for (const u of DEMO_USERS) {
    await upsertUser.run({ email: u.email, display_name: u.display_name, password_hash: passwordHash });
    const userId = (await getUserId.get(u.email)).id;
    await clearUserRoles.run(userId);
    await insertUserRole.run(userId, roleIds[u.role]);
    await clearUserScope.run(userId);
    await insertUserScope.run(userId, u.scope);
  }


  // ============================================================
  // Payroll Configuration foundation — default data (2026-09-14)
  // 8 modular domains. Every value here is versioned by effective_date;
  // nothing is hardcoded into application logic (see routes/payroll-config/*
  // and the future Payroll Calculation Engine, which reads these tables).
  // ============================================================

  // Domain 2: JKK Risk Class rates (Kepmenaker risk categories)
  // B3: rates are integer basis points (24 = 0.24%). See lib/money.js.
  const JKK_RISK_CLASSES = [
    ['very_low', 24, '2026-01-01', 'Risiko sangat rendah'],
    ['low', 54, '2026-01-01', 'Risiko rendah'],
    ['medium', 89, '2026-01-01', 'Risiko sedang'],
    ['high', 127, '2026-01-01', 'Risiko tinggi (mis. konstruksi)'],
    ['very_high', 174, '2026-01-01', 'Risiko sangat tinggi'],
  ];
  const insertJkk = db.prepare(
    `INSERT INTO jkk_risk_classes (risk_class, rate_bp, effective_date, source_note)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM jkk_risk_classes WHERE risk_class = ? AND end_date IS NULL)`
  );
  for (const [riskClass, rate, effDate, note] of JKK_RISK_CLASSES) {
    await insertJkk.run(riskClass, rate, effDate, note, riskClass);
  }

  // Domain 1: Legal Entity Master — KAHE 360 itself, as the default internal entity
  await db.prepare(
    `INSERT INTO legal_entities (id, name, entity_type, jkk_risk_class, effective_date, created_by)
     SELECT 'KAHE360', 'KAHE 360 Workforce Solutions', 'internal', 'high', '2026-01-01', 'system_seed'
     WHERE NOT EXISTS (SELECT 1 FROM legal_entities WHERE id = 'KAHE360')`
  ).run();

  // Domain 5: Work Patterns (5-day / 6-day week, PP 35/2021 Pasal 21)
  const WORK_PATTERNS = [
    ['5 Hari Kerja', 5, 'sunday', '2026-01-01'],
    ['6 Hari Kerja', 6, 'sunday', '2026-01-01'],
  ];
  const insertWorkPattern = db.prepare(
    `INSERT INTO work_patterns (name, days_per_week, weekly_rest_day, effective_date)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM work_patterns WHERE name = ?)`
  );
  for (const [name, days, rest, eff] of WORK_PATTERNS) await insertWorkPattern.run(name, days, rest, eff, name);

  // Phase 2A: a default monthly payroll group for the internal entity, plus
  // its 2026 periods. Cutoff/pay policy is expressed as OFFSETS so nothing
  // company-specific is hardcoded; change the offsets, not the code.
  await db.prepare(
    `INSERT INTO payroll_groups
       (code, name, legal_entity_id, project_code, frequency, periods_per_year,
        attendance_cutoff_offset_days, overtime_cutoff_offset_days,
        adjustment_cutoff_offset_days, payment_offset_days, effective_from, created_by)
     SELECT 'KAHE-MONTHLY', 'KAHE 360 Bulanan', 'KAHE360', NULL, 'monthly', 12,
            0, 0, 2, 5, '2026-01-01', 'system_seed'
     WHERE NOT EXISTS (SELECT 1 FROM payroll_groups WHERE code = 'KAHE-MONTHLY' AND effective_to IS NULL)`
  ).run();

  const defaultGroup = await db.prepare(
    `SELECT * FROM payroll_groups WHERE code = 'KAHE-MONTHLY' AND effective_to IS NULL`
  ).get();
  if (defaultGroup) {
    const pp = require('../lib/payrollPeriod');
    const insertPeriod = db.prepare(`
      INSERT INTO payroll_periods
        (payroll_group_id, period_year, period_sequence, period_month,
         period_start, period_end, attendance_cutoff, overtime_cutoff,
         adjustment_cutoff, payment_date, status, created_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'system_seed'
      WHERE NOT EXISTS (
        SELECT 1 FROM payroll_periods WHERE payroll_group_id = ? AND period_year = ? AND period_sequence = ?
      )
    `);
    for (let month = 1; month <= 12; month += 1) {
      const w = pp.monthlyWindow(2026, month);
      const d = pp.deriveDates(defaultGroup, w.periodStart, w.periodEnd);
      await insertPeriod.run(
        defaultGroup.id, 2026, month, month,
        d.period_start, d.period_end, d.attendance_cutoff, d.overtime_cutoff,
        d.adjustment_cutoff, d.payment_date,
        defaultGroup.id, 2026, month
      );
    }

    // Link existing payroll assignments that have no group yet.
    await db.prepare(
      `UPDATE employee_payroll_assignments SET payroll_group_id = ?
       WHERE payroll_group_id IS NULL AND legal_entity_id = ?`
    ).run(defaultGroup.id, defaultGroup.legal_entity_id);
  }

  // Domain 8: default global Work Calendar (Phase 1B). Employees resolve to
  // this unless their assignment or legal entity points at a more specific one.
  await db.prepare(
    `INSERT INTO work_calendars (code, name, legal_entity_id, project_code, effective_from, created_by)
     SELECT 'DEFAULT', 'Kalender Kerja Default', NULL, NULL, '2026-01-01', 'system_seed'
     WHERE NOT EXISTS (SELECT 1 FROM work_calendars WHERE code = 'DEFAULT' AND effective_to IS NULL)`
  ).run();

  // Domain 4: Holiday calendar 2026 (SKB 3 Menteri No. 1497/2/5 Tahun 2025)
  const HOLIDAYS_2026 = [
    ['2026-01-01', 'Tahun Baru Masehi'],
    ['2026-01-16', 'Isra Mikraj Nabi Muhammad SAW'],
    ['2026-02-16', 'Cuti Bersama Imlek'],
    ['2026-02-17', 'Tahun Baru Imlek 2577 Kongzili'],
    ['2026-03-18', 'Cuti Bersama Nyepi'],
    ['2026-03-19', 'Hari Suci Nyepi (Tahun Baru Saka 1948)'],
    ['2026-03-20', 'Cuti Bersama Idul Fitri'],
    ['2026-03-21', 'Idul Fitri 1447 Hijriah (Hari Pertama)'],
    ['2026-03-22', 'Idul Fitri 1447 Hijriah (Hari Kedua)'],
    ['2026-03-23', 'Cuti Bersama Idul Fitri'],
    ['2026-03-24', 'Cuti Bersama Idul Fitri'],
    ['2026-04-03', 'Wafat Yesus Kristus'],
    ['2026-04-05', 'Kebangkitan Yesus Kristus (Paskah)'],
    ['2026-05-01', 'Hari Buruh Internasional'],
    ['2026-05-14', 'Kenaikan Yesus Kristus'],
    ['2026-05-15', 'Cuti Bersama Kenaikan Yesus Kristus'],
    ['2026-05-27', 'Idul Adha 1447 Hijriah'],
    ['2026-05-28', 'Cuti Bersama Idul Adha'],
    ['2026-05-31', 'Hari Raya Waisak 2570 BE'],
    ['2026-06-01', 'Hari Lahir Pancasila'],
    ['2026-06-16', 'Tahun Baru Islam 1448 Hijriah'],
    ['2026-08-17', 'Hari Kemerdekaan RI'],
    ['2026-08-25', 'Maulid Nabi Muhammad SAW'],
    ['2026-12-24', 'Cuti Bersama Natal'],
    ['2026-12-25', 'Hari Raya Natal'],
  ];
  const insertHoliday = db.prepare(
    `INSERT INTO holidays (date, name, scope, created_by) VALUES (?, ?, 'national', 'system_seed') ON CONFLICT DO NOTHING`
  );
  for (const [date, name] of HOLIDAYS_2026) await insertHoliday.run(date, name);

  // Domain 3: Payroll Rule Set — BPJS 2026 rates + PP 35/2021 overtime +
  // PMK 168/2023 TER bracket table. Only seeded once (first run); later
  // updates go through POST /api/payroll-config/rule-sets + /activate.
  const existingRuleSet = await db.prepare(`SELECT id FROM payroll_rule_sets WHERE status = 'active' AND end_date IS NULL`).get();
  if (!existingRuleSet) {
    const ruleSetInfo = await db.prepare(`
      INSERT INTO payroll_rule_sets (
        name, status, effective_date,
        bpjs_kesehatan_rate_employee_bp, bpjs_kesehatan_rate_company_bp, bpjs_kesehatan_salary_cap_sen,
        jht_rate_employee_bp, jht_rate_company_bp, jp_rate_employee_bp, jp_rate_company_bp, jp_salary_cap_sen,
        jkm_rate_bp, overtime_hourly_divisor, overtime_is_taxable, overtime_is_bpjs_base, created_by
      ) VALUES (
        'BPJS 2026 & PMK 168/2023 (default)', 'active', '2026-01-01',
        -- B3: *_bp = basis points (100 = 1%), *_sen = integer sen (Rp x 100)
        100, 400, 1200000000,
        200, 370, 100, 200, 1054740000,
        30, 173, 1, 0, 'system_seed'
      ) RETURNING id
    `).run();
    const ruleSetId = ruleSetInfo.lastInsertRowid;

    const insertTer = db.prepare(
      'INSERT INTO ptkp_ter_rates (rule_set_id, category, income_min_sen, income_max_sen, rate_bp) VALUES (?, ?, ?, ?, ?)'
    );
    for (const [cat, lo, hi, rate] of [
      ['A', 0, 540000000, 0],
      ['A', 540000000, 565000000, 25],
      ['A', 565000000, 595000000, 50],
      ['A', 595000000, 630000000, 75],
      ['A', 630000000, 675000000, 100],
      ['A', 675000000, 750000000, 125],
      ['A', 750000000, 855000000, 150],
      ['A', 855000000, 965000000, 175],
      ['A', 965000000, 1005000000, 200],
      ['A', 1005000000, 1035000000, 225],
      ['A', 1035000000, 1070000000, 250],
      ['A', 1070000000, 1105000000, 275],
      ['A', 1105000000, 1160000000, 300],
      ['A', 1160000000, 1250000000, 325],
      ['A', 1250000000, 1375000000, 350],
      ['A', 1375000000, 1510000000, 375],
      ['A', 1510000000, 1695000000, 400],
      ['A', 1695000000, 1975000000, 425],
      ['A', 1975000000, 2415000000, 450],
      ['A', 2415000000, 2645000000, 475],
      ['A', 2645000000, 2800000000, 500],
      ['A', 2800000000, 3005000000, 525],
      ['A', 3005000000, 3240000000, 550],
      ['A', 3240000000, 3540000000, 575],
      ['A', 3540000000, 3910000000, 600],
      ['A', 3910000000, 4385000000, 625],
      ['A', 4385000000, 4780000000, 650],
      ['A', 4780000000, 5140000000, 675],
      ['A', 5140000000, 5630000000, 700],
      ['A', 5630000000, 6220000000, 725],
      ['A', 6220000000, 6860000000, 750],
      ['A', 6860000000, 7750000000, 775],
      ['A', 7750000000, 8900000000, 800],
      ['A', 8900000000, 10300000000, 850],
      ['A', 10300000000, 12500000000, 900],
      ['A', 12500000000, 15700000000, 950],
      ['A', 15700000000, 20600000000, 1000],
      ['A', 20600000000, 33700000000, 1500],
      ['A', 33700000000, 45400000000, 2000],
      ['A', 45400000000, 55000000000, 2500],
      ['A', 55000000000, 140000000000, 3000],
      ['A', 140000000000, null, 3400],
      ['B', 0, 620000000, 0],
      ['B', 620000000, 650000000, 25],
      ['B', 650000000, 685000000, 50],
      ['B', 685000000, 730000000, 75],
      ['B', 730000000, 920000000, 100],
      ['B', 920000000, 1075000000, 125],
      ['B', 1075000000, 1125000000, 150],
      ['B', 1125000000, 1160000000, 175],
      ['B', 1160000000, 1260000000, 200],
      ['B', 1260000000, 1360000000, 225],
      ['B', 1360000000, 1495000000, 250],
      ['B', 1495000000, 1640000000, 275],
      ['B', 1640000000, 1845000000, 300],
      ['B', 1845000000, 2185000000, 325],
      ['B', 2185000000, 2600000000, 350],
      ['B', 2600000000, 2770000000, 375],
      ['B', 2770000000, 2935000000, 400],
      ['B', 2935000000, 3145000000, 425],
      ['B', 3145000000, 3395000000, 450],
      ['B', 3395000000, 3710000000, 475],
      ['B', 3710000000, 4110000000, 500],
      ['B', 4110000000, 4580000000, 525],
      ['B', 4580000000, 4950000000, 550],
      ['B', 4950000000, 5380000000, 575],
      ['B', 5380000000, 5850000000, 600],
      ['B', 5850000000, 6400000000, 625],
      ['B', 6400000000, 7100000000, 650],
      ['B', 7100000000, 8000000000, 675],
      ['B', 8000000000, 9300000000, 700],
      ['B', 9300000000, 10900000000, 725],
      ['B', 10900000000, 12900000000, 750],
      ['B', 12900000000, 16300000000, 800],
      ['B', 16300000000, 21100000000, 850],
      ['B', 21100000000, 37400000000, 900],
      ['B', 37400000000, 45900000000, 1500],
      ['B', 45900000000, 55500000000, 2000],
      ['B', 55500000000, 70400000000, 2500],
      ['B', 70400000000, 140500000000, 3000],
      ['B', 140500000000, null, 3400],
      ['C', 0, 660000000, 0],
      ['C', 660000000, 695000000, 25],
      ['C', 695000000, 735000000, 50],
      ['C', 735000000, 780000000, 75],
      ['C', 780000000, 885000000, 100],
      ['C', 885000000, 980000000, 125],
      ['C', 980000000, 1095000000, 150],
      ['C', 1095000000, 1120000000, 175],
      ['C', 1120000000, 1205000000, 200],
      ['C', 1205000000, 1295000000, 225],
      ['C', 1295000000, 1415000000, 250],
      ['C', 1415000000, 1555000000, 275],
      ['C', 1555000000, 1705000000, 300],
      ['C', 1705000000, 1950000000, 325],
      ['C', 1950000000, 2270000000, 350],
      ['C', 2270000000, 2660000000, 375],
      ['C', 2660000000, 2810000000, 400],
      ['C', 2810000000, 3010000000, 425],
      ['C', 3010000000, 3260000000, 450],
      ['C', 3260000000, 3540000000, 475],
      ['C', 3540000000, 3890000000, 500],
      ['C', 3890000000, 4300000000, 525],
      ['C', 4300000000, 4740000000, 550],
      ['C', 4740000000, 5120000000, 575],
      ['C', 5120000000, 5580000000, 600],
      ['C', 5580000000, 6040000000, 625],
      ['C', 6040000000, 6670000000, 650],
      ['C', 6670000000, 7450000000, 675],
      ['C', 7450000000, 8320000000, 700],
      ['C', 8320000000, 9560000000, 725],
      ['C', 9560000000, 11000000000, 750],
      ['C', 11000000000, 13400000000, 800],
      ['C', 13400000000, 16900000000, 850],
      ['C', 16900000000, 22100000000, 900],
      ['C', 22100000000, 39000000000, 950],
      ['C', 39000000000, 46300000000, 1000],
      ['C', 46300000000, 56100000000, 1500],
      ['C', 56100000000, 70900000000, 2000],
      ['C', 70900000000, 102000000000, 2500],
      ['C', 102000000000, 141500000000, 3000],
      ['C', 141500000000, null, 3400],
    ]) await insertTer.run(ruleSetId, cat, lo, hi, rate);

    // PP 35/2021 Pasal 31: workday first hour 1.5x, subsequent hours 2x;
    // weekly-rest/public-holiday differs by 5-day vs 6-day week pattern.
    const OVERTIME_RULES = [
      // B3: multiplier on the 1/10000 scale — 1.5x = 15000, 2x = 20000.
      ['workday', 1, 1, 15000],
      ['workday', 2, null, 20000],
      ['rest_or_holiday_6day', 1, 7, 20000],
      ['rest_or_holiday_6day', 8, 8, 30000],
      ['rest_or_holiday_6day', 9, 10, 40000],
      ['rest_or_holiday_5day', 1, 8, 20000],
      ['rest_or_holiday_5day', 9, 9, 30000],
      ['rest_or_holiday_5day', 10, 11, 40000],
    ];
    const insertOvertimeRule = db.prepare(
      'INSERT INTO overtime_multiplier_rules (rule_set_id, day_type, hour_from, hour_to, multiplier_bp) VALUES (?, ?, ?, ?, ?)'
    );
    for (const [dayType, hourFrom, hourTo, mult] of OVERTIME_RULES) {
      await insertOvertimeRule.run(ruleSetId, dayType, hourFrom, hourTo, mult);
    }
  }



  // ============================================================
  // Phase 1A / B1 — Salary Component master catalogue (Domain 7)
  // These are STARTING POINTS, not hardcoded rules: every flag below is
  // editable per component and per legal entity through the UI, and a change
  // creates a new version rather than mutating these rows.
  // legal_entity_id = NULL -> available to every entity.
  // ============================================================
  const SALARY_COMPONENTS = [
    // code,        name,                 type,        calc,       paid_by,    taxable, bpjs_base, ot_base, proratable, recurrence,   order
    ['BASIC',       'Gaji Pokok',         'earning',   'fixed',    'employee', 1, 1, 1, 1, 'recurring', 10],
    ['ALLOW_FIXED', 'Tunjangan Tetap',    'earning',   'fixed',    'employee', 1, 1, 1, 1, 'recurring', 20],
    ['ALLOW_SITE',  'Tunjangan Lokasi',   'earning',   'fixed',    'employee', 1, 0, 0, 1, 'recurring', 30],
    ['ALLOW_MEAL',  'Tunjangan Makan',    'earning',   'variable', 'employee', 1, 0, 0, 1, 'recurring', 40],
    ['ALLOW_TRANS', 'Tunjangan Transport','earning',   'variable', 'employee', 1, 0, 0, 1, 'recurring', 50],
    ['BONUS',       'Bonus',              'earning',   'variable', 'employee', 1, 0, 0, 0, 'one_time',  60],
    ['DED_LOAN',    'Potongan Pinjaman',  'deduction', 'fixed',    'employee', 0, 0, 0, 0, 'recurring', 200],
    ['DED_MESS',    'Potongan Mess',      'deduction', 'fixed',    'employee', 0, 0, 0, 1, 'recurring', 210],
  ];
  const insertComponent = db.prepare(`
    INSERT INTO salary_components
      (code, name, component_type, calculation_type, paid_by, is_taxable, is_bpjs_base,
       is_overtime_base, is_proratable, recurrence, calculation_order, legal_entity_id,
       effective_from, created_by)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '2026-01-01', 'system_seed'
    WHERE NOT EXISTS (
      SELECT 1 FROM salary_components WHERE code = ? AND legal_entity_id IS NULL AND effective_to IS NULL
    )
  `);
  for (const [code, name, type, calc, paidBy, taxable, bpjsBase, otBase, proratable, recurrence, order] of SALARY_COMPONENTS) {
    await insertComponent.run(code, name, type, calc, paidBy, taxable, bpjsBase, otBase, proratable, recurrence, order, code);
  }

  // Phase 2I: demo entity scope. Every demo user is scoped to KAHE360 only —
  // deliberately NOT to every entity, so the isolation boundary is visible in
  // the demo data rather than silently bypassed.
  const scopeUsers = await db.prepare('SELECT id FROM users').all();
  const grantScope = db.prepare(
    `INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by, note)
     VALUES (?, 'KAHE360', 'system_seed', 'demo scope — KAHE360 only') ON CONFLICT DO NOTHING`
  );
  for (const u of scopeUsers) await grantScope.run(u.id);

  db.close();

  console.log('KAHE 360: seed complete.');
  console.log('Demo users (password for all:', DEMO_PASSWORD + '):');
  for (const u of DEMO_USERS) console.log('  -', u.email, '(' + u.role + ')');
  console.log('\nDEMO CREDENTIALS ONLY. REMOVE BEFORE PRODUCTION.');
}

if (require.main === module) {
  await seed();
}

module.exports = { seed, MODULES, ROLES, ROLE_PERMISSIONS, DEMO_USERS, DEMO_PASSWORD, SOD_OVERRIDE_MODULE, ENTITY_OVERRIDE_MODULE };

})().catch((err) => { console.error(err); process.exit(1); });
