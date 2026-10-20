'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 14 * DAY;
const ALERT_EVERY_MS = 30 * 60 * 1000; // at most one "server errors" alert to admins per half hour
const BACKUP_STALE_MS = 26 * 60 * 60 * 1000; // nightly, with some slack

/**
 * Keeping an eye on the server: records 500 errors (and tells admins, at most
 * every half hour), answers the uptime check, and reads the status the nightly
 * backup script leaves behind. Admin › Launch checklist shows all of it.
 */
function createHealthService(db, players, { push = null, backupStatusFile = defaultStatusFile() } = {}) {
  const stmts = {
    insert: db.prepare('INSERT INTO server_errors (method, path, message, stack, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    recent: db.prepare('SELECT * FROM server_errors ORDER BY id DESC LIMIT ?'),
    since: db.prepare('SELECT COUNT(*) AS n FROM server_errors WHERE created_at >= ?'),
    prune: db.prepare('DELETE FROM server_errors WHERE created_at < ?'),
    admins: db.prepare('SELECT id FROM users WHERE is_admin = 1 AND banned_at IS NULL'),
    ping: db.prepare('SELECT 1 AS ok'),
  };
  const MAX_PER_HOUR = 300; // errors stored per hour at most
  let lastAlertAt = 0;

  return {
    /** Records a server error and, at most every half hour, tells the admins. */
    record(err, req = null, now = Date.now()) {
      try {
        const where = req ? `${req.method} ${req.originalUrl || req.url}` : 'background job';
        // A flood of errors (say, someone hammering a broken page) keeps the first few hundred an hour, not all of them.
        if (stmts.since.get(now - 60 * 60 * 1000).n >= MAX_PER_HOUR) return;
        stmts.insert.run(req ? req.method : null, req ? String(req.originalUrl || req.url).slice(0, 300) : null,
          String((err && err.message) || err).slice(0, 500), String((err && err.stack) || '').slice(0, 4000),
          req && req.session ? req.session.userId || null : null, now);
        if (now - lastAlertAt < ALERT_EVERY_MS) return;
        lastAlertAt = now;
        const n = stmts.since.get(now - 60 * 60 * 1000).n;
        const text = `Server error${n > 1 ? `s: ${n} in the last hour` : ''} (latest on ${where}). Details on the launch checklist.`;
        for (const { id } of stmts.admins.all()) {
          players.notify(id, 'system', text, '/admin/launch#errors');
          if (push) push.staff(id, text, '/admin/launch#errors', 'errors');
        }
      } catch (inner) {
        console.error('[health] could not record an error', inner); // never let error reporting cause another error
      }
    },

    recent: (limit = 20) => stmts.recent.all(limit),
    countSince: (since) => stmts.since.get(since).n,

    /** For the uptime check: is the database answering? */
    ok() {
      try { return stmts.ping.get().ok === 1; } catch { return false; }
    },

    /**
     * What the last nightly backup reported (deploy/backup.sh writes it), or
     * null if none has run. Adds `stale` when it's over a day old.
     */
    backupStatus(now = Date.now()) {
      try {
        const s = JSON.parse(fs.readFileSync(backupStatusFile, 'utf8'));
        const at = Date.parse(s.at);
        return { ...s, atMs: at, stale: !Number.isFinite(at) || now - at > BACKUP_STALE_MS };
      } catch {
        return null;
      }
    },

    prune: (now = Date.now()) => stmts.prune.run(now - KEEP_MS).changes,
    schedule() {
      const timer = setInterval(() => { try { this.prune(); } catch (err) { console.error('[health] prune failed', err); } }, 6 * 60 * 60 * 1000);
      timer.unref();
    },
  };
}

/** Where deploy/backup.sh leaves its status: next to the database. */
function defaultStatusFile(env = process.env) {
  if (env.BACKUP_STATUS_FILE) return env.BACKUP_STATUS_FILE;
  const dbFile = env.DB_FILE || path.join(__dirname, '..', 'data', 'eliteforces.db');
  return path.join(path.dirname(dbFile), 'backup-status.json');
}

module.exports = { ALERT_EVERY_MS, BACKUP_STALE_MS, createHealthService, defaultStatusFile };
