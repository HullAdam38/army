'use strict';

/** Queries used only by the admin area. */
function createAdminRepo(db) {
  const stmts = {
    stats: db.prepare(`
      SELECT
        COUNT(*) AS players,
        COALESCE(SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), 0) AS newToday,
        COALESCE(SUM(CASE WHEN last_seen_at >= ?2 AND (signed_out_at IS NULL OR signed_out_at < last_seen_at) THEN 1 ELSE 0 END), 0) AS online,
        COALESCE(SUM(CASE WHEN hospital_until > ?3 THEN 1 ELSE 0 END), 0) AS inHospital,
        COALESCE(SUM(CASE WHEN banned_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS banned,
        COALESCE(SUM(cash), 0) AS cash,
        COALESCE(SUM(bank_balance), 0) AS banked
      FROM users`),
    battlesToday: db.prepare('SELECT COUNT(*) AS n FROM battles WHERE created_at >= ?'),
    search: db.prepare(`
      SELECT id, username, email, level, cash, bank_balance, created_at, last_seen_at, banned_at, is_admin
      FROM users
      WHERE (?1 = '' OR username LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\')
      ORDER BY id DESC LIMIT ?3 OFFSET ?4`),
    searchCount: db.prepare(`
      SELECT COUNT(*) AS n FROM users
      WHERE (?1 = '' OR username LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\')`),
    ban: db.prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?'),
    unban: db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?'),
    killSessions: db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"),
    log: db.prepare('INSERT INTO admin_actions (admin_id, target_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)'),
    recentActions: db.prepare(`
      SELECT a.action, a.details, a.created_at, a.target_id, adm.username AS admin_name, t.username AS target_name
      FROM admin_actions a JOIN users adm ON adm.id = a.admin_id LEFT JOIN users t ON t.id = a.target_id
      ORDER BY a.id DESC LIMIT ?`),
    actionsFor: db.prepare(`
      SELECT a.action, a.details, a.created_at, adm.username AS admin_name
      FROM admin_actions a JOIN users adm ON adm.id = a.admin_id
      WHERE a.target_id = ? ORDER BY a.id DESC LIMIT ?`),
    broadcast: db.prepare(`
      INSERT INTO notifications (user_id, kind, message, link, created_at)
      SELECT id, 'system', ?, NULL, ? FROM users WHERE banned_at IS NULL`),
    setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE username = ?'),
    admins: db.prepare('SELECT username, email FROM users WHERE is_admin = 1 ORDER BY username'),
  };

  const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  return {
    stats({ now, dayStart, onlineSince }) {
      const s = stmts.stats.get(dayStart, onlineSince, now);
      return { ...s, battlesToday: stmts.battlesToday.get(dayStart).n };
    },
    searchUsers(q = '', limit = 25, offset = 0) {
      return {
        rows: stmts.search.all(q, like(q), limit, offset),
        total: stmts.searchCount.get(q, like(q)).n,
      };
    },
    ban(userId, reason, now = Date.now()) {
      stmts.ban.run(now, reason, userId);
      stmts.killSessions.run(userId); // signed out everywhere, immediately
    },
    unban: (userId) => stmts.unban.run(userId),
    log: (adminId, targetId, action, details) => stmts.log.run(adminId, targetId, action, details, Date.now()),
    recentActions: (limit = 15) => stmts.recentActions.all(limit),
    actionsFor: (targetId, limit = 20) => stmts.actionsFor.all(targetId, limit),
    broadcast: (message, now = Date.now()) => Number(stmts.broadcast.run(message, now).changes),
    setAdmin: (username, on) => Number(stmts.setAdmin.run(on ? 1 : 0, username).changes),
    admins: () => stmts.admins.all(),
  };
}

module.exports = { createAdminRepo };
