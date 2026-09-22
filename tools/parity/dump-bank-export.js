// tools/parity/dump-bank-export.js <sqlite|pg> <target> <out.json> — DB-M1 CP3.
// The bank file is not stored, only its hash — and that hash covers the batch reference, which
// ends in a wall-clock token, so two runs can never hash alike (not even SQLite vs SQLite).
// This regenerates every exported bank file from the stored batch + instructions with the PURE
// lib/bankExport.js of the engine under test, proves the regenerated file reproduces the STORED
// export_hash (self-consistency), then masks the clock token so the two engines can be compared
// byte for byte.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const [kind, target, outFile] = process.argv.slice(2);
const root = kind === 'sqlite' ? process.env.KAHE_A3_ROOT : path.join(__dirname, '..', '..');
const bankExport = require(path.join(root, 'lib', 'bankExport'));
const mask = (s) => String(s).replace(/(PB-[A-Za-z0-9_]+-\d{6}-)[0-9A-Z]{8,9}/g, '$1<CLOCK>');
(async () => {
  let all; let close;
  if (kind === 'sqlite') { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(target); all = async (q, ...p) => db.prepare(q).all(...p); close = async () => db.close(); } else {
    const u = new URL(process.env.TEST_DATABASE_ADMIN_URL); u.pathname = `/${target}`;
    const db = require('../../database/db').createDb({ connectionString: u.toString(), max: 2 }); all = (q, ...p) => db.prepare(q).all(...p); close = () => db.close(); }
  const out = [];
  for (const b of await all('SELECT * FROM payroll_payment_batches WHERE export_format IS NOT NULL ORDER BY id')) {
    const period = (await all('SELECT * FROM payroll_periods WHERE id = ?', b.payroll_period_id))[0];
    const items = await all(`SELECT * FROM payroll_payment_items WHERE batch_id = ? AND status NOT IN ('PENDING','EXCLUDED','CANCELLED') ORDER BY employee_id`, b.id);
    const file = bankExport.buildExport(b.export_format, { ...b, period_label: `${period.period_year}-${String(period.period_sequence).padStart(2, '0')}` }, items);
    const content = mask(file.content);
    out.push({ format: b.export_format, filename: mask(file.filename), instructions: items.length, total_sen: items.reduce((n, i) => n + i.amount_sen, 0),
      reproduces_stored_hash: file.content_hash === b.export_hash, masked_content_sha256: crypto.createHash('sha256').update(content).digest('hex'), content });
  }
  fs.writeFileSync(outFile, JSON.stringify(out)); await close();
})().catch((e) => { console.error(e); process.exit(1); });
