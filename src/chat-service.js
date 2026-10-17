'use strict';

const chat = require('./chat');
const titles = require('./titles');
const bbcode = require('./bbcode');

/**
 * Game chat backed by the database: posting, history, live polling,
 * deleting, reports and mutes. Messages from players you've blocked are
 * never shown to you.
 */
function createChatService(db, players) {
  const MESSAGE_COLUMNS = `
    m.id, m.channel, m.user_id, m.body, m.created_at,
    u.username, u.level, u.is_admin, u.title, u.avatar_v, un.tag AS unit_tag`;
  const FROM = `
    FROM chat_messages m JOIN users u ON u.id = m.user_id LEFT JOIN units un ON un.id = u.unit_id
    WHERE m.channel = ?1 AND m.deleted_at IS NULL AND u.banned_at IS NULL
      AND m.user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?2)`;
  const stmts = {
    insert: db.prepare('INSERT INTO chat_messages (channel, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM chat_messages WHERE id = ?'),
    latest: db.prepare(`SELECT ${MESSAGE_COLUMNS} ${FROM} ORDER BY m.id DESC LIMIT ?3`),
    after: db.prepare(`SELECT ${MESSAGE_COLUMNS} ${FROM} AND m.id > ?3 ORDER BY m.id ASC LIMIT 100`),
    before: db.prepare(`SELECT ${MESSAGE_COLUMNS} ${FROM} AND m.id < ?3 ORDER BY m.id DESC LIMIT ?4`),
    one: db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages m JOIN users u ON u.id = m.user_id LEFT JOIN units un ON un.id = u.unit_id WHERE m.id = ?`),
    deletedSince: db.prepare('SELECT id FROM chat_messages WHERE channel = ? AND deleted_at >= ?'),
    lastBy: db.prepare('SELECT body, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
    remove: db.prepare('UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL'),
    prune: db.prepare('DELETE FROM chat_messages WHERE created_at < ?'),
    usersNamed: (n) => db.prepare(`SELECT id, username, unit_id, banned_at FROM users WHERE username COLLATE NOCASE IN (${Array(n).fill('?').join(',')})`),
    blocked: db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    // Mention notifications are links back to chat; the latest one from this author tells us if they're pinging too often.
    lastMention: db.prepare("SELECT MAX(created_at) AS at FROM notifications WHERE user_id = ? AND kind = 'chat' AND message LIKE ? ESCAPE '\\'"),
    markRead: db.prepare(`INSERT INTO chat_reads (user_id, channel, last_id) VALUES (?, ?, ?)
                          ON CONFLICT(user_id, channel) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`),
    latestId: db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE channel = ?'),
    reportsSince: db.prepare('SELECT COUNT(*) AS n FROM chat_reports WHERE reporter_id = ? AND created_at >= ?'),

    report: db.prepare(`INSERT OR IGNORE INTO chat_reports (message_id, channel, reporter_id, author_id, body, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    reports: db.prepare(`
      SELECT r.*, rep.username AS reporter, a.username AS author, a.chat_muted_until, adm.username AS resolver,
             (SELECT deleted_at FROM chat_messages WHERE id = r.message_id) AS message_deleted,
             (SELECT COUNT(*) FROM chat_reports x WHERE x.message_id = r.message_id) AS times_reported
      FROM chat_reports r JOIN users rep ON rep.id = r.reporter_id
      LEFT JOIN users a ON a.id = r.author_id LEFT JOIN users adm ON adm.id = r.resolved_by
      WHERE r.status = ? ORDER BY r.id DESC LIMIT 100`),
    reportById: db.prepare('SELECT * FROM chat_reports WHERE id = ?'),
    openReports: db.prepare("SELECT COUNT(*) AS n FROM chat_reports WHERE status = 'open'"),
    resolve: db.prepare("UPDATE chat_reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE status = 'open' AND message_id = ?"),

    mute: db.prepare('UPDATE users SET chat_muted_until = ?, chat_mute_reason = ? WHERE id = ?'),
    muted: db.prepare('SELECT id, username, chat_muted_until, chat_mute_reason FROM users WHERE chat_muted_until > ? ORDER BY chat_muted_until'),
  };

  /** Real players among `names` (case-insensitive): Map of lower-case → row. */
  function lookup(names) {
    if (!names.length) return new Map();
    return new Map(stmts.usersNamed(names.length).all(...names).map((u) => [u.username.toLowerCase(), u]));
  }

  /** Display data for messages: rendered HTML with @mentions linked. */
  function view(rows, me) {
    const names = lookup([...new Set(rows.flatMap((r) => chat.mentionsIn(r.body)))]);
    const spelled = new Map([...names].map(([k, u]) => [k, u.username]));
    return rows.map((r) => {
      const html = chat.linkMentions(bbcode.render(r.body), spelled, me ? me.username : null);
      return {
        ...r,
        titleName: titles.nameOf(r.title),
        avatarUrl: `/avatars/${r.user_id}?v=${r.avatar_v || 0}`,
        html,
        mine: Boolean(me && r.user_id === me.id),
        mentionsMe: Boolean(me && r.user_id !== me.id && html.includes('chat-mention--you')),
      };
    });
  }

  return {
    view,

    /** Marks a channel read up to `lastId` (default: its newest message). */
    markRead(userId, channel, lastId = null) {
      const id = lastId ?? stmts.latestId.get(channel).id;
      if (id) stmts.markRead.run(userId, channel, id);
    },

    /** The latest page of a channel (oldest first), or the page before message `before`. */
    history(channel, me, { before = null, limit = chat.PAGE_SIZE } = {}) {
      const rows = before ? stmts.before.all(channel, me.id, before, limit) : stmts.latest.all(channel, me.id, limit);
      return view(rows.reverse(), me);
    },

    /** New messages after `afterId`, plus messages deleted in the last 10 minutes (to take off screen). */
    poll(channel, me, afterId, now = Date.now()) {
      return {
        messages: view(stmts.after.all(channel, me.id, afterId), me),
        deleted: stmts.deletedSince.all(channel, now - 10 * 60 * 1000).map((r) => r.id),
      };
    },

    /**
     * Posts a message. `canSee(user)` says whether a mentioned player can read
     * the channel (unit channels are members only). Returns { error } or { message }.
     */
    post({ me, channel, channelName, raw, canSee = () => true, now = Date.now() }) {
      const v = chat.validateBody(raw);
      if (v.error) return v;
      const blocker = chat.postBlocker(me, v.body, stmts.lastBy.get(me.id), now);
      if (blocker) return { error: blocker };
      const id = Number(stmts.insert.run(channel, me.id, v.body, now).lastInsertRowid);
      // Notify @mentioned players who can see the channel and haven't blocked the author.
      const mentioned = lookup(chat.mentionsIn(v.body));
      const snippet = bbcode.toPlain(v.body).slice(0, 120);
      for (const u of mentioned.values()) {
        if (u.id === me.id || u.banned_at || !canSee(u) || stmts.blocked.get(u.id, me.id)) continue;
        const prefix = `${me.username.replace(/[\\%_]/g, (c) => `\\${c}`)} mentioned you%`;
        const last = stmts.lastMention.get(u.id, prefix).at;
        if (last && now - last < chat.MENTION_NOTIFY_MS) continue; // already pinged them recently
        players.notify(u.id, 'chat', `${me.username} mentioned you in ${channelName} chat: “${snippet}”`, `/chat/${channel === 'global' ? 'global' : 'unit'}#m-${id}`);
      }
      return { message: view([stmts.one.get(id)], me)[0] };
    },

    findById: (id) => stmts.byId.get(id) || null,

    /** Deletes a message. Authors can delete their own; admins any. Returns the message or { error }. */
    remove(id, me, now = Date.now()) {
      const m = stmts.byId.get(id);
      if (!m || m.deleted_at) return { error: 'That message is already gone.' };
      if (m.user_id !== me.id && !me.is_admin) return { error: 'You can only delete your own messages.' };
      stmts.remove.run(now, me.id, id);
      return { message: m, byAdmin: m.user_id !== me.id };
    },

    /** Reports a message to the admins (once per reporter). */
    report(id, me, reason, now = Date.now()) {
      const m = stmts.byId.get(id);
      if (!m || m.deleted_at) return { error: 'That message is already gone.' };
      if (m.user_id === me.id) return { error: 'You can’t report your own message.' };
      if (stmts.reportsSince.get(me.id, now - 60 * 60 * 1000).n >= chat.REPORTS_PER_HOUR) {
        return { error: 'You’ve sent a lot of reports in the last hour. The admins will get to them; try again later.' };
      }
      const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, chat.MAX_REPORT_REASON) || null;
      const added = stmts.report.run(id, m.channel, me.id, m.user_id, m.body, why, now).changes;
      return { message: m, added: Boolean(added) };
    },

    reports: (status = 'open') => stmts.reports.all(status).map((r) => ({ ...r, html: bbcode.render(r.body) })),
    reportById: (id) => stmts.reportById.get(id) || null,
    openReportCount: () => stmts.openReports.get().n,
    /** Resolves every open report on the same message. */
    resolveReports: (messageId, adminId, resolution, now = Date.now()) => stmts.resolve.run(resolution, adminId, now, messageId).changes,

    mute(userId, ms, reason, now = Date.now()) {
      stmts.mute.run(now + ms, reason || null, userId);
      return now + ms;
    },
    unmute: (userId) => stmts.mute.run(null, null, userId),
    muted: (now = Date.now()) => stmts.muted.all(now),

    /** Deletes messages older than the retention period (reports keep their own copy). */
    prune: (now = Date.now()) => Number(stmts.prune.run(now - chat.RETENTION_DAYS * 24 * 60 * 60 * 1000).changes),

    schedule(ms = 60 * 60 * 1000) {
      setInterval(() => {
        try { this.prune(); } catch (err) { console.error('[chat] prune failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createChatService };
