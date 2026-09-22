// modules/talent/routes/publicRegister.js — mounted at /api/public/tw/register
// Emergency Registration V0 public API. No login. Mounted in server.js BEFORE the global write serializer so a slow
// mobile upload can never hold the portal's write queue; each registration is one self-contained insert transaction.
//   GET  /form-token  → { token }            (same-origin fetch; the token goes back in the X-TW-Form-Token header)
//   POST /submit      → multipart: data (JSON) + cv (1 PDF) + supporting (0–5 PDF/JPG/PNG)
// Responses are codes only; nothing about other candidates (duplicates) or internal identifiers is ever returned.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../../../database/db');
const { requireTalentSchema } = require('../lib/schemaCheck');
const { issueToken, verifyToken } = require('../lib/formToken');
const { inspectUploads, UploadRejected, LIMITS } = require('../lib/uploadGuard');
const { validateRegistration, createRegistration, RegistrationInvalid } = require('../lib/registrationV0');

const intEnv = (name, dflt) => { const v = Number.parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : dflt; };
// Keyed on the validated client IP (lib/deploymentConfig.clientIpKey): req.ip is the TCP peer in direct mode and the
// address supplied by the last TRUSTED proxy hop when KAHE_TRUST_PROXY is set — a client-forged X-Forwarded-For is
// never used. The 429 body is generic: it says nothing about any candidate.
const { clientIpKey } = require('../../../lib/deploymentConfig');
const limiter = (max, windowMs) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: clientIpKey,
  validate: false, handler: (req, res) => res.status(429).json({ error: 'RATE_LIMITED', detail: {} }) });

const submitLimiter = limiter(intEnv('KAHE_TW_REG_SUBMIT_MAX', 20), intEnv('KAHE_TW_REG_SUBMIT_WINDOW_MS', 15 * 60 * 1000));
const tokenLimiter = limiter(intEnv('KAHE_TW_REG_TOKEN_MAX', 60), intEnv('KAHE_TW_REG_SUBMIT_WINDOW_MS', 15 * 60 * 1000));

const upload = multer({
  storage: multer.memoryStorage(),
  // files: one above the legitimate maximum (1 CV + 5 supporting) so an extra file is reported per field by maxCount.
  limits: { fileSize: LIMITS.fileBytes, files: 2 + LIMITS.supportingFiles, fields: 2, fieldSize: 32 * 1024, parts: 12, headerPairs: 200 },
}).fields([{ name: 'cv', maxCount: 1 }, { name: 'supporting', maxCount: LIMITS.supportingFiles }]);

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Deployment readiness (monitors / load balancers). Reports ONLY { service, status }: no reason, path, version or count.
// ready = Talent schema at the expected version AND private upload storage writable. Result cached for 5 s.
const { checkTalentSchema } = require('../lib/schemaCheck');
const { ensureStorage } = require('../lib/uploadGuard');
let healthCache = { at: 0, ready: false };
async function readiness() {
  if (Date.now() - healthCache.at < 5000) return healthCache.ready;
  let ready = false;
  try {
    ready = (await checkTalentSchema()).ready === true;
    if (ready) { const fs = require('fs'); fs.accessSync(ensureStorage(), fs.constants.W_OK); }
  } catch (_) { ready = false; }
  healthCache = { at: Date.now(), ready };
  return ready;
}
router.get('/health', tokenLimiter, async (req, res) => {
  const ready = await readiness();
  res.status(ready ? 200 : 503).json({ service: 'talent-registration-v0', status: ready ? 'ready' : 'not_ready' });
});

router.use(requireTalentSchema('api'));

router.get('/form-token', tokenLimiter, (req, res) => res.json({ token: issueToken() }));

function parseMultipart(req, res) {
  return new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
}

router.post('/submit', submitLimiter, async (req, res) => {
  const tokenCheck = verifyToken(req.get('X-TW-Form-Token'));
  if (!tokenCheck.ok) return res.status(403).json({ error: 'FORM_TOKEN_INVALID', detail: {} });
  if (!req.is('multipart/form-data')) return res.status(400).json({ error: 'INVALID_REQUEST', detail: {} });
  try {
    await parseMultipart(req, res);
  } catch (err) {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const field = err.field === 'cv' || err.field === 'supporting' ? err.field : '_form';
      let reason = { LIMIT_FILE_SIZE: 'FILE_TOO_LARGE', LIMIT_FILE_COUNT: 'TOO_MANY_FILES', LIMIT_UNEXPECTED_FILE: 'UNEXPECTED_FILE' }[err.code] || 'INVALID_UPLOAD';
      if (err.code === 'LIMIT_UNEXPECTED_FILE' && field !== '_form') reason = 'TOO_MANY_FILES';   // a known field above its maxCount
      return res.status(status).json({ error: 'UPLOAD_REJECTED', detail: { field, reason } });
    }
    return res.status(400).json({ error: 'INVALID_REQUEST', detail: {} });
  }
  let data;
  try { data = JSON.parse(String((req.body && req.body.data) || '')); } catch (_) { return res.status(400).json({ error: 'INVALID_REQUEST', detail: {} }); }
  let row; let docs;
  try {
    row = validateRegistration(data);
    docs = inspectUploads(req.files);
  } catch (err) {
    if (err instanceof RegistrationInvalid) {
      if (err.fields._form === 'REJECTED') return res.status(400).json({ error: 'SUBMISSION_REJECTED', detail: {} });
      return res.status(400).json({ error: 'VALIDATION_FAILED', detail: { fields: err.fields } });
    }
    if (err instanceof UploadRejected) return res.status(err.status).json({ error: 'UPLOAD_REJECTED', detail: { field: err.field, reason: err.reason } });
    throw err;
  }
  const db = getDb();
  try {
    const receipt = await createRegistration(db, row, docs, { nonce: tokenCheck.nonce });
    return res.status(201).json(receipt);
  } catch (err) {
    if (err.code === '23505' && /submission_nonce/.test(String(err.constraint || err.message))) {
      return res.status(409).json({ error: 'ALREADY_SUBMITTED', detail: {} });
    }
    console.error('[talent] registration failed:', err.code || err.message);   // no row data in logs
    return res.status(500).json({ error: 'INTERNAL_ERROR', detail: {} });
  } finally { db.close(); }
});

router.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', detail: {} }));
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[talent] public registration error:', err && (err.code || err.message));
  res.status(500).json({ error: 'INTERNAL_ERROR', detail: {} });
});

module.exports = router;
