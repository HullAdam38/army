'use strict';

const express = require('express');
const supplies = require('../supplies');
const game = require('../game');
const { ITEMS_BY_ID, SLOTS } = require('../items');
const { SHOPS, SHOPS_BY_ID, catalogueView, checkEquip, checkPurchase, inventoryView, loadoutOf, shopForSlot } = require('../armory');
const gear = require('../gear');
const { createRequireAuth } = require('../require-auth');
const vehicles = require('../vehicles');

/**
 * The Armory: your loadout and inventory on /armory, a shop per gear slot
 * (plus supplies) on /armory/shop/:shop, and the motor pool on /armory/motor-pool.
 */
function armoryRoutes(players, vehicleService = null) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const toInventory = (res, slot) => res.redirect(slot ? `/armory#inv-${slot}` : '/armory');
  const shopUrl = (shop, hash = '') => `/armory/shop/${shop.id}${hash}`;

  router.get('/armory', requireAuth, (req, res) => {
    const owned = players.ownedItemIds(req.player.id);
    const equipment = players.equipment(req.player.id);
    const inventory = inventoryView(owned, equipment, players.conditions(req.player.id));
    const all = inventory.flatMap((s) => s.items);
    res.render('armory', {
      title: 'Armory',
      nav: 'armory',
      shops: SHOPS,
      active: 'inventory',
      loadout: loadoutOf(players, req.player),
      inventory,
      repairAll: all.reduce((n, i) => n + i.repairCost, 0),
      fullPowerAt: gear.FULL_POWER_AT,
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

  // Repairs: back to 100% for a share of the price (Game settings › Armory). `all` repairs everything owned.
  router.post('/armory/repair/:id', requireAuth, (req, res) => {
    const all = req.params.id === 'all';
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      const conditions = players.conditions(fresh.id);
      const jobs = [...conditions].map(([id, condition]) => ({ item: ITEMS_BY_ID.get(id), condition }))
        .filter((j) => j.item && (all || j.item.id === req.params.id) && j.condition < 100)
        .map((j) => ({ ...j, cost: gear.repairCost(j.item, j.condition) }));
      if (!all && !conditions.has(req.params.id)) return { error: 'You don’t own that.' };
      if (!jobs.length) return { error: all ? 'Everything you own is in perfect condition.' : 'That’s already in perfect condition.' };
      const cost = jobs.reduce((n, j) => n + j.cost, 0);
      if (fresh.cash < cost) return { error: `That repair costs $${cost.toLocaleString('en-US')}. You have $${fresh.cash.toLocaleString('en-US')} in cash.` };
      fresh.cash -= cost;
      players.save(fresh, { reason: 'armory-repair', ref: all ? 'all' : jobs[0].item.id });
      for (const j of jobs) players.setCondition(fresh.id, j.item.id, 100);
      return { cost, jobs };
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `${outcome.jobs.length === 1 ? outcome.jobs[0].item.name : `${outcome.jobs.length} items`} repaired to 100% for $${outcome.cost.toLocaleString('en-US')}.`);
    const one = !all && ITEMS_BY_ID.get(String(req.params.id));
    toInventory(res, one ? one.slot : null);
  });

  // Selling: the Armory buys gear back for a share of its price, less for worn gear.
  router.post('/armory/sell/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      const item = ITEMS_BY_ID.get(String(req.params.id));
      const conditions = players.conditions(fresh.id);
      if (!item || !conditions.has(item.id)) return { error: 'You don’t own that.' };
      const value = gear.saleValue(item, conditions.get(item.id));
      if (!players.removeItem(fresh.id, item.id)) return { error: 'You don’t own that.' };
      fresh.cash += value;
      players.save(fresh, { reason: 'armory-sale', ref: item.id });
      players.log(fresh.id, 'system', `Sold the ${item.name} for $${value.toLocaleString('en-US')}.`);
      return { item, value };
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `${outcome.item.name} sold for $${outcome.value.toLocaleString('en-US')}.`);
    toInventory(res, outcome.item && outcome.item.slot);
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

  // ----- Motor pool: vehicles (src/vehicles.js) -----
  if (vehicleService) {
    const pool = (res, id) => res.redirect(`/armory/motor-pool${id ? `#veh-${id}` : ''}`);
    const done = (req, res, out, ok, id) => {
      req.flash(out.error ? 'error' : 'success', out.error || ok(out));
      pool(res, out.error ? null : id);
    };

    router.get('/armory/motor-pool', requireAuth, (req, res) => {
      const classes = vehicleService.garage(req.player);
      const mine = classes.flatMap((c) => c.vehicles).filter((v) => v.owned);
      const a = vehicleService.assigned(req.player.id);
      res.render('motor-pool', {
        title: 'Motor pool',
        nav: 'armory',
        shops: SHOPS,
        active: 'motor-pool',
        classes,
        mine,
        cash: req.player.cash,
        assigned: a ? { ...a.vehicle, cls: vehicles.CLASSES_BY_ID.get(a.vehicle.cls), condition: a.condition, bonusText: vehicles.describe(vehicles.bonusesOf(a.vehicle, a.condition)) } : null,
        repairAll: mine.reduce((n, v) => n + v.repairCost, 0),
        fullPowerAt: gear.FULL_POWER_AT,
      });
    });

    router.post('/armory/motor-pool/buy/:id', requireAuth, (req, res) => {
      const id = String(req.params.id);
      done(req, res, vehicleService.buy(req.player.id, id), (o) => `${o.vehicle.name} bought${o.assigned ? ' and taken out' : '. Take it out when you want to use it'}.`, id);
    });
    router.post('/armory/motor-pool/assign/:id', requireAuth, (req, res) => {
      const id = String(req.params.id);
      done(req, res, vehicleService.assign(req.player.id, id), (o) => `You’re taking the ${o.vehicle.name} out.`, id);
    });
    router.post('/armory/motor-pool/park', requireAuth, (req, res) => {
      done(req, res, vehicleService.park(req.player.id), (o) => `${o.vehicle.name} left in the motor pool.`, null);
    });
    router.post('/armory/motor-pool/repair/:id', requireAuth, (req, res) => {
      const id = String(req.params.id);
      done(req, res, vehicleService.repair(req.player.id, id), (o) => `${o.jobs.length === 1 ? o.jobs[0].vehicle.name : `${o.jobs.length} vehicles`} repaired to 100% for $${o.cost.toLocaleString('en-US')}.`, id === 'all' ? null : id);
    });
    router.post('/armory/motor-pool/sell/:id', requireAuth, (req, res) => {
      done(req, res, vehicleService.sell(req.player.id, String(req.params.id)), (o) => `${o.vehicle.name} sold for $${o.value.toLocaleString('en-US')}.`, null);
    });
  }

  return router;
}

module.exports = { armoryRoutes };
