// koreksi-absensi.js — Attendance A3 UI: correction & void requests, approval
// inbox, exception center, payroll impact, and the Audit & Activity Center.
// Reuses the existing app shell (page-shell.js) and the shared tab/modal
// conventions. Nothing here shows or computes a rupiah amount.
(function () {
  const API = '/api/attendance-correction';
  const TS = '/api/timesheet';
  const perms = {};
  const can = (mod, action) => Array.isArray(perms[mod]) && perms[mod].includes(action);
  let me = null;

  const REASONS = ['MISSED_CLOCK_IN', 'MISSED_CLOCK_OUT', 'DEVICE_FAILURE', 'WRONG_SHIFT', 'WRONG_WORK_DATE',
    'BREAK_CORRECTION', 'OT_DISCREPANCY', 'DUPLICATE_RECORD', 'SUPERVISOR_CORRECTION', 'DATA_ENTRY_ERROR', 'OTHER'];
  const IMPACT_BADGE = {
    NO_PAYROLL_IMPACT: 'status-badge--grey',
    PAYROLL_IMPACT_OPEN_PERIOD: 'status-badge--green',
    PAYROLL_IMPACT_FROZEN_PERIOD: 'status-badge--amber',
    PAYROLL_ADJUSTMENT_REQUIRED: 'status-badge--red',
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
  }
  async function api(method, path, body, base = API) {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
    return json;
  }

  document.querySelectorAll('.pcfg-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pcfg-tab').forEach((b) => b.classList.remove('is-active'));
      document.querySelectorAll('.pcfg-panel').forEach((p) => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      document.querySelector(`.pcfg-panel[data-panel="${btn.dataset.tab}"]`).classList.add('is-active');
      if (btn.dataset.tab === 'exceptions') loadExceptions();
      if (btn.dataset.tab === 'impact') loadImpact();   // no-op without the permission
      if (btn.dataset.tab === 'policy') loadPolicies();
      if (btn.dataset.tab === 'requests') loadRequests();
    });
  });

  // ---- modal ------------------------------------------------------------------
  const overlay = document.getElementById('modalOverlay');
  const form = document.getElementById('genericForm');
  const formBody = document.getElementById('genericFormBody');
  let onSubmit = null;
  const field = (label, html) => `<label class="form-field">${label}${html}</label>`;
  const select = (name, options, attrs = '') =>
    `<select name="${name}" ${attrs}>${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
  function openModal(title, html, handler) {
    document.getElementById('modalTitle').textContent = title;
    formBody.innerHTML = html; onSubmit = handler; overlay.hidden = false;
  }
  function closeModal() { overlay.hidden = true; onSubmit = null; }
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try { await onSubmit(data); closeModal(); } catch (err) { toast(`Gagal: ${err.message}`); }
  });

  // ---- request form -----------------------------------------------------------
  async function requestForm() {
    openModal('Ajukan Koreksi / Void', `
      ${field('Tanggal Kerja', '<input name="work_date" type="date" required>')}
      ${field('ID Karyawan', '<input name="employee_id" required placeholder="mis. EMP-001">')}
      <button type="button" class="btn btn--cyan" id="btnFindEntry">Cari Absensi</button>
      <div id="entryPreview" class="hint">Masukkan karyawan &amp; tanggal, lalu cari absensinya.</div>
      ${field('Jenis Permintaan', select('request_type', [
        { value: 'CORRECTION', label: 'KOREKSI — perbaiki nilai' },
        { value: 'VOID', label: 'VOID — batalkan catatan (data asli tetap tersimpan)' }]))}
      ${field('Kode Alasan', select('reason_code', REASONS.map((r) => ({ value: r, label: r }))))}
      ${field('Penjelasan', '<input name="reason_text" placeholder="Apa yang salah dan mengapa">')}
      <div style="display:flex;gap:8px">
        ${field('Jam Masuk (baru)', '<input name="clock_in" type="time">')}
        ${field('Jam Pulang (baru)', '<input name="clock_out" type="time">')}
        ${field('Tanggal Pulang', '<input name="clock_out_date" type="date">')}
      </div>
      ${field('Status Kehadiran (baru)', select('attendance_status', [{ value: '', label: '— tidak diubah —' },
        { value: 'present', label: 'Hadir' }, { value: 'late', label: 'Terlambat' }, { value: 'absent', label: 'Tidak Hadir' },
        { value: 'leave', label: 'Izin' }, { value: 'sick', label: 'Sakit' }, { value: 'no_show', label: 'Tidak di Lokasi' }]))}
      ${field('Alasan Terlambat Mengoreksi', '<input name="late_reason" placeholder="wajib bila melewati jendela koreksi">')}
      ${field('Bukti (referensi)', '<input name="evidence_ref" placeholder="mis. log gate / timesheet lapangan">')}
      ${field('Catatan Bukti', '<input name="evidence_note">')}
      <p class="hint">Nilai turunan (menit kerja, lembur) dihitung ulang oleh server dari jadwal yang tersimpan di baris absensi — tidak pernah diambil dari input ini.</p>
    `, async (data) => {
      const entryId = form.dataset.entryId;
      if (!entryId) throw new Error('Cari absensinya dulu.');
      const proposed = {};
      for (const f of ['clock_in', 'clock_out', 'clock_out_date', 'attendance_status']) {
        if (data[f]) proposed[f] = data[f];
      }
      const res = await api('POST', '/requests', {
        timesheet_entry_id: Number(entryId), request_type: data.request_type, reason_code: data.reason_code,
        reason_text: data.reason_text, late_reason: data.late_reason || null,
        evidence_ref: data.evidence_ref || null, evidence_note: data.evidence_note || null,
        proposed_values: data.request_type === 'VOID' ? {} : proposed, submit: true,
      });
      toast(`${res.request_no} dibuat — dampak payroll: ${res.payroll_impact}${res.is_late_correction ? ' (koreksi terlambat)' : ''}`);
      loadInbox(); loadRequests();
    });
    document.getElementById('btnFindEntry').addEventListener('click', async () => {
      const date = form.querySelector('[name=work_date]').value;
      const emp = form.querySelector('[name=employee_id]').value;
      if (!date || !emp) return toast('Isi tanggal dan ID karyawan.');
      try {
        const rows = await api('GET', `/entries?date=${date}`, undefined, TS);
        const hit = rows.find((r) => r.employee_id === emp);
        if (!hit) { document.getElementById('entryPreview').textContent = 'Tidak ada absensi untuk karyawan/tanggal ini.'; return; }
        form.dataset.entryId = hit.id;
        document.getElementById('entryPreview').innerHTML =
          `<strong>${esc(hit.full_name)}</strong> — ${esc(hit.work_date)} · ${esc(hit.schedule_code || 'tanpa jadwal')} · `
          + `aktual ${esc(hit.clock_in || '-')}–${esc(hit.clock_out || '-')} · ${hit.work_minutes ?? '-'} menit · ${esc(hit.attendance_status)}`;
      } catch (err) { toast(`Gagal: ${err.message}`); }
    });
  }

  // ---- inbox / requests --------------------------------------------------------
  function statusBadge(s) {
    const red = ['REJECTED', 'VOID_REJECTED', 'PAYROLL_REJECTED', 'CANCELLED'];
    const green = ['APPLIED', 'VOIDED', 'QUEUED_FOR_PAYROLL'];
    const amber = ['PENDING_PAYROLL_REVIEW', 'SUBMITTED', 'UNDER_REVIEW', 'VOID_REQUESTED', 'VOID_REVIEWED', 'DRAFT'];
    const cls = red.includes(s) ? 'status-badge--red' : green.includes(s) ? 'status-badge--green'
      : amber.includes(s) ? 'status-badge--amber' : 'status-badge--grey';
    return `<span class="status-badge ${cls}">${esc(s)}</span>`;
  }
  function actionsFor(r) {
    const out = [];
    const isVoid = r.request_type === 'VOID';
    const mine = r.requested_by_user_id === (me && me.id);
    const canDecide = isVoid ? can('attendance_void', 'APPROVE') : can('attendance_correction', 'APPROVE');
    if (['SUBMITTED', 'VOID_REQUESTED'].includes(r.status) && can('attendance_correction', 'EDIT')) {
      out.push(`<a href="#" data-act="review" data-id="${r.id}">Review</a>`);
    }
    if (!mine && canDecide && ['SUBMITTED', 'UNDER_REVIEW', 'VOID_REQUESTED', 'VOID_REVIEWED'].includes(r.status)) {
      out.push(`<a href="#" data-act="approve" data-id="${r.id}">Setujui</a>`);
      out.push(`<a href="#" data-act="reject" data-id="${r.id}">Tolak</a>`);
    }
    if (r.status === 'PENDING_PAYROLL_REVIEW' && can('attendance_payroll_impact', 'APPROVE') && !mine) {
      out.push(`<a href="#" data-act="payroll-approve" data-id="${r.id}">Setujui Dampak Payroll</a>`);
      out.push(`<a href="#" data-act="payroll-reject" data-id="${r.id}">Tolak</a>`);
    }
    if (mine && ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'VOID_REQUESTED', 'VOID_REVIEWED'].includes(r.status)) {
      out.push(`<a href="#" data-act="cancel" data-id="${r.id}">Batalkan</a>`);
    }
    out.push(`<a href="#" data-act="detail" data-id="${r.id}">Rincian</a>`);
    return out.join(' · ');
  }
  function bindActions(scope) {
    scope.querySelectorAll('[data-act]').forEach((a) => a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = a.dataset.id;
      try {
        if (a.dataset.act === 'review') await api('POST', `/requests/${id}/review`, {});
        else if (a.dataset.act === 'approve') await api('POST', `/requests/${id}/decide`, { decision: 'approved' });
        else if (a.dataset.act === 'reject') await api('POST', `/requests/${id}/decide`, { decision: 'rejected', reason: 'Ditolak dari inbox' });
        else if (a.dataset.act === 'payroll-approve') await api('POST', `/requests/${id}/payroll-review`, { decision: 'approved' });
        else if (a.dataset.act === 'payroll-reject') await api('POST', `/requests/${id}/payroll-review`, { decision: 'rejected' });
        else if (a.dataset.act === 'cancel') await api('POST', `/requests/${id}/cancel`, { reason: 'Dibatalkan pengaju' });
        else if (a.dataset.act === 'detail') return showDetail(id);
        toast('Tersimpan.');
        loadInbox(); loadRequests(); loadImpact();
      } catch (err) { toast(`Gagal: ${err.message}`); }
    }));
  }

  async function showDetail(id) {
    const r = await api('GET', `/requests/${id}`);
    const d = r.delta_values || {};
    const wrap = document.getElementById('requestDetail');
    wrap.style.display = 'block';
    wrap.innerHTML = `
      <p class="hint">Rincian <strong style="color:var(--white)">${esc(r.request_no)}</strong> — ${esc(r.request_type)}</p>
      <div class="table-scroll"><table class="hrd-table"><tbody>
        <tr><td>Karyawan</td><td>${esc(r.employee_id)} · ${esc(r.work_date)}</td></tr>
        <tr><td>Alasan</td><td>${esc(r.reason_code)} — ${esc(r.reason_text || '')}</td></tr>
        <tr><td>Koreksi terlambat</td><td>${r.is_late_correction ? `Ya — ${esc(r.late_reason || '')}` : 'Tidak'}</td></tr>
        <tr><td>Dampak payroll</td><td>${esc(r.payroll_impact || '-')}</td></tr>
        <tr><td>Selisih waktu</td><td>Kerja ${d.delta_work_minutes ?? 0} mnt · Lembur ${d.delta_overtime_minutes ?? 0} mnt</td></tr>
        <tr><td>Bukti</td><td>${esc(r.evidence_ref || r.evidence_note || '—')}</td></tr>
      </tbody></table></div>
      <p class="hint" style="margin-top:12px">Riwayat persetujuan</p>
      <div class="table-scroll"><table class="hrd-table">
        <thead><tr><th>Waktu</th><th>Aksi</th><th>Aktor</th><th>Peran (saat itu)</th><th>Izin</th><th>Status</th></tr></thead>
        <tbody>${r.approval_history.map((a) => `<tr><td>${esc(a.occurred_at)}</td><td>${esc(a.action)}</td>
          <td>${esc(a.actor_name || '')}</td><td>${esc(a.actor_role || '')}</td><td>${esc(a.permission_used || '')}</td>
          <td>${esc(a.to_status || a.result || '')}</td></tr>`).join('')}</tbody>
      </table></div>`;
    document.querySelector('.pcfg-tab[data-tab=requests]').click();
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderRows(rows, tbody, cols) {
    const el = document.getElementById(tbody);
    el.innerHTML = rows.length ? rows.map(cols).join('')
      : `<tr><td colspan="10" style="text-align:center;color:var(--grey-500);padding:16px">Tidak ada data.</td></tr>`;
    bindActions(el);
  }

  async function loadInbox() {
    try {
      const rows = await api('GET', '/requests?inbox=1');
      renderRows(rows, 'inboxRows', (r) => `<tr>
        <td><strong>${esc(r.request_no)}</strong></td><td>${esc(r.request_type)}</td>
        <td>${esc(r.full_name)}</td><td>${esc(r.work_date)}</td><td>${esc(r.reason_code)}</td>
        <td>${r.is_late_correction ? '<span class="status-badge status-badge--amber">TERLAMBAT</span>' : '—'}</td>
        <td><span class="status-badge ${IMPACT_BADGE[r.payroll_impact] || 'status-badge--grey'}">${esc(r.payroll_impact || '-')}</span></td>
        <td>${statusBadge(r.status)}</td><td>${r.age_days} hari</td><td>${actionsFor(r)}</td></tr>`);
    } catch (err) { toast(`Gagal memuat inbox: ${err.message}`); }
  }

  async function loadRequests() {
    try {
      const status = document.getElementById('reqStatus').value;
      const rows = await api('GET', `/requests${status ? `?status=${status}` : ''}`);
      renderRows(rows, 'requestRows', (r) => `<tr>
        <td><strong>${esc(r.request_no)}</strong></td><td>${esc(r.request_type)}</td><td>${esc(r.full_name)}</td>
        <td>${esc(r.work_date)}</td><td>${esc(r.reason_code)}</td>
        <td>${esc(r.requested_by_name || '')}<br><span class="hint">${esc(r.requested_by_role || '')}</span></td>
        <td>${esc(r.decided_by_name || '—')}<br><span class="hint">${esc(r.decided_by_role || '')}</span></td>
        <td><span class="status-badge ${IMPACT_BADGE[r.payroll_impact] || 'status-badge--grey'}">${esc(r.payroll_impact || '-')}</span></td>
        <td>${statusBadge(r.status)}</td><td>${actionsFor(r)}</td></tr>`);
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  // ---- exceptions --------------------------------------------------------------
  async function loadExceptions() {
    if (!can('attendance_exception', 'VIEW')) return;
    try {
      const rows = await api('GET', '/exceptions?status=OPEN');
      const assigned = await api('GET', '/exceptions?status=ASSIGNED');
      const all = rows.concat(assigned);
      renderRows(all, 'exceptionRows', (x) => `<tr>
        <td>${esc(x.full_name || x.employee_id)}</td><td>${esc(x.work_date)}</td><td>${esc(x.exception_type)}</td>
        <td><span class="status-badge ${x.severity === 'HIGH' ? 'status-badge--red' : x.severity === 'LOW' ? 'status-badge--grey' : 'status-badge--amber'}">${esc(x.severity)}</span></td>
        <td>${statusBadge(x.status)}</td><td>${x.age_days} hari</td><td>${esc(x.assigned_to_name || '—')}</td>
        <td>${can('attendance_exception', 'EDIT') ? `<a href="#" data-exc="${x.id}">Selesaikan</a>` : ''}</td></tr>`);
      document.querySelectorAll('[data-exc]').forEach((a) => a.addEventListener('click', async (e) => {
        e.preventDefault();
        const note = window.prompt('Catatan penyelesaian (wajib):');
        if (!note) return;
        try { await api('POST', `/exceptions/${a.dataset.exc}/resolve`, { note }); toast('Exception diselesaikan.'); loadExceptions(); }
        catch (err) { toast(`Gagal: ${err.message}`); }
      }));
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  // ---- payroll impact ----------------------------------------------------------
  async function loadImpact() {
    if (!can('attendance_payroll_impact', 'VIEW')) return;
    try {
      const rows = await api('GET', '/payroll-impact');
      renderRows(rows, 'impactRows', (r) => {
        const d = r.delta_values ? JSON.parse(r.delta_values) : {};
        return `<tr><td><strong>${esc(r.request_no)}</strong></td><td>${esc(r.full_name)}</td><td>${esc(r.work_date)}</td>
          <td><span class="status-badge ${IMPACT_BADGE[r.payroll_impact] || 'status-badge--grey'}">${esc(r.payroll_impact)}</span></td>
          <td>${d.delta_work_minutes ?? 0}</td><td>${d.delta_overtime_minutes ?? 0}</td>
          <td>${statusBadge(r.status)}</td><td>${actionsFor(r)}</td></tr>`;
      });
      const queue = await api('GET', '/payroll-queue');
      document.getElementById('queueRows').innerHTML = queue.length ? queue.map((q) => `<tr>
        <td>${esc(q.request_no)}</td><td>${esc(q.full_name)}</td><td>${esc(q.work_date)}</td>
        <td>${esc(q.source_period_id || '—')}</td><td>${q.delta_work_minutes}</td><td>${q.delta_overtime_minutes}</td>
        <td>${esc(q.payroll_review_status)}</td><td>${esc(q.queue_status)}</td></tr>`).join('')
        : '<tr><td colspan="8" style="text-align:center;color:var(--grey-500);padding:16px">Antrian kosong.</td></tr>';
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  // ---- audit -------------------------------------------------------------------
  async function loadAudit() {
    if (!can('attendance_audit', 'VIEW')) return;
    const q = new URLSearchParams();
    const from = document.getElementById('auditFrom').value;
    const to = document.getElementById('auditTo').value;
    const actor = document.getElementById('auditActor').value;
    const event = document.getElementById('auditEvent').value;
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (actor) q.set('actor_user_id', actor);
    if (event) q.set('event_type', event);
    try {
      const rows = await api('GET', `/audit?${q.toString()}`);
      const el = document.getElementById('auditRows');
      el.innerHTML = rows.length ? rows.map((r) => `<tr>
        <td>${esc(r.occurred_at)}</td><td>${esc(r.actor_name || '—')}</td>
        <td>${esc(r.actor_role_snapshot || '—')}</td><td>${esc(r.event_type)}</td>
        <td>${esc(r.employee_id)}</td><td>${esc(r.work_date)}</td>
        <td>${esc(r.permission_used || '—')}</td><td>${esc(r.result || '—')}</td>
        <td><a href="#" data-audit="${r.id}">Lihat</a></td></tr>`).join('')
        : '<tr><td colspan="9" style="text-align:center;color:var(--grey-500);padding:16px">Tidak ada aktivitas.</td></tr>';
      el.querySelectorAll('[data-audit]').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        const r = rows.find((x) => String(x.id) === a.dataset.audit);
        const w = document.getElementById('auditDetail');
        w.style.display = 'block';
        w.innerHTML = `<div class="table-scroll"><table class="hrd-table"><tbody>
          <tr><td>Siapa</td><td>${esc(r.actor_name || '')} (user #${esc(r.actor_user_id || '')})</td></tr>
          <tr><td>Peran saat itu</td><td>${esc(r.actor_role_snapshot || '')}</td></tr>
          <tr><td>Aksi</td><td>${esc(r.event_type)} · izin ${esc(r.permission_used || '—')}</td></tr>
          <tr><td>Kapan</td><td>${esc(r.occurred_at)}</td></tr>
          <tr><td>Mengapa</td><td>${esc(r.reason_code || '')} ${esc(r.reason || '')}</td></tr>
          <tr><td>Sebelum</td><td><pre style="white-space:pre-wrap">${esc(JSON.stringify(r.old_values || {}, null, 1))}</pre></td></tr>
          <tr><td>Sesudah</td><td><pre style="white-space:pre-wrap">${esc(JSON.stringify(r.new_values || {}, null, 1))}</pre></td></tr>
          <tr><td>Selisih</td><td>${esc(JSON.stringify(r.delta_values || {}))}</td></tr>
          <tr><td>Hasil / langkah berikutnya</td><td>${esc(r.result || '—')}</td></tr>
        </tbody></table></div>`;
      }));
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  // ---- policy ------------------------------------------------------------------
  async function loadPolicies() {
    if (!can('attendance_correction', 'VIEW')) return;
    try {
      const rows = await api('GET', '/policies');
      const el = document.getElementById('policyRows');
      el.innerHTML = rows.length ? rows.map((p) => `<tr>
        <td><strong>${esc(p.code)}</strong></td><td>${esc(p.legal_entity_id || 'GLOBAL')}</td>
        <td>${p.correction_window} ${esc(p.window_unit)}</td>
        <td>${p.allow_late_correction ? 'Diizinkan' : 'Tidak'}</td>
        <td>${p.late_requires_approval ? 'Ya' : 'Tidak'}</td>
        <td>${esc(p.evidence_requirement)}${p.post_finalized_evidence_required ? ' (wajib pasca-final)' : ''}</td>
        <td>${p.abnormal_duration_ratio_pct}%</td><td>${p.ot_grace_minutes} mnt</td>
        <td>${esc(p.effective_from)} → ${esc(p.effective_to || 'terbuka')}</td>
        <td>${can('attendance_correction', 'EDIT') ? `<a href="#" data-pol="${p.id}">Versi Baru</a>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="10" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada kebijakan.</td></tr>';
      el.querySelectorAll('[data-pol]').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault(); policyForm(rows.find((p) => String(p.id) === a.dataset.pol));
      }));
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  function policyForm(existing) {
    const p = existing || {};
    openModal(existing ? `Versi Baru — ${p.code}` : 'Kebijakan Koreksi Baru', `
      ${field('Kode', `<input name="code" value="${esc(p.code || '')}" ${existing ? 'readonly' : 'required'}>`)}
      ${field('Nama', `<input name="name" value="${esc(p.name || '')}" required>`)}
      ${existing ? '' : field('Legal Entity', `<input name="legal_entity_id" required placeholder="mis. KAHE360">`)}
      <div style="display:flex;gap:8px">
        ${field('Jendela Koreksi', `<input name="correction_window" type="number" min="0" value="${esc(p.correction_window ?? 3)}" required>`)}
        ${field('Satuan', select('window_unit', [{ value: 'DAYS', label: 'Hari' }, { value: 'WEEKS', label: 'Minggu' }, { value: 'MONTHS', label: 'Bulan' }]))}
      </div>
      ${field('Koreksi Terlambat', select('allow_late_correction', [{ value: '1', label: 'Diizinkan' }, { value: '0', label: 'Tidak diizinkan' }]))}
      ${field('Koreksi Terlambat Butuh Approval Khusus', select('late_requires_approval', [{ value: '1', label: 'Ya' }, { value: '0', label: 'Tidak' }]))}
      ${field('Bukti', select('evidence_requirement', [{ value: 'OPTIONAL', label: 'Opsional' }, { value: 'REQUIRED', label: 'Wajib' }, { value: 'NONE', label: 'Tidak perlu' }]))}
      ${field('Bukti Wajib Setelah Payroll Final', select('post_finalized_evidence_required', [{ value: '1', label: 'Ya' }, { value: '0', label: 'Tidak' }]))}
      <div style="display:flex;gap:8px">
        ${field('Ambang Durasi Abnormal (%)', `<input name="abnormal_duration_ratio_pct" type="number" min="100" value="${esc(p.abnormal_duration_ratio_pct ?? 150)}">`)}
        ${field('Grace OT (menit)', `<input name="ot_grace_minutes" type="number" min="0" value="${esc(p.ot_grace_minutes ?? 30)}">`)}
        ${field('Toleransi Selisih OT (menit)', `<input name="ot_mismatch_tolerance_minutes" type="number" min="0" value="${esc(p.ot_mismatch_tolerance_minutes ?? 15)}">`)}
      </div>
      ${field('Berlaku Sejak', '<input name="effective_from" type="date" required>')}
    `, async (data) => {
      const payload = {
        ...data,
        correction_window: Number(data.correction_window),
        allow_late_correction: data.allow_late_correction === '1',
        late_requires_approval: data.late_requires_approval === '1',
        post_finalized_evidence_required: data.post_finalized_evidence_required === '1',
        abnormal_duration_ratio_pct: Number(data.abnormal_duration_ratio_pct),
        ot_grace_minutes: Number(data.ot_grace_minutes),
        ot_mismatch_tolerance_minutes: Number(data.ot_mismatch_tolerance_minutes),
      };
      if (existing) await api('POST', `/policies/${p.id}/versions`, payload);
      else await api('POST', '/policies', payload);
      toast('Kebijakan tersimpan.'); loadPolicies();
    });
  }

  // ---- bootstrap ---------------------------------------------------------------
  async function bootstrap() {
    try {
      const res = await (await fetch('/api/auth/me')).json();
      me = res.user;
      Object.assign(perms, res.user.permissions || {});
    } catch (err) { /* page-shell handles auth redirect */ }

    const today = new Date().toISOString().slice(0, 10);
    ['excTo', 'auditTo'].forEach((id) => { document.getElementById(id).value = today; });
    ['excFrom', 'auditFrom'].forEach((id) => {
      const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      document.getElementById(id).value = d;
    });
    const tabPerm = {
      exceptions: ['attendance_exception', 'VIEW'],
      impact: ['attendance_payroll_impact', 'VIEW'],
      audit: ['attendance_audit', 'VIEW'],
    };
    Object.entries(tabPerm).forEach(([tab, [mod, act]]) => {
      if (!can(mod, act)) {
        const el = document.querySelector(`.pcfg-tab[data-tab="${tab}"]`);
        if (el) el.style.display = 'none';
      }
    });

    const newBtn = document.getElementById('btnNewRequest');
    if (!can('attendance_correction', 'CREATE') && !can('attendance_void', 'CREATE')) newBtn.style.display = 'none';
    newBtn.addEventListener('click', requestForm);
    const polBtn = document.getElementById('btnNewPolicy');
    if (!can('attendance_correction', 'EDIT')) polBtn.style.display = 'none';
    polBtn.addEventListener('click', () => policyForm(null));
    const scanBtn = document.getElementById('btnScan');
    if (!can('attendance_exception', 'EDIT')) scanBtn.style.display = 'none';
    scanBtn.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/exceptions/scan', {
          from: document.getElementById('excFrom').value, to: document.getElementById('excTo').value,
        });
        toast(`${r.scanned} baris dipindai — ${r.exceptions} exception.`);
        loadExceptions();
      } catch (err) { toast(`Gagal: ${err.message}`); }
    });
    document.getElementById('btnAudit').addEventListener('click', loadAudit);
    document.getElementById('reqStatus').addEventListener('change', loadRequests);

    if (me) {
      const sel = document.getElementById('auditActor');
      sel.innerHTML = `<option value="">Semua aktor</option><option value="${me.id}">${esc(me.displayName || me.display_name || 'Saya')} (saya)</option>`;
    }
    await loadInbox();
  }

  bootstrap();
})();
