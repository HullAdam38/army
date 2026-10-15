'use strict';

const express = require('express');
const bounties = require('../bounties');
const game = require('../game');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function bountyRoutes(players, bountyService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/bounties', requireAuth, (req, res) => {
    bountyService.expireDue();
    const now = Date.now();
    res.render('bounties', {
      title: 'Bounties',
      nav: 'players',
      wanted: bountyService.wanted(now).map((w) => {
        const rank = game.rankFor(w.level);
        return {
          ...w,
          grade: rank.grade,
          rank: rank.name,
          online: presence.isOnline(w, now),
          hospitalized: Boolean(w.hospital_until && w.hospital_until > now),
          isYou: w.id === req.player.id,
        };
      }),
      claims: bountyService.recentClaims(8).map((c) => ({ ...c, ago: presence.timeAgo(c.settled_at, now) })),
      mine: bountyService.placedBy(req.player.id).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at, now) })),
      onYou: bountyService.onTarget(req.player.id, now),
      form: { target: String(req.query.target || '').slice(0, 20) },
      rules: { min: bounties.MIN_BOUNTY, feePct: Math.round(bounties.FEE_RATE * 100), days: bounties.DURATION_MS / 86_400_000, maxOpen: bounties.MAX_OPEN_PER_PLACER },
    });
  });

  router.post('/bounties', requireAuth, (req, res) => {
    const name = String(req.body.target || '').trim();
    const target = name ? players.findByUsername(name) : null;
    const back = req.body.back === 'profile' && target ? `/profile/${encodeURIComponent(target.username)}#bounty` : '/bounties';
    if (!target) {
      req.flash('error', name ? `No soldier called ${name}.` : 'Enter the callsign of the soldier you want hunted.');
      return res.redirect('/bounties');
    }
    const out = players.transaction(() => bountyService.place({
      placerId: req.player.id,
      target,
      amountInput: req.body.amount,
      anonymous: req.body.anonymous === 'on',
    }));
    req.flash(
      out.error ? 'error' : 'success',
      out.error || `Bounty posted: $${out.amount.toLocaleString('en-US')} on ${target.username} (fee $${out.fee.toLocaleString('en-US')}). It lasts 7 days.`,
    );
    res.redirect(back);
  });

  return router;
}

module.exports = { bountyRoutes };
