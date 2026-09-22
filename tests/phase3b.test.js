(async () => {
// tests/phase3b.test.js
// Phase 3B — Client Billing Quantity & Calculation. Throwaway database.
// Usage: npm run test:phase3b

const fs = require('fs');
const path = require('path');
const { createTestDatabase } = require('./helpers/pgTestDb');
const pgx = require('./helpers/pgIntrospect');

const { initDb, withTransaction } = require('../database/init-db');
const money = require('../lib/money');
const addonLib = require('../lib/workerServiceAddon');
const rateLib = require('../lib/billingRate');
const qtyLib = require('../lib/billingQuantity');
const billing = require('../lib/billingCalculator');

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
const rp = (sen) => money.senToRupiah(sen);

const TEST_DB = path.join(__dirname, 'phase3b.test.db');
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
const __t = await createTestDatabase('phase3b');
const db = __t.db;
await initDb(db);

const MAKER = { displayName: 'Billing Officer', permissions: { client_billing: ['VIEW','CREATE','EDIT'] } };
const APPROVER = { displayName: 'Ops Director', permissions: { client_billing: ['VIEW','APPROVE'] } };
const VERIFIER = { displayName: 'Site Supervisor', permissions: { client_billing: ['VIEW','APPROVE'] } };

// ---- fixtures ---------------------------------------------------------------------
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('PPB','PPB Balongan','Indramayu','active')`).run();
await db.prepare(`INSERT INTO projects (code,name,location,status) VALUES ('TBN','Tuban','Tuban','active')`).run();
const PRJ = (await db.prepare(`SELECT id FROM projects WHERE code='PPB'`).get()).id;
for (const [id, name, t] of [['KAHE360','KAHE','internal'], ['MITRA','Mitra Jaya','subkontraktor']]) {
  await db.prepare(`INSERT INTO legal_entities (id,name,entity_type,jkk_risk_class,effective_date)
              VALUES (?,?,?,'high','2026-01-01')`).run(id, name, t);
}
const mkClient = async (code, entity) => (await db.prepare(
  `INSERT INTO clients (code,name,legal_entity_id,created_by) VALUES (?,?,?,'test') RETURNING id`).run(code, code, entity)).lastInsertRowid;
const CLI = await mkClient('WUHUAN', 'KAHE360');
const CLI2 = await mkClient('OTHER', 'KAHE360');
const CLI_M = await mkClient('MITRA-CLI', 'MITRA');

const E = { legal_entity_id: 'KAHE360', client_id: CLI };
const S = (o = {}) => ({ legalEntityId: 'KAHE360', clientId: CLI, projectId: null, asOf: '2026-06-30', ...o });

async function mkAddon(o, actor = MAKER) {
  const row = await withTransaction(db, async () => await addonLib.createAddon(db,
    { legal_entity_id: 'KAHE360', effective_from: '2026-01-01', ...o }, actor));
  return await withTransaction(db, async () => await addonLib.approveAddon(db, row.id, APPROVER, 'ok'));
}
async function mkRate(o, actor = MAKER) {
  const row = await withTransaction(db, async () => await rateLib.createRate(db,
    { legal_entity_id: 'KAHE360', effective_from: '2026-01-01', ...o }, actor));
  return await withTransaction(db, async () => await rateLib.approveRate(db, row.id, APPROVER, 'ok'));
}
async function mkMeal(o, actor = MAKER) {
  const row = await withTransaction(db, async () => await rateLib.createMealPlanItem(db,
    { legal_entity_id: 'KAHE360', effective_from: '2026-01-01', ...o }, actor));
  return await withTransaction(db, async () => await rateLib.approveMealPlanItem(db, row.id, APPROVER));
}
async function mkQty(o, actor = MAKER, verify = true) {
  const row = await withTransaction(db, async () => await qtyLib.recordQuantity(db,
    { legal_entity_id: 'KAHE360', client_id: CLI, billing_period: '2026-06', ...o }, actor));
  return verify ? await withTransaction(db, async () => await qtyLib.verifyQuantity(db, row.id, VERIFIER, 'dicek')) : row;
}
async function runFor(period, o = {}) {
  return await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: CLI, billingPeriod: period, ...o }, MAKER));
}
const preview = async (run) => await billing.calculateRun(db, run, MAKER);
const lineFor = (r, type, meal = null) =>
  r.lines.find((l) => l.addon_type === type && (meal === null || l.meal_type === meal));
const skipFor = (r, type, meal = null) =>
  r.skipped.find((s) => s.addon_type === type && (meal === null || s.meal_type === meal));

// =============================================================================
section('ARCHITECTURE: NOTHING HARDCODED, NOT EVERY MODEL USES QUANTITY');
// =============================================================================

await check('no price, count or fee percentage is hardcoded anywhere', () => {
  for (const f of ['billingRate.js', 'billingQuantity.js', 'billingCalculator.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // no rupiah-scale literals, and no default fee percentage
    const literals = [...code.matchAll(/\b(\d{7,})\b/g)].map((m) => m[1]);
    if (literals.length) throw new Error(`${f} contains money-scale literals: ${literals.join(', ')}`);
    if (/=\s*0\.1\b|1000\s*\/\s*100|DEFAULT_FEE|10\s*%/.test(code)) throw new Error(`${f} appears to assume a fee rate`);
  }
});

await check('quantityless pricing models are declared and refuse a quantity source', async () => {
  eq([...rateLib.QUANTITYLESS_MODELS].sort(),
    ['ALL_IN','FIXED_MONTHLY','FIXED_PER_MONTH','PACKAGE','PASS_THROUGH','PERCENTAGE','PERCENTAGE_MARKUP']);
  // FIXED_PER_WORKER genuinely multiplies by a headcount, so it is NOT here
  eq(rateLib.usesQuantity('FIXED_PER_WORKER'), true, 'per-worker fee needs a quantity: ');
  eq(rateLib.usesQuantity('PERCENTAGE'), false, 'a percentage prices a subtotal, not a count: ');
  eq(rateLib.usesQuantity('FIXED_MONTHLY'), false);
  eq(rateLib.usesQuantity('PER_TRIP'), true);
  await throwsCode(() => rateLib.validateRate({ addon_type: 'TRANSPORT', pricing_model: 'FIXED_MONTHLY',
    quantity_source: 'TRANSPORT_TRIP', legal_entity_id: 'KAHE360', effective_from: '2026-01-01' }),
    rateLib.ERROR.QUANTITY_ON_FIXED_MODEL, 'fixed model with a quantity source: ');
  await throwsCode(() => rateLib.validateRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP',
    legal_entity_id: 'KAHE360', effective_from: '2026-01-01' }),
    rateLib.ERROR.MISSING_QUANTITY_SOURCE, 'quantity model without a source: ');
});

await check('a pricing model is only legal for its own category', async () => {
  await throwsCode(() => rateLib.validateRate({ addon_type: 'MEALS', pricing_model: 'PER_VEHICLE_DAY',
    meal_type: 'LUNCH', quantity_source: 'VEHICLE_DAY', legal_entity_id: 'KAHE360', effective_from: '2026-01-01' }),
    rateLib.ERROR.INVALID_PRICING_MODEL);
  await throwsCode(() => rateLib.validateRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', legal_entity_id: 'KAHE360', effective_from: '2026-01-01' }),
    rateLib.ERROR.INVALID_PRICING_MODEL);
});

// =============================================================================
section('MEALS');
// =============================================================================

await mkAddon({ addon_type: 'MEALS', delivery_mode: 'CATERING', client_billable: 1,
  client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: CLI });

await check('1. LUNCH ONLY — breakfast and dinner disabled', async () => {
  await mkMeal({ meal_type: 'LUNCH', enabled: 1, client_id: CLI });
  await mkMeal({ meal_type: 'BREAKFAST', enabled: 0, client_id: CLI });
  await mkMeal({ meal_type: 'DINNER', enabled: 0, client_id: CLI });
  eq((await rateLib.enabledMeals(db, S())).sort(), ['LUNCH']);

  await mkRate({ addon_type: 'MEALS', meal_type: 'LUNCH', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(35000), client_id: CLI });
  await mkQty({ addon_type: 'MEALS', meal_type: 'LUNCH', quantity_source: 'MEAL_CONSUMPTION',
    quantity: 500, unit_of_measure: 'MEAL', service_period_start: '2026-06-01',
    service_period_end: '2026-06-30', source_reference: 'nota katering Juni' });

  const r = await preview(await runFor('2026-06'));
  const lunch = lineFor(r, 'MEALS', 'LUNCH');
  eq(lunch.quantity, 500);
  eq(rp(lunch.amount_sen), 500 * 35000, '500 x Rp35.000: ');
  eq(skipFor(r, 'MEALS', 'BREAKFAST').reason, billing.SKIP_REASON.MEAL_NOT_ENABLED);
  eq(skipFor(r, 'MEALS', 'DINNER').reason, billing.SKIP_REASON.MEAL_NOT_ENABLED);
});

await check('2. LUNCH + DINNER with different rates', async () => {
  await mkMeal({ meal_type: 'DINNER', enabled: 1, client_id: CLI, effective_from: '2026-02-01' });
  await mkRate({ addon_type: 'MEALS', meal_type: 'DINNER', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(40000), client_id: CLI, effective_from: '2026-02-01' });
  await mkQty({ addon_type: 'MEALS', meal_type: 'DINNER', quantity_source: 'MEAL_CONSUMPTION',
    quantity: 300, unit_of_measure: 'MEAL', source_reference: 'nota dinner' });

  const r = await preview(await runFor('2026-06'));
  eq(rp(lineFor(r, 'MEALS', 'LUNCH').amount_sen), 500 * 35000);
  eq(rp(lineFor(r, 'MEALS', 'DINNER').amount_sen), 300 * 40000);
  eq(lineFor(r, 'MEALS', 'LUNCH').effective_rate_sen !== lineFor(r, 'MEALS', 'DINNER').effective_rate_sen, true,
    'each meal has its own rate: ');
});

await check('3. ACTUAL MEALS ARE LOWER THAN ATTENDANCE DAYS', async () => {
  // 20 workers x 26 attendance days = 520 possible lunches. Only 500 were eaten.
  const lunchQty = (await db.prepare(`SELECT quantity FROM billing_quantities
    WHERE meal_type='LUNCH' AND verification_status='VERIFIED'`).get()).quantity;
  eq(lunchQty, 500, 'billed on actual consumption: ');
  if (lunchQty === 520) throw new Error('attendance was substituted for consumption');
  // and nothing in the engine derives meals from attendance
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'billingCalculator.js'), 'utf8');
  if (/timesheet_entries/.test(src)) throw new Error('billing must not read attendance directly');
});

await check('4. MEAL FREQUENCY CHANGES NEXT MONTH — June unaffected', async () => {
  // July: breakfast switched on
  await mkMeal({ meal_type: 'BREAKFAST', enabled: 1, client_id: CLI, effective_from: '2026-07-01' });
  eq((await rateLib.enabledMeals(db, S({ asOf: '2026-06-30' }))).sort(), ['DINNER','LUNCH'], 'June: ');
  eq((await rateLib.enabledMeals(db, S({ asOf: '2026-07-31' }))).sort(), ['BREAKFAST','DINNER','LUNCH'], 'July: ');
});

await check('5. MEAL PRICE CHANGES NEXT MONTH — historical price preserved', async () => {
  await mkRate({ addon_type: 'MEALS', meal_type: 'LUNCH', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(38000), client_id: CLI, effective_from: '2026-07-01' });
  const june = await rateLib.resolveRate(db, { ...S(), addonType: 'MEALS', mealType: 'LUNCH', asOf: '2026-06-30' });
  const july = await rateLib.resolveRate(db, { ...S(), addonType: 'MEALS', mealType: 'LUNCH', asOf: '2026-07-31' });
  eq(rp(june.rate_sen), 35000, 'June forever: ');
  eq(rp(july.rate_sen), 38000, 'July: ');
  eq(june.version, 1); eq(july.version, 2);
  eq(june.id !== july.id, true, 'two records — history is not overwritten: ');
});

await check('6. BREAKFAST + LUNCH + DINNER in July, each at its own rate', async () => {
  await mkRate({ addon_type: 'MEALS', meal_type: 'BREAKFAST', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(20000), client_id: CLI, effective_from: '2026-07-01' });
  for (const [meal, qty] of [['BREAKFAST', 400], ['LUNCH', 520], ['DINNER', 310]]) {
    await mkQty({ addon_type: 'MEALS', meal_type: meal, quantity_source: 'MEAL_CONSUMPTION',
      quantity: qty, unit_of_measure: 'MEAL', billing_period: '2026-07',
      source_reference: `nota ${meal} Juli` });
  }
  const r = await preview(await runFor('2026-07'));
  eq(rp(lineFor(r, 'MEALS', 'BREAKFAST').amount_sen), 400 * 20000);
  eq(rp(lineFor(r, 'MEALS', 'LUNCH').amount_sen), 520 * 38000, 'July rate applies: ');
  eq(rp(lineFor(r, 'MEALS', 'DINNER').amount_sen), 310 * 40000);
});

await check('7. MULTIPLE MEALS PER WORKER PER DAY, with a cap recorded', async () => {
  const item = await mkMeal({ meal_type: 'SHIFT_MEAL', enabled: 1, max_per_worker_per_day: 2,
    client_id: CLI, project_id: PRJ });
  eq(item.max_per_worker_per_day, 2);
  await mkRate({ addon_type: 'MEALS', meal_type: 'SHIFT_MEAL', pricing_model: 'PER_PORTION',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'PORTION',
    rate_sen: money.rupiahToSen(25000), client_id: CLI, project_id: PRJ });
  // one worker, two portions on the same day
  await mkQty({ addon_type: 'MEALS', meal_type: 'SHIFT_MEAL', quantity_source: 'MEAL_CONSUMPTION',
    quantity: 2, unit_of_measure: 'PORTION', project_id: PRJ, employee_id: null,
    service_date: '2026-06-10', source_reference: 'shift malam' });
  const rows = await qtyLib.getBillableQuantities(db, { legalEntityId: 'KAHE360', clientId: CLI,
    projectId: PRJ, billingPeriod: '2026-06', addonType: 'MEALS', mealType: 'SHIFT_MEAL' });
  eq(qtyLib.sumQuantities(rows).quantity, 2);
  eq(rows[0].unit_of_measure, 'PORTION');
});

await check('8. PER_WORKER_DAY package pricing for meals', async () => {
  await mkRate({ addon_type: 'MEALS', meal_type: 'EXTRA_MEAL', pricing_model: 'PER_WORKER_DAY',
    quantity_source: 'ATTENDANCE_DAY', unit_of_measure: 'DAY',
    rate_sen: money.rupiahToSen(60000), client_id: CLI2, effective_from: '2026-01-01' });
  const rate = await rateLib.resolveRate(db, { addonType: 'MEALS', mealType: 'EXTRA_MEAL',
    legalEntityId: 'KAHE360', clientId: CLI2, asOf: '2026-06-30' });
  eq(rate.pricing_model, 'PER_WORKER_DAY');
  eq(rate.uses_quantity, true, 'still quantity-driven, but the unit is a worker-day: ');
  eq(rate.quantity_source, 'ATTENDANCE_DAY', 'attendance is an explicit CHOICE here, not a default: ');
});

await check('9. MEAL RATE NOT_CONFIGURED is reported and skipped, never guessed', async () => {
  await mkMeal({ meal_type: 'SNACK', enabled: 1, client_id: CLI });
  const rate = await mkRate({ addon_type: 'MEALS', meal_type: 'SNACK', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL', client_id: CLI });
  eq(rate.rate_status, 'NOT_CONFIGURED');
  eq(rate.rate_sen, null);
  await mkQty({ addon_type: 'MEALS', meal_type: 'SNACK', quantity_source: 'MEAL_CONSUMPTION',
    quantity: 100, unit_of_measure: 'MEAL', source_reference: 'snack' });
  const r = await preview(await runFor('2026-06'));
  eq(lineFor(r, 'MEALS', 'SNACK'), undefined, 'no line produced: ');
  eq(skipFor(r, 'MEALS', 'SNACK').reason, billing.SKIP_REASON.RATE_NOT_CONFIGURED);
  eq(r.lines.some((l) => l.amount_sen === 0), false, 'no fake Rp0 row: ');
});

// =============================================================================
section('TRANSPORT / MOBILITY');
// =============================================================================

await check('10. TRANSPORT NOT_PROVIDED produces nothing', async () => {
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'NOT_PROVIDED',
    legal_entity_id: 'MITRA', client_id: CLI_M });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'MITRA', clientId: CLI_M, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.length, 0);
  eq(r.skipped.find((s) => s.addon_type === 'TRANSPORT').reason, billing.SKIP_REASON.NOT_PROVIDED);
});

await check('11. CLIENT-PROVIDED transport is not billable and has no payroll impact', async () => {
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'CLIENT_PROVIDED_TRANSPORT',
    client_billable: 0, client_billable_mode: 'NO', cost_bearer: 'CLIENT',
    billing_treatment: 'NON_BILLABLE', client_id: CLI2 });
  const s = { legalEntityId: 'KAHE360', clientId: CLI2, asOf: '2026-06-30' };
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: CLI2, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.some((l) => l.addon_type === 'TRANSPORT'), false);
  const sk = r.skipped.find((x) => x.addon_type === 'TRANSPORT');
  eq(sk.reason, billing.SKIP_REASON.NOT_BILLABLE);
  eq(sk.cost_bearer, 'CLIENT');
  eq((await addonLib.resolvePayrollImpact(db, s)).components.length, 0, 'no payroll component: ');
});

await check('12. KAHE SHUTTLE billed PER_TRIP on verified trips', async () => {
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI, project_id: PRJ });
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP', quantity_source: 'TRANSPORT_TRIP',
    unit_of_measure: 'TRIP', rate_sen: money.rupiahToSen(1000000), client_id: CLI, project_id: PRJ });
  for (const [d, n] of [['2026-06-02', 2], ['2026-06-03', 2], ['2026-06-04', 1]]) {
    await mkQty({ addon_type: 'TRANSPORT', quantity_source: 'TRANSPORT_TRIP', quantity: n,
      unit_of_measure: 'TRIP', project_id: PRJ, service_date: d,
      route_id: 'R-01', vehicle_id: 'B-1234-XY', vehicle_type: 'MINIBUS',
      trip_reference: `MANIFEST-${d}`, source_reference: `manifest ${d}` });
  }
  const r = await preview(await runFor('2026-06', { projectId: PRJ }));
  const t = lineFor(r, 'TRANSPORT');
  eq(t.quantity, 5, '2+2+1 trips: ');
  eq(rp(t.amount_sen), 5 * 1000000);
  eq(t.quantity_ids.length, 3, 'traceable to three manifests: ');
  eq(t.verified_by, 'Site Supervisor');
});

await check('13. ACTUAL TRANSPORT USAGE DIFFERS FROM ATTENDANCE', async () => {
  // 20 workers attended all month; only 5 shuttle trips were actually run.
  const t = lineFor(await preview(await runFor('2026-06', { projectId: PRJ })), 'TRANSPORT');
  eq(t.quantity, 5);
  eq(t.quantity_source, 'TRANSPORT_TRIP', 'source is trips, not attendance: ');
});

await check('14. THIRD-PARTY shuttle with SHARED cost bearer', async () => {
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'THIRD_PARTY_TRANSPORT', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'SHARED', cost_share_kahe_bp: 3000,
    billing_treatment: 'SEPARATE', legal_entity_id: 'MITRA', client_id: CLI_M, project_id: PRJ });
  const a = await addonLib.resolveAddon(db, { addonType: 'TRANSPORT', legalEntityId: 'MITRA',
    clientId: CLI_M, projectId: PRJ, asOf: '2026-06-30' });
  eq(a.cost_bearer, 'SHARED');
  eq(a.cost_share_kahe_bp, 3000);
});

await check('15. FIXED_MONTHLY transport needs no quantity at all', async () => {
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'FIXED_MONTHLY', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'MONTH', rate_sen: money.rupiahToSen(25000000), client_id: CLI2 });
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'BUS', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI2, project_id: PRJ });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: CLI2, projectId: PRJ, billingPeriod: '2026-06' }, MAKER)), MAKER);
  const t = lineFor(r, 'TRANSPORT');
  eq(t.quantity, null, 'no quantity invented: ');
  eq(t.quantity_source, null);
  eq(rp(t.amount_sen), 25000000, 'the rate IS the amount: ');
  eq(t.delivery_mode, 'BUS');
});

await check('16. PER_VEHICLE_DAY and ROUTE_TRIP quantity sources work', async () => {
  const C3 = await mkClient('VEHCLI', 'KAHE360');
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'DEDICATED_VEHICLE', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C3 });
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_VEHICLE_DAY', quantity_source: 'VEHICLE_DAY',
    unit_of_measure: 'VEHICLE_DAY', rate_sen: money.rupiahToSen(750000), client_id: C3 });
  await withTransaction(db, async () => {
    const q = await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360', client_id: C3,
      billing_period: '2026-06', addon_type: 'TRANSPORT', quantity_source: 'VEHICLE_DAY',
      quantity: 26, unit_of_measure: 'VEHICLE_DAY', vehicle_id: 'B-9999-ZZ',
      vehicle_type: 'PICKUP', source_reference: 'log kendaraan' }, MAKER);
    await qtyLib.verifyQuantity(db, q.id, VERIFIER, 'ok');
  });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C3, billingPeriod: '2026-06' }, MAKER)), MAKER);
  const t = lineFor(r, 'TRANSPORT');
  eq(t.quantity, 26);
  eq(rp(t.amount_sen), 26 * 750000);
  eq(t.unit_of_measure, 'VEHICLE_DAY');
});

await check('17. CASH TRANSPORT ALLOWANCE requires an explicit payroll component', async () => {
  await throwsCode(async () => await withTransaction(db, async () => await addonLib.createAddon(db, {
    addon_type: 'TRANSPORT', delivery_mode: 'CASH_ALLOWANCE', rate_sen: 100,
    legal_entity_id: 'KAHE360', client_id: CLI2, project_id: 2, effective_from: '2026-01-01' }, MAKER)),
    addonLib.ERROR.CASH_REQUIRES_COMPONENT);
  const ok = await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'CASH_ALLOWANCE',
    payroll_component_code: 'ALLOW_TRANSPORT', rate_sen: money.rupiahToSen(500000),
    quantity_basis: 'PER_WORKER_PER_MONTH', client_id: CLI2, project_id: 2 });
  eq(addonLib.natureOf(ok), 'CASH_ALLOWANCE');
  eq(ok.payroll_component_code, 'ALLOW_TRANSPORT');
});

await check('18. SHUTTLE carrying a payroll component is rejected', async () => {
  for (const mode of ['SHUTTLE_SERVICE','BUS','MINIBUS','DEDICATED_VEHICLE','POOL_VEHICLE','PICKUP_DROP_SERVICE']) {
    await throwsCode(async () => await withTransaction(db, async () => await addonLib.createAddon(db, {
      addon_type: 'TRANSPORT', delivery_mode: mode, payroll_component_code: 'ALLOW_TRANSPORT',
      legal_entity_id: 'KAHE360', client_id: CLI_M, project_id: 2, effective_from: '2026-01-01' }, MAKER)),
      addonLib.ERROR.COMPONENT_ON_NON_CASH, `${mode}: `);
  }
});

await check('19. TRANSPORT rate NOT_CONFIGURED and rate change next month', async () => {
  const C4 = await mkClient('RATECLI', 'KAHE360');
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C4 });
  const noRate = await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP',
    quantity_source: 'TRANSPORT_TRIP', unit_of_measure: 'TRIP', client_id: C4 });
  eq(noRate.rate_status, 'NOT_CONFIGURED');
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C4, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.skipped.find((s) => s.addon_type === 'TRANSPORT').reason, billing.SKIP_REASON.RATE_NOT_CONFIGURED);

  // June Rp1.000.000/trip, July Rp1.200.000/trip — June preserved forever
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP', quantity_source: 'TRANSPORT_TRIP',
    unit_of_measure: 'TRIP', rate_sen: money.rupiahToSen(1200000), client_id: CLI,
    project_id: PRJ, effective_from: '2026-07-01' });
  const june = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI, projectId: PRJ, asOf: '2026-06-30' });
  const july = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI, projectId: PRJ, asOf: '2026-07-31' });
  eq(rp(june.rate_sen), 1000000, 'June: ');
  eq(rp(july.rate_sen), 1200000, 'July: ');
});

// =============================================================================
section('ACCOMMODATION');
// =============================================================================

await check('20. BED_NIGHT billing for KAHE Mess', async () => {
  await mkAddon({ addon_type: 'ACCOMMODATION', delivery_mode: 'KAHE_MESS', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE',
    client_id: CLI, project_id: PRJ });
  await mkRate({ addon_type: 'ACCOMMODATION', pricing_model: 'BED_NIGHT', quantity_source: 'BED_NIGHT',
    unit_of_measure: 'BED_NIGHT', rate_sen: money.rupiahToSen(75000), client_id: CLI, project_id: PRJ });
  await mkQty({ addon_type: 'ACCOMMODATION', quantity_source: 'BED_NIGHT', quantity: 480,
    unit_of_measure: 'BED_NIGHT', project_id: PRJ, source_reference: 'log mess Juni' });
  const a = lineFor(await preview(await runFor('2026-06', { projectId: PRJ })), 'ACCOMMODATION');
  eq(a.quantity, 480);
  eq(rp(a.amount_sen), 480 * 75000);
  eq(a.delivery_mode, 'KAHE_MESS');
  // and no housing allowance is created
  eq((await addonLib.resolvePayrollImpact(db, S({ projectId: PRJ }))).components
    .some((c) => c.addon_type === 'ACCOMMODATION'), false, 'no housing allowance: ');
});

await check('21. CLIENT_CAMP is not billable and creates no allowance', async () => {
  const C5 = await mkClient('CAMPCLI', 'KAHE360');
  await mkAddon({ addon_type: 'ACCOMMODATION', delivery_mode: 'CLIENT_CAMP', client_billable: 0,
    client_billable_mode: 'NO', cost_bearer: 'CLIENT', billing_treatment: 'NON_BILLABLE', client_id: C5 });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C5, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.some((l) => l.addon_type === 'ACCOMMODATION'), false);
  eq((await addonLib.resolvePayrollImpact(db, { legalEntityId: 'KAHE360', clientId: C5, asOf: '2026-06-30' }))
    .components.length, 0);
});

await check('22. FIXED_MONTHLY accommodation, and historical rate preserved', async () => {
  const C6 = await mkClient('HOTELCLI', 'KAHE360');
  await mkAddon({ addon_type: 'ACCOMMODATION', delivery_mode: 'HOTEL_LODGING', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'BUNDLED', client_id: C6 });
  await mkRate({ addon_type: 'ACCOMMODATION', pricing_model: 'FIXED_MONTHLY', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'MONTH', rate_sen: money.rupiahToSen(40000000), client_id: C6 });
  await mkRate({ addon_type: 'ACCOMMODATION', pricing_model: 'FIXED_MONTHLY', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'MONTH', rate_sen: money.rupiahToSen(45000000), client_id: C6,
    effective_from: '2026-07-01' });
  const june = await rateLib.resolveRate(db, { addonType: 'ACCOMMODATION', legalEntityId: 'KAHE360',
    clientId: C6, asOf: '2026-06-30' });
  eq(rp(june.rate_sen), 40000000, 'June preserved: ');
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C6, billingPeriod: '2026-06' }, MAKER)), MAKER);
  const a = lineFor(r, 'ACCOMMODATION');
  eq(a.quantity, null, 'fixed monthly needs no quantity: ');
  eq(rp(a.amount_sen), 40000000);
  eq(a.billing_treatment, 'BUNDLED');
});

await check('23. ACCOMMODATION NOT_PROVIDED produces nothing', async () => {
  const C7 = await mkClient('NOACC', 'KAHE360');
  await mkAddon({ addon_type: 'ACCOMMODATION', delivery_mode: 'NOT_PROVIDED', client_id: C7 });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C7, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.length, 0);
  eq(r.skipped.find((s) => s.addon_type === 'ACCOMMODATION').reason, billing.SKIP_REASON.NOT_PROVIDED);
});

// =============================================================================
section('QUANTITY DISCIPLINE');
// =============================================================================

await check('24. DUPLICATE QUANTITY for the same service day is prevented', async () => {
  const base = { addon_type: 'TRANSPORT', quantity_source: 'TRANSPORT_TRIP', quantity: 2,
    unit_of_measure: 'TRIP', project_id: PRJ, service_date: '2026-06-02' };
  await throwsCode(async () => await mkQty(base, MAKER, false), qtyLib.ERROR.DUPLICATE_QUANTITY);
  // and the database index backs it up
  await throwsMatching(async () => await db.prepare(`INSERT INTO billing_quantities (legal_entity_id,client_id,project_id,
    addon_type,billing_period,service_date,quantity_source,quantity,unit_of_measure,created_by,created_at)
    VALUES ('KAHE360',?,?, 'TRANSPORT','2026-06','2026-06-02','TRANSPORT_TRIP',9,'TRIP','x',kahe_now())`)
    .run(CLI, PRJ), /UNIQUE|constraint/i);
});

await check('25. NEGATIVE quantity is rejected unless it is an explicit adjustment', async () => {
  await throwsCode(async () => await mkQty({ addon_type: 'MEALS', meal_type: 'LUNCH',
    quantity_source: 'MEAL_CONSUMPTION', quantity: -5, unit_of_measure: 'MEAL' }, MAKER, false),
    qtyLib.ERROR.NEGATIVE_QUANTITY);
  // an explicit adjustment against a prior record is allowed
  const prior = await db.prepare(`SELECT id FROM billing_quantities WHERE meal_type='LUNCH' LIMIT 1`).get();
  const adj = await mkQty({ addon_type: 'MEALS', meal_type: 'LUNCH', quantity_source: 'MEAL_CONSUMPTION',
    quantity: -5, unit_of_measure: 'MEAL', is_adjustment: 1, corrects_quantity_id: prior.id,
    adjustment_reason: 'koreksi nota ganda', billing_period: '2026-09' }, MAKER, false);
  eq(adj.quantity, -5);
  eq(adj.is_adjustment, 1);
});

await check('26. ZERO quantity is legitimate and is reported, not billed', async () => {
  const C8 = await mkClient('ZEROCLI', 'KAHE360');
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C8 });
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP', quantity_source: 'TRANSPORT_TRIP',
    unit_of_measure: 'TRIP', rate_sen: money.rupiahToSen(500000), client_id: C8 });
  await withTransaction(db, async () => {
    const q = await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360', client_id: C8,
      billing_period: '2026-06', addon_type: 'TRANSPORT', quantity_source: 'TRANSPORT_TRIP',
      quantity: 0, unit_of_measure: 'TRIP', source_reference: 'shuttle jalan, tidak ada penumpang' }, MAKER);
    await qtyLib.verifyQuantity(db, q.id, VERIFIER, 'nol sah');
  });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C8, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.some((l) => l.addon_type === 'TRANSPORT'), false, 'not billed: ');
  eq(r.skipped.find((s) => s.addon_type === 'TRANSPORT').reason, billing.SKIP_REASON.ZERO_QUANTITY);
});

await check('27. only VERIFIED quantities are billable', async () => {
  const C9 = await mkClient('UNVCLI', 'KAHE360');
  await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'SHUTTLE_SERVICE', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C9 });
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'PER_TRIP', quantity_source: 'TRANSPORT_TRIP',
    unit_of_measure: 'TRIP', rate_sen: money.rupiahToSen(500000), client_id: C9 });
  await withTransaction(db, async () => await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360', client_id: C9,
    billing_period: '2026-06', addon_type: 'TRANSPORT', quantity_source: 'TRANSPORT_TRIP',
    quantity: 10, unit_of_measure: 'TRIP' }, MAKER));
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C9, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.skipped.find((s) => s.addon_type === 'TRANSPORT').reason, billing.SKIP_REASON.NO_VERIFIED_QUANTITY);
});

await check('28. SoD: the recorder cannot verify their own quantity', async () => {
  const q = await withTransaction(db, async () => await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360',
    client_id: CLI, billing_period: '2026-08', addon_type: 'MEALS', meal_type: 'LUNCH',
    quantity_source: 'MEAL_CONSUMPTION', quantity: 10, unit_of_measure: 'MEAL' }, MAKER));
  const selfVerify = { displayName: 'Billing Officer', permissions: { client_billing: ['APPROVE'] } };
  await throwsCode(async () => await withTransaction(db, async () => await qtyLib.verifyQuantity(db, q.id, selfVerify, 'x')),
    qtyLib.ERROR.SOD_VIOLATION);
});

await check('29. CORRECTION supersedes without editing, and keeps the history', async () => {
  const q = await withTransaction(db, async () => await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360',
    client_id: CLI, billing_period: '2026-08', addon_type: 'ACCOMMODATION',
    quantity_source: 'BED_NIGHT', quantity: 100, unit_of_measure: 'BED_NIGHT',
    service_date: '2026-08-05', source_reference: 'log awal' }, MAKER));
  const out = await withTransaction(db, async () => await qtyLib.correctQuantity(db, q.id, 92, APPROVER, 'salah hitung 8 bed-night'));
  eq(out.superseded.verification_status, 'SUPERSEDED');
  eq(out.superseded.quantity, 100, 'original figure preserved: ');
  eq(out.corrected.quantity, 92);
  eq(out.corrected.version, 2);
  eq(out.corrected.corrects_quantity_id, q.id);
  eq(out.corrected.adjustment_reason, 'salah hitung 8 bed-night');
  const audit = (await db.prepare('SELECT action FROM billing_quantity_audit WHERE quantity_id IN (?,?) ORDER BY id')
    .all(q.id, out.corrected.id)).map((a) => a.action);
  eq(audit.includes('SUPERSEDED') && audit.includes('CORRECTED'), true, `audit: ${audit}`);
});

await check('30. MANUAL_APPROVED_QUANTITY is a first-class source', async () => {
  const C10 = await mkClient('MANCLI', 'KAHE360');
  await mkAddon({ addon_type: 'MEALS', delivery_mode: 'THIRD_PARTY_CATERING', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'THIRD_PARTY', billing_treatment: 'SEPARATE', client_id: C10 });
  await mkMeal({ meal_type: 'RAMADAN_MEAL', enabled: 1, client_id: C10 });
  await mkRate({ addon_type: 'MEALS', meal_type: 'RAMADAN_MEAL', pricing_model: 'PER_MEAL',
    quantity_source: 'MANUAL_APPROVED_QUANTITY', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(45000), client_id: C10 });
  await withTransaction(db, async () => {
    const q = await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360', client_id: C10,
      billing_period: '2026-06', addon_type: 'MEALS', meal_type: 'RAMADAN_MEAL',
      quantity_source: 'MANUAL_APPROVED_QUANTITY', quantity: 120, unit_of_measure: 'MEAL',
      source_reference: 'BA kesepakatan manual' }, MAKER);
    await qtyLib.verifyQuantity(db, q.id, VERIFIER, 'disepakati');
  });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C10, billingPeriod: '2026-06' }, MAKER)), MAKER);
  const l = lineFor(r, 'MEALS', 'RAMADAN_MEAL');
  eq(l.quantity, 120);
  eq(l.quantity_source, 'MANUAL_APPROVED_QUANTITY');
  eq(rp(l.amount_sen), 120 * 45000);
});

// =============================================================================
section('COMMERCIAL POSTURE · SERVICE FEE · PAYROLL COST');
// =============================================================================

await check('31. COST BEARER variants are all carried onto the billing line', async () => {
  const r = await preview(await runFor('2026-06', { projectId: PRJ }));
  const bearers = new Set(r.lines.map((l) => l.cost_bearer));
  eq(bearers.has('KAHE'), true, `bearers seen: ${[...bearers]} — `);
  for (const l of r.lines) {
    if (!['CLIENT','KAHE','SHARED','THIRD_PARTY','NOT_APPLICABLE'].includes(l.cost_bearer)) {
      throw new Error(`unknown cost bearer ${l.cost_bearer}`);
    }
  }
});

await check('32. CONDITIONAL billability is never billed automatically', async () => {
  const C11 = await mkClient('CONDCLI', 'KAHE360');
  const a = await mkAddon({ addon_type: 'TRANSPORT', delivery_mode: 'POOL_VEHICLE', client_billable: 1,
    client_billable_mode: 'CONDITIONAL', billable_condition: 'hanya bila klien menyetujui rekap bulanan',
    cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C11 });
  eq(a.client_billable_mode, 'CONDITIONAL');
  await mkRate({ addon_type: 'TRANSPORT', pricing_model: 'FIXED_MONTHLY', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'MONTH', rate_sen: money.rupiahToSen(5000000), client_id: C11 });
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C11, billingPeriod: '2026-06' }, MAKER)), MAKER);
  eq(r.lines.some((l) => l.addon_type === 'TRANSPORT'), false, 'not billed automatically: ');
  const sk = r.skipped.find((s) => s.addon_type === 'TRANSPORT');
  eq(sk.reason, billing.SKIP_REASON.CONDITIONAL_UNMET);
  eq(sk.condition, 'hanya bila klien menyetujui rekap bulanan', 'the condition is surfaced: ');
});

await check('33. SERVICE FEE disabled / NOT_CONFIGURED produces no line and no Rp0 row', async () => {
  const r = await preview(await runFor('2026-06', { projectId: PRJ }));
  eq(r.lines.some((l) => l.addon_type === 'SERVICE_FEE'), false);
  const sk = r.skipped.find((s) => s.addon_type === 'SERVICE_FEE');
  eq([billing.SKIP_REASON.NO_RATE_CARD, billing.SKIP_REASON.RATE_NOT_CONFIGURED].includes(sk.reason), true);
  eq(r.lines.some((l) => l.amount_sen === 0), false, 'no fake Rp0 anywhere: ');
});

await check('34. SERVICE FEE, once configured, is applied to the subtotal', async () => {
  const C12 = await mkClient('FEECLI', 'KAHE360');
  await mkAddon({ addon_type: 'ACCOMMODATION', delivery_mode: 'THIRD_PARTY_HOUSING', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'THIRD_PARTY', billing_treatment: 'SEPARATE', client_id: C12 });
  await mkRate({ addon_type: 'ACCOMMODATION', pricing_model: 'FIXED_MONTHLY', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'MONTH', rate_sen: money.rupiahToSen(10000000), client_id: C12 });
  await mkRate({ addon_type: 'SERVICE_FEE', pricing_model: 'PERCENTAGE', quantity_source: 'NOT_APPLICABLE',
    unit_of_measure: 'UNIT', rate_sen: 750, client_id: C12 });   // 7.5% in basis points
  const r = await billing.calculateRun(db, await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C12, billingPeriod: '2026-06' }, MAKER)), MAKER);
  const fee = lineFor(r, 'SERVICE_FEE');
  eq(fee.effective_rate_sen, 750);
  eq(fee.amount_sen, money.applyBp(money.rupiahToSen(10000000), 750));
  eq(rp(fee.amount_sen), 750000, '7,5% dari Rp10jt: ');
});

await check('35. PAYROLL COST is read from FINALIZED payroll only, never recalculated', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'billingCalculator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const w of [/UPDATE\s+payroll/i, /INSERT\s+INTO\s+payroll_run/i, /DELETE\s+FROM\s+payroll/i]) {
    if (w.test(code)) throw new Error(`billing must not write payroll: ${w}`);
  }
  for (const t of ['payrollCalculator', 'employee_salary_components', 'ptkp_ter_rates', 'payroll_rule_sets']) {
    if (code.includes(t)) throw new Error(`billing must not touch ${t}`);
  }
  if (!/status\s*=\s*'FINALIZED'/.test(code)) throw new Error('payroll read must be restricted to FINALIZED runs');
});

await check('36. no payroll table was mutated by this entire suite', async () => {
  for (const t of ['payroll_runs','payroll_run_lines','payroll_input_snapshots','payroll_payslips',
    'employee_salary_components','payroll_payment_items','payroll_adjustments','salary_components']) {
    eq((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n, 0, `${t} rows: `);
  }
});

// =============================================================================
section('PERSISTENCE · REPRODUCIBILITY · FREEZE');
// =============================================================================

let FROZEN_RUN;
await check('37. a calculated run is persisted with full provenance', async () => {
  const run = await runFor('2026-06', { projectId: PRJ });
  const result = await billing.calculateRun(db, run, MAKER);
  const out = await withTransaction(db, async () => await billing.persistRun(db, run, result, MAKER));
  FROZEN_RUN = out.run;
  eq(out.run.status, 'CALCULATED');
  eq(out.line_count, result.lines.length);
  const explained = await billing.explainRun(db, out.run.id);
  eq(explained.reconciles, true, 'lines sum to the run total exactly: ');
  eq(explained.is_invoice, false, 'this is a draft statement, not an invoice: ');
  for (const l of explained.lines) {
    for (const f of ['addon_type','pricing_model','amount_sen','cost_bearer','billing_treatment',
      'calculation_timestamp','billing_period','legal_entity_id','client_id']) {
      if (l[f] === null || l[f] === undefined) throw new Error(`line missing ${f}`);
    }
    if (l.source_type === 'ADDON' && !l.rate_card_id) throw new Error('line must name its rate card');
  }
  const trip = explained.lines.find((l) => l.addon_type === 'TRANSPORT');
  eq(Array.isArray(trip.quantity_ids) && trip.quantity_ids.length === 3, true, 'quantity provenance: ');
  eq(trip.verified_by, 'Site Supervisor', 'who verified it: ');
});

await check('38. consumed quantities are marked, so a second run cannot double-bill', async () => {
  const marked = (await db.prepare('SELECT COUNT(*) AS n FROM billing_quantities WHERE billed_in_run_id = ?')
    .get(FROZEN_RUN.id)).n;
  eq(marked > 0, true, `quantities consumed (${marked}): `);
  const second = await runFor('2026-06', { projectId: PRJ });
  const r2 = await billing.calculateRun(db, second, MAKER);
  eq(r2.lines.some((l) => l.addon_type === 'TRANSPORT' && l.quantity === 5), false,
    'the same trips are not billed twice: ');
});

await check('39. a CALCULATED run is frozen — lines cannot be edited or deleted', async () => {
  const line = await db.prepare('SELECT * FROM billing_lines WHERE billing_run_id = ? LIMIT 1').get(FROZEN_RUN.id);
  await throwsMatching(async () => await db.prepare('UPDATE billing_lines SET amount_sen = 1 WHERE id = ?').run(line.id),
    /BILLING_CALCULATED/, 'update: ');
  await throwsMatching(async () => await db.prepare('DELETE FROM billing_lines WHERE id = ?').run(line.id),
    /BILLING_CALCULATED/, 'delete: ');
  await throwsCode(async () => await billing.calculateRun(db, FROZEN_RUN, MAKER), billing.ERROR.ALREADY_CALCULATED);
});

await check('40. LATER RATE CHANGES do not alter a frozen statement', async () => {
  const before = await billing.explainRun(db, FROZEN_RUN.id);
  // change the world: a new accommodation rate from today
  await mkRate({ addon_type: 'ACCOMMODATION', pricing_model: 'BED_NIGHT', quantity_source: 'BED_NIGHT',
    unit_of_measure: 'BED_NIGHT', rate_sen: money.rupiahToSen(500000), client_id: CLI,
    project_id: PRJ, effective_from: '2026-08-01' });
  const after = await billing.explainRun(db, FROZEN_RUN.id);
  eq(after.run.total_amount_sen, before.run.total_amount_sen, 'total unchanged: ');
  eq(JSON.stringify(after.lines), JSON.stringify(before.lines), 'every line unchanged: ');
});

await check('41. an ACTIVE rate version cannot be edited in place', async () => {
  const active = await db.prepare(`SELECT * FROM billing_rate_cards WHERE status='ACTIVE' AND rate_sen IS NOT NULL LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare('UPDATE billing_rate_cards SET rate_sen = 1 WHERE id = ?').run(active.id),
    /RATE_ACTIVE/);
  await throwsMatching(async () => await db.prepare(`UPDATE billing_rate_cards SET pricing_model='CUSTOM' WHERE id = ?`).run(active.id),
    /RATE_ACTIVE/);
});

await check('42. only one open ACTIVE rate per scope is possible', async () => {
  const active = await db.prepare(`SELECT * FROM billing_rate_cards WHERE status='ACTIVE' AND effective_to IS NULL LIMIT 1`).get();
  await throwsMatching(async () => await db.prepare(`INSERT INTO billing_rate_cards (addon_type,meal_type,pricing_model,
    quantity_source,unit_of_measure,rate_sen,rate_status,legal_entity_id,client_id,project_id,
    version,effective_from,status,created_by,created_at)
    VALUES (?,?,?,?,?,?, 'CONFIGURED',?,?,?,99,'2030-01-01','ACTIVE','x',kahe_now())`)
    .run(active.addon_type, active.meal_type, active.pricing_model, active.quantity_source,
      active.unit_of_measure, 1, active.legal_entity_id, active.client_id, active.project_id),
    /UNIQUE|constraint/i);
});

// =============================================================================
section('ISOLATION · SCALE · REGRESSION');
// =============================================================================

await check('43. CROSS-CLIENT isolation: quantities and rates never leak', async () => {
  const cliRates = (await db.prepare('SELECT COUNT(*) AS n FROM billing_rate_cards WHERE client_id = ?').get(CLI)).n;
  const cli2Rates = (await db.prepare('SELECT COUNT(*) AS n FROM billing_rate_cards WHERE client_id = ?').get(CLI2)).n;
  eq(cliRates > 0 && cli2Rates > 0, true);
  const june = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI, projectId: PRJ, asOf: '2026-06-30' });
  const other = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI2, asOf: '2026-06-30' });
  eq(june.client_id, CLI);
  eq(other.client_id, CLI2);
  eq(june.pricing_model !== other.pricing_model, true, 'different commercial terms per client: ');
  const q = await qtyLib.getBillableQuantities(db, { legalEntityId: 'KAHE360', clientId: CLI2,
    billingPeriod: '2026-06', addonType: 'MEALS' });
  eq(q.every((x) => x.client_id === CLI2), true);
});

await check('44. CROSS-ENTITY isolation: MITRA never resolves KAHE terms', async () => {
  const kahe = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'KAHE360',
    clientId: CLI, projectId: PRJ, asOf: '2026-06-30' });
  const mitra = await rateLib.resolveRate(db, { addonType: 'TRANSPORT', legalEntityId: 'MITRA',
    clientId: CLI_M, asOf: '2026-06-30' });
  eq(kahe.legal_entity_id, 'KAHE360');
  eq(mitra, null, 'MITRA has no transport rate of its own: ');
  // a billing run refuses a client belonging to another entity
  await throwsCode(async () => await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: CLI_M, billingPeriod: '2026-06' }, MAKER)),
    billing.ERROR.ENTITY_MISMATCH);
});

await check('45. 1,500-worker billing scenario computes exactly', async () => {
  const C13 = await mkClient('SCALECLI', 'KAHE360');
  await mkAddon({ addon_type: 'MEALS', delivery_mode: 'CATERING', client_billable: 1,
    client_billable_mode: 'YES', cost_bearer: 'KAHE', billing_treatment: 'SEPARATE', client_id: C13 });
  await mkMeal({ meal_type: 'LUNCH', enabled: 1, client_id: C13 });
  await mkRate({ addon_type: 'MEALS', meal_type: 'LUNCH', pricing_model: 'PER_MEAL',
    quantity_source: 'MEAL_CONSUMPTION', unit_of_measure: 'MEAL',
    rate_sen: money.rupiahToSen(35000), client_id: C13 });

  const t0 = Date.now();
  await withTransaction(db, async () => {
    const ins = db.prepare(`INSERT INTO employees (id,full_name,worker_type,status,start_date,project_code)
      VALUES (?,?,'pkwt','active','2026-01-01','PPB')`);
    for (let i = 0; i < 1500; i += 1) await ins.run(`SC-${String(i).padStart(4,'0')}`, `Scale ${i}`);
  });
  // one verified lunch quantity per worker: 22 lunches each (not 26 attendance days)
  await withTransaction(db, async () => {
    for (let i = 0; i < 1500; i += 1) {
      const q = await qtyLib.recordQuantity(db, { legal_entity_id: 'KAHE360', client_id: C13,
        billing_period: '2026-06', addon_type: 'MEALS', meal_type: 'LUNCH',
        quantity_source: 'MEAL_CONSUMPTION', quantity: 22, unit_of_measure: 'MEAL',
        employee_id: `SC-${String(i).padStart(4,'0')}`, source_reference: 'rekap katering' }, MAKER);
      await qtyLib.verifyQuantity(db, q.id, VERIFIER, 'batch');
    }
  });
  const run = await withTransaction(db, async () => await billing.createRun(db,
    { legalEntityId: 'KAHE360', clientId: C13, billingPeriod: '2026-06' }, MAKER));
  const result = await billing.calculateRun(db, run, MAKER);
  const out = await withTransaction(db, async () => await billing.persistRun(db, run, result, MAKER));
  const ms = Date.now() - t0;

  const l = await db.prepare(`SELECT * FROM billing_lines WHERE billing_run_id=? AND meal_type='LUNCH'`).get(out.run.id);
  eq(l.quantity, 1500 * 22, 'total lunches: ');
  eq(rp(l.amount_sen), 1500 * 22 * 35000, 'exact integer arithmetic at scale: ');
  eq(JSON.parse(l.quantity_ids).length, 1500, 'every contributing quantity is traceable: ');
  eq((await billing.explainRun(db, out.run.id)).reconciles, true);
  console.log(`\n     1,500-worker billing: ${rp(l.amount_sen).toLocaleString('id-ID')} rupiah in ${ms}ms`);
});

await check('46. all money is integer sen; no floating point anywhere', async () => {
  for (const [t, c] of [['billing_lines','amount_sen'], ['billing_lines','effective_rate_sen'],
    ['billing_rate_cards','rate_sen'], ['billing_runs','total_amount_sen'],
    ['billing_quantities','quantity']]) {
    const bad = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND CAST(${c} AS BIGINT) != ${c}`).get()).n;
    eq(bad, 0, `${t}.${c}: `);
  }
});

await check('47. Phase 3B builds NO invoice, AR, tax invoice or fleet module', async () => {
  const tables = (await pgx.tableNames(db)).map((t) => t.name);
  for (const f of ['client_invoices','invoice_lines','accounts_receivable','tax_invoices',
    'fleet_vehicles','dispatch_orders','vehicles','routes']) {
    if (tables.includes(f)) throw new Error(`Phase 3B must not create ${f}`);
  }
  for (const req of ['billing_rate_cards','billing_quantities','billing_runs','billing_lines','meal_plan_items']) {
    eq(tables.includes(req), true, `${req}: `);
  }
});

await check('48. future mobility references are RECORDED but nothing acts on them', async () => {
  const q = await db.prepare(`SELECT * FROM billing_quantities WHERE vehicle_id IS NOT NULL ORDER BY id LIMIT 1`).get();
  eq(q.route_id, 'R-01');
  eq(q.vehicle_type, 'MINIBUS');
  eq(q.trip_reference !== null, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'billingCalculator.js'), 'utf8');
  for (const t of ['dispatch', 'fleet', 'assignVehicle', 'scheduleRoute']) {
    if (src.includes(t)) throw new Error(`Phase 3B must not build fleet/dispatch: ${t}`);
  }
});

await check('49. prior invariants and triggers are untouched', async () => {
  const idx = (await pgx.indexNames(db, 'uq_%')).map((r) => r.name);
  for (const req of ['uq_payroll_run_single_finalized_original','uq_snapshot_period_employee',
    'uq_addon_open_per_scope','uq_rate_open_per_scope','uq_qty_live_per_service_day',
    'uq_meal_plan_open_per_scope']) {
    if (!idx.includes(req)) throw new Error(`missing index: ${req}`);
  }
  const trg = (await pgx.triggerNames(db)).map((r) => r.name);
  for (const req of ['trg_lock_finalized_run_status','trg_lock_active_addon_terms',
    'trg_lock_active_rate','trg_lock_calculated_billing_line']) {
    if (!trg.includes(req)) throw new Error(`missing trigger: ${req}`);
  }
});

await check('50. Phase 3A add-on behaviour is unchanged', () => {
  eq(addonLib.natureOf({ enabled: 1, delivery_mode: 'SHUTTLE_SERVICE' }), 'BENEFIT_IN_KIND');
  eq(addonLib.natureOf({ enabled: 1, delivery_mode: 'CASH_ALLOWANCE' }), 'CASH_ALLOWANCE');
  eq(addonLib.natureOf({ enabled: 1, delivery_mode: 'NOT_PROVIDED' }), 'NOT_PROVIDED');
  eq([...addonLib.CASH_MODES].sort(), ['CASH_ALLOWANCE','HOUSING_ALLOWANCE'], 'still only two cash modes: ');
});

db.close();
for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);

console.log(`\n${'='.repeat(60)}`);
console.log(`PHASE 3B TESTS: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); }
console.log('='.repeat(60));
await __t.drop();
process.exit(failed ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });
