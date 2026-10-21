'use strict';

const game = require('./game');
const presence = require('./presence');
const { TERMS_VERSION } = require('./legal');

// Pages a player can reach before accepting new terms.
const TERMS_FREE = new Set(['/terms', '/terms/accept', '/logout', '/account/password']);
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
    if (user.banned_at) {
      // Suspended mid-session: end it immediately.
      return req.session.regenerate(() => {
        if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Account suspended.' });
        req.flash('error', `Your account has been suspended${user.ban_reason ? `: ${user.ban_reason}` : ''}.`);
        res.redirect('/login');
      });
    }
    if (user.must_change_password && req.path !== '/account/password') {
      if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Set a new password first.' });
      return res.redirect('/account/password');
    }
    if (user.terms_version !== TERMS_VERSION && !TERMS_FREE.has(req.path)) {
      if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Accept the updated Terms of Service first.' });
      if (req.method === 'GET') req.session.returnTo = req.originalUrl;
      return res.redirect('/terms/accept');
    }
    const now = Date.now();
    if (!user.last_seen_at || now - user.last_seen_at > presence.SEEN_THROTTLE_MS) {
      players.touchSeen(user.id, now);
      user.last_seen_at = now;
    }
    players.markActive(user.id, now);
    if (!req.path.endsWith('/poll')) players.trackPlay(user, now); // time played (admins only); background polls don't count
    req.player = user;
    res.locals.player = game.playerView(user);
    res.locals.isAdmin = Boolean(user.is_admin);
    res.locals.unreadCount = players.unreadCount(user.id);
    res.locals.unreadMessages = players.unreadMessageCount(user.id);
    res.locals.chatUnread = players.chatUnread(user);
    res.locals.latestNotificationId = players.latestNotificationId(user.id);
    next();
  };
}

module.exports = { createRequireAuth };
