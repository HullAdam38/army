'use strict';

/**
 * Basic training: a short checklist that walks new players through the game.
 * Pure rules. Each step is detected from the player's real state (nothing to
 * click to "complete" it), pays a small one-off reward, and finishing every
 * step pays a graduation bonus.
 */

const STEPS = [
  { id: 'mission', title: 'Run your first mission', hint: 'Missions earn XP and cash. Start with Perimeter Patrol.', link: '/missions', cta: 'Missions', xp: 20, cash: 100, done: (s) => s.missions >= 1 },
  { id: 'gear', title: 'Equip gear from the Armory', hint: 'Gear raises your combat rating for missions and fights.', link: '/armory/shop/weapons', cta: 'Weapons shop', xp: 20, cash: 150, done: (s) => s.equipped >= 1 },
  { id: 'train', title: 'Train a stat', hint: 'Strength, Agility and Endurance are hidden from other players.', link: '/training', cta: 'Training', xp: 20, cash: 100, done: (s) => s.training >= 1 },
  { id: 'supply', title: 'Collect a supply drop', hint: 'Free cash every day. Keep a streak going for bigger drops.', link: '/hq#supply-title', cta: 'Supply drop', xp: 15, cash: 50, done: (s) => s.supplyDrops >= 1 },
  { id: 'bank', title: 'Bank some cash', hint: 'Cash in the bank can’t be taken when you lose a fight.', link: '/bank', cta: 'Bank', xp: 15, cash: 50, done: (s) => s.deposits >= 1 },
  { id: 'level', title: 'Reach level 3', hint: 'Level 3 unlocks PvP: you can attack, and be attacked.', link: '/missions', cta: 'Missions', xp: 0, cash: 200, done: (s) => s.level >= 3 },
  { id: 'vehicle', title: 'Get a vehicle from the motor pool', hint: 'A Trail Bike costs $1,200 from level 3 and raises your chance on every mission.', link: '/armory/motor-pool', cta: 'Motor pool', xp: 20, cash: 300, done: (s) => s.vehicles >= 1 },
  { id: 'unit', title: 'Apply to or join a unit', hint: 'Unit members can’t attack each other and share upgrades.', link: '/units', cta: 'Units', xp: 30, cash: 250, done: (s) => s.inUnit || s.applications >= 1 },
  { id: 'pvp', title: 'Win a PvP fight', hint: 'Find a target on the players list. Bank your cash first!', link: '/players?filter=targets', cta: 'Find a target', xp: 40, cash: 300, done: (s) => s.pvpWins >= 1 },
];

const GRADUATION = { id: 'graduate', xp: 100, cash: 500 };

const STEP_IDS = new Set(STEPS.map((s) => s.id));

/** Steps whose condition `state` meets but which aren't in `done` (a Set of ids). */
function newlyDone(state, done) {
  return STEPS.filter((step) => !done.has(step.id) && step.done(state));
}

/** View for the HQ card: every step with its status, plus totals. */
function view(done, { dismissed = false } = {}) {
  const steps = STEPS.map((s) => ({ id: s.id, title: s.title, hint: s.hint, link: s.link, cta: s.cta, xp: s.xp, cash: s.cash, done: done.has(s.id) }));
  const count = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done) || null;
  return {
    steps,
    count,
    total: steps.length,
    pct: Math.round((count / steps.length) * 100),
    next,
    complete: count === steps.length,
    graduated: done.has(GRADUATION.id),
    dismissed,
    bonus: GRADUATION,
  };
}

module.exports = { GRADUATION, STEPS, STEP_IDS, newlyDone, view };
