'use strict';

const express = require('express');
const bank = require('../bank');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function bankRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const money = (n) => `$${n.toLocaleString('en-US')}`;

  router.get('/bank', requireAuth, (req, res) => {
    const now = Date.now();
    res.render('bank', {
      title: 'Bank',
      nav: 'bank',
      feePct: Math.round(bank.DEPOSIT_FEE * 100),
      history: players.bankHistory(req.player.id).map((t) => ({ ...t, ago: presence.timeAgo(t.created_at, now) })),
    });
  });

  router.post('/bank/deposit', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const out = bank.deposit(players.findById(req.player.id), req.body.amount);
      if (out.error) return out;
      players.save(out.player);
      players.logBankTransaction(req.player.id, { type: 'deposit', amount: out.credited, fee: out.fee, balanceAfter: out.player.bank_balance });
      return out;
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `Deposited ${money(outcome.amount)}. ${money(outcome.credited)} banked after the ${money(outcome.fee)} fee.`);
    res.redirect('/bank');
  });

  router.post('/bank/withdraw', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const out = bank.withdraw(players.findById(req.player.id), req.body.amount);
      if (out.error) return out;
      players.save(out.player);
      players.logBankTransaction(req.player.id, { type: 'withdraw', amount: out.amount, fee: 0, balanceAfter: out.player.bank_balance });
      return out;
    });
    if (outcome.error) req.flash('error', outcome.error);
    else req.flash('success', `Withdrew ${money(outcome.amount)}. Careful out there: cash on hand can be taken in a fight.`);
    res.redirect('/bank');
  });

  return router;
}

module.exports = { bankRoutes };
