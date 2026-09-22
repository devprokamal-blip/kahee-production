// tools/parity/compare-state.js <a3.json> <pg.json> — exact comparison; prints counts and the first differences.
const fs = require('fs'); const [fa, fb] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(fa)); const b = JSON.parse(fs.readFileSync(fb));
// The payment batch reference ends in Date.now().toString(36) (lib/payrollPayment.js) — a wall-clock token, masked like every other clock value.
const clock = (x) => x.replace(/(PB-[A-Za-z0-9_]+-\d{6}-)[0-9A-Z]{8,9}/g, '$1<CLOCK>');
// The bank-file hash covers file content that contains that clock token, so it can never be equal between two
// runs. It is NOT ignored: tools/parity/dump-bank-export.js regenerates each file, proves it reproduces the STORED
// hash on its own engine, and compares the clock-masked content byte for byte. Here it is only set aside and counted.
let deferred = 0;
const exportHash = (t, c, v) => { if (v === null || v === undefined) return v;
  if (t === 'payroll_payment_batches' && c === 'export_hash') { deferred += 1; return '<verified by bank-export parity>'; }
  if (t === 'payroll_payment_events' && c === 'detail' && v && typeof v === 'object' && 'hash' in v && 'filename' in v) { deferred += 1; return { ...v, hash: '<verified by bank-export parity>' }; }
  return v; };
let tables = 0; let rows = 0; let values = 0; let money = 0; const diffs = [];
for (const t of Object.keys(a)) { if (!a[t].length && !b[t].length) continue; tables += 1;
  if (a[t].length !== b[t].length) { diffs.push(`${t}: row count ${a[t].length} vs ${b[t].length}`); continue; }
  a[t].forEach((ra, i) => { rows += 1; for (const c of Object.keys(ra)) { values += 1; if (/_sen$|_bp$|minutes|_hash$|quantity|amount/.test(c)) money += 1;
    const x = clock(JSON.stringify(exportHash(t, c, ra[c]))); const y = clock(JSON.stringify(exportHash(t, c, b[t][i][c]))); if (x !== y) diffs.push(`${t}[${i + 1}].${c}: ${x.slice(0, 90)} vs ${y.slice(0, 90)}`); } }); }
console.log(JSON.stringify({ tables, rows, values, money_time_hash_values: money, export_hashes_deferred: deferred / 2, diffs: diffs.length }));
const byCol = {}; for (const d of diffs) { const k = d.replace(/\[\d+\]/, '[]').split(':')[0]; byCol[k] = (byCol[k] || 0) + 1; }
for (const [k, n] of Object.entries(byCol).slice(0, 12)) console.log(`   ${n} × ${k}   e.g. ${diffs.find((d) => d.replace(/\[\d+\]/, '[]').startsWith(k + ':'))}`.slice(0, 330));
process.exit(diffs.length ? 1 : 0);
