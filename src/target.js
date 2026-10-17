'use strict';

/**
 * The daily high-value target (pure). Each UTC day one active, high-level
 * player is marked. Beating them in a full-reward fight pays a bonus, once
 * per attacker per day; each attack they fight off pays them a smaller one.
 */

const tuning = require('./tuning');
const { hourPay, hourXp } = require('./objectives');

const POOL = 25; // picked from this many of the highest-level active players
const ACTIVE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_DEFENSE_PAYOUTS = 10; // per day

const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const dayEnds = (key) => Date.parse(`${key}T00:00:00Z`) + 24 * 60 * 60 * 1000;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Today's pick from `candidates` (best first), never yesterday's target if anyone else qualifies. */
function pick(candidates, day, yesterdayId = null) {
  const pool = candidates.length > 1 ? candidates.filter((c) => c.id !== yesterdayId) : candidates;
  if (!pool.length) return null;
  return pool[hash(day) % pool.length];
}

/** What beating the target pays the attacker. */
const bonus = (targetLevel) => ({
  cash: Math.round(6 * hourPay(targetLevel) * tuning.get('targetBonusMult')),
  xp: Math.round(4 * hourXp(targetLevel) * tuning.get('targetBonusMult')),
});
/** What the target earns for each attack they fight off. */
const defenseBonus = (targetLevel) => Math.round(2 * hourPay(targetLevel) * tuning.get('targetBonusMult'));

module.exports = { ACTIVE_MS, MAX_DEFENSE_PAYOUTS, POOL, bonus, dayEnds, dayKey, defenseBonus, pick };
