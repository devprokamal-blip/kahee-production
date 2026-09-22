// scripts/test-payroll-regression.js
// Runs the full payroll + billing regression and enforces the baseline.
// Any portal change touching employee assignment, attendance, overtime,
// worker services, payroll input or legal entity must pass this.
const { execFileSync } = require('child_process');
const path = require('path');
const { PAYROLL_SUITES, REGRESSION_BASELINE } = require('./payroll-freeze-manifest');

const ROOT = path.join(__dirname, '..');
let total = 0; let failedSuites = 0;
const results = [];

for (const suite of PAYROLL_SUITES) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync('node', [path.join(ROOT, 'tests', `${suite}.test.js`)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    ok = false;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const m = out.match(/TESTS:\s*(\d+) passed,\s*(\d+) failed/);
  const passed = m ? Number(m[1]) : 0;
  const failed = m ? Number(m[2]) : -1;
  total += passed;
  if (!ok || failed !== 0) failedSuites += 1;
  results.push({ suite, passed, failed, ok });
  console.log(`  ${ok && failed === 0 ? 'PASS' : 'FAIL'}  ${suite.padEnd(10)} ${passed} passed, ${failed} failed`);
}

console.log(`\n  TOTAL: ${total} passed (baseline ${REGRESSION_BASELINE})`);
if (failedSuites) {
  console.log('\n  PAYROLL REGRESSION FAILED.');
  console.log('  STOP. Do not modify payroll to make this pass — report the regression');
  console.log('  and the portal change that caused it, then wait for approval.');
  process.exit(1);
}
if (total < REGRESSION_BASELINE) {
  console.log(`\n  COVERAGE DROPPED: ${total} < ${REGRESSION_BASELINE}. Tests were removed or skipped.`);
  process.exit(1);
}
console.log(total > REGRESSION_BASELINE
  ? `  Coverage grew by ${total - REGRESSION_BASELINE}. Update the baseline deliberately if intended.`
  : '  PAYROLL REGRESSION INTACT.');
