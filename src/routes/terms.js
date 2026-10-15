'use strict';

const express = require('express');
const { TERMS_VERSION } = require('../legal');
const { safeRedirectPath } = require('../middleware');
const { createRequireAuth } = require('../require-auth');

function termsRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  // Public: anyone can read the terms, signed in or not.
  router.get('/terms', (req, res) => {
    res.render('terms', { title: 'Terms of Service', nav: null, accept: false });
  });

  router.get('/terms/accept', requireAuth, (req, res) => {
    if (req.player.terms_version === TERMS_VERSION) return res.redirect('/hq');
    res.render('terms', { title: 'Terms of Service', nav: null, accept: true, firstTime: !req.player.terms_version });
  });

  router.post('/terms/accept', requireAuth, (req, res) => {
    if (req.body.agree !== 'on') {
      req.flash('error', 'Tick the box to accept the Terms of Service, or sign out.');
      return res.redirect('/terms/accept#accept');
    }
    players.acceptTerms(req.player.id, TERMS_VERSION);
    const returnTo = safeRedirectPath(req.session.returnTo, '/hq');
    delete req.session.returnTo;
    req.flash('success', 'Thanks, you’re cleared for duty.');
    res.redirect(returnTo.startsWith('/terms') ? '/hq' : returnTo);
  });

  return router;
}

module.exports = { termsRoutes };
