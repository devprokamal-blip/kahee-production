// scripts/check-payroll-pure-formulas.js
// DB-M1 guard. The four PURE BUSINESS / FORMULA files of the payroll core hold
// every monetary formula and perform no database access. The SQLite -> PostgreSQL
// migration has no reason to touch them, so they must stay BYTE-IDENTICAL to the
// original PAYROLL_CORE_STABLE_V1 (SQLite) freeze — permanently, even after the
// PostgreSQL re-baseline. This check reads the PRESERVED historical lock, never
// the current one, so re-baselining cannot hide a formula change.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const V1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'freeze-history', 'PAYROLL_CORE_STABLE_V1.sqlite.lock.json'), 'utf8'));
const PURE = ['lib/money.js', 'lib/time.js', 'lib/payrollCalculator.js', 'lib/bankExport.js'];

let drift = 0;
console.log('PAYROLL PURE-FORMULA CHECK — against preserved PAYROLL_CORE_STABLE_V1 (SQLite) lock');
for (const f of PURE) {
  const src = fs.readFileSync(path.join(ROOT, f));
  const same = crypto.createHash('sha256').update(src).digest('hex') === V1.frozen[f];
  const touchesDb = /\.prepare\(|database\/(db|init-db)|withTransaction\(|require\('pg'\)|node:sqlite/.test(src.toString());
  if (!same || touchesDb) drift += 1;
  console.log(`  ${same && !touchesDb ? 'IDENTICAL' : 'CHANGED  '}  ${f}${touchesDb ? '  (now touches the database!)' : ''}`);
}
console.log(drift ? '\n  RESULT: PAYROLL BUSINESS LOGIC CHANGED — stop and report.' : '\n  RESULT: PAYROLL BUSINESS LOGIC — UNCHANGED (4/4 byte-identical).');
process.exit(drift ? 1 : 0);
