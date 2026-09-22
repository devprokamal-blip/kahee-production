(async () => {
// tests/phase3a.test.js
// Phase 3A — Add-on Benefit / Worker Service model. Throwaway database.
// Usage: npm run test:phase3a

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const addon = require('../lib/workerServiceAddon');
const money = require('../lib/money');

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function throwsCode(fn, code, label = '') {
  try { await fn(); } catch (e) {
    if (e.code !== code) throw new Error(`${label}expected ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(`${label}expected a throw with code ${code}`);
}
async function throwsMatching(fn, re, label = '') {
  try { await fn(); } catch (e) {
    if (!re.test(e.message)) throw new Error(`${label}did not match ${re}: ${e.message}`);
    return e;
  }
  throw new Error(`${label}expected a throw matching ${re}`);
}
function section(t) { console.log(`\n${t}`); }

const TEST_DB = path.join(__dirname, 'phase3a.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase3a');
const db = __t.db;
await initDb(db);

const MAKER = { displayName: 'Config Officer', permissions: { worker_services_config: ['VIEW','CREATE','EDIT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: { worker_services_config: ['VIEW','APPROVE'] } };

// ---- fixtures -----------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('TBN','Tuban','Tuban','active')`).run();
const PRJ_PPB = (await db.prepare(`SELECT id FROM projects WHERE code='PPB'`).get()).id;
const PRJ_TBN = (await db.prepare(`SELECT id FROM projects WHERE code='TBN'`).get()).id;
for (const [id, name] of [['KAHE360','KAHE'], ['MITRA','Mitra Jaya']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2026-01-01')`).run(id, name, id === 'KAHE360' ? 'internal' : 'subkontraktor');
}
async function makeClient(code, entity) {
  return (await db.prepare(`INSERT INTO clients (code,name,legal_entity_id,created_by) VALUES (?,?,?,'test') RETURNING id`)
    .run(code, code, entity)).lastInsertRowid;
}
const CLI_WUHUAN = await makeClient('WUHUAN', 'KAHE360');
const CLI_OTHER  = await makeClient('OTHER', 'KAHE360');
const CLI_MITRA  = await makeClient('MITRA-CLI', 'MITRA');

function cfg(o) {
  return { legal_entity_id: 'KAHE360', effective_from: '2026-01-01', ...o };
}
async function create(o, actor = MAKER) {
  return await withTransaction(db, async () => await addon.createAddon(db, cfg(o), actor));
}
async function activate(o, actor = MAKER) {
  const row = await create(o, actor);
  return await withTransaction(db, async () => await addon.approveAddon(db, row.id, APPROVER, 'ok'));
}
const at = (o) => ({ legalEntityId: 'KAHE360', asOf: '2026-06-15', ...o });

// =============================================================================
section('THE THREE STATES ARE DISTINCT');
// =============================================================================

await check('CASH / IN-KIND / NOT_PROVIDED are classified correctly', () => {
  eq(addon.natureOf({ enabled: 1, delivery_mode: 'CASH_ALLOWANCE' }), 'CASH_ALLOWANCE');
  eq(addon.natureOf({ enabled: 1, delivery_mode: 'HOUSING_ALLOWANCE' }), 'CASH_ALLOWANCE');
  for (const m of ['SHUTTLE_SERVICE','CLIENT_PROVIDED_TRANSPORT','KAHE_PROVIDED_TRANSPORT','THIRD_PARTY_TRANSPORT',
    'CATERING','CLIENT_CANTEEN','KAHE_PROVIDED_MEALS','THIRD_PARTY_CATERING',
    'KAHE_MESS','CLIENT_CAMP','THIRD_PARTY_HOUSING','HOTEL_LODGING']) {
    eq(addon.natureOf({ enabled: 1, delivery_mode: m }), 'BENEFIT_IN_KIND', `${m}: `);
  }
  eq(addon.natureOf({ enabled: 1, delivery_mode: 'NOT_PROVIDED' }), 'NOT_PROVIDED');
  eq(addon.natureOf({ enabled: 0, delivery_mode: 'CASH_ALLOWANCE' }), 'NOT_PROVIDED', 'disabled cash is nothing: ');
  eq(addon.natureOf(null), 'NOT_PROVIDED', 'unconfigured is nothing: ');
});

await check('exactly two delivery modes in the whole catalogue are cash', () => {
  eq([...addon.CASH_MODES].sort(), ['CASH_ALLOWANCE','HOUSING_ALLOWANCE']);
  const all = Object.values(addon.DELIVERY_MODES).flat();
  eq(all.filter((m) => addon.CASH_MODES.has(m)).length, 3, 'three entries across three categories: ');
});

await check('a delivery mode is only legal for its own category', async () => {
  await throwsCode(async () => await create({ addon_type: 'MEALS', delivery_mode: 'SHUTTLE_SERVICE' }),
    addon.ERROR.INVALID_MODE_FOR_TYPE, 'shuttle meals: ');
  await throwsCode(async () => await create({ addon_type: 'TRANSPORT', delivery_mode: 'KAHE_MESS' }),
    addon.ERROR.INVALID_MODE_FOR_TYPE, 'mess transport: ');
  await throwsCode(async () => await create({ addon_type: 'ACCOMMODATION', delivery_mode: 'CASH_ALLOWANCE' }),
    addon.ERROR.INVALID_MODE_FOR_TYPE, 'accommodation cash is HOUSING_ALLOWANCE: ');
});

// =============================================================================
section('TRANSPORT / MOBILITY');
// =============================================================================

await check('1. TRANSPORT CASH ALLOWANCE becomes a payroll component — only when named', async () => {
  const a = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'CASH_ALLOWANCE',
    payroll_component_code: 'ALLOW_TRANSPORT', rate_sen: money.rupiahToSen(500000),
    quantity_basis: 'PER_WORKER_PER_MONTH', client_billable: 1,
    cost_bearer: 'CLIENT', billing_treatment: 'SEPARATE',
    client_id: CLI_WUHUAN });
  eq(addon.natureOf(a), 'CASH_ALLOWANCE');
  const impact = await addon.resolvePayrollImpact(db, at({ clientId: CLI_WUHUAN }));
  const t = impact.components.find((c) => c.addon_type === 'TRANSPORT');
  eq(t.component_code, 'ALLOW_TRANSPORT');
  eq(money.senToRupiah(t.amount_sen), 500000);
});

await check('cash mode WITHOUT an explicit component code is refused', async () => {
  await throwsCode(async () => await create({ addon_type: 'TRANSPORT', delivery_mode: 'CASH_ALLOWANCE',
    rate_sen: 100, client_id: CLI_OTHER }), addon.ERROR.CASH_REQUIRES_COMPONENT);
});

await check('2. RULE 1 — SHUTTLE_SERVICE creates NO transport allowance', async () => {
  const a = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE',
    rate_sen: money.rupiahToSen(200000), quantity_basis: 'PER_WORKER_PER_MONTH',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_OTHER });
  eq(addon.natureOf(a), 'BENEFIT_IN_KIND');
  const impact = await addon.resolvePayrollImpact(db, at({ clientId: CLI_OTHER }));
  eq(impact.components.some((c) => c.addon_type === 'TRANSPORT'), false, 'no payroll component: ');
  const ex = impact.excluded.find((e) => e.addon_type === 'TRANSPORT');
  eq(ex.nature, 'BENEFIT_IN_KIND');
  eq(ex.reason.includes('SHUTTLE_SERVICE'), true, `reason states why: ${ex.reason} — `);
  // …but it IS a billable service
  const bill = await addon.resolveBillableAddons(db, at({ clientId: CLI_OTHER }));
  eq(bill.billable.some((b) => b.addon_type === 'TRANSPORT'), true, 'still billable: ');
});

await check('a service in kind may NEVER carry a payroll component code', async () => {
  await throwsCode(async () => await create({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE',
    payroll_component_code: 'ALLOW_TRANSPORT', client_id: CLI_OTHER }),
    addon.ERROR.COMPONENT_ON_NON_CASH);
  await throwsCode(async () => await create({ addon_type: 'MEALS', delivery_mode: 'CATERING',
    payroll_component_code: 'ALLOW_MEAL', client_id: CLI_OTHER }),
    addon.ERROR.COMPONENT_ON_NON_CASH);
});

await check('3. SCENARIO A — CLIENT_PROVIDED_TRANSPORT: no payroll cost, not billable', async () => {
  const prj = PRJ_TBN;
  const a = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'CLIENT_PROVIDED_TRANSPORT',
    client_billable: 0, cost_bearer: 'CLIENT', billing_treatment: 'NON_BILLABLE',
    quantity_basis: 'NOT_APPLICABLE', client_id: CLI_WUHUAN, project_id: prj });
  eq(addon.natureOf(a), 'BENEFIT_IN_KIND');
  const s = at({ clientId: CLI_WUHUAN, projectId: prj });
  eq((await addon.resolvePayrollImpact(db, s)).components.some((c) => c.addon_type === 'TRANSPORT'), false,
    'KAHE payroll impact = NONE: ');
  const bill = await addon.resolveBillableAddons(db, s);
  eq(bill.billable.some((b) => b.addon_type === 'TRANSPORT'), false, 'client billable = NO: ');
  const nb = bill.notBillable.find((b) => b.addon_type === 'TRANSPORT');
  eq(nb.cost_bearer, 'CLIENT', 'the client bears it directly: ');
});

await check('4. SCENARIO D — TRANSPORT NOT_PROVIDED creates nothing at all', async () => {
  const a = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'NOT_PROVIDED',
    legal_entity_id: 'MITRA', client_id: CLI_MITRA });
  eq(addon.natureOf(a), 'NOT_PROVIDED');
  const s = { legalEntityId: 'MITRA', clientId: CLI_MITRA, asOf: '2026-06-15' };
  const impact = await addon.resolvePayrollImpact(db, s);
  eq(impact.components.length, 0, 'no components at all: ');
  const ex = impact.excluded.find((e) => e.addon_type === 'TRANSPORT');
  eq(ex.reason.includes('NOT_PROVIDED'), true);
  // RULE 4: emphatically not a zero-rupiah line
  eq(impact.components.some((c) => c.amount_sen === 0), false, 'no fake Rp0 component: ');
  eq(a.rate_sen, null, 'no rate stored: ');
  eq(a.payroll_component_code, null, 'no component stored: ');
});

await check('RULE 4 — NOT_PROVIDED carrying terms is refused outright', async () => {
  for (const bad of [
    { rate_sen: 1000 },
    { payroll_component_code: 'X' },
    { client_billable: 1, cost_bearer: 'CLIENT', billing_treatment: 'SEPARATE' },
    { cost_bearer: 'KAHE' },
  ]) {
    await throwsCode(async () => await create({ addon_type: 'TRANSPORT', delivery_mode: 'NOT_PROVIDED',
      client_id: CLI_OTHER, project_id: PRJ_PPB, ...bad }),
      addon.ERROR.NOT_PROVIDED_HAS_TERMS, `${JSON.stringify(bad)}: `);
  }
});

// =============================================================================
section('MEALS');
// =============================================================================

await check('5. MEAL CASH ALLOWANCE becomes a component', async () => {
  const a = await activate({ addon_type: 'MEALS', delivery_mode: 'CASH_ALLOWANCE',
    payroll_component_code: 'ALLOW_MEAL', rate_sen: money.rupiahToSen(30000),
    quantity_basis: 'PER_ATTENDANCE_DAY', client_billable: 1,
    cost_bearer: 'CLIENT', billing_treatment: 'BUNDLED', client_id: CLI_WUHUAN });
  eq(addon.natureOf(a), 'CASH_ALLOWANCE');
  const t = (await addon.resolvePayrollImpact(db, at({ clientId: CLI_WUHUAN }))).components.find((c) => c.addon_type === 'MEALS');
  eq(t.component_code, 'ALLOW_MEAL');
  eq(t.quantity_basis, 'PER_ATTENDANCE_DAY');
});

await check('6. SCENARIO B — RULE 2: CATERING by KAHE, billable, no meal allowance', async () => {
  const a = await activate({ addon_type: 'MEALS', delivery_mode: 'CATERING',
    rate_sen: money.rupiahToSen(28000), quantity_basis: 'PER_ATTENDANCE_DAY',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    note: 'KAHE menalangi, ditagihkan ke klien', client_id: CLI_OTHER });
  eq(addon.natureOf(a), 'BENEFIT_IN_KIND');
  const s = at({ clientId: CLI_OTHER });
  eq((await addon.resolvePayrollImpact(db, s)).components.some((c) => c.addon_type === 'MEALS'), false,
    'no meal allowance created: ');
  const b = (await addon.resolveBillableAddons(db, s)).billable.find((x) => x.addon_type === 'MEALS');
  eq(b.cost_bearer, 'KAHE', 'KAHE bears it initially: ');
  eq(b.billing_treatment, 'SEPARATE', 'recoverable from the client: ');
});

await check('7. CLIENT_CANTEEN: client provides directly, no KAHE cost', async () => {
  const a = await activate({ addon_type: 'MEALS', delivery_mode: 'CLIENT_CANTEEN',
    client_billable: 0, cost_bearer: 'CLIENT', billing_treatment: 'NON_BILLABLE',
    client_id: CLI_WUHUAN, project_id: PRJ_TBN });
  const s = at({ clientId: CLI_WUHUAN, projectId: PRJ_TBN });
  eq((await addon.resolvePayrollImpact(db, s)).components.some((c) => c.addon_type === 'MEALS'), false);
  eq((await addon.resolveBillableAddons(db, s)).billable.some((b) => b.addon_type === 'MEALS'), false);
  eq(a.cost_bearer, 'CLIENT');
});

await check('8. MEALS NOT_PROVIDED creates nothing', async () => {
  const s = { legalEntityId: 'MITRA', clientId: CLI_MITRA, asOf: '2026-06-15' };
  eq((await addon.resolveAllAddons(db, s)).MEALS.configured, false, 'nothing configured at all: ');
  eq((await addon.resolveAllAddons(db, s)).MEALS.nature, 'NOT_PROVIDED');
  eq((await addon.resolvePayrollImpact(db, s)).components.length, 0);
});

// =============================================================================
section('ACCOMMODATION / HOUSING');
// =============================================================================

await check('9. HOUSING_ALLOWANCE is the cash mode and becomes a component', async () => {
  const a = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'HOUSING_ALLOWANCE',
    payroll_component_code: 'ALLOW_HOUSING', rate_sen: money.rupiahToSen(1500000),
    quantity_basis: 'PER_WORKER_PER_MONTH', client_billable: 1,
    cost_bearer: 'CLIENT', billing_treatment: 'SEPARATE', client_id: CLI_WUHUAN });
  eq(addon.natureOf(a), 'CASH_ALLOWANCE');
  const t = (await addon.resolvePayrollImpact(db, at({ clientId: CLI_WUHUAN }))).components.find((c) => c.addon_type === 'ACCOMMODATION');
  eq(t.component_code, 'ALLOW_HOUSING');
});

await check('10. SCENARIO C — RULE 3: KAHE_MESS enabled, billable, no housing allowance', async () => {
  const a = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'KAHE_MESS',
    rate_sen: money.rupiahToSen(900000), quantity_basis: 'PER_WORKER_PER_MONTH',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_OTHER });
  const s = at({ clientId: CLI_OTHER });
  eq(addon.natureOf(a), 'BENEFIT_IN_KIND');
  eq((await addon.resolvePayrollImpact(db, s)).components.some((c) => c.addon_type === 'ACCOMMODATION'), false,
    'no housing allowance: ');
  eq((await addon.resolveBillableAddons(db, s)).billable.some((b) => b.addon_type === 'ACCOMMODATION'), true,
    'client billable = YES: ');
});

await check('11. RULE 3 — CLIENT_CAMP creates no housing allowance either', async () => {
  const a = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'CLIENT_CAMP',
    client_billable: 0, cost_bearer: 'CLIENT', billing_treatment: 'NON_BILLABLE',
    client_id: CLI_WUHUAN, project_id: PRJ_TBN });
  const s = at({ clientId: CLI_WUHUAN, projectId: PRJ_TBN });
  eq(addon.natureOf(a), 'BENEFIT_IN_KIND');
  eq((await addon.resolvePayrollImpact(db, s)).components.some((c) => c.addon_type === 'ACCOMMODATION'), false);
});

await check('12. ACCOMMODATION NOT_PROVIDED creates nothing', async () => {
  const a = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'NOT_PROVIDED',
    legal_entity_id: 'MITRA', client_id: CLI_MITRA });
  eq(addon.natureOf(a), 'NOT_PROVIDED');
  const s = { legalEntityId: 'MITRA', clientId: CLI_MITRA, asOf: '2026-06-15' };
  eq((await addon.resolvePayrollImpact(db, s)).components.length, 0);
  eq((await addon.resolveBillableAddons(db, s)).billable.length, 0);
});

await check('SCENARIO D — all three NOT_PROVIDED: payroll and billing still work', async () => {
  const s = { legalEntityId: 'MITRA', clientId: CLI_MITRA, asOf: '2026-06-15' };
  const all = await addon.resolveAllAddons(db, s);
  eq(Object.values(all).every((r) => r.nature === 'NOT_PROVIDED'), true);
  const impact = await addon.resolvePayrollImpact(db, s);
  eq(impact.components, [], 'payroll adds nothing: ');
  eq(impact.excluded.length, 3, 'each category explained: ');
  const basis = await addon.resolveBillingBasis(db, s);
  eq(basis.addons, [], 'billing basis has no add-on lines: ');
  eq(basis.service_fee.configured, false);
  eq(basis.amounts_calculated, false, 'Phase 3A calculates nothing: ');
});

// =============================================================================
section('COST BEARER & BILLING TREATMENT');
// =============================================================================

await check('13/14/15. KAHE, CLIENT and SHARED cost bearers are all supported', async () => {
  const mk = async (bearer, extra = {}) => await activate({ addon_type: 'MEALS', delivery_mode: 'THIRD_PARTY_CATERING',
    rate_sen: 1000, quantity_basis: 'PER_HEADCOUNT', client_billable: 1,
    cost_bearer: bearer, billing_treatment: 'SEPARATE',
    client_id: CLI_OTHER, project_id: PRJ_PPB, effective_from: extra.from || '2026-01-01', ...extra });
  const kahe = await mk('KAHE');
  eq(kahe.cost_bearer, 'KAHE');
  const client = await mk('CLIENT', { from: '2026-02-01' });
  eq(client.cost_bearer, 'CLIENT');
  const shared = await mk('SHARED', { from: '2026-03-01', cost_share_kahe_bp: 4000 });
  eq(shared.cost_bearer, 'SHARED');
  eq(shared.cost_share_kahe_bp, 4000, 'KAHE bears 40%: ');
  // third party too
  const tp = await mk('THIRD_PARTY', { from: '2026-04-01' });
  eq(tp.cost_bearer, 'THIRD_PARTY');
});

await check('SHARED without a share percentage is refused', async () => {
  await throwsCode(async () => await create({ addon_type: 'MEALS', delivery_mode: 'CATERING', rate_sen: 100,
    client_billable: 1, cost_bearer: 'SHARED', billing_treatment: 'SEPARATE',
    client_id: CLI_MITRA, legal_entity_id: 'MITRA' }), addon.ERROR.VALIDATION);
  await throwsMatching(async () => await create({ addon_type: 'MEALS', delivery_mode: 'CATERING', rate_sen: 100,
    client_billable: 1, cost_bearer: 'SHARED', billing_treatment: 'SEPARATE',
    cost_share_kahe_bp: 20000, client_id: CLI_MITRA, legal_entity_id: 'MITRA' }),
    /0 dan 10000/, 'out of range: ');
});

await check('16. RULE 6 — a NON_BILLABLE add-on with KAHE as cost bearer is valid', async () => {
  // The client refuses to reimburse; KAHE still pays. Recorded, not hidden.
  const a = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'KAHE_PROVIDED_TRANSPORT',
    rate_sen: money.rupiahToSen(150000), quantity_basis: 'PER_WORKER_PER_MONTH',
    client_billable: 0, cost_bearer: 'KAHE', billing_treatment: 'NON_BILLABLE',
    note: 'klien menolak mengganti', client_id: CLI_WUHUAN, project_id: PRJ_PPB });
  const s = at({ clientId: CLI_WUHUAN, projectId: PRJ_PPB });
  const bill = await addon.resolveBillableAddons(db, s);
  eq(bill.billable.some((b) => b.addon_type === 'TRANSPORT'), false, 'not billed: ');
  const nb = bill.notBillable.find((b) => b.addon_type === 'TRANSPORT');
  eq(nb.cost_bearer, 'KAHE', 'but KAHE still bears the cost, and it is visible: ');
  eq(a.rate_sen, money.rupiahToSen(150000), 'the real cost is still recorded: ');
});

await check('17. BUNDLED billing treatment is supported and distinguished from SEPARATE', async () => {
  const s = at({ clientId: CLI_WUHUAN });
  const bill = await addon.resolveBillableAddons(db, s);
  const meals = bill.billable.find((b) => b.addon_type === 'MEALS');
  eq(meals.billing_treatment, 'BUNDLED');
  const acc = bill.billable.find((b) => b.addon_type === 'ACCOMMODATION');
  eq(acc.billing_treatment, 'SEPARATE');
});

await check('client_billable without a billing treatment or bearer is refused', async () => {
  await throwsCode(async () => await create({ addon_type: 'MEALS', delivery_mode: 'CATERING', rate_sen: 100,
    client_billable: 1, billing_treatment: 'NON_BILLABLE', cost_bearer: 'KAHE',
    client_id: CLI_MITRA, legal_entity_id: 'MITRA' }), addon.ERROR.VALIDATION, 'non-billable treatment: ');
  await throwsCode(async () => await create({ addon_type: 'MEALS', delivery_mode: 'CATERING', rate_sen: 100,
    client_billable: 1, billing_treatment: 'SEPARATE', cost_bearer: 'NOT_APPLICABLE',
    client_id: CLI_MITRA, legal_entity_id: 'MITRA' }), addon.ERROR.VALIDATION, 'no bearer: ');
});

await check('entitlement and billability are INDEPENDENT axes', async () => {
  // employee not entitled, yet the client is still billed for the service
  const a = await activate({ addon_type: 'MEALS', delivery_mode: 'KAHE_PROVIDED_MEALS',
    employee_entitlement: 'NOT_ENTITLED', rate_sen: 500, quantity_basis: 'PER_HEADCOUNT',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_WUHUAN, project_id: PRJ_PPB });
  const s = at({ clientId: CLI_WUHUAN, projectId: PRJ_PPB });
  eq(a.employee_entitlement, 'NOT_ENTITLED');
  eq((await addon.resolveBillableAddons(db, s)).billable.some((b) => b.addon_type === 'MEALS'), true, 'still billable: ');
  // and a cash allowance the employee is NOT entitled to produces no component
  const b = await activate({ addon_type: 'TRANSPORT', delivery_mode: 'CASH_ALLOWANCE',
    payroll_component_code: 'ALLOW_TRANSPORT', employee_entitlement: 'NOT_ENTITLED',
    rate_sen: 1000, quantity_basis: 'PER_WORKER_PER_MONTH',
    legal_entity_id: 'MITRA', client_id: CLI_MITRA, project_id: PRJ_PPB });
  const s2 = { legalEntityId: 'MITRA', clientId: CLI_MITRA, projectId: PRJ_PPB, asOf: '2026-06-15' };
  eq((await addon.resolvePayrollImpact(db, s2)).components.some((c) => c.addon_type === 'TRANSPORT'), false,
    'not entitled -> no component: ');
  eq(b.delivery_mode, 'CASH_ALLOWANCE');
});

// =============================================================================
section('VERSIONING & EFFECTIVE DATING');
// =============================================================================

await check('18. an EFFECTIVE-DATE CHANGE creates a new version and closes the old one', async () => {
  const v1 = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'KAHE_MESS',
    rate_sen: money.rupiahToSen(900000), quantity_basis: 'PER_WORKER_PER_MONTH',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_WUHUAN, project_id: PRJ_PPB, effective_from: '2026-01-01' });
  const v2 = await activate({ addon_type: 'ACCOMMODATION', delivery_mode: 'KAHE_MESS',
    rate_sen: money.rupiahToSen(1100000), quantity_basis: 'PER_WORKER_PER_MONTH',
    client_billable: 1, cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_WUHUAN, project_id: PRJ_PPB, effective_from: '2026-07-01' });
  eq(v2.version, 2);
  const closed = await db.prepare('SELECT * FROM worker_service_addons WHERE id = ?').get(v1.id);
  eq(closed.status, 'SUPERSEDED');
  eq(closed.effective_to, '2026-06-30', 'closed the day before the new one starts: ');
});

await check('19. HISTORICAL VERSION PRESERVATION: June still resolves the old rate', async () => {
  const s = { legalEntityId: 'KAHE360', clientId: CLI_WUHUAN, projectId: PRJ_PPB };
  const june = await addon.resolveAddon(db, { ...s, addonType: 'ACCOMMODATION', asOf: '2026-06-15' });
  const july = await addon.resolveAddon(db, { ...s, addonType: 'ACCOMMODATION', asOf: '2026-07-15' });
  eq(money.senToRupiah(june.rate_sen), 900000, 'June: ');
  eq(money.senToRupiah(july.rate_sen), 1100000, 'July: ');
  eq(june.version, 1);
  eq(july.version, 2);
  eq(june.id !== july.id, true, 'two distinct records — history is not overwritten: ');
});

await check('RULE 9 — an ACTIVE version cannot have its commercial terms edited', async () => {
  const active = await db.prepare(`SELECT * FROM worker_service_addons WHERE status='ACTIVE' AND rate_sen IS NOT NULL LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare('UPDATE worker_service_addons SET rate_sen = 1 WHERE id = ?').run(active.id),
    /ADDON_ACTIVE/, 'rate: ');
  // pick a value guaranteed to differ, or the trigger has nothing to fire on
  const otherBearer = active.cost_bearer === 'CLIENT' ? 'KAHE' : 'CLIENT';
  await throwsMatching(async () => await db.prepare('UPDATE worker_service_addons SET cost_bearer=? WHERE id = ?').run(otherBearer, active.id),
    /ADDON_ACTIVE/, 'cost bearer: ');
  await throwsMatching(async () => await db.prepare(`UPDATE worker_service_addons SET delivery_mode='CATERING' WHERE id = ?`).run(active.id),
    /ADDON_ACTIVE/, 'delivery mode: ');
  eq((await db.prepare('SELECT rate_sen FROM worker_service_addons WHERE id=?').get(active.id)).rate_sen, active.rate_sen);
});

await check('a backdated version that overlaps the active one is refused', async () => {
  const row = await create({ addon_type: 'ACCOMMODATION', delivery_mode: 'KAHE_MESS',
    rate_sen: 100, quantity_basis: 'PER_WORKER_PER_MONTH', client_billable: 1,
    cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI_WUHUAN, project_id: PRJ_PPB, effective_from: '2026-05-01' });
  await throwsCode(async () => await withTransaction(db, async () => await addon.approveAddon(db, row.id, APPROVER, 'backdate')),
    addon.ERROR.OVERLAPPING_VERSION);
});

await check('only ONE open ACTIVE configuration per scope is possible (database index)', async () => {
  const active = await db.prepare(`SELECT * FROM worker_service_addons
    WHERE status='ACTIVE' AND effective_to IS NULL LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare(`INSERT INTO worker_service_addons
    (addon_type,enabled,delivery_mode,employee_entitlement,client_billable,cost_bearer,billing_treatment,
     quantity_basis,legal_entity_id,client_id,project_id,version,effective_from,status,created_by,created_at)
    VALUES (?,1,?, 'ENTITLED',0,'NOT_APPLICABLE','NON_BILLABLE','NOT_APPLICABLE',?,?,?,99,'2030-01-01','ACTIVE','x',kahe_now())`)
    .run(active.addon_type, active.delivery_mode, active.legal_entity_id, active.client_id, active.project_id),
    /UNIQUE|constraint/i);
});

await check('a new configuration is DRAFT until explicitly approved', async () => {
  const row = await create({ addon_type: 'MEALS', delivery_mode: 'CATERING', rate_sen: 500,
    quantity_basis: 'PER_HEADCOUNT', client_billable: 1, cost_bearer: 'KAHE',
    billing_treatment: 'SEPARATE', legal_entity_id: 'MITRA', client_id: CLI_MITRA,
    project_id: PRJ_TBN, effective_from: '2026-01-01' });
  eq(row.status, 'DRAFT');
  eq(await addon.resolveAddon(db, { addonType: 'MEALS', legalEntityId: 'MITRA', clientId: CLI_MITRA,
    projectId: PRJ_TBN, asOf: '2026-06-15' }), null, 'a DRAFT is not in force: ');
  const approved = await withTransaction(db, async () => await addon.approveAddon(db, row.id, APPROVER, 'ok'));
  eq(approved.status, 'ACTIVE');
  eq(approved.approved_by, 'Ops Director');
});

await check('SoD: the creator cannot approve their own configuration', async () => {
  const row = await create({ addon_type: 'TRANSPORT', delivery_mode: 'THIRD_PARTY_TRANSPORT',
    rate_sen: 200, quantity_basis: 'PER_WORKER_PER_TRIP', client_billable: 1,
    cost_bearer: 'THIRD_PARTY', billing_treatment: 'SEPARATE',
    legal_entity_id: 'MITRA', client_id: CLI_MITRA, project_id: PRJ_TBN,
    effective_from: '2026-01-01' });
  const selfApprove = { displayName: 'Config Officer', permissions: { worker_services_config: ['APPROVE'] } };
  await throwsCode(async () => await withTransaction(db, async () => await addon.approveAddon(db, row.id, selfApprove, 'sendiri')),
    addon.ERROR.SOD_VIOLATION);
});

await check('every change is AUDITED with actor, before and after', async () => {
  const a = await db.prepare(`SELECT * FROM worker_service_addons WHERE status='SUPERSEDED' LIMIT 1`).get();
  const rows = await db.prepare('SELECT * FROM worker_service_addon_audit WHERE addon_id = ? ORDER BY id').all(a.id);
  eq(rows.length >= 2, true, `audit rows (${rows.length}): `);
  eq(rows[0].action, 'CREATED');
  const sup = rows.find((r) => r.action === 'SUPERSEDED');
  if (!sup) throw new Error('supersession not audited');
  eq(JSON.parse(sup.after_json).status, 'SUPERSEDED');
  for (const r of rows) {
    if (!r.actor) throw new Error(`audit row ${r.action} has no actor`);
    if (!r.occurred_at) throw new Error(`audit row ${r.action} has no timestamp`);
  }
});

// =============================================================================
section('SCOPE PRECEDENCE & ISOLATION');
// =============================================================================

await check('scope precedence is project > client > legal entity', async () => {
  // entity-level default
  await activate({ addon_type: 'MEALS', delivery_mode: 'NOT_PROVIDED', effective_from: '2026-01-01' });
  const entityLevel = await addon.resolveAddon(db, { addonType: 'MEALS', legalEntityId: 'KAHE360', asOf: '2026-06-15' });
  eq(entityLevel.resolved_tier, 'LEGAL_ENTITY');
  eq(entityLevel.delivery_mode, 'NOT_PROVIDED');
  // client-level overrides it
  const clientLevel = await addon.resolveAddon(db, { addonType: 'MEALS', legalEntityId: 'KAHE360',
    clientId: CLI_WUHUAN, asOf: '2026-06-15' });
  eq(clientLevel.resolved_tier, 'CLIENT');
  eq(clientLevel.delivery_mode, 'CASH_ALLOWANCE');
  // project-level overrides the client
  const projectLevel = await addon.resolveAddon(db, { addonType: 'MEALS', legalEntityId: 'KAHE360',
    clientId: CLI_WUHUAN, projectId: PRJ_TBN, asOf: '2026-06-15' });
  eq(projectLevel.resolved_tier, 'PROJECT');
  eq(projectLevel.delivery_mode, 'CLIENT_CANTEEN');
});

await check('20. CROSS-CLIENT isolation: one client never sees another\'s terms', async () => {
  const wuhuan = await addon.resolveAddon(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI_WUHUAN, asOf: '2026-06-15' });
  const other = await addon.resolveAddon(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI_OTHER, asOf: '2026-06-15' });
  eq(wuhuan.delivery_mode, 'CASH_ALLOWANCE');
  eq(other.delivery_mode, 'SHUTTLE_SERVICE');
  eq(wuhuan.id !== other.id, true);
  eq(wuhuan.client_id, CLI_WUHUAN);
  eq(other.client_id, CLI_OTHER);
});

await check('21. CROSS-ENTITY isolation: MITRA config never leaks into KAHE', async () => {
  const kahe = await addon.resolveAllAddons(db, at({ clientId: CLI_WUHUAN }));
  const mitra = await addon.resolveAllAddons(db, { legalEntityId: 'MITRA', clientId: CLI_MITRA, asOf: '2026-06-15' });
  eq(kahe.TRANSPORT.addon.legal_entity_id, 'KAHE360');
  eq(mitra.TRANSPORT.addon.legal_entity_id, 'MITRA');
  eq(mitra.TRANSPORT.nature, 'NOT_PROVIDED');
  eq(kahe.TRANSPORT.nature, 'CASH_ALLOWANCE');
  // an entity with nothing configured resolves to nothing, not to another's config
  const none = await addon.resolveAllAddons(db, { legalEntityId: 'MITRA', asOf: '2020-01-01' });
  eq(Object.values(none).every((r) => !r.configured), true);
});

// =============================================================================
section('SERVICE FEE (optional, may remain NOT_CONFIGURED)');
// =============================================================================

await check('SERVICE FEE is NOT_CONFIGURED by default and billing still works', async () => {
  const fee = await addon.resolveServiceFee(db, { legalEntityId: 'KAHE360', clientId: CLI_WUHUAN, asOf: '2026-06-15' });
  eq(fee.fee_mode, 'NOT_CONFIGURED');
  eq(fee.configured, false);
  const basis = await addon.resolveBillingBasis(db, at({ clientId: CLI_WUHUAN }));
  eq(basis.service_fee.configured, false);
  eq(Array.isArray(basis.addons), true, 'the basis still assembles: ');
});

await check('SERVICE FEE can be configured later without being hardcoded', async () => {
  await withTransaction(db, async () => {
    await db.prepare(`INSERT INTO service_fee_config (legal_entity_id,client_id,fee_mode,fee_rate_bp,fee_basis,
      version,effective_from,status,created_by,created_at,approved_by,approved_at)
      VALUES ('KAHE360',?, 'PERCENTAGE', 750, 'PAYROLL_COST_PLUS_ADDONS', 1,'2026-01-01','ACTIVE','test',kahe_now(),'Ops Director',kahe_now())`)
      .run(CLI_WUHUAN);
  });
  const fee = await addon.resolveServiceFee(db, { legalEntityId: 'KAHE360', clientId: CLI_WUHUAN, asOf: '2026-06-15' });
  eq(fee.fee_mode, 'PERCENTAGE');
  eq(fee.fee_rate_bp, 750, '7.5%: ');
  eq(fee.configured, true);
  // another client remains unconfigured — no default leaked across
  eq((await addon.resolveServiceFee(db, { legalEntityId: 'KAHE360', clientId: CLI_OTHER, asOf: '2026-06-15' })).fee_mode,
    'NOT_CONFIGURED');
});

await check('the BILLING BASIS shape is assembled but NO amount is calculated', async () => {
  const basis = await addon.resolveBillingBasis(db, at({ clientId: CLI_WUHUAN }));
  eq(basis.amounts_calculated, false);
  eq(basis.payroll_cost.resolved_here, false, 'payroll cost comes from finalized payroll, not from here: ');
  eq(basis.payroll_cost.source, 'FINALIZED_PAYROLL');
  for (const line of basis.addons) {
    if ('amount_sen' in line) throw new Error(`Phase 3A must not compute amounts: ${line.addon_type}`);
  }
});

// =============================================================================
section('22. NO PAYROLL MUTATION · REGRESSION');
// =============================================================================

await check('the add-on module NEVER writes to payroll', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workerServiceAddon.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const t of ['payroll_run', 'payroll_run_lines', 'payroll_input_snapshots', 'payroll_payslips',
    'employee_salary_components', 'salary_components', 'payroll_payment', 'timesheet_entries']) {
    if (code.includes(t)) throw new Error(`add-on module must not touch ${t}`);
  }
  for (const w of [/UPDATE\s+payroll/i, /INSERT\s+INTO\s+payroll/i, /DELETE\s+FROM\s+payroll/i]) {
    if (w.test(code)) throw new Error(`add-on module must not write payroll: ${w}`);
  }
});

await check('no payroll table was touched by this entire suite', async () => {
  for (const t of ['payroll_runs','payroll_run_lines','payroll_input_snapshots','payroll_payslips',
    'employee_salary_components','payroll_payment_items','payroll_adjustments']) {
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n, 0, `${t} rows: `);
  }
});

await check('no mandatory allowance component was created anywhere', async () => {
  eq((await db.prepare('SELECT COUNT(*) AS n FROM salary_components').get()).n, 0,
    'Phase 3A creates no salary component: ');
  // the component CODE is configuration on the add-on, not a payroll row
  const cash = await db.prepare(`SELECT payroll_component_code FROM worker_service_addons
    WHERE payroll_component_code IS NOT NULL`).all();
  eq(cash.length > 0, true, 'cash add-ons do name a component: ');
});

await check('prior invariants and triggers are untouched', async () => {
  const idx = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_run_single_finalized_original','uq_snapshot_period_employee',
    'uq_payment_item_live_per_period','uq_addon_open_per_scope','uq_service_fee_open_per_scope']) {
    if (!idx.includes(req)) throw new Error(`missing index: ${req}`);
  }
  const trg = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_status','trg_lock_payslip_update','trg_lock_active_addon_terms']) {
    if (!trg.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

await check('Phase 3A builds NO invoice or billing calculation', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  // SUPERSEDED IN PART BY PHASE 3B: the billing tables now exist. What
  // this test guards is unchanged and is asserted below — THIS module
  // creates no billing record of its own.
  for (const f of ['client_invoices','invoice_lines','accounts_receivable','tax_invoices']) {
    if (tables.includes(f)) throw new Error(`must not create ${f}`);
  }
  const billingRows = (await db.prepare('SELECT COUNT(*) AS n FROM billing_runs').get()).n
    + (await db.prepare('SELECT COUNT(*) AS n FROM billing_lines').get()).n;
  eq(billingRows, 0, 'this phase must create no billing record: ');
  eq(tables.includes('worker_service_addons'), true);
  eq(tables.includes('service_fee_config'), true);
  eq(tables.includes('clients'), true);
});

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 3A TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
