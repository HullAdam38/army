'use strict';

const webpush = require('web-push');
const push = require('./push');
const game = require('./game');

const MAX_DEVICES = 10; // per player; the oldest is dropped
const MAX_PER_HOUR = 30; // pushes per player, so a busy evening can't flood a phone
const ACTIVE_MS = 50 * 1000; // a visible game tab polls every 20s; no pushes while one is open
const ENERGY_CHECK_MS = 2 * 60 * 1000;

/**
 * Push notifications: alerts on a player's phone or computer even when the
 * game isn't open. Players opt in per device (/account/alerts) and pick
 * which categories they want. Every in-game notification passes through
 * notify(); private messages and "energy full" are sent from here directly.
 *
 * `sender(subscription, payload, options)` does the actual sending (web-push
 * by default; tests pass a fake). It resolves, or rejects with an error that
 * has a `statusCode`.
 */
function createPushService(db, players, { sender = null, contact = null } = {}) {
  const stmts = {
    key: db.prepare('SELECT value FROM app_keys WHERE name = ?'),
    setKey: db.prepare('INSERT INTO app_keys (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'),
    subs: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id'),
    byEndpoint: db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?'),
    insert: db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, device = COALESCE(?, device), last_error = NULL WHERE id = ?'),
    replace: db.prepare('UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, last_error = NULL WHERE id = ?'),
    remove: db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?'),
    removeEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    removeById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
    sent: db.prepare('UPDATE push_subscriptions SET last_sent_at = ?, last_error = NULL WHERE id = ?'),
    failed: db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?'),
    prefs: db.prepare('SELECT push_prefs FROM users WHERE id = ?'),
    setPrefs: db.prepare('UPDATE users SET push_prefs = ? WHERE id = ?'),
    usersWithSubs: db.prepare(`SELECT DISTINCT u.id, u.push_prefs FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.banned_at IS NULL`),
    energyCandidates: db.prepare(`
      SELECT u.* FROM users u
      WHERE u.banned_at IS NULL AND u.energy < u.max_energy AND u.push_prefs LIKE '%"energy"%'
        AND (u.energy_push_for IS NULL OR u.energy_push_for != u.energy_updated_at)
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)`),
    energyDone: db.prepare('UPDATE users SET energy_push_for = ? WHERE id = ?'),
  };

  // The server's VAPID key pair identifies it to the push services. Made once and kept.
  let keys = null;
  function vapid() {
    if (keys) return keys;
    const stored = stmts.key.get('vapid');
    if (stored) keys = JSON.parse(stored.value);
    else {
      keys = webpush.generateVAPIDKeys();
      stmts.setKey.run('vapid', JSON.stringify(keys));
    }
    return keys;
  }
  const subject = () => {
    const c = contact || process.env.PUSH_CONTACT || (process.env.LEGAL_CONTACT_EMAIL ? `mailto:${process.env.LEGAL_CONTACT_EMAIL}` : '');
    return /^(mailto:|https:\/\/)/.test(c) ? c : 'mailto:admin@generalforces.com';
  };
  const send = sender || ((sub, payload, options) => webpush.sendNotification(sub, payload, {
    ...options,
    vapidDetails: { subject: subject(), publicKey: vapid().publicKey, privateKey: vapid().privateKey },
  }));

  // When each player last had a visible game tab open (from the notification poll).
  const visibleAt = new Map();
  // Recent push times per player, for the hourly cap.
  const sentLog = new Map();

  const prefsOf = (userId) => {
    const row = stmts.prefs.get(userId);
    return row ? push.parsePrefs(row.push_prefs) : null;
  };

  async function sendTo(sub, payload) {
    try {
      await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
        TTL: 12 * 60 * 60,
        urgency: payload.tag === 'attacks' || payload.tag === 'mentions' || payload.tag === 'messages' ? 'high' : 'normal',
        topic: payload.tag, // a newer alert of the same kind replaces an undelivered one
      });
      stmts.sent.run(Date.now(), sub.id);
      return true;
    } catch (err) {
      // 404/410: the browser dropped this subscription (app removed, permission revoked).
      if (err && (err.statusCode === 404 || err.statusCode === 410)) stmts.removeById.run(sub.id);
      else stmts.failed.run(String((err && (err.statusCode || err.message)) || 'error').slice(0, 200), sub.id);
      return false;
    }
  }

  /**
   * Sends an alert to all of a player's devices if they want this category
   * and aren't busy playing or in quiet hours. Resolves to how many devices
   * it reached. `force` (the test button) skips those checks.
   */
  async function deliver(userId, category, message, link, { now = Date.now(), force = false } = {}) {
    const subs = stmts.subs.all(userId);
    if (!subs.length) return 0;
    if (!force) {
      const prefs = prefsOf(userId);
      if (!prefs || !prefs.categories.includes(category)) return 0;
      if (push.inQuietHours(prefs, now)) return 0;
      if (now - (visibleAt.get(userId) || 0) < ACTIVE_MS) return 0; // they'll see it in the game
      const log = (sentLog.get(userId) || []).filter((t) => t > now - 60 * 60 * 1000);
      if (log.length >= MAX_PER_HOUR) return 0;
      log.push(now);
      sentLog.set(userId, log);
    }
    const payload = push.payloadFor(category, message, link);
    const results = await Promise.all(subs.map((s) => sendTo(s, payload)));
    return results.filter(Boolean).length;
  }

  // Every in-game notification may become a push. Sent after the current
  // request's database work, so a slow push service never holds it up.
  const pending = new Set();
  function fromNotification(userId, kind, message, link) {
    const category = push.categoryForKind(kind);
    if (!category) return;
    const p = new Promise((resolve) => setImmediate(resolve))
      .then(() => deliver(userId, category, message, link))
      .catch((err) => console.error('[push] send failed', err))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  players.onNotify(fromNotification);

  return {
    MAX_DEVICES,
    publicKey: () => vapid().publicKey,
    categories: push.CATEGORIES,

    /** Saves a browser's subscription for a player. Returns { device } or { error }. */
    subscribe(userId, input, userAgent = '', now = Date.now()) {
      const sub = push.validateSubscription(input);
      if (sub.error) return sub;
      const device = push.deviceLabel(userAgent);
      const existing = stmts.byEndpoint.get(sub.endpoint);
      if (existing) stmts.update.run(userId, sub.p256dh, sub.auth, device, existing.id);
      else stmts.insert.run(userId, sub.endpoint, sub.p256dh, sub.auth, device, now);
      // First device: start them on the recommended categories.
      if (!prefsOf(userId)) stmts.setPrefs.run(JSON.stringify(push.normalizePrefs({}, { useDefaults: true })), userId);
      const all = stmts.subs.all(userId);
      for (const old of all.slice(0, Math.max(0, all.length - MAX_DEVICES))) stmts.removeById.run(old.id);
      return { device };
    },

    /** Turns alerts off for one browser (by its endpoint). */
    unsubscribe(userId, endpoint) {
      const sub = stmts.byEndpoint.get(String(endpoint || ''));
      if (!sub || sub.user_id !== userId) return false;
      stmts.removeById.run(sub.id);
      return true;
    },

    removeDevice: (userId, id) => stmts.remove.run(Number(id), userId).changes > 0,

    /** The browser swapped its subscription: knowing the old endpoint proves it's the same device. */
    renew(oldEndpoint, input) {
      const old = oldEndpoint ? stmts.byEndpoint.get(String(oldEndpoint)) : null;
      const sub = push.validateSubscription(input);
      if (!old || sub.error) return false;
      if (stmts.byEndpoint.get(sub.endpoint)) stmts.removeById.run(old.id);
      else stmts.replace.run(sub.endpoint, sub.p256dh, sub.auth, old.id);
      return true;
    },

    devices: (userId) => stmts.subs.all(userId).map((s) => ({ id: s.id, device: s.device || 'Device', created_at: s.created_at, last_sent_at: s.last_sent_at, last_error: s.last_error, endpoint: s.endpoint })),

    /** A player's alert settings (defaults if they've never chosen). */
    prefs: (userId) => prefsOf(userId) || push.normalizePrefs({}, { useDefaults: true }),
    setPrefs(userId, input) {
      const prefs = push.normalizePrefs(input);
      stmts.setPrefs.run(JSON.stringify(prefs), userId);
      return prefs;
    },

    /** Called by the notification poll: this player has the game open and visible. */
    markVisible: (userId, now = Date.now()) => visibleAt.set(userId, now),

    deliver,

    /** Sends a test alert to every device, ignoring settings. Resolves to devices reached. */
    test: (userId) => deliver(userId, 'news', 'Alerts are working. This is how GeneralForces will reach you.', '/account/alerts', { force: true }),

    /** A private message arrived. `text` is what the alert says. */
    message(recipientId, text, conversationId) {
      const p = deliver(recipientId, 'messages', String(text).slice(0, 200), `/messages/${conversationId}#latest`)
        .catch((err) => console.error('[push] send failed', err));
      pending.add(p);
      p.finally(() => pending.delete(p));
      return p;
    },

    /** Sends to everyone who wants this category (events going live, admin announcements). */
    async broadcast(category, message, link) {
      let n = 0;
      for (const u of stmts.usersWithSubs.all()) {
        const prefs = push.parsePrefs(u.push_prefs);
        if (prefs && prefs.categories.includes(category)) n += await deliver(u.id, category, message, link);
      }
      return n;
    },

    /** "Energy full" alerts, once per refill. Resolves to how many players were alerted. */
    async checkEnergy(now = Date.now()) {
      let n = 0;
      for (const u of stmts.energyCandidates.all()) {
        const p = game.applyRegen(u, now);
        if (p.energy < p.max_energy) continue;
        stmts.energyDone.run(u.energy_updated_at, u.id); // once per refill, sent or not
        n += (await deliver(u.id, 'energy', `Your energy is full (${p.max_energy}/${p.max_energy}). Time for a mission, soldier.`, '/missions', { now })) ? 1 : 0;
      }
      return n;
    },

    schedule() {
      const timer = setInterval(() => { this.checkEnergy().catch((err) => console.error('[push] energy check failed', err)); }, ENERGY_CHECK_MS);
      timer.unref();
    },

    /** Resolves once queued sends have finished (for tests). */
    settle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}

module.exports = { createPushService };
