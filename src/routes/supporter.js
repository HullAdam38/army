'use strict';

const express = require('express');
const supporter = require('../supporter');
const { createRequireAuth } = require('../require-auth');

const when = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Where members manage their subscription: the store's billing page (they sign in with their email). */
function billingUrl(checkout) {
  try { return `https://${new URL(checkout).host}/billing`; } catch { return null; }
}

/** The Supporter page and the way to checkout. */
function supporterRoutes(players, service) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const checkout = () => process.env.SUPPORTER_CHECKOUT_URL || '';

  router.get('/supporter', requireAuth, (req, res) => {
    const me = service.status(req.player.id);
    const active = supporter.isActive(me);
    res.render('supporter', {
      title: 'Supporter membership',
      nav: 'supporter',
      perks: supporter.PERKS,
      price: process.env.SUPPORTER_PRICE || '',
      open: Boolean(checkout()),
      active,
      me: {
        status: me.supporter_status,
        source: me.supporter_source,
        until: active ? when(me.supporter_until) : null,
        since: me.supporter_since ? when(me.supporter_since) : null,
        cancelled: me.supporter_status === 'cancelled',
        pastDue: me.supporter_status === 'past_due',
      },
      manage: me.supporter_source === 'lemonsqueezy' ? billingUrl(checkout()) : null,
    });
  });

  // Off to the store's checkout, with the player's account filled in so the payment finds them.
  router.get('/supporter/join', requireAuth, (req, res) => {
    const url = supporter.checkoutUrl(checkout(), { id: req.player.id, email: req.player.email });
    if (!url) {
      req.flash('info', 'Supporter membership opens soon.');
      return res.redirect('/supporter');
    }
    res.redirect(303, url);
  });

  return router;
}

/**
 * Lemon Squeezy's webhook. Mounted before the body parsers, sessions and CSRF
 * checks: it needs the exact bytes to check the signature, and it's signed
 * rather than coming from a signed-in browser.
 */
function supporterWebhook(service) {
  const router = express.Router();
  router.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    const out = service.webhook(req.body, req.get('x-signature'), process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '');
    if (out.error) return res.status(out.status || 400).json({ ok: false, error: out.error });
    res.json({ ok: true });
  });
  return router;
}

module.exports = { billingUrl, supporterRoutes, supporterWebhook };
