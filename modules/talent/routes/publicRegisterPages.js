// modules/talent/routes/publicRegisterPages.js — mounted at /register (no login)
// P01–P04 public registration shell. One view file, served from OUTSIDE public/ for exactly these paths.
const path = require('path');
const express = require('express');
const { requireTalentSchema } = require('../lib/schemaCheck');

const VIEW = path.join(__dirname, '..', 'views', 'register.html');
const STEPS = Object.freeze(['/profile', '/experience-skills', '/availability-cv', '/success']);

const router = express.Router({ strict: false });
router.use(requireTalentSchema('page'));
router.get('/', (req, res) => res.redirect(302, '/register/profile'));
// Scoped Content-Security-Policy for the public P01–P04 shell only (the portal-wide Helmet CSP stays as it is).
// register.html carries no inline script, inline style or on* handler, so this strict policy renders the page as is.
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join('; ');
for (const p of STEPS) {
  router.get(p, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.set('Content-Security-Policy', CSP);
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(VIEW);
  });
}
router.use((req, res) => res.redirect(302, '/register/profile'));

module.exports = router;
module.exports.STEPS = STEPS;
module.exports.CSP = CSP;
