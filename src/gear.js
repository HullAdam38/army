'use strict';

/**
 * Gear condition: wear, repairs and selling. Every owned item has a condition
 * from 0 to 100%. Fighting wears it down: weapons and kit when you strike,
 * armour and helmets when you take hits. Above 50% gear works at full power;
 * below that it weakens, down to half power at 0%, so neglect costs you but
 * never leaves you empty-handed. Repairs and sales are priced from the
 * item's shop price (Game settings › Armory).
 */

const tuning = require('./tuning');
const { ITEMS_BY_ID } = require('./items');
const workshop = require('./workshop');

const FULL_POWER_AT = 50; // condition from which gear works at 100%
const WORN_AT = 50; // tell the player once their gear drops below this…
const BROKEN_AT = 15; // …and again below this

// Condition points each slot loses per action, before the admin multiplier.
const WEAR = {
  mission: { weapon: 0.5, kit: 0.25 },
  missionFailed: { weapon: 0.5, kit: 0.25, body: 1, helmet: 1 }, // a failed mission means you took hits
  attack: { weapon: 1, kit: 0.5, body: 1, helmet: 1 },
  defend: { weapon: 0.5, body: 1, helmet: 1 },
  strike: { weapon: 1, kit: 0.5, body: 0.5, helmet: 0.5 },
};

/** How much of an item's stats work at `condition` (1 at 50% and up, 0.5 at 0%). */
const effectiveness = (condition = 100) => Math.min(1, 0.5 + Math.max(0, condition) / (2 * FULL_POWER_AT));

/** An item's modifiers at a given condition and workshop upgrade (0–3): each bonus scaled by both. */
function scaledMods(item, condition = 100, upgrade = 0) {
  const f = effectiveness(condition) * workshop.gearFactor(upgrade);
  if (f === 1) return item.mods;
  return item.mods.map((m) => ({ ...m, value: m.value * f }));
}

/** Cost to bring an item back to 100%. */
function repairCost(item, condition) {
  const lost = Math.max(0, 100 - condition);
  if (!lost) return 0;
  return Math.max(1, Math.round((item.price * tuning.get('gearRepairShare') * lost) / 100));
}

/** What the Armory pays for an item: a share of its price, less for worn gear (half at 0%). */
const saleValue = (item, condition = 100) => {
  const exact = item.price * tuning.get('gearSellShare') * (0.5 + Math.max(0, Math.min(100, condition)) / 200);
  return Math.floor(Math.round(exact * 100) / 100); // rounded to cents first: 1800 × 0.4 × 0.7 is 503.9999… in floating point
};

/** A short label for a condition. */
function conditionLabel(condition) {
  if (condition >= 90) return 'Good';
  if (condition >= WORN_AT) return 'Used';
  if (condition >= BROKEN_AT) return 'Worn';
  return 'Badly worn';
}

/**
 * Wears the player's equipped gear for one action (inside the caller's
 * transaction). `event` is a key of WEAR. Reserve soldiers' gear doesn't wear.
 * Tells the player when an item drops below 50% or 15%. Returns what changed.
 */
function wear(players, userId, event, now = Date.now()) {
  const mult = tuning.get('gearWearMult');
  const plan = WEAR[event];
  if (!plan || mult <= 0) return [];
  const user = players.findById(userId);
  if (!user || user.is_bot) return [];
  const equipment = players.equipment(userId);
  const conditions = players.conditions(userId);
  const changed = [];
  for (const [slot, points] of Object.entries(plan)) {
    const itemId = equipment[slot];
    const item = itemId && ITEMS_BY_ID.get(itemId);
    if (!item || !conditions.has(itemId)) continue;
    const before = conditions.get(itemId);
    const after = Math.max(0, Math.round((before - points * mult) * 100) / 100);
    if (after === before) continue;
    players.setCondition(userId, itemId, after);
    changed.push({ item, before, after });
    const crossed = [BROKEN_AT, WORN_AT].find((t) => before >= t && after < t);
    if (crossed) {
      players.notify(userId, 'system', crossed === BROKEN_AT
        ? `Your ${item.name} is badly worn (${Math.floor(after)}%) and only works at ${Math.round(effectiveness(after) * 100)}% power. Repair it at the Armory.`
        : `Your ${item.name} is getting worn (${Math.floor(after)}%) and starting to lose power. Repair it at the Armory.`, `/armory#inv-${slot}`);
    }
  }
  return changed;
}

module.exports = { BROKEN_AT, FULL_POWER_AT, WEAR, WORN_AT, conditionLabel, effectiveness, repairCost, saleValue, scaledMods, wear };
