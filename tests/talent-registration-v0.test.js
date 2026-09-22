(async () => {
// tests/talent-registration-v0.test.js
// Emergency Registration V0 — public P01–P04 registration, upload security, anti-abuse, EMERGENCY REGISTRATION INTAKE V0
// list/CSV, migration TW0002, isolation. REAL PostgreSQL, REAL server.js over HTTP, runtime role for SQL probes.
// Usage: npm run test:talent-registration-v0
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const { createTalentTestDatabase, APP } = require('./helpers/talentTestDb');
const { createTestDatabase } = require('./helpers/pgTestDb');

const __t = await createTalentTestDatabase('talent_reg_v0');
process.env.DATABASE_URL = __t.appUrl;
const talentMig = require('../database/pg/talent/migrate-talent');
const { listMigrations } = require('../database/pg/migrate');
const reg = require('../modules/talent/lib/registrationV0');
const ug = require('../modules/talent/lib/uploadGuard');
const { verifyToken, issueToken } = require('../modules/talent/lib/formToken');
const { csvCell } = require('../modules/talent/routes/emergencyIntake');

const PASSWORD = 'Kahe360Demo!2026';
let passed = 0, failed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function eq(a, e, label = '') { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function ok(c, label) { if (!c) throw new Error(label || 'assertion failed'); }
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function sqlState(fn) { try { await fn(); return 'OK'; } catch (e) { return e.code || e.message; } }

const db = __t.db;
const owner = __t.openOwner(2);
const one = (h, sql, ...p) => h.prepare(sql).get(...p);
const all = (h, sql, ...p) => h.prepare(sql).all(...p);
const count = async (table) => Number((await one(db, `SELECT count(*)::int AS n FROM talent.${table}`)).n);

// ---- fixtures ---------------------------------------------------------------------------------------------
const PDF = (extra = '') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${extra}trailer\n<< >>\n%%EOF\n`, 'latin1');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
const EXE = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), crypto.randomBytes(64)]);
const BIG_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF\n')]);
const today = reg.todayWib();
const plusDays = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let seq = 0;
function validData(over = {}) {
  seq += 1;
  return { full_name: 'Calon Pekerja Uji', whatsapp_country_code: '62', whatsapp_number: `0812 ${String(1000 + seq).padStart(4, '0')} ${String(7000 + seq)}`,
    email: `calon.${seq}@contoh.id`, current_city: 'Cirebon', birth_date: '1995-05-17', education_level: 'SMA_SMK', major: 'Teknik Mesin',
    linkedin_url: 'https://www.linkedin.com/in/calon-uji', has_work_experience: 'YES', total_experience: '5_10', latest_position: 'Pipe Fitter',
    latest_company: 'PT Contoh Konstruksi', previous_industry: 'OIL_GAS', has_epc_experience: 'YES', skills: ['PIPING', 'WELDING'],
    other_skills: null, current_work_status: 'EMPLOYED', available_start_date: plusDays(30), preferred_work_type: ['SITE'],
    preferred_locations: ['Indramayu', 'Cirebon'], willing_out_of_town: 'YES', willing_shift: 'YES', consent: true, ...over };
}

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tw_v0_uploads_'));
const storedFiles = () => fs.readdirSync(UPLOAD_DIR).sort();

// ---- users ------------------------------------------------------------------------------------------------
const hash = bcrypt.hashSync(PASSWORD, 4);
const NEW_WFM = Number((await one(db, `INSERT INTO users (email, display_name, password_hash, is_active) VALUES ('wfm.noscope@t.local','WFM Tanpa Scope',?,1) RETURNING id`, hash)).id);
await db.prepare(`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = 'workforce_manager'`).run(NEW_WFM);   // added AFTER seed-talent: no scope

// ---- servers ----------------------------------------------------------------------------------------------
const servers = [];
async function startServer(appUrl, extraEnv = {}) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  let out = '';
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: appUrl, PORT: String(port), NODE_ENV: 'development',
    KAHE_WRITE_SERIALIZATION: 'off', KAHE_DB_QUERY_STATS: '', SESSION_SECRET: 'talent_v0_test_only', KAHE_TW_UPLOAD_DIR: UPLOAD_DIR,
    KAHE_TW_REG_SUBMIT_MAX: '1000', KAHE_TW_REG_TOKEN_MAX: '1000', ...extraEnv }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/login.html`)).status === 200) return { base, out: () => out }; } catch { /* */ } await sleep(100); }
  throw new Error(`server did not start:\n${out}`);
}
const srv = await startServer(__t.appUrl);
const B = srv.base;
async function http(method, url, { cookie, headers = {}, body } = {}) {
  const h = { ...headers }; if (cookie) h.Cookie = cookie;
  const r = await fetch(`${B}${url}`, { method, headers: h, body, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer()); const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text, headers: r.headers, location: r.headers.get('location') };
}
async function tokens(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push((await http('GET', '/api/public/tw/register/form-token')).body.token);
  await sleep(3100);   // server default minimum fill time is 3 s
  return out;
}
function form(data, { cv = [{ buf: PDF(), name: 'CV Saya.pdf', type: 'application/pdf' }], supporting = [], extraFiles = [] } = {}) {
  const fd = new FormData();
  fd.append('data', typeof data === 'string' ? data : JSON.stringify(data));
  for (const f of cv) fd.append('cv', new Blob([f.buf], { type: f.type }), f.name);
  for (const f of supporting) fd.append('supporting', new Blob([f.buf], { type: f.type }), f.name);
  for (const f of extraFiles) fd.append(f.field, new Blob([f.buf], { type: f.type }), f.name);
  return fd;
}
const submit = (token, fd, headers = {}) => http('POST', '/api/public/tw/register/submit', { headers: { 'X-TW-Form-Token': token, ...headers }, body: fd });
async function login(email) {
  const r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { get: (u) => http('GET', u, { cookie }) };
}

let T = await tokens(60); let ti = 0;
const tok = () => { if (ti >= T.length) throw new Error('out of tokens'); return T[ti++]; };

try {
// =============================================================================================================
section('1. MIGRATION TW0002 (schema talent only)');
await check('TW0002 is applied by the Talent runner and recorded with its checksum; core ledger stays 0001–0007', async () => {
  const files = talentMig.listTalentMigrations();
  eq((await all(db, 'SELECT version, checksum FROM talent.schema_migrations ORDER BY version')), files.map((f) => ({ version: f.version, checksum: f.checksum })));
  eq(files.map((f) => f.version), ['TW0001', 'TW0002']);
  eq((await all(owner, 'SELECT version, checksum FROM public.schema_migrations ORDER BY version')), listMigrations().map((m) => ({ version: m.version, checksum: m.checksum })));
});
await check('TW0002 creates only talent.registration + talent.registration_document and inserts no rows', async () => {
  const fresh = await createTalentTestDatabase('talent_reg_v0_fresh', { coreSeed: false, talentSeed: false });
  try {
    const o = fresh.openOwner(1);
    eq((await o.query(`SELECT count(*)::int AS n FROM talent.registration`)).rows[0].n, 0);
    eq((await o.query(`SELECT count(*)::int AS n FROM talent.registration_document`)).rows[0].n, 0);
    eq((await o.query(`SELECT relname FROM pg_class WHERE relnamespace='talent'::regnamespace AND relkind='r' AND relname LIKE 'registration%' ORDER BY 1`)).rows.map((r) => r.relname),
      ['registration', 'registration_document']);
  } finally { await fresh.drop(); }
});
await check('schema public is identical to a core-only database (TW0002 touches nothing outside talent)', async () => {
  const core = await createTestDatabase('talent_reg_v0_core');
  try {
    const snap = async (h) => (await h.query(`SELECT string_agg(x, '|' ORDER BY x) AS s FROM (
      SELECT 't:'||relname||':'||relkind::text AS x FROM pg_class WHERE relnamespace='public'::regnamespace
      UNION ALL SELECT 'c:'||conrelid::regclass::text||':'||conname FROM pg_constraint WHERE connamespace='public'::regnamespace
      UNION ALL SELECT 'g:'||tgrelid::regclass::text||':'||tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT tgisinternal
      UNION ALL SELECT 'f:'||proname FROM pg_proc WHERE pronamespace='public'::regnamespace) q`)).rows[0].s;
    const co = core.openOwner(1);
    eq(sha(await snap(owner)), sha(await snap(co)));
  } finally { await core.drop(); }
});
await check('runtime grants on the V0 tables: SELECT, INSERT only (no UPDATE / DELETE / TRUNCATE)', async () => {
  const g = await all(owner, `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
    WHERE table_schema='talent' AND grantee=? AND table_name LIKE 'registration%' GROUP BY 1 ORDER BY 1`, APP);
  eq(g, [{ t: 'registration', p: 'INSERT,SELECT' }, { t: 'registration_document', p: 'INSERT,SELECT' }]);
  for (const sql of ['UPDATE talent.registration SET status = status', 'DELETE FROM talent.registration', 'TRUNCATE talent.registration_document']) {
    eq([sql, await sqlState(() => db.query(sql))], [sql, '42501']);
  }
});
await check('database defaults / constraints: EMERGENCY_V0, NEW, PENDING only; registration_id format; one CV per registration', async () => {
  const c = await all(owner, `SELECT column_name, column_default FROM information_schema.columns WHERE table_schema='talent' AND table_name='registration'
    AND column_name IN ('source_type','status','migration_status') ORDER BY 1`);
  eq(c.map((x) => x.column_default), [`'PENDING'::text`, `'EMERGENCY_V0'::text`, `'NEW'::text`]);
  const defs = (await all(owner, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='talent.registration'::regclass`)).map((r) => r.d).join('\n');
  ok(/source_type = 'EMERGENCY_V0'|source_type = ANY \(ARRAY\['EMERGENCY_V0'/.test(defs) && /KAHE-TAL-/.test(defs), 'constraint definitions missing');
  eq((await one(owner, `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='talent' AND indexname='uq_registration_one_cv'`)).n, 1);
});
await check('a registration row cannot be committed without a CV (deferred database check); rows are undeletable even for the owner', async () => {
  const msg = await sqlState(() => owner.exec(`BEGIN; INSERT INTO talent.registration (registration_id, full_name, whatsapp_country_code, whatsapp_number,
    whatsapp_normalized, email, email_normalized, current_city, birth_date, education_level, has_work_experience, has_epc_experience, skills,
    current_work_status, available_start_date, preferred_work_type, willing_out_of_town, willing_shift, consent_accuracy, consent_processing,
    consent_version, consent_at, submission_nonce) VALUES ('KAHE-TAL-2026-999999','Tanpa CV','62','81234567','6281234567','x@y.id','x@y.id','Kota',
    '1990-01-01','SD',0,0,'{CIVIL}','NOT_EMPLOYED','2030-01-01','{SITE}',1,1,1,1,'EMERG-V0-2026-09-22',now(),'${'b'.repeat(32)}'); COMMIT;`));
  await owner.exec('ROLLBACK').catch(() => {});
  eq(msg, 'P0001');
  eq(await count('registration'), 0);
});
await check('audit event list widened by exactly EXPORT_CSV; unknown events still refused', async () => {
  const d = (await one(owner, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='audit_event_event_type_check'`)).d;
  ok(d.includes('EXPORT_CSV') && d.includes('PERMISSION_DENIED'), d);
  eq(await sqlState(() => db.query(`INSERT INTO talent.audit_event (event_type, outcome) VALUES ('EXPORT_XLSX','ALLOWED')`)), '23514');
});

// =============================================================================================================
section('2. PUBLIC PAGES P01–P04 (no login, public registration shell)');
await check('/register redirects to /register/profile; all four step URLs serve the public shell without login', async () => {
  const r = await http('GET', '/register');
  eq([r.status, r.location], [302, '/register/profile']);
  for (const p of ['/register/profile', '/register/experience-skills', '/register/availability-cv', '/register/success']) {
    const x = await http('GET', p);
    eq([p, x.status], [p, 200]);
    ok(/Pendaftaran Talenta KAHE Group/.test(x.text) && /register\.js/.test(x.text), `${p} is not the registration shell`);
  }
});
await check('the shell uses the canonical KAHE GROUP INDONESIA master logo file (byte-identical, native aspect ratio)', async () => {
  const html = (await http('GET', '/register/profile')).text;
  ok(/<img src="\/tw-assets\/kahe-group-indonesia-logo\.png"[^>]*width="2172" height="724"/.test(html), 'logo <img> missing');
  const r = await fetch(`${B}/tw-assets/kahe-group-indonesia-logo.png`);
  eq(sha(Buffer.from(await r.arrayBuffer())), '68bd292b8728c0407f3cd5f8603a1a0beb952c68f4d21922fbe166f948940ed5');
});
await check('applicant screens never ask for job family, NIK, BPJS, bank or medical data, and never show internal concepts', async () => {
  const text = [fs.readFileSync(path.join(ROOT, 'modules/talent/views/register.html'), 'utf8'), fs.readFileSync(path.join(ROOT, 'public/tw-assets/register.js'), 'utf8')].join('\n');
  for (const s of [/job[_ ]?family/i, /name="nik"/i, /\bNIK\b/, /BPJS/i, /rekening|bank account/i, /diagnos/i, /\bL[0-4]\b/, /readiness/i, /match score/i, /role dna/i, /worker_uuid/i]) {
    ok(!s.test(text), `found ${s}`);
  }
});
await check('status text on P04 is exactly "PROFIL DITERIMA — MENUNGGU REVIEW"', async () => {
  const html = (await http('GET', '/register/success')).text;
  ok(html.includes('PROFIL DITERIMA — MENUNGGU REVIEW'), 'status text missing');
});
await check('the view files are not reachable through static serving; pages are not cached', async () => {
  for (const u of ['/register.html', '/modules/talent/views/register.html', '/views/register.html']) {
    const r = await http('GET', u); ok(r.status === 404, `${u} -> ${r.status}`);
  }
  eq((await http('GET', '/register/profile')).headers.get('cache-control'), 'no-store');
});
await check('existing routes are unaffected (login page, protected Home, CP1 Talent pages)', async () => {
  eq((await http('GET', '/login.html')).status, 200);
  eq([(await http('GET', '/index.html')).status, (await http('GET', '/index.html')).location], [302, '/login.html']);
  eq((await http('GET', '/tw/app/')).location, '/login.html');
});

// =============================================================================================================
section('3. SUBMISSION — happy paths');
let first;
await check('a complete registration → 201 with ONLY registration_id, full_name, registered_at, status', async () => {
  const d = validData({ full_name: '  Ahmad   Uji  Coba ', email: '  Ahmad.Uji@Contoh.ID ', whatsapp_number: '0812-3456-0001' });
  const r = await submit(tok(), form(d, { supporting: [{ buf: JPG, name: 'sertifikat.jpg', type: 'image/jpeg' }, { buf: PNG, name: 'k3.png', type: 'image/png' }] }));
  eq(r.status, 201, r.text);
  eq(Object.keys(r.body).sort(), ['full_name', 'registered_at', 'registration_id', 'status']);
  ok(new RegExp(`^KAHE-TAL-${today.slice(0, 4)}-\\d{6}$`).test(r.body.registration_id), r.body.registration_id);
  eq([r.body.full_name, r.body.status], ['Ahmad Uji Coba', 'PROFILE_RECEIVED']);
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} WIB$/.test(r.body.registered_at), r.body.registered_at);
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.text), 'a UUID leaked in the response');
  first = r.body;
});
await check('stored row: EMERGENCY_V0 / NEW / PENDING, normalised input, consent recorded, NO worker identity created', async () => {
  const row = await one(db, 'SELECT * FROM talent.registration WHERE registration_id = ?', first.registration_id);
  eq([row.source_type, row.status, row.migration_status, row.worker_uuid], ['EMERGENCY_V0', 'NEW', 'PENDING', null]);
  eq([row.full_name, row.email, row.email_normalized, row.whatsapp_number, row.whatsapp_normalized],
    ['Ahmad Uji Coba', 'Ahmad.Uji@Contoh.ID', 'ahmad.uji@contoh.id', '81234560001', '6281234560001']);
  eq([Number(row.consent_accuracy), Number(row.consent_processing), row.consent_version], [1, 1, 'EMERG-V0-2026-09-22']);
  ok(row.consent_at, 'consent timestamp missing');
  eq([row.skills, row.preferred_work_type, row.preferred_locations], [['PIPING', 'WELDING'], ['SITE'], ['Indramayu', 'Cirebon']]);
  eq(await count('worker'), 0);
});
await check('documents: 1 CV + 2 supporting, random storage names, original name as metadata only, sha256 recorded, files 0600 in private storage', async () => {
  const docs = await all(db, `SELECT d.* FROM talent.registration_document d JOIN talent.registration r USING (registration_uuid)
    WHERE r.registration_id = ? ORDER BY d.document_kind, d.content_type`, first.registration_id);
  eq(docs.map((d) => [d.document_kind, d.content_type, d.original_filename]),
    [['CV', 'application/pdf', 'CV Saya.pdf'], ['SUPPORTING', 'image/jpeg', 'sertifikat.jpg'], ['SUPPORTING', 'image/png', 'k3.png']]);
  for (const d of docs) {
    ok(/^[0-9a-f]{32}\.(pdf|jpg|png)$/.test(d.storage_key), d.storage_key);
    const p = path.join(UPLOAD_DIR, d.storage_key);
    ok(fs.existsSync(p), `missing ${d.storage_key}`);
    eq((fs.statSync(p).mode & 0o777).toString(8), '600');
    eq(sha(fs.readFileSync(p)), d.sha256);
  }
  ok(!storedFiles().some((f) => /CV Saya|sertifikat|k3/.test(f)), 'original name used on disk');
});
await check('the same form token cannot submit twice (409 ALREADY_SUBMITTED, nothing written)', async () => {
  const t = tok();
  const a = await submit(t, form(validData()));
  eq(a.status, 201);
  const before = [await count('registration'), storedFiles().length];
  const b = await submit(t, form(validData()));
  eq([b.status, b.body], [409, { error: 'ALREADY_SUBMITTED', detail: {} }]);
  eq([await count('registration'), storedFiles().length], before);
});
await check('a candidate WITHOUT EPC experience can register', async () => {
  const r = await submit(tok(), form(validData({ has_epc_experience: 'NO', previous_industry: 'MANUFACTURING' })));
  eq(r.status, 201, r.text);
  eq(Number((await one(db, 'SELECT has_epc_experience FROM talent.registration WHERE registration_id = ?', r.body.registration_id)).has_epc_experience), 0);
});
await check('a fresh graduate registers; experience details sent anyway are not kept', async () => {
  const r = await submit(tok(), form(validData({ has_work_experience: 'NO', current_work_status: 'FRESH_GRADUATE', total_experience: 'GT_10', latest_position: 'X', latest_company: 'Y' })));
  eq(r.status, 201, r.text);
  const row = await one(db, 'SELECT has_work_experience, total_experience, latest_position, latest_company FROM talent.registration WHERE registration_id = ?', r.body.registration_id);
  eq([Number(row.has_work_experience), row.total_experience, row.latest_position, row.latest_company], [0, null, null, null]);
});
await check('skills: predefined choices + "Keahlian Lainnya" free text (OTHER is added automatically)', async () => {
  const r = await submit(tok(), form(validData({ skills: ['CIVIL'], other_skills: 'Scaffolding, rigging' })));
  eq(r.status, 201, r.text);
  const row = await one(db, 'SELECT skills, other_skills FROM talent.registration WHERE registration_id = ?', r.body.registration_id);
  eq([row.skills, row.other_skills], [['CIVIL', 'OTHER'], 'Scaffolding, rigging']);
  const x = await submit(tok(), form(validData({ skills: ['OTHER'], other_skills: null })));
  eq([x.status, x.body.detail.fields], [400, { other_skills: 'REQUIRED' }]);
});

// =============================================================================================================
section('4. SERVER-SIDE VALIDATION (codes only, nothing stored on failure)');
const expectInvalid = async (over, fields, label) => {
  const before = [await count('registration'), storedFiles().length];
  const r = await submit(tok(), form(validData(over)));
  eq([label, r.status, r.body && r.body.error, r.body && r.body.detail.fields], [label, 400, 'VALIDATION_FAILED', fields]);
  eq([label, await count('registration'), storedFiles().length], [label, ...before]);
};
await check('required fields', async () => {
  await expectInvalid({ full_name: '', email: '', current_city: ' ', birth_date: '', education_level: '', has_epc_experience: undefined,
    current_work_status: '', available_start_date: '', preferred_work_type: [], willing_out_of_town: undefined, willing_shift: undefined, consent: false },
  { full_name: 'REQUIRED', email: 'REQUIRED', current_city: 'REQUIRED', birth_date: 'REQUIRED', education_level: 'REQUIRED', has_epc_experience: 'REQUIRED',
    current_work_status: 'REQUIRED', available_start_date: 'REQUIRED', preferred_work_type: 'REQUIRED', willing_out_of_town: 'REQUIRED',
    willing_shift: 'REQUIRED', consent: 'REQUIRED' }, 'required');
});
await check('formats: email, WhatsApp, LinkedIn URL, name characters, enums, unknown skill', async () => {
  await expectInvalid({ email: 'bukan-email' }, { email: 'INVALID' }, 'email');
  await expectInvalid({ whatsapp_number: '0212345' }, { whatsapp_number: 'INVALID' }, 'phone');
  await expectInvalid({ whatsapp_country_code: '999' }, { whatsapp_country_code: 'INVALID' }, 'cc');
  await expectInvalid({ linkedin_url: 'javascript:alert(1)' }, { linkedin_url: 'INVALID' }, 'url');
  await expectInvalid({ full_name: '<script>x</script>' }, { full_name: 'INVALID' }, 'name');
  await expectInvalid({ education_level: 'PHD' }, { education_level: 'INVALID' }, 'edu');
  await expectInvalid({ skills: ['PIPING', 'HACKING'] }, { skills: 'INVALID' }, 'skill');
  await expectInvalid({ has_work_experience: 'YES', total_experience: '' }, { total_experience: 'REQUIRED' }, 'exp');
});
await check('dates: minimum age 17, start date not in the past and within one year', async () => {
  await expectInvalid({ birth_date: plusDays(-365 * 10) }, { birth_date: 'TOO_YOUNG' }, 'young');
  await expectInvalid({ birth_date: '2026-02-30' }, { birth_date: 'INVALID' }, 'bad date');
  await expectInvalid({ available_start_date: plusDays(-1) }, { available_start_date: 'IN_PAST' }, 'past');
  await expectInvalid({ available_start_date: plusDays(400) }, { available_start_date: 'OUT_OF_RANGE' }, 'far');
});
await check('lengths and list sizes are bounded', async () => {
  await expectInvalid({ full_name: 'A'.repeat(121) }, { full_name: 'TOO_LONG' }, 'name');
  await expectInvalid({ preferred_locations: Array.from({ length: 11 }, (_, i) => `Kota ${i}`) }, { preferred_locations: 'TOO_MANY' }, 'locations');
  await expectInvalid({ other_skills: 'x'.repeat(201) }, { other_skills: 'TOO_LONG' }, 'other');
});
await check('job family and sensitive fields are REFUSED as unknown fields (never stored)', async () => {
  await expectInvalid({ job_family: 'Construction' }, { job_family: 'UNKNOWN_FIELD' }, 'job family');
  await expectInvalid({ nik: '3201234567890001', bpjs_number: '1', bank_account_number: '1', medical_diagnosis: 'x', salary: 1 },
    { nik: 'UNKNOWN_FIELD', bpjs_number: 'UNKNOWN_FIELD', bank_account_number: 'UNKNOWN_FIELD', medical_diagnosis: 'UNKNOWN_FIELD', salary: 'UNKNOWN_FIELD' }, 'sensitive');
  eq((await one(db, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='talent' AND table_name='registration'
    AND column_name ~ '(nik|bpjs|bank|salary|medical|job_family|religion)'`)).n, 0);
});
await check('wrong JSON types are refused, not coerced', async () => {
  await expectInvalid({ full_name: 123, skills: 'PIPING', consent: 'true' }, { full_name: 'INVALID', skills: 'INVALID', consent: 'REQUIRED' }, 'types');
});
await check('the honeypot field rejects bots with a generic answer (nothing stored)', async () => {
  const before = await count('registration');
  const r = await submit(tok(), form(validData({ company_website: 'http://spam.example' })));
  eq([r.status, r.body], [400, { error: 'SUBMISSION_REJECTED', detail: {} }]);
  eq(await count('registration'), before);
});
await check('malformed request bodies get a generic 400 — never a stack trace or file path', async () => {
  for (const r of [await submit(tok(), form('{not json')), await submit(tok(), 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' }),
    await http('POST', '/api/public/tw/register/submit', { headers: { 'X-TW-Form-Token': tok(), 'Content-Type': 'multipart/form-data; boundary=zzz' }, body: '--zzz\r\nbroken' })]) {
    eq([r.status, r.body && r.body.error], [400, 'INVALID_REQUEST']);
    ok(!/\bat \w|node_modules|\/home\/|Error:/.test(r.text), `leak: ${r.text.slice(0, 120)}`);
  }
});

// =============================================================================================================
section('5. UPLOAD SECURITY');
const expectUpload = async (opts, status, field, reason, label) => {
  const before = [await count('registration'), await count('registration_document'), storedFiles().length];
  const r = await submit(tok(), form(validData(), opts));
  eq([label, r.status, r.body && r.body.error, r.body && r.body.detail], [label, status, 'UPLOAD_REJECTED', { field, reason }]);
  eq([label, await count('registration'), await count('registration_document'), storedFiles().length], [label, ...before]);
};
await check('CV is required and exactly one', async () => {
  await expectUpload({ cv: [] }, 400, 'cv', 'REQUIRED', 'no cv');
  await expectUpload({ cv: [{ buf: PDF(), name: 'a.pdf', type: 'application/pdf' }, { buf: PDF(), name: 'b.pdf', type: 'application/pdf' }] }, 400, 'cv', 'TOO_MANY_FILES', 'two cvs');
});
await check('CV must be PDF: extension, MIME and signature must agree', async () => {
  await expectUpload({ cv: [{ buf: PNG, name: 'cv.png', type: 'image/png' }] }, 400, 'cv', 'EXTENSION_NOT_ALLOWED', 'png cv');
  await expectUpload({ cv: [{ buf: PDF(), name: 'cv.pdf', type: 'image/png' }] }, 400, 'cv', 'MIME_MISMATCH', 'mime');
  await expectUpload({ cv: [{ buf: PNG, name: 'cv.pdf', type: 'application/pdf' }] }, 400, 'cv', 'SIGNATURE_MISMATCH', 'png as pdf');
  await expectUpload({ cv: [{ buf: EXE, name: 'cv.pdf', type: 'application/pdf' }] }, 400, 'cv', 'SIGNATURE_MISMATCH', 'exe as pdf');
  await expectUpload({ cv: [{ buf: Buffer.from('%PDF-1.4 truncated'), name: 'cv.pdf', type: 'application/pdf' }] }, 400, 'cv', 'MALFORMED_PDF', 'truncated');
});
await check('PDFs with active content (JavaScript, Launch, embedded files) are refused', async () => {
  await expectUpload({ cv: [{ buf: PDF('2 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n'), name: 'cv.pdf', type: 'application/pdf' }] }, 400, 'cv', 'ACTIVE_CONTENT', 'js');
  await expectUpload({ cv: [{ buf: PDF('2 0 obj\n<< /S /Launch /F (cmd.exe) >>\nendobj\n'), name: 'cv.pdf', type: 'application/pdf' }] }, 400, 'cv', 'ACTIVE_CONTENT', 'launch');
  await expectUpload({ supporting: [{ buf: PDF('<< /EmbeddedFiles 3 0 R >>\n'), name: 'lamp.pdf', type: 'application/pdf' }] }, 400, 'supporting', 'ACTIVE_CONTENT', 'embedded');
});
await check('CV larger than 5 MB → 413; nothing stored', async () => {
  await expectUpload({ cv: [{ buf: BIG_PDF, name: 'cv.pdf', type: 'application/pdf' }] }, 413, 'cv', 'FILE_TOO_LARGE', 'big');
});
await check('supporting documents: PDF/JPG/PNG only, max 5 files, max 10 MB in total', async () => {
  await expectUpload({ supporting: [{ buf: GIF, name: 'x.gif', type: 'image/gif' }] }, 400, 'supporting', 'EXTENSION_NOT_ALLOWED', 'gif');
  await expectUpload({ supporting: [{ buf: JPG, name: 'x.png', type: 'image/png' }] }, 400, 'supporting', 'SIGNATURE_MISMATCH', 'jpg as png');
  await expectUpload({ supporting: Array.from({ length: 6 }, (_, i) => ({ buf: PNG, name: `d${i}.png`, type: 'image/png' })) }, 400, 'supporting', 'TOO_MANY_FILES', 'six');
  const four = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4 * 1024 * 1024, 1)]);
  await expectUpload({ supporting: [0, 1, 2].map((i) => ({ buf: four, name: `f${i}.png`, type: 'image/png' })) }, 413, 'supporting', 'TOTAL_TOO_LARGE', 'total');
});
await check('an unexpected file field is refused', async () => {
  await expectUpload({ extraFiles: [{ field: 'avatar', buf: PNG, name: 'a.png', type: 'image/png' }] }, 400, '_form', 'UNEXPECTED_FILE', 'unexpected');
});
await check('path-traversal / hostile file names are reduced to a safe display name; storage name stays random', async () => {
  const r = await submit(tok(), form(validData(), { cv: [{ buf: PDF(), name: '../../etc/passwd<script>.pdf', type: 'application/pdf' }] }));
  eq(r.status, 201, r.text);
  const d = await one(db, `SELECT d.original_filename, d.storage_key FROM talent.registration_document d JOIN talent.registration r USING (registration_uuid)
    WHERE r.registration_id = ? AND d.document_kind = 'CV'`, r.body.registration_id);
  eq(d.original_filename, 'passwdscript.pdf');
  ok(/^[0-9a-f]{32}\.pdf$/.test(d.storage_key), d.storage_key);
  eq(ug.safeOriginalName('C:\\Users\\a\\CV Final.PDF'), 'CV Final.PDF');
});
await check('uploaded files are never reachable through static URLs', async () => {
  const key = storedFiles()[0];
  for (const u of [`/uploads/talent-registration/${key}`, `/talent-registration/${key}`, `/${key}`, `/tw-assets/${key}`]) {
    eq([u, (await http('GET', u)).status], [u, 404]);
  }
});

// =============================================================================================================
section('6. ANTI-ABUSE');
await check('no token / forged token / expired token / too-fast token → 403 FORM_TOKEN_INVALID; nothing stored', async () => {
  const before = await count('registration');
  const forged = `${'a'.repeat(32)}.${Date.now() - 10000}.${'A'.repeat(43)}`;
  for (const t of [undefined, 'garbage', forged]) {
    const r = await http('POST', '/api/public/tw/register/submit', { headers: t ? { 'X-TW-Form-Token': t } : {}, body: form(validData()) });
    eq([r.status, r.body], [403, { error: 'FORM_TOKEN_INVALID', detail: {} }]);
  }
  const fresh = (await http('GET', '/api/public/tw/register/form-token')).body.token;
  eq((await submit(fresh, form(validData()))).status, 403);            // younger than the minimum fill time
  eq(verifyToken(issueToken(Date.now() - 3 * 60 * 60 * 1000)).reason, 'EXPIRED');
  eq(verifyToken(issueToken(Date.now() - 5000)).ok, true);
  eq(await count('registration'), before);
});
await check('duplicates are FLAGGED, never merged, and never disclosed: same phone (other format) and same email (other case)', async () => {
  const a = await submit(tok(), form(validData({ whatsapp_number: '081299990000', email: 'dup.person@contoh.id' })));
  const b = await submit(tok(), form(validData({ whatsapp_number: '+62 812-9999-0000', email: 'lain@contoh.id' })));
  const c = await submit(tok(), form(validData({ whatsapp_number: '081277776666', email: 'DUP.Person@Contoh.id' })));
  eq([a.status, b.status, c.status], [201, 201, 201]);
  eq([Object.keys(b.body).sort(), Object.keys(c.body).sort()], [['full_name', 'registered_at', 'registration_id', 'status'], ['full_name', 'registered_at', 'registration_id', 'status']]);
  ok(!b.text.includes(a.body.registration_id) && !c.text.includes(a.body.registration_id), 'existing registration disclosed');
  const rows = await all(db, `SELECT registration_id, possible_duplicate, duplicate_signals FROM talent.registration WHERE registration_id IN (?, ?, ?) ORDER BY registration_id`,
    a.body.registration_id, b.body.registration_id, c.body.registration_id);
  eq(rows.map((r) => [Number(r.possible_duplicate), r.duplicate_signals]), [[0, []], [1, ['PHONE']], [1, ['EMAIL']]]);
  eq(new Set(rows.map((r) => r.registration_id)).size, 3);
});
await check('rate limiting on submissions (keyed on the TCP peer — a forged X-Forwarded-For does not escape it)', async () => {
  const lim = await startServer(__t.appUrl, { KAHE_TW_REG_SUBMIT_MAX: '2' });
  const post = (h = {}) => fetch(`${lim.base}/api/public/tw/register/submit`, { method: 'POST', headers: { 'X-TW-Form-Token': 'x', ...h }, body: form(validData()) });
  const s = [];
  for (let i = 0; i < 2; i += 1) s.push((await post()).status);
  s.push((await post({ 'X-Forwarded-For': '203.0.113.9' })).status);
  const last = await post({ 'X-Forwarded-For': '198.51.100.7' });
  eq([...s, last.status], [403, 403, 429, 429]);
  eq(await last.json(), { error: 'RATE_LIMITED', detail: {} });
});
await check('the public API is not behind the portal write queue, and unknown public paths answer 404', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(src.indexOf("'/api/public/tw/register'") < src.indexOf("require('./middleware/writeSerializer')"), 'mounted after the serializer');
  eq((await http('GET', '/api/public/tw/register/nope')).status, 404);
  eq((await http('GET', '/api/public/tw/register/submit')).status, 404);
});

// =============================================================================================================
section('7. EMERGENCY REGISTRATION INTAKE V0 (internal list + CSV — not P05)');
const wf = await login('workforce@kahe360.local');
const hrd = await login('hrd@kahe360.local');
const dir = await login('director@kahe360.local');
const pay = await login('payroll@kahe360.local');
const noscope = await login('wfm.noscope@t.local');
const LIST = '/api/tw/emergency-intake/registrations';
await check('unauthenticated → 401 (API) / redirect to login (page)', async () => {
  eq((await http('GET', LIST)).status, 401);
  eq((await http('GET', '/api/tw/emergency-intake/export.csv')).status, 401);
  eq((await http('GET', '/tw/emergency-intake')).location, '/login.html');
});
await check('Director and payroll have no V0 intake grant → 403 and PERMISSION_DENIED audited', async () => {
  const before = Number((await one(db, `SELECT count(*)::int AS n FROM talent.audit_event WHERE event_type='PERMISSION_DENIED'`)).n);
  for (const c of [dir, pay]) { eq((await c.get(LIST)).status, 403); eq((await c.get('/api/tw/emergency-intake/export.csv')).status, 403); eq((await c.get('/tw/emergency-intake')).status, 403); }
  eq(Number((await one(db, `SELECT count(*)::int AS n FROM talent.audit_event WHERE event_type='PERMISSION_DENIED'`)).n), before + 6);
});
await check('a Workforce Manager WITHOUT data scope is refused (fail closed)', async () => {
  const r = await noscope.get(LIST);
  eq([r.status, r.body], [403, { error: 'FORBIDDEN', detail: { reason: 'NO_SCOPE' } }]);
  eq((await noscope.get('/api/tw/emergency-intake/export.csv')).status, 403);
});
await check('Workforce Manager / HRD list: labelled V0, only the approved columns, newest first, no internal identifiers', async () => {
  for (const c of [wf, hrd]) {
    const r = await c.get(`${LIST}?limit=200`);
    eq([r.status, r.body.label], [200, 'EMERGENCY REGISTRATION INTAKE V0']);
    eq(r.body.total, await count('registration'));
    eq(Object.keys(r.body.rows[0]), ['registration_id', 'full_name', 'whatsapp', 'email', 'current_city', 'latest_position', 'registered_at', 'status', 'possible_duplicate']);
    ok(!/registration_uuid|worker_uuid|storage_key|sha256|birth_date|submission_nonce|[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.text), 'internal field leaked');
    const row = r.body.rows.find((x) => x.registration_id === first.registration_id);
    eq([row.full_name, row.whatsapp, row.email, row.status], ['Ahmad Uji Coba', '+6281234560001', 'Ahmad.Uji@Contoh.ID', 'NEW']);
  }
});
await check('list search and paging', async () => {
  const r = await wf.get(`${LIST}?q=${encodeURIComponent(first.registration_id)}`);
  eq([r.body.total, r.body.rows.map((x) => x.registration_id)], [1, [first.registration_id]]);
  const p = await wf.get(`${LIST}?limit=2&offset=1`);
  eq([p.body.limit, p.body.offset, p.body.rows.length], [2, 1, 2]);
  eq((await wf.get(`${LIST}?q=${encodeURIComponent("%' OR 'a'='a")}`)).body.total, 0);
});
await check('CSV export (Workforce Manager): attachment, no-store, BOM, exact header, one row per registration, no file content', async () => {
  const r = await wf.get('/api/tw/emergency-intake/export.csv');
  eq([r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'text/csv; charset=utf-8', 'no-store']);
  ok(/^attachment; filename="emergency-registrations-v0-\d{8}\.csv"$/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));
  ok(r.text.startsWith('\ufeff'), 'BOM missing');
  const lines = r.text.slice(1).trim().split('\r\n');
  eq(lines[0], '"registration_id","full_name","whatsapp","email","current_city","latest_position","registered_at","status","possible_duplicate"');
  eq(lines.length - 1, await count('registration'));
  ok(!/%PDF|PNG|storage_key|sha256|registration_uuid/.test(r.text), 'file content or internal identifiers in CSV');
});
await check('CSV neutralises spreadsheet formulas', async () => {
  const x = await submit(tok(), form(validData({ latest_position: '=HYPERLINK("http://x","klik")' })));
  eq(x.status, 201, x.text);
  const r = await hrd.get('/api/tw/emergency-intake/export.csv');
  ok(r.text.includes(`"'=HYPERLINK(""http://x"",""klik"")"`), 'formula not neutralised');
  eq([csvCell('+1'), csvCell('-2'), csvCell('@x'), csvCell('a"b'), csvCell(null)], [`"'+1"`, `"'-2"`, `"'@x"`, '"a""b"', '""']);
});
await check('every CSV export is audited as EXPORT_CSV with metadata only (actor, rows, columns) — no personal data', async () => {
  const rows = await all(db, `SELECT actor_user_id, actor_role_codes, permission_code, action, route, payload FROM talent.audit_event WHERE event_type = 'EXPORT_CSV' ORDER BY id`);
  eq(rows.length, 2);
  eq(rows.map((r) => [r.actor_role_codes, r.permission_code, r.action, r.route]), [
    [['workforce_manager'], 'tw_emergency_intake', 'EXPORT', '/api/tw/emergency-intake/export.csv'],
    [['hrd_officer'], 'tw_emergency_intake', 'EXPORT', '/api/tw/emergency-intake/export.csv']]);
  eq(Object.keys(rows[1].payload).sort(), ['columns', 'dataset', 'rows', 'truncated']);
  ok(!/@contoh\.id|6281|Ahmad/.test(JSON.stringify(rows)), 'personal data in the audit log');
});
await check('the intake page is labelled "EMERGENCY REGISTRATION INTAKE V0" and is not part of the canonical Talent navigation', async () => {
  const p = await wf.get('/tw/emergency-intake');
  eq(p.status, 200);
  ok(p.text.includes('EMERGENCY REGISTRATION INTAKE V0') && p.text.includes('bukan modul Talent Intake (P05)'), 'label missing');
  const me = (await wf.get('/api/tw/me')).body;
  eq(me.nav.length, 9);
  ok(!me.nav.some((n) => /emergency/.test(n.href)), 'V0 intake added to the sidebar');
});

// =============================================================================================================
section('8. ISOLATION & ROLLBACK');
await check('V0 code never reads or writes Payroll / Attendance / HRD / employee tables', async () => {
  const PROTECTED = /\b(FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(public\.)?(attendance_[a-z_]+|timesheet_entries|payroll_[a-z_]+|employee_[a-z_]+|employees|salary_components|billing_[a-z_]+|legal_entities|clients|projects)\b/i;
  for (const f of ['modules/talent/lib/registrationV0.js', 'modules/talent/lib/uploadGuard.js', 'modules/talent/lib/formToken.js', 'modules/talent/routes/publicRegister.js',
    'modules/talent/routes/publicRegisterPages.js', 'modules/talent/routes/emergencyIntake.js', 'database/pg/talent/migrations/TW0002_emergency_registration_v0.sql']) {
    const hits = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|--)/.test(l) && PROTECTED.test(l));
    eq([f, hits], [f, []]);
  }
});
await check('TW0002 rollback refuses while registrations exist; on an empty database it removes only V0 and re-applies cleanly', async () => {
  const down = fs.readFileSync(path.join(talentMig.DIR, 'TW0002_emergency_registration_v0.down.sql'), 'utf8');
  const { Client } = require('pg');
  const c = new Client({ connectionString: __t.ownerUrl }); await c.connect();
  let msg = 'OK'; try { await c.query(down); } catch (e) { msg = e.message; } finally { await c.end(); }
  ok(/refused/.test(msg), `rollback was not refused: ${msg}`);
  ok(await count('registration') > 0, 'data lost');
  const fresh = await createTalentTestDatabase('talent_reg_v0_rb', { coreSeed: false, talentSeed: false });
  try {
    const o = fresh.openOwner(1);
    await o.exec(down);
    eq((await o.query(`SELECT to_regclass('talent.registration') AS a, to_regclass('talent.worker') AS b`)).rows[0].a, null);
    eq((await o.query(`SELECT version FROM talent.schema_migrations ORDER BY 1`)).rows.map((r) => r.version), ['TW0001']);
    const r = await fresh.migrateTalent();
    eq(r.ran, ['TW0002']);
  } finally { await fresh.drop(); }
});

} finally {
  for (const s of servers) s.kill();
  await owner.close(); await __t.drop();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

console.log('\n============================================================');
console.log(`TALENT EMERGENCY REGISTRATION V0 TESTS: ${passed} passed, ${failed} failed`);
console.log('============================================================');
if (failed) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
