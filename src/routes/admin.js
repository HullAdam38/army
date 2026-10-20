'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const admin = require('../admin');
const game = require('../game');
const presence = require('../presence');
const { loadoutOf } = require('../armory');
const { createRequireAuth } = require('../require-auth');
const { createFailureTracker } = require('../middleware');
const bbcode = require('../bbcode');
const support = require('../support');
const { ITEMS, ITEMS_BY_ID, SLOTS } = require('../items');
const { EMAIL_RE, USERNAME_RE } = require('./auth');
const { announceLevels } = require('../notify');
const { createStatsService } = require('../stats-service');
const { createCasinoStats } = require('../casino-stats');
const tuning = require('../tuning');
const launch = require('../launch');
const cosmeticsCatalogue = require('../cosmetics');
const supporterRules = require('../supporter');
const vehicleRules = require('../vehicles');
const workshopRules = require('../workshop');

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
  armory: 'Armory (gear)', 'armory-repair': 'Armory (repairs)', 'armory-sale': 'Armory (gear sold)', supplies: 'Armory (supplies)',
  vehicle: 'Motor pool (vehicles)', 'vehicle-repair': 'Motor pool (repairs)', 'vehicle-sale': 'Motor pool (vehicles sold)', workshop: 'Workshop (upgrade fees)', training: 'Training', scout: 'Scouting', base: 'Forward base', 'base-refund': 'Forward base refunds',
  'hospital-treatment': 'Hospital treatment', 'hospital-discharge': 'Hospital discharge', 'unit-donation': 'Unit donations', 'unit-founded': 'Units founded',
  signup: 'Starting cash', 'bank-deposit': 'Bank deposits (fees)', 'bank-withdraw': 'Bank withdrawals', reversal: 'Anti-cheat reversals', 'daily-order': 'Daily orders', 'daily-bonus': 'Daily commendation',
};
const DEFAULT_WARNING = 'HQ has noticed activity on your account that may break the rules of engagement (one account per player, no farming other players). Further activity may lead to suspension.';

function adminRoutes(players, adminRepo, anti, messages, seasonService, chatService, avatarService, push = null, unitRepo = null, raidService = null, theatreService = null, supportService = null, { health = null, reserve = null, legal = null, production = false, serverSettings = null, onServerSettings = null, cosmetics = null, supporters = null, vehicles = null, workshop = null } = {}) {
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
  // Tickets waiting for HQ, for the badge in the admin menu.
  router.use('/admin', (req, res, next) => {
    res.locals.supportWaiting = supportService ? supportService.waiting() : 0;
    next();
  });

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
      notifications: players.notificationCounts(t.id),
      title: `Admin · ${t.username}`,
      nav: 'admin',
      t,
      view: game.playerView(req.target, now),
      rank: game.rankFor(t.level),
      rating: loadoutOf(players, t).rating,
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
      ...(() => {
        // Vehicles share the Gear card; their ids go in the same select as "veh:<id>".
        const mine = vehicles ? vehicles.owned(t.id) : new Map();
        const out = vehicles ? vehicles.assigned(t.id) : null;
        return {
          vehiclesOwned: vehicleRules.VEHICLES.filter((v) => mine.has(v.id)).map((v) => ({ ...v, condition: Math.floor(mine.get(v.id)), out: Boolean(out && out.vehicle.id === v.id) })),
          vehiclesGrantable: vehicles ? vehicleRules.VEHICLES.filter((v) => !mine.has(v.id)) : [],
          materials: workshop ? (() => { const have = workshop.materials(t.id); return workshopRules.MATERIALS.map((m) => ({ ...m, qty: have.get(m.id) || 0 })); })() : [],
        };
      })(),
      cosmeticGrants: cosmetics ? cosmetics.grantsFor(t.id) : [],
      supporterInfo: {
        active: supporterRules.isActive(t),
        until: t.supporter_until ? new Date(t.supporter_until).toISOString().slice(0, 10) : null,
        source: t.supporter_source,
        status: t.supporter_status,
      },
      cosmeticOptions: cosmeticsCatalogue.COSMETICS.filter((c) => c.kind !== 'crest'),
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
  router.post('/admin/players/:id/items', loadTarget, (req, res, next) => {
    if (String(req.body.item || '').startsWith('veh:')) return next(); // a vehicle (below)
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

  // Give or take workshop materials.
  router.post('/admin/players/:id/materials', loadTarget, (req, res) => {
    const material = workshopRules.MATERIALS_BY_ID.get(String(req.body.material || ''));
    const qty = Math.trunc(Number(req.body.qty));
    const reason = admin.cleanReason(req.body.reason);
    if (!workshop || !material) req.flash('error', 'Pick a material.');
    else if (!Number.isInteger(qty) || !qty || Math.abs(qty) > 100000) req.flash('error', 'Give an amount from -100,000 to 100,000 (negative takes away).');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else {
      workshop.add(req.target.id, { [material.id]: qty });
      const n = Math.abs(qty).toLocaleString('en-US');
      adminRepo.log(req.player.id, req.target.id, qty > 0 ? 'materials-grant' : 'materials-remove', `${qty > 0 ? 'Gave' : 'Took away'} ${n} ${material.name}. Reason: ${reason}`);
      if (qty > 0) players.notify(req.target.id, 'system', `HQ sent you ${n} ${material.name} for the workshop.`, '/armory/workshop');
      req.flash('success', `${qty > 0 ? 'Gave' : 'Took away'} ${n} ${material.name}.`);
    }
    res.redirect(`/admin/players/${req.target.id}#inventory`);
  });

  // Give or take a vehicle (same form as gear, with "veh:<id>").
  router.post('/admin/players/:id/items', loadTarget, (req, res) => {
    const vehicle = vehicleRules.VEHICLES_BY_ID.get(String(req.body.item).slice(4));
    const reason = admin.cleanReason(req.body.reason);
    if (!vehicles || !vehicle) req.flash('error', 'Pick a vehicle.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else if (req.body.action === 'remove') {
      if (!vehicles.remove(req.target.id, vehicle.id)) req.flash('error', `${req.target.username} doesn’t own the ${vehicle.name}.`);
      else {
        adminRepo.log(req.player.id, req.target.id, 'vehicle-remove', `Took away the ${vehicle.name}. Reason: ${reason}`);
        req.flash('success', `${vehicle.name} removed.`);
      }
    } else if (!vehicles.grant(req.target.id, vehicle.id)) {
      req.flash('error', `${req.target.username} already owns the ${vehicle.name}.`);
    } else {
      adminRepo.log(req.player.id, req.target.id, 'vehicle-grant', `Gave the ${vehicle.name}. Reason: ${reason}`);
      players.notify(req.target.id, 'system', `HQ issued you a ${vehicle.name}. Take it out in the motor pool.`, '/armory/motor-pool');
      req.flash('success', `${vehicle.name} given to ${req.target.username}.`);
    }
    res.redirect(`/admin/players/${req.target.id}#inventory`);
  });

  // Supporter membership: a gift from HQ (or ending one). Paid memberships are managed with the payment provider.
  router.post('/admin/players/:id/supporter', loadTarget, (req, res) => {
    const reason = admin.cleanReason(req.body.reason);
    const days = Math.floor(Number(req.body.days));
    if (!supporters) req.flash('error', 'Not available.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else if (req.body.action === 'end') {
      const out = supporters.endGift(req.target.id);
      if (out.error) req.flash('error', out.error);
      else {
        adminRepo.log(req.player.id, req.target.id, 'supporter-end', `Ended their gift Supporter membership. Reason: ${reason}`);
        req.flash('success', 'Gift membership ended.');
      }
    } else if (!Number.isInteger(days) || days < 1 || days > 3660) req.flash('error', 'Give a number of days from 1 to 3,660.');
    else {
      const out = supporters.gift(req.target.id, days);
      adminRepo.log(req.player.id, req.target.id, 'supporter-gift', `Gave ${days} day${days === 1 ? '' : 's'} of Supporter membership (until ${new Date(out.until).toISOString().slice(0, 10)}). Reason: ${reason}`);
      req.flash('success', `${req.target.username} is a Supporter until ${new Date(out.until).toISOString().slice(0, 10)}.`);
    }
    res.redirect(`/admin/players/${req.target.id}#supporter`);
  });

  router.get('/admin/supporters', (req, res) => {
    const now = Date.now();
    res.render('admin/supporters', {
      title: 'Admin · Supporters',
      nav: 'admin',
      o: supporters ? supporters.overview(now) : { counts: { active: 0, gifted: 0, ending: 0, ever: 0 }, members: [], events: [], revenue: [] },
      price: process.env.SUPPORTER_PRICE || '',
      open: Boolean(process.env.SUPPORTER_CHECKOUT_URL),
      webhookReady: Boolean(process.env.LEMONSQUEEZY_WEBHOOK_SECRET),
      ago: (ms) => presence.timeAgo(ms, now),
    });
  });

  // Cosmetics: give a player a Supporter item (or any cosmetic), or take one back.
  router.post('/admin/players/:id/cosmetics', loadTarget, (req, res) => {
    const reason = admin.cleanReason(req.body.reason);
    const revoke = req.body.action === 'revoke';
    if (!cosmetics) req.flash('error', 'Not available.');
    else if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else {
      const out = revoke ? cosmetics.revoke({ userId: req.target.id, id: req.body.cosmetic }) : cosmetics.grant({ userId: req.target.id, id: req.body.cosmetic, by: req.player.id });
      if (out.error) req.flash('error', out.error);
      else {
        adminRepo.log(req.player.id, req.target.id, revoke ? 'cosmetic-revoke' : 'cosmetic-grant', `${revoke ? 'Took back' : 'Gave'} ${out.cosmetic.name}. Reason: ${reason}`);
        if (!revoke) players.notify(req.target.id, 'system', `HQ gave you ${out.cosmetic.name}. Put it on in your wardrobe.`, out.cosmetic.kind === 'badgePack' ? '/account/avatar' : `/account/wardrobe#${out.cosmetic.kind}`);
        req.flash('success', `${revoke ? 'Took back' : 'Gave'} ${out.cosmetic.name}.`);
      }
    }
    res.redirect(`/admin/players/${req.target.id}#cosmetics`);
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

  // Clear a player's notifications (e.g. after something spammed them).
  router.post('/admin/players/:id/clear-notifications', loadTarget, (req, res) => {
    const n = players.clearNotifications(req.target.id);
    if (!n) req.flash('error', `${req.target.username} has no notifications to clear.`);
    else {
      adminRepo.log(req.player.id, req.target.id, 'clear-notifications', `Cleared ${n} notification${n === 1 ? '' : 's'}.`);
      req.flash('success', `Cleared ${n} of ${req.target.username}’s notification${n === 1 ? '' : 's'}.`);
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
  // ----- Server settings (the safe subset of the settings file) -----
  const renderServer = (req, res, status = 200, extra = {}) => res.status(status).render('admin/server', {
    title: 'Admin · Server settings',
    nav: 'admin',
    groups: serverSettings ? serverSettings.view() : [],
    serverOnly: serverSettings ? serverSettings.serverOnly() : [],
    file: serverSettings ? serverSettings.file : null,
    errors: {},
    values: null,
    ...extra,
  });
  router.get('/admin/server', (req, res) => renderServer(req, res));
  // Guessing the password from a hijacked admin session gets throttled, like changing a password.
  const serverPasswordFailures = createFailureTracker({ windowMs: 15 * 60 * 1000, max: 5 });
  router.post('/admin/server', async (req, res, next) => {
    try {
      if (!serverSettings) return renderServer(req, res, 404);
      const values = Object.fromEntries(serverSettings.FIELDS.map((f) => [f.key, String(req.body[f.key] ?? '').slice(0, 300)]));
      // Changing server settings needs the admin's password, not just a signed-in session.
      const me = players.findById(req.player.id);
      const key = String(me.id);
      const locked = serverPasswordFailures.lockedFor(key);
      if (locked) return renderServer(req, res, 429, { values, errors: { password: `Too many wrong attempts. Try again in ${locked} min.` } });
      if (!(await bcrypt.compare(String(req.body.password || ''), me.password_hash))) {
        serverPasswordFailures.fail(key);
        return renderServer(req, res, 422, { values, errors: { password: 'That password isn’t right.' } });
      }
      serverPasswordFailures.clear(key);
      const out = serverSettings.save(values);
      if (out.errors) return renderServer(req, res, 422, { values, errors: out.errors });
      if (!out.changed.length) {
        req.flash('info', 'Nothing changed.');
        return res.redirect('/admin/server');
      }
      if (onServerSettings) onServerSettings(out.changed);
      adminRepo.log(req.player.id, null, 'server-settings', `Changed ${out.changed.join(', ')}`);
      req.flash('success', `Saved: ${out.changed.join(', ')}. In force now${out.changed.some((k) => k.startsWith('BACKUP_')) ? ' (backup settings from the next backup)' : ''}.`);
      res.redirect('/admin/server');
    } catch (err) {
      next(err);
    }
  });

  // ----- Launch checklist -----
  router.get('/admin/launch', (req, res) => {
    const now = Date.now();
    res.render('admin/launch', {
      title: 'Admin · Launch checklist',
      nav: 'admin',
      items: launch.checklist({
        legal: legal || req.app.locals.legal,
        production,
        host: req.get('host'),
        backup: health ? health.backupStatus(now) : null,
        errors24h: health ? health.countSince(now - 24 * 60 * 60 * 1000) : 0,
        signupsOpen: tuning.get('registrationOpen'),
        signupsPerIp: tuning.get('signupsPerIpPerDay'),
        reserve: reserve ? reserve.count() : 0,
        store: { checkout: Boolean(process.env.SUPPORTER_CHECKOUT_URL), webhook: Boolean(process.env.LEMONSQUEEZY_WEBHOOK_SECRET) },
        now,
      }),
      errors: health ? health.recent(20).map((e) => ({ ...e, ago: presence.timeAgo(e.created_at, now) })) : [],
    });
  });

  // ----- Player stats -----
  const stats = createStatsService(adminRepo.db);
  const casinoStats = createCasinoStats(adminRepo.db);
  router.get('/admin/casino', (req, res) => {
    const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    res.render('admin/casino', { title: 'Admin · Casino', nav: 'admin', c: casinoStats.overview({ days }), luckZ: casinoStats.LUCK_Z, luckMin: casinoStats.LUCK_MIN_PLAYS });
  });
  router.get('/admin/stats', (req, res) => {
    const range = req.query.range === 'all' ? 'all' : 'month';
    res.render('admin/stats', { title: 'Admin · Player stats', nav: 'admin', s: stats.overview(Date.now(), { range }), RETENTION: stats.RETENTION });
  });

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
  // ---- Support tickets ----
  router.get('/admin/support', (req, res, next) => {
    if (!supportService) return next('router');
    const now = Date.now();
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const mine = req.query.mine === '1';
    const q = supportService.queue({ status: String(req.query.status || 'open'), assignedTo: mine ? req.player.id : null, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    res.render('admin/support', {
      title: 'Admin · Support',
      nav: 'admin',
      ...q,
      rows: q.rows.map((t) => ({ ...t, ago: presence.timeAgo(t.updated_at, now), waitingSince: presence.timeAgo(t.last_player_at || t.created_at, now) })),
      mine,
      page,
      pages: Math.max(1, Math.ceil(q.total / PAGE_SIZE)),
      counts: supportService.counts(),
      statuses: support.STATUSES,
      alertsOn: supportService.alertsOn(req.player.id),
    });
  });

  router.post('/admin/support/alerts', (req, res, next) => {
    if (!supportService) return next('router');
    const on = req.body.on === '1';
    supportService.setAlerts(req.player.id, on);
    req.flash('success', on ? 'You’ll get a push alert for new tickets and player replies (on devices with alerts turned on).' : 'Push alerts for support tickets are off. You’ll still see them in your notifications.');
    res.redirect('/admin/support');
  });

  router.get('/admin/support/:id', (req, res, next) => {
    if (!supportService) return next('router');
    const view = supportService.forStaff(req.params.id);
    if (!view) return next();
    const now = Date.now();
    res.render('admin/support-ticket', {
      title: `Admin · Ticket #${view.ticket.id}`,
      nav: 'admin',
      ...view,
      messages: view.messages.map((m) => ({ ...m, ago: presence.timeAgo(m.created_at, now), when: new Date(m.created_at).toISOString() })),
      others: view.others.map((t) => ({ ...t, ago: presence.timeAgo(t.created_at, now) })),
      opened: presence.timeAgo(view.ticket.created_at, now),
      limits: { body: support.MAX_BODY },
    });
  });

  const ticketAction = (fn) => (req, res, next) => {
    if (!supportService) return next('router');
    const out = players.transaction(() => fn(req));
    req.flash(out.error ? 'error' : 'success', out.error || out.ok);
    res.redirect(`/admin/support/${Number(req.params.id) || ''}${out.error ? '' : '#latest'}`);
  };

  router.post('/admin/support/:id/reply', ticketAction((req) => {
    const internal = req.body.internal === 'on';
    const close = !internal && req.body.close === 'on';
    const out = supportService.staffReply({ admin: req.player, ticketId: req.params.id, body: req.body.body, internal, close });
    if (out.error) return out;
    return { ok: internal ? 'Note added (only admins can see it).' : close ? 'Reply sent and ticket closed.' : 'Reply sent. The player has been notified.' };
  }));

  router.post('/admin/support/:id/status', ticketAction((req) => {
    const status = String(req.body.status || '');
    const out = supportService.setStatus({ admin: req.player, ticketId: req.params.id, status });
    if (out.error) return out;
    return { ok: status === 'closed' ? 'Ticket closed. The player has been told.' : 'Ticket reopened.' };
  }));

  router.post('/admin/support/:id/assign', ticketAction((req) => {
    const to = req.body.to === 'me' ? req.player.id : Number(req.body.to) || null;
    const out = supportService.assign({ ticketId: req.params.id, adminId: to });
    if (out.error) return out;
    return { ok: out.ticket.assignee ? `Assigned to ${out.ticket.assignee}. Only they get alerts about it now.` : 'Unassigned. Every admin gets alerts about it again.' };
  }));

  // ---- Raids & map: fix problems with unit raids and the theatre of war ----
  router.get('/admin/teamwork', (req, res, next) => {
    if (!raidService || !theatreService) return next('router');
    res.render('admin/teamwork', {
      title: 'Admin · Raids & map',
      nav: 'admin',
      raids: raidService.adminView(),
      map: theatreService.adminView(),
      now: Date.now(),
    });
  });

  /** Runs an admin change that needs a reason: flashes the error, or logs it and flashes `ok`. */
  const withReason = (req, res, anchor, fn) => {
    const reason = admin.cleanReason(req.body.reason);
    if (!reason) req.flash('error', 'Give a reason; it goes in the audit log.');
    else {
      const out = players.transaction(() => fn(reason));
      if (out.error) req.flash('error', out.error);
      else {
        adminRepo.log(req.player.id, null, out.action, `${out.log} Reason: ${reason}`);
        req.flash('success', out.ok);
      }
    }
    res.redirect(`/admin/teamwork#${anchor}`);
  };
  const raidLabel = (r) => `[${r.unit_tag}] ${r.unit_name}'s raid on the ${r.name}`;

  router.post('/admin/raids/:id/cancel', (req, res, next) => {
    if (!raidService) return next('router');
    withReason(req, res, 'raids', (reason) => {
      const before = raidService.adminView().active.find((r) => r.id === Number(req.params.id));
      const out = raidService.cancel(Number(req.params.id), { refund: req.body.refund === 'on', reason });
      if (out.error || !before) return out.error ? out : { error: 'That raid isn’t under way any more.' };
      const refund = out.refunded ? ` and refunded $${out.refunded.toLocaleString('en-US')} in supplies` : ' with no refund';
      return { action: 'raid-cancel', log: `Called off ${raidLabel(before)}${refund}.`, ok: `Called off ${raidLabel(before)}${refund}.` };
    });
  });

  router.post('/admin/raids/:id/extend', (req, res, next) => {
    if (!raidService) return next('router');
    withReason(req, res, 'raids', (reason) => {
      const before = raidService.adminView().active.find((r) => r.id === Number(req.params.id));
      const out = raidService.extend(Number(req.params.id), req.body.hours, { reason });
      if (out.error || !before) return out.error ? out : { error: 'That raid isn’t under way any more.' };
      const h = Number(req.body.hours);
      return { action: 'raid-extend', log: `Gave ${raidLabel(before)} ${h} more hour${h === 1 ? '' : 's'}.`, ok: `Gave ${raidLabel(before)} ${h} more hour${h === 1 ? '' : 's'}.` };
    });
  });

  router.post('/admin/theatre/:region/holder', (req, res, next) => {
    if (!theatreService) return next('router');
    withReason(req, res, 'map', () => {
      const tag = String(req.body.tag || '').trim();
      const unit = tag ? adminRepo.unitByTag(tag) : null;
      if (tag && !unit) return { error: `No unit has the tag [${tag.replace(/^\[|\]$/g, '')}].` };
      const out = theatreService.setHolder(req.params.region, unit);
      if (out.error) return out;
      const from = out.from ? `[${out.from.tag}] ${out.from.name}` : 'nobody';
      const msg = unit ? `Handed ${out.region.name} to [${unit.tag}] ${unit.name} (was ${from}).` : `Freed ${out.region.name} (was ${from}).`;
      return { action: 'theatre-holder', log: msg, ok: msg };
    });
  });

  router.post('/admin/theatre/units/:id/wipe', (req, res, next) => {
    if (!theatreService) return next('router');
    withReason(req, res, 'map', () => {
      const unit = adminRepo.unitById(Number(req.params.id));
      if (!unit) return { error: 'That unit no longer exists.' };
      const points = theatreService.wipePoints(unit.id);
      if (!points) return { error: `[${unit.tag}] has no theatre points this week.` };
      const msg = `Removed [${unit.tag}] ${unit.name}'s ${points.toLocaleString('en-US')} theatre points for this week.`;
      return { action: 'theatre-wipe', log: msg, ok: msg };
    });
  });

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
