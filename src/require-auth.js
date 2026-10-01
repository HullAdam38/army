'use strict';

const game = require('./game');
const presence = require('./presence');
const { wantsJson } = require('./middleware');

/** Loads the signed-in player onto req.player, or sends them to sign in. */
function createRequireAuth(players) {
  return function requireAuth(req, res, next) {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user) {
      if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Signed out.' });
      if (req.method === 'GET') req.session.returnTo = req.originalUrl;
      req.flash('info', 'Sign in to report for duty.');
      return res.redirect('/login');
    }
    const now = Date.now();
    if (!user.last_seen_at || now - user.last_seen_at > presence.SEEN_THROTTLE_MS) {
      players.touchSeen(user.id, now);
      user.last_seen_at = now;
    }
    req.player = user;
    res.locals.player = game.playerView(user);
    res.locals.unreadCount = players.unreadCount(user.id);
    res.locals.latestNotificationId = players.latestNotificationId(user.id);
    next();
  };
}

module.exports = { createRequireAuth };
