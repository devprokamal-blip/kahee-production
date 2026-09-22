// payroll-config.js — KAHE 360 Internal Operations Portal
(function () {
  const API = '/api/payroll-config';

  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // ---- tab switching -----------------------------------------------------------
  document.querySelectorAll('.pcfg-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pcfg-tab').forEach((b) => b.classList.remove('is-active'));
      document.querySelectorAll('.pcfg-panel').forEach((p) => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      document.querySelector(`.pcfg-panel[data-panel="${btn.dataset.tab}"]`).classList.add('is-active');
    });
  });

  const RISK_LABELS = { very_low: 'Sangat Rendah', low: 'Rendah', medium: 'Sedang', high: 'Tinggi', very_high: 'Sangat Tinggi' };
  const DAY_TYPE_LABELS = { workday: 'Hari Kerja Biasa', rest_or_holiday_5day: 'Libur/Istirahat (Pola 5 Hari)', rest_or_holiday_6day: 'Libur/Istirahat (Pola 6 Hari)' };
  // B3: values arrive as integer basis points (370 = 3.7%) and integer sen.
  // Formatting is pure integer arithmetic, so float artifacts like
  // 3.6999999999999996 are structurally impossible, not just rounded away.
  function pct(bp) {
    if (bp === null || bp === undefined) return '-';
    const n = Number(bp);
    const whole = Math.trunc(n / 100);
    const frac = Math.abs(n % 100);
    if (frac === 0) return String(whole);
    return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  }
  function rupiah(sen) {
    if (sen === null || sen === undefined) return '-';
    return 'Rp' + Math.round(Number(sen) / 100).toLocaleString('id-ID');
  }
  function multiplierText(bp) {
    if (bp === null || bp === undefined) return '-';
    const v = Number(bp) / 10000;
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  }

  // ============================================================
  // 1. LEGAL ENTITIES
  // ============================================================
  async function loadLegalEntities() {
    const res = await fetch(`${API}/legal-entities`);
    const rows = res.ok ? await res.json() : [];
    const tbody = document.getElementById('legalEntityRows');
    tbody.innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${r.id}</td><td>${r.name}</td>
        <td>${r.entity_type === 'internal' ? 'Internal' : 'Subkontraktor'}</td>
        <td>${r.npwp || '-'}</td>
        <td><span class="status-badge status-badge--amber">${RISK_LABELS[r.jkk_risk_class]}</span></td>
        <td>${r.effective_date}</td>
        <td><span class="status-badge ${r.status === 'active' ? 'status-badge--green' : ''}">${r.status}</span></td>
      </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada legal entity.</td></tr>`;
  }

  document.getElementById('btnAddLegalEntity').addEventListener('click', () => openGenericForm({
    title: 'Tambah Legal Entity',
    fields: [
      { name: 'id', label: 'Kode Entitas (unik)', type: 'text', required: true, placeholder: 'mis. MITRA-JAYA' },
      { name: 'name', label: 'Nama Entitas', type: 'text', required: true },
      { name: 'entity_type', label: 'Tipe', type: 'select', required: true, options: [['internal', 'Internal'], ['subkontraktor', 'Subkontraktor']] },
      { name: 'npwp', label: 'NPWP', type: 'text' },
      { name: 'jkk_risk_class', label: 'Kelas Risiko JKK', type: 'select', required: true, options: Object.entries(RISK_LABELS).map(([k, v]) => [k, v]) },
      { name: 'effective_date', label: 'Berlaku Sejak', type: 'date', required: true },
    ],
    onSubmit: async (values) => {
      const res = await fetch(`${API}/legal-entities`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
      loadLegalEntities();
    },
  }));

  // ============================================================
  // 2. JKK RISK CLASSES
  // ============================================================
  async function loadJkkRates() {
    const res = await fetch(`${API}/jkk-risk-classes`);
    const rows = res.ok ? await res.json() : [];
    document.getElementById('jkkRows').innerHTML = rows.map((r) => `
      <tr>
        <td>${RISK_LABELS[r.risk_class]}</td>
        <td>${pct(r.rate_bp)}%</td>
        <td>${r.effective_date}</td>
        <td class="hint">${r.source_note || '-'}</td>
      </tr>`).join('');
  }

  document.getElementById('btnRepriceJkk').addEventListener('click', () => openGenericForm({
    title: 'Reprice Kelas Risiko JKK',
    fields: [
      { name: 'risk_class', label: 'Kelas Risiko', type: 'select', required: true, options: Object.entries(RISK_LABELS).map(([k, v]) => [k, v]) },
      { name: 'rate_bp', label: 'Rate Baru dalam basis point (127 = 1,27%)', type: 'number', step: '1', required: true },
      { name: 'effective_date', label: 'Berlaku Sejak', type: 'date', required: true },
      { name: 'source_note', label: 'Catatan / Referensi Keputusan', type: 'text' },
    ],
    onSubmit: async (values) => {
      const res = await fetch(`${API}/jkk-risk-classes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, rate_bp: Number(values.rate_bp) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
      loadJkkRates();
      loadJkkHistory(document.getElementById('fJkkHistoryClass').value);
    },
  }));

  // Version history + audit trail for one risk class (current vs previous).
  function populateJkkHistorySelect() {
    const select = document.getElementById('fJkkHistoryClass');
    if (select.options.length) return; // already populated
    select.innerHTML = Object.entries(RISK_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    select.addEventListener('change', () => loadJkkHistory(select.value));
  }

  async function loadJkkHistory(riskClass) {
    if (!riskClass) return;
    const res = await fetch(`${API}/jkk-risk-classes/all-versions`);
    const all = res.ok ? await res.json() : [];
    const versions = all.filter((r) => r.risk_class === riskClass);
    document.getElementById('jkkHistoryRows').innerHTML = versions.length ? versions.map((r) => `
      <tr>
        <td>${pct(r.rate_bp)}%</td>
        <td>${r.effective_date}</td>
        <td>${r.end_date || '-'}</td>
        <td><span class="status-badge ${r.end_date ? '' : 'status-badge--green'}">${r.end_date ? 'Superseded' : 'Current'}</span></td>
        <td class="hint">${r.source_note || '-'}</td>
      </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada versi.</td></tr>`;

    const auditRes = await fetch(`${API}/jkk-risk-classes/${riskClass}/history`);
    const audit = auditRes.ok ? await auditRes.json() : [];
    document.getElementById('jkkAuditRows').innerHTML = audit.length ? audit.map((a) => {
      let newVal = '-';
      try { const parsed = JSON.parse(a.new_value); newVal = `${pct(parsed.rate_bp)}% mulai ${parsed.effective_date}`; } catch (e) { /* noop */ }
      return `<tr><td>${a.action}</td><td>${a.changed_by}</td><td>${a.changed_at}</td><td class="hint">${newVal}</td></tr>`;
    }).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada riwayat perubahan.</td></tr>`;
  }

  // ============================================================
  // 3. RULE SET (BPJS / PPh21 TER / Overtime)
  // ============================================================
  let activeRuleSet = null;

  async function loadRuleSet() {
    const res = await fetch(`${API}/rule-sets/active`);
    if (!res.ok) {
      document.getElementById('ruleSetSummary').innerHTML = '<span style="color:var(--red-500)">Belum ada rule set aktif.</span>';
      return;
    }
    activeRuleSet = await res.json();
    const r = activeRuleSet;
    document.getElementById('ruleSetSummary').innerHTML = `
      <p style="margin:0 0 10px"><strong style="color:var(--white)">${r.name}</strong> — aktif sejak ${r.effective_date}</p>
      <div class="pk-kpi-bar" style="margin-bottom:0">
        <div class="pk-kpi pk-kpi--blue"><div class="pk-kpi__icon pk-kpi__icon--blue">🏥</div><div><p class="pk-kpi__label">BPJS Kesehatan</p><p class="pk-kpi__value" style="font-size:16px">${pct(r.bpjs_kesehatan_rate_employee_bp)}% + ${pct(r.bpjs_kesehatan_rate_company_bp)}%</p><p class="pk-kpi__sub">cap ${rupiah(r.bpjs_kesehatan_salary_cap_sen)}</p></div></div>
        <div class="pk-kpi pk-kpi--blue"><div class="pk-kpi__icon pk-kpi__icon--blue">🏦</div><div><p class="pk-kpi__label">JHT</p><p class="pk-kpi__value" style="font-size:16px">${pct(r.jht_rate_employee_bp)}% + ${pct(r.jht_rate_company_bp)}%</p><p class="pk-kpi__sub">tanpa batas atas</p></div></div>
        <div class="pk-kpi pk-kpi--blue"><div class="pk-kpi__icon pk-kpi__icon--blue">👴</div><div><p class="pk-kpi__label">JP</p><p class="pk-kpi__value" style="font-size:16px">${pct(r.jp_rate_employee_bp)}% + ${pct(r.jp_rate_company_bp)}%</p><p class="pk-kpi__sub">cap ${rupiah(r.jp_salary_cap_sen)}</p></div></div>
        <div class="pk-kpi pk-kpi--blue"><div class="pk-kpi__icon pk-kpi__icon--blue">⚰️</div><div><p class="pk-kpi__label">JKM</p><p class="pk-kpi__value" style="font-size:16px">${pct(r.jkm_rate_bp)}%</p><p class="pk-kpi__sub">perusahaan penuh</p></div></div>
        <div class="pk-kpi pk-kpi--green"><div class="pk-kpi__icon pk-kpi__icon--green">🕐</div><div><p class="pk-kpi__label">Dasar Upah Sejam</p><p class="pk-kpi__value" style="font-size:16px">1/${r.overtime_hourly_divisor}</p><p class="pk-kpi__sub">PP 35/2021</p></div></div>
      </div>
    `;
    const terCounts = { A: 0, B: 0, C: 0 };
    (r.ter_rates || []).forEach((row) => { terCounts[row.category]++; });
    document.getElementById('terSummary').innerHTML = `
      <span class="status-badge status-badge--blue" style="margin-right:8px">Kategori A: ${terCounts.A} lapisan</span>
      <span class="status-badge status-badge--blue" style="margin-right:8px">Kategori B: ${terCounts.B} lapisan</span>
      <span class="status-badge status-badge--blue">Kategori C: ${terCounts.C} lapisan</span>
    `;
    document.getElementById('overtimeRuleRows').innerHTML = (r.overtime_rules || []).map((row) => `
      <tr>
        <td>${DAY_TYPE_LABELS[row.day_type]}</td>
        <td>${row.hour_to ? `jam ke-${row.hour_from}–${row.hour_to}` : `jam ke-${row.hour_from} dst`}</td>
        <td><strong>${multiplierText(row.multiplier_bp)}×</strong></td>
      </tr>`).join('');
  }

  // Full list of rule sets (draft/active/superseded) + Aktifkan action.
  // Reuses the existing POST /rule-sets/:id/activate endpoint — no new
  // backend logic, this is purely the missing UI for it.
  async function loadRuleSetList() {
    const res = await fetch(`${API}/rule-sets`);
    const rows = res.ok ? await res.json() : [];
    const badgeClass = { active: 'status-badge--green', draft: 'status-badge--amber', superseded: 'status-badge--red' };
    document.getElementById('ruleSetListRows').innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${r.name}</td>
        <td><span class="status-badge ${badgeClass[r.status] || ''}">${r.status}</span></td>
        <td>${r.effective_date}</td>
        <td>${r.end_date || '-'}</td>
        <td>${r.status === 'draft' ? `<button class="hrd-table__link" data-activate="${r.id}">Aktifkan</button>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada rule set.</td></tr>`;

    document.querySelectorAll('[data-activate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Aktifkan rule set ini? Rule set yang sedang aktif akan otomatis di-supersede dan seluruh perhitungan payroll berikutnya memakai rate baru ini.')) return;
        const res2 = await fetch(`${API}/rule-sets/${btn.getAttribute('data-activate')}/activate`, { method: 'POST' });
        if (!res2.ok) return toast((await res2.json().catch(() => ({}))).message || 'Gagal mengaktifkan.');
        toast('Rule set diaktifkan.');
        loadRuleSet();
        loadRuleSetList();
      });
    });
  }

  document.getElementById('btnNewRuleSet').addEventListener('click', () => {
    if (!activeRuleSet) return toast('Rule set aktif belum termuat.');
    openGenericForm({
      title: 'Buat Rule Set Baru (revisi rate BPJS)',
      fields: [
        { name: 'name', label: 'Nama Rule Set', type: 'text', required: true, value: 'Revisi ' + new Date().toISOString().slice(0, 10) },
        { name: 'effective_date', label: 'Berlaku Sejak', type: 'date', required: true },
        { name: 'bpjs_kesehatan_rate_employee_bp', label: 'BPJS Kesehatan — Karyawan (basis point, 100 = 1%)', type: 'number', step: '1', required: true, value: activeRuleSet.bpjs_kesehatan_rate_employee_bp },
        { name: 'bpjs_kesehatan_rate_company_bp', label: 'BPJS Kesehatan — Perusahaan (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.bpjs_kesehatan_rate_company_bp },
        { name: 'bpjs_kesehatan_salary_cap_sen', label: 'BPJS Kesehatan — Cap Upah (sen, Rp x 100)', type: 'number', step: '1', required: true, value: activeRuleSet.bpjs_kesehatan_salary_cap_sen },
        { name: 'jht_rate_employee_bp', label: 'JHT — Karyawan (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.jht_rate_employee_bp },
        { name: 'jht_rate_company_bp', label: 'JHT — Perusahaan (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.jht_rate_company_bp },
        { name: 'jp_rate_employee_bp', label: 'JP — Karyawan (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.jp_rate_employee_bp },
        { name: 'jp_rate_company_bp', label: 'JP — Perusahaan (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.jp_rate_company_bp },
        { name: 'jp_salary_cap_sen', label: 'JP — Cap Upah (sen)', type: 'number', step: '1', required: true, value: activeRuleSet.jp_salary_cap_sen },
        { name: 'jkm_rate_bp', label: 'JKM (bp)', type: 'number', step: '1', required: true, value: activeRuleSet.jkm_rate_bp },
        { name: 'overtime_hourly_divisor', label: 'Dasar Upah Sejam (pembagi)', type: 'number', required: true, value: activeRuleSet.overtime_hourly_divisor },
      ],
      hint: 'Tabel TER dan multiplier lembur aktif akan disalin otomatis ke rule set baru ini. Rule set baru berstatus draft — perlu diaktifkan lewat API untuk menggantikan yang lama.',
      onSubmit: async (values) => {
        const payload = {
          ...values,
          ter_rates: activeRuleSet.ter_rates.map((r) => ({ category: r.category, income_min_sen: r.income_min_sen, income_max_sen: r.income_max_sen, rate_bp: r.rate_bp })),
          overtime_rules: activeRuleSet.overtime_rules.map((r) => ({ day_type: r.day_type, hour_from: r.hour_from, hour_to: r.hour_to, multiplier_bp: r.multiplier_bp })),
        };
        for (const f of ['bpjs_kesehatan_rate_employee_bp', 'bpjs_kesehatan_rate_company_bp', 'bpjs_kesehatan_salary_cap_sen', 'jht_rate_employee_bp', 'jht_rate_company_bp', 'jp_rate_employee_bp', 'jp_rate_company_bp', 'jp_salary_cap_sen', 'jkm_rate_bp', 'overtime_hourly_divisor']) {
          payload[f] = Number(payload[f]);
        }
        const res = await fetch(`${API}/rule-sets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
        toast('Draft rule set baru dibuat. Klik Aktifkan di tabel bawah saat siap berlaku.');
        loadRuleSetList();
      },
    });
  });

  // ============================================================
  // 4. HOLIDAYS
  // ============================================================
  async function loadHolidays() {
    const year = document.getElementById('fHolidayYear').value;
    const res = await fetch(`${API}/holidays?year=${year}`);
    const rows = res.ok ? await res.json() : [];
    document.getElementById('holidayRows').innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${r.date}</td><td>${r.name}</td>
        <td>${r.scope === 'national' ? 'Nasional' : 'Proyek: ' + (r.project_code || '-')}</td>
        <td><button class="hrd-table__link" data-delete-holiday="${r.id}">Hapus</button></td>
      </tr>`).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada hari libur.</td></tr>`;

    document.querySelectorAll('[data-delete-holiday]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res2 = await fetch(`${API}/holidays/${btn.getAttribute('data-delete-holiday')}`, { method: 'DELETE' });
        if (!res2.ok) return toast('Gagal menghapus.');
        loadHolidays();
      });
    });
  }
  document.getElementById('fHolidayYear').addEventListener('change', loadHolidays);

  document.getElementById('btnAddHoliday').addEventListener('click', () => openGenericForm({
    title: 'Tambah Hari Libur',
    fields: [
      { name: 'date', label: 'Tanggal', type: 'date', required: true },
      { name: 'name', label: 'Nama Hari Libur', type: 'text', required: true },
      { name: 'scope', label: 'Cakupan', type: 'select', required: true, options: [['national', 'Nasional'], ['project', 'Khusus Proyek']] },
    ],
    onSubmit: async (values) => {
      const res = await fetch(`${API}/holidays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
      loadHolidays();
    },
  }));

  // ============================================================
  // 5. WORK PATTERNS
  // ============================================================
  async function loadWorkPatterns() {
    const res = await fetch(`${API}/work-patterns`);
    const rows = res.ok ? await res.json() : [];
    document.getElementById('workPatternRows').innerHTML = rows.map((r) => `
      <tr><td>${r.name}</td><td>${r.days_per_week} hari</td><td>${r.weekly_rest_day}</td><td>${r.effective_date}</td></tr>
    `).join('');
  }

  document.getElementById('btnAddWorkPattern').addEventListener('click', () => openGenericForm({
    title: 'Tambah Pola Kerja',
    fields: [
      { name: 'name', label: 'Nama Pola', type: 'text', required: true },
      { name: 'days_per_week', label: 'Hari Kerja / Minggu', type: 'select', required: true, options: [['5', '5 Hari'], ['6', '6 Hari']] },
      { name: 'weekly_rest_day', label: 'Hari Istirahat Mingguan', type: 'text', required: true, value: 'sunday' },
      { name: 'effective_date', label: 'Berlaku Sejak', type: 'date', required: true },
    ],
    onSubmit: async (values) => {
      const res = await fetch(`${API}/work-patterns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, days_per_week: Number(values.days_per_week) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
      loadWorkPatterns();
    },
  }));

  // ============================================================
  // 6. EMPLOYEE PAYROLL ASSIGNMENT
  // ============================================================
  async function loadAssignments() {
    const res = await fetch(`${API}/employee-assignments`);
    const rows = res.ok ? await res.json() : [];
    const search = document.getElementById('fAssignSearch').value.toLowerCase();
    const filtered = search ? rows.filter((r) => r.full_name.toLowerCase().includes(search)) : rows;
    document.getElementById('assignmentRows').innerHTML = filtered.length ? filtered.map((r) => `
      <tr>
        <td>${r.full_name}</td><td>${r.legal_entity_id}</td><td>#${r.work_pattern_id}</td>
        <td>${r.marital_status}/${r.dependents_count}</td>
        <td><span class="status-badge status-badge--blue">${r.ter_category}</span></td>
        <td>${rupiah(r.base_salary_sen)}</td>
      </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada assignment.</td></tr>`;
  }
  document.getElementById('fAssignSearch').addEventListener('input', loadAssignments);

  async function fetchEmployeeOptions() {
    const res = await fetch('/api/hrd/employees?status=active');
    if (!res.ok) return [];
    const list = await res.json();
    return list.map((e) => [e.id, `${e.full_name} (${e.id})`]);
  }
  async function fetchLegalEntityOptions() {
    const res = await fetch(`${API}/legal-entities`);
    if (!res.ok) return [];
    return (await res.json()).map((e) => [e.id, e.name]);
  }
  async function fetchWorkPatternOptions() {
    const res = await fetch(`${API}/work-patterns`);
    if (!res.ok) return [];
    return (await res.json()).map((p) => [String(p.id), p.name]);
  }

  document.getElementById('btnAddAssignment').addEventListener('click', async () => {
    const [employeeOpts, legalEntityOpts, workPatternOpts] = await Promise.all([
      fetchEmployeeOptions(), fetchLegalEntityOptions(), fetchWorkPatternOptions(),
    ]);
    openGenericForm({
      title: 'Assign Karyawan ke Konfigurasi Payroll',
      fields: [
        { name: 'employee_id', label: 'Karyawan', type: 'select', required: true, options: employeeOpts },
        { name: 'legal_entity_id', label: 'Legal Entity', type: 'select', required: true, options: legalEntityOpts },
        { name: 'work_pattern_id', label: 'Pola Kerja', type: 'select', required: true, options: workPatternOpts },
        { name: 'marital_status', label: 'Status Kawin (PTKP)', type: 'select', required: true, options: [['TK', 'Tidak Kawin'], ['K', 'Kawin']] },
        { name: 'dependents_count', label: 'Jumlah Tanggungan (0-3)', type: 'select', required: true, options: [['0', '0'], ['1', '1'], ['2', '2'], ['3', '3']] },
        { name: 'npwp', label: 'NPWP', type: 'text' },
        { name: 'base_salary', label: 'Gaji Pokok Bulanan (Rp)', type: 'number' },
        { name: 'effective_date', label: 'Berlaku Sejak', type: 'date', required: true },
      ],
      onSubmit: async (values) => {
        const payload = { ...values, dependents_count: Number(values.dependents_count), base_salary: values.base_salary ? Number(values.base_salary) : null };
        const res = await fetch(`${API}/employee-assignments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
        loadAssignments();
      },
    });
  });


  // ============================================================
  // 7. SALARY COMPONENTS (Phase 1A / B1)
  // ============================================================
  const SAPI = `${API}/salary`;
  const yn = (v) => (Number(v) === 1
    ? '<span class="status-badge status-badge--green">Ya</span>'
    : '<span class="status-badge">-</span>');

  let componentCache = [];

  async function loadComponents() {
    const res = await fetch(`${SAPI}/components`);
    componentCache = res.ok ? await res.json() : [];
    document.getElementById('componentRows').innerHTML = componentCache.length
      ? componentCache.map((c) => `
        <tr>
          <td>${c.calculation_order}</td>
          <td><strong>${c.code}</strong></td>
          <td>${c.name}</td>
          <td><span class="status-badge ${c.component_type === 'earning' ? 'status-badge--green' : 'status-badge--red'}">${c.component_type === 'earning' ? 'Pendapatan' : 'Potongan'}</span></td>
          <td>${c.calculation_type === 'fixed' ? 'Tetap' : 'Variabel'}</td>
          <td>${c.paid_by === 'employee' ? 'Karyawan' : 'Perusahaan'}</td>
          <td>${yn(c.is_taxable)}</td>
          <td>${yn(c.is_bpjs_base)}</td>
          <td>${yn(c.is_overtime_base)}</td>
          <td>${yn(c.is_proratable)}</td>
          <td class="hint">${c.legal_entity_id || 'Semua'}</td>
          <td>${c.effective_from}</td>
          <td><button class="hrd-table__link" data-revise-component="${c.id}">Revisi</button></td>
        </tr>`).join('')
      : `<tr><td colspan="13" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada komponen.</td></tr>`;

    const sel = document.getElementById('fComponentHistory');
    const codes = Array.from(new Set(componentCache.map((c) => c.code)));
    sel.innerHTML = '<option value="">Pilih kode komponen</option>' + codes.map((c) => `<option value="${c}">${c}</option>`).join('');

    document.querySelectorAll('[data-revise-component]').forEach((btn) => {
      btn.addEventListener('click', () => openReviseComponent(btn.getAttribute('data-revise-component')));
    });
  }

  document.getElementById('fComponentHistory').addEventListener('change', async (e) => {
    const code = e.target.value;
    const tbody = document.getElementById('componentVersionRows');
    if (!code) { tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--grey-500);padding:16px">Pilih komponen.</td></tr>`; return; }
    const res = await fetch(`${SAPI}/components/versions/${code}`);
    const rows = res.ok ? await res.json() : [];
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.name}</td><td>${r.effective_from}</td><td>${r.effective_to || '-'}</td>
        <td><span class="status-badge ${r.effective_to ? '' : 'status-badge--green'}">${r.effective_to ? 'Superseded' : 'Current'}</span></td>
        <td>${yn(r.is_taxable)}</td><td>${yn(r.is_bpjs_base)}</td><td class="hint">${r.created_by || '-'}</td>
      </tr>`).join('');
  });

  const COMPONENT_FIELDS = (defaults = {}) => ([
    { name: 'name', label: 'Nama Komponen', type: 'text', required: true, value: defaults.name },
    { name: 'component_type', label: 'Jenis', type: 'select', required: true, value: defaults.component_type,
      options: [['earning', 'Pendapatan'], ['deduction', 'Potongan']] },
    { name: 'calculation_type', label: 'Sifat Nilai', type: 'select', required: true, value: defaults.calculation_type,
      options: [['fixed', 'Tetap'], ['variable', 'Variabel']] },
    { name: 'paid_by', label: 'Ditanggung', type: 'select', required: true, value: defaults.paid_by,
      options: [['employee', 'Karyawan (mempengaruhi take-home)'], ['employer', 'Perusahaan (biaya, bukan potongan)']] },
    { name: 'is_taxable', label: 'Kena Pajak (PPh21)', type: 'select', required: true, value: defaults.is_taxable,
      options: [['1', 'Ya'], ['0', 'Tidak']] },
    { name: 'is_bpjs_base', label: 'Masuk Dasar BPJS', type: 'select', required: true, value: defaults.is_bpjs_base,
      options: [['0', 'Tidak'], ['1', 'Ya']] },
    { name: 'is_overtime_base', label: 'Masuk Dasar Lembur', type: 'select', required: true, value: defaults.is_overtime_base,
      options: [['0', 'Tidak'], ['1', 'Ya']] },
    { name: 'is_proratable', label: 'Diprorata (joiner/leaver)', type: 'select', required: true, value: defaults.is_proratable,
      options: [['1', 'Ya'], ['0', 'Tidak']] },
    { name: 'recurrence', label: 'Perulangan', type: 'select', required: true, value: defaults.recurrence,
      options: [['recurring', 'Rutin'], ['one_time', 'Sekali']] },
    { name: 'calculation_order', label: 'Urutan Perhitungan (kecil = lebih dulu)', type: 'number', required: true, value: defaults.calculation_order ?? 100 },
  ]);

  document.getElementById('btnAddComponent').addEventListener('click', async () => {
    const entityOpts = await fetchLegalEntityOptions();
    openGenericForm({
      title: 'Tambah Komponen Gaji',
      fields: [
        { name: 'code', label: 'Kode Komponen (unik, mis. ALLOW_SITE)', type: 'text', required: true },
        ...COMPONENT_FIELDS(),
        { name: 'legal_entity_id', label: 'Scope Legal Entity', type: 'select', required: false,
          options: [['', 'Semua entity']].concat(entityOpts) },
        { name: 'effective_from', label: 'Berlaku Sejak', type: 'date', required: true },
      ],
      onSubmit: async (values) => {
        const res = await fetch(`${SAPI}/components`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...values, legal_entity_id: values.legal_entity_id || null }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
        loadComponents();
      },
    });
  });

  function openReviseComponent(id) {
    const c = componentCache.find((x) => String(x.id) === String(id));
    if (!c) return;
    openGenericForm({
      title: `Revisi Komponen: ${c.code}`,
      hint: 'Revisi tidak mengubah versi lama. Versi sekarang ditutup sehari sebelum tanggal berlaku baru, sehingga payroll periode lampau tetap memakai aturan lama.',
      fields: [...COMPONENT_FIELDS(c), { name: 'effective_from', label: 'Berlaku Sejak (harus setelah ' + c.effective_from + ')', type: 'date', required: true }],
      onSubmit: async (values) => {
        const res = await fetch(`${SAPI}/components/${id}/revise`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
        loadComponents();
      },
    });
  }

  // ---- employee salary structure ----
  const structureDate = document.getElementById('fStructureDate');
  structureDate.value = new Date().toISOString().slice(0, 10);
  structureDate.addEventListener('change', loadStructures);

  async function loadStructures() {
    const res = await fetch(`${SAPI}/employee-structure?date=${structureDate.value}`);
    const rows = res.ok ? await res.json() : [];
    document.getElementById('structureRows').innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${r.full_name}</td>
        <td>${r.component_count}</td>
        <td>${rupiah(r.gross_earnings_sen)}</td>
        <td>${rupiah(r.taxable_base_sen)}</td>
        <td>${rupiah(r.bpjs_base_sen)}</td>
        <td>${rupiah(r.overtime_base_sen)}</td>
        <td><button class="hrd-table__link" data-structure="${r.employee_id}" data-name="${r.full_name}">Rincian</button></td>
      </tr>`).join('')
      : `<tr><td colspan="7" style="text-align:center;color:var(--grey-500);padding:16px">Belum ada karyawan dengan komponen gaji.</td></tr>`;

    document.querySelectorAll('[data-structure]').forEach((btn) => {
      btn.addEventListener('click', () => loadStructureDetail(btn.getAttribute('data-structure'), btn.getAttribute('data-name')));
    });
  }

  async function loadStructureDetail(employeeId, fullName) {
    const res = await fetch(`${SAPI}/employee-structure/${employeeId}/history`);
    const rows = res.ok ? await res.json() : [];
    document.getElementById('structureDetailName').textContent = fullName;
    document.getElementById('structureDetailWrap').style.display = 'block';
    document.getElementById('structureDetailRows').innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${r.code}</strong></td><td>${r.name}</td>
        <td>${r.component_type === 'earning' ? 'Pendapatan' : 'Potongan'}</td>
        <td>${rupiah(r.amount_sen)}</td>
        <td>${r.effective_from}</td><td>${r.effective_to || '-'}</td>
        <td>${r.effective_to ? '' : `<button class="hrd-table__link" data-change-amount="${r.id}" data-code="${r.code}" data-from="${r.effective_from}">Ubah Nilai</button>`}</td>
      </tr>`).join('');

    document.querySelectorAll('[data-change-amount]').forEach((btn) => {
      btn.addEventListener('click', () => openGenericForm({
        title: `Ubah Nilai: ${btn.getAttribute('data-code')}`,
        hint: 'Perubahan di tengah periode: baris saat ini ditutup sehari sebelum tanggal berlaku baru. Payroll periode lampau tidak berubah.',
        fields: [
          { name: 'amount', label: 'Nilai Baru (Rp)', type: 'number', required: true },
          { name: 'effective_from', label: 'Berlaku Sejak (harus setelah ' + btn.getAttribute('data-from') + ')', type: 'date', required: true },
          { name: 'note', label: 'Catatan', type: 'text' },
        ],
        onSubmit: async (values) => {
          const r2 = await fetch(`${SAPI}/employee-structure/${btn.getAttribute('data-change-amount')}/change-amount`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...values, amount: Number(values.amount) }),
          });
          if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).message || 'Gagal menyimpan.');
          loadStructureDetail(employeeId, fullName);
          loadStructures();
        },
      }));
    });
  }

  document.getElementById('btnAssignComponent').addEventListener('click', async () => {
    const employeeOpts = await fetchEmployeeOptions();
    openGenericForm({
      title: 'Assign Komponen ke Karyawan',
      fields: [
        { name: 'employee_id', label: 'Karyawan', type: 'select', required: true, options: employeeOpts },
        { name: 'component_id', label: 'Komponen', type: 'select', required: true,
          options: componentCache.map((c) => [String(c.id), `${c.code} — ${c.name}`]) },
        { name: 'amount', label: 'Nilai (Rp)', type: 'number', required: true },
        { name: 'effective_from', label: 'Berlaku Sejak', type: 'date', required: true },
        { name: 'effective_to', label: 'Berakhir (kosongkan jika berlanjut)', type: 'date' },
        { name: 'note', label: 'Catatan', type: 'text' },
      ],
      onSubmit: async (values) => {
        const res = await fetch(`${SAPI}/employee-structure`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...values, amount: Number(values.amount), effective_to: values.effective_to || null }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal menyimpan.');
        loadComponents(); loadStructures();
      },
    });
  });

  // ============================================================
  // Generic small-form modal (shared by every "+ Tambah" button)
  // ============================================================
  const modalOverlay = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const genericForm = document.getElementById('genericForm');
  const genericFormBody = document.getElementById('genericFormBody');
  let currentOnSubmit = null;

  function openGenericForm({ title, fields, onSubmit, hint }) {
    modalTitle.textContent = title;
    currentOnSubmit = onSubmit;
    genericFormBody.innerHTML = (hint ? `<p class="hint">${hint}</p>` : '') + fields.map((f) => {
      if (f.type === 'select') {
        return `<label class="form-field">${f.label}${f.required ? ' *' : ''}
          <select name="${f.name}" ${f.required ? 'required' : ''}>
            ${f.options.map(([v, l]) => `<option value="${v}" ${String(f.value) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>`;
      }
      return `<label class="form-field">${f.label}${f.required ? ' *' : ''}
        <input type="${f.type}" name="${f.name}" ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.value !== undefined ? `value="${f.value}"` : ''} ${f.required ? 'required' : ''}>
      </label>`;
    }).join('');
    modalOverlay.hidden = false;
  }
  function closeGenericForm() {
    modalOverlay.hidden = true;
    genericForm.reset();
    currentOnSubmit = null;
  }
  document.getElementById('modalClose').addEventListener('click', closeGenericForm);
  document.getElementById('btnCancel').addEventListener('click', closeGenericForm);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeGenericForm(); });

  genericForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(genericForm).entries());
    try {
      await currentOnSubmit(values);
      closeGenericForm();
      toast('Tersimpan.');
    } catch (err) {
      toast(err.message || 'Gagal menyimpan.');
    }
  });

  // ---- bootstrap ------------------------------------------------------------------
  loadLegalEntities();
  loadJkkRates();
  populateJkkHistorySelect();
  loadJkkHistory(document.getElementById('fJkkHistoryClass').value);
  loadRuleSet();
  loadRuleSetList();
  loadHolidays();
  loadWorkPatterns();
  loadAssignments();
  loadComponents();
  loadStructures();
})();
