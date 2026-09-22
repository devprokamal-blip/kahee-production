// tw-shell.js — Talent & Worker V1 internal shell (P05–P16).
// The server decides everything that matters: which pages open (guarded routes) and which menu
// items are enabled (/api/tw/me). This script only renders. All API URLs are relative.
(function () {
  const t = window.TwI18n.t;
  const BASE = '/tw/app';

  // Canonical sidebar labels (locked). Order and enablement come from the server.
  const LABELS = {
    home: 'HOME',
    dashboard: 'DASHBOARD',
    candidate_registration: 'CANDIDATE REGISTRATION',
    talent_pool: 'TALENT POOL',
    verification_screening: 'VERIFICATION & SCREENING',
    deployment_assignment: 'DEPLOYMENT & ASSIGNMENT CONTROL',
    contract_placement: 'CONTRACT & PLACEMENT',
    reports_analytics: 'REPORTS & ANALYTICS',
    settings: 'SETTINGS',
  };
  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
    candidate_registration: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0M19 8v6M16 11h6',
    talent_pool: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm8 0a3 3 0 1 0 0-6M2 20a7 7 0 0 1 14 0M17 14a5 5 0 0 1 5 6',
    verification_screening: 'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2 6 6M7 10l2 2 4-4',
    deployment_assignment: 'M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6',
    contract_placement: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
    reports_analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3 2-1-1-3-2 .3-1.5-1.5L17.8 5 15 4l-1 2h-2l-1-2-3 1 .3 2.2L6.8 8.7 5 8.5 4 11.5l2 1v1l-2 1 1 3 2-.3 1.5 1.5-.3 2.3 3 1 1-2h2l1 2 3-1-.3-2.2 1.5-1.5 2 .3 1-3-2-1z',
  };
  // Development stage in which each page's functions are built (approved checkpoint plan).
  const STAGE = {
    dashboard: 'CP9', candidate_registration: 'CP2 – CP3', talent_pool: 'CP4 – CP5',
    verification_screening: 'CP3', deployment_assignment: 'CP6 – CP7', contract_placement: 'CP7',
    reports_analytics: 'CP9', settings: 'CP9',
  };

  function pageCode() {
    let p = window.location.pathname.replace(/\/+$/, '');
    if (p === BASE || p === '') return 'home';
    p = p.slice(BASE.length + 1);
    const code = p.replace(/-/g, '_');
    return Object.prototype.hasOwnProperty.call(LABELS, code) ? code : 'home';
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v);
    }
    for (const c of children || []) if (c) n.appendChild(c);
    return n;
  }

  function icon(code) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'tw-nav-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[code] || ''); svg.appendChild(path);
    return svg;
  }

  function applyStaticI18n() {
    document.documentElement.lang = window.TwI18n.getLang();
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    document.querySelectorAll('.tw-lang button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === window.TwI18n.getLang()));
    });
  }

  function renderNav(nav, current) {
    const ul = document.getElementById('twNav');
    ul.textContent = '';
    for (const item of nav) {
      const label = LABELS[item.code] || item.code;
      let node;
      if (item.enabled) {
        node = el('a', { href: item.href, class: 'tw-nav-link' }, [icon(item.code), el('span', { text: label })]);
        if (item.code === current) { node.setAttribute('aria-current', 'page'); node.classList.add('is-active'); }
      } else {
        node = el('span', { class: 'tw-nav-link is-locked', 'aria-disabled': 'true', title: t('shell.locked') },
          [icon(item.code), el('span', { text: label })]);
      }
      ul.appendChild(el('li', null, [node]));
    }
  }

  function renderHeader(me) {
    const name = me.user.display_name || '';
    document.getElementById('twUserName').textContent = name;
    document.getElementById('twUserRole').textContent = (me.user.role_names || []).join(', ');
    document.getElementById('twAvatar').textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  function renderTitle(code) {
    document.title = `${t(`page.${code}.title`)} — KAHE Talent`;
    document.getElementById('twTitle').textContent = t(`page.${code}.title`);
    document.getElementById('twLede').textContent = t(`page.${code}.lede`);
    const bc = document.getElementById('twBreadcrumb');
    bc.textContent = '';
    bc.appendChild(el('li', { text: t('shell.crumb_root') }));
    bc.appendChild(el('li', { text: t(`page.${code}.title`), 'aria-current': 'page' }));
  }

  function renderEmpty(code) {
    const box = document.getElementById('twContent');
    box.textContent = '';
    box.appendChild(el('section', { class: 'tw-panel tw-empty' }, [
      el('h2', { text: t('empty.title') }),
      el('p', { text: t('empty.body') }),
      el('p', { class: 'tw-stage' }, [el('span', { text: `${t('empty.stage')}: ` }), el('strong', { text: STAGE[code] || '—' })]),
    ]));
  }

  async function renderHome(me) {
    const box = document.getElementById('twContent');
    box.textContent = '';
    const open = me.nav.filter((n) => n.enabled && n.code !== 'home').map((n) => el('li', null, [el('a', { href: n.href, text: LABELS[n.code] })]));
    const scopeText = me.scope.all ? t('home.scope_all') : t('home.scope_none');
    box.appendChild(el('section', { class: 'tw-panel tw-account' }, [
      el('h2', { text: t('home.account') }),
      el('dl', null, [
        el('dt', { text: t('home.roles') }), el('dd', { text: (me.user.role_names || []).join(', ') || '—' }),
        el('dt', { text: t('home.scope') }), el('dd', { text: scopeText, class: me.scope.all ? '' : 'is-warning' }),
      ]),
      el('h3', { text: t('home.modules') }),
      el('ul', { class: 'tw-open-list' }, open),
    ]));
    const canPassport = Array.isArray(me.permissions.tw_worker_passport) && me.permissions.tw_worker_passport.includes('VIEW');
    if (!canPassport) return;
    const res = await fetch('/api/tw/integrations', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    const rows = data.integrations.map((i) => el('tr', null, [
      el('th', { scope: 'row', text: t(`integration.${i.code}`) }),
      el('td', null, [el('span', { class: 'tw-pill tw-pill-pending', text: t('home.integration_status') })]),
    ]));
    box.appendChild(el('section', { class: 'tw-panel tw-integrations' }, [
      el('h2', { text: t('home.integrations') }),
      el('p', { class: 'tw-note', text: t('home.integrations_note') }),
      el('div', { class: 'tw-table-wrap' }, [el('table', { class: 'tw-table' }, [el('tbody', null, rows)])]),
    ]));
  }

  function wireDrawer() {
    const btn = document.getElementById('twMenuBtn');
    const scrim = document.getElementById('twScrim');
    const setOpen = (open) => {
      document.body.classList.toggle('tw-drawer-open', open);
      btn.setAttribute('aria-expanded', String(open));
      scrim.hidden = !open;
    };
    btn.addEventListener('click', () => setOpen(!document.body.classList.contains('tw-drawer-open')));
    scrim.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }

  async function main() {
    applyStaticI18n();
    wireDrawer();
    const code = pageCode();
    renderTitle(code);
    document.querySelectorAll('.tw-lang button').forEach((b) => b.addEventListener('click', () => {
      window.TwI18n.setLang(b.getAttribute('data-lang')); window.location.reload();
    }));
    document.getElementById('twLogout').addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } finally { window.location.href = '/login.html'; }
    });
    let me;
    try {
      const res = await fetch('/api/tw/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      if (!res.ok) throw new Error(String(res.status));
      me = await res.json();
    } catch (_) {
      const box = document.getElementById('twContent');
      box.textContent = '';
      box.appendChild(el('p', { class: 'tw-panel tw-error', role: 'alert', text: t('shell.load_error') }));
      return;
    }
    renderHeader(me);
    renderNav(me.nav, code);
    if (code === 'home') await renderHome(me); else renderEmpty(code);
  }

  document.addEventListener('DOMContentLoaded', main);
}());
