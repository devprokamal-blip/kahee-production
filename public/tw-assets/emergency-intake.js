// emergency-intake.js — EMERGENCY REGISTRATION INTAKE V0 (internal list). Not P05. Server enforces RBAC/field security.
(function () {
  const COLS = ['registration_id', 'full_name', 'whatsapp', 'email', 'current_city', 'latest_position', 'registered_at', 'status', 'possible_duplicate'];
  const LIMIT = 50;
  let offset = 0; let total = 0;
  const $ = (id) => document.getElementById(id);
  async function load() {
    const q = $('eiQ').value.trim();
    const res = await fetch(`/api/tw/emergency-intake/registrations?limit=${LIMIT}&offset=${offset}&q=${encodeURIComponent(q)}`,
      { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (!res.ok) { $('eiError').textContent = 'Data tidak dapat dimuat. Periksa akses Anda atau muat ulang halaman.'; $('eiError').hidden = false; return; }
    const data = await res.json();
    total = data.total;
    const body = $('eiRows'); body.textContent = '';
    if (!data.rows.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = COLS.length;
      td.textContent = q ? 'Tidak ada pendaftaran yang cocok dengan pencarian.' : 'Belum ada pendaftaran.'; tr.appendChild(td); body.appendChild(tr);
    }
    for (const r of data.rows) {
      const tr = document.createElement('tr');
      for (const c of COLS) {
        const td = document.createElement('td');
        const v = r[c] === undefined ? '—' : r[c];
        td.textContent = c === 'status' && v === 'NEW' ? 'NEW — menunggu review' : (c === 'possible_duplicate' ? (v === 'YES' ? 'Ya' : 'Tidak') : (v === null ? '—' : v));
        if (c === 'possible_duplicate' && v === 'YES') td.className = 'ei-dup';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    $('eiTotal').textContent = `${total} pendaftaran`;
    $('eiPage').textContent = total ? `${offset + 1}–${Math.min(offset + LIMIT, total)} dari ${total}` : '';
    $('eiPrev').disabled = offset === 0; $('eiNext').disabled = offset + LIMIT >= total;
  }
  async function exportAllowed() {
    const r = await fetch('/api/tw/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const me = await r.json();
    const a = me.permissions.tw_emergency_intake || [];
    $('eiExport').hidden = !a.includes('EXPORT');
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('eiSearch').addEventListener('click', () => { offset = 0; load(); });
    $('eiQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { offset = 0; load(); } });
    $('eiPrev').addEventListener('click', () => { offset = Math.max(0, offset - LIMIT); load(); });
    $('eiNext').addEventListener('click', () => { offset += LIMIT; load(); });
    load(); exportAllowed();
  });
}());
