'use strict';

/**
 * Special operations: rare, time-limited missions. Pure rules.
 *
 * Every 6 hours (00:00, 06:00, 12:00 and 18:00 UTC) a special operation opens
 * for 3 hours. Each player gets one run per opening: three stages in a row,
 * and at each one they choose how to go in. Stealth is the safer choice;
 * assault pays more and hurts more when it goes wrong. A failed stage ends
 * the run. Clearing all three pays a completion bonus, a haul of workshop
 * materials rich in prototype cores, and a chance at a vehicle.
 *
 * Stages are scaled to the player: built from the best mission open to their
 * level, so a special operation is worth the same effort at every level.
 */

const crypto = require('node:crypto');
const tuning = require('./tuning');

const HOUR = 60 * 60 * 1000;
const EVERY_MS = 6 * HOUR;
const OPEN_MS = 3 * HOUR;
const MIN_LEVEL = 10;
const VEHICLE_CHANCE = 0.15; // on completion, if a vehicle they don't own is open to their level

const APPROACHES = {
  stealth: { id: 'stealth', name: 'Stealth', favours: 'agility', chance: 0.12, pay: 1, damage: 1 },
  assault: { id: 'assault', name: 'Assault', favours: 'strength', chance: -0.08, pay: 1.6, damage: 1.6 },
};

const OPS = [
  { id: 'glass-tower', name: 'Glass Tower', theatre: 'Capital District', brief: 'An enemy general is meeting his paymasters on the top floor of a glass tower. Get to him first.',
    stages: [
      { name: 'Get inside', stealth: 'Pose as the cleaning crew', assault: 'Breach the loading bay' },
      { name: 'Reach the top floor', stealth: 'Climb the lift shaft', assault: 'Fight up the stairwell' },
      { name: 'Take the general', stealth: 'Wait for him alone', assault: 'Storm the boardroom' },
    ] },
  { id: 'red-harvest', name: 'Red Harvest', theatre: 'Farmlands', brief: 'A militia has seized the grain stores the region needs for winter. Take them back before they burn them.',
    stages: [
      { name: 'Cross the fields', stealth: 'Move through the irrigation ditches', assault: 'Drive straight up the farm road' },
      { name: 'Clear the silos', stealth: 'Pick off the lookouts one by one', assault: 'Hit every silo at once' },
      { name: 'Hold the stores', stealth: 'Set traps and wait', assault: 'Counter-attack their trucks' },
    ] },
  { id: 'deep-water', name: 'Deep Water', theatre: 'Naval Yard', brief: 'A prototype submarine is being readied in an enemy dry dock. Make sure it never sails.',
    stages: [
      { name: 'Enter the harbour', stealth: 'Swim in under the nets', assault: 'Ram the harbour gate' },
      { name: 'Find the dry dock', stealth: 'Steal a dockworker’s pass', assault: 'Shoot through the warehouse' },
      { name: 'Scuttle the submarine', stealth: 'Open the flood valves', assault: 'Plant charges on the hull' },
    ] },
  { id: 'ghost-signal', name: 'Ghost Signal', theatre: 'Mountain Relay', brief: 'Someone is broadcasting our patrol routes from a relay station in the mountains. Silence it.',
    stages: [
      { name: 'Climb the pass', stealth: 'Take the goat track at night', assault: 'Push up the main road' },
      { name: 'Take the relay', stealth: 'Cut the power and slip in', assault: 'Assault the bunker' },
      { name: 'Trace the source', stealth: 'Tap the line and listen', assault: 'Interrogate the operators' },
    ] },
  { id: 'iron-rain', name: 'Iron Rain', theatre: 'Artillery Ridge', brief: 'Long-range guns on the ridge are shelling our forward base. Knock them out before nightfall.',
    stages: [
      { name: 'Reach the ridge', stealth: 'Crawl up under the smoke', assault: 'Charge the slope behind our own barrage' },
      { name: 'Silence the guns', stealth: 'Spike the barrels', assault: 'Blow the ammunition dump' },
      { name: 'Get out', stealth: 'Slip away down the far side', assault: 'Fight back to our lines' },
    ] },
  { id: 'black-ledger', name: 'Black Ledger', theatre: 'Free Port', brief: 'The enemy’s money runs through one banker in the free port. Take his ledger and the war goes broke.',
    stages: [
      { name: 'Find the banker', stealth: 'Shadow his courier', assault: 'Raid his favourite casino' },
      { name: 'Crack the vault', stealth: 'Copy the keys', assault: 'Cut through the door' },
      { name: 'Escape the port', stealth: 'Leave on a fishing boat', assault: 'Run the roadblocks' },
    ] },
  { id: 'white-out', name: 'White Out', theatre: 'Frozen North', brief: 'A downed cargo plane carrying our encryption gear lies in enemy territory. Reach it in the blizzard.',
    stages: [
      { name: 'Cross the ice', stealth: 'Ski in behind the storm front', assault: 'Drive across the frozen lake' },
      { name: 'Reach the wreck', stealth: 'Dig in and wait for their patrol to pass', assault: 'Ambush their patrol' },
      { name: 'Destroy the gear', stealth: 'Wipe it and take the drives', assault: 'Burn the whole wreck' },
    ] },
  { id: 'cold-iron', name: 'Cold Iron', theatre: 'Rail Junction', brief: 'An armoured train full of enemy officers passes the junction at dawn. Stop it.',
    stages: [
      { name: 'Reach the junction', stealth: 'Ride in on a freight car', assault: 'March cross-country through the night' },
      { name: 'Stop the train', stealth: 'Switch the points', assault: 'Blow the bridge' },
      { name: 'Board the train', stealth: 'Slip in through the mail car', assault: 'Storm the locomotive' },
    ] },
];
const OPS_BY_ID = new Map(OPS.map((o) => [o.id, o]));

/** The opening `now` falls in: { key, op, opensAt, closesAt, open }. */
function windowAt(now = Date.now()) {
  const index = Math.floor(now / EVERY_MS);
  const opensAt = index * EVERY_MS;
  // Shuffled by the window number, so the order isn't predictable but every player sees the same one.
  const pick = crypto.createHash('sha256').update(`special:${index}`).digest().readUInt32LE(0) % OPS.length;
  return { key: String(index), op: OPS[pick], opensAt, closesAt: opensAt + OPEN_MS, open: now < opensAt + OPEN_MS };
}

/** When the next opening starts (the current one, if it's still to come). */
const nextOpening = (now = Date.now()) => (windowAt(now).open ? windowAt(now).opensAt : (Math.floor(now / EVERY_MS) + 1) * EVERY_MS);

/**
 * One stage, as a mission-shaped object game.resolveMission can roll, built
 * from `base` (the best mission open to the player) and the approach chosen.
 */
function stageMission(op, stageNo, approachId, base) {
  const a = APPROACHES[approachId];
  const s = op.stages[stageNo - 1];
  const scale = (range, f) => range.map((v) => Math.max(1, Math.round(v * f)));
  const pay = 1.3 * a.pay * tuning.get('specialOpPayMult');
  return {
    id: `special:${op.id}:${stageNo}`,
    name: `${op.name}: ${s.name}`,
    minLevel: base.minLevel,
    energy: base.energy,
    chance: Math.max(0.1, Math.min(0.92, base.chance + a.chance)),
    favours: a.favours,
    xp: scale(base.xp, 1.3 * a.pay),
    cash: scale(base.cash, pay),
    damage: scale(base.damage, a.damage),
  };
}

/** The completion bonus: about four of the base mission's average pay, more for each assault taken. */
function completionBonus(base, assaults = 0) {
  const f = 4 * (1 + 0.15 * assaults) * tuning.get('specialOpPayMult');
  return {
    cash: Math.round(((base.cash[0] + base.cash[1]) / 2) * f),
    xp: Math.round(((base.xp[0] + base.xp[1]) / 2) * f),
  };
}

module.exports = { APPROACHES, EVERY_MS, MIN_LEVEL, OPEN_MS, OPS, OPS_BY_ID, VEHICLE_CHANCE, completionBonus, nextOpening, stageMission, windowAt };
