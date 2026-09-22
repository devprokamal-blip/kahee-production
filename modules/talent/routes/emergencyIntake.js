// modules/talent/routes/emergencyIntake.js
// EMERGENCY REGISTRATION INTAKE V0 — a minimal internal list + CSV export of V0 public registrations.
// It is NOT P05 Talent Intake (no review, status change, mapping or document access).
//   API  /api/tw/emergency-intake/registrations   tw_emergency_intake:VIEW
//        /api/tw/emergency-intake/export.csv      tw_emergency_intake:EXPORT  (audited as EXPORT_CSV)
//   Page /tw/emergency-intake                     tw_emergency_intake:VIEW
// Every response goes through the CP1 field-level security and requires data scope ALL.
const path = require('path');
const express = require('express');
const { getDb } = require('../../../database/db');
const { requireTalentSchema } = require('../lib/schemaCheck');
const { requireTalent } = require('../lib/talentAuth');
const { loadFieldSecurity, applyFieldSecurity } = require('../lib/fieldSecurity');
const { resolveScope, checkScope } = require('../lib/dataScope');
const { recordEvent } = require('../lib/talentAudit');
const { listRegistrations, LIST_FIELDS, toCatalogRecord } = require('../lib/registrationV0');

const VIEW = path.join(__dirname, '..', 'views', 'emergency-intake.html');
const EXPORT_MAX_ROWS = 10000;

function scopeGuard(req, res, next) {
  const s = checkScope(resolveScope(req.talent.scopeRows), {});
  if (!s.allowed) return res.status(403).json({ error: 'FORBIDDEN', detail: { reason: s.reason } });
  return next();
}

async function secureRows(db, ctx, rows) {
  const fs = await loadFieldSecurity(db, ctx.roles);
  return rows.map((r) => {
    const { data } = applyFieldSecurity(toCatalogRecord(r), fs);
    const out = {};
    for (const [name, code] of LIST_FIELDS) if (code in data) out[name] = data[code];
    return out;
  });
}

// ---- API -------------------------------------------------------------------------------------------------
const api = express.Router();
api.use(requireTalentSchema('api'));
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

api.get('/registrations', requireTalent('tw_emergency_intake', 'VIEW'), scopeGuard, async (req, res) => {
  const db = getDb();
  try {
    const r = await listRegistrations(db, { limit: req.query.limit, offset: req.query.offset, q: req.query.q });
    res.json({ label: 'EMERGENCY REGISTRATION INTAKE V0', total: r.total, limit: r.limit, offset: r.offset,
      rows: await secureRows(db, req.talent, r.rows) });
  } finally { db.close(); }
});

// CSV cells: quote everything and neutralise spreadsheet formulas (=, +, -, @, tab, CR at the start of a value).
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

api.get('/export.csv', requireTalent('tw_emergency_intake', 'EXPORT'), scopeGuard, async (req, res) => {
  const db = getDb();
  try {
    const r = await listRegistrations(db, { limit: EXPORT_MAX_ROWS > 200 ? 200 : EXPORT_MAX_ROWS, offset: 0 });
    // page through everything (the list helper caps a page at 200 rows)
    let rows = r.rows; let offset = rows.length;
    while (offset < Math.min(r.total, EXPORT_MAX_ROWS)) {
      const next = await listRegistrations(db, { limit: 200, offset });
      if (!next.rows.length) break;
      rows = rows.concat(next.rows); offset += next.rows.length;
    }
    const secured = await secureRows(db, req.talent, rows);
    const columns = LIST_FIELDS.map(([name]) => name).filter((name) => secured.every((row) => name in row));
    // The export is refused unless its audit record is written first (fail closed).
    await recordEvent(db, { eventType: 'EXPORT_CSV', outcome: 'ALLOWED', actorUserId: req.talent.userId,
      actorRoles: req.talent.roles, permissionCode: 'tw_emergency_intake', action: 'EXPORT',
      route: String(req.originalUrl).split('?')[0], ip: req.ip,
      payload: { dataset: 'EMERGENCY_REGISTRATION_V0', rows: secured.length, columns, truncated: r.total > EXPORT_MAX_ROWS } });
    const body = [columns.map(csvCell).join(','), ...secured.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="emergency-registrations-v0-${stamp}.csv"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(`\ufeff${body}\r\n`);
  } finally { db.close(); }
});

api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', detail: {} }));

// ---- page ------------------------------------------------------------------------------------------------
const page = express.Router({ strict: false });
page.use(requireTalentSchema('page'));
page.get('/', requireTalent('tw_emergency_intake', 'VIEW', 'page'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(VIEW);
});
page.use((req, res) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>KAHE Talent</title>'
  + '<p style="font-family:sans-serif;padding:2rem">Halaman tidak ditemukan.</p>'));

module.exports = { api, page, csvCell };
