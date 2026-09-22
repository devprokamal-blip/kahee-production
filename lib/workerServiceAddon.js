// lib/workerServiceAddon.js
// Phase 3A — Add-on Benefit / Worker Service model.
//
// ============================================================
// ARCHITECTURE LOCK
// ============================================================
// Transport, Meals and Accommodation are NOT mandatory payroll allowances.
// They are optional, configurable worker services with several possible
// delivery modes, of which exactly one per category is cash.
//
// The three states are kept strictly apart:
//
//   CASH_ALLOWANCE     → MAY become a payroll salary component, and only
//                        when the delivery mode is explicitly a cash mode.
//   BENEFIT_IN_KIND    → a real service (shuttle, catering, mess, camp…).
//                        Real cost, possibly billable, ZERO payroll impact.
//   NOT_PROVIDED       → nothing at all. No payroll component, and
//                        emphatically no zero-rupiah placeholder line.
//
// Employee entitlement and client billability are INDEPENDENT. A client may
// refuse to reimburse something KAHE still bears; a client may provide
// something directly that never touches KAHE payroll at all.
//
// THIS MODULE NEVER WRITES TO PAYROLL. It resolves configuration and reports
// what a future payroll or billing run may do with it. A test greps this file
// for writes to any payroll table.

const ADDON_TYPE = { TRANSPORT: 'TRANSPORT', MEALS: 'MEALS', ACCOMMODATION: 'ACCOMMODATION' };

/** Delivery modes per category. A mode is only legal for its own category. */
const DELIVERY_MODES = {
  // Phase 3B widened the transport catalogue. The database column has no CHECK
  // constraint, so the list lives here and only here — adding a mode needs no
  // migration. Only CASH_ALLOWANCE is cash; every addition below is in kind.
  TRANSPORT: ['CASH_ALLOWANCE', 'SHUTTLE_SERVICE', 'CLIENT_PROVIDED_TRANSPORT',
    'KAHE_PROVIDED_TRANSPORT', 'THIRD_PARTY_TRANSPORT', 'DEDICATED_VEHICLE',
    'POOL_VEHICLE', 'BUS', 'MINIBUS', 'PICKUP_DROP_SERVICE', 'CUSTOM', 'NOT_PROVIDED'],
  MEALS: ['CASH_ALLOWANCE', 'CATERING', 'CLIENT_CANTEEN',
    'KAHE_PROVIDED_MEALS', 'THIRD_PARTY_CATERING', 'CUSTOM', 'NOT_PROVIDED'],
  ACCOMMODATION: ['HOUSING_ALLOWANCE', 'KAHE_MESS', 'CLIENT_CAMP',
    'THIRD_PARTY_HOUSING', 'HOTEL_LODGING', 'CUSTOM', 'NOT_PROVIDED'],
};

/**
 * THE cash list. This is the single place that decides whether an add-on can
 * ever become a payroll component. Everything else is a service in kind.
 */
const CASH_MODES = new Set(['CASH_ALLOWANCE', 'HOUSING_ALLOWANCE']);

const NATURE = {
  CASH_ALLOWANCE: 'CASH_ALLOWANCE',
  BENEFIT_IN_KIND: 'BENEFIT_IN_KIND',
  NOT_PROVIDED: 'NOT_PROVIDED',
};

const COST_BEARER = { CLIENT: 'CLIENT', KAHE: 'KAHE', SHARED: 'SHARED',
  THIRD_PARTY: 'THIRD_PARTY', NOT_APPLICABLE: 'NOT_APPLICABLE' };
const BILLING_TREATMENT = { SEPARATE: 'SEPARATE', BUNDLED: 'BUNDLED', NON_BILLABLE: 'NON_BILLABLE' };
const ENTITLEMENT = { ENTITLED: 'ENTITLED', NOT_ENTITLED: 'NOT_ENTITLED', OPTIONAL: 'OPTIONAL' };
const QUANTITY_BASIS = ['PER_WORKER_PER_DAY', 'PER_WORKER_PER_MONTH', 'PER_WORKER_PER_TRIP',
  'PER_ATTENDANCE_DAY', 'PER_HEADCOUNT', 'FLAT', 'NOT_APPLICABLE'];
const STATUS = { DRAFT: 'DRAFT', ACTIVE: 'ACTIVE', SUPERSEDED: 'SUPERSEDED', CANCELLED: 'CANCELLED' };

const ERROR = {
  VALIDATION: 'VALIDATION',
  INVALID_MODE_FOR_TYPE: 'INVALID_MODE_FOR_TYPE',
  CASH_REQUIRES_COMPONENT: 'CASH_REQUIRES_COMPONENT',
  COMPONENT_ON_NON_CASH: 'COMPONENT_ON_NON_CASH',
  NOT_PROVIDED_HAS_TERMS: 'NOT_PROVIDED_HAS_TERMS',
  OVERLAPPING_VERSION: 'OVERLAPPING_VERSION',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  ENTITY_MISMATCH: 'ENTITY_MISMATCH',
  SOD_VIOLATION: 'SOD_VIOLATION',
};

class AddonError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.name = 'AddonError'; this.code = code; this.detail = detail;
  }
}

/** Is this configuration cash, a service in kind, or nothing at all? */
function natureOf(addon) {
  if (!addon) return NATURE.NOT_PROVIDED;
  if (Number(addon.enabled) === 0) return NATURE.NOT_PROVIDED;
  if (addon.delivery_mode === 'NOT_PROVIDED') return NATURE.NOT_PROVIDED;
  return CASH_MODES.has(addon.delivery_mode) ? NATURE.CASH_ALLOWANCE : NATURE.BENEFIT_IN_KIND;
}

const isCashMode = (mode) => CASH_MODES.has(mode);

/**
 * Validate a configuration before it is stored. The rules here are the
 * architecture lock expressed as code.
 */
function validateConfig(input) {
  const errors = [];
  const add = (code, msg) => errors.push({ code, message: msg });

  if (!ADDON_TYPE[input.addon_type]) {
    add(ERROR.VALIDATION, `addon_type tidak dikenal: ${input.addon_type}`);
    throw new AddonError(ERROR.VALIDATION, errors[0].message, { errors });
  }
  const legalModes = DELIVERY_MODES[input.addon_type];
  if (!legalModes.includes(input.delivery_mode)) {
    add(ERROR.INVALID_MODE_FOR_TYPE,
      `delivery_mode ${input.delivery_mode} tidak berlaku untuk ${input.addon_type}. `
      + `Yang berlaku: ${legalModes.join(', ')}`);
  }
  if (input.cost_bearer && !COST_BEARER[input.cost_bearer]) add(ERROR.VALIDATION, `cost_bearer tidak dikenal: ${input.cost_bearer}`);
  if (input.billing_treatment && !BILLING_TREATMENT[input.billing_treatment]) add(ERROR.VALIDATION, `billing_treatment tidak dikenal: ${input.billing_treatment}`);
  if (input.employee_entitlement && !ENTITLEMENT[input.employee_entitlement]) add(ERROR.VALIDATION, `employee_entitlement tidak dikenal: ${input.employee_entitlement}`);
  if (input.quantity_basis && !QUANTITY_BASIS.includes(input.quantity_basis)) add(ERROR.VALIDATION, `quantity_basis tidak dikenal: ${input.quantity_basis}`);
  if (input.rate_sen !== undefined && input.rate_sen !== null && !Number.isInteger(input.rate_sen)) {
    add(ERROR.VALIDATION, 'rate_sen harus bilangan bulat (sen).');
  }
  if (!input.effective_from) add(ERROR.VALIDATION, 'effective_from wajib diisi.');
  if (!input.legal_entity_id) add(ERROR.VALIDATION, 'legal_entity_id wajib diisi.');

  // Phase 3B: billability is YES / NO / CONDITIONAL. The Phase 3A integer is
  // the boolean projection; CONDITIONAL is never billed automatically.
  if (input.client_billable_mode && !['YES','NO','CONDITIONAL'].includes(input.client_billable_mode)) {
    add(ERROR.VALIDATION, `client_billable_mode tidak dikenal: ${input.client_billable_mode}`);
  }
  if (input.client_billable_mode === 'CONDITIONAL' && !input.billable_condition) {
    add(ERROR.VALIDATION, 'client_billable_mode CONDITIONAL memerlukan billable_condition yang menjelaskan syaratnya.');
  }

  const cash = isCashMode(input.delivery_mode);
  const provided = Number(input.enabled ?? 1) === 1 && input.delivery_mode !== 'NOT_PROVIDED';

  // RULE 4 first: NOT_PROVIDED must be genuinely nothing — no rate, no
  // bearer, no billing, no component — so it can never be mistaken for a
  // zero-rupiah line. Checked BEFORE the cash/in-kind rules so the message
  // says what is actually wrong instead of calling it a service.
  if (!provided) {
    if (input.rate_sen) add(ERROR.NOT_PROVIDED_HAS_TERMS, 'NOT_PROVIDED tidak boleh memiliki rate.');
    if (input.payroll_component_code) add(ERROR.NOT_PROVIDED_HAS_TERMS, 'NOT_PROVIDED tidak boleh membawa komponen gaji.');
    if (Number(input.client_billable) === 1) add(ERROR.NOT_PROVIDED_HAS_TERMS, 'NOT_PROVIDED tidak bisa ditagihkan ke klien.');
    if (input.cost_bearer && input.cost_bearer !== COST_BEARER.NOT_APPLICABLE) {
      add(ERROR.NOT_PROVIDED_HAS_TERMS, 'NOT_PROVIDED harus memiliki cost_bearer NOT_APPLICABLE.');
    }
    if (errors.length) throw new AddonError(errors[0].code, errors[0].message, { errors });
  }

  // RULE 5 (Scenario E): a cash allowance becomes a payroll component ONLY
  // when explicitly configured as one — so the component must be named.
  if (provided && cash && !input.payroll_component_code) {
    add(ERROR.CASH_REQUIRES_COMPONENT,
      'Mode tunai harus menyebut payroll_component_code secara eksplisit; komponen gaji tidak dibuat otomatis.');
  }
  // RULES 1-3: a service in kind must NEVER carry a payroll component. This is
  // the check that stops a shuttle from quietly becoming a transport allowance.
  if (provided && !cash && input.payroll_component_code) {
    add(ERROR.COMPONENT_ON_NON_CASH,
      `${input.delivery_mode} adalah layanan in-kind, bukan tunai. Layanan tidak boleh membawa `
      + 'payroll_component_code — itu akan membuat tunjangan ganda.');
  }
  // A billable add-on has to say who bears the cost and how it is billed.
  if (Number(input.client_billable) === 1 || input.client_billable_mode === 'CONDITIONAL') {
    if (!input.billing_treatment || input.billing_treatment === BILLING_TREATMENT.NON_BILLABLE) {
      add(ERROR.VALIDATION, 'client_billable = 1 memerlukan billing_treatment SEPARATE atau BUNDLED.');
    }
    if (!input.cost_bearer || input.cost_bearer === COST_BEARER.NOT_APPLICABLE) {
      add(ERROR.VALIDATION, 'client_billable = 1 memerlukan cost_bearer yang jelas.');
    }
  }
  if (input.cost_bearer === COST_BEARER.SHARED) {
    const bp = input.cost_share_kahe_bp;
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) {
      add(ERROR.VALIDATION, 'cost_bearer SHARED memerlukan cost_share_kahe_bp antara 0 dan 10000 basis point.');
    }
  }

  if (errors.length) {
    throw new AddonError(errors[0].code, errors[0].message, { errors });
  }
  return true;
}

/**
 * Create a new DRAFT version. Never activates on its own — activation is a
 * separate, approved step, so a commercial term cannot slip into force.
 */
async function createAddon(db, input, userContext) {
  validateConfig(input);

  const scopeWhere = `addon_type = ? AND legal_entity_id = ?
    AND COALESCE(client_id,-1) = COALESCE(?,-1) AND COALESCE(project_id,-1) = COALESCE(?,-1)`;
  const prior = await db.prepare(`SELECT MAX(version) AS v FROM worker_service_addons WHERE ${scopeWhere}`)
    .get(input.addon_type, input.legal_entity_id, input.client_id ?? null, input.project_id ?? null);
  const version = Number(prior.v || 0) + 1;

  const info = await db.prepare(`
    INSERT INTO worker_service_addons (
      addon_type, enabled, delivery_mode, employee_entitlement, client_billable,
      cost_bearer, cost_share_kahe_bp, billing_treatment, quantity_basis, rate_sen,
      payroll_component_code, legal_entity_id, client_id, project_id,
      version, effective_from, effective_to, status, note, created_by, created_at,
      client_billable_mode, billable_condition
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, ?, kahe_now(), ?, ?) RETURNING id
  `).run(
    input.addon_type, input.enabled ?? 1, input.delivery_mode,
    input.employee_entitlement || ENTITLEMENT.ENTITLED,
    input.client_billable ?? 0,
    input.cost_bearer || COST_BEARER.NOT_APPLICABLE,
    input.cost_share_kahe_bp ?? null,
    input.billing_treatment || BILLING_TREATMENT.NON_BILLABLE,
    input.quantity_basis || 'NOT_APPLICABLE',
    input.rate_sen ?? null,
    input.payroll_component_code ?? null,
    input.legal_entity_id, input.client_id ?? null, input.project_id ?? null,
    version, input.effective_from, input.effective_to ?? null,
    input.note ?? null, userContext.displayName,
    input.client_billable_mode || (Number(input.client_billable ?? 0) === 1 ? 'YES' : 'NO'),
    input.billable_condition ?? null
  );
  const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(info.lastInsertRowid);
  await audit(db, row.id, 'CREATED', userContext, null, row, input.note);
  return row;
}

/**
 * Approve and activate. Supersedes the previous open version by closing it
 * the day before this one starts — so "what applied on date X" always has
 * exactly one answer.
 *
 * Segregation of duties: the creator may not approve their own configuration
 * unless they hold the SoD override, mirroring the payroll controls.
 */
async function approveAddon(db, addonId, userContext, note) {
  const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(addonId);
  if (!row) throw new AddonError(ERROR.NOT_FOUND, 'Konfigurasi add-on tidak ditemukan.');
  if (row.status !== STATUS.DRAFT) {
    throw new AddonError(ERROR.INVALID_STATE, `Hanya versi DRAFT yang bisa disetujui (status: ${row.status}).`);
  }
  const hasOverride = ((userContext.permissions || {}).payroll_sod_override || []).length > 0;
  if (!hasOverride && row.created_by === userContext.displayName) {
    throw new AddonError(ERROR.SOD_VIOLATION,
      `Pemisahan tugas: ${userContext.displayName} yang membuat konfigurasi ini tidak boleh menyetujuinya sendiri.`,
      { created_by: row.created_by });
  }

  // Close the previous open ACTIVE version for the same scope.
  const prev = await db.prepare(`
    SELECT * FROM worker_service_addons
    WHERE addon_type = ? AND legal_entity_id = ?
      AND COALESCE(client_id,-1) = COALESCE(?,-1) AND COALESCE(project_id,-1) = COALESCE(?,-1)
      AND status = 'ACTIVE' AND effective_to IS NULL AND id != ?
  `).get(row.addon_type, row.legal_entity_id, row.client_id, row.project_id, row.id);

  if (prev) {
    if (prev.effective_from >= row.effective_from) {
      throw new AddonError(ERROR.OVERLAPPING_VERSION,
        `Versi aktif (#${prev.id}) berlaku sejak ${prev.effective_from}; versi baru harus berlaku setelahnya.`,
        { active_version_id: prev.id, active_effective_from: prev.effective_from });
    }
    const closeOn = previousDay(row.effective_from);
    // The trigger guards commercial terms, not the closing date — closing is
    // how history is preserved, not how it is rewritten.
    await db.prepare(`UPDATE worker_service_addons SET effective_to = ?, status = 'SUPERSEDED' WHERE id = ?`)
      .run(closeOn, prev.id);
    await audit(db, prev.id, 'SUPERSEDED', userContext, prev,
      { ...prev, effective_to: closeOn, status: 'SUPERSEDED' },
      `digantikan oleh versi #${row.id}`);
  }

  await db.prepare(`UPDATE worker_service_addons SET status='ACTIVE', approved_by=?, approved_at=kahe_now() WHERE id=?`)
    .run(userContext.displayName, row.id);
  const after = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(row.id);
  await audit(db, row.id, 'APPROVED', userContext, row, after, note);
  return after;
}

async function cancelAddon(db, addonId, userContext, reason) {
  const row = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(addonId);
  if (!row) throw new AddonError(ERROR.NOT_FOUND, 'Konfigurasi tidak ditemukan.');
  if (row.status === STATUS.SUPERSEDED) {
    throw new AddonError(ERROR.INVALID_STATE, 'Versi yang sudah digantikan adalah riwayat dan tidak bisa dibatalkan.');
  }
  if (!reason) throw new AddonError(ERROR.VALIDATION, 'Alasan pembatalan wajib diisi.');
  await db.prepare(`UPDATE worker_service_addons SET status='CANCELLED' WHERE id=?`).run(row.id);
  await audit(db, row.id, 'CANCELLED', userContext, row, { ...row, status: 'CANCELLED' }, reason);
  return await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(row.id);
}

async function audit(db, addonId, action, userContext, before, after, note) {
  await db.prepare(`INSERT INTO worker_service_addon_audit (addon_id, action, actor, before_json, after_json, note, occurred_at)
              VALUES (?,?,?,?,?,?, kahe_now())`)
    .run(addonId, action, userContext.displayName,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note ?? null);
}

function previousDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the add-on in force for one category at one date.
 *
 * SCOPE PRECEDENCE: project > client > legal entity. The most specific
 * configuration wins, so a site can override a client default without
 * duplicating every other term.
 *
 * Returns `null` when nothing is configured — and null is a legitimate,
 * fully-supported answer (Scenario D).
 */
async function resolveAddon(db, { addonType, legalEntityId, clientId = null, projectId = null, asOf }) {
  if (!asOf) throw new AddonError(ERROR.VALIDATION, 'asOf wajib diisi — konfigurasi add-on adalah effective-dated.');
  const dateBound = `effective_from <= @as_of AND (effective_to IS NULL OR effective_to >= @as_of)`;

  // node:sqlite rejects named parameters a statement does not use, so each
  // tier declares exactly the extra parameters its own SQL binds.
  const tiers = [
    { sql: 'client_id = @client_id AND project_id = @project_id',
      extra: { client_id: clientId, project_id: projectId },
      ok: clientId !== null && projectId !== null, tier: 'PROJECT' },
    { sql: 'client_id = @client_id AND project_id IS NULL',
      extra: { client_id: clientId },
      ok: clientId !== null, tier: 'CLIENT' },
    { sql: 'client_id IS NULL AND project_id IS NULL',
      extra: {},
      ok: true, tier: 'LEGAL_ENTITY' },
  ];

  for (const t of tiers) {
    if (!t.ok) continue;
    const rows = await db.prepare(`
      SELECT * FROM worker_service_addons
      WHERE addon_type = @addon_type AND legal_entity_id = @entity
        AND status IN ('ACTIVE','SUPERSEDED') AND ${dateBound} AND ${t.sql}
      ORDER BY version DESC
    `).all({ addon_type: addonType, entity: legalEntityId, as_of: asOf, ...t.extra });

    if (rows.length > 1) {
      throw new AddonError(ERROR.OVERLAPPING_VERSION,
        `${rows.length} konfigurasi ${addonType} berlaku bersamaan pada ${asOf} di tingkat ${t.tier}.`,
        { ids: rows.map((r) => r.id) });
    }
    if (rows.length === 1) return { ...rows[0], resolved_tier: t.tier };
  }
  return null;
}

/** Resolve all three categories at once. */
async function resolveAllAddons(db, scope) {
  const out = {};
  for (const type of Object.values(ADDON_TYPE)) {
    const addon = await resolveAddon(db, { ...scope, addonType: type });
    out[type] = {
      configured: addon !== null,
      nature: natureOf(addon),
      addon,
    };
  }
  return out;
}

/**
 * What a payroll run MAY add for this worker — cash modes only.
 *
 * This is a REPORT, not an action. Nothing here writes to payroll. A future
 * payroll configuration step consumes it; the engine is never touched by this
 * module.
 *
 * Returns `[]` for shuttle, catering, mess, camp and NOT_PROVIDED — and an
 * empty array means exactly that: no component, not a zero-rupiah one.
 */
async function resolvePayrollImpact(db, scope) {
  const resolved = await resolveAllAddons(db, scope);
  const components = [];
  const excluded = [];

  for (const [type, r] of Object.entries(resolved)) {
    if (r.nature === NATURE.CASH_ALLOWANCE
        && r.addon.employee_entitlement !== ENTITLEMENT.NOT_ENTITLED) {
      components.push({
        addon_type: type,
        component_code: r.addon.payroll_component_code,
        delivery_mode: r.addon.delivery_mode,
        amount_sen: r.addon.rate_sen,
        quantity_basis: r.addon.quantity_basis,
        addon_id: r.addon.id,
        addon_version: r.addon.version,
      });
    } else {
      excluded.push({
        addon_type: type,
        nature: r.nature,
        delivery_mode: r.addon ? r.addon.delivery_mode : null,
        reason: !r.configured
          ? 'tidak dikonfigurasi'
          : r.nature === NATURE.NOT_PROVIDED
            ? 'NOT_PROVIDED — tidak membuat komponen apa pun'
            : r.addon.employee_entitlement === ENTITLEMENT.NOT_ENTITLED
              ? 'karyawan tidak berhak'
              : `layanan in-kind (${r.addon.delivery_mode}) — tidak menjadi tunjangan tunai`,
      });
    }
  }
  return { components, excluded };
}

/**
 * The billable add-on lines a future Client Billing run may charge.
 * Configuration only — no amounts are multiplied out, no invoice is produced.
 */
async function resolveBillableAddons(db, scope) {
  const resolved = await resolveAllAddons(db, scope);
  const billable = [];
  const notBillable = [];

  for (const [type, r] of Object.entries(resolved)) {
    if (!r.configured || r.nature === NATURE.NOT_PROVIDED) {
      notBillable.push({ addon_type: type, reason: r.configured ? 'NOT_PROVIDED' : 'tidak dikonfigurasi' });
      continue;
    }
    const a = r.addon;
    if (Number(a.client_billable) !== 1 || a.billing_treatment === BILLING_TREATMENT.NON_BILLABLE) {
      // Scenario A / rule 6: KAHE may still bear the cost even when the
      // client will not reimburse it. That is recorded, not hidden.
      notBillable.push({
        addon_type: type, reason: 'tidak ditagihkan ke klien',
        cost_bearer: a.cost_bearer, delivery_mode: a.delivery_mode, nature: r.nature,
      });
      continue;
    }
    billable.push({
      addon_type: type,
      nature: r.nature,
      delivery_mode: a.delivery_mode,
      billing_treatment: a.billing_treatment,
      cost_bearer: a.cost_bearer,
      cost_share_kahe_bp: a.cost_share_kahe_bp,
      quantity_basis: a.quantity_basis,
      rate_sen: a.rate_sen,
      addon_id: a.id,
      addon_version: a.version,
      resolved_tier: a.resolved_tier,
    });
  }
  return { billable, notBillable };
}

/**
 * The billing BASIS skeleton a future phase will price:
 *   finalized payroll cost + optional add-ons + optional service fee.
 * Phase 3A returns the SHAPE and the configuration, never an amount.
 */
async function resolveBillingBasis(db, scope) {
  const addons = await resolveBillableAddons(db, scope);
  const fee = await resolveServiceFee(db, scope);
  return {
    scope,
    payroll_cost: { source: 'FINALIZED_PAYROLL', resolved_here: false,
      note: 'Diambil dari payroll final oleh modul Client Billing, bukan dari sini.' },
    addons: addons.billable,
    excluded_addons: addons.notBillable,
    service_fee: fee,
    // Deliberately absent: Phase 3A builds configuration, not invoices.
    amounts_calculated: false,
  };
}

/**
 * SERVICE FEE — optional and legitimately absent. A client with no
 * configuration resolves to NOT_CONFIGURED, and billing must work that way
 * rather than assume a default percentage.
 */
async function resolveServiceFee(db, { legalEntityId, clientId = null, projectId = null, asOf }) {
  if (!asOf) throw new AddonError(ERROR.VALIDATION, 'asOf wajib diisi.');
  const dateBound = `effective_from <= @as_of AND (effective_to IS NULL OR effective_to >= @as_of)`;
  const tiers = [
    { sql: 'client_id = @client_id AND project_id = @project_id',
      extra: { client_id: clientId, project_id: projectId },
      ok: clientId !== null && projectId !== null, tier: 'PROJECT' },
    { sql: 'client_id = @client_id AND project_id IS NULL',
      extra: { client_id: clientId }, ok: clientId !== null, tier: 'CLIENT' },
    { sql: 'client_id IS NULL AND project_id IS NULL',
      extra: {}, ok: true, tier: 'LEGAL_ENTITY' },
  ];
  for (const t of tiers) {
    if (!t.ok) continue;
    const row = await db.prepare(`
      SELECT * FROM service_fee_config
      WHERE legal_entity_id = @entity AND status IN ('ACTIVE','SUPERSEDED') AND ${dateBound} AND ${t.sql}
      ORDER BY version DESC LIMIT 1
    `).get({ entity: legalEntityId, as_of: asOf, ...t.extra });
    if (row) return { ...row, configured: row.fee_mode !== 'NOT_CONFIGURED', resolved_tier: t.tier };
  }
  return { fee_mode: 'NOT_CONFIGURED', configured: false, resolved_tier: null,
    note: 'Belum dikonfigurasi. Ini keadaan yang sah — penagihan tetap berjalan tanpa service fee.' };
}

module.exports = {
  ADDON_TYPE, DELIVERY_MODES, CASH_MODES, NATURE, COST_BEARER, BILLING_TREATMENT,
  ENTITLEMENT, QUANTITY_BASIS, STATUS, ERROR, AddonError,
  natureOf, isCashMode, validateConfig,
  createAddon, approveAddon, cancelAddon, audit,
  resolveAddon, resolveAllAddons, resolvePayrollImpact,
  resolveBillableAddons, resolveBillingBasis, resolveServiceFee,
  previousDay,
};
