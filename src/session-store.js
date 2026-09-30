'use strict';

const session = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal express-session store backed by the app's SQLite database. */
class SQLiteStore extends session.Store {
  constructor(db, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.stmts = {
      get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      cleanup: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    };
    this.timer = setInterval(() => this.stmts.cleanup.run(Date.now()), cleanupIntervalMs);
    this.timer.unref();
  }

  static expiry(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + DAY_MS;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), SQLiteStore.expiry(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.stmts.touch.run(SQLiteStore.expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = { SQLiteStore };
