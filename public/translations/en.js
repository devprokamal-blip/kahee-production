// translations/en.js — English
(function () {
  window.KAHE_I18N = window.KAHE_I18N || {};
  window.KAHE_I18N.en = {
    // ---- Login: topbar tags ----
    tag_tenaga: 'WORKFORCE',
    tag_resource: 'RESOURCE',
    tag_kesehatan: 'OCCUPATIONAL HEALTH',
    tag_kontinuitas: 'CONTINUITY',

    // ---- Login: hero copy ----
    hero_tagline_top: 'People. Projects.',
    hero_tagline_bottom: 'A Stronger Tomorrow.',
    hero_title_sub: 'INTERNAL OPERATIONS',
    hero_lead: 'Driving the Workforce.<br />Safeguarding Operations.<br />Securing Project Continuity.',
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
    panel_welcome: 'Welcome Back',
    panel_subtitle: 'Sign in to KAHE 360° Internal Operations Portal',
    field_email: 'Email / User ID',
    field_password: 'Password',
    remember_device: 'Remember this device',
    forgot_password: 'Forgot password?',
    sign_in: 'SIGN IN',
    or_label: 'or',
    google_signin: 'Sign in with Google',
    legal_text: 'Authorized Personnel Only. All activities are monitored and recorded. Unauthorized access is prohibited.',
    footer_strap: 'The Right People. The Right Resource. Ready on the Right Time.',

    // ---- Login: errors / toasts ----
    err_invalid: 'Incorrect email or password.',
    err_generic: 'Something went wrong. Please try again.',
    err_rate_limited: 'Too many login attempts. Try again later.',
    google_toast: 'Google Sign-In is not configured in the development environment.',
    forgot_toast: 'Password reset is not available in the development environment.',

    // ---- Home: topbar / chrome ----
    topbar_title_main: 'INTERNAL OPERATIONS PORTAL',
    topbar_title_sub: 'People. Operations. Continuity.',
    topbar_live: 'Live Operations',
    topbar_night_shift: 'Night Shift',
    notif_title: 'Notifications',
    profile_logout: 'Logout',
    lang_switch_toast: 'Language switched to English.',
    module_wip_toast: 'This module is under development.',
    module_no_access_title: 'You do not have access to this module.',

    // ---- Home: sidebar nav ----
    'nav.home': 'Home',
    'nav.command_center': 'Command Center',
    'nav.intelligence_planning': 'Intelligence & Planning',
    'nav.talent_readiness': 'Talent & Readiness',
    'nav.workforce_operations': 'Workforce Operations',
    'nav.performance_employment': 'Performance & Employment',
    'nav.payroll_bpjs': 'Payroll & BPJS',
    'nav.hrd_kontrak': 'HRD & Contracts',
    'nav.timesheet_absensi': 'Timesheet & Attendance',
    'nav.attendance_config': 'Work Schedule & Patterns',
    'nav.attendance_correction': 'Attendance Correction & Audit',
    'nav.payroll_config': 'Payroll Configuration',
    'nav.worker_services': 'Worker Services',
    'nav.occupational_health': 'Occupational Health',
    'nav.hse_compliance': 'HSE & Compliance',
    'nav.equipment_resource': 'Equipment & Resource',
    'nav.contractor_control': 'Contractor Control',
    'nav.customer_control': 'Customer Control',
    'nav.commercial': 'Commercial',
    'nav.reports_analytics': 'Reports & Analytics',
    'nav.documents': 'Documents',
    'nav.demobilization': 'Demobilization',
    'nav.settings': 'Settings',

    // ---- Home: KPI row ----
    'kpi.workforce': 'Workforce',
    'kpi.readyTomorrow': 'Ready Tomorrow',
    'kpi.criticalActions': 'Critical Actions',
    'kpi.criticalActionsSub': 'Requiring Attention',
    'kpi.projectPhase': 'Project Phase',
    'kpi.dataHealth': 'Data Health',
    'kpi.systemOnline': 'System Online',

    // ---- Home: panel headers ----
    'panel.workforceToday': 'Workforce Today',
    'panel.currentGap': 'Current Operational Gap',
    'panel.actionRequired': 'Action Required',
    'panel.manpowerControl': 'Manpower Control',
    'panel.readinessFunnel': 'Readiness Funnel',
    'panel.readyByStatus': 'Ready-By Status',
    'panel.serviceHealth': 'Service Health',
    'panel.wuhuanCommitments': 'Wuhuan Commitments',
    'panel.upcomingDemand': 'Upcoming Resource Demand',

    // ---- Home: panel link buttons ----
    'action.detail': 'Detail ›',
    'action.viewAll': 'View All ›',

    // ---- Home: Workforce Today stat labels ----
    'label.planned': 'Planned',
    'label.ready': 'Ready',
    'label.present': 'Present',
    'label.deployed': 'Deployed',
    'label.onTask': 'On Task',

    // ---- Home: Current Operational Gap ----
    'label.workers': 'workers',
    'label.absence': 'Absence',
    'label.compliance': 'Compliance',
    'label.waitingMobilization': 'Waiting Mobilization',
    'label.assignment': 'Assignment',
    'label.transport': 'Transport',
    'label.replacement': 'Replacement',
    'label.other': 'Other',

    // ---- Home: Manpower Control ----
    'label.attendance': 'Attendance',
    'label.overtime': 'Overtime',
    'label.payroll': 'Payroll',
    'label.bpjs': 'BPJS',
    'label.workerKpi': 'Worker KPI',
    'label.approved': 'Approved',
    'label.pending': 'Pending',
    'label.rejected': 'Rejected',
    'label.problem': 'Problem',
    'label.belowTarget': 'Below Target',

    // ---- Home: Ready-By Status ----
    'label.today': 'Today',
    'label.next3': 'Next 3 Days',
    'label.next7': 'Next 7 Days',
    'label.next14': 'Next 14 Days',

    // ---- Home: Service Health ----
    'label.accommodation': 'Accommodation',
    'label.mobilityTransport': 'Mobility / Transport',
    'label.meals': 'Meals',
    'label.laundry': 'Laundry',
    'label.occupationalHealth': 'Occupational Health',
    'label.equipment': 'Equipment',

    // ---- Home: readiness funnel stages ----
    'funnel.sourced': 'Sourced',
    'funnel.screened': 'Screened',
    'funnel.verified': 'Verified',
    'funnel.compliant': 'Compliant',
    'funnel.ready': 'Ready',
    'funnel.mobilized': 'Mobilized',
    'funnel.deployed': 'Deployed',

    // ---- Home: Wuhuan Commitments table ----
    'table.item': 'Item',
    'table.qty': 'Qty',
    'table.ready': 'Ready',

    // ---- Home: Upcoming Resource Demand ----
    'demand.30': '30 Days',
    'demand.60': '60 Days',
    'demand.90': '90 Days',

    // ---- Home: footer ----
    'footer.brand': 'KAHE 360° WORKFORCE SOLUTIONS',
    'footer.strap': 'The Right People. The Right Resource. Ready on the Right Time.',
    'footer.tagline': 'PEOPLE. PROJECTS. PROGRESS. A STRONGER TOMORROW.',
  };
})();
