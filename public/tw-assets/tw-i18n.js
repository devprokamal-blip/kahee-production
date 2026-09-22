// tw-i18n.js — Talent & Worker V1 shell dictionary (ID primary, EN secondary).
// Shares the portal's language preference key so a user's ID/EN choice is the same everywhere.
// UI preference only; it has no bearing on authentication or authorization.
(function () {
  const STORAGE_KEY = 'kahe360.lang';
  const DICT = {
    id: {
      'shell.skip': 'Lewati ke konten',
      'shell.menu': 'Menu',
      'shell.product_sub': 'From People Registration to Workforce Readiness',
      'shell.logout': 'Keluar',
      'shell.portal_link': 'Portal KAHE 360°',
      'shell.crumb_root': 'Talent Management',
      'shell.load_error': 'Data sesi tidak dapat dimuat. Muat ulang halaman; bila berulang, hubungi administrator.',
      'shell.locked': 'Tidak ada akses',
      'page.home.title': 'Beranda Talent & Worker',
      'page.home.lede': 'Satu identitas digital untuk setiap pekerja, dari registrasi hingga penugasan.',
      'page.dashboard.title': 'Dashboard',
      'page.dashboard.lede': 'Ringkasan kondisi talenta dan kesiapan tenaga kerja.',
      'page.candidate_registration.title': 'Candidate Registration',
      'page.candidate_registration.lede': 'Pendaftaran kandidat dan daftar registrasi baru untuk ditinjau.',
      'page.talent_pool.title': 'Talent Pool',
      'page.talent_pool.lede': 'Talenta terverifikasi, profil digital, kesiapan, dan pencocokan proyek.',
      'page.verification_screening.title': 'Verification & Screening',
      'page.verification_screening.lede': 'Tinjau data kandidat dan petakan ke struktur posisi KAHE.',
      'page.deployment_assignment.title': 'Deployment & Assignment Control',
      'page.deployment_assignment.lede': 'Mobilisasi, keberangkatan, kedatangan, dan penugasan di lokasi proyek.',
      'page.contract_placement.title': 'Contract & Placement',
      'page.contract_placement.lede': 'Kontrak kerja dan penempatan tenaga kerja di proyek.',
      'page.reports_analytics.title': 'Reports & Analytics',
      'page.reports_analytics.lede': 'Laporan talenta dan tenaga kerja.',
      'page.settings.title': 'Settings — Security & Access',
      'page.settings.lede': 'Peran, izin, cakupan data, dan keamanan field.',
      'empty.title': 'Halaman ini belum aktif',
      'empty.body': 'Fondasi keamanan dan identitas sudah siap. Fungsi halaman ini dibangun pada tahap pengembangan berikutnya.',
      'empty.stage': 'Tahap',
      'home.account': 'Akses Anda',
      'home.roles': 'Peran',
      'home.scope': 'Cakupan data',
      'home.scope_all': 'Semua data talenta',
      'home.scope_none': 'Belum ada cakupan data. Hubungi administrator.',
      'home.modules': 'Menu yang dapat Anda buka',
      'home.integrations': 'Integrasi Worker Passport',
      'home.integrations_note': 'Data operasional berikut belum terhubung ke Worker Passport. Tidak ada data yang ditampilkan sampai integrasinya disetujui dan dibangun.',
      'home.integration_status': 'Belum terhubung',
      'integration.ATTENDANCE': 'Absensi',
      'integration.OVERTIME': 'Lembur (OT)',
      'integration.PAYROLL': 'Payroll',
      'integration.BPJS': 'BPJS',
      'integration.ACCOMMODATION': 'Akomodasi',
      'integration.MOBILITY': 'Mobilitas',
      'integration.MEALS': 'Makan',
    },
    en: {
      'shell.skip': 'Skip to content',
      'shell.menu': 'Menu',
      'shell.product_sub': 'From People Registration to Workforce Readiness',
      'shell.logout': 'Sign out',
      'shell.portal_link': 'KAHE 360° Portal',
      'shell.crumb_root': 'Talent Management',
      'shell.load_error': 'Your session data could not be loaded. Reload the page; if it happens again, contact the administrator.',
      'shell.locked': 'No access',
      'page.home.title': 'Talent & Worker Home',
      'page.home.lede': 'One digital identity for every worker, from registration to assignment.',
      'page.dashboard.title': 'Dashboard',
      'page.dashboard.lede': 'Overview of talent and workforce readiness.',
      'page.candidate_registration.title': 'Candidate Registration',
      'page.candidate_registration.lede': 'Candidate sign-up and the list of new registrations to review.',
      'page.talent_pool.title': 'Talent Pool',
      'page.talent_pool.lede': 'Verified talent, digital profiles, readiness and project matching.',
      'page.verification_screening.title': 'Verification & Screening',
      'page.verification_screening.lede': 'Review candidate data and map it to the KAHE position structure.',
      'page.deployment_assignment.title': 'Deployment & Assignment Control',
      'page.deployment_assignment.lede': 'Mobilization, departure, arrival and on-site assignment.',
      'page.contract_placement.title': 'Contract & Placement',
      'page.contract_placement.lede': 'Employment contracts and project placement.',
      'page.reports_analytics.title': 'Reports & Analytics',
      'page.reports_analytics.lede': 'Talent and workforce reports.',
      'page.settings.title': 'Settings — Security & Access',
      'page.settings.lede': 'Roles, permissions, data scope and field security.',
      'empty.title': 'This page is not active yet',
      'empty.body': 'The security and identity foundation is in place. This page’s functions are built in a later development stage.',
      'empty.stage': 'Stage',
      'home.account': 'Your access',
      'home.roles': 'Roles',
      'home.scope': 'Data scope',
      'home.scope_all': 'All talent data',
      'home.scope_none': 'No data scope yet. Contact the administrator.',
      'home.modules': 'Menus you can open',
      'home.integrations': 'Worker Passport integrations',
      'home.integrations_note': 'The operational data below is not connected to the Worker Passport yet. Nothing is shown until each integration is approved and built.',
      'home.integration_status': 'Not connected',
      'integration.ATTENDANCE': 'Attendance',
      'integration.OVERTIME': 'Overtime (OT)',
      'integration.PAYROLL': 'Payroll',
      'integration.BPJS': 'BPJS',
      'integration.ACCOMMODATION': 'Accommodation',
      'integration.MOBILITY': 'Mobility',
      'integration.MEALS': 'Meals',
    },
  };

  function getLang() {
    let v = null;
    try { v = window.localStorage.getItem(STORAGE_KEY); } catch (_) { /* storage unavailable */ }
    return v === 'en' || v === 'id' ? v : 'id';
  }
  function setLang(lang) {
    if (lang !== 'id' && lang !== 'en') return;
    try { window.localStorage.setItem(STORAGE_KEY, lang); } catch (_) { /* storage unavailable */ }
  }
  function t(key) {
    const lang = getLang();
    if (Object.prototype.hasOwnProperty.call(DICT[lang], key)) return DICT[lang][key];
    const other = DICT[lang === 'id' ? 'en' : 'id'];
    if (Object.prototype.hasOwnProperty.call(other, key)) return other[key];
    return key.split('.').pop();
  }
  window.TwI18n = { DICT, getLang, setLang, t };
}());
