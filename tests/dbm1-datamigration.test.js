// tests/dbm1-datamigration.test.js — DB-M1 CP4. One-way SQLite -> PostgreSQL data migration:
// preflight (report and BLOCK, never normalise), id preservation, identity reset, reconciliation,
// safe failure. Real SQLite files (A3 schema) and a real PostgreSQL server; no mocks.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const { createTestDatabase } = require('./helpers/pgTestDb');
const M = require('../database/pg/migrate-from-sqlite');

let passed = 0; let failed = 0; const failures = [];
async function check(name, fn) { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); } }
const eq = (a, e, l = '') => { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${l}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const ok = (v, l) => { if (!v) throw new Error(l || 'expected truthy'); };
const section = (t) => console.log(`\n${t}`);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const quiet = () => {};
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kahe-mig-'));

/** A small but real A3 database: RBAC, an employee, attendance with a 2-version correction chain, audit events. */
function buildSource(file) {
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys = ON;'); require('../database/legacy-sqlite/init-db').initDb(db);
  const ins = (table, values) => { const row = { ...values }; const ddl = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table).sql;
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) { if (c.name in row || !c.notnull || c.dflt_value !== null || (c.pk && c.type === 'INTEGER')) continue;
      const m = ddl.match(new RegExp(`\\b${c.name}\\s+IN\\s*\\(\\s*'([^']+)'`));
      row[c.name] = m ? m[1] : c.type === 'INTEGER' ? 0 : /(_at|timestamp)$/.test(c.name) ? '2026-01-01 00:00:00' : /date|_from$|_start$|_end$|cutoff/.test(c.name) ? '2026-01-01' : 'x'; }
    const cols = Object.keys(row); return Number(db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => row[k])).lastInsertRowid); };
  const role = ins('roles', { code: 'workforce_manager', name: 'Workforce Manager' });
  ins('roles', { code: 'temp', name: 'Temp' }); db.exec("DELETE FROM roles WHERE code = 'temp'");           // sqlite_sequence is now AHEAD of max(id)
  const user = ins('users', { email: 'wf@kahe360.local', display_name: 'WF', password_hash: '$2b$10$x', is_active: 1 });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(user, role);
  ins('legal_entities', { id: 'KAHE360', name: 'KAHE', entity_type: 'internal', jkk_risk_class: 'high', effective_date: '2019-01-01' });
  ins('employees', { id: 'KAHE-2026-001', full_name: 'Budi', status: 'active' });
  ins('holidays', { date: '2026-12-25', name: 'Natal', scope: 'national' });
  const entry = ins('timesheet_entries', { employee_id: 'KAHE-2026-001', work_date: '2026-09-01', legal_entity_id: 'KAHE360', work_minutes: 480, overtime_minutes_approved: 90, recorded_by_user_id: user });
  ins('attendance_entry_versions', { timesheet_entry_id: entry, employee_id: 'KAHE-2026-001', version_no: 1, version_type: 'ORIGINAL', payload: '{"work_minutes":480}', actor_user_id: user, created_at: '2026-09-01 10:00:00' });
  ins('attendance_entry_versions', { timesheet_entry_id: entry, employee_id: 'KAHE-2026-001', version_no: 2, payload: '{"work_minutes":450}', actor_user_id: user, created_at: '2026-09-02 03:04:05' });
  for (const [i, type] of ['CREATED', 'CORRECTION_APPLIED'].entries()) ins('attendance_events', { timesheet_entry_id: entry, employee_id: 'KAHE-2026-001', work_date: '2026-09-01',
    event_type: type, actor_user_id: user, actor_role_snapshot: 'Workforce Manager', occurred_at: `2026-09-0${i + 1} 10:00:00` });
  db.close(); return { role, user, entry };
}
const GOOD = path.join(DIR, 'good.db'); const ids = buildSource(GOOD);
function tampered(name, sql) { const f = path.join(DIR, `${name}.db`); fs.copyFileSync(GOOD, f);
  const db = new DatabaseSync(f); db.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  // A3's own SQLite triggers refuse to tamper with audit history — drop them in this throwaway COPY to simulate a damaged file
  for (const g of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) db.exec(`DROP TRIGGER ${g.name}`);
  db.exec(sql); db.close(); return f; }

(async () => {
  const fresh = (label) => createTestDatabase(`mig_${label}`);
  const rowCount = async (t, table) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
  const blocked = async (name, sql, expectCheck, expectTable, expectColumn) => {
    const t = await fresh(name);
    try { const f = tampered(name, sql); const before = sha(f);
      const r = await M.migrateFromSqlite({ source: f, connectionString: t.ownerUrl, log: quiet });
      eq(r.result, 'BLOCKED_BY_PREFLIGHT'); const hit = r.preflight.findings.find((x) => x.check === expectCheck && x.table === expectTable && (!expectColumn || x.column === expectColumn));
      ok(hit, `no ${expectCheck} finding on ${expectTable}.${expectColumn}: ${JSON.stringify(r.preflight.findings.slice(0, 3))}`);
      ok(hit.reason && (hit.row || expectCheck === 'schema' || expectCheck === 'duplicate'), 'finding must carry row identity and a reason');
      eq([await rowCount(t, 'users'), await rowCount(t, 'timesheet_entries'), await rowCount(t, 'data_migrations')], [0, 0, 0], 'nothing may be written: ');
      eq(sha(f), before, 'source modified: '); eq(r.source.untouched, true);
      return hit;
    } finally { await t.drop(); } };

  section('PREFLIGHT — REPORT AND BLOCK, NEVER NORMALISE');
  await check('a clean A3 source passes preflight without touching PostgreSQL', async () => { const t = await fresh('pre'); try {
    const r = await M.migrateFromSqlite({ source: GOOD, connectionString: t.ownerUrl, mode: 'preflight', log: quiet });
    eq([r.result, r.preflight.findings.length, await rowCount(t, 'users')], ['PREFLIGHT_OK', 0, 0]); } finally { await t.drop(); } });
  await check('an impossible calendar date blocks (2026-02-30 is not turned into 2 March)', async () => {
    const h = await blocked('baddate', "UPDATE timesheet_entries SET work_date = '2026-02-30'", 'malformed_date', 'timesheet_entries', 'work_date'); ok(/2026-02-30/.test(h.reason)); ok(/id=/.test(h.row)); });
  await check('a date in another format blocks (01/09/2026 is not reinterpreted)', () => blocked('fmtdate', "UPDATE employees SET birth_date = '01/09/2026'", 'malformed_date', 'employees', 'birth_date'));
  await check('an ISO "T…Z" timestamp blocks (it would come back in a different representation)', () =>
    blocked('isots', "UPDATE attendance_entry_versions SET created_at = '2026-09-01T10:00:00.000Z' WHERE version_no = 1", 'malformed_timestamp', 'attendance_entry_versions', 'created_at'));
  await check('an out-of-range time blocks', () => blocked('badts', "UPDATE users SET created_at = '2026-09-01 25:61:00'", 'malformed_timestamp', 'users', 'created_at'));
  await check('an orphan foreign key blocks', () => blocked('orphan', 'DELETE FROM roles', 'foreign_key', 'user_roles', 'role_id'));
  await check('a duplicate that violates a PARTIAL unique index blocks', () => blocked('dup',
    "DROP INDEX uq_holiday_national_per_date; INSERT INTO holidays (date, name, scope) VALUES ('2026-12-25', 'dup', 'national')", 'duplicate', 'holidays'));
  await check('NULL in a PostgreSQL NOT NULL column blocks (SQLite allows NULL in a TEXT primary key)', () =>
    blocked('nullpk', "INSERT INTO legal_entities (id, name, entity_type, jkk_risk_class, effective_date) VALUES (NULL, 'ghost', 'internal', 'low', '2020-01-01')", 'nullability', 'legal_entities', 'id'));
  await check('text stored in an INTEGER column blocks (SQLite loose typing)', () => blocked('loose', "UPDATE timesheet_entries SET work_minutes = 'eight hours'", 'type', 'timesheet_entries', 'work_minutes'));
  await check('a fractional value in an INTEGER column blocks (it is not rounded)', () => blocked('real', 'UPDATE timesheet_entries SET overtime_minutes_approved = 90.5', 'integer_range', 'timesheet_entries', 'overtime_minutes_approved'));
  await check('an integer beyond the safe range blocks', () => blocked('range', 'UPDATE timesheet_entries SET work_minutes = 9223372036854775807', 'integer_range', 'timesheet_entries', 'work_minutes'));
  await check('a BLOB stored in a TEXT column blocks', () => blocked('blob', "UPDATE employees SET full_name = X'00FF'", 'type', 'employees', 'full_name'));
  await check('a historical id that cannot be preserved blocks', () => blocked('zeroid', 'UPDATE roles SET id = 0', 'identity', 'roles', 'id'));
  await check('a broken correction/version chain blocks (versions 1,3)', () => blocked('chain', 'UPDATE attendance_entry_versions SET version_no = 3 WHERE version_no = 2', 'version_chain', 'attendance_entry_versions', 'version_no'));
  await check('a broken audit reference blocks (event points at a missing attendance row)', () => blocked('audit', 'UPDATE attendance_events SET timesheet_entry_id = 999 WHERE id = 1', 'audit_reference', 'attendance_events', 'timesheet_entry_id'));
  await check('an audit event by a user that does not exist blocks', () => blocked('actor', 'UPDATE attendance_events SET actor_user_id = 777', 'audit_reference', 'attendance_events', 'actor_user_id'));
  await check('a table the PostgreSQL schema does not know blocks (no data is dropped silently)', () => blocked('extra', 'CREATE TABLE my_notes (x TEXT); INSERT INTO my_notes VALUES (1)', 'schema', 'my_notes'));
  await check('a source that is not at the A3 shape blocks', async () => {
    const probe = new DatabaseSync(GOOD, { readOnly: true }); const last = probe.prepare('PRAGMA table_info(attendance_payroll_adjustments)').all().pop().name; probe.close();
    await blocked('old', `ALTER TABLE attendance_payroll_adjustments DROP COLUMN ${last}`, 'schema', 'attendance_payroll_adjustments', last); });

  section('MIGRATION');
  const t = await fresh('main'); const owner = t.openOwner();
  await check('dry-run reconciles a full trial load and leaves the destination untouched', async () => {
    const r = await M.migrateFromSqlite({ source: GOOD, connectionString: t.ownerUrl, mode: 'dry-run', log: quiet });
    eq([r.result, r.reconciliation.ok, await rowCount(t, 'users'), await rowCount(t, 'data_migrations')], ['DRY_RUN_OK_ROLLED_BACK', true, 0, 0]); });
  let report;
  await check('migrates every table: row difference 0 and identical content checksum on all 63', async () => {
    const before = sha(GOOD); report = await M.migrateFromSqlite({ source: GOOD, connectionString: t.ownerUrl, log: quiet });
    eq(report.result, 'MIGRATED'); const tabs = Object.values(report.reconciliation.tables);
    eq([tabs.length, tabs.filter((x) => x.difference !== 0).length, tabs.filter((x) => !x.content_match).length], [63, 0, 0]);
    eq([report.totals.source_rows, report.invariants.ok, report.integrity.ok, sha(GOOD) === before], [report.totals.destination_rows, true, true, true]); });
  await check('table order comes from the real foreign keys (every parent before its child)', () => {
    const pos = Object.fromEntries(report.migration_order.map((n, i) => [n, i]));
    for (const [c, p] of [['user_roles', 'users'], ['user_roles', 'roles'], ['payroll_run_lines', 'payroll_runs'], ['payroll_runs', 'payroll_periods'], ['payroll_payslips', 'payroll_run_lines'],
      ['attendance_corrections', 'timesheet_entries'], ['attendance_correction_actions', 'attendance_corrections'], ['attendance_payroll_adjustments', 'attendance_corrections']]) ok(pos[p] < pos[c], `${p} must precede ${c}`); });
  await check('historical primary keys, dates, timestamps and role snapshots are preserved exactly', async () => {
    eq(await t.db.prepare('SELECT id, timesheet_entry_id, event_type, actor_user_id, actor_role_snapshot, occurred_at FROM attendance_events ORDER BY id').all(),
      [{ id: 1, timesheet_entry_id: ids.entry, event_type: 'CREATED', actor_user_id: ids.user, actor_role_snapshot: 'Workforce Manager', occurred_at: '2026-09-01 10:00:00' },
        { id: 2, timesheet_entry_id: ids.entry, event_type: 'CORRECTION_APPLIED', actor_user_id: ids.user, actor_role_snapshot: 'Workforce Manager', occurred_at: '2026-09-02 10:00:00' }]);
    eq(await t.db.prepare('SELECT version_no, payload, created_at FROM attendance_entry_versions ORDER BY version_no').all(),
      [{ version_no: 1, payload: '{"work_minutes":480}', created_at: '2026-09-01 10:00:00' }, { version_no: 2, payload: '{"work_minutes":450}', created_at: '2026-09-02 03:04:05' }]);
    eq(await t.db.prepare('SELECT work_date, work_minutes, overtime_minutes_approved FROM timesheet_entries').get(), { work_date: '2026-09-01', work_minutes: 480, overtime_minutes_approved: 90 }); });
  await check('identity generators continue AFTER the highest id SQLite ever issued — a deleted historical id is never reused', async () => {
    eq(report.load.sequences.roles, { max_historical_id: ids.role, sqlite_sequence: ids.role + 1, next_id: ids.role + 2 });
    eq((await t.db.prepare("INSERT INTO roles (code, name) VALUES ('new_role', 'New') RETURNING id").run()).lastInsertRowid, ids.role + 2); });
  await check('new records on every migrated identity table get an id above all historical ids', async () => {
    const e = (await t.db.prepare(`INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('KAHE-2026-001', '2026-09-03', 'CREATED') RETURNING id`).run()).lastInsertRowid;
    const u = (await t.db.prepare(`INSERT INTO users (email, display_name, password_hash) VALUES ('n@x', 'N', 'h') RETURNING id`).run()).lastInsertRowid;
    eq([e, u], [3, ids.user + 1]); });
  await check('integrity triggers are enforced again on the MIGRATED history (runtime role, raw SQL)', async () => {
    for (const sql of ['UPDATE attendance_events SET event_type = \'X\' WHERE id = 1', 'DELETE FROM attendance_events WHERE id = 1', 'DELETE FROM attendance_entry_versions', 'UPDATE attendance_entry_versions SET payload = \'{}\'']) {
      let e = null; try { await t.db.exec(sql); } catch (x) { e = x; } ok(e && e.code === 'KH001', `not blocked: ${sql}`); } });
  await check('the migration ledger records the exact source file and the reconciliation checksum', async () => {
    const l = await owner.prepare('SELECT source_name, source_sha256, tables_migrated, rows_migrated, content_checksum FROM data_migrations').all();
    eq(l, [{ source_name: 'good.db', source_sha256: sha(GOOD), tables_migrated: 63, rows_migrated: report.totals.destination_rows, content_checksum: report.reconciliation.content_checksum }]); });
  await check('a second run is refused: the destination is not fresh, and nothing changes', async () => {
    const before = await rowCount(t, 'attendance_events');
    const r = await M.migrateFromSqlite({ source: GOOD, connectionString: t.ownerUrl, log: quiet });
    eq(r.result, 'FAILED_ROLLED_BACK'); ok(/not fresh/.test(r.error.message)); eq(await rowCount(t, 'attendance_events'), before); });
  await check('reconciliation is content-level: one changed value is found and located', async () => {
    await owner.exec("UPDATE employees SET full_name = 'Budi X' WHERE id = 'KAHE-2026-001'");
    const pg = new Client({ connectionString: t.ownerUrl, options: '-c timezone=UTC' }); await pg.connect(); const src = new DatabaseSync(GOOD, { readOnly: true });
    try { const r = await M.reconcile(src, pg, await M.loadCatalogue(pg)); const e = r.tables.employees;
      eq([r.ok, e.difference, e.content_match, e.first_difference.row, e.first_difference.column, e.first_difference.sqlite, e.first_difference.postgresql], [false, 0, false, 'id=KAHE-2026-001', 'full_name', 'Budi', 'Budi X']);
    } finally { src.close(); await pg.end(); } });

  section('SAFE FAILURE');
  await check('a row PostgreSQL rejects mid-load rolls back EVERYTHING; the error names the table; rerun works after the fix', async () => {
    const d = await fresh('fail'); try {
      const f = tampered('check', "UPDATE holidays SET scope = 'galactic'");      // violates a CHECK that preflight does not model
      const r = await M.migrateFromSqlite({ source: f, connectionString: d.ownerUrl, log: quiet });
      eq([r.result, r.error.table], ['FAILED_ROLLED_BACK', 'holidays']); ok(/check constraint/i.test(r.error.message), r.error.message);
      eq([await rowCount(d, 'users'), await rowCount(d, 'roles'), await rowCount(d, 'data_migrations')], [0, 0, 0], 'partial load survived: ');
      const o = d.openOwner(); eq((await o.prepare(`SELECT COUNT(*) AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgenabled <> 'O'`).get()).n, 0, 'triggers left disabled: ');
      eq((await M.migrateFromSqlite({ source: GOOD, connectionString: d.ownerUrl, log: quiet })).result, 'MIGRATED');
    } finally { await d.drop(); } });
  await check('the runtime role cannot run the migration (it cannot disable integrity triggers)', async () => {
    const d = await fresh('role'); try { const r = await M.migrateFromSqlite({ source: GOOD, connectionString: d.appUrl, log: quiet });
      eq(r.result, 'FAILED_ROLLED_BACK'); eq(await rowCount(d, 'users'), 0); } finally { await d.drop(); } });
  await check('an unmigrated destination is refused', async () => {
    const d = await createTestDatabase('mig_bare', { migrated: false }); try { const r = await M.migrateFromSqlite({ source: GOOD, connectionString: d.ownerUrl, log: quiet });
      eq(r.result, 'FAILED_ROLLED_BACK'); ok(/not migrated/.test(r.error.message)); } finally { await d.drop(); } });
  await check('date and timestamp validators accept only real, canonical values', () => {
    eq(['2024-02-29', '2026-02-29', '2026-13-01', '2026-1-1', '0000-01-01', ''].map(M.validDate), [true, false, false, false, false, false]);
    eq(['2026-09-01 23:59:59', '2026-09-01 24:00:00', '2026-09-01T10:00:00Z', '2026-09-01'].map(M.validTimestamp), [true, false, false, false]); });

  await t.drop(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}\nDB-M1 DATA MIGRATION TESTS: ${passed} passed, ${failed} failed`);
  if (failed) for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  console.log('='.repeat(60)); process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED:', err); process.exit(1); });
