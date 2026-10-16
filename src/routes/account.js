'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { createFailureTracker } = require('../middleware');
const { passwordProblem } = require('./auth');
const { createRequireAuth } = require('../require-auth');

const MAX_BIO = 2000; // BBCode source, tags included

function accountRoutes(players, medalService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  // Guessing the current password from a hijacked session gets throttled too.
  const failures = createFailureTracker({ windowMs: 15 * 60 * 1000, max: 5 });

  const render = (req, res, status, errors = {}) =>
    res.status(status).render('account-password', {
      title: 'Change password',
      nav: null,
      forced: Boolean(req.player.must_change_password),
      errors,
    });

  router.get('/account/password', requireAuth, (req, res) => render(req, res, 200));

  router.post('/account/password', requireAuth, async (req, res, next) => {
    try {
      const current = String(req.body.current || '');
      const password = String(req.body.password || '');
      const confirm = String(req.body.confirm || '');
      const key = String(req.player.id);

      const locked = failures.lockedFor(key);
      if (locked) return render(req, res, 429, { current: `Too many wrong attempts. Try again in ${locked} min.` });
      if (!(await bcrypt.compare(current, req.player.password_hash))) {
        failures.fail(key);
        return render(req, res, 401, { current: 'That isn’t your current password.' });
      }
      failures.clear(key);

      const errors = {};
      const problem = passwordProblem(password);
      if (problem) errors.password = problem;
      else if (password === current) errors.password = 'Choose a password different from the current one.';
      if (password !== confirm) errors.confirm = 'Passwords do not match.';
      if (Object.keys(errors).length) return render(req, res, 422, errors);

      players.setPassword(req.player.id, await bcrypt.hash(password, 12));
      players.endSessions(req.player.id, req.sessionID); // sign out other devices
      req.flash('success', 'Password changed. Any other devices have been signed out.');
      res.redirect('/hq');
    } catch (err) {
      next(err);
    }
  });

  // Profile bio: free text with BBCode formatting, shown on the public profile.
  router.get('/account/profile', requireAuth, (req, res) => {
    const draft = req.session.bioDraft;
    delete req.session.bioDraft;
    medalService.checkTitles(req.player.id); // catch anything earned while away
    res.render('account-profile', {
      title: 'Edit profile', nav: 'profile', bio: draft === undefined ? req.player.bio : draft, maxBio: MAX_BIO,
      titles: medalService.titlesFor(req.player.id),
      currentTitle: players.findById(req.player.id).title || '',
    });
  });

  // Pick which earned title shows under your callsign (or none).
  router.post('/account/title', requireAuth, (req, res) => {
    const out = medalService.setTitle(req.player.id, String(req.body.title || ''));
    req.flash(out.error ? 'error' : 'success', out.error || (out.title ? `Your title is now “${out.title.name}”.` : 'Title removed.'));
    res.redirect('/account/profile#title');
  });

  router.post('/account/profile', requireAuth, (req, res) => {
    const bio = String(req.body.bio || '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (bio.length > MAX_BIO) {
      req.session.bioDraft = bio.slice(0, MAX_BIO * 2); // keep what they wrote
      req.flash('error', `Your bio is limited to ${MAX_BIO.toLocaleString('en-US')} characters (yours is ${bio.length.toLocaleString('en-US')}).`);
      return res.redirect('/account/profile');
    }
    players.setBio(req.player.id, bio);
    req.flash('success', bio ? 'Profile updated.' : 'Bio cleared.');
    res.redirect(`/profile/${encodeURIComponent(req.player.username)}#about`);
  });

  return router;
}

module.exports = { MAX_BIO, accountRoutes };
