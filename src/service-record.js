'use strict';

/**
 * The service record: a soldier's career on one page, for anyone to read
 * (money and training totals only for the soldier themselves). Everything is
 * worked out from records the game already keeps.
 *
 * Only fights that paid XP and weren't reversed by an admin count towards
 * PvP records, the same rule as the medals, so farming linked accounts
 * doesn't build a record.
 */

const game = require('./game');
const medals = require('./medals');
const titles = require('./titles');
const seasons = require('./seasons');
const vehicles = require('./vehicles');
const workshop = require('./workshop');
const { ITEMS_BY_ID } = require('./items');

const HOUR = 60 * 60 * 1000;
const TIMELINE_LIMIT = 40;

/**
 * Longest run of fights won in a row, attacking or defending. `fights` are
 * { won, counts } in time order; fights that don't count (no XP paid) neither
 * extend nor break a run.
 */
function longestStreak(fights) {
  let best = 0;
  let run = 0;
  for (const f of fights) {
    if (!f.counts) continue;
    run = f.won ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Promotions that reached a new rank, from "Promoted to level N…" lines in the activity log. */
function rankUps(promotions) {
  const out = [];
  const seen = new Set();
  for (const p of promotions) {
    const m = /level (\d+)/.exec(p.message);
    if (!m) continue;
    const level = Number(m[1]);
    const rank = game.rankFor(level);
    if (level > 1 && rank.name !== game.rankFor(level - 1).name && !seen.has(rank.name)) {
      seen.add(rank.name);
      out.push({ at: p.created_at, kind: 'rank', text: `Promoted to ${rank.name} (${rank.grade}) at level ${level}` });
    }
  }
  return out;
}

function createServiceRecord(db) {
  const stmts = {
    fights: db.prepare(`SELECT attacker_id = ?1 AS attacking, attacker_won, attacker_xp, defender_xp FROM battles
                        WHERE (attacker_id = ?1 OR defender_id = ?1) AND reversed_at IS NULL ORDER BY id`),
    haul: db.prepare(`SELECT id, cash_taken, created_at FROM battles WHERE attacker_id = ? AND attacker_won = 1 AND attacker_xp > 0
                      AND reversed_at IS NULL ORDER BY cash_taken DESC, id LIMIT 1`),
    pvpTotals: db.prepare(`SELECT COALESCE(SUM(cash_taken), 0) AS taken, MIN(created_at) AS firstWin FROM battles
                           WHERE attacker_id = ? AND attacker_won = 1 AND attacker_xp > 0 AND reversed_at IS NULL`),
    operations: db.prepare('SELECT COALESCE(SUM(completions), 0) AS n FROM operation_progress WHERE user_id = ?'),
    deployments: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ends_at - started_at), 0) AS ms FROM deployments WHERE user_id = ? AND status = 'returned'"),
    raids: db.prepare(`SELECT COUNT(*) AS raids, COALESCE(SUM(h.strikes), 0) AS strikes, COALESCE(SUM(h.damage), 0) AS damage,
                              COALESCE(SUM(r.status = 'won'), 0) AS won FROM raid_hits h JOIN raids r ON r.id = h.raid_id WHERE h.user_id = ?`),
    warPoints: db.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM unit_war_battles WHERE user_id = ?'),
    bounties: db.prepare("SELECT COUNT(DISTINCT battle_id) AS n FROM bounties WHERE claimer_id = ? AND status = 'claimed'"),
    seasons: db.prepare('SELECT COUNT(*) AS n, MIN(rank) AS best FROM season_results WHERE user_id = ?'),
    bestDivision: db.prepare('SELECT division FROM season_results WHERE user_id = ?'),
    days: db.prepare('SELECT COUNT(*) AS n FROM player_days WHERE user_id = ?'),
    medals: db.prepare('SELECT medal_id, tier, awarded_at FROM user_medals WHERE user_id = ? ORDER BY awarded_at DESC LIMIT ?'),
    medalCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tier = 3), 0) AS gold FROM user_medals WHERE user_id = ?'),
    titles: db.prepare('SELECT title_id, earned_at FROM user_titles WHERE user_id = ? ORDER BY earned_at DESC'),
    promotions: db.prepare("SELECT message, created_at FROM activity WHERE user_id = ? AND kind = 'promotion' ORDER BY id"),
    vehicles: db.prepare('SELECT vehicle_id, upgrade, acquired_at FROM vehicles WHERE user_id = ? ORDER BY acquired_at'),
    bestGear: db.prepare('SELECT item_id, upgrade FROM inventory WHERE user_id = ? AND upgrade > 0 ORDER BY upgrade DESC, acquired_at LIMIT 1'),
    earnings: db.prepare(`SELECT reason, COALESCE(SUM(delta_cash), 0) AS cash FROM ledger WHERE user_id = ?
                          AND reason IN ('mission', 'operation', 'deployment', 'pvp', 'raid-loot', 'daily-order', 'daily-bonus', 'supply-drop', 'medal') GROUP BY reason`),
    casinoBest: db.prepare('SELECT MAX(payout - bet) AS n FROM casino_plays WHERE user_id = ?'),
  };

  /** The record for `user` (a users row). `own`: the soldier is looking at their own record. */
  function view(user, { own = false, now = Date.now() } = {}) {
    const id = user.id;
    const fights = stmts.fights.all(id).map((f) => ({
      won: f.attacking ? f.attacker_won === 1 : f.attacker_won === 0,
      counts: f.attacking ? f.attacker_xp > 0 || f.attacker_won === 0 : f.defender_xp > 0 || f.attacker_won === 1,
    }));
    const haul = stmts.haul.get(id);
    const pvp = stmts.pvpTotals.get(id);
    const dep = stmts.deployments.get(id);
    const raid = stmts.raids.get(id);
    const season = stmts.seasons.get(id);
    const divisionRank = (d) => seasons.DIVISIONS.findIndex((x) => x.id === d);
    const bestDivision = stmts.bestDivision.all(id).map((r) => r.division).sort((a, b) => divisionRank(b) - divisionRank(a))[0] || null;
    const medalCount = stmts.medalCount.get(id);
    const owned = stmts.vehicles.all(id).filter((v) => vehicles.VEHICLES_BY_ID.has(v.vehicle_id));
    const gearRow = stmts.bestGear.get(id);
    const bestGear = gearRow && ITEMS_BY_ID.get(gearRow.item_id) ? workshop.nameOf(ITEMS_BY_ID.get(gearRow.item_id), gearRow.upgrade) : null;
    const missions = user.missions_completed + user.missions_failed;

    const sections = [
      { id: 'service', title: 'Service', rows: [
        ['Enlisted', new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })],
        ['Days on duty', stmts.days.get(id).n],
        ['Rank', `${game.rankFor(user.level).name}, level ${user.level}`],
        ['Medals', `${medalCount.n} (${medalCount.gold} gold)`],
        ['Titles earned', stmts.titles.all(id).length],
        ['Daily orders completed', user.orders_completed],
        ['Best supply-drop streak', `${user.streak_best || 0} days`],
      ] },
      { id: 'operations', title: 'Missions and operations', rows: [
        ['Missions won', user.missions_completed],
        ['Missions failed', user.missions_failed],
        ['Success rate', missions ? `${Math.round((user.missions_completed / missions) * 100)}%` : '–'],
        ['Operations completed', stmts.operations.get(id).n],
        ['Special operations completed', user.specials_done || 0],
        ['Deployments completed', dep.n],
        ['Hours deployed', Math.round(dep.ms / HOUR)],
      ] },
      { id: 'combat', title: 'Combat', rows: [
        ['PvP wins', user.pvp_wins],
        ['PvP losses', user.pvp_losses],
        ['Longest winning streak', longestStreak(fights)],
        ['Biggest haul', haul ? { text: `$${haul.cash_taken.toLocaleString('en-US')}`, href: `/battles/${haul.id}` } : '–'],
        ['Bounties collected', stmts.bounties.get(id).n],
        ['Contracts completed', `${user.contracts_done || 0}${user.contracts_failed ? ` (${user.contracts_failed} failed)` : ''}`],
        ['PvP seasons played', season.n],
        ['Best season finish', season.best ? `#${season.best}${bestDivision ? ` · ${seasons.DIVISIONS_BY_ID.get(bestDivision).name}` : ''}` : '–'],
      ] },
      { id: 'unit', title: 'Unit service', rows: [
        ['Unit wars won', user.wars_won],
        ['War points scored', stmts.warPoints.get(id).n],
        ['Raids joined', raid.raids],
        ['Raids won', raid.won],
        ['Raid strikes', raid.strikes],
        ['Raid damage dealt', raid.damage],
      ] },
      { id: 'kit', title: 'Motor pool and workshop', rows: [
        ['Vehicles in the motor pool', owned.length],
        ['Missions won with a vehicle out', user.vehicle_missions || 0],
        ['Workshop upgrades made', user.upgrades_made || 0],
        ['Best upgraded gear', bestGear || '–'],
      ] },
    ];

    let privateRows = null;
    if (own) {
      const e = Object.fromEntries(stmts.earnings.all(id).map((r) => [r.reason, r.cash]));
      const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`;
      privateRows = [
        ['Earned from missions', money(e.mission)],
        ['Earned from operations', money(e.operation)],
        ['Earned from deployments', money(e.deployment)],
        ['Taken in PvP', money(pvp.taken)],
        ['Raid loot', money(e['raid-loot'])],
        ['Daily orders, drops and medals', money((e['daily-order'] || 0) + (e['daily-bonus'] || 0) + (e['supply-drop'] || 0) + (e.medal || 0))],
        ['Bet at the casino', money(user.casino_wagered)],
        ['Biggest casino win (last 30 days)', stmts.casinoBest.get(id).n > 0 ? money(stmts.casinoBest.get(id).n) : '–'],
        ['Training', `Strength ${user.stat_str} · Agility ${user.stat_agi} · Endurance ${user.stat_end}`],
      ];
    }

    // Milestones, newest first.
    const timeline = [
      { at: user.created_at, kind: 'enlisted', text: 'Enlisted' },
      ...rankUps(stmts.promotions.all(id)),
      ...stmts.medals.all(id, TIMELINE_LIMIT).map((m) => {
        const medal = medals.MEDALS_BY_ID.get(m.medal_id);
        return medal ? { at: m.awarded_at, order: m.tier, kind: 'medal', tier: medals.TIERS[m.tier - 1].key, text: `${medals.TIERS[m.tier - 1].label} ${medal.name}` } : null;
      }).filter(Boolean),
      ...stmts.titles.all(id).map((t) => (titles.nameOf(t.title_id) ? { at: t.earned_at, kind: 'title', text: `Earned the title “${titles.nameOf(t.title_id)}”` } : null)).filter(Boolean),
      pvp.firstWin ? { at: pvp.firstWin, kind: 'pvp', text: 'First PvP win' } : null,
      owned[0] ? { at: owned[0].acquired_at, kind: 'vehicle', text: `First vehicle: ${vehicles.VEHICLES_BY_ID.get(owned[0].vehicle_id).name}` } : null,
    ].filter(Boolean).filter((t) => t.at && t.at <= now).sort((a, b) => b.at - a.at || (b.order || 0) - (a.order || 0)).slice(0, TIMELINE_LIMIT); // the higher tier first when awarded together

    return { sections, privateRows, timeline };
  }

  return { view };
}

module.exports = { createServiceRecord, longestStreak, rankUps };
