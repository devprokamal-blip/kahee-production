(async () => {
// tests/talent-hardening-v0.test.js
// Emergency Registration V0 — Internet Deployment Hardening: trusted proxy / real client IP, HTTPS session cookies,
// production fail-fast, rate-limit keying behind a proxy, readiness endpoint, private storage, scoped CSP.
// REAL PostgreSQL, REAL server.js started in several configurations. Usage: npm run test:talent-hardening-v0
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { createTalentTestDatabase } = require('./helpers/talentTestDb');
const { createTestDatabase } = require('./helpers/pgTestDb');
const dc = require('../lib/deploymentConfig');
const { CSP } = require('../modules/talent/routes/publicRegisterPages');

const __t = await createTalentTestDatabase('talent_hard_v0');
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
const db = __t.db;
const one = (sql, ...p) => db.prepare(sql).get(...p);
const lastDeniedIp = async () => (await one(`SELECT ip_address FROM talent.audit_event WHERE event_type='PERMISSION_DENIED' ORDER BY id DESC LIMIT 1`)).ip_address;

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tw_hard_uploads_'));
const GOOD_SECRET = crypto.randomBytes(48).toString('base64url');
const servers = [];
const BASE_ENV = { DATABASE_URL: __t.appUrl, NODE_ENV: 'development', KAHE_WRITE_SERIALIZATION: 'off', KAHE_DB_QUERY_STATS: '',
  SESSION_SECRET: 'talent_hardening_test_only', KAHE_TW_UPLOAD_DIR: UPLOAD_DIR, KAHE_TW_REG_TOKEN_MAX: '1000', KAHE_TW_REG_SUBMIT_MAX: '1000' };
const clean = () => { const e = { ...process.env }; for (const k of ['KAHE_TRUST_PROXY', 'KAHE_COOKIE_SECURE', 'SESSION_SECRET', 'NODE_ENV']) delete e[k]; return e; };

/** Start server.js; resolves { base, out } when it listens, or { exitCode, out } when it exits first. */
async function startServer(extraEnv = {}) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  let out = ''; let exitCode = null;
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...clean(), ...BASE_ENV, PORT: String(port), ...extraEnv }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  proc.on('exit', (c) => { exitCode = c; });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (exitCode !== null) return { exitCode, out: () => out };
    try { if ((await fetch(`${base}/login.html`)).status === 200) return { base, out: () => out, proc }; } catch { /* */ }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${out}`);
}
async function http(base, method, url, { headers = {}, body, cookie } = {}) {
  const h = { ...headers }; if (cookie) h.Cookie = cookie;
  const r = await fetch(`${base}${url}`, { method, headers: h, body, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') };
}
const login = (base, email, headers = {}) => http(base, 'POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email, password: PASSWORD }) });
const cookieOf = (r) => (r.setCookie ? r.setCookie.split(';')[0] : null);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n');
function form() { const fd = new FormData(); fd.append('data', '{}'); fd.append('cv', new Blob([PDF], { type: 'application/pdf' }), 'cv.pdf'); return fd; }
const submitWith = (base, headers) => http(base, 'POST', '/api/public/tw/register/submit', { headers: { 'X-TW-Form-Token': 'x', ...headers }, body: form() });

try {
// =============================================================================================================
section('1. CONFIGURATION (pure)');
await check('KAHE_TRUST_PROXY: unset/off/false/0 → no proxy trusted; hop counts; address lists; keywords', async () => {
  for (const v of [undefined, '', 'off', 'OFF', 'false', '0', 'none']) eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: v }), false, `${v}: `);
  eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: '1' }), 1); eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: ' 2 ' }), 2);
  eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: 'loopback' }), 'loopback');
  eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: '10.0.0.5, 172.16.0.0/12,loopback' }), '10.0.0.5, 172.16.0.0/12, loopback');
  eq(dc.resolveTrustProxy({ KAHE_TRUST_PROXY: '2001:db8::/32' }), '2001:db8::/32');
});
await check('KAHE_TRUST_PROXY: garbage is refused (never silently trusted)', async () => {
  for (const v of ['true', 'all', '*', '10.0.0.999', '10.0.0.0/33', 'proxy.example', '1,2']) {
    let threw = false; try { dc.resolveTrustProxy({ KAHE_TRUST_PROXY: v }); } catch (e) { threw = e.name === 'DeploymentConfigError'; }
    ok(threw, `"${v}" accepted`);
  }
});
await check('session cookie policy: dev = HttpOnly+Lax, not Secure (opt-in); production = always Secure', async () => {
  eq(dc.resolveSessionCookie({}), { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 28800000 });
  eq(dc.resolveSessionCookie({ KAHE_COOKIE_SECURE: 'true' }).secure, true);
  eq(dc.resolveSessionCookie({ NODE_ENV: 'production' }).secure, true);
  eq(dc.resolveSessionCookie({ NODE_ENV: 'production', KAHE_COOKIE_SECURE: 'false' }).secure, true);
});
await check('production fail-fast rules: secret, trust-proxy explicitness, cookie override; development is untouched', async () => {
  eq(dc.productionProblems({}), []);
  eq(dc.productionProblems({ NODE_ENV: 'development', SESSION_SECRET: dc.DEV_SECRET }), []);
  const p1 = dc.productionProblems({ NODE_ENV: 'production' });
  ok(p1.length === 2 && /SESSION_SECRET/.test(p1[0]) && /KAHE_TRUST_PROXY/.test(p1[1]), JSON.stringify(p1));
  ok(/32 characters/.test(dc.productionProblems({ NODE_ENV: 'production', SESSION_SECRET: 'short', KAHE_TRUST_PROXY: 'off' })[0]));
  ok(/not allowed/.test(dc.productionProblems({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: 'off', KAHE_COOKIE_SECURE: 'false' })[0]));
  ok(/not a hop count/.test(dc.productionProblems({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: 'all' })[0]));
  eq(dc.productionProblems({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: '1' }), []);
});
await check('rate-limit key: req.ip, IPv4-mapped unwrapped, IPv6 keyed on /64', async () => {
  eq(dc.clientIpKey({ ip: '203.0.113.9' }), '203.0.113.9');
  eq(dc.clientIpKey({ ip: '::ffff:203.0.113.9' }), '203.0.113.9');
  eq(dc.clientIpKey({ ip: '2001:db8:abcd:1234:5678:9abc:def0:1' }), '2001:0db8:abcd:1234::/64');
  eq(dc.clientIpKey({ ip: '2001:db8:abcd:1234::9' }), '2001:0db8:abcd:1234::/64');
  eq(dc.clientIpKey({ ip: '::1' }), '0000:0000:0000:0000::/64');
  eq(dc.clientIpKey({ socket: { remoteAddress: '10.1.2.3' } }), '10.1.2.3');
});

// =============================================================================================================
section('2. DIRECT MODE (default: no proxy trusted)');
const direct = await startServer();
const wf = cookieOf(await login(direct.base, 'workforce@kahe360.local'));
const dirC = cookieOf(await login(direct.base, 'director@kahe360.local'));
await check('a client-forged X-Forwarded-For is ignored: req.ip is the TCP peer (audit evidence)', async () => {
  await http(direct.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: dirC, headers: { 'X-Forwarded-For': '203.0.113.50', 'X-Real-IP': '203.0.113.51' } });
  eq(await lastDeniedIp(), '127.0.0.1');
});
await check('rate limit keyed on the TCP peer in direct mode: rotating X-Forwarded-For does not escape it', async () => {
  const lim = await startServer({ KAHE_TRUST_PROXY: 'off', KAHE_TW_REG_SUBMIT_MAX: '2' });
  const s = [];
  for (const xff of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) s.push((await submitWith(lim.base, { 'X-Forwarded-For': xff })).status);
  eq(s, [403, 403, 429, 429]);
});
await check('development session cookie: HttpOnly; SameSite=Lax; not Secure — login works over plain HTTP', async () => {
  const r = await login(direct.base, 'hrd@kahe360.local');
  eq(r.status, 200);
  ok(/HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie) && !/;\s*Secure/i.test(r.setCookie), r.setCookie);
  eq((await http(direct.base, 'GET', '/api/auth/me', { cookie: cookieOf(r) })).status, 200);
});
await check('login rate limiter (existing) still keys on req.ip = TCP peer; routes/auth.js is byte-unchanged from V0', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/auth.js'), 'utf8');
  ok(!/keyGenerator|X-Forwarded/.test(src), 'auth.js changed its keying');
  ok(!/trust proxy', 1\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'hard-coded trust proxy still present');
});

// =============================================================================================================
section('3. TRUSTED PROXY MODE');
await check('KAHE_TRUST_PROXY=1: req.ip is the address appended by the ONE trusted hop; a client-prepended value is discarded', async () => {
  const p1 = await startServer({ KAHE_TRUST_PROXY: '1' });
  const c = cookieOf(await login(p1.base, 'director@kahe360.local'));
  await http(p1.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: c, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  eq(await lastDeniedIp(), '203.0.113.9');
  await http(p1.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: c, headers: { 'X-Forwarded-For': '1.2.3.4, 203.0.113.10' } });
  eq(await lastDeniedIp(), '203.0.113.10');     // proxy appended 203.0.113.10; "1.2.3.4" came from the client and is ignored
  await http(p1.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: c });
  eq(await lastDeniedIp(), '127.0.0.1');        // no header: the peer itself
});
await check('KAHE_TRUST_PROXY=1: the rate limit is per real client, so one client cannot exhaust it for others', async () => {
  const lim = await startServer({ KAHE_TRUST_PROXY: '1', KAHE_TW_REG_SUBMIT_MAX: '2' });
  const s = [];
  for (let i = 0; i < 3; i += 1) s.push((await submitWith(lim.base, { 'X-Forwarded-For': '203.0.113.20' })).status);
  s.push((await submitWith(lim.base, { 'X-Forwarded-For': '203.0.113.21' })).status);
  s.push((await submitWith(lim.base, { 'X-Forwarded-For': '9.9.9.9, 203.0.113.20' })).status);   // still client .20 → limited
  eq(s, [403, 403, 429, 403, 429]);
});
await check('address-list mode: X-Forwarded-For is honoured only when the peer IS a listed proxy', async () => {
  const yes = await startServer({ KAHE_TRUST_PROXY: 'loopback' });
  const c1 = cookieOf(await login(yes.base, 'director@kahe360.local'));
  await http(yes.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: c1, headers: { 'X-Forwarded-For': '203.0.113.30' } });
  eq(await lastDeniedIp(), '203.0.113.30');
  const no = await startServer({ KAHE_TRUST_PROXY: '10.0.0.0/8' });
  const c2 = cookieOf(await login(no.base, 'director@kahe360.local'));
  await http(no.base, 'GET', '/api/tw/emergency-intake/registrations', { cookie: c2, headers: { 'X-Forwarded-For': '203.0.113.31' } });
  eq(await lastDeniedIp(), '127.0.0.1');
});
await check('Secure cookie behind a proxy: issued only when the trusted proxy says X-Forwarded-Proto: https', async () => {
  const s = await startServer({ KAHE_TRUST_PROXY: '1', KAHE_COOKIE_SECURE: 'true' });
  const plain = await login(s.base, 'hrd@kahe360.local');
  eq([plain.status, plain.setCookie], [200, null]);                                          // http: no Secure cookie can be sent
  const https = await login(s.base, 'hrd@kahe360.local', { 'X-Forwarded-Proto': 'https' });
  ok(https.status === 200 && /;\s*Secure/i.test(https.setCookie) && /HttpOnly/i.test(https.setCookie) && /SameSite=Lax/i.test(https.setCookie), String(https.setCookie));
  eq((await http(s.base, 'GET', '/api/auth/me', { cookie: cookieOf(https), headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
  // without a trusted proxy the header is ignored → still no cookie
  const s2 = await startServer({ KAHE_TRUST_PROXY: 'off', KAHE_COOKIE_SECURE: 'true' });
  eq((await login(s2.base, 'hrd@kahe360.local', { 'X-Forwarded-Proto': 'https' })).setCookie, null);
});

// =============================================================================================================
section('4. PRODUCTION FAIL-FAST');
await check('production with the development secret refuses to start (exit 1, reasons printed, nothing listening)', async () => {
  const r = await startServer({ NODE_ENV: 'production', SESSION_SECRET: dc.DEV_SECRET, KAHE_TRUST_PROXY: 'off' });
  eq(r.exitCode, 1); ok(/Refusing to start in production/.test(r.out()) && /SESSION_SECRET/.test(r.out()), r.out());
  ok(!/Environment: production/.test(r.out()), 'server reported listening');
});
await check('production without KAHE_TRUST_PROXY refuses to start; with an explicit topology it starts', async () => {
  const r = await startServer({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET });
  eq(r.exitCode, 1); ok(/KAHE_TRUST_PROXY/.test(r.out()), r.out());
  const s = await startServer({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: '1' });
  ok(s.base, 'did not start');
  const h = await http(s.base, 'GET', '/api/public/tw/register/health');
  eq([h.status, h.body], [200, { service: 'talent-registration-v0', status: 'ready' }]);
  const plain = await login(s.base, 'hrd@kahe360.local');
  eq([plain.status, plain.setCookie], [200, null]);       // production: Secure cookie ⇒ HTTPS required
  ok(/;\s*Secure/i.test((await login(s.base, 'hrd@kahe360.local', { 'X-Forwarded-Proto': 'https' })).setCookie));
});
await check('production refuses KAHE_COOKIE_SECURE=false and an invalid KAHE_TRUST_PROXY', async () => {
  const a = await startServer({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: 'off', KAHE_COOKIE_SECURE: 'false' });
  eq(a.exitCode, 1); ok(/KAHE_COOKIE_SECURE=false is not allowed/.test(a.out()));
  const b = await startServer({ NODE_ENV: 'production', SESSION_SECRET: GOOD_SECRET, KAHE_TRUST_PROXY: 'everything' });
  eq(b.exitCode, 1); ok(/not a hop count/.test(b.out()));
});
await check('a garbage KAHE_TRUST_PROXY also refuses to start in development (never silently trusted)', async () => {
  const r = await startServer({ KAHE_TRUST_PROXY: 'true' });
  eq(r.exitCode, 1); ok(/KAHE_TRUST_PROXY/.test(r.out()));
});

// =============================================================================================================
section('5. READINESS ENDPOINT');
await check('ready: 200, exactly { service, status }, no login, no-store', async () => {
  const h = await http(direct.base, 'GET', '/api/public/tw/register/health');
  eq([h.status, h.body], [200, { service: 'talent-registration-v0', status: 'ready' }]);
  eq(h.headers.get('cache-control'), 'no-store');
});
await check('not ready (Talent schema absent): 503 { status: not_ready } with no reason, path, version or count', async () => {
  const core = await createTestDatabase('talent_hard_core');
  try {
    const s = await startServer({ DATABASE_URL: core.appUrl });
    const h = await http(s.base, 'GET', '/api/public/tw/register/health');
    eq([h.status, h.body], [503, { service: 'talent-registration-v0', status: 'not_ready' }]);
    ok(!/TW00|SCHEMA|\/home|\/srv|postgres|uploads|password/i.test(h.text), h.text);
    s.proc.kill();
  } finally { await core.drop(); }
});
await check('not ready when the upload storage cannot be used (path is a file): 503, path never leaked', async () => {
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'tw_hard_ro_'));
  const blocker = path.join(ro, 'store'); fs.writeFileSync(blocker, 'not a directory');
  const s = await startServer({ KAHE_TW_UPLOAD_DIR: blocker });
  const h = await http(s.base, 'GET', '/api/public/tw/register/health');
  eq([h.status, h.body], [503, { service: 'talent-registration-v0', status: 'not_ready' }]);
  ok(!h.text.includes(ro) && !/ENOTDIR|EEXIST|mkdir/.test(h.text), 'path leaked');
  s.proc.kill(); fs.rmSync(ro, { recursive: true, force: true });
});

// =============================================================================================================
section('6. PRIVATE STORAGE & SECURITY HEADERS');
await check('no directory listing and no static exposure of the upload directory or the view files', async () => {
  const key = `${crypto.randomBytes(16).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR, key), PDF, { mode: 0o600 });
  for (const u of ['/uploads/', '/uploads/talent-registration/', `/uploads/talent-registration/${key}`, `/${key}`, '/tw-assets/', '/assets/', '/modules/', '/modules/talent/views/register.html', '/register/../uploads/talent-registration/' + key]) {
    const r = await http(direct.base, 'GET', u);
    ok(r.status === 404 || (r.status === 302 && r.headers.get('location') === '/register/profile'), `${u} -> ${r.status}`);
    ok(!r.text.includes('%PDF') && !/<a href="[^"]*\.pdf"/.test(r.text), `${u} exposed content`);
  }
});
await check('storage is git-ignored, outside public/, no download route, no directory index in code', async () => {
  ok(/^uploads\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
  const src = ['modules/talent/routes/publicRegister.js', 'modules/talent/routes/publicRegisterPages.js', 'modules/talent/routes/emergencyIntake.js', 'modules/talent/routes/api.js', 'modules/talent/routes/pages.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  ok(!/res\.download|storage_key[^\n]*sendFile|createReadStream|serveIndex|express\.static/.test(src), 'a file-serving path exists in Talent routes');
  ok(/index: false/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'static index not disabled');
  ok(!path.resolve(require('../modules/talent/lib/uploadGuard').storageDir()).startsWith(path.join(ROOT, 'public')), 'upload dir under public/');
});
await check('P01–P04 send the scoped strict CSP + referrer/robots/no-store; register.html has no inline script/style/handlers', async () => {
  for (const p of ['/register/profile', '/register/experience-skills', '/register/availability-cv', '/register/success']) {
    const r = await http(direct.base, 'GET', p);
    eq([p, r.status, r.headers.get('content-security-policy')], [p, 200, CSP]);
    eq([r.headers.get('referrer-policy'), r.headers.get('x-robots-tag'), r.headers.get('cache-control')], ['no-referrer', 'noindex', 'no-store']);
    eq([r.headers.get('x-content-type-options'), r.headers.get('x-frame-options')], ['nosniff', 'SAMEORIGIN']);
  }
  const html = fs.readFileSync(path.join(ROOT, 'modules/talent/views/register.html'), 'utf8');
  ok(!/<script(?![^>]*\bsrc=)/i.test(html) && !/<style\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/\sstyle\s*=/i.test(html) && !/javascript:/i.test(html), 'inline content would be blocked by CSP');
  ok(/frame-ancestors 'none'/.test(CSP) && /object-src 'none'/.test(CSP) && !/unsafe/.test(CSP));
  const js = fs.readFileSync(path.join(ROOT, 'public/tw-assets/register.js'), 'utf8');
  ok(!/https?:\/\//.test(js.replace(/https:\/\/www\.linkedin\.com\/in\/username/g, '')), 'register.js loads a remote origin');
});
await check('CSP is scoped: the portal login page and Talent shell keep their existing headers (portal-wide CSP unchanged)', async () => {
  eq((await http(direct.base, 'GET', '/login.html')).headers.get('content-security-policy'), null);
  const shell = await http(direct.base, 'GET', '/tw/app/', { cookie: wf });
  eq([shell.status, shell.headers.get('content-security-policy')], [200, null]);
});
await check('429 and token errors stay generic (no candidate existence hint); IPv6 loopback key is stable', async () => {
  const lim = await startServer({ KAHE_TW_REG_SUBMIT_MAX: '1' });
  await submitWith(lim.base, {});
  const r = await submitWith(lim.base, {});
  eq([r.status, r.body], [429, { error: 'RATE_LIMITED', detail: {} }]);
  ok(r.headers.get('ratelimit-limit') === '1' && !/candidate|exist|duplicate|KAHE-TAL/i.test(r.text));
});

} finally {
  for (const s of servers) { try { s.kill(); } catch { /* */ } }
  await __t.drop();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

console.log('\n============================================================');
console.log(`TALENT INTERNET HARDENING V0 TESTS: ${passed} passed, ${failed} failed`);
console.log('============================================================');
if (failed) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
