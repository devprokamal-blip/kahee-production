// hrd-kontrak.js — KAHE 360 Internal Operations Portal
// Talks to /api/hrd/* (routes/hrd.js). Loaded AFTER page-shell.js, which
// already wired the sidebar/topbar/logout/i18n/clock for this page.
(function () {
  const API = '/api/hrd';
  const TYPE_LABELS = {
    internal: 'Internal KAHE',
    pkwt: 'Kontrak (PKWT)',
    harian: 'Harian',
    subkontraktor: 'Subkontraktor',
  };

  const el = {
    kpiTotal: document.getElementById('kpiTotal'),
    kpiContracts: document.getElementById('kpiContracts'),
    kpiDocs: document.getElementById('kpiDocs'),
    kpiBreakdown: document.getElementById('kpiBreakdown'),
    rows: document.getElementById('employeeRows'),
    search: document.getElementById('fSearch'),
    type: document.getElementById('fType'),
    status: document.getElementById('fStatus'),
    btnAdd: document.getElementById('btnAdd'),
    overlay: document.getElementById('modalOverlay'),
    form: document.getElementById('employeeForm'),
    modalTitle: document.getElementById('modalTitle'),
    workerType: document.getElementById('workerType'),
    docUploadBlock: document.getElementById('docUploadBlock'),
    documentList: document.getElementById('documentList'),
  };

  let currentEmployeeId = null;
  let myActions = { hrd_kontrak: [] }; // filled once /api/auth/me resolves

  function can(action) {
    return Array.isArray(myActions.hrd_kontrak) && myActions.hrd_kontrak.includes(action);
  }

  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  function contractStatus(contractEnd) {
    if (!contractEnd) return null;
    const days = Math.ceil((new Date(contractEnd) - new Date()) / 86400000);
    if (days < 0) return { days, level: 'expired' };
    if (days <= 7) return { days, level: 'red' };
    if (days <= 30) return { days, level: 'amber' };
    return { days, level: 'green' };
  }

  function contractBadge(status) {
    if (!status) return '<span class="status-badge">-</span>';
    const map = { green: 'status-badge--green', amber: 'status-badge--amber', red: 'status-badge--red', expired: 'status-badge--red' };
    const label = status.level === 'expired' ? 'Berakhir' : `${status.days} hari`;
    return `<span class="status-badge ${map[status.level]}">${label}</span>`;
  }

  // ---- data loading -------------------------------------------------------
  async function loadSummary() {
    const res = await fetch(`${API}/employees/summary`);
    if (!res.ok) return;
    const data = await res.json();
    el.kpiTotal.textContent = data.total;
    el.kpiContracts.textContent = data.expiringContracts;
    el.kpiDocs.textContent = data.expiringDocs;
    el.kpiBreakdown.innerHTML = data.byType
      .map((t) => `${TYPE_LABELS[t.worker_type] || t.worker_type}: <strong style="color:var(--white)">${t.n}</strong>`)
      .join(' &nbsp;·&nbsp; ') || '—';
  }

  async function loadEmployees() {
    const params = new URLSearchParams();
    if (el.search.value) params.set('search', el.search.value);
    if (el.type.value) params.set('worker_type', el.type.value);
    if (el.status.value) params.set('status', el.status.value);

    el.rows.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--grey-500);padding:20px">Memuat data…</td></tr>`;
    const res = await fetch(`${API}/employees?${params.toString()}`);
    if (!res.ok) {
      el.rows.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red-500);padding:20px">Gagal memuat data.</td></tr>`;
      return;
    }
    const rows = await res.json();
    if (!rows.length) {
      el.rows.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--grey-500);padding:20px">Belum ada data karyawan.</td></tr>`;
      return;
    }
    el.rows.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.id}</td>
        <td>${r.full_name}</td>
        <td>${TYPE_LABELS[r.worker_type] || r.worker_type || '-'}</td>
        <td>${r.position || '-'}</td>
        <td><span class="status-badge ${r.status === 'active' ? 'status-badge--green' : ''}">${r.status === 'active' ? 'Aktif' : 'Nonaktif'}</span></td>
        <td>${contractBadge(r.contract_status)}</td>
        <td>${can('EDIT') || can('VIEW') ? `<button class="hrd-table__link" data-open="${r.id}">${can('EDIT') ? 'Edit' : 'Lihat'}</button>` : ''}</td>
      </tr>
    `).join('');

    el.rows.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openEdit(btn.getAttribute('data-open')));
    });
  }

  // ---- modal: tabs ---------------------------------------------------------
  document.querySelectorAll('.modal__tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal__tab').forEach((b) => b.classList.remove('is-active'));
      document.querySelectorAll('.modal__panel').forEach((p) => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      document.querySelector(`.modal__panel[data-panel="${btn.dataset.tab}"]`).classList.add('is-active');
    });
  });

  function updateTypeFields() {
    const type = el.workerType.value;
    document.querySelectorAll('.type-fields').forEach((block) => {
      block.classList.toggle('is-active', block.dataset.for === type);
    });
    const box = document.getElementById('contractActionBox');
    box.style.display = (type === 'pkwt' && currentEmployeeId && can('EDIT')) ? 'block' : 'none';
  }
  el.workerType.addEventListener('change', updateTypeFields);

  function openModal() { el.overlay.hidden = false; }
  function closeModal() {
    el.overlay.hidden = true;
    el.form.reset();
    currentEmployeeId = null;
    el.docUploadBlock.style.display = 'none';
    el.documentList.innerHTML = '';
    updateTypeFields();
    document.querySelectorAll('.modal__tab').forEach((b, i) => b.classList.toggle('is-active', i === 0));
    document.querySelectorAll('.modal__panel').forEach((p, i) => p.classList.toggle('is-active', i === 0));
  }

  el.btnAdd.addEventListener('click', () => {
    el.modalTitle.textContent = 'Tambah Karyawan';
    openModal();
  });
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  el.overlay.addEventListener('click', (e) => { if (e.target === el.overlay) closeModal(); });

  window.openEdit = openEdit; // exposed for the inline onclick fallback path, if any
  async function openEdit(id) {
    const res = await fetch(`${API}/employees/${id}`);
    if (!res.ok) return toast('Gagal memuat data karyawan.');
    const data = await res.json();
    currentEmployeeId = id;
    el.modalTitle.textContent = data.full_name ? `Edit: ${data.full_name}` : `Detail: ${id}`;

    Object.entries(data).forEach(([key, value]) => {
      const field = el.form.elements[key];
      if (field && value !== null && value !== undefined) field.value = value;
    });
    updateTypeFields();

    const readOnly = !can('EDIT');
    Array.from(el.form.elements).forEach((f) => { if (f.tagName !== 'BUTTON') f.disabled = readOnly; });
    document.querySelector('.modal__footer button[type="submit"]').style.display = readOnly ? 'none' : '';

    el.docUploadBlock.style.display = can('EDIT') ? 'flex' : 'none';
    renderDocuments(data.documents || []);
    renderContractHistory(data.contract_history || []);
    openModal();
  }

  function renderContractHistory(history) {
    const box = document.getElementById('contractHistoryList');
    if (!history.length) { box.innerHTML = ''; return; }
    const statusBadge = { pending: 'status-badge--amber', approved: 'status-badge--green', rejected: 'status-badge--red' };
    box.innerHTML = '<p class="hint" style="margin:0 0 6px">Riwayat pengajuan:</p>' + history.map((h) => `
      <div class="hint" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0">
        <span>${h.action === 'extend' ? 'Perpanjangan' : 'Pemutusan'} ${h.end_date ? '→ ' + h.end_date : ''}</span>
        <span class="status-badge ${statusBadge[h.status] || ''}">${h.status}</span>
      </div>
    `).join('');
  }

  function renderDocuments(docs) {
    if (!docs.length) {
      el.documentList.innerHTML = '<p class="hint">Belum ada dokumen diunggah.</p>';
      return;
    }
    el.documentList.innerHTML = docs.map((d) => `
      <div class="hint">
        <a href="${API}/documents/${d.id}/file" target="_blank" rel="noopener">${d.doc_type.toUpperCase()} — ${d.doc_name || 'tanpa nama'}</a>
        ${d.expiry_date ? ` (kedaluwarsa: ${d.expiry_date})` : ''}
      </div>
    `).join('');
  }

  // ---- form submit ----------------------------------------------------------
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(el.form).entries());
    const url = currentEmployeeId ? `${API}/employees/${currentEmployeeId}` : `${API}/employees`;
    const method = currentEmployeeId ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return toast(`Gagal menyimpan: ${err.message || res.status}`);
    }
    closeModal();
    loadEmployees();
    loadSummary();
    toast('Data karyawan disimpan.');
  });

  // ---- document upload --------------------------------------------------------
  document.getElementById('btnUploadDoc').addEventListener('click', async () => {
    if (!currentEmployeeId) return toast('Simpan data karyawan dulu sebelum unggah dokumen.');
    const fileInput = document.getElementById('docFile');
    if (!fileInput.files.length) return toast('Pilih file dulu.');

    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('doc_type', document.getElementById('docType').value);
    fd.append('doc_name', document.getElementById('docName').value);
    fd.append('expiry_date', document.getElementById('docExpiry').value);

    const res = await fetch(`${API}/employees/${currentEmployeeId}/documents`, { method: 'POST', body: fd });
    if (!res.ok) return toast('Gagal mengunggah dokumen.');

    const refreshed = await (await fetch(`${API}/employees/${currentEmployeeId}`)).json();
    renderDocuments(refreshed.documents || []);
    fileInput.value = '';
    toast('Dokumen diunggah.');
  });

  // ---- filters ------------------------------------------------------------------
  let debounceTimer;
  [el.search, el.type, el.status].forEach((input) => {
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadEmployees, 300);
    });
  });

  // ---- contract action: extend / terminate request --------------------------
  document.getElementById('btnSubmitContractAction').addEventListener('click', async () => {
    if (!currentEmployeeId) return;
    const action = document.getElementById('caAction').value;
    const contract_no = document.getElementById('caContractNo').value;
    const end_date = document.getElementById('caEndDate').value;
    const note = document.getElementById('caNote').value;

    if (action === 'extend' && !end_date) return toast('Isi tanggal berakhir baru untuk perpanjangan.');

    const res = await fetch(`${API}/employees/${currentEmployeeId}/contract-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, contract_no, end_date, note }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return toast(`Gagal mengajukan: ${err.message || res.status}`);
    }
    toast('Pengajuan dikirim, menunggu persetujuan.');
    document.getElementById('caNote').value = '';
    const refreshed = await (await fetch(`${API}/employees/${currentEmployeeId}`)).json();
    renderContractHistory(refreshed.contract_history || []);
    loadApprovalQueue();
  });

  // ---- approval queue (only rendered for hrd_kontrak:APPROVE roles) ----------
  async function loadApprovalQueue() {
    if (!can('APPROVE')) return;
    const panel = document.getElementById('approvalPanel');
    const list = document.getElementById('approvalRows');
    const res = await fetch(`${API}/contract-actions/pending`);
    if (!res.ok) return;
    const rows = await res.json();
    panel.style.display = rows.length ? 'block' : 'none';
    if (!rows.length) return;

    list.innerHTML = rows.map((r) => `
      <li class="action-pk action-pk--amber">
        <div class="action-pk__flag action-pk__flag--amber">!</div>
        <div class="action-pk__body">
          <p class="action-pk__title">${r.full_name} — ${r.action === 'extend' ? 'Perpanjangan' : 'Pemutusan'} Kontrak</p>
          <p class="action-pk__meta">${r.position || '-'} · ${r.end_date ? 'Baru berakhir: ' + r.end_date : ''} ${r.note ? '· ' + r.note : ''} · diajukan oleh ${r.requested_by}</p>
        </div>
        <button class="btn btn--gold" style="padding:5px 10px;font-size:11px" data-decide="${r.id}" data-decision="approved">Setujui</button>
        <button class="btn btn--ghost" style="padding:5px 10px;font-size:11px" data-decide="${r.id}" data-decision="rejected">Tolak</button>
      </li>
    `).join('');

    list.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const historyId = btn.getAttribute('data-decide');
        const decision = btn.getAttribute('data-decision');
        const res2 = await fetch(`${API}/contract-actions/${historyId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        if (!res2.ok) return toast('Gagal memproses keputusan.');
        toast(decision === 'approved' ? 'Pengajuan disetujui.' : 'Pengajuan ditolak.');
        loadApprovalQueue();
        loadEmployees();
        loadSummary();
      });
    });
  }

  // ---- permission-aware bootstrap ------------------------------------------------
  // page-shell.js already called /api/auth/me for the sidebar; this module
  // needs the SAME data to decide which buttons to show, so it fetches
  // /api/auth/me again (cheap, session-authenticated, no extra privilege).
  async function bootstrap() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        myActions.hrd_kontrak = (data.user.permissions || {}).hrd_kontrak || [];
      }
    } catch (err) {
      // page-shell.js already redirects to /login.html on auth failure;
      // nothing further to do here.
    }
    el.btnAdd.style.display = can('CREATE') ? '' : 'none';
    loadSummary();
    loadEmployees();
    loadApprovalQueue();
    updateTypeFields();
  }

  bootstrap();
})();
