'use strict';

/**
 * Operations: three-stage missions for campaigns 2 to 6. Each stage is rolled like a
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
  // Campaign 3
  {
    id: 'black-tide',
    name: 'Operation Black Tide',
    theatre: 'Southern Archipelago',
    brief: 'Island by island, take back the sea lanes the enemy fleet controls.',
    minLevel: 40,
    favours: 'agility',
    bonus: { xp: 4500, cash: 28000 },
  },
  {
    id: 'iron-crown',
    name: 'Operation Iron Crown',
    theatre: 'The Old Empire',
    brief: 'March on the palace where the enemy high command has dug in, and end their rule.',
    minLevel: 47,
    favours: 'strength',
    bonus: { xp: 7000, cash: 45000 },
  },
  // Campaigns 4–6
  {
    id: 'glass-dagger',
    name: 'Operation Glass Dagger',
    theatre: 'Silicon Coast',
    brief: 'Strike the chip foundries that keep their drones flying, one plant at a time.',
    minLevel: 55,
    favours: 'agility',
    bonus: { xp: 9600, cash: 68000 },
  },
  {
    id: 'deep-winter',
    name: 'Operation Deep Winter',
    theatre: 'Frozen Front',
    brief: 'Push across a frozen front in the worst winter in a century.',
    minLevel: 62,
    favours: 'endurance',
    bonus: { xp: 11800, cash: 91000 },
  },
  {
    id: 'iron-tempest',
    name: 'Operation Iron Tempest',
    theatre: 'Industrial Heartland',
    brief: 'Shut down the factories that feed their entire war effort.',
    minLevel: 70,
    favours: 'strength',
    bonus: { xp: 14400, cash: 123000 },
  },
  {
    id: 'longest-night',
    name: 'Operation Longest Night',
    theatre: 'Polar Night',
    brief: 'Months of darkness at the top of the world, and an enemy that knows it better than you.',
    minLevel: 77,
    favours: 'endurance',
    bonus: { xp: 16900, cash: 155000 },
  },
  {
    id: 'starfall',
    name: 'Operation Starfall',
    theatre: 'Low Orbit',
    brief: 'Take the fight to their satellites, one station at a time.',
    minLevel: 85,
    favours: 'agility',
    bonus: { xp: 20000, cash: 198000 },
  },
  {
    id: 'endgame',
    name: 'Operation Endgame',
    theatre: 'Enemy Capital',
    brief: 'Every campaign has led here. Take the capital and end the war for good.',
    minLevel: 95,
    favours: 'strength',
    bonus: { xp: 24100, cash: 261000 },
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
  'black-tide': [
    { name: 'Beach landing', brief: 'Hit the shore at dawn under covering fire.', energy: 60, chance: 0.46, xp: [880, 1000], cash: [6400, 8200], damage: [50, 75] },
    { name: 'Take the harbour', brief: 'Seize the port before their ships can slip away.', energy: 65, chance: 0.43, xp: [980, 1120], cash: [7400, 9600], damage: [55, 80] },
    { name: 'Silence the coastal guns', brief: 'Knock out the batteries that guard the strait.', energy: 70, chance: 0.4, xp: [1100, 1260], cash: [8600, 11000], damage: [60, 85] },
  ],
  'iron-crown': [
    { name: 'Break the outer walls', brief: 'Open a breach in the ancient fortifications.', energy: 70, chance: 0.42, xp: [1240, 1420], cash: [10400, 13200], damage: [65, 90] },
    { name: 'Fight through the city', brief: 'Push street by street to the palace gates.', energy: 75, chance: 0.39, xp: [1380, 1580], cash: [11800, 15000], damage: [70, 95] },
    { name: 'Storm the throne room', brief: 'Take the palace and the high command with it.', energy: 80, chance: 0.36, xp: [1560, 1780], cash: [13600, 17400], damage: [75, 100] },
  ],
  'glass-dagger': [
    { name: 'Slip the border', brief: 'Cross at night with forged papers and no backup.', energy: 85, chance: 0.44, xp: [1800, 2050], cash: [17900, 22700], damage: [75, 100] },
    { name: 'Blind the foundry', brief: 'Cut power and comms to the main plant.', energy: 90, chance: 0.40, xp: [2000, 2280], cash: [19900, 25300], damage: [80, 105] },
    { name: 'Burn the clean rooms', brief: 'Destroy the lines they can’t rebuild for years.', energy: 95, chance: 0.36, xp: [2200, 2510], cash: [21800, 27800], damage: [85, 110] },
  ],
  'deep-winter': [
    { name: 'Cross the ice', brief: 'March over the frozen lake before the thaw.', energy: 90, chance: 0.43, xp: [2200, 2510], cash: [24000, 30500], damage: [80, 110] },
    { name: 'Take the fuel depot', brief: 'Without fuel, their tanks are scrap metal.', energy: 100, chance: 0.39, xp: [2440, 2780], cash: [26700, 33900], damage: [85, 115] },
    { name: 'Break the siege', brief: 'Relieve the city that has held out all winter.', energy: 110, chance: 0.35, xp: [2690, 3060], cash: [29300, 37300], damage: [90, 120] },
  ],
  'iron-tempest': [
    { name: 'Hit the rail yards', brief: 'Stop the ore trains coming in.', energy: 100, chance: 0.43, xp: [2700, 3070], cash: [32400, 41200], damage: [90, 115] },
    { name: 'Storm the foundries', brief: 'Fight through furnaces and assembly halls.', energy: 110, chance: 0.39, xp: [3000, 3410], cash: [35900, 45700], damage: [95, 120] },
    { name: 'Bring down the stacks', brief: 'Blow the power plant and the city goes dark.', energy: 120, chance: 0.35, xp: [3290, 3750], cash: [39500, 50300], damage: [100, 125] },
  ],
  'longest-night': [
    { name: 'Land in the dark', brief: 'Parachute onto the ice cap without lights.', energy: 110, chance: 0.42, xp: [3160, 3600], cash: [40900, 52100], damage: [95, 125] },
    { name: 'Find the listening post', brief: 'Track the signal across a hundred miles of snow.', energy: 120, chance: 0.38, xp: [3510, 4000], cash: [45500, 57900], damage: [100, 130] },
    { name: 'Hold until dawn', brief: 'Defend the post until the sun comes back.', energy: 130, chance: 0.34, xp: [3870, 4400], cash: [50000, 63700], damage: [105, 135] },
  ],
  'starfall': [
    { name: 'Launch', brief: 'Ride a converted rocket past their orbital defences.', energy: 120, chance: 0.42, xp: [3730, 4250], cash: [52200, 66500], damage: [100, 135] },
    { name: 'Board the station', brief: 'Breach the hull and take the control ring.', energy: 130, chance: 0.38, xp: [4150, 4730], cash: [58000, 73900], damage: [105, 140] },
    { name: 'Bring it down', brief: 'Steer it safely into the ocean.', energy: 140, chance: 0.34, xp: [4560, 5200], cash: [63800, 81300], damage: [110, 145] },
  ],
  'endgame': [
    { name: 'Break the outer ring', brief: 'Smash through the last defensive belt.', energy: 130, chance: 0.41, xp: [4500, 5130], cash: [68800, 87500], damage: [110, 145] },
    { name: 'Take the bridges', brief: 'Seize every crossing into the old city.', energy: 140, chance: 0.37, xp: [5000, 5700], cash: [76400, 97300], damage: [115, 150] },
    { name: 'Raise the flag', brief: 'Take the citadel and accept their surrender.', energy: 150, chance: 0.33, xp: [5500, 6270], cash: [84100, 107000], damage: [120, 155] },
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
