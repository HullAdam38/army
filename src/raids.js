'use strict';

/**
 * Unit raids (pure): a unit attacks an enemy stronghold together. It has one
 * shared health bar; members strike it with energy over 48 hours. If it falls
 * in time, the loot is split by damage dealt (players) with a share for the
 * treasury. If not, there's no loot.
 */

const game = require('./game');
const combat = require('./combat');
const tuning = require('./tuning');
const { hourPay, hourXp } = require('./objectives');

const DURATION_MS = 48 * 60 * 60 * 1000;
const STRIKE_ENERGY = 10;
const MIN_HEALTH_PCT = 0.2; // too hurt to strike below this share of max health
const TREASURY_SHARE = 0.25;
const NUDGE_AT = 0.75; // members hear when the stronghold is this far down
const REMIND_BEFORE_MS = 6 * 60 * 60 * 1000;
const MIN_MEMBERS = 3; // strongholds are sized for at least this many

// Each tier: the unit's average level it opens at, how much health per member
// (in strikes at that level), and how big the cash and XP loot are. The loot
// figures are tuned (see `npm run balance`) so a member earns about 1.75× the
// cash and 1.5× the XP that the same energy would earn on missions, at every
// tier: a clear reward for working together, without making missions pointless.
const STRONGHOLDS = [
  { id: 'outpost', name: 'Insurgent Outpost', minLevel: 1, strikes: 8, cash: 0.8, xp: 1.6, blurb: 'A lightly held forward post. A good first raid.' },
  { id: 'compound', name: 'Fortified Compound', minLevel: 10, strikes: 11, cash: 0.85, xp: 1.6, blurb: 'Walls, wire and a garrison that shoots back.' },
  { id: 'bunker', name: 'Mountain Bunker', minLevel: 20, strikes: 14, cash: 1.25, xp: 1.8, blurb: 'Dug into rock. Bring everyone.' },
  { id: 'battery', name: 'Coastal Battery', minLevel: 35, strikes: 17, cash: 1.55, xp: 1.8, blurb: 'Heavy guns covering the landing beaches.' },
  { id: 'citadel', name: 'Command Citadel', minLevel: 50, strikes: 20, cash: 2.25, xp: 2.2, blurb: 'The enemy’s regional headquarters.' },
  { id: 'blacksite', name: 'Black Site', minLevel: 75, strikes: 24, cash: 3.7, xp: 2.7, blurb: 'Off the map, and defended like it.' },
];
const STRONGHOLDS_BY_ID = new Map(STRONGHOLDS.map((s) => [s.id, s]));

const sized = (members) => Math.max(MIN_MEMBERS, members);
/** A typical strike at a level (no gear): what stronghold health is measured in. */
const typicalStrike = (level) => combat.combatRating(game.statsFor(Math.max(1, Math.round(level)), []));

/** Health, launch cost and loot for a stronghold, given the unit's size and average level. */
function plan(stronghold, { members, avgLevel }) {
  const m = sized(members);
  const level = Math.max(1, Math.round(avgLevel));
  const mult = tuning.get('raidRewardMult');
  return {
    hp: Math.round(stronghold.strikes * m * typicalStrike(level)),
    cost: Math.round((3 * m * hourPay(level) * Math.sqrt(stronghold.cash)) / 100) * 100,
    cash: Math.round(20 * m * hourPay(level) * stronghold.cash * mult),
    xp: Math.round(10 * m * hourXp(level) * stronghold.xp * mult),
  };
}

/** Strongholds a unit can attack, with their plans. */
const available = (unit) => STRONGHOLDS.filter((s) => unit.avgLevel >= s.minLevel).map((s) => ({ ...s, ...plan(s, unit) }));

/** Why `player` can't strike right now, or null. */
function strikeBlocker(player, now = Date.now()) {
  if (game.isHospitalized(player, now)) return 'You’re in hospital';
  if (game.isDeployed(player, now)) return 'You’re away on deployment';
  if (player.energy < STRIKE_ENERGY) return `You need ${STRIKE_ENERGY} energy`;
  if (player.health < Math.ceil(player.max_health * MIN_HEALTH_PCT)) return 'You’re too injured to strike';
  return null;
}

/** One strike: damage from the striker's combat rating, and the return fire they take. */
function strike(stats, player, rng = Math.random) {
  const damage = Math.max(1, Math.round(combat.combatRating(stats) * (0.8 + 0.45 * rng())));
  const hurt = Math.max(1, Math.round(player.max_health * (0.03 + 0.05 * rng())));
  return { damage, hurt };
}

/**
 * Splits the loot by damage: the treasury takes its share, the rest goes to
 * the strikers in proportion to what they did. Returns { treasury, players: [{ userId, cash, xp }] }.
 */
function splitLoot({ cash, xp }, hits) {
  const total = hits.reduce((n, h) => n + h.damage, 0);
  const treasury = Math.round(cash * TREASURY_SHARE);
  const pool = cash - treasury;
  return {
    treasury,
    players: total ? hits.map((h) => ({
      userId: h.user_id,
      share: h.damage / total,
      cash: Math.floor(pool * (h.damage / total)),
      xp: Math.max(1, Math.floor(xp * (h.damage / total))),
    })) : [],
  };
}

module.exports = {
  DURATION_MS,
  NUDGE_AT,
  REMIND_BEFORE_MS,
  STRIKE_ENERGY,
  STRONGHOLDS,
  STRONGHOLDS_BY_ID,
  TREASURY_SHARE,
  available,
  plan,
  splitLoot,
  strike,
  strikeBlocker,
  typicalStrike,
};
