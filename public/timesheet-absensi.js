// timesheet-absensi.js — KAHE 360 Internal Operations Portal
(function () {
  const API = '/api/timesheet';
  const DAY_TYPE_LABELS = {
    WORKDAY: 'Hari Kerja', WEEKLY_REST_DAY: 'Hari Istirahat', PUBLIC_HOLIDAY: 'Libur Nasional',
    COMPANY_HOLIDAY: 'Libur Perusahaan', SUBSTITUTED_HOLIDAY: 'Cuti Bersama',
  };
  const STATUS_LABELS = {
    present: 'Hadir', late: 'Terlambat', absent: 'Absen Tanpa Keterangan',
    leave: 'Izin', sick: 'Sakit', no_show: 'Tidak di Lokasi',
  };
  const STATUS_BADGE = {
    present: 'status-badge--green', late: 'status-badge--amber',
    absent: 'status-badge--red', no_show: 'status-badge--red',
    leave: 'status-badge--blue', sick: 'status-badge--blue',
  };

  // Phase 0B / N1: minutes are canonical; these format for display only.
  function fmtMinutes(min) {
    if (min === null || min === undefined) return '-';
    const t = Math.abs(Number(min)); const h = Math.trunc(t / 60); const m = t % 60;
    if (m === 0) return `${h} jam`;
    if (h === 0) return `${m} mnt`;
    return `${h} jam ${m} mnt`;
  }

  const el = {
    kpiPresent: document.getElementById('kpiPresent'),
    kpiPresentSub: document.getElementById('kpiPresentSub'),
    kpiNotRecorded: document.getElementById('kpiNotRecorded'),
    kpiOvertimeCount: document.getElementById('kpiOvertimeCount'),
    kpiOvertimeSub: document.getElementById('kpiOvertimeSub'),
    kpiPendingOT: document.getElementById('kpiPendingOT'),
    kpiPayrollReady: document.getElementById('kpiPayrollReady'),
    rows: document.getElementById('entryRows'),
    fDate: document.getElementById('fDate'),
    fWorkfront: document.getElementById('fWorkfront'),
    fShift: document.getElementById('fShift'),
    fSearch: document.getElementById('fSearch'),
    btnAdd: document.getElementById('btnAdd'),
    overlay: document.getElementById('modalOverlay'),
    form: document.getElementById('entryForm'),
    modalTitle: document.getElementById('modalTitle'),
    fEmployee: document.getElementById('fEmployee'),
    fWorkfrontModal: document.getElementById('fWorkfrontModal'),
    fStatus: document.getElementById('fStatus'),
    overtimeBox: document.getElementById('overtimeBox'),
    overtimeStatusLine: document.getElementById('overtimeStatusLine'),
  };

  let currentEntryId = null;
  let myActions = { timesheet_absensi: [] };

  function can(action) {
    return Array.isArray(myActions.timesheet_absensi) && myActions.timesheet_absensi.includes(action);
  }

  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  el.fDate.value = todayStr();

  // ---- reference data: workfronts + active employees -------------------------
  async function loadWorkfronts() {
    const res = await fetch(`${API}/workfronts`);
    if (!res.ok) return;
    const list = await res.json();
    [el.fWorkfront, el.fWorkfrontModal].forEach((select) => {
      list.forEach((w) => {
        const opt = document.createElement('option');
        opt.value = w; opt.textContent = w;
        select.appendChild(opt.cloneNode(true));
      });
    });
  }

  async function loadEmployeeOptions() {
    const res = await fetch('/api/hrd/employees?status=active');
    if (!res.ok) return;
    const list = await res.json();
    el.fEmployee.innerHTML = '<option value="">Pilih karyawan</option>' + list.map(
      (e) => `<option value="${e.id}">${e.full_name} (${e.id})</option>`
    ).join('');
  }

  // ---- KPI summary -------------------------------------------------------------
  async function loadSummary() {
    const res = await fetch(`${API}/entries/summary?date=${el.fDate.value}`);
    if (!res.ok) return;
    const d = await res.json();
    el.kpiPresent.textContent = d.present;
    el.kpiPresentSub.textContent = `dari ${d.totalActive} aktif`;
    el.kpiNotRecorded.textContent = d.notRecorded;
    el.kpiOvertimeCount.textContent = d.overtimeCount;
    el.kpiOvertimeSub.textContent = `${d.overtimeApprovedMinutes ? fmtMinutes(d.overtimeApprovedMinutes) : '0 jam'} disetujui`;
    el.kpiPendingOT.textContent = d.pendingOvertime;
    el.kpiPayrollReady.textContent = `${d.payrollReadyPct}%`;
  }

  // ---- overtime approval queue ---------------------------------------------------
  async function loadOvertimeQueue() {
    if (!can('APPROVE')) return;
    const panel = document.getElementById('overtimePanel');
    const list = document.getElementById('overtimeRows');
    const res = await fetch(`${API}/overtime/pending`);
    if (!res.ok) return;
    const rows = await res.json();
    panel.style.display = rows.length ? 'block' : 'none';
    if (!rows.length) return;

    list.innerHTML = rows.map((r) => `
      <li class="action-pk action-pk--amber">
        <div class="action-pk__flag action-pk__flag--amber">!</div>
        <div class="action-pk__body">
          <p class="action-pk__title">${r.full_name} — ${fmtMinutes(r.overtime_minutes_requested)} lembur</p>
          <p class="action-pk__meta">${r.work_date} · ${r.workfront || '-'} · diajukan oleh ${r.overtime_requested_by}</p>
        </div>
        ${r.is_own_request ? '<p class="hint">Pengajuan Anda — perlu penyetuju lain</p>' : `
        <button class="btn btn--gold" style="padding:5px 10px;font-size:11px" data-decide="${r.id}" data-decision="approved">Setujui</button>
        <button class="btn btn--ghost" style="padding:5px 10px;font-size:11px" data-decide="${r.id}" data-decision="rejected">Tolak</button>`}
      </li>
    `).join('');

    list.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res2 = await fetch(`${API}/entries/${btn.getAttribute('data-decide')}/overtime-decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: btn.getAttribute('data-decision') }),
        });
        if (!res2.ok) {
          const err = await res2.json().catch(() => ({}));
          return toast(`Gagal memproses keputusan: ${err.message || res2.status}`);
        }
        toast(btn.getAttribute('data-decision') === 'approved' ? 'Lembur disetujui.' : 'Lembur ditolak.');
        loadOvertimeQueue();
        loadEntries();
        loadSummary();
      });
    });
  }

  // ---- table ------------------------------------------------------------------
  async function loadEntries() {
    const params = new URLSearchParams({ date: el.fDate.value });
    if (el.fWorkfront.value) params.set('workfront', el.fWorkfront.value);
    if (el.fShift.value) params.set('shift', el.fShift.value);
    if (el.fSearch.value) params.set('search', el.fSearch.value);

    el.rows.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--grey-500);padding:20px">Memuat data…</td></tr>`;
    const res = await fetch(`${API}/entries?${params.toString()}`);
    if (!res.ok) {
      el.rows.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--red-500);padding:20px">Gagal memuat data.</td></tr>`;
      return;
    }
    const rows = await res.json();
    if (!rows.length) {
      el.rows.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--grey-500);padding:20px">Belum ada absensi tercatat untuk tanggal ini.</td></tr>`;
      return;
    }
    el.rows.innerHTML = rows.map((r) => {
      const ot = r.overtime_status === 'pending'
        ? `<span class="status-badge status-badge--amber">${fmtMinutes(r.overtime_minutes_requested)} (pending)</span>`
        : r.overtime_status === 'approved'
          ? `<span class="status-badge status-badge--green">${fmtMinutes(r.overtime_minutes_approved)}</span>`
          : r.overtime_status === 'rejected'
            ? `<span class="status-badge status-badge--red">ditolak</span>`
            : '-';
      // A2: what was EXPECTED (resolved schedule, snapshotted on the row) shown
      // next to what actually happened.
      const dayBadge = r.day_status === 'OFF'
        ? '<span class="status-badge status-badge--grey">OFF</span>' : '';
      const sched = r.schedule_code
        ? `${r.schedule_code}${r.schedule_cross_midnight ? ' 🌙' : ''} ${dayBadge}`
        : (r.shift ? (r.shift === 'day' ? 'Day' : 'Night') : '-');
      const schedTimes = r.scheduled_clock_in
        ? `${r.scheduled_clock_in}–${r.scheduled_clock_out}${r.overtime_eligible_from && r.overtime_eligible_from !== r.scheduled_clock_out ? ` <span class="hint">(OT ${r.overtime_eligible_from})</span>` : ''}`
        : '-';
      const actualOut = r.clock_out
        ? `${r.clock_out}${r.clock_out_date && r.clock_out_date !== r.work_date ? ' +1' : ''}` : '-';
      return `
      <tr>
        <td>${r.full_name}</td>
        <td>${r.workfront || '-'}</td>
        <td>${sched}</td>
        <td>${schedTimes}</td>
        <td>${DAY_TYPE_LABELS[r.day_type] || r.day_type || '-'}</td>
        <td>${r.clock_in || '-'}</td>
        <td>${actualOut}</td>
        <td>${fmtMinutes(r.work_minutes)}</td>
        <td>${r.scheduled_minutes ? fmtMinutes(r.scheduled_minutes) : '-'}</td>
        <td>${ot}</td>
        <td><span class="status-badge ${STATUS_BADGE[r.attendance_status] || ''}">${STATUS_LABELS[r.attendance_status] || r.attendance_status}</span></td>
        <td>${can('EDIT') ? `<button class="hrd-table__link" data-open="${r.id}">Edit</button>` : ''}</td>
      </tr>
    `;
    }).join('');

    el.rows.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openEdit(btn.getAttribute('data-open')));
    });
  }

  // ---- modal --------------------------------------------------------------------
  function updateClockFieldsVisibility() {
    const status = el.fStatus.value;
    document.getElementById('clockFields').style.display = (status === 'present' || status === 'late') ? 'flex' : 'none';
  }
  el.fStatus.addEventListener('change', updateClockFieldsVisibility);

  function openModal() { el.overlay.hidden = false; }
  function closeModal() {
    el.overlay.hidden = true;
    el.form.reset();
    el.fDate ? null : null;
    currentEntryId = null;
    el.overtimeBox.style.display = 'none';
    el.overtimeStatusLine.innerHTML = '';
    updateClockFieldsVisibility();
  }

  el.btnAdd.addEventListener('click', () => {
    el.modalTitle.textContent = 'Catat Absensi';
    document.getElementById('fWorkDate').value = el.fDate.value;
    document.getElementById('fId').value = '';
    el.fEmployee.disabled = false;
    openModal();
  });
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  el.overlay.addEventListener('click', (e) => { if (e.target === el.overlay) closeModal(); });

  async function openEdit(id) {
    const res = await fetch(`${API}/entries?date=${el.fDate.value}`);
    const rows = res.ok ? await res.json() : [];
    const data = rows.find((r) => String(r.id) === String(id));
    if (!data) return toast('Data tidak ditemukan.');

    currentEntryId = id;
    el.modalTitle.textContent = `Edit Absensi: ${data.full_name}`;
    document.getElementById('fId').value = id;
    el.fEmployee.innerHTML = `<option value="${data.employee_id}">${data.full_name} (${data.employee_id})</option>`;
    el.fEmployee.disabled = true;
    document.getElementById('fWorkDate').value = data.work_date;

    Object.entries(data).forEach(([key, value]) => {
      const field = el.form.elements[key];
      if (field && value !== null && value !== undefined) field.value = value;
    });
    updateClockFieldsVisibility();

    const readOnly = !can('EDIT');
    Array.from(el.form.elements).forEach((f) => { if (f.tagName !== 'BUTTON' && f !== el.fEmployee) f.disabled = readOnly; });
    document.querySelector('.modal__footer button[type="submit"]').style.display = readOnly ? 'none' : '';

    el.overtimeBox.style.display = can('EDIT') ? 'block' : 'none';
    if (data.overtime_status && data.overtime_status !== 'none') {
      const map = { pending: 'Menunggu persetujuan', approved: 'Disetujui', rejected: 'Ditolak' };
      el.overtimeStatusLine.innerHTML = `<p class="hint">Status lembur: <strong>${map[data.overtime_status]}</strong> (${fmtMinutes(data.overtime_minutes_requested)} diajukan)</p>`;
    }

    openModal();
  }

  // ---- form submit --------------------------------------------------------------
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(el.form).entries());
    const url = currentEntryId ? `${API}/entries/${currentEntryId}` : `${API}/entries`;
    const method = currentEntryId ? 'PUT' : 'POST';

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
    loadEntries();
    loadSummary();
    toast('Absensi disimpan.');
  });

  // ---- overtime request (from within the modal) ----------------------------------
  document.getElementById('btnSubmitOvertime').addEventListener('click', async () => {
    if (!currentEntryId) return toast('Simpan absensi dulu sebelum mengajukan lembur.');
    const hours = document.getElementById('otHours').value;
    if (!hours || Number(hours) <= 0) return toast('Isi jumlah jam lembur.');

    const res = await fetch(`${API}/entries/${currentEntryId}/overtime-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return toast(`Gagal mengajukan: ${err.message || res.status}`);
    }
    toast('Pengajuan lembur dikirim.');
    el.overtimeStatusLine.innerHTML = '<p class="hint">Status lembur: <strong>Menunggu persetujuan</strong></p>';
    loadOvertimeQueue();
    loadEntries();
    loadSummary();
  });

  // ---- filters ------------------------------------------------------------------
  let debounceTimer;
  [el.fWorkfront, el.fShift].forEach((elm) => elm.addEventListener('change', loadEntries));
  el.fDate.addEventListener('change', () => { loadEntries(); loadSummary(); });
  el.fSearch.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadEntries, 300);
  });

  // ---- bootstrap ------------------------------------------------------------------
  async function bootstrap() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        myActions.timesheet_absensi = (data.user.permissions || {}).timesheet_absensi || [];
      }
    } catch (err) { /* page-shell.js already handles auth redirect */ }

    el.btnAdd.style.display = can('CREATE') ? '' : 'none';
    await loadWorkfronts();
    await loadEmployeeOptions();
    loadSummary();
    loadEntries();
    loadOvertimeQueue();
    updateClockFieldsVisibility();
  }

  bootstrap();
})();
