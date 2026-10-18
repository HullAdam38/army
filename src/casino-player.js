'use strict';

/**
 * What the casino keeps for each player, shared by every game:
 *
 * - Limits players set for themselves: a daily loss limit (net losses over
 *   the last 24 hours) and breaks of a day, a week or a month. Tightening a
 *   limit or taking a break works at once and can't be undone early; loosening
 *   a limit waits 24 hours, so it's never a decision made mid-session.
 * - Career counters for the casino medals (casino_plays only keeps 30 days).
 * - Big-win shouts in global chat.
 */

const tuning = require('./tuning');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMIT_DELAY_MS = DAY; // raising or removing a limit takes this long
const MAX_LIMIT = 100_000_000;
const BREAKS = {
  day: { label: '24 hours', ms: DAY },
  week: { label: '7 days', ms: 7 * DAY },
  month: { label: '30 days', ms: 30 * DAY },
};
const BIG_WIN = 20; // × the bet: counts towards the Big Winner medal

const GAME_NAMES = { slots: 'the slot machine', roulette: 'roulette', blackjack: 'blackjack' };
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Parses the loss limit field: blank means none. Returns { error } or { limit } (null for none). */
function parseLimit(raw) {
  const s = String(raw ?? '').replace(/[$,\s]/g, '');
  if (s === '') return { limit: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 100 || n > MAX_LIMIT) return { error: `Set a whole-dollar limit from $100 to ${money(MAX_LIMIT)}, or leave it blank for none.` };
  return { limit: n };
}

function createCasinoPlayer(db) {
  const stmts = {
    user: db.prepare('SELECT id, username, casino_loss_limit, casino_limit_next, casino_limit_next_at, casino_break_until FROM users WHERE id = ?'),
    lost: db.prepare('SELECT COALESCE(SUM(bet - payout), 0) AS n FROM casino_plays WHERE user_id = ? AND created_at >= ?'),
    setLimit: db.prepare('UPDATE users SET casino_loss_limit = ?, casino_limit_next = NULL, casino_limit_next_at = NULL WHERE id = ?'),
    setNext: db.prepare('UPDATE users SET casino_limit_next = ?, casino_limit_next_at = ? WHERE id = ?'),
    setBreak: db.prepare('UPDATE users SET casino_break_until = ? WHERE id = ?'),
    count: db.prepare('UPDATE users SET casino_wagered = casino_wagered + ?, casino_big_wins = casino_big_wins + ?, casino_blackjacks = casino_blackjacks + ? WHERE id = ?'),
    shout: db.prepare("INSERT INTO chat_messages (channel, user_id, body, created_at, kind) VALUES ('global', ?, ?, ?, 'casino')"),
    onBreak: db.prepare('SELECT COUNT(*) AS n FROM users WHERE casino_break_until > ?'),
    withLimit: db.prepare('SELECT COUNT(*) AS n FROM users WHERE casino_loss_limit IS NOT NULL'),
  };
  // Cash a player has on the table right now that isn't in casino_plays yet (blackjack bets mid-round).
  const inPlayFns = [];

  /** The limit in force now, applying a loosened limit once its 24 hours are up. */
  function current(u, now) {
    if (u.casino_limit_next_at && u.casino_limit_next_at <= now) {
      const next = u.casino_limit_next || null; // 0 stores "no limit"
      stmts.setLimit.run(next, u.id);
      u.casino_loss_limit = next;
      u.casino_limit_next = null;
      u.casino_limit_next_at = null;
    }
    return u.casino_loss_limit;
  }

  const inPlay = (userId) => inPlayFns.reduce((n, fn) => n + fn(userId), 0);

  return {
    BREAKS,
    LIMIT_DELAY_MS,
    parseLimit,

    /** Lets a game report cash a player has staked but not yet settled. */
    trackInPlay(fn) { inPlayFns.push(fn); },

    /** Everything the limits page shows. */
    status(userId, now = Date.now()) {
      const u = stmts.user.get(userId);
      const limit = current(u, now);
      const lost = Math.max(0, stmts.lost.get(userId, now - DAY).n + inPlay(userId));
      return {
        limit,
        next: u.casino_limit_next_at ? (u.casino_limit_next || null) : undefined, // undefined: nothing pending
        nextAt: u.casino_limit_next_at || null,
        breakUntil: u.casino_break_until > now ? u.casino_break_until : null,
        lost,
        room: limit === null ? null : Math.max(0, limit - lost),
      };
    },

    /** Why the player can't play at all right now (a break), or null. */
    breakBlocker(player, now = Date.now()) {
      if (!(player.casino_break_until > now)) return null;
      const until = new Date(player.casino_break_until).toUTCString().replace(/:\d\d GMT$/, ' UTC');
      return `You’re taking a break from the casino until ${until}.`;
    },

    /** Why staking `amount` more would break the player's loss limit, or null. */
    stakeBlocker(userId, amount, now = Date.now()) {
      const s = this.status(userId, now);
      if (s.limit === null || amount <= s.room) return null;
      return s.room > 0
        ? `That would take you past your daily loss limit of ${money(s.limit)}. You can stake ${money(s.room)} more for now.`
        : `You’ve reached your daily loss limit of ${money(s.limit)}. It frees up as losses from the last 24 hours roll off.`;
    },

    /** How much more the player can stake under their limit (Infinity without one). */
    room(userId, now = Date.now()) {
      const s = this.status(userId, now);
      return s.limit === null ? Infinity : s.room;
    },

    /** Sets the daily loss limit. Tighter is immediate; looser waits 24 hours. Returns { ok } or { error }. */
    setLimit(userId, raw, now = Date.now()) {
      const p = parseLimit(raw);
      if (p.error) return p;
      const u = stmts.user.get(userId);
      const limit = current(u, now);
      const tighter = p.limit !== null && (limit === null || p.limit <= limit);
      if (tighter) {
        stmts.setLimit.run(p.limit, userId);
        return { ok: `Daily loss limit set to ${money(p.limit)}. It works from now.` };
      }
      if (p.limit === limit) return { ok: 'That’s already your limit.' };
      stmts.setNext.run(p.limit || 0, now + LIMIT_DELAY_MS, userId);
      return { ok: p.limit === null
        ? 'Your loss limit will be removed in 24 hours. Until then it stays as it is.'
        : `Your loss limit goes up to ${money(p.limit)} in 24 hours. Until then it stays at ${money(limit)}.` };
    },

    /** Cancels a pending loosening of the limit. */
    cancelPending(userId, now = Date.now()) {
      const u = stmts.user.get(userId);
      current(u, now); // a change whose 24 hours are up has already happened
      if (!u.casino_limit_next_at) return { error: 'There’s no change waiting.' };
      stmts.setLimit.run(u.casino_loss_limit, userId);
      return { ok: 'Change cancelled. Your limit stays as it is.' };
    },

    /** Starts a break (or makes one longer). It can't be shortened or ended early. */
    takeBreak(userId, key, now = Date.now()) {
      const b = BREAKS[key];
      if (!b) return { error: 'Pick how long a break to take.' };
      const u = stmts.user.get(userId);
      const until = now + b.ms;
      if (u.casino_break_until && u.casino_break_until >= until) return { error: 'You’re already on a break that lasts longer than that.' };
      stmts.setBreak.run(until, userId);
      return { ok: `You’re on a break from the casino for ${b.label}. See you after.`, until };
    },

    /**
     * Records a settled play: medal counters, and a shout in global chat for a
     * big win. `detail` (optional) describes the win, e.g. "a 100× jackpot".
     */
    record({ userId, username, game, bet, payout, blackjacks = 0, detail = null, now = Date.now() }) {
      stmts.count.run(bet, payout >= bet * BIG_WIN ? 1 : 0, blackjacks, userId);
      const min = tuning.get('casinoShoutMin');
      const net = payout - bet;
      if (!min || net < min) return null;
      const name = username || stmts.user.get(userId).username;
      const body = `[b]${name}[/b] won [b]${money(net)}[/b] at ${GAME_NAMES[game] || game}${detail ? ` with ${detail}` : ''}!`;
      return Number(stmts.shout.run(userId, body, now).lastInsertRowid);
    },

    /** For Admin › Casino. */
    counts: (now = Date.now()) => ({ onBreak: stmts.onBreak.get(now).n, withLimit: stmts.withLimit.get().n }),
  };
}

module.exports = { BIG_WIN, BREAKS, LIMIT_DELAY_MS, createCasinoPlayer, parseLimit };
