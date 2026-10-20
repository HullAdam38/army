'use strict';

/**
 * Daily orders and the login streak ("supply drop"). Pure rules: which orders
 * a player gets each day, what they pay, and how streaks advance. Days are UTC.
 */

const crypto = require('node:crypto');
const { MISSIONS } = require('./game');
const perks = require('./perks');

/** Supply drop pay for `level` on a streak day with multiplier `mult` (Generals get a perk bonus). */
const dropCash = (level, mult) => Math.round((25 + 15 * level) * mult * (1 + perks.perksFor(level).supplyDrop));

const ORDERS_PER_DAY = 3;
const STREAK_CYCLE = [1, 1, 1.5, 1.5, 2, 2, 3]; // supply drop multiplier for days 1–7 of a streak

/** 'YYYY-MM-DD' for the UTC day containing `ms`. */
function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function previousDay(key) {
  return dayKey(Date.parse(`${key}T00:00:00Z`) - 86_400_000);
}

/** Milliseconds until the next UTC midnight (when orders reset). */
function msUntilReset(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/**
 * Order types. `make(level, rand, ctx)` returns { target, param } for a player, or null if it
 * doesn't fit. `ctx.hasVehicle`: they own a vehicle in the motor pool.
 */
const ORDER_TYPES = {
  missions_won: {
    make: (level) => ({ target: Math.min(8, 3 + Math.floor(level / 4)) }),
    text: (o) => `Complete ${o.target} missions`,
  },
  mission_specific: {
    make: (level, rand) => {
      const unlocked = MISSIONS.filter((m) => m.minLevel <= level);
      const m = unlocked[Math.floor(rand() * unlocked.length)];
      return { target: 2, param: m.id };
    },
    text: (o) => `Complete ${(MISSIONS.find((m) => m.id === o.param) || { name: 'a mission' }).name} twice`,
  },
  mission_cash: {
    make: (level) => ({ target: 100 + 80 * level }),
    text: (o) => `Earn $${o.target.toLocaleString('en-US')} from missions`,
  },
  pvp_wins: {
    make: (level) => (level >= 3 ? { target: level >= 8 ? 2 : 1 } : null),
    text: (o) => `Win ${o.target === 1 ? 'a PvP fight' : `${o.target} PvP fights`} as the attacker`,
  },
  training: {
    make: () => ({ target: 3 }),
    text: (o) => `Train ${o.target} sessions`,
  },
  scout: {
    make: (level) => (level >= 3 ? { target: 1 } : null),
    text: () => 'Scout another player',
  },
  vehicle_missions: {
    make: (level, rand, ctx) => (ctx.hasVehicle ? { target: Math.min(6, 2 + Math.floor(level / 8)) } : null),
    text: (o) => `Complete ${o.target} missions with a vehicle taken out`,
  },
  vehicle_deploy: {
    make: (level, rand, ctx) => (ctx.hasVehicle ? { target: 1 } : null),
    text: () => 'Come back from a deployment with a vehicle taken out',
  },
};

/** Reward for one order at `level`. Finishing all three pays one more as a bonus. */
function orderReward(level) {
  return { xp: 15 + 8 * level, cash: 40 + 35 * level };
}

/** A small deterministic RNG so a player's orders don't change when the page reloads. */
function seededRandom(seed) {
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 2 ** 32;
  };
}

/** Today's three orders for a player: distinct types that fit their level (and `ctx`, see ORDER_TYPES). */
function generateOrders(userId, level, day, ctx = {}) {
  const rand = seededRandom(`${userId}:${day}`);
  const pool = Object.keys(ORDER_TYPES);
  const picked = [];
  while (picked.length < ORDERS_PER_DAY && pool.length) {
    const type = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    const made = ORDER_TYPES[type].make(level, rand, ctx);
    if (made) picked.push({ type, param: made.param || null, target: made.target });
  }
  const reward = orderReward(level);
  return picked.map((o, slot) => ({ ...o, slot, rewardXp: reward.xp, rewardCash: reward.cash }));
}

function orderText(order) {
  return ORDER_TYPES[order.type] ? ORDER_TYPES[order.type].text(order) : order.type;
}

/**
 * Supply drop for today. Returns { error } or { streak, cycleDay, cash, refillEnergy }
 * plus the updated streak fields to save.
 */
function supplyDrop(player, today) {
  if (player.streak_day === today) return { error: 'Today’s supply drop is already claimed. Come back tomorrow.' };
  const continuing = player.streak_day === previousDay(today);
  const streak = continuing ? (player.streak_count || 0) + 1 : 1;
  const cycleDay = ((streak - 1) % STREAK_CYCLE.length) + 1;
  const cash = dropCash(player.level, STREAK_CYCLE[cycleDay - 1]);
  return {
    streak,
    cycleDay,
    cash,
    refillEnergy: cycleDay === STREAK_CYCLE.length,
    broken: !continuing && (player.streak_count || 0) > 1,
    best: Math.max(player.streak_best || 0, streak),
  };
}

/** The 7-day track for the HQ card. */
function streakView(player, today) {
  const claimedToday = player.streak_day === today;
  const alive = claimedToday || player.streak_day === previousDay(today);
  const current = alive ? player.streak_count || 0 : 0;
  // Which day of the cycle the next claim would be (or today's, if claimed).
  const nextStreak = claimedToday ? current : current + 1;
  const cycleDay = ((nextStreak - 1) % STREAK_CYCLE.length) + 1;
  return {
    current,
    best: player.streak_best || 0,
    claimedToday,
    cycleDay,
    days: STREAK_CYCLE.map((mult, i) => ({
      day: i + 1,
      cash: dropCash(player.level, mult),
      energy: i === STREAK_CYCLE.length - 1,
      done: i + 1 < cycleDay || (claimedToday && i + 1 === cycleDay),
      today: i + 1 === cycleDay,
    })),
  };
}

module.exports = {
  ORDERS_PER_DAY,
  ORDER_TYPES,
  STREAK_CYCLE,
  dayKey,
  generateOrders,
  msUntilReset,
  orderReward,
  orderText,
  previousDay,
  streakView,
  supplyDrop,
};
