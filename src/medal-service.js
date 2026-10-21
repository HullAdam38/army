'use strict';

const medals = require('./medals');
const titles = require('./titles');
const game = require('./game');
const { announceLevels } = require('./notify');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Medals backed by the database: works out a player's career metrics,
 * awards any newly reached tiers (paying through the ledger) and stores pins.
 */
function createMedalService(db, players) {
  const stmts = {
    user: db.prepare('SELECT level, missions_completed, stat_str, stat_agi, stat_end, streak_best, orders_completed, wars_won, base_barracks, base_medbay, base_vault, base_intel, base_range, base_comms, casino_wagered, casino_big_wins, casino_blackjacks, vehicle_missions, upgrades_made, contracts_done, specials_done FROM users WHERE id = ?'),
    vehicles: db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?'),
    // Only fights that paid XP count, and reversed (farmed) fights never do.
    battles: db.prepare(`
      SELECT
        COALESCE(SUM(attacker_id = ?1 AND attacker_won = 1 AND attacker_xp > 0), 0) AS pvpWins,
        COALESCE(SUM(((attacker_id = ?1 AND attacker_won = 1 AND attacker_xp > 0) OR (defender_id = ?1 AND attacker_won = 0 AND defender_xp > 0)) AND knockout = 1), 0) AS knockouts,
        COALESCE(SUM(defender_id = ?1 AND attacker_won = 0 AND defender_xp > 0), 0) AS defenses
      FROM battles WHERE (attacker_id = ?1 OR defender_id = ?1) AND reversed_at IS NULL`),
    warPoints: db.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM unit_war_battles WHERE user_id = ?'),
    seasonBest: db.prepare('SELECT MIN(rank) AS r FROM season_results WHERE user_id = ?'),
    titles: db.prepare('SELECT title_id, earned_at FROM user_titles WHERE user_id = ?'),
    awardTitle: db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id, earned_at) VALUES (?, ?, ?)'),
    setTitle: db.prepare('UPDATE users SET title = ? WHERE id = ?'),
    seasonsGold: db.prepare("SELECT COUNT(*) AS n FROM season_results WHERE user_id = ? AND division IN ('gold', 'elite')"),
    deployments: db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE user_id = ? AND status = 'returned'"),
    bounties: db.prepare("SELECT COUNT(DISTINCT battle_id) AS n FROM bounties WHERE claimer_id = ? AND status = 'claimed'"),
    owned: db.prepare('SELECT medal_id, MAX(tier) AS tier, MAX(awarded_at) AS at FROM user_medals WHERE user_id = ? GROUP BY medal_id'),
    history: db.prepare('SELECT medal_id, tier, awarded_at FROM user_medals WHERE user_id = ? ORDER BY awarded_at DESC, tier DESC'),
    award: db.prepare('INSERT OR IGNORE INTO user_medals (user_id, medal_id, tier, awarded_at) VALUES (?, ?, ?, ?)'),
    pins: db.prepare('SELECT pinned_medals FROM users WHERE id = ?'),
    setPins: db.prepare('UPDATE users SET pinned_medals = ? WHERE id = ?'),
    holders: db.prepare(`SELECT m.medal_id, m.tier, COUNT(*) AS n FROM user_medals m JOIN users u ON u.id = m.user_id
                         WHERE u.banned_at IS NULL GROUP BY m.medal_id, m.tier`),
    players: db.prepare('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NULL'),
  };

  function metrics(userId) {
    const u = stmts.user.get(userId);
    if (!u) return null;
    const b = stmts.battles.get(userId);
    return {
      missions: u.missions_completed,
      pvpWins: b.pvpWins,
      knockouts: b.knockouts,
      defenses: b.defenses,
      training: u.stat_str + u.stat_agi + u.stat_end,
      streak: u.streak_best,
      orders: u.orders_completed,
      level: u.level,
      warPoints: stmts.warPoints.get(userId).n,
      warsWon: u.wars_won,
      bounties: stmts.bounties.get(userId).n,
      deployments: stmts.deployments.get(userId).n,
      seasonsGold: stmts.seasonsGold.get(userId).n,
      seasonBestRank: stmts.seasonBest.get(userId).r || 0,
      base: require('./base').baseRating(u),
      casinoWagered: u.casino_wagered,
      casinoBigWins: u.casino_big_wins,
      casinoBlackjacks: u.casino_blackjacks,
      vehicleMissions: u.vehicle_missions,
      vehicles: stmts.vehicles.get(userId).n,
      upgrades: u.upgrades_made,
      contracts: u.contracts_done,
      specials: u.specials_done,
    };
  }

  const ownedMap = (userId) => new Map(stmts.owned.all(userId).map((r) => [r.medal_id, r.tier]));

  return {
    metrics,

    /**
     * Awards every tier the player has newly reached. Rewards can level them
     * up, which can earn the Commission medal, so it repeats until settled.
     * Returns the list of { medal, tier } awarded.
     */
    check(userId, now = Date.now()) {
      const awarded = [];
      for (let pass = 0; pass < 3; pass += 1) {
        const found = players.transaction(() => {
          const m = metrics(userId);
          if (!m) return [];
          const fresh = medals.newTiers(m, ownedMap(userId));
          const won = fresh.filter(({ medal, tier }) => stmts.award.run(userId, medal.id, tier.tier, now).changes);
          if (!won.length) return [];
          const p = game.applyRegen(players.findById(userId), now);
          const xp = won.reduce((n, w) => n + w.tier.xp, 0);
          const cash = won.reduce((n, w) => n + w.tier.cash, 0);
          p.cash += cash;
          const levels = game.grantXp(p, xp);
          players.save(p, { reason: 'medal', ref: won.map((w) => `${w.medal.id}:${w.tier.tier}`).join(',') });
          for (const w of won) {
            const text = `${w.tier.label} ${w.medal.name}`;
            players.log(userId, 'medal', `Awarded the ${text}. +${w.tier.xp} XP, +${money(w.tier.cash)}.`, '/medals');
            players.notify(userId, 'medal', `Medal awarded: ${text} for ${w.medal.thresholds[w.tier.tier - 1].toLocaleString('en-US')} ${w.medal.unit}. +${w.tier.xp} XP, +${money(w.tier.cash)}.`, '/medals');
          }
          for (const lvl of levels) {
            const rank = game.rankFor(lvl);
            players.log(userId, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
          }
          announceLevels(players, userId, levels);
          return won;
        });
        if (!found.length) break;
        awarded.push(...found);
      }
      this.checkTitles(userId, now);
      return awarded;
    },

    /** Records titles the player has newly earned and tells them. Returns the new titles. */
    checkTitles(userId, now = Date.now()) {
      const m = metrics(userId);
      if (!m) return [];
      const owned = new Set(stmts.titles.all(userId).map((r) => r.title_id));
      const fresh = titles.newlyEarned(m, owned).filter((t) => stmts.awardTitle.run(userId, t.id, now).changes);
      for (const t of fresh) {
        players.notify(userId, 'title', `New title unlocked: “${t.name}”. Show it under your callsign from your profile settings.`, '/account/profile#title');
      }
      return fresh;
    },

    /** Every title with whether (and when) the player earned it. */
    titlesFor(userId) {
      const owned = new Map(stmts.titles.all(userId).map((r) => [r.title_id, r.earned_at]));
      return titles.TITLES.map((t) => ({ id: t.id, name: t.name, how: t.how, earned: owned.has(t.id), earnedAt: owned.get(t.id) || null }));
    },

    /** Shows a title under the player's callsign ('' for none). Only earned titles. */
    setTitle(userId, id) {
      if (!id) { stmts.setTitle.run(null, userId); return { title: null }; }
      const owned = new Set(stmts.titles.all(userId).map((r) => r.title_id));
      if (!titles.TITLES_BY_ID.has(id) || !owned.has(id)) return { error: 'You haven’t earned that title yet.' };
      stmts.setTitle.run(id, userId);
      return { title: titles.TITLES_BY_ID.get(id) };
    },

    /** The full medal case for a player: every medal with progress, plus pins. */
    caseFor(userId) {
      const m = metrics(userId) || {};
      const owned = stmts.owned.all(userId);
      const byId = new Map(owned.map((r) => [r.medal_id, r]));
      const pins = this.pinsFor(userId);
      return medals.MEDALS.map((medal) => {
        const row = byId.get(medal.id);
        return { ...medals.medalView(medal, m[medal.metric] || 0, row ? row.tier : 0), awardedAt: row ? row.at : null, pinned: pins.includes(medal.id) };
      });
    },

    /** Earned medals only (highest tier each), pinned ones first. For profiles. */
    rackFor(userId) {
      const pins = this.pinsFor(userId);
      return this.caseFor(userId)
        .filter((m) => m.tier > 0)
        .sort((a, b) => (pins.indexOf(a.id) + 1 || 99) - (pins.indexOf(b.id) + 1 || 99) || b.tier - a.tier);
    },

    pinsFor(userId) {
      const row = stmts.pins.get(userId);
      const raw = row ? row.pinned_medals : '';
      return raw ? raw.split(',') : [];
    },

    /** Sets the pinned medals; ignores ones the player doesn't hold. */
    setPins(userId, ids, max = medals.MAX_PINNED) {
      const pins = medals.parsePins(ids, ownedMap(userId), max);
      stmts.setPins.run(pins.join(','), userId);
      return pins;
    },

    history: (userId, limit = 10) => stmts.history.all(userId).slice(0, limit),

    /** Share of active players holding each tier: Map "medal:tier" → percent. */
    rarity() {
      const total = stmts.players.get().n || 1;
      const out = new Map();
      for (const r of stmts.holders.all()) out.set(`${r.medal_id}:${r.tier}`, Math.max(r.n ? 1 : 0, Math.round((r.n / total) * 100)));
      return out;
    },

    /**
     * Middleware: after any successful POST by a signed-in player, award any
     * medals it earned. Runs once the response is sent, so it never slows a page.
     */
    tracker() {
      return (req, res, next) => {
        if (req.method !== 'POST') return next();
        res.on('finish', () => {
          const userId = req.session && req.session.userId;
          if (!userId || res.statusCode >= 400) return;
          try { this.check(userId); } catch (err) { console.error('[medals] check failed', err); }
        });
        next();
      };
    },
  };
}

module.exports = { createMedalService };
