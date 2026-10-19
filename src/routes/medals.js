'use strict';

const express = require('express');
const medals = require('../medals');
const supporter = require('../supporter');

/** Supporters pin six medals; everyone else three. */
const maxPins = (player) => (supporter.isActive(player) ? supporter.SUPPORTER_PINS : medals.MAX_PINNED);
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function medalRoutes(players, medalService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/medals', requireAuth, (req, res) => {
    medalService.check(req.player.id); // catches anything earned while away (e.g. defending, war wins)
    const now = Date.now();
    const rarity = medalService.rarity();
    const list = medalService.caseFor(req.player.id).map((m) => ({
      ...m,
      tiers: medals.TIERS.map((t, i) => ({
        ...t,
        threshold: m.thresholds[i],
        earned: m.tier >= t.tier,
        rarity: rarity.get(`${m.id}:${t.tier}`) || 0,
      })),
    }));
    const earned = list.reduce((n, m) => n + m.tier, 0);
    res.render('medals', {
      title: 'Medals',
      nav: 'profile',
      list,
      earned,
      possible: medals.MEDALS.length * medals.TIERS.length,
      maxPinned: maxPins(req.player),
      tiers: medals.TIERS,
      recent: medalService.history(req.player.id, 6).map((h) => {
        const medal = medals.MEDALS_BY_ID.get(h.medal_id);
        return { name: medal ? medal.name : h.medal_id, tier: medals.TIERS[h.tier - 1], ago: presence.timeAgo(h.awarded_at, now) };
      }),
    });
  });

  router.post('/medals/pins', requireAuth, (req, res) => {
    const wanted = req.body.pin === undefined ? [] : req.body.pin;
    const asked = (Array.isArray(wanted) ? wanted : [wanted]).length;
    const max = maxPins(req.player);
    const pins = medalService.setPins(req.player.id, wanted, max);
    req.flash(
      asked > max ? 'error' : 'success',
      asked > max
        ? `You can pin up to ${max} medals${max === medals.MAX_PINNED ? ' (Supporters can pin six)' : ''}. Kept the first ${pins.length}.`
        : pins.length ? `Pinned ${pins.length} medal${pins.length === 1 ? '' : 's'} to your profile.` : 'No medals pinned. Your profile shows your highest medals.',
    );
    res.redirect('/medals');
  });

  return router;
}

module.exports = { medalRoutes };
