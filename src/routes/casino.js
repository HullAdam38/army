'use strict';

const express = require('express');
const slots = require('../slots');
const game = require('../game');
const presence = require('../presence');
const { wantsJson } = require('../middleware');
const { createRequireAuth } = require('../require-auth');

// The games on the casino floor. `path` null means it isn't open yet.
const GAMES = [
  { id: 'slots', name: 'Slot machine', path: '/casino/slots', icon: 'i-star', blurb: 'Three reels, one line. Line up Stars, Crests and Cash for up to 100× your bet.' },
];

/** The casino: a lobby to pick a game, and the games themselves. All bets are in-game cash. */
function casinoRoutes(players, casino) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const symbolsById = Object.fromEntries(slots.SYMBOLS.map((s) => [s.id, s]));

  router.get('/casino', requireAuth, (req, res) => {
    const now = Date.now();
    res.render('casino', {
      title: 'Casino',
      nav: 'casino',
      games: GAMES.map((g) => ({ ...g, today: casino.today(req.player.id, g.id, now) })),
      blocker: casino.blocker(req.player),
    });
  });

  router.get('/casino/slots', requireAuth, (req, res) => {
    const now = Date.now();
    const last = req.session.lastSpin || null; // shown once after a spin without JavaScript
    delete req.session.lastSpin;
    const limits = casino.limits();
    res.render('casino-slots', {
      title: 'Slot machine',
      nav: 'casino',
      symbols: slots.SYMBOLS,
      symbolsById,
      paytable: slots.paytable(),
      rtp: slots.returnToPlayer(),
      limits,
      bet: Math.min(limits.maxBet, req.session.slotsBet || 100),
      chips: [10, 50, 100, 500, 1000, 5000].filter((c) => c <= limits.maxBet),
      last,
      line: last ? last.line : ['star', 'crest', 'cash'],
      today: casino.today(req.player.id, 'slots', now),
      recent: casino.recent(req.player.id, 'slots', 10).map((p) => ({ ...p, ago: presence.timeAgo(p.created_at, now) })),
      bigWins: casino.bigWins('slots', 8, now).map((p) => ({ ...p, ago: presence.timeAgo(p.created_at, now) })),
      blocker: casino.blocker(req.player),
    });
  });

  router.post('/casino/slots/spin', requireAuth, (req, res) => {
    const out = players.transaction(() => casino.spinSlots({ userId: req.player.id, bet: req.body.bet }));
    if (!out.error) req.session.slotsBet = out.bet; // keep the same bet for the next spin
    if (wantsJson(req)) {
      if (out.error) return res.status(400).json({ ok: false, error: out.error });
      return res.json({
        ok: true,
        line: out.line,
        mult: out.mult,
        bet: out.bet,
        payout: out.payout,
        net: out.net,
        text: out.text,
        big: out.mult >= slots.BIG_WIN,
        jackpot: out.kind === 'three' && out.line[0] === 'star',
        player: game.playerView(out.player),
        today: casino.today(req.player.id, 'slots'),
      });
    }
    if (out.error) req.flash('error', out.error);
    else req.session.lastSpin = { line: out.line, text: out.text, payout: out.payout, bet: out.bet, net: out.net, big: out.mult >= slots.BIG_WIN };
    res.redirect('/casino/slots#machine');
  });

  return router;
}

module.exports = { GAMES, casinoRoutes };
