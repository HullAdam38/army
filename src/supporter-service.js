'use strict';

const crypto = require('node:crypto');
const supporter = require('./supporter');

const DAY = 24 * 60 * 60 * 1000;
const when = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Supporter membership backed by the database (rules in src/supporter.js):
 * applies the payment provider's webhooks, HQ's gift memberships, and takes
 * Supporter-only looks off once a membership has ended.
 */
function createSupporterService(db, players, { onLapse = () => {} } = {}) {
  const stmts = {
    user: db.prepare('SELECT id, username, email, supporter_until, supporter_since, supporter_status, supporter_source, supporter_sub_id, supporter_portal FROM users WHERE id = ?'),
    bySub: db.prepare('SELECT id FROM users WHERE supporter_sub_id = ?'),
    event: db.prepare(`INSERT OR IGNORE INTO payment_events (id, provider, event, user_id, subscription_id, status, amount, currency, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    set: db.prepare(`UPDATE users SET supporter_until = @until, supporter_status = @status, supporter_source = @source, supporter_sub_id = @sub,
                     supporter_portal = @portal, supporter_since = COALESCE(supporter_since, @since), supporter_lapsed_at = NULL WHERE id = @id`),
    lapsed: db.prepare('SELECT id FROM users WHERE supporter_since IS NOT NULL AND supporter_lapsed_at IS NULL AND (supporter_until IS NULL OR supporter_until <= ?)'),
    markLapsed: db.prepare('UPDATE users SET supporter_lapsed_at = ? WHERE id = ?'),
    members: db.prepare(`SELECT id, username, supporter_until, supporter_since, supporter_status, supporter_source FROM users
                         WHERE supporter_since IS NOT NULL ORDER BY supporter_until > ?1 DESC, supporter_until DESC LIMIT 200`),
    counts: db.prepare(`SELECT COALESCE(SUM(supporter_until > ?1), 0) AS active,
                               COALESCE(SUM(supporter_until > ?1 AND supporter_source = 'admin'), 0) AS gifted,
                               COALESCE(SUM(supporter_until > ?1 AND supporter_status = 'cancelled'), 0) AS ending,
                               COALESCE(SUM(supporter_since IS NOT NULL), 0) AS ever
                        FROM users`),
    events: db.prepare(`SELECT e.*, u.username FROM payment_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT ?`),
    revenue: db.prepare(`SELECT currency, SUM(amount) AS total, COUNT(*) AS payments FROM payment_events
                         WHERE event = 'subscription_payment_success' AND created_at >= ? GROUP BY currency`),
  };

  return {
    isActive: (user, now) => supporter.isActive(user, now),
    status: (userId) => stmts.user.get(userId),

    /**
     * A webhook from Lemon Squeezy: checks the signature, records the event once,
     * and updates the member. Returns { ok } (also for events that change
     * nothing), { duplicate } or { error, status }.
     */
    webhook(rawBody, signature, secret, now = Date.now()) {
      if (!supporter.verifySignature(rawBody, signature, secret)) return { error: 'Bad signature.', status: 401 };
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { error: 'Not JSON.', status: 400 }; }
      const change = supporter.readWebhook(body, now);
      const id = crypto.createHash('sha256').update(rawBody).digest('hex');
      return players.transaction(() => {
        const userId = (change && change.userId && stmts.user.get(change.userId) ? change.userId : null)
          || (change && change.subscriptionId && (stmts.bySub.get(change.subscriptionId) || {}).id) || null;
        const event = (body.meta && body.meta.event_name) || 'unknown';
        const fresh = stmts.event.run(id, 'lemonsqueezy', String(event).slice(0, 60), userId, change ? change.subscriptionId : null,
          change ? change.status : null, change && change.invoiceOnly ? change.amount : null, change && change.currency ? String(change.currency).slice(0, 8) : null, now).changes;
        if (!fresh) return { duplicate: true };
        if (!change || change.invoiceOnly || !userId) return { ok: true, ignored: !change || !userId };
        const before = stmts.user.get(userId);
        const wasActive = supporter.isActive(before, now);
        // A gift from HQ that runs longer than the paid membership isn't cut short.
        const until = before.supporter_source === 'admin' && before.supporter_until > change.until ? before.supporter_until : change.until;
        stmts.set.run({ id: userId, until, status: change.status, source: 'lemonsqueezy', sub: change.subscriptionId, portal: change.portal || before.supporter_portal, since: now });
        const nowActive = until > now;
        if (nowActive && !wasActive) players.notify(userId, 'system', 'Thank you for becoming a Supporter! Your Supporter tag, looks and extra medal pins are on.', '/supporter');
        else if (change.status === 'cancelled' && before.supporter_status !== 'cancelled' && nowActive) players.notify(userId, 'system', `Your Supporter membership is cancelled and ends on ${when(until)}. Thanks for your support.`, '/supporter');
        else if (change.status === 'past_due' && before.supporter_status !== 'past_due') players.notify(userId, 'system', 'Your last Supporter payment didn’t go through. Update your payment details to keep your perks.', '/supporter');
        if (!nowActive) { onLapse(userId, now); stmts.markLapsed.run(now, userId); }
        return { ok: true, userId, active: nowActive };
      });
    },

    /** HQ gives (or extends) a free membership for `days`. */
    gift(userId, days, now = Date.now()) {
      const u = stmts.user.get(userId);
      if (!u) return { error: 'No such player.' };
      const paid = u.supporter_source === 'lemonsqueezy' && supporter.isActive(u, now);
      const until = Math.max(u.supporter_until || 0, now) + days * DAY;
      stmts.set.run({ id: userId, until, status: paid ? u.supporter_status : 'gift', source: paid ? 'lemonsqueezy' : 'admin', sub: u.supporter_sub_id, portal: u.supporter_portal, since: now });
      players.notify(userId, 'system', `HQ made you a Supporter until ${when(until)}. Enjoy your Supporter tag, looks and extra medal pins.`, '/supporter');
      return { until };
    },

    /** HQ ends a gift membership (a paid one is ended by cancelling it with the provider). */
    endGift(userId, now = Date.now()) {
      const u = stmts.user.get(userId);
      if (!u || u.supporter_source !== 'admin' || !supporter.isActive(u, now)) return { error: 'They don’t have a gift membership from HQ.' };
      stmts.set.run({ id: userId, until: now, status: 'ended', source: 'admin', sub: u.supporter_sub_id, portal: u.supporter_portal, since: now });
      onLapse(userId, now);
      stmts.markLapsed.run(now, userId);
      return { ok: true };
    },

    /** Takes Supporter-only looks off members whose time has run out. Returns how many. */
    sweep(now = Date.now()) {
      let n = 0;
      for (const { id } of stmts.lapsed.all(now)) {
        players.transaction(() => { onLapse(id, now); stmts.markLapsed.run(now, id); });
        players.notify(id, 'system', 'Your Supporter membership has ended, so the Supporter-only looks are off. You can rejoin any time.', '/supporter');
        n += 1;
      }
      return n;
    },
    schedule() {
      const timer = setInterval(() => { try { this.sweep(); } catch (err) { console.error('[supporter] sweep failed', err); } }, 60 * 60 * 1000);
      timer.unref();
    },

    /** For Admin › Supporters. */
    overview(now = Date.now()) {
      return {
        counts: stmts.counts.get(now),
        members: stmts.members.all(now).map((m) => ({ ...m, active: supporter.isActive(m, now) })),
        events: stmts.events.all(30),
        revenue: stmts.revenue.all(now - 30 * DAY),
      };
    },
  };
}

module.exports = { createSupporterService };
