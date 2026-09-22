// modules/talent/routes/api.js — mounted at /api/tw
// CP1 foundation API. No worker data is served yet; nothing here reads a protected public table.
const express = require('express');
const { requireTalentSchema, checkTalentSchema } = require('../lib/schemaCheck');
const { requireTalent, can } = require('../lib/talentAuth');
const { resolveScope, summarizeScope } = require('../lib/dataScope');
const { NAV } = require('./pages');

// Operational domains the Worker Passport will aggregate later. Until an approved integration
// checkpoint connects one, it is reported as NOT_CONNECTED — never with invented data.
const PENDING_INTEGRATIONS = Object.freeze(['ATTENDANCE', 'OVERTIME', 'PAYROLL', 'BPJS', 'ACCOMMODATION', 'MOBILITY', 'MEALS']);

const router = express.Router();
router.use(requireTalentSchema('api'));

router.get('/me', requireTalent(null), (req, res) => {
  const ctx = req.talent;
  res.set('Cache-Control', 'no-store');
  res.json({
    user: { display_name: ctx.displayName, role_names: ctx.roleNames },
    permissions: ctx.grants,
    nav: NAV.map((n) => ({ code: n.code, href: `/tw/app${n.path === '/' ? '/' : n.path}`, enabled: can(ctx, n.permission, 'VIEW') })),
    scope: summarizeScope(resolveScope(ctx.scopeRows)),
  });
});

router.get('/health', requireTalent('tw_home', 'VIEW'), async (req, res) => {
  const r = await checkTalentSchema();
  res.json({ ready: r.ready, schema_version: r.version || null });
});

router.get('/integrations', requireTalent('tw_worker_passport', 'VIEW'), (req, res) => {
  res.json({ integrations: PENDING_INTEGRATIONS.map((code) => ({ code, status: 'NOT_CONNECTED' })) });
});

router.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', detail: {} }));

module.exports = router;
module.exports.PENDING_INTEGRATIONS = PENDING_INTEGRATIONS;
