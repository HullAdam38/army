'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { createFailureTracker, rateLimit, safeRedirectPath } = require('../middleware');

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hash to compare against when the account doesn't exist, so timing doesn't leak usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function validateRegistration({ username, email, password, confirm, adult, terms }) {
  const errors = {};
  if (!USERNAME_RE.test(username)) errors.username = '3–20 characters: letters, numbers, _ or -.';
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Keep it under 72 characters.';
  if (password !== confirm) errors.confirm = 'Passwords do not match.';
  if (!adult) errors.adult = 'You must be 18 or older to enlist.';
  if (!terms) errors.terms = 'You must accept the rules of engagement.';
  return errors;
}

function authRoutes(players) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts. Stand down for a few minutes and try again.',
  });

  // Per-account lockout: 8 wrong passwords for one account in 15 minutes locks it
  // for the rest of that window, however many IPs the guesses come from.
  const failures = createFailureTracker({ windowMs: 15 * 60 * 1000, max: 8 });

  const guestOnly = (req, res, next) => (req.session.userId ? res.redirect('/hq') : next());

  function startSession(req, userId, done) {
    // Fresh session ID on login prevents session fixation. Carry over where the
    // player was heading, since regenerating wipes the old session.
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return done(err);
      req.session.userId = userId;
      players.touchLogin(userId);
      done(null, returnTo);
    });
  }

  router.get('/register', guestOnly, (req, res) => {
    res.render('register', { title: 'Enlist', values: {}, errors: {} });
  });

  router.post('/register', guestOnly, limiter, async (req, res, next) => {
    try {
      const values = {
        username: String(req.body.username || '').trim(),
        email: String(req.body.email || '').trim().toLowerCase(),
        password: String(req.body.password || ''),
        confirm: String(req.body.confirm || ''),
        adult: req.body.adult === 'on',
        terms: req.body.terms === 'on',
      };
      const errors = validateRegistration(values);
      if (!errors.username && !errors.email) {
        const taken = players.conflict(values.username, values.email);
        if (taken === 'username') errors.username = 'That callsign is already taken.';
        if (taken === 'email') errors.email = 'An account with that email already exists.';
      }
      if (Object.keys(errors).length) {
        const { password, confirm, ...safe } = values;
        return res.status(422).render('register', { title: 'Enlist', values: safe, errors });
      }

      const passwordHash = await bcrypt.hash(values.password, 12);
      let id;
      try {
        id = players.create({ username: values.username, email: values.email, passwordHash });
      } catch (err) {
        // Two sign-ups for the same name/email at once: the database's unique
        // constraint catches the loser of the race.
        if (!String(err.message).includes('UNIQUE')) throw err;
        const field = String(err.message).includes('email') ? 'email' : 'username';
        const { password, confirm, ...safe } = values;
        return res.status(422).render('register', {
          title: 'Enlist',
          values: safe,
          errors: { [field]: field === 'email' ? 'An account with that email already exists.' : 'That callsign is already taken.' },
        });
      }
      players.notify(id, 'system', 'Welcome to EliteForces. Run missions to earn XP and cash. PvP unlocks at level 3.', '/missions');
      startSession(req, id, (err) => {
        if (err) return next(err);
        req.flash('success', `Welcome aboard, ${values.username}. Your first orders are waiting.`);
        res.redirect('/hq');
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/login', guestOnly, (req, res) => {
    res.render('login', { title: 'Sign in', values: {}, error: null });
  });

  router.post('/login', guestOnly, limiter, async (req, res, next) => {
    try {
      const login = String(req.body.login || '').trim().slice(0, 254);
      const password = String(req.body.password || '');
      const key = login.toLowerCase();
      const fail = (status, error) => res.status(status).render('login', { title: 'Sign in', values: { login }, error });

      const lockedMins = failures.lockedFor(key);
      if (lockedMins) return fail(429, `Too many failed sign-ins for this account. Try again in ${lockedMins} min.`);

      const user = login ? players.findByLogin(login) : null;
      const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) {
        failures.fail(key);
        return fail(401, 'Callsign or password is incorrect.');
      }
      failures.clear(key);
      // Only reveal a suspension once the password is proven correct.
      if (user.banned_at) {
        return fail(403, `This account has been suspended${user.ban_reason ? `: ${user.ban_reason}` : ''}.`);
      }
      startSession(req, user.id, (err, returnTo) => {
        if (err) return next(err);
        res.redirect(safeRedirectPath(returnTo, '/hq'));
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    if (req.session.userId) players.signOut(req.session.userId);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ef.sid');
      res.redirect('/');
    });
  });

  return router;
}

module.exports = { authRoutes, validateRegistration };
