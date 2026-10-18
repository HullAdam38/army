'use strict';

const express = require('express');
const supplies = require('../supplies');
const game = require('../game');
const { ITEMS_BY_ID, SLOTS } = require('../items');
const { SHOPS, SHOPS_BY_ID, catalogueView, checkEquip, checkPurchase, inventoryView, loadoutView, shopForSlot } = require('../armory');
const { createRequireAuth } = require('../require-auth');

/**
 * The Armory: your loadout and inventory on /armory, and a shop per gear slot
 * (plus supplies) on /armory/shop/:shop.
 */
function armoryRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const toInventory = (res, slot) => res.redirect(slot ? `/armory#inv-${slot}` : '/armory');
  const shopUrl = (shop, hash = '') => `/armory/shop/${shop.id}${hash}`;

  router.get('/armory', requireAuth, (req, res) => {
    const owned = players.ownedItemIds(req.player.id);
    const equipment = players.equipment(req.player.id);
    res.render('armory', {
      title: 'Armory',
      nav: 'armory',
      shops: SHOPS,
      active: 'inventory',
      loadout: loadoutView(req.player.level, equipment, req.player),
      inventory: inventoryView(owned, equipment),
      stimLoaded: Boolean(req.player.stim_loaded),
    });
  });

  router.get('/armory/shop/:shop', requireAuth, (req, res, next) => {
    const shop = SHOPS_BY_ID.get(String(req.params.shop));
    if (!shop) return next();
    const now = Date.now();
    const me = game.applyRegen(req.player, now);
    const equipment = players.equipment(req.player.id);
    const slot = shop.slot ? catalogueView(me, players.ownedItemIds(me.id), equipment).find((s) => s.id === shop.slot) : null;
    res.render('armory-shop', {
      title: shop.name,
      nav: 'armory',
      shops: SHOPS,
      active: shop.id,
      shop,
      cash: me.cash,
      items: slot ? slot.items : [],
      equipped: shop.slot ? ITEMS_BY_ID.get(equipment[shop.slot]) || null : null,
      supplies: shop.slot ? [] : supplies.SUPPLIES.map((s) => ({ ...s, locked: me.level < s.minLevel, blocker: supplies.buyBlocker(s, me, now), loaded: s.id === 'stim' && Boolean(me.stim_loaded) })),
    });
  });

  // Consumables: bought and used in one step.
  router.post('/armory/supplies/:id', requireAuth, (req, res) => {
    const back = shopUrl(SHOPS_BY_ID.get('supplies'));
    const supply = supplies.SUPPLIES_BY_ID.get(String(req.params.id));
    if (!supply) return res.redirect(back);
    const outcome = players.transaction(() => {
      const now = Date.now();
      const fresh = game.applyRegen(players.findById(req.player.id), now);
      const blocker = supplies.buyBlocker(supply, fresh, now);
      if (blocker) return { error: `${supply.name}: ${blocker}.` };
      const out = supplies.use(supply, fresh, now);
      players.save(out.player, { reason: 'supplies', ref: supply.id });
      return out;
    });
    req.flash(outcome.error ? 'error' : 'success', outcome.error || `${supply.name} used: ${outcome.note}.`);
    res.redirect(back);
  });

  router.post('/armory/buy/:id', requireAuth, (req, res) => {
    const item = ITEMS_BY_ID.get(String(req.params.id));
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      const check = checkPurchase(req.params.id, fresh, players.ownedItemIds(fresh.id));
      if (check.error) return check;
      fresh.cash -= check.cost;
      players.save(fresh, { reason: 'armory', ref: check.item.id });
      players.addItem(fresh.id, check.item.id);
      players.equip(fresh.id, check.item.slot, check.item.id);
      players.log(fresh.id, 'system', `Bought the ${check.item.name} for $${check.cost.toLocaleString('en-US')}.`);
      return check;
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `${outcome.item.name} purchased and equipped.`);
    // Back to the shop it was bought from (or the inventory for an unknown item).
    const shop = item && shopForSlot(item.slot);
    if (!shop) return toInventory(res);
    res.redirect(shopUrl(shop, `#item-${item.id}`));
  });

  router.post('/armory/equip/:id', requireAuth, (req, res) => {
    const check = checkEquip(req.params.id, req.player, players.ownedItemIds(req.player.id));
    if (check.error) {
      req.flash('error', check.error);
      return toInventory(res);
    }
    players.equip(req.player.id, check.item.slot, check.item.id);
    req.flash('success', `${check.item.name} equipped.`);
    toInventory(res, check.item.slot);
  });

  router.post('/armory/unequip/:slot', requireAuth, (req, res) => {
    const slot = SLOTS.find((s) => s.id === req.params.slot);
    const current = slot && ITEMS_BY_ID.get(players.equipment(req.player.id)[slot.id]);
    if (!current) {
      req.flash('error', 'Nothing equipped there.');
      return toInventory(res);
    }
    players.unequip(req.player.id, slot.id);
    req.flash('info', `${current.name} stowed.`);
    toInventory(res, slot.id);
  });

  return router;
}

module.exports = { armoryRoutes };
