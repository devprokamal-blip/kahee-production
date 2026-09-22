// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
require('./middleware/asyncErrors');
const PgSessionStore = require('./middleware/pgSessionStore');

const { getDb, initDb, DB_PATH } = require('./database/init-db');
const { requireAuth } = require('./middleware/auth');
const { loadUserContext, hasPermission } = require('./middleware/permissions');

// Page-level RBAC guard: unauthenticated → login, unauthorised → home with
// an error flag. This is UX enforcement on top of the API-level enforcement
// in middleware/permissions.js — the backend API routes remain independently
// protected regardless of this guard.
function requirePagePermission(moduleCode, action = 'VIEW') {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/login.html');
    }
    let ctx;
    try { ctx = await loadUserContext(req.session.userId); } catch (e) { ctx = null; }
    if (!ctx) { req.session.destroy(() => {}); return res.redirect('/login.html'); }
    if (hasPermission(ctx, moduleCode, action)) return next();
    return res.redirect('/index.html?access=denied&module=' + moduleCode);
  };
}

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const systemRoutes = require('./routes/system');
const hrdRoutes = require('./routes/hrd');
const timesheetRoutes = require('./routes/timesheet');
const workScheduleRoutes = require('./routes/work-schedule');
const attendanceCorrectionRoutes = require('./routes/attendance-correction');
const payrollConfigRoutes = require('./routes/payroll-config');
const payrollPeriodRoutes = require('./routes/payroll/periods');
const payrollSnapshotRoutes = require('./routes/payroll/snapshots');
const payrollDryRunRoutes = require('./routes/payroll/dryrun');
const payrollExceptionRoutes = require('./routes/payroll/exceptions');
const payrollRunRoutes = require('./routes/payroll/runs');
const payrollPayslipRoutes = require('./routes/payroll/payslips');
const payrollAdjustmentRoutes = require('./routes/payroll/adjustments');
const payrollPaymentRoutes = require('./routes/payroll/payments');
const workerServiceRoutes = require('./routes/worker-services');
const clientBillingRoutes = require('./routes/client-billing');

// Ensure schema exists even if seed hasn't run yet. Also acts as a startup
// self-check: a stale/incompatible database file (e.g. carried over from an
// older build) fails HERE with a clear, actionable message instead of
// crashing later with a raw native stack trace on the first login attempt.
(async () => {
  try {
    const db = getDb();
    await initDb(db);
    // Cheap read to prove the auth tables are actually usable, not just that
    // the file opened.
    await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    db.close();
  } catch (err) {
    console.error('========================================');
    console.error(' KAHE 360: DATABASE STARTUP CHECK FAILED');
    console.error('========================================');
    console.error(` Target: ${DB_PATH}`);
    console.error(` Error: ${err.message}`);
    console.error('');
    console.error(' Check that PostgreSQL is running, that DATABASE_URL in .env');
    console.error(' points at it, and that the schema is migrated and seeded:');
    console.error('   npm run db:migrate && npm run seed');
    console.error('========================================');
    process.exit(1);
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_for_development';

// Internet Deployment Hardening (Emergency Registration V0): the trusted-proxy setting, the session-cookie policy and
// the production fail-fast come from lib/deploymentConfig.js. Default (unset) = direct mode: no proxy is trusted, so
// req.ip is the TCP peer and a client-supplied X-Forwarded-For is ignored. See docs/DEPLOYMENT_INTERNET_V0.md.
const deployment = require('./lib/deploymentConfig');
{
  const problems = deployment.productionProblems(process.env);
  if (problems.length) {
    console.error('Refusing to start in production:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
app.set('trust proxy', deployment.resolveTrustProxy(process.env));

app.use(
  helmet({
    contentSecurityPolicy: false, // kept simple for local/LAN static assets in Phase 1
  })
);

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

app.use(
  session({
    store: new PgSessionStore(),
    name: 'kahe360.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // httpOnly + SameSite=Lax always; Secure is forced in production (HTTPS required) and optional in development
    // (KAHE_COOKIE_SECURE=true). Behind a proxy the cookie is only issued when the proxy sends X-Forwarded-Proto: https.
    cookie: deployment.resolveSessionCookie(process.env), // 8h maxAge
  })
);

// --- API routes ---
app.use(require('./middleware/dbStats'));   // no-op unless KAHE_DB_QUERY_STATS=1
// Talent Emergency Registration V0 — PUBLIC candidate registration API (no login). Mounted BEFORE the write serializer:
// a slow mobile upload must never hold the portal-wide write queue; each registration is one self-contained insert.
app.use('/api/public/tw/register', require('./modules/talent/routes/publicRegister'));
app.use(require('./middleware/writeSerializer'));   // DB-M1 CP5: mutating requests run one at a time, as they did on SQLite
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/hrd', hrdRoutes);
app.use('/api/timesheet', timesheetRoutes);
app.use('/api/work-schedule', workScheduleRoutes);
app.use('/api/attendance-correction', attendanceCorrectionRoutes);
app.use('/api', require('./routes/attendance-period'));   // A4 CP1: /api/attendance-periods, /api/attendance-closing-policies
app.use('/api/payroll-config', payrollConfigRoutes);
app.use('/api/payroll', payrollPeriodRoutes);
app.use('/api/payroll', payrollSnapshotRoutes);
app.use('/api/payroll', payrollDryRunRoutes);
app.use('/api/payroll', payrollExceptionRoutes);
app.use('/api/payroll', payrollRunRoutes);
app.use('/api/payroll', payrollPayslipRoutes);
app.use('/api/payroll', payrollAdjustmentRoutes);
app.use('/api/payroll', payrollPaymentRoutes);
app.use('/api/worker-services', workerServiceRoutes);
app.use('/api/client-billing', clientBillingRoutes);

// --- Talent & Worker V1 — isolated bounded context (schema `talent`, own migrations/grants/audit).
//     Namespaced: API under /api/tw, internal pages under /tw/app. If the Talent schema is absent,
//     only these two prefixes answer 503; the rest of the portal is unaffected. ---
app.use('/api/tw/emergency-intake', require('./modules/talent/routes/emergencyIntake').api);   // V0, before the CP1 /api/tw catch-all
app.use('/api/tw', require('./modules/talent/routes/api'));
app.use('/tw/app', require('./modules/talent/routes/pages'));
app.use('/tw/emergency-intake', require('./modules/talent/routes/emergencyIntake').page);          // EMERGENCY REGISTRATION INTAKE V0
app.use('/register', require('./modules/talent/routes/publicRegisterPages'));                     // public P01–P04

// --- Page routes (registered BEFORE the static middleware below, so the
//     auth guard on /index.html can never be bypassed by static file serving) ---
app.get('/', (req, res) => {
  return res.redirect('/register');
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// HOME is protected: unauthenticated access redirects to login.
app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Phase 2 pages: auth + RBAC guard ---
app.get('/pusat-kendali.html',
  requirePagePermission('command_center'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'pusat-kendali.html'))
);

app.get('/intelijen-perencanaan.html',
  requirePagePermission('intelligence_planning'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'intelijen-perencanaan.html'))
);

app.get('/talenta-kesiapan.html',
  requirePagePermission('talent_readiness'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'talenta-kesiapan.html'))
);

// --- Phase 3 pages: modules 04-17, auth + RBAC guard ---
app.get('/operasi-tenaga-kerja.html',
  requirePagePermission('workforce_operations'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'operasi-tenaga-kerja.html'))
);

app.get('/kinerja-ketenagakerjaan.html',
  requirePagePermission('performance_employment'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'kinerja-ketenagakerjaan.html'))
);

app.get('/penggajian-bpjs.html',
  requirePagePermission('payroll_bpjs'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'penggajian-bpjs.html'))
);

app.get('/hrd-kontrak.html',
  requirePagePermission('hrd_kontrak'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'hrd-kontrak.html'))
);

app.get('/timesheet-absensi.html',
  requirePagePermission('timesheet_absensi'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'timesheet-absensi.html'))
);

app.get('/jadwal-kerja.html',
  requirePagePermission('attendance_config'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'jadwal-kerja.html'))
);

app.get('/koreksi-absensi.html',
  requirePagePermission('attendance_correction'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'koreksi-absensi.html'))
);

app.get('/payroll-config.html',
  requirePagePermission('payroll_config'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'payroll-config.html'))
);

app.get('/layanan-pekerja.html',
  requirePagePermission('worker_services'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'layanan-pekerja.html'))
);

app.get('/kesehatan-kerja.html',
  requirePagePermission('occupational_health'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'kesehatan-kerja.html'))
);

app.get('/hse-kepatuhan.html',
  requirePagePermission('hse_compliance'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'hse-kepatuhan.html'))
);

app.get('/peralatan-resource.html',
  requirePagePermission('equipment_resource'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'peralatan-resource.html'))
);

app.get('/kendali-kontraktor.html',
  requirePagePermission('contractor_control'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'kendali-kontraktor.html'))
);

app.get('/kendali-pelanggan.html',
  requirePagePermission('customer_control'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'kendali-pelanggan.html'))
);

app.get('/komersial.html',
  requirePagePermission('commercial'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'komersial.html'))
);

app.get('/laporan-analitik.html',
  requirePagePermission('reports_analytics'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'laporan-analitik.html'))
);

app.get('/dokumen.html',
  requirePagePermission('documents'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dokumen.html'))
);

app.get('/demobilisasi.html',
  requirePagePermission('demobilization'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'demobilisasi.html'))
);

app.get('/pengaturan.html',
  requirePagePermission('settings'),
  (req, res) => res.sendFile(path.join(__dirname, 'public', 'pengaturan.html'))
);

// --- Static assets (CSS/JS/images). Because the explicit GET /index.html
//     route above is registered first and fully handles that path (redirect,
//     401, or sendFile), requests for /index.html never reach this static
//     middleware — the auth guard can't be bypassed by static file serving. ---
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Phase 2I: a cross-entity read is answered 404, never 403. A 403 would
  // confirm the record exists in another tenant, which is the basis of id
  // enumeration. The attempt is already audited in entity_access_audit.
  if (err && err.name === 'EntityAccessError') {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Data tidak ditemukan.' });
  }

  // Phase 0 / B5: the database now enforces invariants that were previously
  // application-only (one open payroll assignment per employee, one active
  // rule set, one open JKK version per class, one national holiday per date).
  // A violation is a client-correctable conflict, not a server fault, so it
  // must surface as 409 rather than a generic 500.
  const message = String(err && err.message);
  if (message.includes('SQLITE_CONSTRAINT') || message.includes('UNIQUE constraint failed')) {
    console.warn('Constraint violation:', message);
    return res.status(409).json({
      error: 'CONFLICT',
      message: 'Data bertentangan dengan aturan yang berlaku (duplikat atau versi ganda). Periksa data yang sudah ada.',
    });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

app.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const lanIps = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
    }
  }
  console.log('========================================');
  console.log(' KAHE 360 INTERNAL OPERATIONS');
  console.log('========================================');
  console.log(` Environment: ${NODE_ENV}`);
  console.log(` Laptop:      http://127.0.0.1:${PORT}`);
  for (const ip of lanIps) console.log(` Phone / LAN: http://${ip}:${PORT}`);
  console.log(` Database:    ${DB_PATH}`);
  console.log('========================================');
});
