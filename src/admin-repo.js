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
    // One statement per sort order (column names can't be parameters).
    search: Object.fromEntries(Object.entries({ newest: 'id DESC', oldest: 'id ASC', played: 'play_ms DESC, id DESC', active: 'last_active_at IS NULL, last_active_at DESC' }).map(([key, order]) => [key, db.prepare(`
      SELECT id, username, email, level, cash, bank_balance, created_at, last_seen_at, last_active_at, play_ms, play_sessions, banned_at, is_admin, is_bot
      FROM users
      WHERE (?1 = '' OR username LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\')
      ORDER BY ${order} LIMIT ?3 OFFSET ?4`)])),
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
    nameTaken: db.prepare('SELECT id FROM users WHERE username = ? AND id != ?'),
    emailTaken: db.prepare('SELECT id FROM users WHERE email = ? AND id != ?'),
    setUsername: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
    setEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    clearTitle: db.prepare('UPDATE users SET title = NULL WHERE id = ?'),
    removeItem: db.prepare('DELETE FROM inventory WHERE user_id = ? AND item_id = ?'),
    unequipItem: db.prepare('DELETE FROM equipment WHERE user_id = ? AND item_id = ?'),

    // Units
    units: db.prepare(`
      SELECT un.*, (SELECT COUNT(*) FROM users u WHERE u.unit_id = un.id) AS members,
             (SELECT username FROM users u WHERE u.unit_id = un.id AND u.unit_role = 'leader') AS leader
      FROM units un
      WHERE (?1 = '' OR un.name LIKE ?2 ESCAPE '\\' OR un.tag LIKE ?2 ESCAPE '\\')
      ORDER BY un.treasury DESC, un.id LIMIT ?3 OFFSET ?4`),
    unitCount: db.prepare(`SELECT COUNT(*) AS n FROM units WHERE (?1 = '' OR name LIKE ?2 ESCAPE '\\' OR tag LIKE ?2 ESCAPE '\\')`),
    unitById: db.prepare('SELECT * FROM units WHERE id = ?'),
    unitByTag: db.prepare('SELECT * FROM units WHERE tag = ? COLLATE NOCASE'),
    setTreasury: db.prepare('UPDATE units SET treasury = treasury + ?1 WHERE id = ?2 AND treasury + ?1 >= 0'),

    // Economy
    flows: db.prepare(`
      SELECT reason,
             SUM(CASE WHEN created_at >= ?1 THEN delta_cash + delta_bank ELSE 0 END) AS day,
             SUM(delta_cash + delta_bank) AS week,
             SUM(CASE WHEN delta_cash + delta_bank > 0 THEN delta_cash + delta_bank ELSE 0 END) AS weekIn,
             SUM(CASE WHEN delta_cash + delta_bank < 0 THEN delta_cash + delta_bank ELSE 0 END) AS weekOut,
             COUNT(*) AS entries
      FROM ledger WHERE created_at >= ?2 AND reason != 'opening-balance'
      GROUP BY reason ORDER BY ABS(SUM(delta_cash + delta_bank)) DESC`),
    treasuries: db.prepare('SELECT COALESCE(SUM(treasury), 0) AS n, COUNT(*) AS units FROM units'),
    topEarners: db.prepare(`
      SELECT u.id, u.username, u.level, SUM(l.delta_cash + l.delta_bank) AS earned
      FROM ledger l JOIN users u ON u.id = l.user_id
      WHERE l.created_at >= ? AND l.delta_cash + l.delta_bank > 0 AND l.reason NOT LIKE 'admin-%' AND l.reason NOT IN ('bank-deposit', 'bank-withdraw', 'opening-balance')
      GROUP BY u.id ORDER BY earned DESC LIMIT ?`),
    richest: db.prepare('SELECT id, username, level, cash + bank_balance AS worth FROM users WHERE banned_at IS NULL ORDER BY worth DESC LIMIT ?'),
    adminMoney: db.prepare("SELECT COALESCE(SUM(delta_cash + delta_bank), 0) AS n, COUNT(*) AS entries FROM ledger WHERE reason LIKE 'admin-%' AND created_at >= ?"),

    // Audit log
    audit: db.prepare(`
      SELECT a.id, a.action, a.details, a.created_at, a.target_id, adm.username AS admin_name, t.username AS target_name
      FROM admin_actions a JOIN users adm ON adm.id = a.admin_id LEFT JOIN users t ON t.id = a.target_id
      WHERE (?1 = '' OR a.action = ?1) AND (?2 = 0 OR a.admin_id = ?2) AND (?3 = '' OR t.username LIKE ?4 ESCAPE '\\' OR a.details LIKE ?4 ESCAPE '\\')
      ORDER BY a.id DESC LIMIT ?5 OFFSET ?6`),
    auditCount: db.prepare(`
      SELECT COUNT(*) AS n FROM admin_actions a LEFT JOIN users t ON t.id = a.target_id
      WHERE (?1 = '' OR a.action = ?1) AND (?2 = 0 OR a.admin_id = ?2) AND (?3 = '' OR t.username LIKE ?4 ESCAPE '\\' OR a.details LIKE ?4 ESCAPE '\\')`),
    auditActions: db.prepare('SELECT DISTINCT action FROM admin_actions ORDER BY action'),
    auditAdmins: db.prepare('SELECT DISTINCT adm.id, adm.username FROM admin_actions a JOIN users adm ON adm.id = a.admin_id ORDER BY adm.username'),
  };

  const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  return {
    db, // for read-only reporting (stats-service)
    stats({ now, dayStart, onlineSince }) {
      const s = stmts.stats.get(dayStart, onlineSince, now);
      return { ...s, battlesToday: stmts.battlesToday.get(dayStart).n };
    },
    /** `sort`: newest, oldest, played (most time played) or active (most recently active). */
    searchUsers(q = '', limit = 25, offset = 0, sort = 'newest') {
      return {
        rows: (stmts.search[sort] || stmts.search.newest).all(q, like(q), limit, offset),
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
    /** Renames a player. False if another account has that callsign (case-insensitive). */
    setUsername(userId, username) {
      if (stmts.nameTaken.get(username, userId)) return false;
      stmts.setUsername.run(username, userId);
      return true;
    },
    setEmail(userId, email) {
      if (stmts.emailTaken.get(email, userId)) return false;
      stmts.setEmail.run(email, userId);
      return true;
    },
    clearTitle: (userId) => stmts.clearTitle.run(userId).changes > 0,

    units(q = '', limit = 25, offset = 0) {
      return { rows: stmts.units.all(q, like(q), limit, offset), total: stmts.unitCount.get(q, like(q)).n };
    },
    unitById: (id) => stmts.unitById.get(id) || null,
    unitByTag: (tag) => stmts.unitByTag.get(String(tag || '').trim().replace(/^\[|\]$/g, '')) || null,
    /** Adds to (or takes from) a unit treasury; false if it would go below zero. */
    adjustTreasury: (unitId, amount) => stmts.setTreasury.run(amount, unitId).changes > 0,

    economy({ now = Date.now() } = {}) {
      const day = now - 24 * 60 * 60 * 1000;
      const week = now - 7 * 24 * 60 * 60 * 1000;
      return {
        flows: stmts.flows.all(day, week),
        treasuries: stmts.treasuries.get(),
        topEarners: stmts.topEarners.all(day, 10),
        richest: stmts.richest.all(10),
        adminMoney: stmts.adminMoney.get(week),
      };
    },

    audit({ action = '', adminId = 0, q = '', limit = 50, offset = 0 } = {}) {
      const params = [action, adminId, q, like(q)];
      return {
        rows: stmts.audit.all(...params, limit, offset),
        total: stmts.auditCount.get(...params).n,
        actions: stmts.auditActions.all().map((r) => r.action),
        admins: stmts.auditAdmins.all(),
      };
    },
    /** Takes a gear item away (unequipping it first). */
    removeItem(userId, itemId) {
      stmts.unequipItem.run(userId, itemId);
      return stmts.removeItem.run(userId, itemId).changes > 0;
    },
  };
}

module.exports = { createAdminRepo };
