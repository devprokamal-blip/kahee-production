// tools/parity/dump-state.js — canonical dump of the complete business state of a database.
//   node dump-state.js sqlite <file> <out.json>      node dump-state.js pg <dbname> <out.json>
// Canonical form (identical rules on both engines):
//   * every A3 table, every column, rows ordered by primary key;
//   * wall-clock columns (TIMESTAMPTZ in the PostgreSQL schema = *_at / *_timestamp) -> 'T' | null;
//   * surrogate ids and every foreign key that points at one -> the row's ORDINAL within its table.
//     PostgreSQL sequences are not rolled back with a failed transaction, SQLite AUTOINCREMENT is,
//     so raw ids legitimately differ after any rolled-back insert; ordinals do not.
//   * JSON text is parsed and wall-clock keys inside it masked the same way.
// Money, rates, minutes, dates, statuses, hashes, references: compared RAW.
const fs = require('fs'); const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const [kind, target, outFile] = process.argv.slice(2);
const ref = new DatabaseSync(':memory:'); require(path.join(__dirname, '..', '..', 'database', 'legacy-sqlite', 'init-db')).initDb(ref);
const tables = ref.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const isClock = (c) => /(_at|timestamp)$/i.test(c);
const maskJson = (v) => { if (Array.isArray(v)) return v.map(maskJson); if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = /(_at|At|timestamp|Timestamp)$/.test(k) ? (v[k] === null ? null : 'T') : maskJson(v[k]); return o; } return v; };
(async () => {
  let all; let close = async () => {};
  if (kind === 'sqlite') { const db = new DatabaseSync(target); all = async (sql) => db.prepare(sql).all(); close = async () => db.close(); } else {
    const u = new URL(process.env.TEST_DATABASE_ADMIN_URL); u.pathname = `/${target}`;
    const { createDb } = require('../../database/db'); const db = createDb({ connectionString: u.toString(), max: 2 });
    all = async (sql) => db.prepare(sql).all(); close = async () => db.close(); }
  const meta = {}; const rows = {}; const ord = {};
  for (const t of tables) {
    const info = ref.prepare(`PRAGMA table_info(${t})`).all();
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const fks = {}; for (const f of ref.prepare(`PRAGMA foreign_key_list(${t})`).all()) fks[f.from] = f.table;
    meta[t] = { info, pk, fks, surrogate: pk.length === 1 && info.find((c) => c.name === pk[0]).type === 'INTEGER' };
    rows[t] = await all(`SELECT * FROM ${t} ORDER BY ${pk.length ? pk.join(',') : '1'}`);
    if (meta[t].surrogate) { ord[t] = new Map(); rows[t].forEach((r, i) => ord[t].set(r[pk[0]], i + 1)); }
  }
  const out = {};
  for (const t of tables) out[t] = rows[t].map((r) => { const o = {};
    for (const c of meta[t].info) { let v = r[c.name];
      if (isClock(c.name)) v = v === null ? null : 'T';
      else if (meta[t].surrogate && c.name === meta[t].pk[0]) v = ord[t].get(v);
      else if (v !== null && meta[t].fks[c.name] && ord[meta[t].fks[c.name]]) v = `#${ord[meta[t].fks[c.name]].get(v) ?? `?${v}`}`;
      else if (typeof v === 'string' && /^[[{]/.test(v)) { try { v = maskJson(JSON.parse(v)); } catch (_) { /* plain text */ } }
      o[c.name] = v; }
    return o; });
  fs.writeFileSync(outFile, JSON.stringify(out));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
