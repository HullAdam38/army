'use strict';

const express = require('express');
const game = require('../game');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function notificationRoutes(players, push = null) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.get('/notifications', requireAuth, (req, res) => {
    const now = Date.now();
    const items = players.notifications(req.player.id).map((n) => ({ ...n, ago: presence.timeAgo(n.created_at, now) }));
    // Render with today's unread highlighted, then mark everything read.
    players.markNotificationsRead(req.player.id);
    res.locals.unreadCount = 0;
    res.render('notifications', { title: 'Notifications', nav: 'notifications', items });
  });

  /** Polled by the browser: new notifications since `after`, plus fresh stats for the stat bar. */
  router.get('/notifications/poll', requireAuth, (req, res) => {
    const after = Math.max(0, Math.floor(Number(req.query.after)) || 0);
    const items = players.notificationsAfter(req.player.id, after);
    // A visible game tab means they're playing: hold back push alerts meanwhile.
    if (push && req.query.visible === '1') push.markVisible(req.player.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      unread: res.locals.unreadCount,
      messages: res.locals.unreadMessages,
      chat: res.locals.chatUnread,
      latestId: items.length ? items.at(-1).id : after,
      items: items.map(({ id, kind, message, link }) => ({ id, kind, message, link })),
      player: game.playerView(req.player),
    });
  });

  return router;
}

module.exports = { notificationRoutes };
