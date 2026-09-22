// modules/talent/routes/pages.js — mounted at /tw/app
// Talent & Worker V1 internal pages (P05–P16 shell). Every page is guarded on the server and the
// HTML lives OUTSIDE public/ (modules/talent/views), so static file serving can never bypass the guard.
const path = require('path');
const express = require('express');
const { requireTalentSchema } = require('../lib/schemaCheck');
const { requireTalent } = require('../lib/talentAuth');

const SHELL = path.join(__dirname, '..', 'views', 'app-shell.html');

// Canonical Talent & Worker sidebar — exactly these 9 items, in this order.
// `path` is relative to /tw/app. `permission` is the Talent permission needed to open the page.
const NAV = Object.freeze([
  { code: 'home', path: '/', permission: 'tw_home' },
  { code: 'dashboard', path: '/dashboard', permission: 'tw_home' },
  { code: 'candidate_registration', path: '/candidate-registration', permission: 'tw_registration' },
  { code: 'talent_pool', path: '/talent-pool', permission: 'tw_talent_pool' },
  { code: 'verification_screening', path: '/verification-screening', permission: 'tw_verification' },
  { code: 'deployment_assignment', path: '/deployment-assignment', permission: 'tw_deployment' },
  { code: 'contract_placement', path: '/contract-placement', permission: 'tw_contract_placement' },
  { code: 'reports_analytics', path: '/reports-analytics', permission: 'tw_reports' },
  { code: 'settings', path: '/settings', permission: 'tw_security_admin' },
].map(Object.freeze));

const router = express.Router({ strict: false });
router.use(requireTalentSchema('page'));

function sendShell(req, res) {
  res.set('Cache-Control', 'no-store');
  res.sendFile(SHELL);
}

for (const item of NAV) router.get(item.path, requireTalent(item.permission, 'VIEW', 'page'), sendShell);

router.use((req, res) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>KAHE Talent</title>'
  + '<p style="font-family:sans-serif;padding:2rem">Halaman tidak ditemukan. <a href="/tw/app/">Kembali ke beranda Talent</a></p>'));

module.exports = router;
module.exports.NAV = NAV;
