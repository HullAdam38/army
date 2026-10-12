'use strict';

const express = require('express');
const { createRequireAuth } = require('../require-auth');

const BACK = '/hq#daily-title';

function dailyRoutes(players, daily) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.post('/daily/orders/:slot/claim', requireAuth, (req, res) => {
    const slot = Number(req.params.slot);
    const out = Number.isInteger(slot)
      ? players.transaction(() => daily.claimOrder(req.player, slot))
      : { error: 'No such order today.' };
    if (out.error) {
      req.flash('error', out.error);
    } else {
      res.locals.gains = { xp: out.order.reward_xp, cash: out.order.reward_cash }; // for anti-cheat
      req.flash('success', `Order complete: ${out.order.text}. +${out.order.reward_xp} XP, +$${out.order.reward_cash.toLocaleString('en-US')}.`);
    }
    res.redirect(BACK);
  });

  router.post('/daily/bonus/claim', requireAuth, (req, res) => {
    const out = players.transaction(() => daily.claimBonus(req.player));
    if (out.error) {
      req.flash('error', out.error);
    } else {
      res.locals.gains = { xp: out.reward.xp, cash: out.reward.cash };
      req.flash('success', `Commendation awarded for completing all of today’s orders. +${out.reward.xp} XP, +$${out.reward.cash.toLocaleString('en-US')}.`);
    }
    res.redirect(BACK);
  });

  router.post('/daily/supply/claim', requireAuth, (req, res) => {
    const out = players.transaction(() => daily.claimSupplyDrop(req.player));
    if (out.error) {
      req.flash('error', out.error);
    } else {
      res.locals.gains = { cash: out.cash };
      const extra = out.refillEnergy ? ' Energy fully restored.' : '';
      const broken = out.broken ? ' Your previous streak lapsed, so this starts a new one.' : '';
      req.flash('success', `Supply drop received: +$${out.cash.toLocaleString('en-US')}.${extra} Streak: ${out.streak} day${out.streak === 1 ? '' : 's'}.${broken}`);
    }
    res.redirect('/hq#supply-title');
  });

  return router;
}

module.exports = { dailyRoutes };
