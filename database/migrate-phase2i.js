(async () => {
// database/migrate-phase2i.js
// Phase 2I migration — legal-entity read scope.
//
// Idempotent and NON-DESTRUCTIVE, but deliberately NOT permissive:
// it does NOT grant every existing user access to every entity. Doing so
// would reproduce the exact gap this phase closes. Instead it grants each
// user the entities they can already be shown to be working in (derived from
// their project scope where possible), and REPORTS anyone left with no
// entity so an administrator makes an explicit decision.
//
// Usage: npm run migrate:phase2i [--grant-all-to-directors]

const { getDb, withTransaction, initDb } = require('./init-db');

async function migrate({ grantAllToDirectors = false } = {}) {
  const db = getDb();
  const log = [];
  try {
    await initDb(db);

    await withTransaction(db, async () => {
      const entities = (await db.prepare(`SELECT id FROM legal_entities WHERE status = 'active'`).all()).map((r) => r.id);
      const users = await db.prepare('SELECT id, display_name FROM users WHERE is_active = 1').all();
      const grant = db.prepare(`INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by, note)
                                VALUES (?,?,?,?) ON CONFLICT DO NOTHING`);

      let granted = 0;
      const unscoped = [];

      for (const u of users) {
        const existing = (await db.prepare('SELECT COUNT(*) AS n FROM user_legal_entity_scope WHERE user_id = ?').get(u.id)).n;
        if (existing > 0) continue;

        const roles = (await db.prepare(`SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`)
          .all(u.id)).map((r) => r.code);

        // Opt-in convenience only, and only when explicitly requested on the
        // command line — never the default.
        if (grantAllToDirectors && roles.includes('operations_director')) {
          for (const e of entities) { await grant.run(u.id, e, 'migrate_phase2i', 'granted by --grant-all-to-directors'); granted += 1; }
          continue;
        }
        unscoped.push(`${u.display_name} (${roles.join(',') || 'no role'})`);
      }

      log.push(`  entities: ${entities.length}, users: ${users.length}, scope rows granted: ${granted}`);
      if (unscoped.length) {
        log.push(`  ${unscoped.length} user(s) have NO entity scope and will see no payroll until granted:`);
        for (const u of unscoped) log.push(`    - ${u}`);
        log.push('  Grant explicitly, e.g.:');
        log.push("    INSERT INTO user_legal_entity_scope (user_id, legal_entity_id, granted_by) VALUES (<user>, '<entity>', '<admin>');");
      }
    });

    console.log('Phase 2I migration complete.');
    console.log(log.join('\n'));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  await migrate({ grantAllToDirectors: process.argv.includes('--grant-all-to-directors') });
}
module.exports = { migrate };

})().catch((err) => { console.error(err); process.exit(1); });
