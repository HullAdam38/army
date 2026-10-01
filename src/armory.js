'use strict';

const { ITEMS, ITEMS_BY_ID, SLOTS } = require('./items');
const combat = require('./combat');
const { statsFor, gearBonus } = require('./game');

/** Combat stats for a stored player from their equipped gear. */
function statsOf(players, user) {
  return statsFor(user.level, Object.values(players.equipment(user.id)));
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

/** Everything the armory, HQ and profiles need to show a player's combat profile. */
function loadoutView(level, equipment) {
  const itemIds = Object.values(equipment);
  const stats = statsFor(level, itemIds);
  return {
    stats,
    rating: combat.combatRating(stats),
    mitigationPct: Math.round(combat.mitigation(stats.armor) * 100),
    gearBonusPct: Math.round(gearBonus(level, stats) * 100),
    slots: SLOTS.map((slot) => {
      const item = ITEMS_BY_ID.get(equipment[slot.id]) || null;
      return { ...slot, item, mods: item ? item.mods.map(combat.describeModifier) : [] };
    }),
  };
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

module.exports = { catalogueView, checkEquip, checkPurchase, loadoutView, statsOf };
