// modules/talent/lib/formToken.js
// Public registration form token (Emergency Registration V0).
// The public form has no session, so classic session-bound CSRF tokens do not apply. Instead:
//   * the token is fetched with a same-origin GET and sent back in a CUSTOM HEADER (X-TW-Form-Token) — a cross-site page
//     cannot read the token and cannot set the header without a CORS preflight, which this server never approves;
//   * it is an HMAC over (nonce, issued-at) — it cannot be forged;
//   * it must be at least MIN_AGE old (bots that post instantly are refused) and at most MAX_AGE;
//   * its nonce is stored with the registration and is UNIQUE, so one token submits at most one registration.
const crypto = require('crypto');

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const minAgeMs = () => {
  const v = Number.parseInt(process.env.KAHE_TW_REG_MIN_FILL_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
};
const key = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'change_this_for_development')
  .update('kahe-talent-registration-v0').digest();

function sign(payload) { return crypto.createHmac('sha256', key()).update(payload).digest('base64url'); }

function issueToken(now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${nonce}.${now}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns { ok: true, nonce } or { ok: false, reason } — the reason is for logs/tests, never shown to candidates. */
function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return { ok: false, reason: 'MISSING' };
  const m = /^([0-9a-f]{32})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, reason: 'MALFORMED' };
  const expected = Buffer.from(sign(`${m[1]}.${m[2]}`));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'BAD_SIGNATURE' };
  const age = now - Number(m[2]);
  if (age < 0 || age > MAX_AGE_MS) return { ok: false, reason: 'EXPIRED' };
  if (age < minAgeMs()) return { ok: false, reason: 'TOO_FAST' };
  return { ok: true, nonce: m[1] };
}

module.exports = { issueToken, verifyToken, MAX_AGE_MS };
