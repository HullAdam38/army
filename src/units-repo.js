'use strict';

/**
 * Units data access. Membership lives on the users row (unit_id, unit_role…)
 * so every player read already knows their unit. Multi-step changes should be
 * wrapped in players.transaction().
 */

const { BASE_CAPACITY } = require('./units');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 3 * DAY_MS; // a recommended unit has members seen this recently
const LOOKING_SEEN_MS = 7 * DAY_MS; // players looking for a unit drop off the list after a quiet week
const INVITE_MS = 7 * DAY_MS; // invitations last this long

/**
 * `rankCacheMs`: how long the unit rankings (by strength) are reused. Working
 * them out sums every member of every unit, so the game caches them briefly.
 */
function createUnitRepo(db, { rankCacheMs = 0 } = {}) {
  let ranks = { at: 0, byId: new Map() };
  const SUMMARY = `
    SELECT u.*, COUNT(m.id) AS members, COALESCE(SUM(m.level), 0) AS strength,
           (SELECT username FROM users l WHERE l.unit_id = u.id AND l.unit_role = 'leader') AS leader_name
    FROM units u LEFT JOIN users m ON m.unit_id = u.id AND m.banned_at IS NULL`;

  const stmts = {
    insert: db.prepare('INSERT INTO units (name, tag, description, founded_by, created_at) VALUES (?, ?, ?, ?, ?)'),
    byId: db.prepare(`${SUMMARY} WHERE u.id = ? GROUP BY u.id`),
    nameTaken: db.prepare('SELECT (name = ?1 COLLATE NOCASE) AS name, (tag = ?2 COLLATE NOCASE) AS tag FROM units WHERE name = ?1 COLLATE NOCASE OR tag = ?2 COLLATE NOCASE'),
    list: db.prepare(`${SUMMARY} WHERE (?1 = '' OR u.name LIKE ?1 ESCAPE '\\' OR u.tag LIKE ?1 ESCAPE '\\')
                      GROUP BY u.id ORDER BY strength DESC, members DESC, u.id ASC LIMIT ?2`),
    ranking: db.prepare(`
      SELECT u.id FROM units u LEFT JOIN users m ON m.unit_id = u.id AND m.banned_at IS NULL
      GROUP BY u.id ORDER BY COALESCE(SUM(m.level), 0) DESC, COUNT(m.id) DESC, u.id ASC`),
    rankOf: db.prepare(`
      WITH s AS (SELECT u.id, COALESCE(SUM(m.level), 0) AS strength, COUNT(m.id) AS members
                 FROM units u LEFT JOIN users m ON m.unit_id = u.id AND m.banned_at IS NULL GROUP BY u.id)
      SELECT COUNT(*) + 1 AS position FROM s, (SELECT strength, members, id FROM s WHERE id = ?1) me
      WHERE s.strength > me.strength OR (s.strength = me.strength AND (s.members > me.members OR (s.members = me.members AND s.id < me.id)))`),
    count: db.prepare('SELECT COUNT(*) AS n FROM units'),
    members: db.prepare(`
      SELECT id, username, level, unit_role, unit_joined_at, unit_donated, last_seen_at, signed_out_at, banned_at, hospital_until, pvp_wins, missions_completed, avatar_v, is_bot
      FROM users WHERE unit_id = ?
      ORDER BY CASE unit_role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, level DESC, username COLLATE NOCASE`),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE unit_id = ?'),
    officers: db.prepare("SELECT id FROM users WHERE unit_id = ? AND unit_role IN ('leader', 'officer') ORDER BY unit_role = 'leader' DESC, id"), // the Commander first
    memberIds: db.prepare('SELECT id FROM users WHERE unit_id = ?'),
    join: db.prepare('UPDATE users SET unit_id = ?, unit_role = ?, unit_joined_at = ?, unit_donated = 0, lfu_at = NULL WHERE id = ? AND unit_id IS NULL'),
    leave: db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL, unit_joined_at = NULL, unit_donated = 0, unit_left_at = ? WHERE id = ? AND unit_id = ?'),
    kick: db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL, unit_joined_at = NULL, unit_donated = 0 WHERE id = ? AND unit_id = ?'),
    disbandMembers: db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL, unit_joined_at = NULL, unit_donated = 0 WHERE unit_id = ?'),
    setRole: db.prepare('UPDATE users SET unit_role = ? WHERE id = ? AND unit_id = ?'),
    donated: db.prepare('UPDATE users SET unit_donated = unit_donated + ? WHERE id = ?'),
    treasury: db.prepare('UPDATE units SET treasury = treasury + ? WHERE id = ?'),
    spend: db.prepare('UPDATE units SET treasury = treasury - ?1 WHERE id = ?2 AND treasury >= ?1'),
    rally: db.prepare('UPDATE units SET rally_until = ?, rally_at = ? WHERE id = ?'),
    upgrade: {
      barracks: db.prepare('UPDATE units SET barracks = barracks + 1 WHERE id = ? AND barracks = ?'),
      drill: db.prepare('UPDATE units SET drill = drill + 1 WHERE id = ? AND drill = ?'),
    },
    settings: db.prepare('UPDATE units SET description = @description, recruiting = @recruiting, min_level = @min_level, min_pvp_wins = @min_pvp_wins, min_missions = @min_missions WHERE id = @id'),
    rename: db.prepare('UPDATE units SET name = ?, tag = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM units WHERE id = ?'),

    apply: db.prepare('INSERT OR IGNORE INTO unit_applications (unit_id, user_id, message, created_at) VALUES (?, ?, ?, ?)'),
    application: db.prepare('SELECT * FROM unit_applications WHERE id = ? AND unit_id = ?'),
    applied: db.prepare('SELECT 1 FROM unit_applications WHERE unit_id = ? AND user_id = ?'),
    pendingCount: db.prepare('SELECT COUNT(*) AS n FROM unit_applications WHERE user_id = ?'),
    pendingForUnit: db.prepare(`
      SELECT a.id, a.message, a.created_at, u.id AS user_id, u.username, u.level, u.pvp_wins, u.missions_completed, u.avatar_v
      FROM unit_applications a JOIN users u ON u.id = a.user_id
      WHERE a.unit_id = ? AND u.banned_at IS NULL ORDER BY a.id`),
    pendingForUser: db.prepare(`
      SELECT a.id, a.created_at, n.id AS unit_id, n.name, n.tag FROM unit_applications a JOIN units n ON n.id = a.unit_id
      WHERE a.user_id = ? ORDER BY a.id DESC`),
    deleteApplication: db.prepare('DELETE FROM unit_applications WHERE id = ?'),
    withdraw: db.prepare('DELETE FROM unit_applications WHERE unit_id = ? AND user_id = ?'),
    clearApplications: db.prepare('DELETE FROM unit_applications WHERE user_id = ?'),

    // Recruiting units a player could join right now (open, room to spare, requirements met), busiest first.
    recommended: db.prepare(`
      SELECT u.*, COUNT(m.id) AS members, COALESCE(SUM(m.level), 0) AS strength, COALESCE(SUM(m.last_seen_at >= @since), 0) AS active,
             (SELECT username FROM users l WHERE l.unit_id = u.id AND l.unit_role = 'leader') AS leader_name
      FROM units u JOIN users m ON m.unit_id = u.id AND m.banned_at IS NULL
      WHERE u.recruiting = 1 AND u.min_level <= @level AND u.min_pvp_wins <= @pvp AND u.min_missions <= @missions
      GROUP BY u.id HAVING members < ${BASE_CAPACITY} + 5 * u.barracks AND active > 0
      ORDER BY active DESC, strength DESC, u.id ASC LIMIT @limit`),
    setLooking: db.prepare('UPDATE users SET lfu_at = ? WHERE id = ? AND unit_id IS NULL'),
    looking: db.prepare(`
      SELECT u.id, u.username, u.level, u.pvp_wins, u.missions_completed, u.last_seen_at, u.signed_out_at, u.lfu_at, u.avatar_v,
             EXISTS (SELECT 1 FROM unit_invites i WHERE i.unit_id = ?1 AND i.user_id = u.id AND i.created_at >= ?2) AS invited
      FROM users u WHERE u.lfu_at IS NOT NULL AND u.unit_id IS NULL AND u.banned_at IS NULL AND u.last_seen_at >= ?3
      ORDER BY u.last_seen_at DESC LIMIT ?4`),
    lookingCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE lfu_at IS NOT NULL AND unit_id IS NULL AND banned_at IS NULL AND last_seen_at >= ?'),
    invite: db.prepare(`INSERT INTO unit_invites (unit_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(unit_id, user_id) DO UPDATE SET invited_by = excluded.invited_by, created_at = excluded.created_at`),
    inviteById: db.prepare('SELECT * FROM unit_invites WHERE id = ? AND user_id = ? AND created_at >= ?'),
    invitesSent: db.prepare('SELECT COUNT(*) AS n FROM unit_invites WHERE unit_id = ? AND created_at >= ?'),
    invitedRecently: db.prepare('SELECT 1 FROM unit_invites WHERE unit_id = ? AND user_id = ? AND created_at >= ?'),
    invitesForUser: db.prepare(`
      SELECT i.id, i.created_at, n.id AS unit_id, n.name, n.tag, n.barracks, b.username AS invited_by,
             (SELECT COUNT(*) FROM users m WHERE m.unit_id = n.id AND m.banned_at IS NULL) AS members
      FROM unit_invites i JOIN units n ON n.id = i.unit_id LEFT JOIN users b ON b.id = i.invited_by
      WHERE i.user_id = ? AND i.created_at >= ? ORDER BY i.id DESC`),
    deleteInvite: db.prepare('DELETE FROM unit_invites WHERE id = ?'),
    clearInvites: db.prepare('DELETE FROM unit_invites WHERE user_id = ?'),
    pruneInvites: db.prepare('DELETE FROM unit_invites WHERE created_at < ?'),

    post: db.prepare('INSERT INTO unit_posts (unit_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    posts: db.prepare(`
      SELECT p.id, p.user_id, p.body, p.created_at, u.username, u.avatar_v, u.unit_id = p.unit_id AS still_member
      FROM unit_posts p JOIN users u ON u.id = p.user_id
      WHERE p.unit_id = ? ORDER BY p.id DESC LIMIT ?`),
    postById: db.prepare('SELECT * FROM unit_posts WHERE id = ? AND unit_id = ?'),
    deletePost: db.prepare('DELETE FROM unit_posts WHERE id = ?'),
    lastPost: db.prepare('SELECT MAX(created_at) AS at FROM unit_posts WHERE user_id = ?'),
    prunePosts: db.prepare('DELETE FROM unit_posts WHERE unit_id = ?1 AND id NOT IN (SELECT id FROM unit_posts WHERE unit_id = ?1 ORDER BY id DESC LIMIT 200)'),

    log: db.prepare('INSERT INTO unit_log (unit_id, kind, message, created_at) VALUES (?, ?, ?, ?)'),
    recentLog: db.prepare('SELECT kind, message, created_at FROM unit_log WHERE unit_id = ? ORDER BY id DESC LIMIT ?'),
  };

  return {
    create({ name, tag, description, leaderId, now = Date.now() }) {
      const id = Number(stmts.insert.run(name, tag, description, leaderId, now).lastInsertRowid);
      stmts.join.run(id, 'leader', now, leaderId);
      stmts.clearApplications.run(leaderId);
      stmts.clearInvites.run(leaderId);
      return id;
    },
    findById: (id) => stmts.byId.get(id) || null,
    /** { name, tag } booleans for which of the two are already in use. */
    taken(name, tag) {
      const rows = stmts.nameTaken.all(name, tag);
      return { name: rows.some((r) => r.name), tag: rows.some((r) => r.tag) };
    },
    list(q = '', limit = 50) {
      const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '';
      return stmts.list.all(like, limit);
    },
    position(id) {
      if (rankCacheMs <= 0) return stmts.rankOf.get(id).position;
      if (Date.now() - ranks.at >= rankCacheMs) ranks = { at: Date.now(), byId: new Map(stmts.ranking.all().map((r, i) => [r.id, i + 1])) };
      return ranks.byId.get(id) || stmts.rankOf.get(id).position; // a brand-new unit isn't in the cache yet
    },
    count: () => stmts.count.get().n,
    members: (unitId) => stmts.members.all(unitId),
    memberCount: (unitId) => stmts.memberCount.get(unitId).n,
    officerIds: (unitId) => stmts.officers.all(unitId).map((r) => r.id),
    memberIds: (unitId) => stmts.memberIds.all(unitId).map((r) => r.id),

    /** Adds a player; false if they joined another unit in the meantime. */
    join(unitId, userId, now = Date.now()) {
      if (!stmts.join.run(unitId, 'member', now, userId).changes) return false;
      stmts.clearApplications.run(userId);
      stmts.clearInvites.run(userId);
      return true;
    },
    leave: (unitId, userId, now = Date.now()) => stmts.leave.run(now, userId, unitId).changes > 0,
    kick: (unitId, userId) => stmts.kick.run(userId, unitId).changes > 0,
    setRole: (unitId, userId, role) => stmts.setRole.run(role, userId, unitId).changes > 0,
    /** Starts a rally if the treasury can pay for it. False if it can't. */
    startRally(unitId, cost, now, until) {
      if (!stmts.spend.run(cost, unitId).changes) return false;
      stmts.rally.run(until, now, unitId);
      return true;
    },
    /** Spends from the treasury; false if it can't cover `amount`. */
    spendTreasury: (unitId, amount) => stmts.spend.run(amount, unitId).changes > 0,
    /** Pays into the treasury from the game itself (e.g. a completed weekly objective). */
    addTreasury: (unitId, amount) => stmts.treasury.run(amount, unitId),
    donate(unitId, userId, amount) {
      stmts.treasury.run(amount, unitId);
      stmts.donated.run(amount, userId);
    },
    /** Spends treasury on the next level of an upgrade; false if funds or level changed. */
    upgrade(unitId, key, fromLevel, cost) {
      if (!stmts.spend.run(cost, unitId).changes) return false;
      if (!stmts.upgrade[key].run(unitId, fromLevel).changes) throw new Error('Upgrade level changed mid-purchase.');
      return true;
    },
    settings: (unitId, { description, recruiting, min_level = 0, min_pvp_wins = 0, min_missions = 0 }) => stmts.settings.run({
      id: unitId, description, recruiting: recruiting ? 1 : 0, min_level, min_pvp_wins, min_missions,
    }),
    rename: (unitId, name, tag) => stmts.rename.run(name, tag, unitId),
    disband(unitId) {
      stmts.disbandMembers.run(unitId);
      stmts.remove.run(unitId);
    },

    apply: (unitId, userId, message, now = Date.now()) => stmts.apply.run(unitId, userId, message, now).changes > 0,
    application: (id, unitId) => stmts.application.get(id, unitId) || null,
    hasApplied: (unitId, userId) => Boolean(stmts.applied.get(unitId, userId)),
    pendingCount: (userId) => stmts.pendingCount.get(userId).n,
    pendingForUnit: (unitId) => stmts.pendingForUnit.all(unitId),
    pendingForUser: (userId) => stmts.pendingForUser.all(userId),
    deleteApplication: (id) => stmts.deleteApplication.run(id),
    withdraw: (unitId, userId) => stmts.withdraw.run(unitId, userId).changes > 0,

    /** Up to `limit` recruiting units `player` could join now, with members active in the last 3 days. */
    recommended(player, { limit = 3, now = Date.now() } = {}) {
      return stmts.recommended.all({ since: now - ACTIVE_MS, level: player.level, pvp: player.pvp_wins || 0, missions: player.missions_completed || 0, limit });
    },
    /** Puts the player on (or takes them off) the list of soldiers looking for a unit. */
    setLooking: (userId, on, now = Date.now()) => stmts.setLooking.run(on ? now : null, userId).changes > 0,
    /** Players looking for a unit, seen in the last week, flagged when `unitId` already invited them. */
    looking: (unitId, { limit = 50, now = Date.now() } = {}) => stmts.looking.all(unitId, now - INVITE_MS, now - LOOKING_SEEN_MS, limit),
    lookingCount: (now = Date.now()) => stmts.lookingCount.get(now - LOOKING_SEEN_MS).n,
    invite: (unitId, userId, byId, now = Date.now()) => stmts.invite.run(unitId, userId, byId, now),
    invitedRecently: (unitId, userId, now = Date.now()) => Boolean(stmts.invitedRecently.get(unitId, userId, now - INVITE_MS)),
    /** Invitations the unit sent in the last day (there's a daily cap). */
    invitesSentToday: (unitId, now = Date.now()) => stmts.invitesSent.get(unitId, now - 24 * 60 * 60 * 1000).n,
    invitation: (id, userId, now = Date.now()) => stmts.inviteById.get(id, userId, now - INVITE_MS) || null,
    invitesFor: (userId, now = Date.now()) => stmts.invitesForUser.all(userId, now - INVITE_MS),
    deleteInvite: (id) => stmts.deleteInvite.run(id),
    pruneInvites: (now = Date.now()) => stmts.pruneInvites.run(now - INVITE_MS).changes,

    post(unitId, userId, body, now = Date.now()) {
      stmts.post.run(unitId, userId, body, now);
      stmts.prunePosts.run(unitId);
    },
    posts: (unitId, limit = 30) => stmts.posts.all(unitId, limit),
    postById: (id, unitId) => stmts.postById.get(id, unitId) || null,
    deletePost: (id) => stmts.deletePost.run(id),
    lastPostAt: (userId) => stmts.lastPost.get(userId).at,

    log: (unitId, kind, message, now = Date.now()) => stmts.log.run(unitId, kind, message, now),
    recentLog: (unitId, limit = 15) => stmts.recentLog.all(unitId, limit),
  };
}

module.exports = { INVITE_MS, createUnitRepo };
