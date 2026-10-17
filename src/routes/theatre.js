'use strict';

const express = require('express');
const { createRequireAuth } = require('../require-auth');
const theatre = require('../theatre');

/** The theatre of war map, and choosing a unit's weekly front. */
function theatreRoutes(players, unitRepo, theatreService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/theatre', requireAuth, (req, res) => {
    theatreService.settleDue();
    res.render('theatre', {
      title: 'Theatre of war',
      nav: 'unit',
      t: theatreService.view(req.player),
      rules: { points: theatre.POINT_LABELS.map(([key, label]) => ({ label, points: theatre.POINTS[key] })), holderPct: Math.round(theatre.HOLDER_BONUS * 100), minMembers: theatre.MIN_MEMBERS, cooldownHours: theatre.FRONT_COOLDOWN_MS / 3_600_000, maxXpPct: Math.round(theatre.MAX_XP_BONUS * 100) },
    });
  });

  router.post('/theatre/front', requireAuth, (req, res) => {
    const out = players.transaction(() => {
      const me = players.findById(req.player.id);
      const unit = me.unit_id ? unitRepo.findById(me.unit_id) : null;
      if (!unit) return { error: 'Join a unit to fight on the theatre of war.' };
      return theatreService.setFront({ unit, role: me.unit_role, me, regionId: req.body.region });
    });
    if (out.error) req.flash('error', out.error);
    else req.flash('success', `Front ${out.moved ? 'moved to' : 'opened in'} ${out.region.name}. Your unit’s play scores there until the week ends.`);
    res.redirect('/theatre#front');
  });

  return router;
}

module.exports = { theatreRoutes };
