'use strict';

/**
 * Scouting: pay to see a player's hidden training and true combat profile.
 * The price only uses public facts (their level vs yours), so it can't leak
 * anything about their training.
 */

const combat = require('./combat');
const game = require('./game');
const training = require('./training');

const SCOUT_ENERGY = 3;
const UPWARD_MULTIPLIER = 1.5; // intel on stronger players is harder to get

function scoutCost(scout, target) {
  const price = 50 + 25 * target.level;
  const discount = require('./base').effectsOf(scout).scoutDiscount; // Intel Room
  return Math.round((target.level > scout.level ? price * UPWARD_MULTIPLIER : price) * (1 - discount));
}

/** Why `scout` can't scout `target` right now, or null. */
function scoutBlocker(scout, target, now = Date.now()) {
  if (scout.id === target.id) return 'You already know your own record';
  if (target.banned_at) return `${target.username} is suspended`;
  if (game.isHospitalized(scout, now)) return 'You can’t run recon from a hospital bed';
  if (scout.energy < SCOUT_ENERGY) return `Scouting needs ${SCOUT_ENERGY} energy`;
  const cost = scoutCost(scout, target);
  if (scout.cash < cost) return `Scouting ${target.username} costs $${cost.toLocaleString('en-US')}`;
  return null;
}

/** A frozen snapshot of what the scout learns. `stats` = target's true combat stats. */
function buildReport(target, stats, now = Date.now()) {
  const t = game.applyRegen(target, now);
  return {
    level: t.level,
    training: training.pointsOf(t),
    rating: combat.combatRating(stats),
    attack: Math.round(stats.attack),
    damage: Math.round(stats.damage * 100) / 100,
    critChancePct: Math.round(stats.critChance * 1000) / 10,
    dodgePct: Math.round(stats.dodge * 1000) / 10,
    armor: Math.round(stats.armor),
    mitigationPct: Math.round(combat.mitigation(stats.armor) * 100),
    health: t.health,
    maxHealth: t.max_health,
  };
}

/** Charges the scout. Returns { error } or { player, cost }. */
function chargeScout(current, target, now = Date.now()) {
  const scout = game.applyRegen(current, now);
  const blocker = scoutBlocker(scout, target, now);
  if (blocker) return { error: `${blocker}.` };
  const cost = scoutCost(scout, target);
  if (scout.energy >= scout.max_energy) scout.energy_updated_at = now;
  scout.energy -= SCOUT_ENERGY;
  scout.cash -= cost;
  return { player: scout, cost };
}

module.exports = { SCOUT_ENERGY, UPWARD_MULTIPLIER, buildReport, chargeScout, scoutBlocker, scoutCost };
