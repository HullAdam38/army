'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { createFailureTracker } = require('../middleware');
const { passwordProblem } = require('./auth');
const { createRequireAuth } = require('../require-auth');

function accountRoutes(players) {
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

  return router;
}

module.exports = { accountRoutes };
