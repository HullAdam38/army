'use strict';

const express = require('express');
const deployments = require('../deployments');
const game = require('../game');
const { createRequireAuth } = require('../require-auth');

function deploymentRoutes(players, deploymentService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/deployments', requireAuth, (req, res) => {
    const returned = deploymentService.completeDue(Date.now(), req.player.id);
    const now = Date.now();
    const me = game.applyRegen(players.findById(req.player.id), now);
    const used = deploymentService.hoursUsed(me.id, now);
    const mult = deploymentService.multipliers(me.level, now);
    const active = deploymentService.active(me.id);
    res.render('deployments', {
      title: 'Deployments',
      nav: null,
      // The header was built before completeDue ran; refresh it if someone just came back.
      player: returned.length ? game.playerView(me, now) : res.locals.player,
      cap: deployments.DAILY_CAP_HOURS,
      used: Math.round(used * 10) / 10,
      left: Math.max(0, Math.floor((deployments.DAILY_CAP_HOURS - used) * 10) / 10),
      boosted: mult.cashMult > 1 || mult.xpMult > 1,
      active: active ? { ...active, kind: deployments.KINDS_BY_ID.get(active.kind) } : null,
      kinds: deployments.KINDS.map((k) => ({
        ...k,
        reward: deployments.rewardFor(k, me.level, mult),
        blocker: deployments.deployBlocker(me, k, used, now),
      })),
      history: deploymentService.history(me.id).map((d) => ({ ...d, kind: deployments.KINDS_BY_ID.get(d.kind) })),
    });
  });

  router.post('/deployments/start/:kind', requireAuth, (req, res) => {
    const out = players.transaction(() => deploymentService.start(req.player.id, String(req.params.kind)));
    if (out.error) req.flash('error', out.error);
    else {
      players.log(req.player.id, 'info', `Deployed on a ${out.kind.name.toLowerCase()} (${out.kind.hours}h).`, '/deployments');
      req.flash('success', `Deployed: ${out.kind.name}. Back in ${out.kind.hours} hour${out.kind.hours === 1 ? '' : 's'}. You can close the game; pay arrives when your soldier returns.`);
    }
    res.redirect('/deployments');
  });

  router.post('/deployments/recall', requireAuth, (req, res) => {
    const out = players.transaction(() => deploymentService.recall(req.player.id));
    req.flash(out.error ? 'error' : 'success', out.error || `Recalled from the ${out.kind.name.toLowerCase()}. Recalled deployments pay nothing.`);
    res.redirect('/deployments');
  });

  return router;
}

module.exports = { deploymentRoutes };
