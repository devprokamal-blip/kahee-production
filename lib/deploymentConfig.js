// lib/deploymentConfig.js — Internet Deployment Hardening (Emergency Registration V0)
// Pure functions that turn environment variables into the trust-proxy setting, the session-cookie policy and the
// fail-fast production checks used by server.js. No I/O, no Express: everything here is unit-testable.
//
//   KAHE_TRUST_PROXY   off | <hops> | <comma-separated IPs / CIDRs / keywords>
//                      unset  -> direct mode (no proxy is trusted: req.ip is the TCP peer, X-Forwarded-* is ignored)
//                      off    -> same as unset, stated explicitly (required in production)
//                      1, 2…  -> trust exactly that many proxy hops in front of the app (Nginx on the same host = 1)
//                      list   -> trust only these proxy addresses, e.g. "loopback" or "10.0.0.5, 172.16.0.0/12"
//                      Keywords accepted by Express/proxy-addr: loopback, linklocal, uniquelocal.
//   KAHE_COOKIE_SECURE true | false
//                      production: always true (cannot be switched off — HTTPS is required)
//                      development: default false (plain HTTP on LAN); "true" for an HTTPS-terminating dev proxy
//   SESSION_SECRET     production: mandatory, not the development default, at least 32 characters
const net = require('net');

const DEV_SECRET = 'change_this_for_development';
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

class DeploymentConfigError extends Error {
  constructor(message) { super(message); this.name = 'DeploymentConfigError'; }
}

function isCidrOrIp(s) {
  const [ip, bits] = s.split('/');
  const v = net.isIP(ip);
  if (!v) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return v === 4 ? n <= 32 : n <= 128;
}

/** Express `trust proxy` value for the environment: false | number | string. */
function resolveTrustProxy(env = process.env) {
  const raw = String(env.KAHE_TRUST_PROXY === undefined ? '' : env.KAHE_TRUST_PROXY).trim();
  if (raw === '' || /^(off|false|0|none|no)$/i.test(raw)) return false;
  if (/^[1-9]\d{0,2}$/.test(raw)) return Number(raw);
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    if (!KEYWORDS.has(p) && !isCidrOrIp(p)) {
      throw new DeploymentConfigError(`KAHE_TRUST_PROXY: "${p}" is not a hop count, an IP address, a CIDR or one of loopback/linklocal/uniquelocal`);
    }
  }
  return parts.join(', ');
}

/** Session cookie options. */
function resolveSessionCookie(env = process.env) {
  const production = (env.NODE_ENV || 'development') === 'production';
  const raw = String(env.KAHE_COOKIE_SECURE === undefined ? '' : env.KAHE_COOKIE_SECURE).trim().toLowerCase();
  const secure = production ? true : raw === 'true' || raw === '1';
  return { httpOnly: true, sameSite: 'lax', secure, maxAge: 8 * 60 * 60 * 1000 };
}

/**
 * Production fail-fast. Returns the list of problems (empty = start). server.js refuses to listen when it is non-empty.
 * Development returns [] always: local/LAN HTTP keeps working unchanged.
 */
function productionProblems(env = process.env) {
  if ((env.NODE_ENV || 'development') !== 'production') return [];
  const problems = [];
  const secret = env.SESSION_SECRET || '';
  if (!secret || secret === DEV_SECRET) problems.push('SESSION_SECRET must be set to a real secret (not the development default)');
  else if (secret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (env.KAHE_TRUST_PROXY === undefined || String(env.KAHE_TRUST_PROXY).trim() === '') {
    problems.push('KAHE_TRUST_PROXY must be set explicitly: "off" (no reverse proxy) or the trusted hop count / proxy addresses');
  } else {
    try { resolveTrustProxy(env); } catch (err) { problems.push(err.message); }
  }
  if (String(env.KAHE_COOKIE_SECURE || '').trim().toLowerCase() === 'false') {
    problems.push('KAHE_COOKIE_SECURE=false is not allowed in production (HTTPS is required; session cookies are always Secure)');
  }
  return problems;
}

/**
 * Rate-limit key for a request: the validated client IP (req.ip — the TCP peer in direct mode, the address supplied
 * by the LAST TRUSTED proxy hop otherwise). IPv4-mapped addresses are unwrapped; IPv6 is keyed on its /64 so one
 * client cannot rotate through its 2^64 addresses to escape the limit.
 */
function clientIpKey(req) {
  let ip = String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || 'unknown');
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv6(ip)) {
    const full = expandIPv6(ip);
    return full ? `${full.slice(0, 4).join(':')}::/64` : ip;
  }
  return ip;
}

function expandIPv6(ip) {
  const noZone = ip.split('%')[0];
  const halves = noZone.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...head, ...Array(fill).fill('0'), ...tail].map((h) => h.padStart(4, '0'));
}

module.exports = { DeploymentConfigError, DEV_SECRET, resolveTrustProxy, resolveSessionCookie, productionProblems, clientIpKey };
