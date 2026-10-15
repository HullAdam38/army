'use strict';

/**
 * Operations: three-stage missions for campaign 2. Each stage is rolled like a
 * mission (energy, success chance, XP, pay, damage on failure). A failed stage
 * stays put; clear all three in order for a big completion bonus. Each
 * operation can be completed once every 20 hours, so it's a daily goal rather
 * than something to grind. Pure rules.
 */

const COOLDOWN_MS = 20 * 60 * 60 * 1000;

const stage = (opId, n, def) => ({ ...def, id: `${opId}:${n}`, stage: n, opId });

const OPERATIONS = [
  {
    id: 'iron-gate',
    name: 'Operation Iron Gate',
    theatre: 'Northern Border',
    brief: 'Break through the fortified border crossing that has held for a decade.',
    minLevel: 16,
    favours: 'strength',
    bonus: { xp: 600, cash: 4000 },
  },
  {
    id: 'nightfall',
    name: 'Operation Nightfall',
    theatre: 'Occupied City',
    brief: 'A three-night campaign to retake the city one district at a time.',
    minLevel: 24,
    favours: 'agility',
    bonus: { xp: 1400, cash: 9000 },
  },
  {
    id: 'last-light',
    name: 'Operation Last Light',
    theatre: 'Enemy Heartland',
    brief: 'The final push. Seize the airfield, cut the rail hub, then take the command centre.',
    minLevel: 32,
    favours: 'endurance',
    bonus: { xp: 2600, cash: 16000 },
  },
];

// Stage details: rising energy and difficulty within each operation.
const STAGES = {
  'iron-gate': [
    { name: 'Clear the minefield', brief: 'Open a lane through the mines before first light.', energy: 25, chance: 0.6, xp: [130, 160], cash: [500, 800], damage: [15, 35] },
    { name: 'Storm the checkpoint', brief: 'Take the guard posts on both sides of the gate.', energy: 30, chance: 0.55, xp: [160, 200], cash: [700, 1000], damage: [20, 40] },
    { name: 'Hold the gate', brief: 'Dig in and beat back the counter-attack.', energy: 35, chance: 0.5, xp: [200, 240], cash: [900, 1300], damage: [25, 45] },
  ],
  nightfall: [
    { name: 'Docks district', brief: 'Land by boat and secure the waterfront.', energy: 35, chance: 0.55, xp: [260, 310], cash: [1300, 1800], damage: [25, 45] },
    { name: 'Old town', brief: 'Clear the narrow streets house by house.', energy: 40, chance: 0.5, xp: [300, 360], cash: [1600, 2200], damage: [30, 50] },
    { name: 'Government quarter', brief: 'Raise the flag over the ministry.', energy: 45, chance: 0.45, xp: [350, 420], cash: [2000, 2700], damage: [35, 55] },
  ],
  'last-light': [
    { name: 'Seize the airfield', brief: 'Take the runway intact for the reinforcements.', energy: 45, chance: 0.5, xp: [480, 560], cash: [2800, 3600], damage: [35, 60] },
    { name: 'Cut the rail hub', brief: 'Stop the trains that feed the front.', energy: 50, chance: 0.46, xp: [540, 630], cash: [3200, 4200], damage: [40, 65] },
    { name: 'Take the command centre', brief: 'End it.', energy: 55, chance: 0.42, xp: [620, 720], cash: [3800, 5000], damage: [45, 70] },
  ],
};

for (const op of OPERATIONS) {
  op.stages = STAGES[op.id].map((s, i) => stage(op.id, i + 1, { ...s, minLevel: op.minLevel, favours: op.favours, theatre: op.theatre }));
}

const OPERATIONS_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));

/**
 * Where a player is in an operation. `row` is their stored progress
 * ({ stage, completed_at, completions }) or null. Returns the stage to play
 * next (1–3) and when it's available again after a completion.
 */
function progressOf(op, row, now = Date.now()) {
  const completedAt = row ? row.completed_at : null;
  const coolingUntil = completedAt && now - completedAt < COOLDOWN_MS ? completedAt + COOLDOWN_MS : null;
  const current = row ? row.stage : 1; // completing an operation resets the stored stage to 1
  return {
    stage: coolingUntil ? null : current,
    cleared: coolingUntil ? op.stages.length : current - 1,
    coolingUntil,
    completions: row ? row.completions : 0,
  };
}

module.exports = { COOLDOWN_MS, OPERATIONS, OPERATIONS_BY_ID, progressOf };
