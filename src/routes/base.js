'use strict';

const express = require('express');
const base = require('../base');
const game = require('../game');
const { createRequireAuth } = require('../require-auth');

function baseRoutes(players, baseService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/base', requireAuth, (req, res) => {
    baseService.completeDue(Date.now(), req.player.id);
    const now = Date.now();
    const me = game.applyRegen(players.findById(req.player.id), now);
    const building = me.base_build && me.base_build_until > now ? base.FACILITIES_BY_ID.get(me.base_build) : null;
    res.render('base', {
      title: 'Forward base',
      nav: null,
      unlocked: me.level >= base.UNLOCK_LEVEL,
      unlockLevel: base.UNLOCK_LEVEL,
      rating: base.baseRating(me),
      maxRating: base.maxRating,
      building: building ? {
        ...building,
        level: base.levelOf(me, building.id) + 1,
        until: me.base_build_until,
        refund: Math.floor((me.base_build_cost || 0) * base.REFUND_RATE),
      } : null,
      facilities: base.FACILITIES.map((f) => {
        const level = base.levelOf(me, f.id);
        const next = base.nextLevel(me, f.id);
        return {
          ...f,
          level,
          now: level ? f.effect(level) : 'not built yet',
          next: next ? { ...next, effect: f.effect(next.level) } : null,
          blocker: base.buildBlocker(me, f.id, now),
          isBuilding: Boolean(building && building.id === f.id),
        };
      }),
    });
  });

  router.post('/base/build/:id', requireAuth, (req, res) => {
    const out = players.transaction(() => baseService.start(req.player.id, String(req.params.id)));
    req.flash(out.error ? 'error' : 'success', out.error
      || `Construction started: ${out.facility.name} level ${out.next.level}. Ready in ${out.next.hours} hour${out.next.hours === 1 ? '' : 's'}.`);
    res.redirect('/base');
  });

  router.post('/base/cancel', requireAuth, (req, res) => {
    const out = players.transaction(() => baseService.cancel(req.player.id));
    req.flash(out.error ? 'error' : 'success', out.error || `${out.facility.name} construction cancelled. $${out.refund.toLocaleString('en-US')} refunded.`);
    res.redirect('/base');
  });

  return router;
}

module.exports = { baseRoutes };
