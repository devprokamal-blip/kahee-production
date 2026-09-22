// scripts/check-payroll-freeze.js
// Verifies that the PAYROLL_CORE_STABLE_V1 surface has not drifted.
//   npm run check:payroll-freeze      -> report drift, exit 1 if any
//   npm run baseline:payroll-freeze   -> re-record the baseline deliberately
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FREEZE_VERSION, FROZEN_FILES, SHARED_FILES, REGRESSION_BASELINE } = require('./payroll-freeze-manifest');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(ROOT, 'docs', 'PAYROLL_CORE_FREEZE.lock.json');

const hash = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
};

function snapshot() {
  const out = { version: FREEZE_VERSION, persistence: 'PostgreSQL', supersedes: 'PAYROLL_CORE_STABLE_V1 (SQLite) — docs/freeze-history/', regression_baseline: REGRESSION_BASELINE,
    recorded_at: new Date().toISOString().slice(0, 19).replace('T', ' '), frozen: {}, shared: {} };
  for (const f of FROZEN_FILES) out.frozen[f] = hash(f);
  for (const f of SHARED_FILES) out.shared[f] = hash(f);
  return out;
}

function baseline() {
  const snap = snapshot();
  const missing = Object.entries(snap.frozen).filter(([, h]) => h === null).map(([f]) => f);
  if (missing.length) {
    console.error('Cannot baseline — these frozen files are missing:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify(snap, null, 2));
  console.log(`${FREEZE_VERSION} baseline recorded: ${Object.keys(snap.frozen).length} frozen files, `
    + `${Object.keys(snap.shared).length} shared files.`);
}

function check() {
  if (!fs.existsSync(LOCK)) {
    console.error('No freeze baseline found. Run: npm run baseline:payroll-freeze');
    process.exit(1);
  }
  const prev = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const now = snapshot();

  const changed = [];
  const missing = [];
  for (const [f, h] of Object.entries(prev.frozen)) {
    const current = now.frozen[f];
    if (current === null) missing.push(f);
    else if (current !== h) changed.push(f);
  }
  const sharedChanged = Object.entries(prev.shared)
    .filter(([f, h]) => now.shared[f] !== h).map(([f]) => f);

  console.log(`PAYROLL CORE FREEZE CHECK — ${prev.version} (baseline ${prev.recorded_at})`);
  console.log(`  frozen files checked : ${Object.keys(prev.frozen).length}`);
  console.log(`  regression baseline  : ${prev.regression_baseline} tests`);

  if (sharedChanged.length) {
    console.log(`\n  NOTE — shared files changed (expected as the portal grows):`);
    for (const f of sharedChanged) console.log(`    ~ ${f}`);
    console.log('    Run the payroll regression to confirm nothing broke:');
    console.log('      npm run test:payroll-regression');
  }

  if (!changed.length && !missing.length) {
    console.log('\n  RESULT: INTACT — no frozen payroll file has drifted.');
    return;
  }
  console.log('\n  RESULT: DRIFT DETECTED');
  for (const f of missing) console.log(`    MISSING  ${f}`);
  for (const f of changed) console.log(`    CHANGED  ${f}`);
  console.log('\n  A frozen file changed. This is allowed ONLY for a confirmed defect.');
  console.log('  1. Confirm the change was deliberate.');
  console.log('  2. npm run test:payroll-regression   (must stay at the baseline)');
  console.log('  3. npm run baseline:payroll-freeze   (re-record)');
  console.log('  4. Record what changed and why in PROJECT_CHECKPOINT.md');
  process.exit(1);
}

if (process.argv.includes('--baseline')) baseline(); else check();
