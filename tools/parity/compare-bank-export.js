// tools/parity/compare-bank-export.js <a3.bank.json> <pg.bank.json> — byte comparison of regenerated, clock-masked bank files.
const fs = require('fs'); const [fa, fb] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(fa)); const b = JSON.parse(fs.readFileSync(fb));
let diffs = a.length === b.length ? 0 : 1; let lines = 0; let total = 0;
a.forEach((x, i) => { const y = b[i] || {}; lines += x.content.split('\n').length; total += x.total_sen;
  for (const k of ['format', 'filename', 'instructions', 'total_sen', 'content', 'masked_content_sha256']) if (x[k] !== y[k]) diffs += 1; });
console.log(JSON.stringify({ files: a.length, file_lines: lines, total_sen: total,
  a3_reproduces_stored_hash: a.filter((x) => x.reproduces_stored_hash).length, pg_reproduces_stored_hash: b.filter((x) => x.reproduces_stored_hash).length, diffs }));
process.exit(diffs ? 1 : 0);
