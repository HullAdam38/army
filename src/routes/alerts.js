'use strict';

const express = require('express');
const { wantsJson } = require('../middleware');
const { createRequireAuth } = require('../require-auth');

/** The App & alerts page: install the app, and push notification settings. */
function alertRoutes(players, push) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }));

  router.get('/account/alerts', requireAuth, (req, res) => {
    const prefs = push.prefs(req.player.id);
    res.render('account-alerts', {
      title: 'App & alerts',
      nav: 'alerts',
      publicKey: push.publicKey(),
      categories: push.categories,
      prefs,
      hours,
      devices: push.devices(req.player.id),
    });
  });

  // Alert categories and quiet hours (a normal form, so it works without JavaScript).
  router.post('/account/alerts', requireAuth, (req, res) => {
    const pick = req.body.categories;
    push.setPrefs(req.player.id, {
      categories: Array.isArray(pick) ? pick : pick ? [pick] : [],
      quietFrom: req.body.quiet === 'on' ? req.body.quietFrom : null,
      quietTo: req.body.quiet === 'on' ? req.body.quietTo : null,
      tz: req.body.tz,
    });
    req.flash('success', 'Alert settings saved.');
    res.redirect('/account/alerts#settings');
  });

  // The browser hands over its push subscription (JSON, sent by app.js with the CSRF header).
  router.post('/push/subscribe', requireAuth, (req, res) => {
    const out = push.subscribe(req.player.id, req.body && req.body.subscription, req.get('user-agent'));
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    if (req.body.tz) {
      const prefs = push.prefs(req.player.id);
      push.setPrefs(req.player.id, { ...prefs, tz: req.body.tz });
    }
    res.json({ ok: true, device: out.device });
  });

  router.post('/push/unsubscribe', requireAuth, (req, res) => {
    const removed = push.unsubscribe(req.player.id, req.body && req.body.endpoint);
    res.json({ ok: true, removed });
  });

  router.post('/account/alerts/devices/:id/delete', requireAuth, (req, res) => {
    req.flash(push.removeDevice(req.player.id, req.params.id) ? 'success' : 'info', 'Alerts turned off for that device.');
    res.redirect('/account/alerts#devices');
  });

  router.post('/account/alerts/test', requireAuth, async (req, res, next) => {
    try {
      const n = await push.test(req.player.id);
      const message = n ? `Test alert sent to ${n} device${n === 1 ? '' : 's'}. It can take a few seconds to arrive.` : 'No device received it. Turn alerts on for this device first, or check the list below.';
      if (wantsJson(req)) return res.json({ ok: n > 0, message });
      req.flash(n ? 'success' : 'error', message);
      res.redirect('/account/alerts#devices');
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * The service worker reports a replaced subscription. It can't send a CSRF
 * token, so this runs before the CSRF check: knowing the old endpoint (a
 * secret address only that browser and this server have) proves it's the
 * same device. JSON only, so other sites can't send it from a form.
 */
function pushRenewRoute(push) {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/push/renew') return next();
    if (!req.is('application/json')) return res.sendStatus(415);
    const ok = push.renew(req.body && req.body.old, req.body && req.body.subscription);
    res.status(ok ? 200 : 404).json({ ok });
  };
}

module.exports = { alertRoutes, pushRenewRoute };
