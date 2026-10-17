'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const admin = require('../admin');
const game = require('../game');
const presence = require('../presence');
const { loadoutView } = require('../armory');
const { createRequireAuth } = require('../require-auth');
const bbcode = require('../bbcode');
const { ITEMS, ITEMS_BY_ID, SLOTS } = require('../items');
const { EMAIL_RE, USERNAME_RE } = require('./auth');
const { announceLevels } = require('../notify');

const PAGE_SIZE = 25;
const timeLeft = (ms) => {
  const mins = Math.ceil(ms / 60000);
  return mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.ceil(mins / 60)}h` : `${Math.ceil(mins / 1440)}d`;
};
const { RULES, SEVERITY } = require('../anticheat/rules');
// Friendly names for ledger reasons on the economy page.
const REASON_LABELS = {
  mission: 'Missions', operation: 'Operations', pvp: 'PvP (cash taken)', deployment: 'Deployments', 'supply-drop': 'Supply drops',
  'season-reward': 'Season rewards', medal: 'Medal rewards', tutorial: 'Basic training rewards', 'unit-objective': 'Unit objectives',
  'target-bonus': 'High-value target', 'bounty-claim': 'Bounties collected', 'bounty-placed': 'Bounties posted', 'bounty-refund': 'Bounty refunds',
  armory: 'Armory (gear)', supplies: 'Armory (supplies)', training: 'Training', scout: 'Scouting', base: 'Forward base', 'base-refund': 'Forward base refunds',
  'hospital-treatment': 'Hospital treatment', 'hospital-discharge': 'Hospital discharge', 'unit-donation': 'Unit donations', 'unit-founded': 'Units founded',
  signup: 'Starting cash', 'bank-deposit': 'Bank deposits (fees)', 'bank-withdraw': 'Bank withdrawals', reversal: 'Anti-cheat reversals', 'daily-order': 'Daily orders', 'daily-bonus': 'Daily commendation',
};
const DEFAULT_WARNING = 'HQ has noticed activity on your account that may break the rules of engagement (one account per player, no farming other players). Further activity may lead to suspension.';

function adminRoutes(players, adminRepo, anti, messages, seasonService, chatService, avatarService, push = null, unitRepo = null) {
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
      openReports: messages.openReportCount(),
      openChatReports: chatService.openReportCount(),
      openAvatarReports: avatarService ? avatarService.openReportCount() : 0,
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
      bioHtml: bbcode.render(t.bio || ''),
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
      ...editorData(t, now),
    });
  });

  /** Inventory, unit, title and moderation state for the player editor. */
  function editorData(t, now) {
    const owned = players.ownedItemIds(t.id);
    const equipped = new Set(Object.values(players.equipment(t.id)));
    const unit = unitRepo && t.unit_id ? unitRepo.findById(t.unit_id) : null;
    const av = avatarService ? avatarService.findUser(t.id) : null;
    return {
      inventory: ITEMS.filter((i) => owned.has(i.id)).map((i) => ({ ...i, equipped: equipped.has(i.id) })),
      grantable: SLOTS.map((s) => ({ ...s, items: ITEMS.filter((i) => i.slot === s.id && !owned.has(i.id)) })).filter((s) => s.items.length),
      unit,
      titleName: t.title ? require('../titles').nameOf(t.title) : null,
      statCap: require('../training').statCap(t.level),
      muted: t.chat_muted_until && t.chat_muted_until > now ? { left: timeLeft(t.chat_muted_until - now), reason: t.chat_mute_reason } : null,
      avatar: av ? { url: `/avatars/${t.id}?v=${av.avatar_v || 0}`, kind: av.avatar_kind || 'starter', uploadsBlocked: Boolean(av.avatar_upload_blocked) } : null,
    };
  }

  /** Runs a pure admin change inside a transaction, saves it and records it. */
  function applyChange(action, change) {
    return (req, res) => {
      const outcome = players.transaction(() => {
        const fresh = players.findById(req.target.id);
        const out = change(game.applyRegen(fresh, Date.now()), req.body);
        if (out.error) return out;
        players.save(out.player, { reason: `admin-${action}`, ref: `admin:${req.player.id}` });
        adminRepo.log(req.player.id, fresh.id, action, out.summary);
        if (out.levelsGained && out.levelsGained.length) announceLevels(players, fresh.id, out.levelsGained);
        return out;
      });
      req.flash(outcome.error ? 'error' : 'success', outcome.error || outcome.summary);
      back(res, req.target);
    };
  }

  router.post('/admin/players/:id/cash', loadTarget, applyChange('cash', (p, b) => admin.adjustCash(p, b.amount, b.reason)));
  router.post('/admin/players/:id/level', loadTarget, applyChange('level', (p, b) => admin.setLevel(p, b.level, b.reason)));
  router.post('/admin/players/:id/restore', loadTarget, applyChange('restore', (p) => admin.restore(p)));
  router.post('/admin/players/:id/bank', loadTarget, applyChange('bank', (p, b) => admin.adjustBank(p, b.amount, b.reason)));
  router.post('/admin/players/:id/xp', loadTarget, applyChange('xp', (p, b) => admin.grantXp(p, b.amount, b.reason)));
  router.post('/admin/players/:id/stats', loadTarget, applyChange('stats', (p, b) => admin.setStats(p, b, b.reason)));

  // Callsign or email. Other admins' details can only be changed on the server.
  router.post('/admin/players/:id/identity', loadTarget, (req, res) => {
    const field = req.body.field === 'email' ? 'email' : 'username';
    const reason = admin.cleanReason(req.body.reason);
    const t = req.target;
    const v = admin.validateIdentity({ [field]: req.body.value }, { USERNAME_RE, EMAIL_RE });
    let error = v.error;
    if (!error && t.is_admin && t.id !== req.player.id) error = 'Another admin’s callsign and email can only be changed on the server.';
    if (!error && !reason) error = 'Give a reason; it goes in the audit log.';
    if (!error && v[field] === t[field]) error = `That’s already their ${field === 'email' ? 'email' : 'callsign'}.`;
    if (!error && !(field === 'email' ? adminRepo.setEmail(t.id, v.email) : adminRepo.setUsername(t.id, v.username))) {
      error = `Another account already uses that ${field === 'email' ? 'email' : 'callsign'}.`;
    }
    if (error) {
      req.flash('error', error);
    } else if (field === 'username') {
      adminRepo.log(req.player.id, t.id, 'rename', `Callsign ${t.username} → ${v.username}. Reason: ${reason}`);
      players.notify(t.id, 'system', `HQ changed your callsign from ${t.username} to ${v.username}: ${reason}`);
      req.flash('success', `${t.username} is now ${v.username}.`);
    } else {
      adminRepo.log(req.player.id, t.id, 'email', `Email changed (was ${t.email}). Reason: ${reason}`);
      req.flash('success', `${t.username}’s email is now ${v.email}.`);
    }
    back(res, t);
  });

  // Give or take a gear item.
  router.post('/admin/players/:id/items', loadTarget, (req, res) => {
    const item = ITEMS_BY_ID.get(String(req.body.item || ''));
    const reason = admin.cleanReason(req.body.reason);
    const owned = players.ownedItemIds(req.target.id);
    if (!item) req.flash('error', 'Pick an item.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else if (req.body.action === 'remove') {
      if (!adminRepo.removeItem(req.target.id, item.id)) req.flash('error', `${req.target.username} doesn’t own ${item.name}.`);
      else {
        adminRepo.log(req.player.id, req.target.id, 'item-remove', `Took away ${item.name}. Reason: ${reason}`);
        req.flash('success', `${item.name} removed.`);
      }
    } else if (owned.has(item.id)) {
      req.flash('error', `${req.target.username} already owns ${item.name}.`);
    } else {
      players.addItem(req.target.id, item.id);
      adminRepo.log(req.player.id, req.target.id, 'item-grant', `Gave ${item.name}. Reason: ${reason}`);
      players.notify(req.target.id, 'system', `HQ issued you a ${item.name}. Equip it in the Armory.`, '/armory');
      req.flash('success', `${item.name} given to ${req.target.username}.`);
    }
    res.redirect(`/admin/players/${req.target.id}#inventory`);
  });

  // Take a player out of their unit (not its Commander: transfer command or disband from the unit page).
  router.post('/admin/players/:id/unit-remove', loadTarget, (req, res) => {
    const t = req.target;
    const reason = admin.cleanReason(req.body.reason);
    const unit = unitRepo && t.unit_id ? unitRepo.findById(t.unit_id) : null;
    if (!unit) req.flash('error', `${t.username} isn’t in a unit.`);
    else if (t.unit_role === 'leader') req.flash('error', 'That’s the unit’s Commander. Transfer command or disband the unit from its page first.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else {
      unitRepo.kick(unit.id, t.id);
      unitRepo.log(unit.id, 'leave', `${t.username} was removed by HQ.`);
      adminRepo.log(req.player.id, t.id, 'unit-remove', `Removed from [${unit.tag}] ${unit.name}. Reason: ${reason}`);
      players.notify(t.id, 'unit', `HQ removed you from ${unit.name}: ${reason}`, '/units');
      req.flash('success', `${t.username} was removed from ${unit.name}.`);
    }
    back(res, t);
  });

  router.post('/admin/players/:id/clear-title', loadTarget, (req, res) => {
    if (adminRepo.clearTitle(req.target.id)) {
      adminRepo.log(req.player.id, req.target.id, 'clear-title', `Cleared the title “${req.target.title}”.`);
      req.flash('success', 'Title cleared. They can pick another one they’ve earned.');
    }
    back(res, req.target);
  });

  // Sign a player out on every device (e.g. after a suspected account compromise).
  router.post('/admin/players/:id/sign-out', loadTarget, (req, res) => {
    if (req.target.id === req.player.id) req.flash('error', 'Use Sign out for your own account.');
    else {
      players.endSessions(req.target.id);
      adminRepo.log(req.player.id, req.target.id, 'sign-out', 'Signed out on every device.');
      req.flash('success', `${req.target.username} is signed out everywhere.`);
    }
    back(res, req.target);
  });

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

  router.post('/admin/players/:id/reset-password', loadTarget, async (req, res, next) => {
    try {
      if (req.target.id === req.player.id) {
        req.flash('error', 'Use Change password for your own account.');
        return back(res, req.target);
      }
      if (req.target.is_admin) {
        req.flash('error', 'Admin passwords can’t be reset from here.');
        return back(res, req.target);
      }
      const temp = admin.generateTempPassword();
      players.setPassword(req.target.id, await bcrypt.hash(temp, 12), { temporary: true });
      players.endSessions(req.target.id);
      // The audit log records that a reset happened, never the password itself.
      adminRepo.log(req.player.id, req.target.id, 'password-reset', 'Issued a temporary password (expires in 24 hours).');
      res.set('Cache-Control', 'no-store');
      res.render('admin/temp-password', { title: 'Admin · Password reset', nav: 'admin', t: req.target, temp });
    } catch (err) {
      next(err);
    }
  });

  // Moderation: wipe a player's profile bio (e.g. offensive content).
  router.post('/admin/players/:id/clear-bio', loadTarget, (req, res) => {
    if (req.target.bio) {
      players.setBio(req.target.id, '');
      adminRepo.log(req.player.id, req.target.id, 'clear-bio', req.target.bio.slice(0, 300));
      players.notify(req.target.id, 'system', 'HQ removed your profile bio because it broke the conduct rules in the Terms of Service.', '/terms#conduct');
      req.flash('success', `${req.target.username}'s bio was cleared.`);
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
      if (push) push.broadcast('news', `Announcement: ${message}`, '/notifications').catch((err) => console.error('[push] broadcast failed', err));
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

  // Reported private messages. Admins only ever see messages someone reported.
  // ----- Units -----
  router.get('/admin/units', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 24);
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const { rows, total } = adminRepo.units(q, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/units', {
      title: 'Admin · Units',
      nav: 'admin',
      q, page, total,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      rows: rows.map((u) => ({ ...u, founded: new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) })),
    });
  });

  router.post('/admin/units/:id/treasury', (req, res, next) => {
    const unit = adminRepo.unitById(Number(req.params.id));
    if (!unit) return next('router');
    const amount = Number(String(req.body.amount || '').replace(/[$,\s]/g, ''));
    const reason = admin.cleanReason(req.body.reason);
    const back = `/admin/units${req.body.q ? `?q=${encodeURIComponent(String(req.body.q))}` : ''}#unit-${unit.id}`;
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) req.flash('error', 'Enter a non-zero whole amount up to $10,000,000, e.g. 5000 or -5000.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else if (!adminRepo.adjustTreasury(unit.id, amount)) req.flash('error', `The ${unit.name} treasury only has $${unit.treasury.toLocaleString('en-US')}.`);
    else {
      const money = (n) => `$${Math.abs(n).toLocaleString('en-US')}`;
      adminRepo.log(req.player.id, null, 'unit-treasury', `[${unit.tag}] ${unit.name}: ${amount > 0 ? 'added' : 'removed'} ${money(amount)} (now ${money(unit.treasury + amount)}). Reason: ${reason}`);
      if (unitRepo) unitRepo.log(unit.id, 'donation', `HQ ${amount > 0 ? 'added' : 'removed'} ${money(amount)} ${amount > 0 ? 'to' : 'from'} the treasury: ${reason}`);
      req.flash('success', `${unit.name} treasury ${amount > 0 ? '+' : '−'}${money(amount)}.`);
    }
    res.redirect(back);
  });

  // ----- Economy -----
  router.get('/admin/economy', (req, res) => {
    const now = Date.now();
    const e = adminRepo.economy({ now });
    const stats = adminRepo.stats({ now, dayStart: new Date(now).setHours(0, 0, 0, 0), onlineSince: now - presence.ONLINE_WINDOW_MS });
    res.render('admin/economy', {
      title: 'Admin · Economy',
      nav: 'admin',
      stats,
      ...e,
      sources: e.flows.filter((f) => f.week > 0),
      sinks: e.flows.filter((f) => f.week < 0),
      transfers: e.flows.filter((f) => f.week === 0),
      label: (reason) => REASON_LABELS[reason] || (reason.startsWith('admin-') ? `Admin: ${reason.slice(6)}` : reason),
    });
  });

  // ----- Audit log -----
  router.get('/admin/audit', (req, res) => {
    const now = Date.now();
    const action = String(req.query.action || '').slice(0, 40);
    const adminId = Math.max(0, Math.floor(Number(req.query.admin)) || 0);
    const q = String(req.query.q || '').trim().slice(0, 60);
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const AUDIT_PAGE = 50;
    const out = adminRepo.audit({ action, adminId, q, limit: AUDIT_PAGE, offset: (page - 1) * AUDIT_PAGE });
    const params = (extra) => {
      const p = new URLSearchParams();
      if (action) p.set('action', action);
      if (adminId) p.set('admin', String(adminId));
      if (q) p.set('q', q);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return `/admin/audit?${p}`;
    };
    res.render('admin/audit', {
      title: 'Admin · Audit log',
      nav: 'admin',
      action, adminId, q, page,
      total: out.total,
      pages: Math.max(1, Math.ceil(out.total / AUDIT_PAGE)),
      rows: out.rows.map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now), when: new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ') })),
      actions: out.actions,
      admins: out.admins,
      pageUrl: (n) => params({ page: String(n) }),
    });
  });

  router.get('/admin/reports', (req, res) => {
    const now = Date.now();
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.render('admin/reports', {
      title: 'Admin · Reported messages',
      nav: 'admin',
      status,
      reports: messages.reports(status).map((r) => ({ ...r, ago: presence.timeAgo(r.created_at, now), resolvedAgo: r.resolved_at ? presence.timeAgo(r.resolved_at, now) : null })),
      openReports: messages.openReportCount(),
    });
  });

  router.post('/admin/reports/:id/resolve', (req, res) => {
    const report = messages.reportById(Number(req.params.id));
    if (!report) return res.redirect('/admin/reports');
    const resolution = req.body.resolution === 'actioned' ? 'actioned' : 'dismissed';
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (messages.resolve(report.id, req.player.id, note ? `${resolution}: ${note}` : resolution)) {
      adminRepo.log(req.player.id, report.sender_id, 'message-report', `Report #${report.id} ${resolution}${note ? `: ${note}` : ''}`);
      req.flash('success', `Report #${report.id} ${resolution === 'actioned' ? 'marked as actioned' : 'dismissed'}.`);
    }
    res.redirect('/admin/reports');
  });

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
    const ids = req.flag.evidence.battleIds || [];
    const { reversed, total, ratings } = players.transaction(() => ({
      ...anti.reverseBattles(ids),
      ratings: seasonService.reverseBattles(ids), // farmed fights don't keep their season rating either
    }));
    resolve(req, 'actioned', `Reversed ${reversed} battle(s), returning $${total} to ${req.flag.evidence.defender.name}.${ratings ? ` Undid the season rating from ${ratings} fight(s).` : ''}`);
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
