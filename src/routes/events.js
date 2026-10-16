'use strict';

const express = require('express');
const events = require('../events');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

function eventRoutes(players, eventService, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  // Non-admins get the ordinary 404, like the rest of the admin area.
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  router.get('/events', requireAuth, (req, res) => {
    const now = Date.now();
    res.render('events', {
      title: 'Events',
      nav: 'events',
      live: eventService.live(now),
      upcoming: eventService.upcoming(now, 10),
      recent: eventService.recent(now, 6).map((e) => ({ ...e, ago: presence.timeAgo(e.ends_at, now) })),
      types: events.TYPES,
    });
  });

  router.get('/admin/events', adminOnly, requireAuth, (req, res) => {
    const now = Date.now();
    const draft = req.session.eventDraft || {};
    delete req.session.eventDraft;
    res.render('admin/events', {
      title: 'Admin · Events',
      nav: 'admin',
      list: eventService.all(now, 50),
      types: events.TYPES,
      draft,
      limits: { minHours: events.MIN_HOURS, maxHours: events.MAX_HOURS, title: events.MAX_TITLE, message: events.MAX_MESSAGE },
      nowUtc: new Date(now).toISOString().slice(0, 16),
      fmt: (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    });
  });

  router.post('/admin/events', adminOnly, requireAuth, (req, res) => {
    const input = {
      type: String(req.body.type || ''),
      title: req.body.title,
      message: req.body.message,
      start: req.body.start === 'later' ? 'later' : 'now',
      startAt: req.body.startAt,
      hours: req.body.hours,
    };
    const out = eventService.create(input, req.player.id);
    if (out.error) {
      req.session.eventDraft = {
        ...input,
        title: String(input.title || '').slice(0, events.MAX_TITLE),
        message: String(input.message || '').slice(0, events.MAX_MESSAGE),
      };
      req.flash('error', out.error);
      return res.redirect('/admin/events');
    }
    const startsNow = out.startsAt <= Date.now() + 1000;
    if (startsNow) eventService.announce();
    adminRepo.log(req.player.id, null, 'event', `${out.title} (${out.type}) ${new Date(out.startsAt).toISOString()} → ${new Date(out.endsAt).toISOString()}`);
    req.flash('success', startsNow ? `${out.title} is live and everyone has been notified.` : `${out.title} is scheduled. Players are notified when it starts.`);
    res.redirect('/admin/events');
  });

  router.post('/admin/events/:id/:action', adminOnly, requireAuth, (req, res, next) => {
    if (!['cancel', 'end'].includes(req.params.action)) return next();
    const e = eventService.byId(Number(req.params.id));
    if (!e) return next();
    const done = req.params.action === 'cancel' ? eventService.cancel(e.id) : eventService.endNow(e.id);
    if (done) {
      adminRepo.log(req.player.id, null, `event-${req.params.action}`, `${e.title} (${e.type})`);
      req.flash('success', req.params.action === 'cancel' ? `${e.title} cancelled.` : `${e.title} ended.`);
    } else {
      req.flash('error', 'That event can’t be changed any more.');
    }
    res.redirect('/admin/events');
  });

  return router;
}

module.exports = { eventRoutes };
