'use strict';

const express = require('express');
const admin = require('../admin');
const game = require('../game');
const presence = require('../presence');
const { loadoutView } = require('../armory');
const { createRequireAuth } = require('../require-auth');

const PAGE_SIZE = 25;
const { RULES, SEVERITY } = require('../anticheat/rules');
const DEFAULT_WARNING = 'HQ has noticed activity on your account that may break the rules of engagement (one account per player, no farming other players). Further activity may lead to suspension.';

function adminRoutes(players, adminRepo, anti) {
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
      openFlags: anti.openFlagCount(),
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
      rating: loadoutView(t.level, players.equipment(t.id), t).rating,
      trainingPoints: require('../training').pointsOf(t),
      maxLevel: admin.MAX_LEVEL,
      isSelf: t.id === req.player.id,
      fmt: (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
      ago: (ms) => presence.timeAgo(ms, now),
      history: adminRepo.actionsFor(t.id).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
      links: anti.linkedAccounts(t.id, now).map((l) => ({ ...l, ago: presence.timeAgo(l.last_at, now) })),
      signIns: anti.signInsFor(t.id).map((s) => ({ ...s, ago: presence.timeAgo(s.created_at, now) })),
      ledger: anti.ledgerFor(t.id).map((l) => ({ ...l, ago: presence.timeAgo(l.created_at, now) })),
      flags: anti.flagsForUser(t.id),
      activity: anti.activityProfile(t.id, now),
      RULES, SEVERITY,
    });
  });

  /** Runs a pure admin change inside a transaction, saves it and records it. */
  function applyChange(action, change) {
    return (req, res) => {
      const outcome = players.transaction(() => {
        const fresh = players.findById(req.target.id);
        const out = change(game.applyRegen(fresh, Date.now()), req.body);
        if (out.error) return out;
        players.save(out.player, { reason: `admin-${action}`, ref: `admin:${req.player.id}` });
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

  // ---- Anti-cheat review queue ----
  const loadFlag = (req, res, next) => {
    const id = Number(req.params.id);
    const flag = Number.isInteger(id) ? anti.getFlag(id) : null;
    if (!flag) return next('router');
    req.flag = flag;
    next();
  };
  const flagUser = (req) => {
    const id = Number(req.body.userId);
    return req.flag.userIdList.includes(id) ? players.findById(id) : null;
  };
  const resolve = (req, status, resolution) => {
    anti.resolveFlag(req.flag.id, req.player.id, status, resolution);
    adminRepo.log(req.player.id, req.flag.userIdList[0] || null, `flag-${status}`, `Flag #${req.flag.id} (${RULES[req.flag.rule] || req.flag.rule}): ${resolution}`);
  };

  router.get('/admin/flags', (req, res) => {
    const now = Date.now();
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.render('admin/flags', {
      title: 'Admin · Suspicious activity',
      nav: 'admin',
      status,
      flags: anti.listFlags(status).map((f) => ({ ...f, ago: presence.timeAgo(f.updated_at, now) })),
      openFlags: anti.openFlagCount(),
      RULES, SEVERITY,
    });
  });

  router.get('/admin/flags/:id', loadFlag, (req, res) => {
    const now = Date.now();
    const involved = req.flag.userIdList.map((id) => players.findById(id)).filter(Boolean).map((u) => ({
      ...u,
      links: anti.linkedAccounts(u.id, now),
      seen: presence.timeAgo(u.last_seen_at, now),
    }));
    const battleIds = req.flag.evidence.battleIds || [];
    res.render('admin/flag', {
      title: `Admin · Flag #${req.flag.id}`,
      nav: 'admin',
      f: req.flag,
      involved,
      battles: battleIds.map((id) => players.findBattle(id)).filter(Boolean).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at, now) })),
      ago: (ms) => presence.timeAgo(ms, now),
      defaultWarning: DEFAULT_WARNING,
      RULES, SEVERITY,
    });
  });

  const backToFlag = (req, res) => res.redirect(`/admin/flags/${req.flag.id}`);

  router.post('/admin/flags/:id/dismiss', loadFlag, (req, res) => {
    const note = admin.cleanReason(req.body.note) || 'No action needed';
    resolve(req, 'dismissed', note);
    req.flash('success', `Flag #${req.flag.id} dismissed.`);
    backToFlag(req, res);
  });

  router.post('/admin/flags/:id/warn', loadFlag, (req, res) => {
    const target = flagUser(req);
    if (!target) {
      req.flash('error', 'Pick a player involved in this flag.');
      return backToFlag(req, res);
    }
    const message = String(req.body.message || '').trim().slice(0, 300) || DEFAULT_WARNING;
    players.notify(target.id, 'system', `Warning from HQ: ${message}`);
    resolve(req, 'actioned', `Warned ${target.username}.`);
    req.flash('success', `${target.username} has been warned.`);
    backToFlag(req, res);
  });

  router.post('/admin/flags/:id/reverse', loadFlag, (req, res) => {
    if (req.flag.rule !== 'pvp-farming') {
      req.flash('error', 'Only PvP farming flags can be reversed.');
      return backToFlag(req, res);
    }
    const { reversed, total } = players.transaction(() => anti.reverseBattles(req.flag.evidence.battleIds || []));
    resolve(req, 'actioned', `Reversed ${reversed} battle(s), returning $${total} to ${req.flag.evidence.defender.name}.`);
    req.flash('success', `Returned $${total} from ${reversed} battle(s) to ${req.flag.evidence.defender.name}.`);
    backToFlag(req, res);
  });

  router.post('/admin/flags/:id/suspend', loadFlag, (req, res) => {
    const target = flagUser(req);
    const reason = admin.cleanReason(req.body.reason);
    if (!target) req.flash('error', 'Pick a player involved in this flag.');
    else if (target.is_admin) req.flash('error', 'Admins can’t be suspended from here.');
    else if (!reason) req.flash('error', 'Give a reason. The player sees it when they try to sign in.');
    else {
      adminRepo.ban(target.id, reason);
      adminRepo.log(req.player.id, target.id, 'ban', `Suspended. Reason: ${reason}`);
      resolve(req, 'actioned', `Suspended ${target.username}: ${reason}`);
      req.flash('success', `${target.username} is suspended and has been signed out.`);
    }
    backToFlag(req, res);
  });

  router.post('/admin/anticheat/scan', (req, res) => {
    const r = anti.runScan();
    adminRepo.log(req.player.id, null, 'scan', `Ran anti-cheat checks: ${r.newFlags} new flag(s), ${r.openFlags} open.`);
    req.flash('success', `Checks complete: ${r.newFlags} new flag(s), ${r.openFlags} open.`);
    res.redirect('/admin/flags');
  });

  return router;
}

module.exports = { adminRoutes };
