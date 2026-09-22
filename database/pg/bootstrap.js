// database/pg/bootstrap.js — DB-M1 development helper (NOT for production use).
//   DATABASE_ADMIN_URL=postgresql://postgres:...@localhost:5432/postgres npm run db:bootstrap
// Creates, idempotently: the schema-owner role, the least-privilege runtime role
// and the database (UTF8, LC_COLLATE 'C'). Names/passwords come from the
// environment; nothing is hardcoded. Production provisioning is a DBA task —
// see docs/POSTGRES_MIGRATION_RUNBOOK.md.
const path = require('path');
const { Client } = require('pg');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) { /* optional */ }

const IDENT = /^[a-z_][a-z0-9_]*$/;
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

async function bootstrap(env = process.env) {
  const admin = new Client({ connectionString: env.DATABASE_ADMIN_URL || need('DATABASE_ADMIN_URL') });
  const dbName = env.KAHE_DB_NAME || 'kahe360';
  const owner = env.KAHE_DB_OWNER_ROLE || 'kahe360_owner';
  const app = env.KAHE_DB_APP_ROLE || 'kahe360_app';
  for (const n of [dbName, owner, app]) if (!IDENT.test(n)) throw new Error(`Invalid identifier: ${n}`);
  const ownerPw = env.KAHE_DB_OWNER_PASSWORD || need('KAHE_DB_OWNER_PASSWORD');
  const appPw = env.KAHE_DB_APP_PASSWORD || need('KAHE_DB_APP_PASSWORD');
  await admin.connect();
  try {
    for (const [role, pw] of [[owner, ownerPw], [app, appPw]]) {
      const lit = (await admin.query('SELECT quote_literal($1) AS q', [pw])).rows[0].q;
      const has = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
      await admin.query(`${has ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${lit}`);
    }
    const hasDb = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount;
    if (!hasDb) {
      await admin.query(`CREATE DATABASE ${dbName} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${app}`);
    console.log(`database "${dbName}" ready · owner "${owner}" · runtime "${app}"`);
  } finally { await admin.end(); }
}
module.exports = { bootstrap };
if (require.main === module) bootstrap().catch((e) => { console.error(`BOOTSTRAP FAILED: ${e.message}`); process.exit(1); });
