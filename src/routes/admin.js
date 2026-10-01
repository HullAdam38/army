'use strict';

const express = require('express');
const admin = require('../admin');
const game = require('../game');
const presence = require('../presence');
const { loadoutView } = require('../armory');
const { createRequireAuth } = require('../require-auth');

const PAGE_SIZE = 25;

function adminRoutes(players, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  // Anyone who isn't a signed-in, unbanned admin gets the ordinary 404, so the
  // admin area doesn't advertise itself.
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('router');
    next();
  };
  router.use('/admin', adminOnly, requireAuth);

  const loadTarget = (req, res, next) => {
    const id = Number(req.params.id);
    const target = Number.isInteger(id) ? players.findById(id) : null;
    if (!target) return next('router');
    req.target = target;
    next();
  };
  const back = (res, target) => res.redirect(`/admin/players/${target.id}`);

  router.get('/admin', (req, res) => {
    const now = Date.now();
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    res.render('admin/index', {
      title: 'Admin',
      nav: 'admin',
      stats: adminRepo.stats({ now, dayStart, onlineSince: now - presence.ONLINE_WINDOW_MS }),
      actions: adminRepo.recentActions(15).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
      signups: adminRepo.searchUsers('', 8).rows.map((u) => ({ ...u, ago: presence.timeAgo(u.created_at, now) })),
    });
  });

  router.get('/admin/players', (req, res) => {
    const now = Date.now();
    const q = String(req.query.q || '').trim().slice(0, 254);
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const { rows, total } = adminRepo.searchUsers(q, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/players', {
      title: 'Admin · Players',
      nav: 'admin',
      q, page, total,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      rows: rows.map((u) => ({ ...u, seen: presence.timeAgo(u.last_seen_at, now) })),
    });
  });

  router.get('/admin/players/:id', loadTarget, (req, res) => {
    const now = Date.now();
    const t = game.applyRegen(req.target, now);
    res.render('admin/player', {
      title: `Admin · ${t.username}`,
      nav: 'admin',
      t,
      view: game.playerView(req.target, now),
      rank: game.rankFor(t.level),
      rating: loadoutView(t.level, players.equipment(t.id)).rating,
      maxLevel: admin.MAX_LEVEL,
      isSelf: t.id === req.player.id,
      fmt: (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
      ago: (ms) => presence.timeAgo(ms, now),
      history: adminRepo.actionsFor(t.id).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
    });
  });

  /** Runs a pure admin change inside a transaction, saves it and records it. */
  function applyChange(action, change) {
    return (req, res) => {
      const outcome = players.transaction(() => {
        const fresh = players.findById(req.target.id);
        const out = change(game.applyRegen(fresh, Date.now()), req.body);
        if (out.error) return out;
        players.save(out.player);
        adminRepo.log(req.player.id, fresh.id, action, out.summary);
        return out;
      });
      req.flash(outcome.error ? 'error' : 'success', outcome.error || outcome.summary);
      back(res, req.target);
    };
  }

  router.post('/admin/players/:id/cash', loadTarget, applyChange('cash', (p, b) => admin.adjustCash(p, b.amount, b.reason)));
  router.post('/admin/players/:id/level', loadTarget, applyChange('level', (p, b) => admin.setLevel(p, b.level, b.reason)));
  router.post('/admin/players/:id/restore', loadTarget, applyChange('restore', (p) => admin.restore(p)));

  router.post('/admin/players/:id/ban', loadTarget, (req, res) => {
    const reason = admin.cleanReason(req.body.reason);
    if (req.target.id === req.player.id) req.flash('error', 'You can’t ban yourself.');
    else if (req.target.is_admin) req.flash('error', 'Admins can’t be banned here. Revoke their admin rights on the server first.');
    else if (!reason) req.flash('error', 'Give a reason. The player sees it when they try to sign in.');
    else {
      adminRepo.ban(req.target.id, reason);
      adminRepo.log(req.player.id, req.target.id, 'ban', `Suspended. Reason: ${reason}`);
      req.flash('success', `${req.target.username} is suspended and has been signed out.`);
    }
    back(res, req.target);
  });

  router.post('/admin/players/:id/unban', loadTarget, (req, res) => {
    if (!req.target.banned_at) req.flash('error', `${req.target.username} isn’t suspended.`);
    else {
      adminRepo.unban(req.target.id);
      adminRepo.log(req.player.id, req.target.id, 'unban', 'Suspension lifted.');
      req.flash('success', `${req.target.username} can sign in again.`);
    }
    back(res, req.target);
  });

  router.post('/admin/players/:id/notify', loadTarget, (req, res) => {
    const message = String(req.body.message || '').trim().slice(0, 300);
    if (!message) req.flash('error', 'Write a message first.');
    else {
      players.notify(req.target.id, 'system', `Message from HQ: ${message}`);
      adminRepo.log(req.player.id, req.target.id, 'message', message);
      req.flash('success', `Message sent to ${req.target.username}.`);
    }
    back(res, req.target);
  });

  router.post('/admin/broadcast', (req, res) => {
    const message = String(req.body.message || '').trim().slice(0, 300);
    if (!message) req.flash('error', 'Write a message first.');
    else {
      const count = adminRepo.broadcast(`Announcement: ${message}`);
      adminRepo.log(req.player.id, null, 'broadcast', message);
      req.flash('success', `Announcement sent to ${count} ${count === 1 ? 'player' : 'players'}.`);
    }
    res.redirect('/admin');
  });

  return router;
}

module.exports = { adminRoutes };
