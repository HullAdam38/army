'use strict';

/**
 * Casino statistics for Admin › Casino, from casino_plays (kept 30 days) and
 * the ledger: what each game took, how its actual return compares with what
 * the maths says, who's up and down, and who is winning more than luck explains.
 */

const slots = require('./slots');
const blackjack = require('./blackjack');

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const GAMES = {
  slots: { name: 'Slot machine', rtp: slots.returnToPlayer().rtp, variance: slots.returnToPlayer().variance, rtpNote: 'exact' },
  roulette: { name: 'Roulette', rtp: 36 / 37, variance: 1, rtpNote: 'exact' },
  blackjack: { name: 'Blackjack', rtp: blackjack.RTP, variance: blackjack.VARIANCE, rtpNote: 'with perfect play; real players do a little worse' },
};
// A player is flagged when their winnings are this many standard deviations above what the game pays on average.
const LUCK_Z = 3;
const LUCK_MIN_PLAYS = 20;

function createCasinoStats(db) {
  const varianceSql = `COALESCE(variance, bet * bet * CASE game ${Object.entries(GAMES).map(([id, g]) => `WHEN '${id}' THEN ${g.variance}`).join(' ')} ELSE 1 END)`;
  const stmts = {
    games: db.prepare(`SELECT game, COUNT(*) AS plays, COUNT(DISTINCT user_id) AS players, SUM(bet) AS wagered, SUM(payout) AS paid
                       FROM casino_plays WHERE created_at >= ? GROUP BY game`),
    biggest: db.prepare(`SELECT p.user_id, p.bet, p.payout, p.created_at, u.username FROM casino_plays p JOIN users u ON u.id = p.user_id
                         WHERE p.game = ? AND p.created_at >= ? ORDER BY p.payout - p.bet DESC LIMIT 1`),
    daily: db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, game, SUM(bet) AS wagered, SUM(payout) AS paid
                       FROM casino_plays WHERE created_at >= ? GROUP BY day, game`),
    winners: db.prepare(`SELECT p.user_id, u.username, u.banned_at, COUNT(*) AS plays, SUM(p.bet) AS wagered, SUM(p.payout - p.bet) AS net
                         FROM casino_plays p JOIN users u ON u.id = p.user_id WHERE p.created_at >= ?
                         GROUP BY p.user_id HAVING net > 0 ORDER BY net DESC LIMIT 10`),
    losers: db.prepare(`SELECT p.user_id, u.username, u.banned_at, COUNT(*) AS plays, SUM(p.bet) AS wagered, SUM(p.payout - p.bet) AS net
                        FROM casino_plays p JOIN users u ON u.id = p.user_id WHERE p.created_at >= ?
                        GROUP BY p.user_id HAVING net < 0 ORDER BY net ASC LIMIT 10`),
    luck: db.prepare(`SELECT p.user_id, u.username, u.banned_at, p.game, COUNT(*) AS plays, SUM(p.bet) AS wagered, SUM(p.payout) AS paid, SUM(${varianceSql}) AS variance
                      FROM casino_plays p JOIN users u ON u.id = p.user_id WHERE p.created_at >= ?
                      GROUP BY p.user_id, p.game HAVING plays >= ?`),
    // Everything players earned outside the casino, to put the casino's take in proportion.
    earned: db.prepare(`SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger
                        WHERE created_at >= ? AND delta_cash > 0 AND reason NOT LIKE 'casino-%' AND reason NOT IN ('opening-balance', 'test')`),
  };

  return {
    GAMES,
    LUCK_Z,
    LUCK_MIN_PLAYS,

    /** Everything the page shows for the last `days` days. */
    overview({ days = 7, now = Date.now() } = {}) {
      const since = now - days * DAY;
      const rows = new Map(stmts.games.all(since).map((r) => [r.game, r]));
      const games = Object.entries(GAMES).map(([id, g]) => {
        const r = rows.get(id) || { plays: 0, players: 0, wagered: 0, paid: 0 };
        return {
          id, ...g, ...r,
          take: r.wagered - r.paid,
          actualRtp: r.wagered ? r.paid / r.wagered : null,
          biggest: r.plays ? stmts.biggest.get(id, since) : null,
        };
      });
      const total = games.reduce((t, g) => ({ plays: t.plays + g.plays, wagered: t.wagered + g.wagered, paid: t.paid + g.paid }), { plays: 0, wagered: 0, paid: 0 });
      total.take = total.wagered - total.paid;

      // The house's take per day (it can be negative on a lucky day for players).
      const byDay = new Map();
      for (const r of stmts.daily.all(since)) {
        const d = byDay.get(r.day) || { wagered: 0, take: 0, games: {} };
        d.wagered += r.wagered;
        d.take += r.wagered - r.paid;
        d.games[r.game] = r.wagered - r.paid;
        byDay.set(r.day, d);
      }
      const daily = Array.from({ length: days }, (_, i) => {
        const day = dayKey(now - (days - 1 - i) * DAY);
        return { day, ...(byDay.get(day) || { wagered: 0, take: 0, games: {} }) };
      });

      // Luck: how far each player's winnings at a game are above what the game pays on average,
      // in standard deviations (z). Recorded per play, so mixed bet sizes and roulette bet types are fair.
      const lucky = stmts.luck.all(since, LUCK_MIN_PLAYS).map((r) => {
        const expected = r.wagered * GAMES[r.game].rtp;
        const z = r.variance > 0 ? (r.paid - expected) / Math.sqrt(r.variance) : 0;
        return { ...r, gameName: GAMES[r.game].name, net: r.paid - r.wagered, actualRtp: r.paid / r.wagered, z };
      }).filter((r) => r.z >= LUCK_Z).sort((a, b) => b.z - a.z).slice(0, 20);

      const earned = stmts.earned.get(since).n;
      return {
        days, since, games, total, daily, lucky, earned,
        takeShare: earned ? total.take / earned : null,
        winners: stmts.winners.all(since),
        losers: stmts.losers.all(since),
      };
    },
  };
}

module.exports = { GAMES, LUCK_MIN_PLAYS, LUCK_Z, createCasinoStats };
