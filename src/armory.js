'use strict';

const { ITEMS, ITEMS_BY_ID, SLOTS } = require('./items');
const combat = require('./combat');
const { statsFor, gearBonus } = require('./game');

/** A player's real combat stats: equipped gear plus training. */
function statsOf(players, user) {
  return statsFor(user.level, Object.values(players.equipment(user.id)), user);
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
function loadoutView(level, equipment, trained = null) {
  const itemIds = Object.values(equipment);
  const stats = statsFor(level, itemIds, trained);
  return {
    stats,
    rating: combat.combatRating(stats),
    includesTraining: Boolean(trained),
    mitigationPct: Math.round(combat.mitigation(stats.armor) * 100),
    gearBonusPct: Math.round(gearBonus(level, stats) * 100),
    slots: SLOTS.map((slot) => {
      const item = ITEMS_BY_ID.get(equipment[slot.id]) || null;
      return { ...slot, item, mods: item ? item.mods.map(combat.describeModifier) : [] };
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

/** Owned gear grouped by slot, best first, for the inventory. */
function inventoryView(owned, equipment) {
  return SLOTS.map((slot) => ({
    ...slot,
    shop: shopForSlot(slot.id),
    items: ITEMS.filter((i) => i.slot === slot.id && owned.has(i.id))
      .sort((a, b) => b.minLevel - a.minLevel)
      .map((item) => ({ ...item, equipped: equipment[slot.id] === item.id, modText: item.mods.map(combat.describeModifier) })),
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

module.exports = { SHOPS, SHOPS_BY_ID, catalogueView, checkEquip, checkPurchase, inventoryView, loadoutView, shopForSlot, statsOf };
