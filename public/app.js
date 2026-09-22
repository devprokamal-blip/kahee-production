// app.js — KAHE 360 Internal Operations Portal (HOME)
// Localization comes from the shared engine (i18n.js) + dictionaries
// (translations/id.js, translations/en.js). The sidebar is JS-generated
// (label text depends on permissions loaded from the server), so it is
// re-rendered on every language switch via KaheI18n.initToggle().
(function () {
  const t = window.KaheI18n.t;

  // Pages built in Phase 2 — clicking these navigates instead of showing WIP toast.
  const PAGE_MAP = {
    command_center:         '/pusat-kendali.html',
    intelligence_planning:  '/intelijen-perencanaan.html',
    talent_readiness:       '/talenta-kesiapan.html',
    workforce_operations:   '/operasi-tenaga-kerja.html',
    performance_employment: '/kinerja-ketenagakerjaan.html',
    payroll_bpjs:           '/penggajian-bpjs.html',
    hrd_kontrak:            '/hrd-kontrak.html',
    timesheet_absensi:      '/timesheet-absensi.html',
    attendance_config:      '/jadwal-kerja.html',
    attendance_correction:      '/koreksi-absensi.html',
    payroll_config:         '/payroll-config.html',
    worker_services:        '/layanan-pekerja.html',
    occupational_health:    '/kesehatan-kerja.html',
    hse_compliance:         '/hse-kepatuhan.html',
    equipment_resource:     '/peralatan-resource.html',
    contractor_control:     '/kendali-kontraktor.html',
    customer_control:       '/kendali-pelanggan.html',
    commercial:             '/komersial.html',
    reports_analytics:      '/laporan-analitik.html',
    documents:              '/dokumen.html',
    demobilization:         '/demobilisasi.html',
    settings:               '/pengaturan.html',
  };

  const MENU = [
    { code: 'home', key: 'nav.home', icon: '🏠', active: true },
    { code: 'command_center', key: 'nav.command_center', icon: '🎛' },
    { code: 'intelligence_planning', key: 'nav.intelligence_planning', icon: '📈' },
    { code: 'talent_readiness', key: 'nav.talent_readiness', icon: '🎯' },
    { code: 'workforce_operations', key: 'nav.workforce_operations', icon: '👷' },
    { code: 'performance_employment', key: 'nav.performance_employment', icon: '📋' },
    { code: 'payroll_bpjs', key: 'nav.payroll_bpjs', icon: '💳' },
    { code: 'hrd_kontrak', key: 'nav.hrd_kontrak', icon: '🗂' },
    { code: 'timesheet_absensi', key: 'nav.timesheet_absensi', icon: '⏱' },
    { code: 'attendance_config', key: 'nav.attendance_config', icon: '🗓' },
    { code: 'attendance_correction', key: 'nav.attendance_correction', icon: '🛠' },
    { code: 'payroll_config', key: 'nav.payroll_config', icon: '⚙' },
    { code: 'worker_services', key: 'nav.worker_services', icon: '🧰' },
    { code: 'occupational_health', key: 'nav.occupational_health', icon: '⚕' },
    { code: 'hse_compliance', key: 'nav.hse_compliance', icon: '🦺' },
    { code: 'equipment_resource', key: 'nav.equipment_resource', icon: '🚧' },
    { code: 'contractor_control', key: 'nav.contractor_control', icon: '🏗' },
    { code: 'customer_control', key: 'nav.customer_control', icon: '🤝' },
    { code: 'commercial', key: 'nav.commercial', icon: '💰' },
    { code: 'reports_analytics', key: 'nav.reports_analytics', icon: '📊' },
    { code: 'documents', key: 'nav.documents', icon: '📁' },
    { code: 'demobilization', key: 'nav.demobilization', icon: '📦' },
    { code: 'settings', key: 'nav.settings', icon: '⚙' },
  ];

  let lastPermissions = {};

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function initials(name) {
    if (!name) return '--';
    return name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('');
  }

  function renderSidebar(permissions) {
    lastPermissions = permissions || {};
    const nav = document.getElementById('sidebarNav');
    nav.innerHTML = '';
    MENU.forEach((item) => {
      const allowed = item.code === 'home' || !!lastPermissions[item.code];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'nav-item' + (item.active ? ' is-active' : '');
      el.innerHTML = `<span class="nav-item__icon">${item.icon}</span><span>${t(item.key)}</span>`;
      if (!allowed) {
        el.disabled = true;
        el.title = t('module_no_access_title');
      } else {
        el.addEventListener('click', () => {
          if (item.code === 'home') return; // already on Home
          const dest = PAGE_MAP[item.code];
          if (dest) { window.location.href = dest; return; }
          showToast(t('module_wip_toast'));
        });
      }
      nav.appendChild(el);
    });
  }

  function tickClock() {
    const el = document.getElementById('topbarDatetime');
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    el.textContent = `${dd} ${months[now.getMonth()]} ${now.getFullYear()} (${hh}:${mm} WIB)`;
  }

  function setupDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const dd = document.getElementById(dropdownId);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !dd.hidden;
      document.querySelectorAll('.dropdown').forEach((d) => (d.hidden = true));
      dd.hidden = isOpen;
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown').forEach((d) => (d.hidden = true));
  });

  setupDropdown('notifBtn', 'notifDropdown');
  setupDropdown('profileBtn', 'profileDropdown');

  // Mobile drawer
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('drawerOverlay');
  document.getElementById('menuBtn').addEventListener('click', () => {
    sidebar.classList.add('is-open');
    overlay.classList.add('is-open');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('is-open');
    overlay.classList.remove('is-open');
  });

  // Apply the current/default language to static [data-i18n] markup, then
  // wire the toggle. The sidebar is JS-generated, so it needs an explicit
  // re-render (with the permissions already loaded) on every switch.
  window.KaheI18n.apply(document);
  window.KaheI18n.initToggle((lang) => {
    renderSidebar(lastPermissions);
    showToast(t('lang_switch_toast'));
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  });

  // Load current user + permissions from the server (session is the auth authority)
  async function loadMe() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = '/login.html';
        return;
      }
      const data = await res.json();
      const user = data.user;
      document.getElementById('profileName').textContent = user.displayName;
      document.getElementById('profileRole').textContent = user.roleNames.join(', ');
      document.getElementById('avatarInitials').textContent = initials(user.displayName);
      renderSidebar(user.permissions || {});
    } catch (err) {
      window.location.href = '/login.html';
    }
  }

  // Show access-denied toast if server redirected us back from a protected page.
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('access') === 'denied') {
    setTimeout(() => showToast(t('module_no_access_title')), 600);
    history.replaceState({}, '', '/index.html');
  }

  tickClock();
  setInterval(tickClock, 30000);
  loadMe();
})();
