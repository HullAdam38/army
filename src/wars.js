'use strict';

/**
 * Unit wars. Pure rules: who can declare on whom, how fights score, and how a
 * war is settled. Only full-reward PvP wins between the two sides count, and
 * only for soldiers who were in their unit when the war began, so recruiting
 * mercenaries mid-war or farming a friend's alt earns nothing.
 */

const HOUR = 60 * 60 * 1000;

const WAR_STAKE = 2500; // paid from the declaring unit's treasury
const WAR_DURATION_MS = 24 * HOUR;
const MIN_WAR_MEMBERS = 3;
const REMATCH_COOLDOWN_MS = 72 * HOUR; // between the same two units
const PROTECTION_MS = 6 * HOUR; // after a war ends, before either side can be declared on again

/** Points for a win in a war fight. */
const pointsFor = ({ knockout }) => (knockout ? 2 : 1);

/**
 * Why `attacker` (the declaring unit) can't declare war on `target`, or null.
 * `ctx` holds facts from the database: member counts, active wars, the last
 * war between the pair.
 */
function declareBlocker(attacker, target, ctx, now = Date.now()) {
  if (attacker.id === target.id) return 'A unit can’t declare war on itself.';
  if (ctx.attackerAtWar) return `${attacker.name} is already at war.`;
  if (ctx.targetAtWar) return `${target.name} is already at war.`;
  if (ctx.attackerMembers < MIN_WAR_MEMBERS) return `You need at least ${MIN_WAR_MEMBERS} members to declare war.`;
  if (ctx.targetMembers < MIN_WAR_MEMBERS) return `${target.name} has fewer than ${MIN_WAR_MEMBERS} members.`;
  if (target.war_protected_until && target.war_protected_until > now) {
    return `${target.name} has just come out of a war and is protected for ${Math.ceil((target.war_protected_until - now) / HOUR)}h.`;
  }
  if (attacker.war_protected_until && attacker.war_protected_until > now) {
    return `Your unit is regrouping after its last war. You can declare again in ${Math.ceil((attacker.war_protected_until - now) / HOUR)}h.`;
  }
  if (ctx.lastPairWarAt && now - ctx.lastPairWarAt < REMATCH_COOLDOWN_MS) {
    return `You fought ${target.name} recently. A rematch is possible in ${Math.ceil((REMATCH_COOLDOWN_MS - (now - ctx.lastPairWarAt)) / HOUR)}h.`;
  }
  if (attacker.treasury < WAR_STAKE) return `Declaring war costs $${WAR_STAKE.toLocaleString('en-US')} from the treasury.`;
  return null;
}

/**
 * Which side, if any, scores for a fight. Returns { side: 'attacker'|'defender', points } or null.
 * `war` is the war row; `a`/`d` are the attacking and defending players at fight time.
 */
function scoreFight(war, { a, d, attackerWon, knockout, fullRewards }) {
  if (!fullRewards) return null; // linked accounts or repeat wins on one player
  const sideOf = (p) => (p.unit_id === war.attacker_unit_id ? 'attacker' : p.unit_id === war.defender_unit_id ? 'defender' : null);
  const aSide = sideOf(a);
  const dSide = sideOf(d);
  if (!aSide || !dSide || aSide === dSide) return null;
  const winner = attackerWon ? a : d;
  if (!winner.unit_joined_at || winner.unit_joined_at > war.started_at) return null; // joined after the war began
  return { side: attackerWon ? aSide : dSide, points: pointsFor({ knockout }) };
}

/** How a finished war settles: winner side and what each treasury receives. */
function settle(war) {
  if (war.attacker_score > war.defender_score) return { winner: 'attacker', attackerPrize: war.stake * 2, defenderPrize: 0 };
  if (war.defender_score > war.attacker_score) return { winner: 'defender', attackerPrize: 0, defenderPrize: war.stake * 2 };
  return { winner: null, attackerPrize: war.stake, defenderPrize: 0 }; // draw: stake refunded
}

module.exports = {
  MIN_WAR_MEMBERS,
  PROTECTION_MS,
  REMATCH_COOLDOWN_MS,
  WAR_DURATION_MS,
  WAR_STAKE,
  declareBlocker,
  pointsFor,
  scoreFight,
  settle,
};
