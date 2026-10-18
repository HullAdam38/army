'use strict';

const support = require('./support');
const bbcode = require('./bbcode');

/**
 * Support tickets backed by the database. Admins hear about new tickets and
 * player replies in-game (notification kind 'support-staff') and, if they
 * have alerts on, by push through `alertStaff(adminId, message, link)`.
 * Players hear about HQ replies with kind 'support'.
 */
function createSupportService(db, players, { alertStaff = () => {} } = {}) {
  const stmts = {
    insert: db.prepare(`INSERT INTO support_tickets (user_id, category, subject, status, created_at, updated_at, last_player_at, player_seen_at)
                        VALUES (?1, ?2, ?3, 'open', ?4, ?4, ?4, ?4)`),
    message: db.prepare('INSERT INTO support_messages (ticket_id, author_id, staff, internal, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    byId: db.prepare(`SELECT t.*, u.username, u.level, u.avatar_v, u.banned_at, a.username AS assignee
                      FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to WHERE t.id = ?`),
    mine: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id AND m.internal = 0) AS messages
                      FROM support_tickets t WHERE t.user_id = ? ORDER BY (t.status = 'closed'), t.updated_at DESC LIMIT 50`),
    openCount: db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status != 'closed'"),
    todayCount: db.prepare('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND created_at >= ?'),
    lastByUser: db.prepare('SELECT MAX(m.created_at) AS at FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id WHERE m.author_id = ? AND m.staff = 0'),
    messages: db.prepare(`SELECT m.*, u.username, u.avatar_v FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
                          WHERE m.ticket_id = ?1 AND (m.internal = 0 OR ?2) ORDER BY m.id`),
    playerReplied: db.prepare("UPDATE support_tickets SET status = 'open', updated_at = ?1, last_player_at = ?1, player_seen_at = ?1, closed_at = NULL, closed_by = NULL WHERE id = ?2"),
    staffReplied: db.prepare(`UPDATE support_tickets SET status = ?1, updated_at = ?2, last_staff_at = ?2, assigned_to = COALESCE(assigned_to, ?3),
                                     closed_at = CASE WHEN ?1 = 'closed' THEN ?2 END, closed_by = CASE WHEN ?1 = 'closed' THEN ?3 END WHERE id = ?4`),
    waiting: db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'"),
    touch: db.prepare('UPDATE support_tickets SET updated_at = ? WHERE id = ?'),
    close: db.prepare("UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status != 'closed'"),
    reopen: db.prepare("UPDATE support_tickets SET status = 'open', closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ? AND status = 'closed'"),
    assign: db.prepare('UPDATE support_tickets SET assigned_to = ? WHERE id = ?'),
    seen: db.prepare('UPDATE support_tickets SET player_seen_at = ? WHERE id = ?'),
    unreadForPlayer: db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND last_staff_at > COALESCE(player_seen_at, 0)"),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status'),
    queue: db.prepare(`SELECT t.*, u.username, u.level, u.avatar_v, a.username AS assignee,
                              (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
                       FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
                       WHERE t.status = ?1 AND (?2 IS NULL OR t.assigned_to = ?2)
                       ORDER BY CASE WHEN ?1 = 'closed' THEN -t.updated_at ELSE t.updated_at END LIMIT ?3 OFFSET ?4`),
    queueTotal: db.prepare('SELECT COUNT(*) AS n FROM support_tickets WHERE status = ?1 AND (?2 IS NULL OR assigned_to = ?2)'),
    others: db.prepare('SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = ? AND id != ? ORDER BY id DESC LIMIT 10'),
    admins: db.prepare('SELECT id, username, support_alerts FROM users WHERE is_admin = 1 AND banned_at IS NULL'),
    stale: db.prepare("SELECT id, user_id, subject FROM support_tickets WHERE status = 'answered' AND last_staff_at < ?"),
    setAlerts: db.prepare('UPDATE users SET support_alerts = ? WHERE id = ? AND is_admin = 1'),
  };

  const link = (id) => `/support/${id}#latest`;
  const adminLink = (id) => `/admin/support/${id}#latest`;

  /** Tells admins (the assignee only, if there is one) in-game and by push. */
  function tellStaff(ticket, message, { exceptId = null } = {}) {
    const admins = stmts.admins.all().filter((a) => a.id !== exceptId && (!ticket.assigned_to || a.id === ticket.assigned_to));
    for (const a of admins) {
      players.notify(a.id, 'support-staff', message, adminLink(ticket.id));
      if (a.support_alerts) alertStaff(a.id, message, adminLink(ticket.id));
    }
  }

  const shape = (t) => ({ ...t, categoryName: (support.CATEGORY.get(t.category) || { name: t.category }).name, statusInfo: support.STATUSES[t.status] });

  return {
    /** Opens a ticket. Returns { ticket } or { error }. */
    open({ me, category, subject: rawSubject, body: rawBody, now = Date.now() }) {
      if (!support.CATEGORY.has(String(category || ''))) return { error: 'Choose what your ticket is about.' };
      const s = support.validateSubject(rawSubject);
      if (s.error) return s;
      const b = support.validateBody(rawBody);
      if (b.error) return b;
      const blocker = support.openBlocker({ openCount: stmts.openCount.get(me.id).n, todayCount: stmts.todayCount.get(me.id, now - 24 * 60 * 60 * 1000).n });
      if (blocker) return { error: blocker };
      const id = Number(stmts.insert.run(me.id, category, s.subject, now).lastInsertRowid);
      stmts.message.run(id, me.id, 0, 0, b.body, now);
      const ticket = stmts.byId.get(id);
      tellStaff(ticket, `New support ticket #${id} from ${me.username} (${support.CATEGORY.get(category).name}): ${s.subject}`);
      return { ticket: shape(ticket) };
    },

    /** The player's reply (reopens a closed ticket). Returns { ticket } or { error }. */
    playerReply({ me, ticketId, body: rawBody, now = Date.now() }) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket || ticket.user_id !== me.id) return { error: 'Ticket not found.' };
      const b = support.validateBody(rawBody, { min: 1 });
      if (b.error) return b;
      const last = stmts.lastByUser.get(me.id).at || 0;
      if (now - last < support.REPLY_COOLDOWN_MS) return { error: 'You’re sending messages too quickly. Wait a few seconds.' };
      const reopened = ticket.status === 'closed';
      if (reopened && stmts.openCount.get(me.id).n >= support.MAX_OPEN) return { error: `You already have ${support.MAX_OPEN} tickets open. Close one before reopening this.` };
      stmts.message.run(ticket.id, me.id, 0, 0, b.body, now);
      stmts.playerReplied.run(now, ticket.id);
      tellStaff(ticket, `${me.username} ${reopened ? 'reopened' : 'replied on'} ticket #${ticket.id}: ${bbcode.toPlain(b.body).slice(0, 120)}`);
      return { ticket: shape(stmts.byId.get(ticket.id)), reopened };
    },

    /** The player closes their own ticket. */
    playerClose({ me, ticketId, now = Date.now() }) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket || ticket.user_id !== me.id) return { error: 'Ticket not found.' };
      if (!stmts.close.run(now, me.id, now, ticket.id).changes) return { error: 'That ticket is already closed.' };
      return { ticket: shape(stmts.byId.get(ticket.id)) };
    },

    /**
     * An admin's reply. `internal` notes are for staff only and change nothing
     * else; replies tell the player and wait for them (or close with `close`).
     */
    staffReply({ admin, ticketId, body: rawBody, internal = false, close = false, now = Date.now() }) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket) return { error: 'Ticket not found.' };
      const b = support.validateBody(rawBody, { min: 1 });
      if (b.error) return b;
      stmts.message.run(ticket.id, admin.id, 1, internal ? 1 : 0, b.body, now);
      if (internal) {
        stmts.touch.run(now, ticket.id);
        return { ticket: shape(stmts.byId.get(ticket.id)), internal: true };
      }
      stmts.staffReplied.run(close ? 'closed' : 'answered', now, admin.id, ticket.id);
      players.notify(ticket.user_id, 'support', `HQ Support replied to your ticket “${ticket.subject}”${close ? ' and closed it' : ''}.`, link(ticket.id));
      return { ticket: shape(stmts.byId.get(ticket.id)) };
    },

    /** Admin: close or reopen. */
    setStatus({ admin, ticketId, status, now = Date.now() }) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket) return { error: 'Ticket not found.' };
      if (status === 'closed') {
        if (!stmts.close.run(now, admin.id, now, ticket.id).changes) return { error: 'That ticket is already closed.' };
        players.notify(ticket.user_id, 'support', `HQ Support closed your ticket “${ticket.subject}”. Reply on it if you still need help.`, link(ticket.id));
      } else if (status === 'open') {
        if (!stmts.reopen.run(now, ticket.id).changes) return { error: 'That ticket isn’t closed.' };
      } else return { error: 'Unknown status.' };
      return { ticket: shape(stmts.byId.get(ticket.id)) };
    },

    /** Admin: assign to an admin (or nobody). */
    assign({ ticketId, adminId }) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket) return { error: 'Ticket not found.' };
      if (adminId && !stmts.admins.all().some((a) => a.id === adminId)) return { error: 'Only admins can take tickets.' };
      stmts.assign.run(adminId || null, ticket.id);
      return { ticket: shape(stmts.byId.get(ticket.id)) };
    },

    /** The player's tickets, newest activity first (open ones on top). */
    mine: (userId) => stmts.mine.all(userId).map((t) => ({ ...shape(t), unread: Boolean(t.last_staff_at && t.last_staff_at > (t.player_seen_at || 0)) })),
    /** How many of the player's tickets have an HQ reply they haven't seen. */
    unreadFor: (userId) => stmts.unreadForPlayer.get(userId).n,
    canOpen: (userId, now = Date.now()) => support.openBlocker({ openCount: stmts.openCount.get(userId).n, todayCount: stmts.todayCount.get(userId, now - 24 * 60 * 60 * 1000).n }),

    /** One ticket for its player (no internal notes); marks HQ replies seen. Null if it isn't theirs. */
    forPlayer(userId, ticketId, now = Date.now()) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket || ticket.user_id !== userId) return null;
      const seenBefore = ticket.player_seen_at || 0;
      stmts.seen.run(now, ticket.id);
      const messages = stmts.messages.all(ticket.id, 0).map((m) => ({ ...m, html: bbcode.render(m.body), unread: Boolean(m.staff && m.created_at > seenBefore) }));
      return { ticket: shape(ticket), messages };
    },

    /** One ticket for admins, with internal notes and the player's other tickets. */
    forStaff(ticketId) {
      const ticket = stmts.byId.get(Number(ticketId));
      if (!ticket) return null;
      return {
        ticket: shape(ticket),
        messages: stmts.messages.all(ticket.id, 1).map((m) => ({ ...m, html: bbcode.render(m.body) })),
        others: stmts.others.all(ticket.user_id, ticket.id).map(shape),
        admins: stmts.admins.all(),
      };
    },

    /** Admin queue: tickets with `status`, optionally only those assigned to `assignedTo`. */
    queue({ status = 'open', assignedTo = null, limit = 25, offset = 0 } = {}) {
      const st = support.STATUSES[status] ? status : 'open';
      return {
        status: st,
        rows: stmts.queue.all(st, assignedTo, limit, offset).map(shape),
        total: stmts.queueTotal.get(st, assignedTo).n,
      };
    },
    counts() {
      const c = { open: 0, answered: 0, closed: 0 };
      for (const r of stmts.counts.all()) c[r.status] = r.n;
      return c;
    },
    /** Tickets waiting for HQ (the admin menu badge). */
    waiting: () => stmts.waiting.get().n,

    alertsOn: (adminId) => Boolean((stmts.admins.all().find((a) => a.id === adminId) || {}).support_alerts),
    setAlerts: (adminId, on) => stmts.setAlerts.run(on ? 1 : 0, adminId).changes > 0,

    /** Closes tickets HQ answered a week ago that the player never came back to. */
    autoClose(now = Date.now()) {
      let n = 0;
      for (const t of stmts.stale.all(now - support.AUTO_CLOSE_MS)) {
        players.transaction(() => {
          if (!stmts.close.run(now, null, now, t.id).changes) return;
          players.notify(t.user_id, 'support', `Your ticket “${t.subject}” was closed after a week without a reply. Reply on it if you still need help.`, link(t.id));
          n += 1;
        });
      }
      return n;
    },

    schedule() {
      const timer = setInterval(() => { try { this.autoClose(); } catch (err) { console.error('[support] auto-close failed', err); } }, 60 * 60 * 1000);
      timer.unref();
    },
  };
}

module.exports = { createSupportService };
