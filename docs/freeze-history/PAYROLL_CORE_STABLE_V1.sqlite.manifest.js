// scripts/payroll-freeze-manifest.js
// PAYROLL_CORE_STABLE_V1 — the frozen surface, as a checksum manifest.
//
// A freeze recorded only in a document is a promise. This file makes it
// DETECTABLE: `npm run check:payroll-freeze` hashes every protected file and
// reports any drift, so an accidental edit during portal development is
// caught by a command rather than by a production surprise.
//
// Changing a frozen file is not forbidden — a confirmed defect may require it.
// It must be DELIBERATE: fix, run the full payroll regression, then re-baseline
// with `npm run baseline:payroll-freeze` and record why in PROJECT_CHECKPOINT.md.

const FROZEN_FILES = [
  // ---- canonical payroll libraries ----
  'lib/money.js',
  'lib/time.js',
  'lib/employeeEligibility.js',
  'lib/salaryStructure.js',
  'lib/dayClassification.js',
  'lib/payrollPeriod.js',
  'lib/asOfResolver.js',
  'lib/snapshotWriter.js',
  'lib/payrollCalculator.js',
  'lib/payrollValidation.js',
  'lib/validationRunner.js',
  'lib/payrollRun.js',
  'lib/runCalculator.js',
  'lib/payslip.js',
  'lib/payrollAdjustment.js',
  'lib/payrollPayment.js',
  'lib/bankExport.js',
  'lib/entityScope.js',
  // ---- commercial / billing foundation ----
  'lib/workerServiceAddon.js',
  'lib/billingRate.js',
  'lib/billingQuantity.js',
  'lib/billingCalculator.js',
  // ---- payroll & billing API surface ----
  'routes/payroll/periods.js',
  'routes/payroll/snapshots.js',
  'routes/payroll/dryrun.js',
  'routes/payroll/exceptions.js',
  'routes/payroll/runs.js',
  'routes/payroll/payslips.js',
  'routes/payroll/adjustments.js',
  'routes/payroll/payments.js',
  'routes/worker-services.js',
  'routes/client-billing.js',
  // ---- regression suites (the baseline itself is part of the freeze) ----
  'tests/phase0.test.js', 'tests/phase0b.test.js',
  'tests/phase1a.test.js', 'tests/phase1b.test.js',
  'tests/phase2a.test.js', 'tests/phase2b.test.js', 'tests/phase2c.test.js',
  'tests/phase2d.test.js', 'tests/phase2e.test.js', 'tests/phase2f.test.js',
  'tests/phase2g.test.js', 'tests/phase2h.test.js', 'tests/phase2i.test.js',
  'tests/e2e.test.js', 'tests/phase3a.test.js', 'tests/phase3b.test.js',
];

// Shared with the rest of the portal, so NOT frozen wholesale — but the
// payroll-owned regions inside them are. Drift here is a warning, not a
// failure: other modules legitimately add tables, routes and permissions.
const SHARED_FILES = [
  'database/init-db.js',
  'database/seed.js',
  'middleware/permissions.js',
  'server.js',
];

const PAYROLL_SUITES = ['phase0', 'phase0b', 'phase1a', 'phase1b',
  'phase2a', 'phase2b', 'phase2c', 'phase2d', 'phase2e', 'phase2f',
  'phase2g', 'phase2h', 'phase2i', 'e2e', 'phase3a', 'phase3b'];

const REGRESSION_BASELINE = 545;

module.exports = { FROZEN_FILES, SHARED_FILES, PAYROLL_SUITES, REGRESSION_BASELINE };
