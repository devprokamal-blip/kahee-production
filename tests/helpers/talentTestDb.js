// tests/helpers/talentTestDb.js
// Throwaway databases for the Talent & Worker suites. Wraps tests/helpers/pgTestDb.js (unchanged):
// the core schema comes from the shared migrated template; the Talent stream is applied on top as the
// OWNER role; the application runs as the least-privilege RUNTIME role, exactly as in production.
const path = require('path');
const { execFileSync } = require('child_process');
const { createTestDatabase, urlFor, OWNER, APP, PREFIX } = require('./pgTestDb');
const { migrateTalent } = require('../../database/pg/talent/migrate-talent');
const { seedTalent } = require('../../database/seed-talent');

const ROOT = path.join(__dirname, '..', '..');

function runCoreSeed(appUrl) {
  execFileSync(process.execPath, [path.join(ROOT, 'database', 'seed.js')], { cwd: ROOT,
    env: { ...process.env, DATABASE_URL: appUrl }, stdio: 'pipe' });
}

/**
 * label: [a-z0-9_]
 * opts.coreSeed   run database/seed.js (roles, permissions, demo users)       default true
 * opts.talent     apply the Talent migration stream                           default true
 * opts.talentSeed run database/seed-talent.js                                 default true
 */
async function createTalentTestDatabase(label, { coreSeed = true, talent = true, talentSeed = true } = {}) {
  const t = await createTestDatabase(label);
  if (coreSeed) runCoreSeed(t.appUrl);
  if (talent) await migrateTalent({ connectionString: t.ownerUrl, appRole: APP, log: () => {} });
  if (talent && talentSeed) await seedTalent({ connectionString: t.ownerUrl, log: () => {} });
  return { ...t, runCoreSeed: () => runCoreSeed(t.appUrl),
    migrateTalent: (opts = {}) => migrateTalent({ connectionString: t.ownerUrl, appRole: APP, log: () => {}, ...opts }),
    seedTalent: () => seedTalent({ connectionString: t.ownerUrl, log: () => {} }) };
}

module.exports = { createTalentTestDatabase, urlFor, OWNER, APP, PREFIX };
