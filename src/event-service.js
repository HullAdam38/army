'use strict';

const events = require('./events');
const bbcode = require('./bbcode');

/**
 * World events backed by the database: scheduling, the effects live right now,
 * and start announcements. effects() is cheap and safe to call on every action.
 */
function createEventService(db, { onAnnounce = null } = {}) {
  const LIVE = 'cancelled_at IS NULL AND starts_at <= ?1 AND ends_at > ?1';
  const stmts = {
    insert: db.prepare('INSERT INTO events (type, title, message, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM events WHERE id = ?'),
    live: db.prepare(`SELECT * FROM events WHERE ${LIVE} ORDER BY ends_at`),
    upcoming: db.prepare('SELECT * FROM events WHERE cancelled_at IS NULL AND starts_at > ? ORDER BY starts_at LIMIT ?'),
    recent: db.prepare('SELECT * FROM events WHERE cancelled_at IS NULL AND ends_at <= ? ORDER BY ends_at DESC LIMIT ?'),
    all: db.prepare(`SELECT e.*, u.username AS creator FROM events e LEFT JOIN users u ON u.id = e.created_by ORDER BY e.starts_at DESC LIMIT ?`),
    sameTypeOverlap: db.prepare('SELECT * FROM events WHERE cancelled_at IS NULL AND type = ? AND starts_at < ? AND ends_at > ? LIMIT 1'),
    cancel: db.prepare('UPDATE events SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL AND ends_at > ?'),
    endNow: db.prepare('UPDATE events SET ends_at = ? WHERE id = ? AND cancelled_at IS NULL AND starts_at <= ? AND ends_at > ?'),
    toAnnounce: db.prepare(`SELECT * FROM events WHERE ${LIVE} AND announced_at IS NULL`),
    announced: db.prepare('UPDATE events SET announced_at = ? WHERE id = ? AND announced_at IS NULL'),
    broadcast: db.prepare(`INSERT INTO notifications (user_id, kind, message, link, created_at)
                           SELECT id, 'event', ?, '/events', ? FROM users WHERE banned_at IS NULL`),
    // Largest cash multiplier live at any point in a window (used by anti-cheat).
    overlapping: db.prepare('SELECT type FROM events WHERE cancelled_at IS NULL AND starts_at < ? AND ends_at > ?'),
  };

  const view = (e, now = Date.now()) => {
    const def = events.TYPES[e.type] || { name: e.type, icon: 'i-star', summary: '' };
    const status = e.cancelled_at ? 'cancelled' : e.starts_at > now ? 'upcoming' : e.ends_at > now ? 'live' : 'ended';
    return { ...e, def, status, messageHtml: e.message ? bbcode.render(e.message) : '' };
  };

  return {
    view,

    /** Schedules an event. Returns { error } or { id }. */
    create(input, adminId, now = Date.now()) {
      const v = events.validateEvent(input, now);
      if (v.error) return v;
      const clash = stmts.sameTypeOverlap.get(v.type, v.endsAt, v.startsAt);
      if (clash) return { error: `A ${events.TYPES[v.type].name} event (“${clash.title}”) already overlaps that time.` };
      const id = Number(stmts.insert.run(v.type, v.title, v.message, v.startsAt, v.endsAt, adminId, now).lastInsertRowid);
      return { id, ...v };
    },

    byId: (id) => stmts.byId.get(id) || null,
    /** Cancels a scheduled or live event. */
    cancel: (id, now = Date.now()) => stmts.cancel.run(now, id, now).changes > 0,
    /** Ends a live event right away. */
    endNow: (id, now = Date.now()) => stmts.endNow.run(now, id, now, now).changes > 0,

    live: (now = Date.now()) => stmts.live.all(now).map((e) => view(e, now)),
    upcoming: (now = Date.now(), limit = 10) => stmts.upcoming.all(now, limit).map((e) => view(e, now)),
    recent: (now = Date.now(), limit = 10) => stmts.recent.all(now, limit).map((e) => view(e, now)),
    all: (now = Date.now(), limit = 50) => stmts.all.all(limit).map((e) => view(e, now)),

    /** Combined multipliers of every event live at `now`. */
    effects(now = Date.now()) {
      return events.effectsOf(stmts.live.all(now).map((e) => e.type));
    },

    /** The biggest cash multiplier live at any moment in [since, now]. */
    maxCashMultSince(since, now = Date.now()) {
      const types = stmts.overlapping.all(now, since).map((r) => r.type);
      return types.reduce((m, t) => Math.max(m, events.effectsOf([t]).cashMult), 1);
    },

    /** Notifies everyone about events that have just started. Returns how many were announced. */
    announce(now = Date.now()) {
      let n = 0;
      for (const e of stmts.toAnnounce.all(now)) {
        if (!stmts.announced.run(now, e.id).changes) continue;
        const def = events.TYPES[e.type];
        const hours = Math.round((e.ends_at - now) / events.HOUR);
        const message = `Event live: ${e.title}! ${def.summary} Ends in ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : 'under an hour'}.`;
        stmts.broadcast.run(message, now);
        if (onAnnounce) onAnnounce(message, '/events');
        n += 1;
      }
      return n;
    },

    /** Middleware: exposes live events to every page (for the banner). */
    locals() {
      return (req, res, next) => {
        try { res.locals.liveEvents = this.live(); } catch { res.locals.liveEvents = []; }
        next();
      };
    },

    schedule(ms = 60 * 1000) {
      setInterval(() => {
        try { this.announce(); } catch (err) { console.error('[events] announce failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createEventService };
