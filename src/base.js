'use strict';

/**
 * Forward base: facilities a player upgrades with cash and time. A long-term
 * money sink with modest, permanent perks. Pure rules; facility levels live
 * on the users row (base_<id>) so every system can read them directly.
 */

const HOUR = 60 * 60 * 1000;
const UNLOCK_LEVEL = 8;
const REFUND_RATE = 0.5; // cancelling a build returns half the cost

// Per facility level (1-based): player level needed, cost multiplier, build time.
const LEVEL_REQUIREMENT = [8, 12, 16, 22, 28];
const COST_MULTIPLIER = [1, 2.5, 6, 14, 30];
const BUILD_HOURS = [1, 3, 6, 12, 24];

const FACILITIES = [
  {
    id: 'barracks',
    name: 'Barracks',
    icon: 'i-bolt',
    blurb: 'Bunks for a bigger squad. Raises your maximum energy.',
    baseCost: 4000,
    maxLevel: 5,
    effect: (lvl) => `+${5 * lvl} max energy`,
  },
  {
    id: 'medbay',
    name: 'Med Bay',
    icon: 'i-health',
    blurb: 'Field surgeons on call. Health comes back faster.',
    baseCost: 3000,
    maxLevel: 5,
    effect: (lvl) => `health regenerates ${10 * lvl}% faster`,
  },
  {
    id: 'vault',
    name: 'Vault',
    icon: 'i-cash',
    blurb: 'A secure strongroom. Lowers the bank deposit fee.',
    baseCost: 5000,
    maxLevel: 3,
    effect: (lvl) => `deposit fee ${(2 - 0.5 * lvl).toFixed(1)}%`,
  },
  {
    id: 'intel',
    name: 'Intel Room',
    icon: 'i-radio',
    blurb: 'Analysts and a wall of maps. Scouting costs less.',
    baseCost: 2500,
    maxLevel: 5,
    effect: (lvl) => `scouting ${10 * lvl}% cheaper`,
  },
  {
    id: 'range',
    name: 'Firing Range',
    icon: 'i-target',
    blurb: 'Your own lanes and instructors. Training sessions cost less.',
    baseCost: 3500,
    maxLevel: 5,
    effect: (lvl) => `training ${5 * lvl}% cheaper`,
  },
  {
    id: 'comms',
    name: 'Comms Tower',
    icon: 'i-flag',
    blurb: 'A direct line to HQ. Daily orders pay more.',
    baseCost: 3000,
    maxLevel: 5,
    effect: (lvl) => `daily order rewards +${10 * lvl}%`,
  },
];

const FACILITIES_BY_ID = new Map(FACILITIES.map((f) => [f.id, f]));
const levelOf = (player, id) => (player && player[`base_${id}`]) || 0;

/** Every perk from a player's base. Safe on rows without base columns (all zero). */
function effectsOf(player) {
  return {
    maxEnergyBonus: 5 * levelOf(player, 'barracks'),
    healthRegenFactor: 1 - 0.1 * levelOf(player, 'medbay'), // multiplies the regen interval
    depositFeeRate: 0.02 - 0.005 * levelOf(player, 'vault'),
    scoutDiscount: 0.1 * levelOf(player, 'intel'),
    trainingDiscount: 0.05 * levelOf(player, 'range'),
    ordersBonus: 0.1 * levelOf(player, 'comms'),
  };
}

/** What the next level of a facility costs and needs, or null when maxed. */
function nextLevel(player, id) {
  const f = FACILITIES_BY_ID.get(id);
  if (!f) return null;
  const level = levelOf(player, id);
  if (level >= f.maxLevel) return null;
  return {
    level: level + 1,
    cost: Math.round(f.baseCost * COST_MULTIPLIER[level]),
    hours: BUILD_HOURS[level],
    requiredLevel: LEVEL_REQUIREMENT[level],
  };
}

/** Why `player` can't start building `id` now, or null. */
function buildBlocker(player, id, now = Date.now()) {
  if (player.level < UNLOCK_LEVEL) return `Your forward base unlocks at level ${UNLOCK_LEVEL}`;
  const next = nextLevel(player, id);
  if (!next) return 'Fully upgraded';
  if (player.base_build && player.base_build_until > now) return 'Your engineers are busy with another build';
  if (player.level < next.requiredLevel) return `Level ${next.level} needs you to be level ${next.requiredLevel}`;
  if (player.cash < next.cost) return `Costs $${next.cost.toLocaleString('en-US')}`;
  return null;
}

/** Total of all facility levels, shown as the base's overall rating. */
const baseRating = (player) => FACILITIES.reduce((n, f) => n + levelOf(player, f.id), 0);
const maxRating = FACILITIES.reduce((n, f) => n + f.maxLevel, 0);

module.exports = {
  BUILD_HOURS, COST_MULTIPLIER, FACILITIES, FACILITIES_BY_ID, HOUR, LEVEL_REQUIREMENT, REFUND_RATE, UNLOCK_LEVEL,
  baseRating, buildBlocker, effectsOf, levelOf, maxRating, nextLevel,
};
