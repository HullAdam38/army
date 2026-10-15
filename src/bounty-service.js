'use strict';

const bounties = require('./bounties');
const { NEUTRAL } = require('./events');
const game = require('./game');
const pvp = require('./pvp');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Bounties backed by the database. place() and claim() move money, so call
 * them inside players.transaction(); expireDue() opens its own.
 * `isLinked(a, b)` comes from anti-cheat (shared device or network).
 */
function createBountyService(db, players, isLinked, { effects = () => NEUTRAL } = {}) {
  const stmts = {
    insert: db.prepare('INSERT INTO bounties (target_id, placer_id, amount, fee, anonymous, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    openOn: db.prepare("SELECT * FROM bounties WHERE target_id = ? AND status = 'open' AND expires_at > ? ORDER BY id"),
    openByPlacer: db.prepare("SELECT COUNT(*) AS n FROM bounties WHERE placer_id = ? AND status = 'open'"),
    claim: db.prepare("UPDATE bounties SET status = 'claimed', claimer_id = ?, battle_id = ?, settled_at = ? WHERE id = ? AND status = 'open'"),
    due: db.prepare("SELECT id FROM bounties WHERE status = 'open' AND expires_at <= ?"),
    byId: db.prepare('SELECT * FROM bounties WHERE id = ?'),
    expire: db.prepare("UPDATE bounties SET status = 'expired', settled_at = ? WHERE id = ? AND status = 'open'"),
    wanted: db.prepare(`
      SELECT u.id, u.username, u.level, u.hospital_until, u.last_seen_at, u.signed_out_at,
             SUM(b.amount) AS total, COUNT(*) AS count, MIN(b.expires_at) AS first_expiry, MAX(b.created_at) AS latest
      FROM bounties b JOIN users u ON u.id = b.target_id
      WHERE b.status = 'open' AND b.expires_at > ? AND u.banned_at IS NULL
      GROUP BY u.id ORDER BY total DESC, latest DESC LIMIT ?`),
    claims: db.prepare(`
      SELECT b.target_id, t.username AS target, c.username AS claimer, b.battle_id, b.settled_at, SUM(b.amount) AS total, COUNT(*) AS count
      FROM bounties b JOIN users t ON t.id = b.target_id JOIN users c ON c.id = b.claimer_id
      WHERE b.status = 'claimed' GROUP BY b.battle_id ORDER BY b.settled_at DESC LIMIT ?`),
    placedBy: db.prepare(`
      SELECT b.*, t.username AS target, c.username AS claimer FROM bounties b
      JOIN users t ON t.id = b.target_id LEFT JOIN users c ON c.id = b.claimer_id
      WHERE b.placer_id = ? ORDER BY b.id DESC LIMIT ?`),
    onTarget: db.prepare(`
      SELECT b.amount, b.anonymous, b.created_at, b.expires_at, p.username AS placer FROM bounties b
      LEFT JOIN users p ON p.id = b.placer_id
      WHERE b.target_id = ? AND b.status = 'open' AND b.expires_at > ? ORDER BY b.amount DESC`),
    forBattle: db.prepare("SELECT SUM(amount) AS total, COUNT(*) AS count FROM bounties WHERE battle_id = ? AND status = 'claimed'"),
    claimedBy: db.prepare("SELECT COUNT(DISTINCT battle_id) AS n FROM bounties WHERE claimer_id = ? AND status = 'claimed'"),
  };

  const placerName = (b) => (b.anonymous || !b.placer ? 'Someone' : b.placer);

  return {
    /** Posts a bounty. Returns { error } or { amount, fee, total }. */
    place({ placerId, target, amountInput, anonymous = false, now = Date.now() }) {
      const placer = game.applyRegen(players.findById(placerId), now);
      const blocker = bounties.placeBlocker(placer, target, {
        minPvpLevel: pvp.MIN_PVP_LEVEL,
        openByPlacer: stmts.openByPlacer.get(placer.id).n,
        linked: placer.id !== target.id && isLinked(placer.id, target.id, now),
      });
      if (blocker) return { error: blocker };
      const a = bounties.parseAmount(amountInput, { feeFree: effects(now).bountyFeeFree });
      if (a.error) return a;
      if (placer.cash < a.total) return { error: `A ${money(a.amount)} bounty costs ${money(a.total)} including the ${money(a.fee)} fee. You have ${money(placer.cash)} on hand.` };
      placer.cash -= a.total;
      players.save(placer, { reason: 'bounty-placed', ref: `user:${target.id}` });
      stmts.insert.run(target.id, placer.id, a.amount, a.fee, anonymous ? 1 : 0, now, now + bounties.DURATION_MS);
      players.log(placer.id, 'bounty', `Put a ${money(a.amount)} bounty on ${target.username}${anonymous ? ' (anonymously)' : ''}. Fee ${money(a.fee)}.`, '/bounties');
      players.notify(target.id, 'bounty', `${anonymous ? 'Someone' : placer.username} put a ${money(a.amount)} bounty on your head. Whoever beats you first collects it.`, '/bounties');
      return a;
    },

    /**
     * Pays every bounty on `targetId` that `claimerId` is allowed to collect.
     * Call after a full-reward PvP win. Returns { total, count } or null.
     */
    claim({ claimerId, targetId, battleId, now = Date.now() }) {
      const open = stmts.openOn.all(targetId, now).filter((b) => bounties.claimable(b, claimerId, (x, y) => isLinked(x, y, now)));
      const won = open.filter((b) => stmts.claim.run(claimerId, battleId, now, b.id).changes);
      if (!won.length) return null;
      const total = won.reduce((n, b) => n + b.amount, 0);
      const claimer = players.findById(claimerId);
      claimer.cash += total;
      players.save(claimer, { reason: 'bounty-claim', ref: `battle:${battleId}` });
      const target = players.findById(targetId);
      const link = `/battles/${battleId}`;
      players.log(claimerId, 'bounty', `Collected ${won.length === 1 ? 'a' : won.length} bount${won.length === 1 ? 'y' : 'ies'} on ${target.username}: +${money(total)}.`, link);
      players.notify(targetId, 'bounty', `${claimer.username} beat you and collected the ${money(total)} bounty on your head.`, link);
      for (const b of won) {
        if (b.placer_id) players.notify(b.placer_id, 'bounty', `${claimer.username} collected your ${money(b.amount)} bounty on ${target.username}.`, link);
      }
      return { total, count: won.length };
    },

    /** Refunds bounties nobody collected in time (the fee is kept). */
    expireDue(now = Date.now()) {
      let n = 0;
      for (const { id } of stmts.due.all(now)) {
        players.transaction(() => {
          const b = stmts.byId.get(id);
          if (!b || !stmts.expire.run(now, id).changes) return;
          n += 1;
          if (!b.placer_id) return;
          const placer = players.findById(b.placer_id);
          if (!placer) return;
          placer.cash += b.amount;
          players.save(placer, { reason: 'bounty-refund', ref: `bounty:${id}` });
          const target = players.findById(b.target_id);
          players.notify(placer.id, 'bounty', `Nobody collected your ${money(b.amount)} bounty on ${target ? target.username : 'a soldier'} in 7 days. It’s been refunded (the fee isn’t).`, '/bounties');
        });
      }
      return n;
    },

    wanted: (now = Date.now(), limit = 25) => stmts.wanted.all(now, limit),
    recentClaims: (limit = 10) => stmts.claims.all(limit),
    placedBy: (userId, limit = 15) => stmts.placedBy.all(userId, limit),
    /** Open bounties on a player, with placers hidden when anonymous. */
    onTarget: (userId, now = Date.now()) => stmts.onTarget.all(userId, now).map((b) => ({ ...b, placer: placerName(b) })),
    totalOn(userId, now = Date.now()) {
      const list = stmts.openOn.all(userId, now);
      return { total: list.reduce((n, b) => n + b.amount, 0), count: list.length };
    },
    forBattle(battleId) {
      const r = stmts.forBattle.get(battleId);
      return r && r.count ? { total: r.total, count: r.count } : null;
    },
    claimedCount: (userId) => stmts.claimedBy.get(userId).n,

    /** Runs expireDue() every few minutes in the background. */
    schedule(ms = 5 * 60 * 1000) {
      setInterval(() => {
        try { this.expireDue(); } catch (err) { console.error('[bounties] expiry failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createBountyService };
