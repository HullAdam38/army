'use strict';

const express = require('express');
const { ITEMS_BY_ID, SLOTS } = require('../items');
const { catalogueView, checkEquip, checkPurchase, loadoutView } = require('../armory');
const { createRequireAuth } = require('../require-auth');

function armoryRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const back = (res, slot) => res.redirect(slot ? `/armory#slot-${slot}` : '/armory');

  router.get('/armory', requireAuth, (req, res) => {
    const owned = players.ownedItemIds(req.player.id);
    const equipment = players.equipment(req.player.id);
    res.render('armory', {
      title: 'Armory',
      nav: 'armory',
      loadout: loadoutView(req.player.level, equipment),
      catalogue: catalogueView(req.player, owned, equipment),
    });
  });

  router.post('/armory/buy/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      const check = checkPurchase(req.params.id, fresh, players.ownedItemIds(fresh.id));
      if (check.error) return check;
      fresh.cash -= check.cost;
      players.save(fresh);
      players.addItem(fresh.id, check.item.id);
      players.equip(fresh.id, check.item.slot, check.item.id);
      players.log(fresh.id, 'system', `Bought the ${check.item.name} for $${check.cost.toLocaleString('en-US')}.`);
      return check;
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `${outcome.item.name} purchased and equipped.`);
    back(res, outcome.item && outcome.item.slot);
  });

  router.post('/armory/equip/:id', requireAuth, (req, res) => {
    const check = checkEquip(req.params.id, req.player, players.ownedItemIds(req.player.id));
    if (check.error) {
      req.flash('error', check.error);
      return back(res);
    }
    players.equip(req.player.id, check.item.slot, check.item.id);
    req.flash('success', `${check.item.name} equipped.`);
    back(res, check.item.slot);
  });

  router.post('/armory/unequip/:slot', requireAuth, (req, res) => {
    const slot = SLOTS.find((s) => s.id === req.params.slot);
    const current = slot && ITEMS_BY_ID.get(players.equipment(req.player.id)[slot.id]);
    if (!current) {
      req.flash('error', 'Nothing equipped there.');
      return back(res);
    }
    players.unequip(req.player.id, slot.id);
    req.flash('info', `${current.name} stowed.`);
    back(res, slot.id);
  });

  return router;
}

module.exports = { armoryRoutes };
