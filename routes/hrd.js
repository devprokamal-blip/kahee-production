// routes/hrd.js
// HRD & Kontrak module: employee database + contract lifecycle.
// RBAC follows the same pattern as routes/user.js — requirePermission()
// loads roles/permissions fresh from SQLite on every call.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database/init-db');
const { requirePermission } = require('../middleware/permissions');
const { rupiahToSen } = require('../lib/money');

const router = express.Router();

// Roles that only get a narrowed field set back, even though they have
// hrd_kontrak:VIEW. Full-access roles (operations_director, workforce_manager,
// hrd_officer) are not in this map and get the complete record.
const FIELD_SCOPE = {
  payroll_officer: [
    'id', 'full_name', 'worker_type', 'project_code', 'position', 'status',
    'wage_scheme', 'daily_rate_sen', 'pay_cycle', 'contract_start', 'contract_end',
  ],
  occupational_health: [
    'id', 'full_name', 'worker_type', 'project_code', 'photo_path',
    'bpjs_kesehatan_no', 'status',
  ],
  hse_officer: [
    'id', 'full_name', 'worker_type', 'project_code', 'position', 'status',
  ],
};

// A user can hold more than one role; use the narrowest scope that applies.
// Full-access roles (workforce_manager, hrd_officer, operations_director)
// short-circuit to "no scoping" if present alongside a limited one.
function scopeFields(userContext, record) {
  const roles = userContext.roles || [];
  const fullAccessRoles = ['operations_director', 'workforce_manager', 'hrd_officer'];
  if (roles.some((r) => fullAccessRoles.includes(r))) return record;

  const scopedRole = roles.find((r) => FIELD_SCOPE[r]);
  if (!scopedRole) return record; // no scoping rule matched, e.g. admin-only roles
  const scoped = {};
  for (const field of FIELD_SCOPE[scopedRole]) {
    if (field in record) scoped[field] = record[field];
  }
  return scoped;
}

// ---- uploaded files: kept OUTSIDE /public, same posture as database/kahe360.db ----
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'employee-documents');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = `${req.params.id}_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    cb(null, safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB/file

// ---- helpers ------------------------------------------------------------
async function generateEmployeeId(db) {
  const year = new Date().getFullYear();
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE id LIKE ?`).get(`KAHE-${year}-%`);
  const next = String(row.n + 1).padStart(5, '0');
  return `KAHE-${year}-${next}`;
}

function contractStatus(contractEnd) {
  if (!contractEnd) return null;
  const days = Math.ceil((new Date(contractEnd) - new Date()) / 86400000);
  if (days < 0) return { days, level: 'expired' };
  if (days <= 7) return { days, level: 'red' };
  if (days <= 30) return { days, level: 'amber' };
  return { days, level: 'green' };
}

// ---- LIST + FILTER --------------------------------------------------------
router.get('/employees', requirePermission('hrd_kontrak', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const { worker_type, project_code, status, search } = req.query;
    let sql = 'SELECT * FROM employees WHERE 1=1';
    const params = [];
    if (worker_type)  { sql += ' AND worker_type = ?';  params.push(worker_type); }
    if (project_code) { sql += ' AND project_code = ?'; params.push(project_code); }
    if (status)       { sql += ' AND status = ?';       params.push(status); }
    if (search) {
      sql += ' AND (full_name LIKE ? OR id LIKE ? OR nik LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY updated_at DESC';

    const rows = (await db.prepare(sql).all(...params)).map((r) => ({
      ...scopeFields(req.userContext, r),
      contract_status: contractStatus(r.contract_end),
    }));
    res.json(rows);
  } finally {
    db.close();
  }
});

// ---- SUMMARY (KPI cards) ---------------------------------------------------
router.get('/employees/summary', requirePermission('hrd_kontrak', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE status = 'active'`).get()).n;
    const byType = await db.prepare(
      `SELECT worker_type, COUNT(*) AS n FROM employees WHERE status = 'active' GROUP BY worker_type ORDER BY worker_type`
    ).all();
    const expiringContracts = (await db.prepare(
      `SELECT COUNT(*) AS n FROM employees
       WHERE status = 'active' AND contract_end IS NOT NULL
         AND contract_end <= (kahe_now()::date + 30)`
    ).get()).n;
    const expiringDocs = (await db.prepare(
      `SELECT COUNT(*) AS n FROM employee_documents
       WHERE expiry_date IS NOT NULL AND expiry_date <= (kahe_now()::date + 30)`
    ).get()).n;

    res.json({ total, byType, expiringContracts, expiringDocs });
  } finally {
    db.close();
  }
});

// ---- GET ONE ----------------------------------------------------------------
router.get('/employees/:id', requirePermission('hrd_kontrak', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const record = await db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ error: 'NOT_FOUND' });

    const documents = await db.prepare(
      'SELECT id, employee_id, doc_type, doc_name, expiry_date, uploaded_by, uploaded_at FROM employee_documents WHERE employee_id = ?'
    ).all(req.params.id); // file_path deliberately excluded from the API response
    const history = await db.prepare(
      'SELECT * FROM employee_contract_history WHERE employee_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    res.json({
      ...scopeFields(req.userContext, record),
      contract_status: contractStatus(record.contract_end),
      documents,
      contract_history: history,
    });
  } finally {
    db.close();
  }
});

// ---- CREATE -------------------------------------------------------------------
router.post('/employees', requirePermission('hrd_kontrak', 'CREATE'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.full_name || !b.worker_type) {
      return res.status(400).json({ error: 'VALIDATION', message: 'full_name dan worker_type wajib diisi.' });
    }

    const id = await generateEmployeeId(db);
    await db.prepare(`
      INSERT INTO employees (
        id, full_name, nik, birth_date, gender, phone, address,
        worker_type, project_code, position, supervisor, status, start_date,
        bpjs_kesehatan_no, bpjs_tk_no,
        nip, grade, permanent_date,
        contract_no, contract_start, contract_end, wage_scheme,
        daily_rate_sen, pay_cycle,
        partner_company, partner_npwp, partner_pic, pks_no, work_scope, worker_count,
        created_by
      ) VALUES (
        @id, @full_name, @nik, @birth_date, @gender, @phone, @address,
        @worker_type, @project_code, @position, @supervisor, @status, @start_date,
        @bpjs_kesehatan_no, @bpjs_tk_no,
        @nip, @grade, @permanent_date,
        @contract_no, @contract_start, @contract_end, @wage_scheme,
        @daily_rate_sen, @pay_cycle,
        @partner_company, @partner_npwp, @partner_pic, @pks_no, @work_scope, @worker_count,
        @created_by
      )
    `).run({
      id,
      full_name: b.full_name, nik: b.nik || null, birth_date: b.birth_date || null,
      gender: b.gender || null, phone: b.phone || null, address: b.address || null,
      worker_type: b.worker_type, project_code: b.project_code || 'PPB_BALONGAN',
      position: b.position || null, supervisor: b.supervisor || null,
      status: b.status || 'active', start_date: b.start_date || null,
      bpjs_kesehatan_no: b.bpjs_kesehatan_no || null, bpjs_tk_no: b.bpjs_tk_no || null,
      nip: b.nip || null, grade: b.grade || null, permanent_date: b.permanent_date || null,
      contract_no: b.contract_no || null, contract_start: b.contract_start || null,
      contract_end: b.contract_end || null, wage_scheme: b.wage_scheme || null,
      // B3: accept rupiah from the client, persist integer sen.
      daily_rate_sen: rupiahToSen(b.daily_rate ?? b.daily_rate_sen), pay_cycle: b.pay_cycle || null,
      partner_company: b.partner_company || null, partner_npwp: b.partner_npwp || null,
      partner_pic: b.partner_pic || null, pks_no: b.pks_no || null,
      work_scope: b.work_scope || null, worker_count: b.worker_count || null,
      created_by: req.userContext.displayName,
    });

    if (b.worker_type === 'pkwt' && b.contract_end) {
      await db.prepare(`
        INSERT INTO employee_contract_history (employee_id, contract_no, start_date, end_date, action, status, requested_by, decided_at)
        VALUES (?, ?, ?, ?, 'new', 'approved', ?, kahe_now())
      `).run(id, b.contract_no || null, b.contract_start || null, b.contract_end || null, req.userContext.displayName);
    }

    res.status(201).json({ id });
  } finally {
    db.close();
  }
});

// ---- UPDATE ---------------------------------------------------------------------
router.put('/employees/:id', requirePermission('hrd_kontrak', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const existing = await db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

    const fields = [
      'full_name', 'nik', 'birth_date', 'gender', 'phone', 'address', 'worker_type', 'project_code',
      'position', 'supervisor', 'status', 'start_date', 'bpjs_kesehatan_no', 'bpjs_tk_no',
      'nip', 'grade', 'permanent_date', 'contract_no', 'contract_start', 'contract_end', 'wage_scheme',
      'daily_rate_sen', 'pay_cycle', 'partner_company', 'partner_npwp', 'partner_pic', 'pks_no', 'work_scope', 'worker_count',
    ];
    // These are NOT NULL columns (required fields) — an empty string here is
    // left as-is (and would fail validation upstream); every other field is
    // optional, so an empty string from an untouched form control means
    // "no value", which must be stored as NULL, not "" — several columns
    // (gender, pay_cycle) have a CHECK(...) that only permits NULL or one of
    // a fixed set of values, and "" satisfies neither.
    const REQUIRED_FIELDS = new Set(['full_name', 'worker_type', 'status']);
    const sets = fields.map((f) => `${f} = @${f}`).join(', ');
    const params = { id: req.params.id };
    fields.forEach((f) => {
      if (b[f] === undefined) { params[f] = existing[f]; }
      else if (b[f] === '' && !REQUIRED_FIELDS.has(f)) { params[f] = null; }
      else { params[f] = b[f]; }
    });

    await db.prepare(`UPDATE employees SET ${sets}, updated_at = kahe_now() WHERE id = @id`).run(params);
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

// ---- CONTRACT EXTEND / TERMINATE (goes to an approval queue) --------------------
router.post('/employees/:id/contract-action', requirePermission('hrd_kontrak', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    const { action, contract_no, start_date, end_date, note } = req.body; // 'extend' | 'terminate'
    if (!['extend', 'terminate'].includes(action)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'action harus extend atau terminate.' });
    }
    const renewalCount = (await db.prepare(
      `SELECT COUNT(*) AS n FROM employee_contract_history WHERE employee_id = ? AND action = 'extend' AND status = 'approved'`
    ).get(req.params.id)).n;

    await db.prepare(`
      INSERT INTO employee_contract_history
        (employee_id, contract_no, start_date, end_date, renewal_number, action, status, requested_by, note)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(req.params.id, contract_no || null, start_date || null, end_date || null,
      renewalCount + (action === 'extend' ? 1 : 0), action, req.userContext.displayName, note || null);

    res.status(201).json({ ok: true, status: 'pending_approval' });
  } finally {
    db.close();
  }
});

// ---- CONTRACT ACTIONS: pending queue (for the approval panel) ------------------
router.get('/contract-actions/pending', requirePermission('hrd_kontrak', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    const rows = await db.prepare(`
      SELECT h.*, e.full_name, e.position, e.worker_type
      FROM employee_contract_history h
      JOIN employees e ON e.id = h.employee_id
      WHERE h.status = 'pending'
      ORDER BY h.created_at ASC
    `).all();
    res.json(rows);
  } finally {
    db.close();
  }
});

// ---- APPROVE / REJECT contract action (needs hrd_kontrak:APPROVE) --------------
router.post('/contract-actions/:historyId/decide', requirePermission('hrd_kontrak', 'APPROVE'), async (req, res) => {
  const db = getDb();
  try {
    const { decision } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'decision harus approved atau rejected.' });
    }
    const entry = await db.prepare('SELECT * FROM employee_contract_history WHERE id = ?').get(req.params.historyId);
    if (!entry) return res.status(404).json({ error: 'NOT_FOUND' });

    await db.prepare(`
      UPDATE employee_contract_history SET status = ?, approved_by = ?, decided_at = kahe_now() WHERE id = ?
    `).run(decision, req.userContext.displayName, req.params.historyId);

    if (decision === 'approved') {
      if (entry.action === 'extend') {
        await db.prepare(`UPDATE employees SET contract_no = ?, contract_start = ?, contract_end = ?, updated_at = kahe_now() WHERE id = ?`)
          .run(entry.contract_no, entry.start_date, entry.end_date, entry.employee_id);
      } else if (entry.action === 'terminate') {
        await db.prepare(`UPDATE employees SET status = 'inactive', updated_at = kahe_now() WHERE id = ?`)
          .run(entry.employee_id);
      }
    }
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

// ---- DOCUMENT UPLOAD --------------------------------------------------------------
router.post('/employees/:id/documents', requirePermission('hrd_kontrak', 'EDIT'), upload.single('file'), async (req, res) => {
  const db = getDb();
  try {
    if (!req.file) return res.status(400).json({ error: 'VALIDATION', message: 'file wajib diunggah.' });
    const { doc_type, doc_name, expiry_date } = req.body;
    if (!doc_type) return res.status(400).json({ error: 'VALIDATION', message: 'doc_type wajib diisi.' });

    const info = await db.prepare(`
      INSERT INTO employee_documents (employee_id, doc_type, doc_name, file_path, expiry_date, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `).run(req.params.id, doc_type, doc_name || req.file.originalname, req.file.path, expiry_date || null, req.userContext.displayName);

    res.status(201).json({ ok: true, documentId: info.lastInsertRowid });
  } finally {
    db.close();
  }
});

// ---- DOCUMENT DOWNLOAD (streamed, permission-checked — never static-served) -----
router.get('/documents/:docId/file', requirePermission('hrd_kontrak', 'VIEW'), async (req, res) => {
  const db = getDb();
  try {
    const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(doc.file_path, doc.doc_name || path.basename(doc.file_path));
  } finally {
    db.close();
  }
});

// ---- DELETE (soft: mark inactive, keep history for audit) -----------------------
router.delete('/employees/:id', requirePermission('hrd_kontrak', 'EDIT'), async (req, res) => {
  const db = getDb();
  try {
    await db.prepare(`UPDATE employees SET status = 'inactive', updated_at = kahe_now() WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

module.exports = router;
