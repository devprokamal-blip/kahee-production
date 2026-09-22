// routes/user.js
// Demonstrates backend RBAC enforcement on a protected, permission-gated route.
const express = require('express');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

// Example restricted endpoint used for Phase 1 RBAC testing:
// only roles with payroll_bpjs:VIEW may read this.
router.get('/payroll-summary', requirePermission('payroll_bpjs', 'VIEW'), (req, res) => {
  res.json({
    ok: true,
    module: 'payroll_bpjs',
    note: 'Demo payroll summary endpoint (mock data) — Phase 1 RBAC check only.',
    data: { ready: '96.8%', exceptions: 31 },
  });
});

// Example admin-only endpoint (Operations Director only in current seed).
router.get('/admin/users', requirePermission('users', 'ADMIN'), (req, res) => {
  res.json({ ok: true, module: 'users', note: 'Demo admin endpoint — user list would go here.' });
});

module.exports = router;
