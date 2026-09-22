// tools/dbm1/verify-mechanical.js — DB-M1 evidence. For every converted file, strip
// the MECHANICAL transformations (async/await, RETURNING id, the fixed dialect
// substitutions) from both versions and report what is left: those residual lines
// are the only hand-made edits and each must be justified in the migration record.
//   node tools/dbm1/verify-mechanical.js <A3 root> file...
const fs = require('fs'); const path = require('path');
const A3 = process.argv[2];
const normOld = (s) => s.replace(/datetime\('now'\)/g, 'kahe_now()').replace(/\bIFNULL\(/g, 'COALESCE(')
  .replace(/date\(\?, '-1 day'\)/g, 'kahe_date_add(?::date, -1)').replace(/date\('(\d{4}-\d\d-\d\d)',\s*'-1 day'\)/g, "kahe_date_add('$1'::date, -1)")
  .replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO');
const normNew = (s) => s.replace(/^\(async \(\) => \{\n/, '').replace(/\n\}\)\(\)\.catch\(\(err\) => \{ console\.error\(err\); process\.exit\(1\); \}\);\n$/, '')
  .replace(/ ON CONFLICT DO NOTHING/g, '').replace(/ RETURNING id/g, '');
const squash = (s) => s.replace(/\basync\s+/g, '').replace(/\bawait\s+/g, '').replace(/[()\s;]/g, '');
let total = 0;
for (const f of process.argv.slice(3)) {
  const oldP = path.join(A3, f); if (!fs.existsSync(oldP)) { console.log(`${f}: NEW FILE`); continue; }
  const a = normOld(fs.readFileSync(oldP, 'utf8')).split('\n').map(squash).filter(Boolean);
  const b = normNew(fs.readFileSync(f, 'utf8')).split('\n').map(squash).filter(Boolean);
  const setA = new Map(); for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
  const added = []; for (const l of b) { if (setA.get(l)) setA.set(l, setA.get(l) - 1); else added.push(l); }
  const removed = [...setA.entries()].filter(([, n]) => n > 0).length;
  total += added.length;
  console.log(`${f}: residual +${added.length} / -${removed}`);
  if (process.env.SHOW) for (const l of added) console.log(`      + ${l.slice(0, 140)}`);
}
console.log(`TOTAL residual added lines: ${total}`);
