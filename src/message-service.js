'use strict';

const rules = require('./messages');
const bbcode = require('./bbcode');

const DAY = 24 * 60 * 60 * 1000;
const snippet = (body, n = 90) => {
  const t = bbcode.toPlain(body);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Private messages: two-person conversations, blocking and reports. Staff can
 * only read a message once someone reports it (a copy is kept with the report).
 */
function createMessageService(db, players) {
  // A conversation shows for a member unless they hid it and nothing new arrived since.
  const VISIBLE = '(m.hidden_at IS NULL OR m.hidden_at < c.last_message_at)';
  const stmts = {
    newConversation: db.prepare('INSERT INTO conversations (subject, created_at, last_message_at) VALUES (?, ?, ?)'),
    addMember: db.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)'),
    insert: db.prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)'),
    touch: db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?'),
    markRead: db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?'),
    member: db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'),
    other: db.prepare(`SELECT u.id, u.username, u.level, u.banned_at FROM conversation_members m JOIN users u ON u.id = m.user_id
                       WHERE m.conversation_id = ? AND m.user_id != ?`),
    conversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    messages: db.prepare(`SELECT msg.id, msg.sender_id, msg.body, msg.created_at, u.username AS sender
                          FROM messages msg LEFT JOIN users u ON u.id = msg.sender_id WHERE msg.conversation_id = ? ORDER BY msg.id`),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    inbox: db.prepare(`
      SELECT c.id, c.subject, c.last_message_at, m.last_read_at,
             o.username AS other, o.id AS other_id,
             (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
             (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_sender,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS count
      FROM conversation_members m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id != m.user_id
      LEFT JOIN users o ON o.id = om.user_id
      WHERE m.user_id = ?1 AND ${VISIBLE}
      ORDER BY c.last_message_at DESC LIMIT ?2 OFFSET ?3`),
    inboxCount: db.prepare(`SELECT COUNT(*) AS n FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = ? AND ${VISIBLE}`),
    hide: db.prepare('UPDATE conversation_members SET hidden_at = ? WHERE conversation_id = ? AND user_id = ?'),
    allHidden: db.prepare(`SELECT COUNT(*) AS n FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
                           WHERE m.conversation_id = ? AND (m.hidden_at IS NULL OR m.hidden_at < c.last_message_at)`),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
    lastSent: db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE sender_id = ?'),
    startedSince: db.prepare(`SELECT COUNT(*) AS n FROM conversations c
                              WHERE c.created_at >= ?2 AND (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY id LIMIT 1) = ?1`),
    block: db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)'),
    unblock: db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    isBlocked: db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    blockedList: db.prepare('SELECT u.username, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY u.username COLLATE NOCASE'),
    report: db.prepare(`INSERT OR IGNORE INTO message_reports (message_id, reporter_id, sender_id, body, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    reports: db.prepare(`
      SELECT r.*, rep.username AS reporter, s.username AS sender, adm.username AS resolver
      FROM message_reports r JOIN users rep ON rep.id = r.reporter_id
      LEFT JOIN users s ON s.id = r.sender_id LEFT JOIN users adm ON adm.id = r.resolved_by
      WHERE r.status = ? ORDER BY r.created_at DESC LIMIT ?`),
    openReports: db.prepare("SELECT COUNT(*) AS n FROM message_reports WHERE status = 'open'"),
    resolve: db.prepare("UPDATE message_reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'"),
    reportById: db.prepare('SELECT * FROM message_reports WHERE id = ?'),
    admins: db.prepare('SELECT id FROM users WHERE is_admin = 1 AND banned_at IS NULL'),
  };

  const isBlocked = (userId, otherId) => Boolean(stmts.isBlocked.get(userId, otherId));

  function context(sender, recipient, { starting, now }) {
    return {
      starting,
      blockedBySender: isBlocked(sender.id, recipient.id),
      blockedByRecipient: isBlocked(recipient.id, sender.id),
      lastSentAt: stmts.lastSent.get(sender.id).at,
      startedToday: starting ? stmts.startedSince.get(sender.id, now - DAY).n : 0,
    };
  }

  return {
    /** Starts a conversation. Call inside players.transaction(). Returns { error } or { id }. */
    start({ senderId, recipientName, subject, body, now = Date.now() }) {
      const sender = players.findById(senderId);
      const recipient = recipientName ? players.findByUsername(String(recipientName).trim()) : null;
      const blocker = recipient ? rules.sendBlocker(sender, recipient, context(sender, recipient, { starting: true, now }), now) : rules.sendBlocker(sender, null, {}, now);
      if (blocker) return { error: blocker };
      const s = rules.validateSubject(subject);
      if (s.error) return s;
      const b = rules.validateBody(body);
      if (b.error) return b;
      const id = Number(stmts.newConversation.run(s.subject, now, now).lastInsertRowid);
      stmts.addMember.run(id, sender.id, now);
      stmts.addMember.run(id, recipient.id, 0);
      stmts.insert.run(id, sender.id, b.body, now);
      return { id, recipient: recipient.username };
    },

    /** Replies in a conversation. Call inside players.transaction(). */
    reply({ senderId, conversationId, body, now = Date.now() }) {
      if (!stmts.member.get(conversationId, senderId)) return { error: 'That conversation doesn’t exist.' };
      const sender = players.findById(senderId);
      const other = stmts.other.get(conversationId, senderId);
      if (!other) return { error: 'The other soldier has left. You can’t reply here.' };
      const blocker = rules.sendBlocker(sender, other, context(sender, other, { starting: false, now }), now);
      if (blocker) return { error: blocker };
      const b = rules.validateBody(body);
      if (b.error) return b;
      stmts.insert.run(conversationId, sender.id, b.body, now);
      stmts.touch.run(now, conversationId);
      stmts.markRead.run(now, conversationId, sender.id);
      return { ok: true, recipient: other.username };
    },

    inbox(userId, { limit = 25, offset = 0 } = {}) {
      return {
        total: stmts.inboxCount.get(userId).n,
        rows: stmts.inbox.all(userId, limit, offset).map((c) => ({
          ...c,
          snippet: snippet(c.last_body || ''),
          fromYou: c.last_sender === userId,
          unread: c.last_sender !== userId && c.last_message_at > c.last_read_at,
        })),
      };
    },

    unreadCount: (userId) => players.unreadMessageCount(userId),

    /** A conversation for a member, with rendered messages; marks it read. Null if not theirs. */
    thread(userId, conversationId, now = Date.now()) {
      const membership = stmts.member.get(conversationId, userId);
      if (!membership) return null;
      const conversation = stmts.conversation.get(conversationId);
      const other = stmts.other.get(conversationId, userId) || null;
      const messages = stmts.messages.all(conversationId).map((m) => ({
        ...m,
        html: bbcode.render(m.body),
        mine: m.sender_id === userId,
        unread: m.sender_id !== userId && m.created_at > membership.last_read_at,
      }));
      stmts.markRead.run(now, conversationId, userId);
      return {
        conversation,
        other,
        messages,
        blocked: other ? isBlocked(userId, other.id) : false,
        blockedYou: other ? isBlocked(other.id, userId) : false,
      };
    },

    /** Hides a conversation from your inbox; it comes back if a new message arrives. */
    hide(userId, conversationId, now = Date.now()) {
      if (!stmts.member.get(conversationId, userId)) return false;
      stmts.hide.run(now, conversationId, userId);
      // Nobody can see it any more: delete it for good.
      if (stmts.allHidden.get(conversationId).n === 0) stmts.deleteConversation.run(conversationId);
      return true;
    },

    block: (userId, blockedId, now = Date.now()) => stmts.block.run(userId, blockedId, now).changes > 0,
    unblock: (userId, blockedId) => stmts.unblock.run(userId, blockedId).changes > 0,
    isBlocked,
    blockedList: (userId) => stmts.blockedList.all(userId),

    /**
     * Reports a message you received. A copy goes to the admin queue, so the
     * report stands even if the conversation is later deleted.
     */
    report({ reporterId, messageId, reason = '', now = Date.now() }) {
      const msg = stmts.message.get(messageId);
      if (!msg || !stmts.member.get(msg.conversation_id, reporterId)) return { error: 'That message doesn’t exist.' };
      if (msg.sender_id === reporterId) return { error: 'You can’t report your own message.' };
      const added = stmts.report.run(msg.id, reporterId, msg.sender_id, msg.body, String(reason).trim().slice(0, rules.MAX_REPORT_REASON), now).changes > 0;
      if (!added) return { error: 'You’ve already reported that message.' };
      for (const { id } of stmts.admins.all()) players.notify(id, 'system', 'A private message was reported and is waiting for review.', '/admin/reports');
      return { ok: true };
    },

    reports: (status = 'open', limit = 50) => stmts.reports.all(status, limit).map((r) => ({ ...r, html: bbcode.render(r.body) })),
    openReportCount: () => stmts.openReports.get().n,
    resolve: (reportId, adminId, resolution, now = Date.now()) => stmts.resolve.run(resolution, adminId, now, reportId).changes > 0,
    reportById: (id) => stmts.reportById.get(id) || null,
  };
}

module.exports = { createMessageService };
