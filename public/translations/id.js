// translations/id.js — Bahasa Indonesia (default language for KAHE 360 Internal Operations)
(function () {
  window.KAHE_I18N = window.KAHE_I18N || {};
  window.KAHE_I18N.id = {
    // ---- Login: topbar tags ----
    tag_tenaga: 'TENAGA KERJA',
    tag_resource: 'RESOURCE',
    tag_kesehatan: 'KESEHATAN KERJA',
    tag_kontinuitas: 'KONTINUITAS',

    // ---- Login: hero copy ----
    hero_tagline_top: 'People. Projects.',
    hero_tagline_bottom: 'A Stronger Tomorrow.',
    hero_title_sub: 'INTERNAL OPERATIONS',
    hero_lead: 'Menggerakkan Tenaga Kerja.<br />Menjaga Operasi.<br />Mengamankan Kontinuitas Proyek.',
    hero_footnote: 'A CONNECTED WORKFORCE. A STRONGER TOMORROW.',
    badge_secure_title: 'SECURE ACCESS',
    badge_secure_sub: 'Your Data. Our Priority.',
    badge_role_title: 'ROLE BASED ACCESS',
    badge_role_sub: 'Right People. Right Access.',
    badge_project_title: 'PROJECT FOCUSED',
    badge_project_sub: 'One Platform. Multiple Projects.',
    badge_excellence_title: 'OPERATIONAL EXCELLENCE',
    badge_excellence_sub: 'Data Driven. People Powered.',

    // ---- Login: sign-in panel ----
    panel_welcome: 'Selamat Datang Kembali',
    panel_subtitle: 'Masuk ke Portal Operasi Internal KAHE 360°',
    field_email: 'Email / ID Pengguna',
    field_password: 'Kata Sandi',
    remember_device: 'Ingat perangkat ini',
    forgot_password: 'Lupa kata sandi?',
    sign_in: 'MASUK',
    or_label: 'atau',
    google_signin: 'Masuk dengan Google',
    legal_text: 'Hanya untuk Personel Berwenang. Seluruh aktivitas dipantau dan dicatat. Akses tanpa izin dilarang.',
    footer_strap: 'Orang yang Tepat. Resource yang Tepat. Siap pada Waktu yang Tepat.',

    // ---- Login: errors / toasts ----
    err_invalid: 'Email atau password salah.',
    err_generic: 'Terjadi kesalahan. Silakan coba lagi.',
    err_rate_limited: 'Terlalu banyak percobaan login. Coba lagi nanti.',
    google_toast: 'Google Sign-In belum dikonfigurasi pada environment development.',
    forgot_toast: 'Reset password belum tersedia pada environment development.',

    // ---- Home: topbar / chrome ----
    topbar_title_main: 'PORTAL OPERASI INTERNAL',
    topbar_title_sub: 'Manusia. Operasi. Kontinuitas.',
    topbar_live: 'Operasi Aktif',
    topbar_night_shift: 'Shift Malam',
    notif_title: 'Notifikasi',
    profile_logout: 'Keluar',
    lang_switch_toast: 'Bahasa diganti ke Indonesia.',
    module_wip_toast: 'Modul sedang dikembangkan.',
    module_no_access_title: 'Tidak memiliki akses ke modul ini.',

    // ---- Home: sidebar nav ----
    'nav.home': 'Beranda',
    'nav.command_center': 'Pusat Kendali',
    'nav.intelligence_planning': 'Intelijen & Perencanaan',
    'nav.talent_readiness': 'Talenta & Kesiapan',
    'nav.workforce_operations': 'Operasi Tenaga Kerja',
    'nav.performance_employment': 'Kinerja & Ketenagakerjaan',
    'nav.payroll_bpjs': 'Penggajian & BPJS',
    'nav.hrd_kontrak': 'HRD & Kontrak',
    'nav.timesheet_absensi': 'Timesheet & Absensi',
    'nav.attendance_config': 'Jadwal & Pola Kerja',
    'nav.attendance_correction': 'Koreksi & Audit Absensi',
    'nav.payroll_config': 'Payroll Configuration',
    'nav.worker_services': 'Layanan Pekerja',
    'nav.occupational_health': 'Kesehatan Kerja',
    'nav.hse_compliance': 'HSE & Kepatuhan',
    'nav.equipment_resource': 'Peralatan & Resource',
    'nav.contractor_control': 'Kendali Kontraktor',
    'nav.customer_control': 'Kendali Pelanggan',
    'nav.commercial': 'Komersial',
    'nav.reports_analytics': 'Laporan & Analitik',
    'nav.documents': 'Dokumen',
    'nav.demobilization': 'Demobilisasi',
    'nav.settings': 'Pengaturan',

    // ---- Home: KPI row ----
    'kpi.workforce': 'Tenaga Kerja',
    'kpi.readyTomorrow': 'Siap Besok',
    'kpi.criticalActions': 'Tindakan Kritis',
    'kpi.criticalActionsSub': 'Perlu Perhatian',
    'kpi.projectPhase': 'Fase Proyek',
    'kpi.dataHealth': 'Kesehatan Data',
    'kpi.systemOnline': 'Sistem Aktif',

    // ---- Home: panel headers ----
    'panel.workforceToday': 'Tenaga Kerja Hari Ini',
    'panel.currentGap': 'Kesenjangan Operasional Saat Ini',
    'panel.actionRequired': 'Perlu Tindakan',
    'panel.manpowerControl': 'Kendali Tenaga Kerja',
    'panel.readinessFunnel': 'Funnel Kesiapan',
    'panel.readyByStatus': 'Status Kesiapan',
    'panel.serviceHealth': 'Kinerja Layanan',
    'panel.wuhuanCommitments': 'Komitmen kepada Wuhuan',
    'panel.upcomingDemand': 'Kebutuhan Resource Mendatang',

    // ---- Home: panel link buttons ----
    'action.detail': 'Detail ›',
    'action.viewAll': 'Lihat Semua ›',

    // ---- Home: Workforce Today stat labels ----
    'label.planned': 'Direncanakan',
    'label.ready': 'Siap',
    'label.present': 'Hadir',
    'label.deployed': 'Ditempatkan',
    'label.onTask': 'Aktif Bertugas',

    // ---- Home: Current Operational Gap ----
    'label.workers': 'pekerja',
    'label.absence': 'Ketidakhadiran',
    'label.compliance': 'Kepatuhan',
    'label.waitingMobilization': 'Menunggu Mobilisasi',
    'label.assignment': 'Penempatan',
    'label.transport': 'Transportasi',
    'label.replacement': 'Penggantian',
    'label.other': 'Lainnya',

    // ---- Home: Manpower Control ----
    'label.attendance': 'Kehadiran',
    'label.overtime': 'Lembur',
    'label.payroll': 'Penggajian',
    'label.bpjs': 'BPJS',
    'label.workerKpi': 'KPI Pekerja',
    'label.approved': 'Disetujui',
    'label.pending': 'Menunggu',
    'label.rejected': 'Ditolak',
    'label.problem': 'Bermasalah',
    'label.belowTarget': 'Di Bawah Target',

    // ---- Home: Ready-By Status ----
    'label.today': 'Hari Ini',
    'label.next3': '3 Hari Berikutnya',
    'label.next7': '7 Hari Berikutnya',
    'label.next14': '14 Hari Berikutnya',

    // ---- Home: Service Health ----
    'label.accommodation': 'Akomodasi',
    'label.mobilityTransport': 'Mobilitas / Transportasi',
    'label.meals': 'Makanan',
    'label.laundry': 'Laundry',
    'label.occupationalHealth': 'Kesehatan Kerja',
    'label.equipment': 'Peralatan',

    // ---- Home: readiness funnel stages ----
    'funnel.sourced': 'Disumberkan',
    'funnel.screened': 'Disaring',
    'funnel.verified': 'Terverifikasi',
    'funnel.compliant': 'Patuh',
    'funnel.ready': 'Siap',
    'funnel.mobilized': 'Dimobilisasi',
    'funnel.deployed': 'Ditempatkan',

    // ---- Home: Wuhuan Commitments table ----
    'table.item': 'Item',
    'table.qty': 'Qty',
    'table.ready': 'Siap',

    // ---- Home: Upcoming Resource Demand ----
    'demand.30': '30 Hari',
    'demand.60': '60 Hari',
    'demand.90': '90 Hari',

    // ---- Home: footer ----
    'footer.brand': 'KAHE 360° WORKFORCE SOLUTIONS',
    'footer.strap': 'Orang yang Tepat. Resource yang Tepat. Siap pada Waktu yang Tepat.',
    'footer.tagline': 'MANUSIA. PROYEK. KEMAJUAN. MASA DEPAN YANG LEBIH KUAT.',
  };
})();
