'use strict';

const crypto = require('node:crypto');
const slots = require('./slots');
const game = require('./game');
const tuning = require('./tuning');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;

/**
 * Casino games played with in-game cash. Every bet is one ledger entry with
 * the net result (reason `casino-<game>`), and a row in casino_plays for the
 * player's history and the big-wins board.
 */
function createCasinoService(db, players) {
  const stmts = {
    insert: db.prepare('INSERT INTO casino_plays (user_id, game, bet, payout, mult, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    lastAt: db.prepare('SELECT MAX(created_at) AS at FROM casino_plays WHERE user_id = ?'),
    recent: db.prepare('SELECT * FROM casino_plays WHERE user_id = ? AND game = ? ORDER BY id DESC LIMIT ?'),
    today: db.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(bet), 0) AS wagered, COALESCE(SUM(payout), 0) AS won, COALESCE(MAX(payout - bet), 0) AS best
                       FROM casino_plays WHERE user_id = ? AND game = ? AND created_at >= ?`),
    bigWins: db.prepare(`SELECT p.*, u.username, u.avatar_v FROM casino_plays p JOIN users u ON u.id = p.user_id
                         WHERE p.game = ? AND p.mult >= ? AND p.created_at >= ? AND u.banned_at IS NULL ORDER BY p.payout DESC, p.id DESC LIMIT ?`),
    prune: db.prepare('DELETE FROM casino_plays WHERE created_at < ?'),
  };

  /** Why `player` can't play right now, or null. */
  function blocker(player) {
    if (!tuning.get('casinoOpen')) return 'The casino is closed for now. Check back later.';
    const min = tuning.get('casinoMinLevel');
    if (player.level < min) return `The casino opens at level ${min}.`;
    return null;
  }

  return {
    blocker,
    limits: () => ({ minBet: slots.MIN_BET, maxBet: tuning.get('slotsMaxBet') }),

    /**
     * One spin of the slot machine, inside the caller's transaction.
     * Returns { line, mult, payout, net, text, cash, play } or { error }.
     */
    spinSlots({ userId, bet: rawBet, now = Date.now(), randomInt = crypto.randomInt }) {
      const player = game.applyRegen(players.findById(userId), now);
      const why = blocker(player);
      if (why) return { error: why };
      const b = slots.checkBet(rawBet, { cash: player.cash, maxBet: tuning.get('slotsMaxBet') });
      if (b.error) return b;
      if (now - (stmts.lastAt.get(userId).at || 0) < slots.SPIN_COOLDOWN_MS) return { error: 'The reels are still turning. Give it a moment.' };
      const result = slots.spin(b.bet, randomInt);
      const id = Number(stmts.insert.run(userId, 'slots', b.bet, result.payout, result.mult, JSON.stringify({ line: result.line, kind: result.kind }), now).lastInsertRowid);
      player.cash += result.payout - b.bet;
      players.save(player, { reason: 'casino-slots', ref: `casino:${id}` });
      return { ...result, bet: b.bet, net: result.payout - b.bet, text: slots.describe(result), cash: player.cash, playId: id, player };
    },

    /** The player's latest plays of a game, newest first. */
    recent: (userId, gameId = 'slots', limit = 10) => stmts.recent.all(userId, gameId, limit).map((p) => ({ ...p, result: JSON.parse(p.result), net: p.payout - p.bet })),

    /** Today's (last 24 hours) totals for a player at a game. */
    today(userId, gameId = 'slots', now = Date.now()) {
      const t = stmts.today.get(userId, gameId, now - DAY_MS);
      return { ...t, net: t.won - t.wagered };
    },

    /** The biggest wins of the past week (20× and up). */
    bigWins: (gameId = 'slots', limit = 8, now = Date.now()) => stmts.bigWins.all(gameId, slots.BIG_WIN, now - 7 * DAY_MS, limit).map((p) => ({ ...p, result: JSON.parse(p.result) })),

    prune: (now = Date.now()) => stmts.prune.run(now - KEEP_MS).changes,
    schedule() {
      const timer = setInterval(() => { try { this.prune(); } catch (err) { console.error('[casino] prune failed', err); } }, 6 * 60 * 60 * 1000);
      timer.unref();
    },
  };
}

module.exports = { createCasinoService };
