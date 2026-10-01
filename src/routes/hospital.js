'use strict';

const express = require('express');
const game = require('../game');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function hospitalRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/hospital', requireAuth, (req, res) => {
    const now = Date.now();
    const patients = players.hospitalPatients(now).map((p) => {
      const rank = game.rankFor(p.level);
      return {
        username: p.username,
        level: p.level,
        grade: rank.grade,
        rank: rank.name,
        reason: p.hospital_reason,
        until: p.hospital_until,
        minutesLeft: Math.ceil((p.hospital_until - now) / 60000),
        isYou: p.username === req.player.username,
      };
    });
    res.render('hospital', { title: 'Hospital', nav: 'hospital', patients, timeAgo: presence.timeAgo });
  });

  // Pay to heal while not admitted.
  router.post('/hospital', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const out = game.visitHospital(players.findById(req.player.id));
      if (out.error) return out;
      players.save(out.player);
      players.log(req.player.id, 'system', `Treated at the field hospital for $${out.cost}.`);
      return out;
    });
    req.flash(outcome.error ? 'error' : 'success', outcome.error || `Patched up for $${outcome.cost}. Back to full strength.`);
    res.redirect('/hospital');
  });

  // Pay to leave early after being knocked out.
  router.post('/hospital/discharge', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const out = game.dischargeEarly(players.findById(req.player.id));
      if (out.error) return out;
      players.save(out.player);
      players.log(req.player.id, 'system', `Paid $${out.cost} for early discharge from hospital.`);
      return out;
    });
    req.flash(outcome.error ? 'error' : 'success', outcome.error || `Discharged for $${outcome.cost}. Get back out there.`);
    res.redirect('/hospital');
  });

  return router;
}

module.exports = { hospitalRoutes };
