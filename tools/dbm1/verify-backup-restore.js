// tools/dbm1/verify-backup-restore.js — DB-M1 CP6. pg_dump → FRESH database → pg_restore → prove the restore is complete.
//   SOURCE_URL=<owner url of the database to back up>  RESTORE_ADMIN_URL=<role that may CREATE DATABASE>  [RUNTIME_ROLE=kahe360_app RUNTIME_PASSWORD=…]
//   node tools/dbm1/verify-backup-restore.js <new_database_name> [--keep] [--report out.json]
// Compares, source vs restored: tables · columns (type, nullability, default, identity) · primary keys · foreign keys · CHECKs · every index
// definition · every trigger (table, definition, ENABLED) · functions · sequence positions · table privileges of the runtime role · migration
// ledgers · per-table row counts and a chunked sha256 of EVERY column of EVERY row. Then, as the RUNTIME role on the restored database:
// audit immutability, version-history protection, no DDL/TRUNCATE, and that a new record gets an id above every restored id.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const { execFileSync } = require('child_process'); const { Client } = require('pg');
const NAME = process.argv[2]; const KEEP = process.argv.includes('--keep'); const REPORT = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
if (!/^[a-z_][a-z0-9_]*$/.test(NAME || '')) { console.error('usage: verify-backup-restore.js <new_database_name> [--keep] [--report out.json]'); process.exit(2); }
const SRC = process.env.SOURCE_URL; const ADMIN = process.env.RESTORE_ADMIN_URL; const CHUNK = 20000;
const pgEnv = (url) => { const u = new URL(url); return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }; };
const withDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const STRUCTURE = {
  columns: `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '-') || ' ' || is_identity AS x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`,
  constraints: `SELECT c.relname || ' ' || con.contype::text || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) || ' validated=' || con.convalidated AS x FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid WHERE con.connamespace = 'public'::regnamespace ORDER BY 1`,
  indexes: `SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  triggers: `SELECT c.relname || ' ' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) AS x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1`,
  functions: `SELECT p.proname || ' ' || md5(pg_get_functiondef(p.oid)) AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
  sequences: `SELECT sequencename || ' last=' || COALESCE(last_value::text, 'never-called') AS x FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
  runtime_privileges: `SELECT table_name || ' ' || string_agg(privilege_type, ',' ORDER BY privilege_type) AS x FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = '${process.env.RUNTIME_ROLE || 'kahe360_app'}' GROUP BY table_name ORDER BY 1`,
  database: `SELECT 'encoding=' || pg_encoding_to_char(encoding) || ' collate=' || datcollate || ' ctype=' || datctype AS x FROM pg_database WHERE datname = current_database()`,
};
async function tableHashes(pg) {
  const out = {}; const tabs = (await pg.query(`SELECT c.relname AS t, (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM pg_constraint con, unnest(con.conkey) WITH ORDINALITY k(n, ord), pg_attribute a
    WHERE con.conrelid = c.oid AND con.contype = 'p' AND a.attrelid = c.oid AND a.attnum = k.n) AS pk FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`)).rows;
  for (const { t, pk } of tabs) { const h = crypto.createHash('sha256'); let n = 0;
    if (pk && pk.length === 1) { let last = null; const k = `"${pk[0]}"`;
      for (;;) { const r = (await pg.query({ text: last === null ? `SELECT ${k}, * FROM ${t} ORDER BY ${k} LIMIT ${CHUNK}` : `SELECT ${k}, * FROM ${t} WHERE ${k} > $1 ORDER BY ${k} LIMIT ${CHUNK}`, values: last === null ? [] : [last], rowMode: 'array' })).rows;
        for (const row of r) h.update(JSON.stringify(row)); n += r.length; if (r.length < CHUNK) break; last = r[r.length - 1][0]; } }
    else { const r = (await pg.query({ text: `SELECT * FROM ${t} ORDER BY ${pk && pk.length ? pk.map((c) => `"${c}"`).join(',') : '1,2'}`, rowMode: 'array' })).rows; for (const row of r) h.update(JSON.stringify(row)); n = r.length; }
    out[t] = { rows: n, sha256: h.digest('hex') }; }
  return out;
}
(async () => {
  const report = { restored_database: NAME, started_at: new Date().toISOString() }; const dump = path.join(os.tmpdir(), `kahe360-${NAME}-${process.pid}.dump`);
  let t0 = Date.now(); execFileSync('pg_dump', ['--format=custom', '--file', dump], { env: pgEnv(SRC), stdio: ['ignore', 'ignore', 'pipe'] });
  report.backup = { tool: execFileSync('pg_dump', ['--version']).toString().trim(), format: 'custom (-Fc)', seconds: (Date.now() - t0) / 1000, size_mb: Math.round(fs.statSync(dump).size / 104857.6) / 10, sha256: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex'),
    toc_entries: execFileSync('pg_restore', ['--list', dump]).toString().split('\n').filter((l) => /^\d+;/.test(l)).length };
  const admin = new Client({ connectionString: ADMIN }); await admin.connect(); const owner = decodeURIComponent(new URL(SRC).username);
  await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${NAME} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  await admin.query(`REVOKE ALL ON DATABASE ${NAME} FROM PUBLIC`); await admin.query(`GRANT CONNECT ON DATABASE ${NAME} TO ${process.env.RUNTIME_ROLE || 'kahe360_app'}`);
  t0 = Date.now(); let stderr = ''; try { execFileSync('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname', NAME, dump], { env: pgEnv(withDb(SRC, NAME)), stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { stderr = String(e.stderr || e.message); }
  report.restore = { seconds: (Date.now() - t0) / 1000, mode: '--single-transaction --exit-on-error, as the schema-owner role (no superuser)', errors: stderr.trim() || null };
  const a = new Client({ connectionString: SRC, options: '-c timezone=UTC' }); const b = new Client({ connectionString: withDb(SRC, NAME), options: '-c timezone=UTC' }); await a.connect(); await b.connect();
  report.structure = {}; let structOk = !stderr;
  for (const [k, sql] of Object.entries(STRUCTURE)) { const x = (await a.query(sql)).rows.map((r) => r.x); const y = (await b.query(sql)).rows.map((r) => r.x); const same = JSON.stringify(x) === JSON.stringify(y);
    report.structure[k] = { source: x.length, restored: y.length, identical: same, ...(same ? {} : { first_difference: x.find((v, i) => v !== y[i]) || y.find((v, i) => v !== x[i]) }) }; if (!same) structOk = false; }
  t0 = Date.now(); const ha = await tableHashes(a); const hb = await tableHashes(b); const diffs = Object.keys({ ...ha, ...hb }).filter((t) => !ha[t] || !hb[t] || ha[t].rows !== hb[t].rows || ha[t].sha256 !== hb[t].sha256);
  report.data = { tables: Object.keys(ha).length, source_rows: Object.values(ha).reduce((n, t) => n + t.rows, 0), restored_rows: Object.values(hb).reduce((n, t) => n + t.rows, 0), tables_with_difference: diffs, seconds: (Date.now() - t0) / 1000 };
  const orph = (await b.query(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated`)).rows[0].n;
  report.integrity = { unvalidated_constraints: orph, disabled_triggers: (await b.query(`SELECT COUNT(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgenabled <> 'O'`)).rows[0].n,
    migrations: (await b.query('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version).join(',') };
  // ---- runtime-role protections on the RESTORED database ----
  const rt = {}; if (process.env.RUNTIME_PASSWORD) { const u = new URL(withDb(SRC, NAME)); u.username = process.env.RUNTIME_ROLE || 'kahe360_app'; u.password = process.env.RUNTIME_PASSWORD; const c = new Client({ connectionString: u.toString() }); await c.connect();
    const refused = async (sql, re) => { try { await c.query(sql); return false; } catch (e) { return re.test(`${e.code} ${e.message}`); } };
    const ev = (await c.query('SELECT MIN(id) AS id FROM attendance_events')).rows[0].id; const ver = (await c.query('SELECT MIN(id) AS id FROM attendance_entry_versions')).rows[0].id;
    if (ev) { rt.audit_update_blocked = await refused(`UPDATE attendance_events SET event_type = 'X' WHERE id = ${ev}`, /ATTENDANCE_EVENT_IMMUTABLE/); rt.audit_delete_blocked = await refused(`DELETE FROM attendance_events WHERE id = ${ev}`, /ATTENDANCE_EVENT_IMMUTABLE/); }
    if (ver) rt.version_history_blocked = await refused(`UPDATE attendance_entry_versions SET payload = '{}' WHERE id = ${ver}`, /AUDIT_APPEND_ONLY/);
    const fin = (await c.query(`SELECT l.id FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.payroll_run_id WHERE r.status = 'FINALIZED' LIMIT 1`)).rows[0]; if (fin) rt.finalized_payroll_blocked = await refused(`UPDATE payroll_run_lines SET net_sen = net_sen + 1 WHERE id = ${fin.id}`, /PAYROLL_FINALIZED/);
    rt.truncate_denied = await refused('TRUNCATE attendance_events', /42501/); rt.ddl_denied = await refused('ALTER TABLE attendance_events DISABLE TRIGGER ALL', /42501/); rt.drop_denied = await refused('DROP TABLE users', /42501/); rt.ledger_write_denied = await refused('DELETE FROM schema_migrations', /42501/);
    await c.query('BEGIN'); const before = Number((await c.query('SELECT COALESCE(MAX(id), 0) AS m FROM attendance_events')).rows[0].m);
    const id = Number((await c.query(`INSERT INTO attendance_events (employee_id, work_date, event_type) VALUES ('RESTORE-PROBE', '2026-01-01', 'PROBE') RETURNING id`)).rows[0].id); await c.query('ROLLBACK');
    rt.new_id_above_restored_history = id > before; rt.probe = `max ${before} → new ${id} (rolled back)`; await c.end(); }
  report.runtime_role_on_restored = rt; const rtOk = Object.entries(rt).every(([k, v]) => k === 'probe' || v === true);
  report.ok = structOk && diffs.length === 0 && report.data.source_rows === report.data.restored_rows && !orph && report.integrity.disabled_triggers === 0 && rtOk;
  await a.end(); await b.end(); if (!KEEP) await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`); await admin.end(); fs.unlinkSync(dump);
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ok: report.ok, backup: report.backup, restore: report.restore, structure: Object.fromEntries(Object.entries(report.structure).map(([k, v]) => [k, `${v.source}=${v.restored}${v.identical ? '' : ' DIFF'}`])), data: report.data, integrity: report.integrity, runtime: rt }, null, 0));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
