// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../database/init-db');
const { loadUserContext, requirePermission } = require('../middleware/permissions');
const { requireApiAuth } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' },
});

async function logAuthEvent(eventType, { email, userId, req }) {
  try {
    const db = getDb();
    try {
      await db.prepare(
        `INSERT INTO audit_auth_events (event_type, email, user_id, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).run(eventType, email || null, userId || null, req.ip, req.get('user-agent') || null);
    } finally {
      db.close();
    }
  } catch (err) {
    // Audit logging must never break the auth flow itself.
    console.error(`[auth] failed to write audit event ${eventType} for ${email || 'unknown'}:`, err.message);
  }
}

router.post(
  '/login',
  loginLimiter,
  [
    body('email').trim().isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Email dan password wajib diisi dengan benar.' });
    }

    const { email, password } = req.body;

    let user;
    try {
      const db = getDb();
      try {
        user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      } finally {
        db.close();
      }
    } catch (err) {
      // Surface the REAL reason on the server console (stale/corrupt DB,
      // locked file, schema mismatch, etc.) while the browser only ever
      // sees a generic message — never leak internals to the client.
      console.error(`[auth] login DB read failed for "${email}":`, err.message);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan. Silakan coba lagi.' });
    }

    const genericFail = async () => {
      await logAuthEvent('LOGIN_FAILED', { email, req });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email atau password salah.' });
    };

    if (!user || !user.is_active) return await genericFail();

    let passwordOk;
    try {
      passwordOk = bcrypt.compareSync(password, user.password_hash);
    } catch (err) {
      console.error(`[auth] password compare failed for "${email}" (bad/missing password_hash?):`, err.message);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan. Silakan coba lagi.' });
    }
    if (!passwordOk) return await genericFail();

    req.session.regenerate(async (err) => {
      if (err) {
        console.error(`[auth] session regenerate failed for "${email}":`, err.message);
        return res.status(500).json({ error: 'SESSION_ERROR', message: 'Could not start session.' });
      }
      req.session.userId = user.id;
      await logAuthEvent('LOGIN_SUCCESS', { email, userId: user.id, req });
      let userContext;
      try {
        userContext = await loadUserContext(user.id);
      } catch (ctxErr) {
        console.error(`[auth] loadUserContext failed right after login for user #${user.id}:`, ctxErr.message);
        return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan. Silakan coba lagi.' });
      }
      res.json({ ok: true, user: publicUser(userContext) });
    });
  }
);

router.post('/logout', (req, res) => {
  const email = req.session ? req.session.userEmailForLog : undefined;
  const userId = req.session ? req.session.userId : undefined;
  req.session.destroy(async () => {
    res.clearCookie('kahe360.sid');
    await logAuthEvent('LOGOUT', { email, userId, req });
    res.json({ ok: true });
  });
});

router.get('/me', requireApiAuth, async (req, res) => {
  let userContext;
  try {
    userContext = await loadUserContext(req.session.userId);
  } catch (err) {
    console.error(`[auth] /me loadUserContext failed for user #${req.session.userId}:`, err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
  if (!userContext) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
  res.json({ user: publicUser(userContext) });
});

router.get('/permissions', requireApiAuth, async (req, res) => {
  let userContext;
  try {
    userContext = await loadUserContext(req.session.userId);
  } catch (err) {
    console.error(`[auth] /permissions loadUserContext failed for user #${req.session.userId}:`, err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
  if (!userContext) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
  res.json({ permissions: userContext.permissions, projectScope: userContext.projectScope,
    entityScope: userContext.entityScope });
});

function publicUser(userContext) {
  return {
    id: userContext.id,
    email: userContext.email,
    displayName: userContext.displayName,
    roles: userContext.roles,
    roleNames: userContext.roleNames,
    permissions: userContext.permissions,
    projectScope: userContext.projectScope,
    // Phase 2I: the entities this user may read. Empty means none — the UI
    // should show an explicit 'no entity access' state rather than an
    // empty payroll that looks like missing data.
    entityScope: userContext.entityScope,
  };
}

module.exports = router;
