'use strict';

const { ITEMS, ITEMS_BY_ID, SLOTS } = require('./items');
const combat = require('./combat');
const gear = require('./gear');
const workshop = require('./workshop');
const { statsFor, gearBonus } = require('./game');

/** A player's real combat stats: equipped gear plus training. */
function statsOf(players, user) {
  return statsFor(user.level, Object.values(players.equipment(user.id)), user, players.conditions(user.id), players.upgrades(user.id));
}

/** Checks a purchase. Returns { error } or { item, cost }. */
function checkPurchase(itemId, player, owned) {
  const item = ITEMS_BY_ID.get(itemId);
  if (!item) return { error: 'That item isn’t in the catalogue.' };
  if (owned.has(item.id)) return { error: `You already own the ${item.name}.` };
  if (player.level < item.minLevel) return { error: `The ${item.name} requires level ${item.minLevel}.` };
  if (player.cash < item.price) return { error: `The ${item.name} costs $${item.price.toLocaleString('en-US')}. You have $${player.cash.toLocaleString('en-US')}.` };
  return { item, cost: item.price };
}

/** Checks equipping an owned item. Returns { error } or { item }. */
function checkEquip(itemId, player, owned) {
  const item = ITEMS_BY_ID.get(itemId);
  if (!item || !owned.has(item.id)) return { error: 'You don’t own that item.' };
  if (player.level < item.minLevel) return { error: `The ${item.name} requires level ${item.minLevel}.` };
  return { item };
}

/**
 * Everything the armory, HQ and profiles need to show a combat profile. Pass
 * the player row as `trained` for their true stats (own pages, scouting);
 * without it you get the gear-only view everyone else sees.
 */
function loadoutView(level, equipment, trained = null, conditions = null, upgrades = null) {
  const itemIds = Object.values(equipment);
  const stats = statsFor(level, itemIds, trained, conditions, upgrades);
  return {
    stats,
    rating: combat.combatRating(stats),
    includesTraining: Boolean(trained),
    mitigationPct: Math.round(combat.mitigation(stats.armor) * 100),
    gearBonusPct: Math.round(gearBonus(level, stats) * 100),
    slots: SLOTS.map((slot) => {
      const item = ITEMS_BY_ID.get(equipment[slot.id]) || null;
      const condition = item && conditions && conditions.has(item.id) ? conditions.get(item.id) : 100;
      const upgrade = item && upgrades && upgrades.has(item.id) ? upgrades.get(item.id) : 0;
      return { ...slot, item, condition, upgrade, upgradeLabel: workshop.label(upgrade), worn: condition < gear.FULL_POWER_AT, mods: item ? gear.scaledMods(item, condition, upgrade).map(combat.describeModifier) : [] };
    }),
  };
}

// The Armory's shops: one per gear slot, plus supplies. `slot` is null for supplies.
const SHOPS = [
  { id: 'weapons', slot: 'weapon', name: 'Weapons', icon: 'i-weapon', blurb: 'Your main source of attack.' },
  { id: 'armour', slot: 'body', name: 'Body armour', icon: 'i-body', blurb: 'Cuts the damage you take.' },
  { id: 'helmets', slot: 'helmet', name: 'Helmets', icon: 'i-helmet', blurb: 'More armour, and some help to dodge.' },
  { id: 'kit', slot: 'kit', name: 'Tactical kit', icon: 'i-kit', blurb: 'Scopes, uplinks and gadgets with special effects.' },
  { id: 'supplies', slot: null, name: 'Supplies', icon: 'i-health', blurb: 'Single-use boosts, bought and used on the spot.' },
];
const SHOPS_BY_ID = new Map(SHOPS.map((s) => [s.id, s]));
/** The shop that sells gear for `slotId`. */
const shopForSlot = (slotId) => SHOPS.find((s) => s.slot === slotId) || null;

/** A player's loadout, with their training and their gear's condition. `trained: false` for the view others see. */
const loadoutOf = (players, user, { trained = true } = {}) => loadoutView(user.level, players.equipment(user.id), trained ? user : null, players.conditions(user.id), players.upgrades(user.id));

/** Owned gear grouped by slot, best first, for the inventory: condition, repair cost and sale value included. */
function inventoryView(owned, equipment, conditions = new Map(), upgrades = new Map()) {
  return SLOTS.map((slot) => ({
    ...slot,
    shop: shopForSlot(slot.id),
    items: ITEMS.filter((i) => i.slot === slot.id && owned.has(i.id))
      .sort((a, b) => b.minLevel - a.minLevel)
      .map((item) => {
        const condition = conditions.has(item.id) ? conditions.get(item.id) : 100;
        const upgrade = upgrades.get(item.id) || 0;
        return {
          ...item,
          equipped: equipment[slot.id] === item.id,
          condition,
          conditionLabel: gear.conditionLabel(condition),
          power: Math.round(gear.effectiveness(condition) * 100),
          repairCost: gear.repairCost(item, condition),
          saleValue: gear.saleValue(item, condition),
          upgrade,
          upgradeLabel: workshop.label(upgrade),
          modText: gear.scaledMods(item, condition, upgrade).map(combat.describeModifier),
        };
      }),
  }));
}

/** Catalogue grouped by slot, annotated with each item's state for this player. */
function catalogueView(player, owned, equipment) {
  return SLOTS.map((slot) => ({
    ...slot,
    items: ITEMS.filter((i) => i.slot === slot.id).map((item) => {
      let state = 'buy';
      if (equipment[slot.id] === item.id) state = 'equipped';
      else if (owned.has(item.id)) state = 'owned';
      else if (player.level < item.minLevel) state = 'locked';
      else if (player.cash < item.price) state = 'expensive';
      return { ...item, state, modText: item.mods.map(combat.describeModifier) };
    }),
  }));
}

module.exports = { SHOPS, SHOPS_BY_ID, catalogueView, checkEquip, checkPurchase, inventoryView, loadoutOf, loadoutView, shopForSlot, statsOf };
