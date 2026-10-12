'use strict';

const express = require('express');
const training = require('../training');
const game = require('../game');
const { loadoutView } = require('../armory');
const { createRequireAuth } = require('../require-auth');

function trainingRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/training', requireAuth, (req, res) => {
    const me = game.applyRegen(req.player, Date.now());
    res.render('training', {
      title: 'Training',
      nav: 'training',
      stats: Object.keys(training.STATS).map((key) => training.statView(me, key)),
      loadout: loadoutView(me.level, players.equipment(me.id), me),
      energyPerSession: training.ENERGY_PER_SESSION,
      perLevel: training.POINTS_PER_LEVEL,
      missions: game.MISSIONS.map((m) => ({ name: m.name, favours: training.STATS[m.favours].label, minLevel: m.minLevel })),
    });
  });

  router.post('/training/:stat', requireAuth, (req, res) => {
    const times = req.body.times === '5' ? 5 : 1;
    const outcome = players.transaction(() => {
      const fresh = game.applyRegen(players.findById(req.player.id), Date.now());
      const out = training.train(fresh, req.params.stat, times);
      if (out.error) return out;
      players.save(out.player, { reason: 'training', ref: req.params.stat });
      return out;
    });
    if (outcome.error) {
      req.flash('error', outcome.error);
    } else {
      const def = training.STATS[req.params.stat];
      const now = outcome.player[def.column];
      const short = outcome.sessions < times ? ` (stopped after ${outcome.sessions}: out of energy, cash or room to grow)` : '';
      req.flash('success', `${def.label} +${outcome.sessions}, now ${now}. Cost $${outcome.cash} and ${outcome.energy} energy${short}.`);
    }
    res.redirect(`/training#stat-${req.params.stat}`);
  });

  return router;
}

module.exports = { trainingRoutes };
