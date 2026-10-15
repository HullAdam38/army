'use strict';

/**
 * Training: three hidden stats raised one point per session. Each point
 * becomes combat modifiers, so training plugs into the same engine as gear.
 */

const ENERGY_PER_SESSION = 5;
const POINTS_PER_LEVEL = 10; // a stat can't exceed 10 × your level
const MAX_HEALTH_PER_ENDURANCE = 2;
const MISSION_BONUS_PER_POINT = 0.002; // +0.2% success per point of the mission's favoured stat…
const MAX_MISSION_BONUS = 0.1; // …up to +10%

const STATS = {
  strength: {
    column: 'stat_str',
    label: 'Strength',
    blurb: 'Hits harder. Every point adds attack.',
    effect: (n) => [`+${fmt(n * 0.5)} attack`],
    mods: (n) => [{ stat: 'attack', kind: 'flat', value: n * 0.5 }],
  },
  agility: {
    column: 'stat_agi',
    label: 'Agility',
    blurb: 'Moves faster. Better crits and a chance to dodge hits entirely.',
    effect: (n) => [`+${fmt(n * 0.2)}% crit chance`, `+${fmt(n * 0.2)}% dodge`],
    mods: (n) => [
      { stat: 'critChance', kind: 'flat', value: n * 0.002 },
      { stat: 'dodge', kind: 'flat', value: n * 0.002 },
    ],
  },
  endurance: {
    column: 'stat_end',
    label: 'Endurance',
    blurb: 'Lasts longer. More armour and more max health.',
    effect: (n) => [`+${fmt(n * 0.5)} armour`, `+${n * MAX_HEALTH_PER_ENDURANCE} max health`],
    mods: (n) => [{ stat: 'armor', kind: 'flat', value: n * 0.5 }],
  },
};

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Cash for the next session when the stat is at `points`: $25, $30, $35… */
/** Cash for the next session at `points`, less any Firing Range discount (0–0.25). */
function sessionCost(points, discount = 0) {
  return Math.round((25 + 5 * points) * (1 - discount));
}

const discountFor = (player) => require('./base').effectsOf(player).trainingDiscount;

function statCap(level) {
  return POINTS_PER_LEVEL * level;
}

/** A player's stat points as { strength, agility, endurance }. */
function pointsOf(player) {
  return Object.fromEntries(Object.entries(STATS).map(([key, def]) => [key, (player && player[def.column]) || 0]));
}

/** Combat modifiers from a player's training (pass the player row). */
function modifiersFor(player) {
  if (!player) return [];
  const points = pointsOf(player);
  return Object.entries(STATS).flatMap(([key, def]) =>
    def.mods(points[key]).filter((m) => m.value).map((m) => ({ ...m, source: `${def.label} training` })));
}

/** Mission success bonus from the mission's favoured stat. */
function missionBonus(mission, player) {
  if (!mission.favours || !player) return 0;
  return Math.min(MAX_MISSION_BONUS, (pointsOf(player)[mission.favours] || 0) * MISSION_BONUS_PER_POINT);
}

/**
 * Trains `stat` up to `times` sessions, stopping early when energy, cash or the
 * level cap runs out. Returns { error } or { player, sessions, cash, energy }.
 * `player` should already have regeneration applied.
 */
function train(current, stat, times = 1) {
  const def = STATS[stat];
  if (!def) return { error: 'Pick Strength, Agility or Endurance.' };
  if (current.hospital_until && current.hospital_until > Date.now()) return { error: 'You can’t train while you’re in hospital.' };
  const cap = statCap(current.level);
  const player = { ...current };
  let sessions = 0;
  let cash = 0;
  for (let i = 0; i < Math.max(1, Math.min(10, times)); i += 1) {
    const points = player[def.column] || 0;
    if (points >= cap) break;
    if (player.energy < ENERGY_PER_SESSION) break;
    const cost = sessionCost(points, discountFor(current));
    if (player.cash < cost) break;
    if (player.energy >= player.max_energy) player.energy_updated_at = Date.now(); // regen clock starts now
    player.energy -= ENERGY_PER_SESSION;
    player.cash -= cost;
    player[def.column] = points + 1;
    if (stat === 'endurance') {
      player.max_health += MAX_HEALTH_PER_ENDURANCE;
      player.health += MAX_HEALTH_PER_ENDURANCE;
    }
    sessions += 1;
    cash += cost;
  }
  if (!sessions) {
    const points = current[def.column] || 0;
    if (points >= cap) return { error: `${def.label} is at its limit for your level (${cap}). Level up to train further.` };
    if (current.energy < ENERGY_PER_SESSION) return { error: `Training needs ${ENERGY_PER_SESSION} energy.` };
    return { error: `The next ${def.label} session costs $${sessionCost(points)}.` };
  }
  return { player, sessions, cash, energy: sessions * ENERGY_PER_SESSION };
}

/** What the training page needs for one stat. */
function statView(player, stat) {
  const def = STATS[stat];
  const points = pointsOf(player)[stat];
  const cap = statCap(player.level);
  const discount = discountFor(player);
  const cost = sessionCost(points, discount);
  const fiveCost = [0, 1, 2, 3, 4].reduce((sum, i) => sum + (points + i < cap ? sessionCost(points + i, discount) : 0), 0);
  return {
    key: stat,
    label: def.label,
    blurb: def.blurb,
    points,
    cap,
    atCap: points >= cap,
    pct: Math.min(100, Math.round((points / cap) * 100)),
    effects: def.effect(points),
    perPoint: def.effect(1),
    cost,
    fiveCost,
    fiveSessions: Math.min(5, cap - points),
  };
}

module.exports = {
  ENERGY_PER_SESSION,
  MAX_HEALTH_PER_ENDURANCE,
  POINTS_PER_LEVEL,
  STATS,
  missionBonus,
  modifiersFor,
  pointsOf,
  sessionCost,
  statCap,
  statView,
  train,
};
