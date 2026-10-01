'use strict';

/**
 * Player-vs-player rules. Pure functions: the route loads both players and
 * their stats, calls resolveAttack, and persists what comes back.
 */

const combat = require('./combat');
const game = require('./game');

const ATTACK_ENERGY = 10;
const MIN_PVP_LEVEL = 3; // Recruits (levels 1–2) can't attack or be attacked
const MAX_LEVELS_BELOW = 3; // can't pick on players more than 3 levels lower
const PAIR_COOLDOWN_MS = 15 * 60 * 1000; // one attack on the same player per 15 minutes
const MAX_ROUNDS = 10;
const CASH_SHARE = 0.05; // winner takes 5% of the loser's cash…
const CASH_CAP_PER_LEVEL = 25; // …but never more than $25 × the loser's level

/** Why `attacker` can't attack anyone right now, or null if they're ready. */
function selfBlocker(attacker, now = Date.now()) {
  if (attacker.level < MIN_PVP_LEVEL) return `PvP unlocks at level ${MIN_PVP_LEVEL}`;
  if (game.isHospitalized(attacker, now)) return 'You’re in hospital';
  if (attacker.energy < ATTACK_ENERGY) return `Attacking needs ${ATTACK_ENERGY} energy`;
  if (attacker.health < game.MIN_DEPLOY_HEALTH) return 'You’re too injured to fight';
  return null;
}

/** Why `defender` can never be a target for `attacker` at the moment, ignoring the attacker's own readiness. */
function targetBlocker(attacker, defender, { now = Date.now(), lastAttackAt = null } = {}) {
  if (attacker.id === defender.id) return 'You can’t attack yourself';
  if (defender.banned_at) return `${defender.username} is suspended`;
  if (defender.level < MIN_PVP_LEVEL) return `${defender.username} is a Recruit and protected until level ${MIN_PVP_LEVEL}`;
  if (game.isHospitalized(defender, now)) return `${defender.username} is in hospital`;
  if (defender.level < attacker.level - MAX_LEVELS_BELOW) return `${defender.username} is too far below your level`;
  if (lastAttackAt && now - lastAttackAt < PAIR_COOLDOWN_MS) {
    const mins = Math.ceil((PAIR_COOLDOWN_MS - (now - lastAttackAt)) / 60000);
    return `You attacked ${defender.username} recently. Try again in ${mins} min`;
  }
  return null;
}

/** Why `attacker` can't attack `defender` right now, or null if they can. */
function attackBlocker(attacker, defender, opts = {}) {
  if (attacker.id === defender.id) return 'You can’t attack yourself';
  return selfBlocker(attacker, opts.now) || targetBlocker(attacker, defender, opts);
}

/**
 * Trades blows until someone is knocked out or MAX_ROUNDS pass. The attacker
 * strikes first each round; the defender fights back automatically.
 */
function simulateFight(aStats, dStats, aHealth, dHealth, rng = Math.random) {
  const start = { attacker: aHealth, defender: dHealth };
  const rounds = [];
  let knockout = null;
  for (let n = 1; n <= MAX_ROUNDS && !knockout; n += 1) {
    const round = { n };
    round.attack = combat.rollHit(aStats, dStats, { rng, context: 'pvp' });
    dHealth = Math.max(0, dHealth - round.attack.damage);
    if (dHealth === 0) knockout = 'defender';
    else {
      round.counter = combat.rollHit(dStats, aStats, { rng, context: 'pvp' });
      aHealth = Math.max(0, aHealth - round.counter.damage);
      if (aHealth === 0) knockout = 'attacker';
    }
    round.health = { attacker: aHealth, defender: dHealth };
    rounds.push(round);
  }

  let attackerWon;
  if (knockout) attackerWon = knockout === 'defender';
  else {
    // No knockout: whoever lost the smaller share of their starting health wins; ties go to the defender.
    const aLoss = (start.attacker - aHealth) / start.attacker;
    const dLoss = (start.defender - dHealth) / start.defender;
    attackerWon = dLoss > aLoss;
  }
  return { rounds, knockout, attackerWon, health: { attacker: aHealth, defender: dHealth }, start };
}

/** XP for beating someone: more for punching up, less for punching down. */
function winXp(winnerLevel, loserLevel) {
  const factor = Math.min(1.5, Math.max(0.5, 1 + 0.1 * (loserLevel - winnerLevel)));
  return Math.round((8 + 2 * loserLevel) * factor);
}

function cashPrize(loser) {
  return Math.max(0, Math.min(Math.floor(loser.cash * CASH_SHARE), CASH_CAP_PER_LEVEL * loser.level));
}

/**
 * Resolves an attack. Inputs are raw DB rows plus combat stats; returns
 * { error } or { attacker, defender, report } with updated copies to persist.
 */
function resolveAttack(rawAttacker, rawDefender, { aStats, dStats, now = Date.now(), rng = Math.random, lastAttackAt = null }) {
  const attacker = game.applyRegen(rawAttacker, now);
  const defender = game.applyRegen(rawDefender, now);
  const blocker = attackBlocker(attacker, defender, { now, lastAttackAt });
  if (blocker) return { error: `${blocker}.` };

  if (attacker.energy >= attacker.max_energy) attacker.energy_updated_at = now;
  attacker.energy -= ATTACK_ENERGY;

  const fight = simulateFight(aStats, dStats, attacker.health, defender.health, rng);
  for (const [p, side] of [[attacker, 'attacker'], [defender, 'defender']]) {
    if (p.health >= p.max_health && fight.health[side] < p.max_health) p.health_updated_at = now;
    p.health = fight.health[side];
  }
  if (fight.knockout === 'defender') game.admitToHospital(defender, now, `Knocked out by ${attacker.username}`);
  if (fight.knockout === 'attacker') game.admitToHospital(attacker, now, `Knocked out attacking ${defender.username}`);

  const report = {
    rounds: fight.rounds,
    knockout: fight.knockout,
    attackerWon: fight.attackerWon,
    start: fight.start,
    end: fight.health,
    ratings: { attacker: combat.combatRating(aStats), defender: combat.combatRating(dStats) },
    levels: { attacker: attacker.level, defender: defender.level },
    cashTaken: 0,
    xp: { attacker: 0, defender: 0 },
    levelsGained: { attacker: [], defender: [] },
  };

  if (fight.attackerWon) {
    report.cashTaken = cashPrize(defender);
    defender.cash -= report.cashTaken;
    attacker.cash += report.cashTaken;
    report.xp.attacker = winXp(attacker.level, defender.level);
    attacker.pvp_wins = (attacker.pvp_wins || 0) + 1;
    defender.pvp_losses = (defender.pvp_losses || 0) + 1;
  } else {
    // Holding the line is worth a little XP; attackers who lose get nothing back.
    report.xp.defender = Math.round(winXp(defender.level, attacker.level) / 2);
    defender.pvp_wins = (defender.pvp_wins || 0) + 1;
    attacker.pvp_losses = (attacker.pvp_losses || 0) + 1;
  }
  report.levelsGained.attacker = game.grantXp(attacker, report.xp.attacker);
  report.levelsGained.defender = game.grantXp(defender, report.xp.defender);
  // A promotion refills health; don't leave someone both healed and admitted.
  for (const p of [attacker, defender]) {
    if (p.hospital_until && p.health > 0) {
      p.hospital_until = null;
      p.hospital_reason = null;
    }
  }

  return { attacker, defender, report };
}

module.exports = {
  ATTACK_ENERGY,
  CASH_CAP_PER_LEVEL,
  CASH_SHARE,
  MAX_LEVELS_BELOW,
  MAX_ROUNDS,
  MIN_PVP_LEVEL,
  PAIR_COOLDOWN_MS,
  attackBlocker,
  cashPrize,
  selfBlocker,
  targetBlocker,
  resolveAttack,
  simulateFight,
  winXp,
};
