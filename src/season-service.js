'use strict';

const seasons = require('./seasons');
const game = require('./game');
const { announceLevels } = require('./notify');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * PvP seasons backed by the database.
 * - rollover() opens its own transaction: call it outside players.transaction()
 *   (before an attack, on page views, and every minute in the background).
 * - recordFight() and reverseBattles() run inside the caller's transaction.
 *   Pass recordFight() anti-cheat's reward plan and whether the two accounts
 *   are linked (shared device or network): neither kind of fight is ranked.
 */
function createSeasonService(db, players) {
  const stmts = {
    active: db.prepare("SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"),
    byNumber: db.prepare('SELECT * FROM seasons WHERE number = ?'),
    lastNumber: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM seasons'),
    insertSeason: db.prepare("INSERT INTO seasons (number, starts_at, ends_at, status) VALUES (?, ?, ?, 'active')"),
    endSeason: db.prepare("UPDATE seasons SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'"),
    setEnds: db.prepare('UPDATE seasons SET ends_at = ? WHERE id = ?'),
    past: db.prepare(`
      SELECT s.*, u.username AS champion, r.rating AS champion_rating,
             (SELECT COUNT(*) FROM season_results x WHERE x.season_id = s.id) AS placed
      FROM seasons s
      LEFT JOIN season_results r ON r.season_id = s.id AND r.rank = 1
      LEFT JOIN users u ON u.id = r.user_id
      WHERE s.status = 'ended' ORDER BY s.number DESC LIMIT ?`),

    player: db.prepare('SELECT * FROM season_players WHERE season_id = ? AND user_id = ?'),
    insertPlayer: db.prepare('INSERT INTO season_players (season_id, user_id, rating, peak) VALUES (?, ?, ?, ?)'),
    updatePlayer: db.prepare(`UPDATE season_players SET rating = ?, peak = MAX(peak, ?), wins = wins + ?, losses = losses + ?, fights = fights + ?, last_fight_at = ?
                              WHERE season_id = ? AND user_id = ?`),
    undoPlayer: db.prepare(`UPDATE season_players SET rating = MAX(?, rating - ?), wins = wins - ?, losses = losses - ?, fights = fights - 1
                            WHERE season_id = ? AND user_id = ?`),
    previousFinal: db.prepare(`
      SELECT p.rating FROM season_players p JOIN seasons s ON s.id = p.season_id
      WHERE p.user_id = ? AND s.number < ? ORDER BY s.number DESC LIMIT 1`),

    insertBattle: db.prepare(`INSERT INTO season_battles (battle_id, season_id, attacker_id, defender_id, attacker_delta, defender_delta, attacker_after, defender_after)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    battle: db.prepare('SELECT b.*, s.number, s.status FROM season_battles b JOIN seasons s ON s.id = b.season_id WHERE b.battle_id = ?'),
    reverseBattle: db.prepare('UPDATE season_battles SET reversed_at = ? WHERE battle_id = ? AND reversed_at IS NULL'),

    // Placed players, best first. Ties go to more wins, then to whoever got there first.
    standings: db.prepare(`
      SELECT p.*, u.username, u.level FROM season_players p JOIN users u ON u.id = p.user_id
      WHERE p.season_id = ? AND p.fights >= ? AND u.banned_at IS NULL
      ORDER BY p.rating DESC, p.wins DESC, p.last_fight_at ASC LIMIT ?`),
    rankOf: db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM season_players p JOIN users u ON u.id = p.user_id
      WHERE p.season_id = ?1 AND p.fights >= ?2 AND u.banned_at IS NULL AND p.user_id != ?3
        AND (p.rating > ?4 OR (p.rating = ?4 AND (p.wins > ?5 OR (p.wins = ?5 AND p.last_fight_at < ?6))))`),
    placedCount: db.prepare(`SELECT COUNT(*) AS n FROM season_players p JOIN users u ON u.id = p.user_id
                             WHERE p.season_id = ? AND p.fights >= ? AND u.banned_at IS NULL`),
    unplaced: db.prepare('SELECT user_id, fights FROM season_players WHERE season_id = ? AND fights > 0 AND fights < ?'),

    insertResult: db.prepare(`INSERT OR IGNORE INTO season_results (season_id, user_id, rank, rating, peak, division, wins, losses, reward_cash, reward_xp)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    results: db.prepare(`SELECT r.*, u.username, u.level FROM season_results r JOIN users u ON u.id = r.user_id
                         WHERE r.season_id = ? ORDER BY r.rank LIMIT ?`),
    resultsFor: db.prepare(`SELECT r.*, s.number FROM season_results r JOIN seasons s ON s.id = r.season_id
                            WHERE r.user_id = ? ORDER BY s.number DESC LIMIT ?`),
    resultFor: db.prepare('SELECT * FROM season_results WHERE season_id = ? AND user_id = ?'),
    goldFinishes: db.prepare("SELECT COUNT(*) AS n FROM season_results WHERE user_id = ? AND division IN ('gold', 'elite')"),
  };

  /** The player's row this season, created at their starting rating if new. */
  function ensurePlayer(season, userId) {
    const row = stmts.player.get(season.id, userId);
    if (row) return row;
    const prev = stmts.previousFinal.get(userId, season.number);
    const rating = seasons.startingRating(prev ? prev.rating : null);
    stmts.insertPlayer.run(season.id, userId, rating, rating);
    return stmts.player.get(season.id, userId);
  }

  function startSeason(now) {
    const number = stmts.lastNumber.get().n + 1;
    stmts.insertSeason.run(number, now, now + seasons.seasonDays() * seasons.DAY);
    return stmts.byNumber.get(number);
  }

  /** Ranks the season, pays rewards, notifies everyone who took part. */
  function finishSeason(season, now) {
    if (!stmts.endSeason.run(now, season.id).changes) return null;
    const placed = stmts.standings.all(season.id, seasons.placementFights(), 1e9);
    const link = `/seasons/${season.number}`;
    placed.forEach((row, i) => {
      const rank = i + 1;
      const reward = seasons.rewardFor(row.rating, rank);
      stmts.insertResult.run(season.id, row.user_id, rank, row.rating, row.peak, reward.division.id, row.wins, row.losses, reward.cash, reward.xp);
      const p = players.findById(row.user_id);
      if (!p) return;
      p.cash += reward.cash;
      const levels = game.grantXp(p, reward.xp);
      players.save(p, { reason: 'season-reward', ref: `season:${season.number}` });
      const place = rank === 1 ? 'Champion' : `#${rank}`;
      players.log(p.id, 'success', `Season ${season.number} final: ${place}, ${reward.division.name} division (${row.rating}). +${money(reward.cash)}, +${reward.xp} XP.`, link);
      players.notify(p.id, 'season', `Season ${season.number} is over. You finished ${rank === 1 ? 'as Champion' : `#${rank}`} in ${reward.division.name} with ${row.rating} rating: +${money(reward.cash)}, +${reward.xp} XP.`, link);
      for (const lvl of levels) {
        const r = game.rankFor(lvl);
        players.log(p.id, 'promotion', `Promoted to level ${lvl} — ${r.name} (${r.grade}).`);
      }
      announceLevels(players, p.id, levels);
    });
    for (const u of stmts.unplaced.all(season.id, seasons.placementFights())) {
      players.notify(u.user_id, 'season', `Season ${season.number} is over. You had ${u.fights} ranked fight${u.fights === 1 ? '' : 's'}; ${seasons.placementFights()} are needed to place and earn a reward.`, link);
    }
    return { season, placed: placed.length };
  }

  const withRank = (season, row) => {
    if (!row) return null;
    const placed = row.fights >= seasons.placementFights();
    return {
      ...row,
      placed,
      rank: placed ? stmts.rankOf.get(season.id, seasons.placementFights(), row.user_id, row.rating, row.wins, row.last_fight_at ?? 0).rank : null,
      division: seasons.divisionFor(row.rating),
      progress: seasons.progressFor(row.rating),
    };
  };

  return {
    /** The active season, or null (rollover() creates one). */
    current: () => stmts.active.get() || null,
    byNumber: (n) => stmts.byNumber.get(n) || null,

    /**
     * Settles a season whose time is up and makes sure one is running.
     * Returns the active season. Safe to call often.
     */
    rollover(now = Date.now()) {
      let season = stmts.active.get();
      if (season && season.ends_at > now) return season;
      return players.transaction(() => {
        season = stmts.active.get();
        if (season && season.ends_at > now) return season;
        if (season) finishSeason(season, now);
        const next = startSeason(now);
        if (season) {
          // Let last season's players know the next one has begun.
          for (const r of stmts.results.all(season.id, 1e9)) {
            const start = seasons.startingRating(r.rating);
            players.notify(r.user_id, 'season', `Season ${next.number} has begun. You start at ${start} rating (${seasons.divisionFor(start).name}).`, '/seasons');
          }
        }
        return next;
      });
    },

    /** Admin: ends the active season now, pays out, starts the next. */
    endNow(now = Date.now()) {
      const season = stmts.active.get();
      if (!season) return null;
      stmts.setEnds.run(now, season.id);
      this.rollover(now);
      return season;
    },

    /**
     * Records a PvP fight for the active season. Call inside the attack's
     * transaction with anti-cheat's reward plan. Returns
     * { ranked: false, reason } or { ranked: true, number, attacker: { delta, rating }, defender: { … } }.
     */
    recordFight({ battleId, attackerId, defenderId, attackerWon, rewards, linked = false, now = Date.now() }) {
      const season = stmts.active.get();
      if (!season || season.ends_at <= now) return { ranked: false, reason: 'No season is running.' };
      if (!seasons.isRanked(rewards)) return { ranked: false, reason: rewards.note || 'Unranked fight.' };
      // Accounts that share a device or network never rank against each other, so alts can't farm rating.
      if (linked) return { ranked: false, reason: 'Unranked: these accounts are linked.' };
      const a = ensurePlayer(season, attackerId);
      const d = ensurePlayer(season, defenderId);
      const delta = seasons.ratingChange(a.rating, d.rating, attackerWon);
      const aAfter = seasons.applyDelta(a.rating, delta.attacker);
      const dAfter = seasons.applyDelta(d.rating, delta.defender);
      const aDelta = aAfter - a.rating;
      const dDelta = dAfter - d.rating;
      stmts.updatePlayer.run(aAfter, aAfter, attackerWon ? 1 : 0, attackerWon ? 0 : 1, 1, now, season.id, attackerId);
      stmts.updatePlayer.run(dAfter, dAfter, attackerWon ? 0 : 1, attackerWon ? 1 : 0, 1, now, season.id, defenderId);
      stmts.insertBattle.run(battleId, season.id, attackerId, defenderId, aDelta, dDelta, aAfter, dAfter);
      return { ranked: true, number: season.number, attacker: { delta: aDelta, rating: aAfter }, defender: { delta: dDelta, rating: dAfter } };
    },

    /** The season record for a battle, or null. */
    forBattle: (battleId) => stmts.battle.get(battleId) || null,

    /** Undoes the rating changes of reversed (farmed) battles in a still-running season. */
    reverseBattles(battleIds, now = Date.now()) {
      let n = 0;
      for (const id of battleIds) {
        const b = stmts.battle.get(id);
        if (!b || b.reversed_at || b.status !== 'active') continue;
        if (!stmts.reverseBattle.run(now, id).changes) continue;
        const aWon = b.attacker_delta > 0;
        stmts.undoPlayer.run(seasons.RATING_FLOOR, b.attacker_delta, aWon ? 1 : 0, aWon ? 0 : 1, b.season_id, b.attacker_id);
        stmts.undoPlayer.run(seasons.RATING_FLOOR, b.defender_delta, aWon ? 0 : 1, aWon ? 1 : 0, b.season_id, b.defender_id);
        n += 1;
      }
      return n;
    },

    /** A player's standing in a season: rating, record, rank (once placed), division. */
    standing(season, userId) {
      if (!season) return null;
      const row = stmts.player.get(season.id, userId);
      if (row) return withRank(season, row);
      // Not fought yet: show where they'd start.
      const prev = stmts.previousFinal.get(userId, season.number);
      const rating = seasons.startingRating(prev ? prev.rating : null);
      return withRank(season, { season_id: season.id, user_id: userId, rating, peak: rating, wins: 0, losses: 0, fights: 0, last_fight_at: null });
    },

    standings: (season, limit = 50) => (season ? stmts.standings.all(season.id, seasons.placementFights(), limit) : [])
      .map((r, i) => ({ ...r, rank: i + 1, division: seasons.divisionFor(r.rating) })),
    placedCount: (season) => (season ? stmts.placedCount.get(season.id, seasons.placementFights()).n : 0),
    past: (limit = 12) => stmts.past.all(limit),
    results: (season, limit = 100) => stmts.results.all(season.id, limit).map((r) => ({ ...r, division: seasons.DIVISIONS_BY_ID.get(r.division) })),
    resultFor: (season, userId) => stmts.resultFor.get(season.id, userId) || null,
    /** Badges for a player's past seasons, newest first. */
    badgesFor: (userId, limit = 12) => stmts.resultsFor.all(userId, limit).map((r) => ({ ...r, ...seasons.badgeFor(r) })),
    goldFinishes: (userId) => stmts.goldFinishes.get(userId).n,

    schedule(ms = 60 * 1000) {
      this.rollover();
      setInterval(() => {
        try { this.rollover(); } catch (err) { console.error('[seasons] rollover failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createSeasonService };
