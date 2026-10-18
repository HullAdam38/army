'use strict';

const express = require('express');
const slots = require('../slots');
const roulette = require('../roulette');
const game = require('../game');
const presence = require('../presence');
const { wantsJson } = require('../middleware');
const { createRequireAuth } = require('../require-auth');

// The games on the casino floor. `path` null means it isn't open yet.
const GAMES = [
  { id: 'slots', name: 'Slot machine', path: '/casino/slots', icon: 'i-star', blurb: 'Three reels, one line. Line up Stars, Crests and Cash for up to 100× your bet.' },
  { id: 'blackjack', name: 'Blackjack', path: '/casino/blackjack', icon: 'i-cash', blurb: 'Sit at a table with other players and beat the dealer to 21. Blackjack pays 3 to 2; double and split.' },
  { id: 'roulette', name: 'Roulette', path: '/casino/roulette', icon: 'i-target', blurb: 'A European wheel with one zero. Bet on numbers, colours, dozens and more; a single number pays 35 to 1.' },
];

/** The casino: a lobby to pick a game, and the games themselves. All bets are in-game cash. */
function casinoRoutes(players, casino, blackjack = null) {
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

  // ---- Roulette ----
  router.get('/casino/roulette', requireAuth, (req, res) => {
    const now = Date.now();
    const last = req.session.lastRoulette || null; // shown once after a spin without JavaScript
    delete req.session.lastRoulette;
    const recent = casino.recent(req.player.id, 'roulette', 12);
    res.render('casino-roulette', {
      title: 'Roulette',
      nav: 'casino',
      wheel: roulette.WHEEL,
      rows: roulette.ROWS,
      colorOf: roulette.colorOf,
      outside: roulette.OUTSIDE,
      limits: casino.rouletteLimits(),
      chips: [10, 50, 100, 500, 1000, 5000].filter((c) => c <= casino.rouletteLimits().maxBet),
      bet: Math.min(casino.rouletteLimits().maxBet, req.session.rouletteBet || 100),
      last,
      today: casino.today(req.player.id, 'roulette', now),
      recent: recent.map((p) => ({ ...p, ago: presence.timeAgo(p.created_at, now), color: roulette.colorOf(p.result.number) })),
      bigWins: casino.bigWins('roulette', 8, now).map((p) => ({ ...p, ago: presence.timeAgo(p.created_at, now), color: roulette.colorOf(p.result.number) })),
      blocker: casino.blocker(req.player),
    });
  });

  /** Bets from the form: `b-<spot>` fields (the table, with JavaScript), or one `spot` and `amount` (without). */
  const betsFrom = (body) => {
    const bets = Object.create(null); // field names come from the browser, so no prototype to tamper with
    for (const [k, v] of Object.entries(body || {})) if (k.startsWith('b-')) bets[k.slice(2)] = v;
    if (body && body.spot !== undefined) bets[String(body.spot)] = (Number(bets[String(body.spot)]) || 0) + (Number(String(body.amount || '').replace(/[$,\s]/g, '')) || 0);
    return bets;
  };

  router.post('/casino/roulette/spin', requireAuth, (req, res) => {
    const out = players.transaction(() => casino.spinRoulette({ userId: req.player.id, bets: betsFrom(req.body) }));
    if (!out.error && req.body.spot !== undefined) req.session.rouletteBet = Number(req.body.amount) || req.session.rouletteBet;
    if (wantsJson(req)) {
      if (out.error) return res.status(400).json({ ok: false, error: out.error });
      return res.json({
        ok: true,
        number: out.number,
        color: out.color,
        pocket: out.pocket,
        total: out.total,
        payout: out.payout,
        net: out.net,
        winners: out.winners,
        big: out.mult >= slots.BIG_WIN,
        player: game.playerView(out.player),
        today: casino.today(req.player.id, 'roulette'),
      });
    }
    if (out.error) req.flash('error', out.error);
    else req.session.lastRoulette = { number: out.number, color: out.color, total: out.total, payout: out.payout, net: out.net, winners: out.winners };
    res.redirect('/casino/roulette#wheel'); // land on the result
  });

  // ---- Blackjack (multiplayer) ----
  if (blackjack) {
    const tableHtml = (res, view) => new Promise((resolve, reject) => {
      res.render('partials/bj-table', { v: view }, (err, html) => (err ? reject(err) : resolve(html)));
    });
    /** The JSON a table page polls for and gets back after each action. */
    const tableJson = async (req, res, extra = {}) => {
      const view = blackjack.view(req.params.id, req.player.id);
      res.set('Cache-Control', 'no-store');
      if (req.query.v !== undefined && Number(req.query.v) === view.version && !extra.error) return res.json({ same: true, version: view.version, deadlineIn: view.deadlineIn });
      const fresh = view.you ? players.findById(req.player.id) : null;
      return res.json({ ok: !extra.error, ...extra, version: view.version, phase: view.phase, deadlineIn: view.deadlineIn, html: await tableHtml(res, view), player: fresh ? game.playerView(fresh) : null });
    };
    const loadTable = (req, res, next) => (blackjack.TABLES.some((t) => String(t.id) === req.params.id) ? next() : next('route'));

    router.get('/casino/blackjack', requireAuth, (req, res) => {
      res.render('casino-blackjack-lobby', {
        title: 'Blackjack',
        nav: 'casino',
        tables: blackjack.lobby(),
        mine: blackjack.tableOf(req.player.id),
        today: casino.today(req.player.id, 'blackjack'),
        blocker: casino.blocker(req.player),
      });
    });

    router.get('/casino/blackjack/:id', requireAuth, loadTable, (req, res) => {
      const view = blackjack.view(req.params.id, req.player.id);
      res.render('casino-blackjack', { title: `Blackjack · ${view.table.name}`, nav: 'casino', v: view, blocker: casino.blocker(req.player) });
    });

    router.get('/casino/blackjack/:id/state', requireAuth, loadTable, (req, res, next) => {
      tableJson(req, res).catch(next);
    });

    const tableAction = (fn) => [requireAuth, loadTable, (req, res, next) => {
      const out = players.transaction(() => fn(req));
      if (wantsJson(req)) return tableJson(req, res, out.error ? { error: out.error } : {}).catch(next);
      if (out.error) req.flash('error', out.error);
      res.redirect(`/casino/blackjack/${req.params.id}#table`);
    }];
    router.post('/casino/blackjack/:id/sit', ...tableAction((req) => blackjack.sit({ tableId: req.params.id, userId: req.player.id, seat: req.body.seat })));
    router.post('/casino/blackjack/:id/leave', ...tableAction((req) => blackjack.leave({ tableId: req.params.id, userId: req.player.id })));
    router.post('/casino/blackjack/:id/bet', ...tableAction((req) => blackjack.bet({ tableId: req.params.id, userId: req.player.id, amount: req.body.amount })));
    router.post('/casino/blackjack/:id/act', ...tableAction((req) => blackjack.act({ tableId: req.params.id, userId: req.player.id, action: String(req.body.action || ''), round: req.body.round })));
  }

  return router;
}

module.exports = { GAMES, casinoRoutes };
