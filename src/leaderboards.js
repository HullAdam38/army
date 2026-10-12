'use strict';

/**
 * Leaderboards. Each board is a fixed SQL ranking (no user input reaches the
 * query text). Only public facts are ranked: no cash, bank or training boards.
 * Suspended players are left out.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP = 50;

const BOARDS = {
  level: {
    label: 'Top soldiers',
    blurb: 'Highest level, then most XP towards the next.',
    valueLabel: 'Level',
    // value/detail are what the table shows; order decides the rank.
    source: `SELECT id, username, level, last_seen_at, signed_out_at, level AS value, xp AS detail FROM users WHERE banned_at IS NULL`,
    order: 'level DESC, detail DESC, id ASC',
  },
  pvp: {
    label: 'PvP wins',
    blurb: 'Most fights won, attacking or defending. Fewer losses breaks ties.',
    valueLabel: 'Wins',
    source: `SELECT id, username, level, last_seen_at, signed_out_at, pvp_wins AS value, pvp_losses AS detail FROM users WHERE banned_at IS NULL AND pvp_wins > 0`,
    order: 'value DESC, detail ASC, id ASC',
  },
  missions: {
    label: 'Missions won',
    blurb: 'Most successful missions.',
    valueLabel: 'Missions',
    source: `SELECT id, username, level, last_seen_at, signed_out_at, missions_completed AS value, missions_failed AS detail FROM users WHERE banned_at IS NULL AND missions_completed > 0`,
    order: 'value DESC, detail ASC, id ASC',
  },
  weekly: {
    label: 'This week',
    blurb: 'XP earned from missions and fights in the last 7 days. Anyone can top this one.',
    valueLabel: 'XP',
    source: `SELECT u.id, u.username, u.level, u.last_seen_at, u.signed_out_at, SUM(a.xp) AS value, COUNT(*) AS detail
             FROM actions a JOIN users u ON u.id = a.user_id
             WHERE a.created_at >= :since AND u.banned_at IS NULL
             GROUP BY u.id HAVING SUM(a.xp) > 0`,
    order: 'value DESC, id ASC',
  },
};

function createLeaderboards(db) {
  const stmts = Object.fromEntries(Object.entries(BOARDS).map(([key, b]) => [key, db.prepare(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${b.order}) AS position FROM (${b.source})
    )
    SELECT * FROM ranked WHERE position <= :top OR id = :me ORDER BY position`)]));

  return {
    /**
     * Returns { rows (top 50), me (your row, or null if you're unranked),
     * total }. `me.outside` is true when you're not in the top 50.
     */
    board(key, meId, now = Date.now()) {
      const params = { top: TOP, me: meId };
      if (key === 'weekly') params.since = now - WEEK_MS;
      const all = stmts[key].all(params);
      const rows = all.filter((r) => r.position <= TOP);
      const mine = all.find((r) => r.id === meId) || null;
      return { rows, me: mine ? { ...mine, outside: mine.position > TOP } : null };
    },
  };
}

module.exports = { BOARDS, TOP, createLeaderboards };
