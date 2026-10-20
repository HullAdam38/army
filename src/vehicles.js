'use strict';

/**
 * The motor pool: vehicles a player buys, assigns and keeps running. Pure rules.
 *
 * A player can own several vehicles but takes one out at a time (the one
 * "assigned"). Each class helps in a different part of the game, and none of
 * them change PvP, so fights stay about the soldier:
 *   - light vehicles get you in and out: a better chance on missions;
 *   - transports carry more back: more mission and deployment pay;
 *   - armour hits harder: more damage on unit raid strikes.
 * Vehicles wear like gear (src/gear.js) and lose power below 50% condition,
 * down to half power at 0%. Repairs and sales use the gear prices.
 */

const tuning = require('./tuning');
const gear = require('./gear');
const workshop = require('./workshop');

const CLASSES = [
  { id: 'light', name: 'Light vehicles', icon: 'i-jeep', blurb: 'Fast and nimble: a better chance of success on missions and operations.' },
  { id: 'transport', name: 'Transports', icon: 'i-truck', blurb: 'Room for the haul: more pay from missions, operations and deployments.' },
  { id: 'armour', name: 'Armour', icon: 'i-tank', blurb: 'Firepower for the big fights: more damage on unit raid strikes.' },
];
const CLASSES_BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

// `bonus`: missionChance (added to the success chance), missionCash and deployCash
// (added to the pay bonuses, like rank perks), raidDamage (more strike damage).
const VEHICLES = [
  // Light vehicles
  { id: 'trail-bike', cls: 'light', name: 'Trail Bike', minLevel: 3, price: 1200, blurb: 'Two wheels, no roof, gets you there first.', bonus: { missionChance: 0.03 } },
  { id: 'patrol-jeep', cls: 'light', name: 'Patrol Jeep', minLevel: 10, price: 9000, blurb: 'Open-top four-by-four with a pintle mount.', bonus: { missionChance: 0.04 } },
  { id: 'recon-buggy', cls: 'light', name: 'Recon Buggy', minLevel: 25, price: 65000, blurb: 'Long-travel suspension for ground nothing else can cross.', bonus: { missionChance: 0.05 } },
  { id: 'scout-car', cls: 'light', name: 'Armoured Scout Car', minLevel: 45, price: 300000, blurb: 'Quiet engine, thick skin, sharp optics.', bonus: { missionChance: 0.06 } },
  { id: 'stealth-rover', cls: 'light', name: 'Stealth Rover', minLevel: 75, price: 1000000, blurb: 'Radar-absorbent panels and an electric drive. In and out unseen.', bonus: { missionChance: 0.08 } },
  // Transports
  { id: 'utility-pickup', cls: 'transport', name: 'Utility Pickup', minLevel: 5, price: 2500, blurb: 'A flatbed and a full tank. Somebody has to carry the loot.', bonus: { missionCash: 0.04, deployCash: 0.1 } },
  { id: 'supply-truck', cls: 'transport', name: 'Supply Truck', minLevel: 15, price: 26000, blurb: 'Six wheels, five tonnes, no complaints.', bonus: { missionCash: 0.06, deployCash: 0.15 } },
  { id: 'apc', cls: 'transport', name: 'Armoured Personnel Carrier', minLevel: 32, price: 100000, blurb: 'Carries a squad and everything they bring back.', bonus: { missionCash: 0.08, deployCash: 0.2 } },
  { id: 'mrap', cls: 'transport', name: 'Heavy MRAP', minLevel: 55, price: 420000, blurb: 'Built to shrug off mines on the long supply runs.', bonus: { missionCash: 0.1, deployCash: 0.25 } },
  { id: 'hover-transport', cls: 'transport', name: 'Hover Transport', minLevel: 85, price: 1150000, blurb: 'Rides a cushion of air over water, sand and minefields alike.', bonus: { missionCash: 0.12, deployCash: 0.3 } },
  // Armour
  { id: 'light-tank', cls: 'armour', name: 'Light Tank', minLevel: 12, price: 16000, blurb: 'Small gun, quick tracks. Enough to crack a gate.', bonus: { raidDamage: 0.06 } },
  { id: 'ifv', cls: 'armour', name: 'Infantry Fighting Vehicle', minLevel: 28, price: 95000, blurb: 'Autocannon and missiles for whatever’s behind the walls.', bonus: { raidDamage: 0.1 } },
  { id: 'battle-tank', cls: 'armour', name: 'Main Battle Tank', minLevel: 45, price: 320000, blurb: 'Sixty tonnes of steel and a gun to match.', bonus: { raidDamage: 0.14 } },
  { id: 'assault-tank', cls: 'armour', name: 'Heavy Assault Tank', minLevel: 70, price: 900000, blurb: 'Breaches bunkers the hard way.', bonus: { raidDamage: 0.18 } },
  { id: 'siege-walker', cls: 'armour', name: 'Siege Walker', minLevel: 95, price: 1800000, blurb: 'Steps over the wall, then takes it apart.', bonus: { raidDamage: 0.22 } },
];
const VEHICLES_BY_ID = new Map(VEHICLES.map((v) => [v.id, v]));

const NO_BONUS = Object.freeze({ missionChance: 0, missionCash: 0, deployCash: 0, raidDamage: 0 });
// The biggest mission pay bonus any vehicle gives at the default setting, fully upgraded (anti-cheat allows for it).
const MAX_MISSION_CASH_BONUS = Math.max(...VEHICLES.map((v) => v.bonus.missionCash || 0)) * workshop.vehicleFactor(workshop.MAX_UPGRADE);
/** The biggest mission pay bonus a vehicle open to `level` gives at the default setting, fully upgraded. */
const bestMissionCash = (level) => Math.max(0, ...VEHICLES.filter((v) => v.minLevel <= level).map((v) => v.bonus.missionCash || 0)) * workshop.vehicleFactor(workshop.MAX_UPGRADE);

// Condition points lost per use, before the admin multiplier.
const WEAR = { mission: 0.15, missionFailed: 0.3, strike: 0.5, deployHour: 0.2 };

/** What a vehicle adds at `condition` and workshop `upgrade`: its bonuses × its power × its upgrade × the admin setting. */
function bonusesOf(vehicle, condition = 100, upgrade = 0) {
  if (!vehicle) return NO_BONUS;
  const f = gear.effectiveness(condition) * workshop.vehicleFactor(upgrade) * tuning.get('vehicleBonusMult');
  const out = {};
  for (const k of Object.keys(NO_BONUS)) out[k] = Math.round((vehicle.bonus[k] || 0) * f * 10000) / 10000;
  return out;
}

/** Short lines describing a set of bonuses, e.g. "+4% mission success". */
function describe(bonus) {
  const pct = (n) => `+${Math.round(n * 1000) / 10}%`;
  return [
    bonus.missionChance ? `${pct(bonus.missionChance)} mission success` : null,
    bonus.missionCash ? `${pct(bonus.missionCash)} mission pay` : null,
    bonus.deployCash ? `${pct(bonus.deployCash)} deployment pay` : null,
    bonus.raidDamage ? `${pct(bonus.raidDamage)} raid damage` : null,
  ].filter(Boolean);
}

/** Checks a purchase. Returns { error } or { vehicle }. */
function checkPurchase(vehicleId, player, owned) {
  const vehicle = VEHICLES_BY_ID.get(vehicleId);
  if (!vehicle) return { error: 'That vehicle isn’t in the motor pool.' };
  if (owned.has(vehicle.id)) return { error: `You already own the ${vehicle.name}.` };
  if (player.level < vehicle.minLevel) return { error: `The ${vehicle.name} requires level ${vehicle.minLevel}.` };
  if (player.cash < vehicle.price) return { error: `The ${vehicle.name} costs $${vehicle.price.toLocaleString('en-US')}. You have $${player.cash.toLocaleString('en-US')}.` };
  return { vehicle };
}

/** Condition after `points` of wear (× the admin setting), never below 0. */
const worn = (condition, points) => Math.max(0, Math.round((condition - points * tuning.get('vehicleWearMult')) * 100) / 100);

module.exports = {
  CLASSES, CLASSES_BY_ID, MAX_MISSION_CASH_BONUS, NO_BONUS, VEHICLES, VEHICLES_BY_ID, WEAR,
  bestMissionCash, bonusesOf, checkPurchase, describe, worn,
};
