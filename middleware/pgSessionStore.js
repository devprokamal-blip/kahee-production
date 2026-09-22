// middleware/pgSessionStore.js — DB-M1 successor of sqliteSessionStore.js.
// Server-side sessions in the PostgreSQL `sessions` table (created by migration
// 0001). Same semantics: upsert on set, lazy expiry on get, 15-minute purge.
const session = require('express-session');
const { getDb } = require('../database/init-db');

const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h, matches server.js cookie.maxAge

class PgSessionStore extends session.Store {
  constructor() {
    super();
    this.db = getDb();
    this._purgeInterval = setInterval(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()).catch(() => { /* ignore */ });
    }, 15 * 60 * 1000);
    this._purgeInterval.unref();
  }

  _expiresAt(sess) {
    const maxAge = sess && sess.cookie && typeof sess.cookie.maxAge === 'number' ? sess.cookie.maxAge : DEFAULT_MAX_AGE_MS;
    return Date.now() + maxAge;
  }

  get(sid, cb) {
    (async () => {
      const row = await this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return null;
      if (row.expires < Date.now()) { await this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); return null; }
      return JSON.parse(row.sess);
    })().then((s) => cb(null, s), (err) => cb(err));
  }

  set(sid, sess, cb) {
    this.db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`)
      .run(sid, JSON.stringify(sess), this._expiresAt(sess)).then(() => cb && cb(null), (err) => cb && cb(err));
  }

  destroy(sid, cb) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid).then(() => cb && cb(null), (err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this._expiresAt(sess), sid)
      .then(() => cb && cb(null), (err) => cb && cb(err));
  }
}

module.exports = PgSessionStore;
