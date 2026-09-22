// jadwal-kerja.js — Attendance A2 configuration UI (schedules, patterns,
// roster dates, date overrides, employee assignment, resolution check).
// Uses the existing app shell (page-shell.js) and the shared tab/modal
// conventions from payroll-config.js. Nothing here computes money.
(function () {
  const API = '/api/work-schedule';
  const WEEKDAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const myActions = { attendance_config: [] };
  const can = (a) => myActions.attendance_config.includes(a);

  let schedules = [], patterns = [], employees = [], entities = [];

  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
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
    });
  });

  // ---- generic modal ----------------------------------------------------------
  const overlay = document.getElementById('modalOverlay');
  const form = document.getElementById('genericForm');
  const formBody = document.getElementById('genericFormBody');
  let onSubmit = null;

  function field(label, html) {
    return `<label class="form-field">${label}${html}</label>`;
  }
  function input(name, type = 'text', attrs = '') { return `<input name="${name}" type="${type}" ${attrs}>`; }
  function select(name, options, attrs = '') {
    return `<select name="${name}" ${attrs}>${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
  }
  const scheduleOptions = (allowEmpty = true) => (allowEmpty ? [{ value: '', label: '— tanpa shift —' }] : [])
    .concat(schedules.map((s) => ({ value: s.id, label: `${s.code} (${s.clock_in}–${s.clock_out})` })));

  function openModal(title, html, handler) {
    document.getElementById('modalTitle').textContent = title;
    formBody.innerHTML = html;
    onSubmit = handler;
    overlay.hidden = false;
  }
  function closeModal() { overlay.hidden = true; onSubmit = null; }
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try { await onSubmit(data, form); closeModal(); }
    catch (err) { toast(`Gagal: ${err.message}`); }
  });

  // ---- SCHEDULES ---------------------------------------------------------------
  async function loadSchedules() {
    schedules = await api('GET', '/schedules');
    const tb = document.getElementById('scheduleRows');
    tb.innerHTML = schedules.length ? schedules.map((s) => `
      <tr>
        <td><strong>${esc(s.code)}</strong></td><td>${esc(s.name)}</td><td>${esc(s.legal_entity_id || 'GLOBAL')}</td>
        <td>${esc(s.clock_in)}</td><td>${esc(s.clock_out)}</td><td>${s.standard_work_minutes} mnt</td>
        <td>${s.cross_midnight ? 'Ya' : 'Tidak'}</td>
        <td>${s.breaks.length ? s.breaks.map((b) => `${esc(b.name)} ${b.duration_minutes}m${b.is_paid ? ' (dibayar)' : ''}`).join('<br>') : '—'}</td>
        <td>${esc(s.overtime_eligible_from_resolved || 'tidak berhak')}</td>
        <td>${esc(s.effective_from)} → ${esc(s.effective_to || 'terbuka')}</td>
        <td><span class="status-badge ${s.status === 'ACTIVE' ? 'status-badge--green' : 'status-badge--grey'}">${esc(s.status)}</span></td>
        <td>${can('EDIT') ? `<a href="#" data-newver="${s.id}">Versi Baru</a> · <a href="#" data-togglestatus="${s.id}">${s.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}</a>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="12" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada shift.</td></tr>';

    tb.querySelectorAll('[data-newver]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); scheduleForm(schedules.find((s) => String(s.id) === a.dataset.newver));
    }));
    tb.querySelectorAll('[data-togglestatus]').forEach((a) => a.addEventListener('click', async (e) => {
      e.preventDefault();
      const s = schedules.find((x) => String(x.id) === a.dataset.togglestatus);
      try {
        await api('POST', `/schedules/${s.id}/status`, { status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
        toast('Status shift diperbarui.'); loadSchedules();
      } catch (err) { toast(`Gagal: ${err.message}`); }
    }));
    refreshSelectors();
  }

  function breakRowsHtml(breaks) {
    const rows = (breaks && breaks.length ? breaks : [{}, {}]).slice(0, 4);
    return rows.map((b, i) => `
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label class="form-field" style="flex:2">Istirahat ${i + 1}<input name="brk_name_${i}" value="${esc(b.name || '')}" placeholder="mis. Istirahat Siang"></label>
        <label class="form-field" style="flex:1">Mulai<input name="brk_start_${i}" type="time" value="${esc(b.start_time || '')}"></label>
        <label class="form-field" style="flex:1">Selesai<input name="brk_end_${i}" type="time" value="${esc(b.end_time || '')}"></label>
        <label class="form-field" style="flex:1">Menit<input name="brk_min_${i}" type="number" min="1" value="${esc(b.duration_minutes || '')}"></label>
        <label class="form-field" style="flex:1">Dibayar<select name="brk_paid_${i}"><option value="0"${b.is_paid ? '' : ' selected'}>Tidak</option><option value="1"${b.is_paid ? ' selected' : ''}>Ya</option></select></label>
      </div>`).join('');
  }
  function collectBreaks(data) {
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      const name = data[`brk_name_${i}`];
      const min = data[`brk_min_${i}`];
      const start = data[`brk_start_${i}`];
      const end = data[`brk_end_${i}`];
      if (!name && !min && !start) continue;
      out.push({ name: name || `Istirahat ${i + 1}`, start_time: start || null, end_time: end || null,
        duration_minutes: min ? Number(min) : undefined, is_paid: data[`brk_paid_${i}`] === '1', sequence: i + 1 });
    }
    return out;
  }

  function scheduleForm(existing) {
    const s = existing || {};
    const isVersion = !!existing;
    openModal(isVersion ? `Versi Baru — ${s.code}` : 'Tambah Shift', `
      ${field('Kode', input('code', 'text', `value="${esc(s.code || '')}" required ${isVersion ? 'readonly' : ''}`))}
      ${field('Nama', input('name', 'text', `value="${esc(s.name || '')}" required`))}
      ${isVersion ? '' : field('Legal Entity', select('legal_entity_id', entities.map((e) => ({ value: e, label: e })), 'required'))}
      ${field('Tipe (label bebas)', input('schedule_type', 'text', `value="${esc(s.schedule_type || 'CUSTOM')}"`))}
      <div style="display:flex;gap:8px">
        ${field('Jam Masuk', input('clock_in', 'time', `value="${esc(s.clock_in || '')}" required`))}
        ${field('Jam Pulang', input('clock_out', 'time', `value="${esc(s.clock_out || '')}" required`))}
        ${field('Menit Kerja Standar', input('standard_work_minutes', 'number', `value="${esc(s.standard_work_minutes || '')}" min="1" max="1440"`))}
      </div>
      ${field('Lewat Tengah Malam', select('cross_midnight', [{ value: '0', label: 'Tidak' }, { value: '1', label: 'Ya' }]))}
      <div style="display:flex;gap:8px">
        ${field('Aturan Lembur', select('overtime_eligibility_rule', [
          { value: 'AFTER_SHIFT_END', label: 'Setelah jam pulang' },
          { value: 'AFTER_DELAY', label: 'Setelah jeda (menit)' },
          { value: 'FIXED_TIME', label: 'Jam tetap' },
          { value: 'NOT_ELIGIBLE', label: 'Tidak berhak lembur' }]))}
        ${field('Jeda (menit)', input('overtime_delay_minutes', 'number', 'value="0" min="0"'))}
        ${field('Lembur Mulai (jam tetap)', input('overtime_eligible_from', 'time'))}
      </div>
      ${field('Berlaku Sejak', input('effective_from', 'date', 'required'))}
      <p class="hint">Istirahat: boleh kosong (0 istirahat), satu, atau beberapa. Menit dihitung dari mulai/selesai bila dikosongkan.</p>
      ${breakRowsHtml(s.breaks)}
    `, async (data) => {
      const payload = {
        code: data.code, name: data.name, legal_entity_id: data.legal_entity_id || (s.legal_entity_id || null),
        schedule_type: data.schedule_type, clock_in: data.clock_in, clock_out: data.clock_out,
        standard_work_minutes: data.standard_work_minutes ? Number(data.standard_work_minutes) : undefined,
        cross_midnight: data.cross_midnight === '1',
        overtime_eligibility_rule: data.overtime_eligibility_rule,
        overtime_delay_minutes: Number(data.overtime_delay_minutes || 0),
        overtime_eligible_from: data.overtime_eligible_from || null,
        effective_from: data.effective_from, breaks: collectBreaks(data),
      };
      if (isVersion) await api('POST', `/schedules/${s.id}/versions`, payload);
      else await api('POST', '/schedules', payload);
      toast(isVersion ? 'Versi shift baru dibuat.' : 'Shift dibuat.');
      loadSchedules();
    });
    if (!isVersion) form.querySelector('[name=cross_midnight]').value = '0';
  }

  // ---- PATTERNS ----------------------------------------------------------------
  async function loadPatterns() {
    patterns = await api('GET', '/patterns');
    const tb = document.getElementById('patternRows');
    tb.innerHTML = patterns.length ? patterns.map((p) => `
      <tr>
        <td><strong>${esc(p.code)}</strong></td><td>${esc(p.name)}</td><td>${esc(p.pattern_type)}</td>
        <td>${esc(p.legal_entity_id || 'GLOBAL')}</td>
        <td>${p.cycle_length_days ? `${p.cycle_length_days} hari` : '—'}</td>
        <td>${esc(p.cycle_start_date || '—')}</td>
        <td>${p.days.filter((d) => d.day_status === 'WORK').length} / ${p.days.length || '—'}</td>
        <td>${esc(p.effective_from)} → ${esc(p.effective_to || 'terbuka')}</td>
        <td><span class="status-badge ${p.status === 'ACTIVE' ? 'status-badge--green' : 'status-badge--grey'}">${esc(p.status)}</span></td>
        <td><a href="#" data-detail="${p.id}">Rincian</a></td>
      </tr>`).join('') : '<tr><td colspan="10" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada pola.</td></tr>';

    tb.querySelectorAll('[data-detail]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const p = patterns.find((x) => String(x.id) === a.dataset.detail);
      document.getElementById('patternDetailWrap').style.display = 'block';
      document.getElementById('patternDetailName').textContent = `${p.code} — ${p.name} (${p.pattern_type})`;
      const label = (d) => (p.pattern_type === 'ROTATING_CYCLE' ? `Hari siklus ${d.day_index}` : WEEKDAYS[d.day_index - 1]);
      document.getElementById('patternDetailRows').innerHTML = p.days.length ? p.days.map((d) => `
        <tr><td>${esc(label(d))}</td>
        <td><span class="status-badge ${d.day_status === 'WORK' ? 'status-badge--green' : 'status-badge--grey'}">${esc(d.day_status)}</span></td>
        <td>${esc((schedules.find((s) => s.id === d.work_schedule_id) || {}).code || '—')}</td>
        <td>${esc(d.note || '')}</td></tr>`).join('')
        : '<tr><td colspan="4">Pola berbasis tanggal — lihat tab Roster Tanggal.</td></tr>';
    }));
    refreshSelectors();
  }

  function patternDayRows(type, count) {
    const rows = [];
    for (let i = 1; i <= count; i += 1) {
      const label = type === 'ROTATING_CYCLE' ? `Hari siklus ${i}` : WEEKDAYS[i - 1];
      rows.push(`<div style="display:flex;gap:8px;align-items:flex-end">
        <span style="flex:1;color:var(--grey-300);font-size:12px;padding-bottom:8px">${label}</span>
        <label class="form-field" style="flex:1">Status<select name="day_status_${i}"><option value="WORK">WORK</option><option value="OFF">OFF</option></select></label>
        <label class="form-field" style="flex:2">Shift${select(`day_schedule_${i}`, scheduleOptions())}</label>
      </div>`);
    }
    return rows.join('');
  }

  function patternForm() {
    openModal('Tambah Pola Kerja', `
      ${field('Kode', input('code', 'text', 'required'))}
      ${field('Nama', input('name', 'text', 'required'))}
      ${field('Legal Entity', select('legal_entity_id', entities.map((e) => ({ value: e, label: e })), 'required'))}
      ${field('Tipe Pola', select('pattern_type', [
        { value: 'FIXED_WEEKLY', label: 'FIXED_WEEKLY — mingguan tetap' },
        { value: 'CUSTOM_WEEKLY', label: 'CUSTOM_WEEKLY — tiap hari diatur sendiri' },
        { value: 'ROTATING_CYCLE', label: 'ROTATING_CYCLE — siklus berputar (4/2, 14/7, 21/7, 2D-2N-2OFF…)' },
        { value: 'DATE_BASED_ROSTER', label: 'DATE_BASED_ROSTER — daftar tanggal' }]))}
      <div style="display:flex;gap:8px">
        ${field('Panjang Siklus (hari)', input('cycle_length_days', 'number', 'min="1" max="366"'))}
        ${field('Tanggal Mulai Siklus', input('cycle_start_date', 'date'))}
      </div>
      ${field('Shift Default', select('default_schedule_id', scheduleOptions()))}
      ${field('Berlaku Sejak', input('effective_from', 'date', 'required'))}
      <div id="dayRows">${patternDayRows('FIXED_WEEKLY', 7)}</div>
    `, async (data) => {
      const type = data.pattern_type;
      const count = type === 'ROTATING_CYCLE' ? Number(data.cycle_length_days || 0) : (type === 'DATE_BASED_ROSTER' ? 0 : 7);
      const days = [];
      for (let i = 1; i <= count; i += 1) {
        days.push({ day_index: i, day_status: data[`day_status_${i}`] || 'OFF',
          work_schedule_id: data[`day_schedule_${i}`] ? Number(data[`day_schedule_${i}`]) : null });
      }
      await api('POST', '/patterns', {
        code: data.code, name: data.name, legal_entity_id: data.legal_entity_id, pattern_type: type,
        cycle_length_days: data.cycle_length_days ? Number(data.cycle_length_days) : null,
        cycle_start_date: data.cycle_start_date || null,
        default_schedule_id: data.default_schedule_id ? Number(data.default_schedule_id) : null,
        effective_from: data.effective_from, days,
      });
      toast('Pola kerja dibuat.'); loadPatterns();
    });
    // Rotating cycles need one row per cycle day; weekly patterns need seven.
    const typeSel = form.querySelector('[name=pattern_type]');
    const lenInput = form.querySelector('[name=cycle_length_days]');
    const rerender = () => {
      const type = typeSel.value;
      const count = type === 'ROTATING_CYCLE' ? Math.min(Number(lenInput.value || 0), 31) : (type === 'DATE_BASED_ROSTER' ? 0 : 7);
      document.getElementById('dayRows').innerHTML = count ? patternDayRows(type, count)
        : '<p class="hint">Pola berbasis tanggal: tambahkan tanggalnya di tab Roster Tanggal setelah pola dibuat.</p>';
    };
    typeSel.addEventListener('change', rerender);
    lenInput.addEventListener('change', rerender);
  }

  // ---- ROSTER DATES ------------------------------------------------------------
  async function loadRoster() {
    const sel = document.getElementById('rosterPattern');
    if (!sel.value) return;
    const rows = await api('GET', `/patterns/${sel.value}/roster-dates`);
    document.getElementById('rosterRows').innerHTML = rows.length ? rows.map((r) => `
      <tr><td>${esc(r.work_date)}</td>
      <td><span class="status-badge ${r.day_status === 'WORK' ? 'status-badge--green' : 'status-badge--grey'}">${esc(r.day_status)}</span></td>
      <td>${esc((schedules.find((s) => s.id === r.work_schedule_id) || {}).code || '—')}</td>
      <td>${esc(r.note || '')}</td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada tanggal roster.</td></tr>';
  }

  function rosterForm() {
    const patternId = document.getElementById('rosterPattern').value;
    if (!patternId) return toast('Pilih pola kerja dulu.');
    openModal('Tambah Tanggal Roster', `
      ${field('Dari Tanggal', input('from', 'date', 'required'))}
      ${field('Sampai Tanggal', input('to', 'date', 'required'))}
      ${field('Status', select('day_status', [{ value: 'WORK', label: 'WORK' }, { value: 'OFF', label: 'OFF' }]))}
      ${field('Shift', select('work_schedule_id', scheduleOptions()))}
      ${field('Catatan', input('note'))}
    `, async (data) => {
      const dates = [];
      for (let d = data.from; d <= data.to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
        dates.push({ work_date: d, day_status: data.day_status,
          work_schedule_id: data.work_schedule_id ? Number(data.work_schedule_id) : null, note: data.note || null });
        if (dates.length > 366) break;
      }
      await api('POST', `/patterns/${patternId}/roster-dates`, { dates });
      toast(`${dates.length} tanggal roster disimpan.`); loadRoster();
    });
  }

  // ---- OVERRIDES ---------------------------------------------------------------
  async function loadOverrides() {
    const rows = await api('GET', '/overrides');
    document.getElementById('overrideRows').innerHTML = rows.length ? rows.map((o) => `
      <tr><td>${esc(o.work_date)}</td>
      <td>${esc(o.full_name || (patterns.find((p) => p.id === o.pattern_id) || {}).code || '—')}</td>
      <td><span class="status-badge ${o.override_status === 'WORK' ? 'status-badge--amber' : 'status-badge--grey'}">${esc(o.override_status)}</span></td>
      <td>${esc((schedules.find((s) => s.id === o.work_schedule_id) || {}).code || '—')}</td>
      <td>${esc(o.reason)}</td><td>${esc(o.created_by || '')}</td>
      <td>${o.is_active ? 'Aktif' : 'Nonaktif'}</td>
      <td>${o.is_active && can('EDIT') ? `<a href="#" data-deact="${o.id}">Nonaktifkan</a>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada override.</td></tr>';
    document.querySelectorAll('[data-deact]').forEach((a) => a.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await api('POST', `/overrides/${a.dataset.deact}/deactivate`); toast('Override dinonaktifkan.'); loadOverrides(); }
      catch (err) { toast(`Gagal: ${err.message}`); }
    }));
  }

  function overrideForm() {
    openModal('Tambah Override Tanggal', `
      ${field('Karyawan (opsional bila pola)', select('employee_id', [{ value: '', label: '— pola —' }].concat(employees.map((e) => ({ value: e.id, label: `${e.full_name} (${e.id})` })))))}
      ${field('Pola (bila bukan karyawan)', select('pattern_id', [{ value: '', label: '—' }].concat(patterns.map((p) => ({ value: p.id, label: p.code })))))}
      ${field('Tanggal', input('work_date', 'date', 'required'))}
      ${field('Jadi', select('override_status', [{ value: 'WORK', label: 'WORK (masuk)' }, { value: 'OFF', label: 'OFF (libur)' }]))}
      ${field('Shift', select('work_schedule_id', scheduleOptions()))}
      ${field('Alasan', input('reason', 'text', 'required'))}
      <p class="hint">Override tidak mengubah pola dasar, dan tidak mengubah jenis hari libur nasional.</p>
    `, async (data) => {
      await api('POST', '/overrides', {
        employee_id: data.employee_id || null, pattern_id: data.pattern_id ? Number(data.pattern_id) : null,
        work_date: data.work_date, override_status: data.override_status,
        work_schedule_id: data.work_schedule_id ? Number(data.work_schedule_id) : null, reason: data.reason,
      });
      toast('Override disimpan.'); loadOverrides();
    });
  }

  // ---- ASSIGNMENTS -------------------------------------------------------------
  async function loadAssignments() {
    const rows = await api('GET', '/assignments');
    document.getElementById('assignmentRows').innerHTML = rows.length ? rows.map((a) => `
      <tr><td>${esc(a.full_name)}</td><td>${esc(a.pattern_code || '—')}</td><td>${esc(a.pattern_type || '—')}</td>
      <td>${esc(a.schedule_code || '—')}</td><td>${esc(a.project_code || '—')}</td><td>${esc(a.workfront || '—')}</td>
      <td>${esc(a.effective_from)}</td><td>${esc(a.effective_to || 'terbuka')}</td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada penugasan.</td></tr>';
  }

  function assignmentForm() {
    openModal('Tugaskan Pola / Shift', `
      ${field('Karyawan', select('employee_id', employees.map((e) => ({ value: e.id, label: `${e.full_name} (${e.id})` })), 'required'))}
      ${field('Pola Kerja', select('pattern_id', [{ value: '', label: '— tanpa pola —' }].concat(patterns.map((p) => ({ value: p.id, label: `${p.code} (${p.pattern_type})` })))))}
      ${field('Shift Default', select('work_schedule_id', scheduleOptions()))}
      ${field('Workfront', input('workfront'))}
      ${field('Berlaku Sejak', input('effective_from', 'date', 'required'))}
      <p class="hint">Penugasan baru menutup penugasan terbuka sehari sebelumnya. Riwayat absensi sebelumnya tetap memakai pola lamanya.</p>
    `, async (data) => {
      await api('POST', '/assignments', {
        employee_id: data.employee_id, pattern_id: data.pattern_id ? Number(data.pattern_id) : null,
        work_schedule_id: data.work_schedule_id ? Number(data.work_schedule_id) : null,
        workfront: data.workfront || null, effective_from: data.effective_from,
      });
      toast('Penugasan disimpan.'); loadAssignments();
    });
  }

  // ---- RESOLUTION CHECK --------------------------------------------------------
  async function resolveCheck() {
    const emp = document.getElementById('resolveEmployee').value;
    const date = document.getElementById('resolveDate').value;
    if (!emp || !date) return toast('Pilih karyawan dan tanggal.');
    try {
      const r = await api('GET', `/resolve/${encodeURIComponent(emp)}/${date}`);
      document.getElementById('resolveResult').innerHTML = `
        <table class="hrd-table"><tbody>
          <tr><td>Status resolusi</td><td><strong>${esc(r.status)}</strong> ${esc(r.reason || '')}</td></tr>
          <tr><td>Sumber</td><td>${esc(r.source)}${r.cycle_day_index ? ` (hari siklus ${r.cycle_day_index})` : ''}</td></tr>
          <tr><td>Status hari</td><td>${esc(r.day_status || '—')}</td></tr>
          <tr><td>Jenis hari</td><td>${esc(r.day_type || '—')} <span class="hint">(${esc(r.day_type_source || '')})</span></td></tr>
          <tr><td>Pola</td><td>${r.pattern ? `${esc(r.pattern.code)} — ${esc(r.pattern.type)}` : '—'}</td></tr>
          <tr><td>Shift</td><td>${r.schedule ? `${esc(r.schedule.code)} ${esc(r.schedule.clock_in)}–${esc(r.schedule.clock_out)}${r.schedule.cross_midnight ? ' (lewat tengah malam)' : ''}` : '—'}</td></tr>
          <tr><td>Menit terjadwal</td><td>${r.scheduled_minutes ?? '—'} (istirahat tanpa upah ${r.break_minutes_unpaid} mnt, dibayar ${r.break_minutes_paid} mnt)</td></tr>
          <tr><td>Lembur mulai</td><td>${esc(r.overtime_eligible_from || 'tidak berhak')}</td></tr>
          <tr><td>Catatan</td><td>${r.warnings.length ? r.warnings.map(esc).join('<br>') : '—'}</td></tr>
        </tbody></table>`;
    } catch (err) { toast(`Gagal: ${err.message}`); }
  }

  // ---- bootstrap ---------------------------------------------------------------
  function refreshSelectors() {
    const rp = document.getElementById('rosterPattern');
    const current = rp.value;
    rp.innerHTML = '<option value="">— pilih pola —</option>' +
      patterns.map((p) => `<option value="${p.id}">${esc(p.code)} (${esc(p.pattern_type)})</option>`).join('');
    if (current) rp.value = current;
  }

  async function bootstrap() {
    try {
      const me = await (await fetch('/api/auth/me')).json();
      myActions.attendance_config = (me.user.permissions || {}).attendance_config || [];
      entities = me.user.entityScope || [];
    } catch (err) { /* page-shell.js handles auth redirect */ }

    try {
      const ctx = await api('GET', '/context');
      document.getElementById('tzBadge').textContent = ctx.timezone;
      document.getElementById('resolveDate').value = ctx.today;
    } catch (err) { /* non-fatal */ }

    // Employee list comes from the attendance-scoped assignment endpoint plus
    // HRD; we filter to the entities in scope so no foreign worker is offered.
    try {
      const all = await (await fetch('/api/hrd/employees?status=active')).json();
      const scoped = await api('GET', '/assignments');
      const known = new Set(scoped.map((a) => a.employee_id));
      employees = Array.isArray(all) ? all.filter((e) => known.has(e.id) || entities.length > 0) : [];
    } catch (err) { employees = []; }

    ['btnAddSchedule', 'btnAddPattern', 'btnAddRoster', 'btnAddOverride', 'btnAddAssignment'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = can('CREATE') || can('EDIT') ? '' : 'none';
    });
    document.getElementById('btnAddSchedule').addEventListener('click', () => scheduleForm(null));
    document.getElementById('btnAddPattern').addEventListener('click', patternForm);
    document.getElementById('btnAddRoster').addEventListener('click', rosterForm);
    document.getElementById('btnAddOverride').addEventListener('click', overrideForm);
    document.getElementById('btnAddAssignment').addEventListener('click', assignmentForm);
    document.getElementById('rosterPattern').addEventListener('change', loadRoster);
    document.getElementById('btnResolve').addEventListener('click', resolveCheck);

    const empSel = document.getElementById('resolveEmployee');
    empSel.innerHTML = '<option value="">— pilih karyawan —</option>' +
      employees.map((e) => `<option value="${esc(e.id)}">${esc(e.full_name)} (${esc(e.id)})</option>`).join('');

    await loadSchedules();
    await loadPatterns();
    await loadOverrides();
    await loadAssignments();
  }

  bootstrap();
})();
