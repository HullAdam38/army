'use strict';

/**
 * Pure game rules. Nothing here touches the database, so the whole loop can be
 * unit tested by passing in a plain player object, a clock and an RNG.
 */

const ENERGY_REGEN_MS = 2 * 60 * 1000; // +1 energy every 2 minutes
const HEALTH_REGEN_MS = 60 * 1000; // +1 health every minute
const MIN_DEPLOY_HEALTH = 15;
const HOSPITAL_COST_PER_HP = 2;

const RANKS = [
  { name: 'Recruit', grade: 'E-1' },
  { name: 'Private', grade: 'E-2' },
  { name: 'Private First Class', grade: 'E-3' },
  { name: 'Corporal', grade: 'E-4' },
  { name: 'Sergeant', grade: 'E-5' },
  { name: 'Staff Sergeant', grade: 'E-6' },
  { name: 'Sergeant First Class', grade: 'E-7' },
  { name: 'Master Sergeant', grade: 'E-8' },
  { name: 'Second Lieutenant', grade: 'O-1' },
  { name: 'First Lieutenant', grade: 'O-2' },
  { name: 'Captain', grade: 'O-3' },
  { name: 'Major', grade: 'O-4' },
  { name: 'Lieutenant Colonel', grade: 'O-5' },
  { name: 'Colonel', grade: 'O-6' },
  { name: 'Brigadier General', grade: 'O-7' },
  { name: 'Major General', grade: 'O-8' },
  { name: 'Lieutenant General', grade: 'O-9' },
  { name: 'General', grade: 'O-10' },
];

const MISSIONS = [
  {
    id: 'perimeter-patrol',
    name: 'Perimeter Patrol',
    theatre: 'Home Base',
    brief: 'Walk the wire, check the sensors and report anything that moves.',
    minLevel: 1, energy: 5, chance: 0.9,
    xp: [8, 12], cash: [20, 40], damage: [3, 8],
  },
  {
    id: 'convoy-escort',
    name: 'Convoy Escort',
    theatre: 'Route Iron',
    brief: 'Ride shotgun on a supply convoy through contested roads.',
    minLevel: 1, energy: 8, chance: 0.8,
    xp: [14, 20], cash: [40, 75], damage: [5, 12],
  },
  {
    id: 'forward-recon',
    name: 'Forward Recon',
    theatre: 'Ridge Line',
    brief: 'Slip past enemy pickets and map their positions before dawn.',
    minLevel: 3, energy: 10, chance: 0.72,
    xp: [22, 30], cash: [70, 120], damage: [8, 16],
  },
  {
    id: 'secure-bridge',
    name: 'Secure the Bridge',
    theatre: 'River Crossing',
    brief: 'Take and hold the crossing until armour can roll through.',
    minLevel: 5, energy: 15, chance: 0.65,
    xp: [40, 55], cash: [150, 240], damage: [12, 22],
  },
  {
    id: 'hostage-extraction',
    name: 'Hostage Extraction',
    theatre: 'Old Town',
    brief: 'Breach, clear and bring every civilian home. No second chances.',
    minLevel: 8, energy: 20, chance: 0.58,
    xp: [70, 95], cash: [300, 450], damage: [15, 30],
  },
  {
    id: 'high-value-target',
    name: 'High-Value Target',
    theatre: 'Classified',
    brief: 'Locate and neutralise a high-value target deep behind enemy lines.',
    minLevel: 12, energy: 30, chance: 0.5,
    xp: [130, 170], cash: [650, 900], damage: [20, 40],
  },
];

const MISSIONS_BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

function xpToNext(level) {
  return Math.round(100 * Math.pow(level, 1.6));
}

function rankFor(level) {
  return RANKS[Math.min(Math.floor((level - 1) / 2), RANKS.length - 1)];
}

/** The next rank up and the level it arrives at, or null at the top. */
function nextRankFor(level) {
  const current = rankFor(level);
  for (let l = level + 1; l <= RANKS.length * 2; l += 1) {
    const rank = rankFor(l);
    if (rank !== current) return { ...rank, level: l };
  }
  return null;
}

function randInt([min, max], rng) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Top up a resource that regenerates over time, keeping leftover progress. */
function regenResource(value, max, updatedAt, intervalMs, now) {
  if (value >= max) return { value: max, updatedAt: now };
  const ticks = Math.floor((now - updatedAt) / intervalMs);
  if (ticks <= 0) return { value, updatedAt };
  const next = Math.min(max, value + ticks);
  return { value: next, updatedAt: next >= max ? now : updatedAt + ticks * intervalMs };
}

/** Returns a copy of the player with energy and health regenerated up to `now`. */
function applyRegen(player, now = Date.now()) {
  const energy = regenResource(player.energy, player.max_energy, player.energy_updated_at, ENERGY_REGEN_MS, now);
  const health = regenResource(player.health, player.max_health, player.health_updated_at, HEALTH_REGEN_MS, now);
  return {
    ...player,
    energy: energy.value,
    energy_updated_at: energy.updatedAt,
    health: health.value,
    health_updated_at: health.updatedAt,
  };
}

function successChance(mission, player) {
  let chance = mission.chance + 0.01 * Math.max(0, player.level - mission.minLevel);
  if (player.health < player.max_health / 2) chance -= 0.1;
  return Math.max(0.05, Math.min(0.97, chance));
}

/** Why a player can't run a mission right now, or null if they can. */
function missionBlocker(mission, player) {
  if (player.level < mission.minLevel) return `Requires level ${mission.minLevel}`;
  if (player.energy < mission.energy) return 'Not enough energy';
  if (player.health < MIN_DEPLOY_HEALTH) return 'Too injured to deploy';
  return null;
}

/** Adds XP and processes any level-ups. Mutates and returns `player`. */
function grantXp(player, amount) {
  player.xp += amount;
  const levelsGained = [];
  while (player.xp >= xpToNext(player.level)) {
    player.xp -= xpToNext(player.level);
    player.level += 1;
    player.max_energy += 5;
    player.max_health += 10;
    player.energy = player.max_energy;
    player.health = player.max_health;
    levelsGained.push(player.level);
  }
  return levelsGained;
}

/**
 * Resolves a mission. Returns { player, result } where `player` is the updated
 * copy to persist, or { error } when the mission can't be attempted.
 */
function runMission(missionId, current, { now = Date.now(), rng = Math.random } = {}) {
  const mission = MISSIONS_BY_ID.get(missionId);
  if (!mission) return { error: 'Unknown mission.' };

  const player = applyRegen(current, now);
  const blocker = missionBlocker(mission, player);
  if (blocker) return { error: `${blocker}.`, player };

  const chance = successChance(mission, player);
  const wasFullEnergy = player.energy >= player.max_energy;
  player.energy -= mission.energy;
  if (wasFullEnergy) player.energy_updated_at = now; // regen clock starts now

  const success = rng() < chance;
  const result = { missionId, missionName: mission.name, success, chance, xp: 0, cash: 0, damage: 0 };

  if (success) {
    result.xp = randInt(mission.xp, rng);
    result.cash = randInt(mission.cash, rng);
    player.cash += result.cash;
    player.missions_completed += 1;
  } else {
    result.xp = Math.max(1, Math.round(randInt(mission.xp, rng) * 0.25));
    result.damage = Math.min(player.health - 1, randInt(mission.damage, rng));
    if (player.health >= player.max_health) player.health_updated_at = now;
    player.health -= result.damage;
    player.missions_failed += 1;
  }

  result.levelsGained = grantXp(player, result.xp);
  return { player, result };
}

function hospitalCost(player) {
  return (player.max_health - player.health) * HOSPITAL_COST_PER_HP;
}

/** Pays to restore health to full. */
function visitHospital(current, { now = Date.now() } = {}) {
  const player = applyRegen(current, now);
  const cost = hospitalCost(player);
  if (cost === 0) return { error: 'You are already at full health.', player };
  if (player.cash < cost) return { error: `Treatment costs $${cost}. You can't cover it yet.`, player };
  player.cash -= cost;
  player.health = player.max_health;
  player.health_updated_at = now;
  return { player, cost };
}

function newPlayerDefaults(now = Date.now()) {
  return {
    level: 1, xp: 0, cash: 100,
    energy: 50, max_energy: 50,
    health: 100, max_health: 100,
    energy_updated_at: now, health_updated_at: now,
  };
}

function secondsUntilNext(value, max, updatedAt, intervalMs, now) {
  if (value >= max) return null;
  return Math.max(0, Math.ceil((updatedAt + intervalMs - now) / 1000));
}

/** Presentation-friendly snapshot shared by the templates and the JSON API. */
function playerView(raw, now = Date.now()) {
  const p = applyRegen(raw, now);
  const need = xpToNext(p.level);
  const rank = rankFor(p.level);
  const total = p.missions_completed + p.missions_failed;
  return {
    username: p.username,
    level: p.level,
    rank: rank.name,
    grade: rank.grade,
    xp: p.xp,
    xpNeeded: need,
    xpPct: Math.floor((p.xp / need) * 100),
    cash: p.cash,
    energy: p.energy,
    maxEnergy: p.max_energy,
    energyPct: Math.floor((p.energy / p.max_energy) * 100),
    energyRegenSeconds: ENERGY_REGEN_MS / 1000,
    nextEnergyIn: secondsUntilNext(p.energy, p.max_energy, p.energy_updated_at, ENERGY_REGEN_MS, now),
    health: p.health,
    maxHealth: p.max_health,
    healthPct: Math.floor((p.health / p.max_health) * 100),
    healthRegenSeconds: HEALTH_REGEN_MS / 1000,
    nextHealthIn: secondsUntilNext(p.health, p.max_health, p.health_updated_at, HEALTH_REGEN_MS, now),
    missionsCompleted: p.missions_completed,
    missionsFailed: p.missions_failed,
    successRate: total ? Math.round((p.missions_completed / total) * 100) : null,
    hospitalCost: hospitalCost(p),
    canDeploy: p.health >= MIN_DEPLOY_HEALTH,
  };
}

function missionViews(raw, now = Date.now()) {
  const p = applyRegen(raw, now);
  return MISSIONS.map((m) => ({
    ...m,
    locked: p.level < m.minLevel,
    blocker: missionBlocker(m, p),
    chancePct: Math.round(successChance(m, p) * 100),
  }));
}

module.exports = {
  ENERGY_REGEN_MS,
  HEALTH_REGEN_MS,
  MIN_DEPLOY_HEALTH,
  MISSIONS,
  RANKS,
  applyRegen,
  grantXp,
  hospitalCost,
  missionViews,
  newPlayerDefaults,
  nextRankFor,
  playerView,
  rankFor,
  runMission,
  successChance,
  visitHospital,
  xpToNext,
};
