'use strict';

const express = require('express');
const contracts = require('../contracts');
const presence = require('../presence');
const tuning = require('../tuning');
const { createRequireAuth } = require('../require-auth');

const ACTIONS = ['accept', 'decline', 'cancel', 'abandon'];
const hoursLeft = (ms) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60000)}m` : `${Math.max(1, Math.ceil(ms / 60000))}m`);

/** The contracts board: post, take and track mercenary work. */
function contractRoutes(players, contractService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/contracts', requireAuth, (req, res) => {
    contractService.expireDue();
    const now = Date.now();
    const v = contractService.view(req.player, now);
    res.render('contracts', {
      title: 'Contracts',
      nav: 'players',
      ...v,
      meId: req.player.id,
      hoursLeft,
      ago: (ms) => presence.timeAgo(ms, now),
      form: {
        target: String(req.query.target || '').slice(0, 20),
        offer: String(req.query.offer || '').slice(0, 20),
        kind: req.query.offer && !req.query.target ? 'guard' : 'hit',
      },
      rules: { min: contracts.MIN_AMOUNT, max: contracts.MAX_AMOUNT, feePct: Math.round(tuning.get('contractFeeRate') * 100), hours: contracts.HOURS, openDays: contracts.OPEN_DAYS, maxPosted: contracts.MAX_POSTED, maxJobs: contracts.MAX_JOBS, kinds: contracts.KINDS },
    });
  });

  router.post('/contracts', requireAuth, (req, res) => {
    const out = contractService.post(req.player.id, req.body, { targetName: String(req.body.target || '').trim(), offerName: String(req.body.offer || '').trim() });
    if (out.error) req.flash('error', out.error);
    else req.flash('success', `Contract posted: ${out.text}, for $${out.terms.amount.toLocaleString('en-US')} (fee $${out.terms.fee.toLocaleString('en-US')}).${out.contract.offered_to ? ' The mercenary has been told.' : ` It stays on the board for ${contracts.OPEN_DAYS} days.`}`);
    res.redirect(out.error ? '/contracts#post' : `/contracts#c-${out.contract.id}`);
  });

  router.post('/contracts/:id/:action', requireAuth, (req, res, next) => {
    const action = String(req.params.action);
    const id = Number(req.params.id);
    if (!ACTIONS.includes(action) || !Number.isInteger(id)) return next();
    const out = contractService[action](req.player.id, id);
    const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;
    const ok = {
      accept: () => `Contract taken: ${out.text}. You have until ${new Date(out.deadline).toUTCString().slice(5, 22)} UTC.`,
      decline: () => 'Offer turned down.',
      cancel: () => `Contract withdrawn. ${money(out.refund)} is back in your cash (the fee isn’t refunded).`,
      abandon: () => 'You walked away from the job. It counts as a failed contract.',
    }[action];
    req.flash(out.error ? 'error' : 'success', out.error || ok());
    res.redirect(`/contracts${out.error ? '' : `#c-${id}`}`);
  });

  return router;
}

module.exports = { contractRoutes };
