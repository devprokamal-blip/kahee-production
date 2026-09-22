// routes/attendance-period.js — Attendance A4 CP1
// Mounted once at /api (server.js). Serves only:
//   /api/attendance-periods/...            Attendance Period (VIEW / CREATE / EDIT)
//   /api/attendance-closing-policies/...   Closing Policy (VIEW / CREATE / EDIT / ADMIN)
//
// Contract:
//   * Every response error is { error: <MACHINE_CODE>, detail: {...} } — no human sentence.
//     The UI translates codes (Bahasa Indonesia default, English selectable).
//   * RBAC is enforced here, server-side, per route. The gate below reuses the shared
//     loadUserContext/hasPermission so authorization is identical to the rest of the portal,
//     but answers in the A4 language-neutral format.
//   * The actor is ALWAYS the authenticated session user; bodies are allowlisted per endpoint.
const express = require('express');
const { getDb } = require('../database/init-db');
const { loadUserContext, hasPermission } = require('../middleware/permissions');
const ap = require('../lib/attendancePeriod');
const cp = require('../lib/attendanceClosingPolicy');
const rd = require('../lib/attendanceReadiness');

const router = express.Router();
const P = '/attendance-periods';
const C = '/attendance-closing-policies';

function sendError(res, err) {
  const e = ap.mapError(err);
  if (e) return res.status(e.status).json({ error: e.code, detail: e.detail || {} });
  console.error('[attendance-period] unhandled error:', err);
  return res.status(500).json({ error: 'INTERNAL_ERROR', detail: {} });
}

/** Language-neutral RBAC gate. Every listed permission is required. */
function gate(...required) {
  return async (req, res, next) => {
    try {
      if (!req.session || !req.session.userId) return res.status(401).json({ error: 'UNAUTHENTICATED', detail: {} });
      const userContext = await loadUserContext(req.session.userId);
      if (!userContext) return res.status(401).json({ error: 'UNAUTHENTICATED', detail: {} });
      req.userContext = userContext;
      for (const [module, action] of required) {
        if (!hasPermission(userContext, module, action)) {
          return res.status(403).json({ error: 'FORBIDDEN', detail: { module, action } });
        }
      }
      return next();
    } catch (err) { return sendError(res, err); }
  };
}
const handle = (fn, status = 200) => async (req, res) => {
  try { res.status(status).json(await fn(req, getDb())); } catch (err) { sendError(res, err); }
};

const PV = ['attendance_period', 'VIEW'];
const PC = ['attendance_period', 'CREATE'];
const PE = ['attendance_period', 'EDIT'];
const CV = ['attendance_closing_policy', 'VIEW'];
const CC = ['attendance_closing_policy', 'CREATE'];
const CE = ['attendance_closing_policy', 'EDIT'];
const CA = ['attendance_closing_policy', 'ADMIN'];
const RV = ['attendance_readiness', 'VIEW'];
const RA = ['attendance_readiness', 'APPROVE'];

// ---- Attendance Period -------------------------------------------------------
router.get(P, gate(PV), handle((req, db) => ap.listPeriods(db, req.userContext, req.query, req.originalUrl)));
router.post(P, gate(PC), handle((req, db) => ap.createPeriod(db, req.userContext, req.body, req.originalUrl), 201));
router.get(`${P}/:id`, gate(PV), handle((req, db) => ap.getPeriod(db, req.userContext, req.params.id, req.originalUrl)));
router.patch(`${P}/:id`, gate(PE), handle((req, db) => ap.updateDetails(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.post(`${P}/:id/transition`, gate(PE),
  handle((req, db) => ap.transition(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.get(`${P}/:id/events`, gate(PV), handle((req, db) => ap.listEvents(db, req.userContext, req.params.id, req.originalUrl)));
// Read-only derived mapping; also requires payroll_run:VIEW so no Payroll metadata is exposed beyond today's visibility.
router.get(`${P}/:id/payroll-periods`, gate(PV, ['payroll_run', 'VIEW']), handle(async (req, db) => {
  const p = await ap.getPeriod(db, req.userContext, req.params.id, req.originalUrl);
  return { attendance_period_id: p.id, legal_entity_id: p.legal_entity_id, payroll_periods: await ap.payrollPeriodsFor(db, p) };
}));

// ---- Closing Policy ----------------------------------------------------------
router.get(C, gate(CV), handle((req, db) => cp.listPolicies(db, req.userContext, req.query, req.originalUrl)));
router.get(`${C}/issue-codes`, gate(CV), handle(async () => ({ configurable: cp.ISSUE_CODES, fixed_blockers: cp.FIXED_BLOCKERS })));
router.get(`${C}/resolve`, gate(CV), handle((req, db) => cp.resolveForUser(db, req.userContext, req.query, req.originalUrl)));
router.post(C, gate(CC), handle((req, db) => cp.createPolicy(db, req.userContext, req.body, req.originalUrl), 201));
router.get(`${C}/:id`, gate(CV), handle((req, db) => cp.getPolicyWithRules(db, req.userContext, req.params.id, req.originalUrl)));
router.patch(`${C}/:id`, gate(CE), handle((req, db) => cp.updatePolicy(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.put(`${C}/:id/rules/:issueCode`, gate(CE),
  handle((req, db) => cp.putRule(db, req.userContext, req.params.id, req.params.issueCode, req.body, req.originalUrl)));
router.delete(`${C}/:id/rules/:issueCode`, gate(CE),
  handle((req, db) => cp.deleteRule(db, req.userContext, req.params.id, req.params.issueCode, req.originalUrl)));
router.post(`${C}/:id/activate`, gate(CA), handle((req, db) => cp.activatePolicy(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.post(`${C}/:id/end`, gate(CA), handle((req, db) => cp.endPolicy(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.post(`${C}/:id/discard`, gate(CE), handle((req, db) => cp.discardPolicy(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.get(`${C}/:id/events`, gate(CV), handle((req, db) => cp.listPolicyEvents(db, req.userContext, req.params.id, req.originalUrl)));

// ---- Readiness (A4 CP2) — attendance_readiness only; attendance_period:VIEW alone reveals nothing ----
router.get(`${P}/:id/readiness`, gate(RV), handle((req, db) => rd.preview(db, req.userContext, req.params.id, req.originalUrl)));
router.get(`${P}/:id/readiness/issues`, gate(RV),
  handle((req, db) => rd.issueDetail(db, req.userContext, req.params.id, req.query, req.originalUrl)));
router.post(`${P}/:id/ready-to-close`, gate(RA),
  handle((req, db) => rd.readyToClose(db, req.userContext, req.params.id, req.body, req.originalUrl)));
router.post(`${P}/:id/withdraw-ready`, gate(RA),
  handle((req, db) => rd.withdrawReady(db, req.userContext, req.params.id, req.body, req.originalUrl)));

// Anything else inside the two A4 namespaces answers in the same language-neutral format
// (instead of falling through to the portal's generic 404). Must stay LAST.
router.all([P, `${P}/*`, C, `${C}/*`], (req, res) => res.status(404).json({ error: 'NOT_FOUND', detail: {} }));

module.exports = router;
