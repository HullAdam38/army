'use strict';

const express = require('express');
const units = require('../units');
const raids = require('../raids');
const game = require('../game');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');
const wars = require('../wars');
const bbcode = require('../bbcode');
const { autoAccepts } = require('../reserve-service');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

// What each rank unlocks, told to members when they're promoted.
const PROMOTION_PERKS = {
  sergeant: 'You can now review applications and moderate the unit board.',
  officer: 'You can now remove Sergeants and Privates, promote Privates, call rally orders and launch raids.',
};

function unitRoutes(players, unitRepo, adminRepo, warService, objectiveService = null, raidService = null, theatreService = null, cosmetics = null) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const urlOf = (unit, hash = '') => `/units/${unit.id}${hash}`;

  /** Loads :id into req.unit, and the viewer's role in it (null if not a member). */
  const loadUnit = (req, res, next) => {
    const id = Number(req.params.id);
    const unit = Number.isInteger(id) ? unitRepo.findById(id) : null;
    if (!unit) return next('route');
    req.unit = unit;
    req.role = req.player.unit_id === unit.id ? req.player.unit_role : null;
    next();
  };
  /** Runs `fn` in a transaction with a fresh player + unit; flashes its { error } or { ok } and redirects. */
  const act = (req, res, fn, redirect) => {
    const out = players.transaction(() => {
      const me = players.findById(req.player.id);
      const unit = unitRepo.findById(req.unit.id);
      if (!unit) return { error: 'That unit has been disbanded.' };
      const role = me.unit_id === unit.id ? me.unit_role : null;
      return fn({ me, unit, role }) || {};
    });
    req.flash(out.error ? 'error' : 'success', out.error || out.ok);
    res.redirect(out.redirect || redirect || urlOf(req.unit));
  };
  const notifyAll = (ids, message, link, exceptId) => {
    for (const id of ids) if (id !== exceptId) players.notify(id, 'unit', message, link);
  };
  /** Only lets a route run when :param is one of `allowed` (Express 5 has no regex params). */
  const oneOf = (param, allowed) => (req, res, next) => (allowed.includes(req.params[param]) ? next() : next('route'));
  /** Disbanding ends any war the unit is in as a forfeit. */
  const disband = (unitId) => {
    warService.forfeit(unitId);
    unitRepo.disband(unitId);
  };
  /** Shapes a war row for templates, from the point of view of `unitId` (if given). */
  const warView = (w, unitId = null, now = Date.now()) => {
    const us = unitId === w.attacker_unit_id ? 'attacker' : unitId === w.defender_unit_id ? 'defender' : null;
    return {
      ...w,
      us,
      them: us ? (us === 'attacker' ? { id: w.defender_unit_id, name: w.defender_name, tag: w.defender_tag } : { id: w.attacker_unit_id, name: w.attacker_name, tag: w.attacker_tag }) : null,
      ourScore: us === 'defender' ? w.defender_score : w.attacker_score,
      theirScore: us === 'defender' ? w.attacker_score : w.defender_score,
      outcome: w.status !== 'ended' ? 'active' : w.winner === null ? 'draw' : !us ? w.winner : w.winner === us ? 'won' : 'lost',
      endsIn: Math.max(0, w.ends_at - now),
      ago: presence.timeAgo(w.ended_at || w.started_at, now),
    };
  };
  const targetMember = (unit, userId) => {
    const t = players.findById(Number(userId));
    return t && t.unit_id === unit.id ? t : null;
  };

  router.get('/unit', requireAuth, (req, res) => res.redirect(req.player.unit_id ? `/units/${req.player.unit_id}` : '/units'));

  router.get('/units', requireAuth, (req, res) => {
    warService.finishDue();
    const now = Date.now();
    const atWar = new Set(warService.active().flatMap((w) => [w.attacker_unit_id, w.defender_unit_id]));
    const q = String(req.query.q || '').trim().slice(0, 24);
    const mine = req.player.unit_id ? unitRepo.findById(req.player.unit_id) : null;
    res.render('units', {
      title: 'Units',
      nav: 'unit',
      q,
      list: unitRepo.list(q).map((u, i) => ({ ...u, position: q ? null : i + 1, capacity: units.capacity(u), isYours: mine && mine.id === u.id, atWar: atWar.has(u.id), requirements: units.requirementList(u) })),
      warCount: atWar.size / 2,
      total: unitRepo.count(),
      mine,
      applications: unitRepo.pendingForUser(req.player.id).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
      // Help for players without a unit: invitations, units they could join now, and the "looking" flag.
      invites: mine ? [] : unitRepo.invitesFor(req.player.id, now).map((i) => ({ ...i, ago: presence.timeAgo(i.created_at, now), full: i.members >= units.capacity(i) })),
      recommended: mine || q ? [] : (() => {
        const applied = new Set(unitRepo.pendingForUser(req.player.id).map((a) => a.unit_id));
        return unitRepo.recommended(req.player, { limit: 3, now }).map((u) => ({ ...u, capacity: units.capacity(u), applied: applied.has(u.id), requirements: units.requirementList(u) }));
      })(),
      looking: Boolean(req.player.lfu_at),
      foundBlocker: units.foundBlocker(req.player, now),
      createCost: units.CREATE_COST,
      createLevel: units.CREATE_LEVEL,
      maxDescription: units.MAX_DESCRIPTION,
      form: req.session.unitForm || {},
    });
    delete req.session.unitForm;
  });

  router.post('/units', requireAuth, (req, res) => {
    const input = { name: req.body.name, tag: req.body.tag, description: req.body.description };
    const out = players.transaction(() => {
      const me = game.applyRegen(players.findById(req.player.id), Date.now());
      const blocker = units.foundBlocker(me);
      if (blocker) return { error: blocker };
      const v = units.validateUnit(input);
      if (v.error) return v;
      const taken = unitRepo.taken(v.name, v.tag);
      if (taken.name) return { error: `There’s already a unit called ${v.name}.` };
      if (taken.tag) return { error: `The tag [${v.tag}] is taken.` };
      me.cash -= units.CREATE_COST;
      players.save(me, { reason: 'unit-founded', ref: v.tag });
      const id = unitRepo.create({ ...v, leaderId: me.id });
      unitRepo.log(id, 'founded', `${me.username} founded ${v.name}.`);
      players.log(me.id, 'unit', `Founded the unit ${v.name} [${v.tag}] for ${money(units.CREATE_COST)}.`, `/units/${id}`);
      players.news(me.id, `[b]${me.username}[/b] founded a new unit: [b]${v.name}[/b] (${v.tag}). It’s recruiting.`);
      return { id, name: v.name };
    });
    if (out.error) {
      req.session.unitForm = { name: String(input.name || '').slice(0, 40), tag: String(input.tag || '').slice(0, 8), description: String(input.description || '').slice(0, units.MAX_DESCRIPTION) };
      req.flash('error', out.error);
      return res.redirect('/units#found');
    }
    req.flash('success', `${out.name} is formed. You are its Commander.`);
    res.redirect(`/units/${out.id}`);
  });

  router.get('/units/:id', requireAuth, (req, res, next) => { warService.finishDue(); next(); }, loadUnit, (req, res) => {
    const now = Date.now();
    const { unit, role } = req;
    const activeWar = warService.activeFor(unit.id);
    // A Commander visiting another unit can declare war on it.
    const myUnit = !role && req.player.unit_role === 'leader' ? unitRepo.findById(req.player.unit_id) : null;
    const member = Boolean(role);
    const roster = unitRepo.members(unit.id).map((m) => {
      const rank = game.rankFor(m.level);
      return {
        ...m,
        avatarUrl: `/avatars/${m.id}?v=${m.avatar_v || 0}`,
        grade: rank.grade,
        rank: rank.name,
        roleLabel: units.roleLabel(m.unit_role),
        online: presence.isOnline(m, now),
        lastSeen: presence.timeAgo(m.last_seen_at, now),
        isYou: m.id === req.player.id,
        canKick: member && m.id !== req.player.id && units.can.kick(role, m.unit_role),
        canPromote: member && m.id !== req.player.id && units.can.promote(role, m.unit_role),
        canDemote: member && m.id !== req.player.id && units.can.demote(role, m.unit_role),
        promoteTo: units.roleLabel(units.promotedRole(m.unit_role)),
        demoteTo: units.roleLabel(units.demotedRole(m.unit_role)),
      };
    });
    const members = roster.filter((m) => !m.banned_at).length;
    const active = roster.filter((m) => !m.banned_at);
    res.render('unit', {
      stats: {
        pvpWins: active.reduce((n, m) => n + m.pvp_wins, 0),
        missions: active.reduce((n, m) => n + m.missions_completed, 0),
        founded: new Date(unit.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        foundedIso: new Date(unit.created_at).toISOString(),
        record: { wins: unit.war_wins, losses: unit.war_losses, draws: unit.war_draws },
      },
      requirements: units.requirementList(unit),
      requirementFields: Object.entries(units.REQUIREMENTS).map(([key, def]) => ({ key, label: def.label, max: def.max, value: unit[key] || '' })),
      war: activeWar ? warView(activeWar, unit.id, now) : null,
      warHistory: warService.history(unit.id, 10).filter((w) => w.status === 'ended').map((w) => warView(w, unit.id, now)),
      declare: myUnit && myUnit.id !== unit.id ? {
        from: myUnit,
        stake: wars.WAR_STAKE,
        blocker: wars.declareBlocker(myUnit, unit, warService.context(myUnit, unit), now),
      } : null,
      title: unit.name,
      nav: member ? 'unit' : null,
      unit: { ...unit, descriptionHtml: bbcode.render(unit.description), capacity: units.capacity(unit), xpBonusPct: Math.round(units.xpBonus(unit) * 100), position: unitRepo.position(unit.id) },
      role,
      roleLabel: role ? units.roleLabel(role) : null,
      can: {
        review: units.can.review(role),
        moderate: units.can.moderate(role),
        manage: units.can.manage(role),
      },
      roster,
      members,
      upgrades: Object.entries(units.UPGRADES).map(([key, def]) => ({
        key, ...def, level: unit[key] || 0, max: def.costs.length, next: units.nextUpgrade(unit, key), now: def.effect(unit[key] || 0),
      })),
      lookingCount: units.can.review(role) ? unitRepo.lookingCount(now) : 0,
      applications: units.can.review(role) ? unitRepo.pendingForUnit(unit.id).map((a) => ({ ...a, html: bbcode.render(a.message), ago: presence.timeAgo(a.created_at, now) })) : [],
      objectives: objectiveService ? objectiveService.view(unit.id, now) : null,
      rally: (() => {
        const avg = roster.reduce((n, m) => n + m.level, 0) / Math.max(1, roster.length);
        return {
          ...units.RALLY,
          pct: Math.round(units.RALLY.bonus * 100),
          active: unit.rally_until > now ? unit.rally_until : null,
          readyAt: Math.max(now, (unit.rally_at || 0) + units.RALLY.cooldownMs),
          cost: units.rallyCost(roster.length, avg),
          canCall: units.can.rally(role),
        };
      })(),
      raid: member && raidService ? raidService.view(unit, req.player, role, now) : null,
      raidShare: raids.TREASURY_SHARE,
      theatre: member && theatreService ? theatreService.summary(unit.id, now) : null,
      chain: Object.entries(units.ROLES).map(([key, r]) => ({ key, label: r.label })),
      crests: cosmetics && (units.can.manage(role) || req.player.is_admin) ? cosmetics.crests(unit.id) : [],
      crestGrants: cosmetics && req.player.is_admin ? cosmetics.unitGrantsFor(unit.id) : [],
      posts: member ? unitRepo.posts(unit.id).map((p) => ({ ...p, html: bbcode.render(p.body), ago: presence.timeAgo(p.created_at, now), canDelete: p.user_id === req.player.id || units.can.moderate(role) })) : [],
      log: member ? unitRepo.recentLog(unit.id).map((l) => ({ ...l, ago: presence.timeAgo(l.created_at, now) })) : [],
      apply: member ? null : {
        blocker: units.applyBlocker(req.player, unit, {
          members,
          pending: unitRepo.pendingCount(req.player.id),
          alreadyApplied: false,
        }, now),
        applied: unitRepo.hasApplied(unit.id, req.player.id),
      },
      limits: { post: units.MAX_POST, message: units.MAX_APPLY_MESSAGE, description: units.MAX_DESCRIPTION, minDonation: units.MIN_DONATION },
    });
  });

  router.post('/units/:id/apply', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit }) => {
    const blocker = units.applyBlocker(me, unit, {
      members: unitRepo.memberCount(unit.id),
      pending: unitRepo.pendingCount(me.id),
      alreadyApplied: unitRepo.hasApplied(unit.id, me.id),
    });
    if (blocker) return { error: blocker };
    if (autoAccepts(unit)) {
      // HQ starter units take everyone who applies, straight away.
      if (!unitRepo.join(unit.id, me.id)) return { error: 'You’re already in a unit.' };
      unitRepo.log(unit.id, 'join', `${me.username} joined.`);
      players.log(me.id, 'unit', `Joined ${unit.name} [${unit.tag}].`, `/units/${unit.id}`);
      return { ok: `Welcome to ${unit.name}. HQ starter units take everyone who applies.` };
    }
    const message = String(req.body.message || '').trim().slice(0, units.MAX_APPLY_MESSAGE);
    unitRepo.apply(unit.id, me.id, message);
    notifyAll(unitRepo.officerIds(unit.id), `${me.username} (level ${me.level}) applied to join ${unit.name}.`, `/units/${unit.id}#applications`);
    return { ok: `Application sent to ${unit.name}. Their officers will review it.` };
  }));

  router.post('/units/:id/withdraw', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit }) => (
    unitRepo.withdraw(unit.id, me.id) ? { ok: `Application to ${unit.name} withdrawn.` } : { error: 'You have no application with this unit.' }
  ), '/units'));

  router.post('/units/:id/applications/:appId/:decision', requireAuth, oneOf('decision', ['accept', 'reject']), loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!units.can.review(role)) return { error: 'Only officers can review applications.' };
    const app = unitRepo.application(Number(req.params.appId), unit.id);
    if (!app) return { error: 'That application is no longer open.' };
    const applicant = players.findById(app.user_id);
    unitRepo.deleteApplication(app.id);
    if (req.params.decision === 'reject') {
      players.notify(applicant.id, 'unit', `${unit.name} turned down your application.`, '/units');
      return { ok: `Application from ${applicant.username} rejected.` };
    }
    if (unitRepo.memberCount(unit.id) >= units.capacity(unit)) return { error: `${unit.name} is full. Upgrade the Barracks to take more members.` };
    if (applicant.banned_at) return { error: `${applicant.username} is suspended.` };
    if (!unitRepo.join(unit.id, applicant.id)) return { error: `${applicant.username} has already joined another unit.` };
    unitRepo.log(unit.id, 'join', `${applicant.username} joined, accepted by ${me.username}.`);
    players.log(applicant.id, 'unit', `Joined ${unit.name} [${unit.tag}].`, `/units/${unit.id}`);
    players.notify(applicant.id, 'unit', `Welcome to ${unit.name}. Your application was accepted.`, `/units/${unit.id}`);
    return { ok: `${applicant.username} has joined ${unit.name}.` };
  }, `${urlOf(req.unit)}#applications`));

  router.post('/units/:id/leave', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!role) return { error: 'You’re not in this unit.' };
    if (role === 'leader') {
      if (unitRepo.memberCount(unit.id) > 1) return { error: 'Hand command to another member before you leave, or disband the unit.' };
      disband(unit.id);
      players.log(me.id, 'unit', `Disbanded ${unit.name} [${unit.tag}].`);
      return { ok: `${unit.name} has been disbanded.`, redirect: '/units' };
    }
    unitRepo.leave(unit.id, me.id);
    unitRepo.log(unit.id, 'leave', `${me.username} left the unit.`);
    players.log(me.id, 'unit', `Left ${unit.name} [${unit.tag}].`);
    return { ok: `You left ${unit.name}.`, redirect: '/units' };
  }));

  const memberAction = (action, userIdOf) => (req, res) => act(req, res, ({ me, unit, role }) => {
    const target = targetMember(unit, userIdOf(req));
    if (!role) return { error: 'You’re not in this unit.' };
    if (!target) return { error: 'That soldier isn’t in this unit.' };
    if (target.id === me.id) return { error: 'Pick another member.' };
    const link = `/units/${unit.id}`;
    switch (action) {
      case 'kick':
        if (!units.can.kick(role, target.unit_role)) return { error: 'You can only remove members below your rank.' };
        unitRepo.kick(unit.id, target.id);
        unitRepo.log(unit.id, 'kick', `${target.username} was removed by ${me.username}.`);
        players.log(target.id, 'unit', `Removed from ${unit.name} [${unit.tag}].`);
        players.notify(target.id, 'unit', `You were removed from ${unit.name}.`, '/units');
        return { ok: `${target.username} has been removed.` };
      case 'promote': {
        if (!units.can.promote(role, target.unit_role)) {
          return { error: units.rankOf(role) < 3 ? 'Only Lieutenants and the Commander can promote.' : `You can’t promote ${target.username} any further.` };
        }
        const next = units.promotedRole(target.unit_role);
        const label = units.roleLabel(next);
        unitRepo.setRole(unit.id, target.id, next);
        unitRepo.log(unit.id, 'promote', `${me.username} promoted ${target.username} to ${label}.`);
        players.notify(target.id, 'unit', `You were promoted to ${label} in ${unit.name}. ${PROMOTION_PERKS[next] || ''}`.trim(), link);
        return { ok: `${target.username} is now a ${label}.` };
      }
      case 'demote': {
        if (!units.can.demote(role, target.unit_role)) return { error: `You can only demote Sergeants and Lieutenants below your rank.` };
        const prev = units.demotedRole(target.unit_role);
        const label = units.roleLabel(prev);
        unitRepo.setRole(unit.id, target.id, prev);
        unitRepo.log(unit.id, 'demote', `${me.username} demoted ${target.username} to ${label}.`);
        players.notify(target.id, 'unit', `You were demoted to ${label} in ${unit.name}.`, link);
        return { ok: `${target.username} is now a ${label}.` };
      }
      case 'transfer':
        if (!units.can.manage(role)) return { error: 'Only the Commander can hand over command.' };
        if (String(req.body.confirm || '').trim().toLowerCase() !== target.username.toLowerCase()) {
          return { error: `Type ${target.username} to confirm handing over command.` };
        }
        unitRepo.setRole(unit.id, target.id, 'leader');
        unitRepo.setRole(unit.id, me.id, 'officer');
        unitRepo.log(unit.id, 'transfer', `${me.username} handed command to ${target.username}.`);
        notifyAll(unitRepo.memberIds(unit.id), `${target.username} is now Commander of ${unit.name}.`, link, me.id);
        return { ok: `${target.username} now commands ${unit.name}. You are a Lieutenant.` };
      default:
        return { error: 'Unknown action.' };
    }
  }, `${urlOf(req.unit)}${action === 'transfer' ? '#command' : '#roster'}`);

  for (const action of ['kick', 'promote', 'demote']) {
    router.post(`/units/:id/members/:userId/${action}`, requireAuth, loadUnit, memberAction(action, (req) => req.params.userId));
  }
  router.post('/units/:id/transfer', requireAuth, loadUnit, memberAction('transfer', (req) => req.body.to));

  // Rally order: a Lieutenant or the Commander spends treasury on an hour of "Advance!" for every member.
  router.post('/units/:id/rally', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    const now = Date.now();
    if (!units.can.rally(role)) return { error: 'Only Lieutenants and the Commander can call a rally.' };
    if (unit.rally_until > now) return { error: 'A rally is already under way.' };
    const ready = (unit.rally_at || 0) + units.RALLY.cooldownMs;
    if (ready > now) return { error: `Your unit can call another rally in ${Math.ceil((ready - now) / 3600000)} hour${Math.ceil((ready - now) / 3600000) === 1 ? '' : 's'}.` };
    const roster = unitRepo.members(unit.id);
    const cost = units.rallyCost(roster.length, roster.reduce((n, m) => n + m.level, 0) / Math.max(1, roster.length));
    if (!unitRepo.startRally(unit.id, cost, now, now + units.RALLY.durationMs)) return { error: `A rally costs ${money(cost)} from the treasury, which has ${money(unit.treasury)}.` };
    const pct = Math.round(units.RALLY.bonus * 100);
    unitRepo.log(unit.id, 'rally', `${me.username} called a rally (${money(cost)}): ${units.RALLY.label} +${pct}% mission cash and XP for an hour.`);
    notifyAll(unitRepo.memberIds(unit.id), `${units.roleLabel(role)} ${me.username} called a rally: ${units.RALLY.label} +${pct}% mission and operation cash and XP for the next hour. Move out!`, `/missions`, me.id);
    return { ok: `Rally called: +${pct}% mission cash and XP for every member for the next hour.` };
  }, `${urlOf(req.unit)}#rally`));

  // Raids: a Lieutenant or the Commander buys supplies from the treasury; every member strikes with energy.
  router.post('/units/:id/raid', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!raidService) return { error: 'Raids are not available.' };
    const out = raidService.launch({ unit, role, me, strongholdId: req.body.stronghold });
    if (out.error) return out;
    return { ok: `Raid launched on the ${out.stronghold.name}. Your unit has 48 hours to bring it down.` };
  }, `${urlOf(req.unit)}#raid`));

  router.post('/units/:id/raid/strike', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!raidService) return { error: 'Raids are not available.' };
    if (!role) return { error: 'Only members can strike.' };
    const out = raidService.strike({ unitId: unit.id, userId: me.id });
    if (out.error) return out;
    if (out.won) return { ok: `Direct hit for ${out.damage.toLocaleString('en-US')} damage, and the ${out.stronghold.name} has fallen! The loot is shared out.` };
    return { ok: `Strike for ${out.damage.toLocaleString('en-US')} damage (you took ${out.hurt} damage in return). The ${out.stronghold.name} is at ${Math.round((out.raid.hp / out.raid.max_hp) * 100)}%.` };
  }, `${urlOf(req.unit)}#raid`));

  router.post('/units/:id/donate', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!role) return { error: 'Only members can donate.' };
    const fresh = game.applyRegen(me, Date.now());
    const d = units.parseDonation(req.body.amount, fresh.cash);
    if (d.error) return d;
    fresh.cash -= d.amount;
    players.save(fresh, { reason: 'unit-donation', ref: `unit:${unit.id}` });
    unitRepo.donate(unit.id, me.id, d.amount);
    unitRepo.log(unit.id, 'donation', `${me.username} donated ${money(d.amount)} to the treasury.`);
    if (objectiveService) objectiveService.track(me.id, 'donations', d.amount);
    return { ok: `Donated ${money(d.amount)} to the ${unit.name} treasury.` };
  }, `${urlOf(req.unit)}#treasury`));

  router.post('/units/:id/upgrades/:key', requireAuth, oneOf('key', Object.keys(units.UPGRADES)), loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!units.can.manage(role)) return { error: 'Only the Commander can spend the treasury.' };
    const next = units.nextUpgrade(unit, req.params.key);
    const def = units.UPGRADES[req.params.key];
    if (!next) return { error: `${def.label} is fully upgraded.` };
    if (unit.treasury < next.cost) return { error: `${def.label} level ${next.level} costs ${money(next.cost)}. The treasury has ${money(unit.treasury)}.` };
    if (!unitRepo.upgrade(unit.id, req.params.key, next.level - 1, next.cost)) return { error: 'The treasury changed. Try again.' };
    unitRepo.log(unit.id, 'upgrade', `${me.username} upgraded the ${def.label} to level ${next.level} (${def.effect(next.level)}) for ${money(next.cost)}.`);
    notifyAll(unitRepo.memberIds(unit.id), `${unit.name} upgraded its ${def.label} to level ${next.level}: ${def.effect(next.level)}.`, `/units/${unit.id}#treasury`, me.id);
    return { ok: `${def.label} upgraded to level ${next.level}.` };
  }, `${urlOf(req.unit)}#treasury`));

  router.post('/units/:id/settings', requireAuth, loadUnit, (req, res) => act(req, res, ({ unit, role }) => {
    if (!units.can.manage(role)) return { error: 'Only the Commander can change unit settings.' };
    const description = String(req.body.description || '').trim().replace(/\r\n/g, '\n');
    if (description.length > units.MAX_DESCRIPTION) return { error: `Keep the description under ${units.MAX_DESCRIPTION} characters.` };
    const reqs = units.parseRequirements(req.body);
    if (reqs.error) return reqs;
    unitRepo.settings(unit.id, { description, recruiting: req.body.recruiting === 'on', ...reqs });
    return { ok: 'Unit settings saved.' };
  }, `${urlOf(req.unit)}#command`));

  // The unit's crest style: the Commander picks from what the unit has earned or owns.
  router.post('/units/:id/crest', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!units.can.manage(role)) return { error: 'Only the Commander can change the crest.' };
    if (!cosmetics) return { error: 'Not available.' };
    const out = cosmetics.setCrest(unit.id, req.body.crest ? String(req.body.crest) : null);
    if (!out.error) unitRepo.log(unit.id, 'crest', `${me.username} changed the unit’s crest.`);
    return out;
  }, `${urlOf(req.unit)}#crest`));

  router.post('/units/:id/disband', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!units.can.manage(role)) return { error: 'Only the Commander can disband the unit.' };
    if (String(req.body.confirm || '').trim().toUpperCase() !== unit.tag.toUpperCase()) return { error: `Type the tag ${unit.tag} to confirm.` };
    const ids = unitRepo.memberIds(unit.id);
    disband(unit.id);
    notifyAll(ids, `${unit.name} has been disbanded by its Commander.`, '/units', me.id);
    players.log(me.id, 'unit', `Disbanded ${unit.name} [${unit.tag}].`);
    return { ok: `${unit.name} has been disbanded.`, redirect: '/units' };
  }, `${urlOf(req.unit)}#command`));

  router.post('/units/:id/posts', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    if (!role) return { error: 'Only members can post on the unit board.' };
    const body = String(req.body.body || '').trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    if (!body) return { error: 'Write something first.' };
    if (body.length > units.MAX_POST) return { error: `Posts are limited to ${units.MAX_POST} characters.` };
    const last = unitRepo.lastPostAt(me.id);
    if (last && Date.now() - last < units.POST_COOLDOWN_MS) return { error: 'Slow down: one post every 10 seconds.' };
    unitRepo.post(unit.id, me.id, body);
    return { ok: 'Posted to the unit board.' };
  }, `${urlOf(req.unit)}#board`));

  router.post('/units/:id/posts/:postId/delete', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    const post = unitRepo.postById(Number(req.params.postId), unit.id);
    if (!post) return { error: 'That post is gone.' };
    if (!role || (post.user_id !== me.id && !units.can.moderate(role))) return { error: 'You can only delete your own posts.' };
    unitRepo.deletePost(post.id);
    return { ok: 'Post deleted.' };
  }, `${urlOf(req.unit)}#board`));

  // ---- Finding recruits: players flag that they're looking, officers invite them ----
  router.post('/units/looking', requireAuth, (req, res) => {
    const on = req.body.looking === 'on';
    const out = players.transaction(() => {
      const me = players.findById(req.player.id);
      if (me.unit_id) return { error: 'You’re already in a unit.' };
      unitRepo.setLooking(me.id, on);
      return { ok: on ? 'You’re on the list of soldiers looking for a unit. Officers can now invite you.' : 'You’re off the list. Officers won’t see you as looking any more.' };
    });
    req.flash(out.error ? 'error' : 'success', out.error || out.ok);
    res.redirect('/units#looking');
  });

  router.post('/units/invites/:inviteId/:decision', requireAuth, oneOf('decision', ['accept', 'decline']), (req, res) => {
    const out = players.transaction(() => {
      const me = players.findById(req.player.id);
      const invite = unitRepo.invitation(Number(req.params.inviteId), me.id);
      if (!invite) return { error: 'That invitation has expired.' };
      const unit = unitRepo.findById(invite.unit_id);
      if (!unit) { unitRepo.deleteInvite(invite.id); return { error: 'That unit has been disbanded.' }; }
      if (req.params.decision === 'decline') {
        unitRepo.deleteInvite(invite.id);
        return { ok: `You turned down the invitation from ${unit.name}.` };
      }
      if (me.unit_id) return { error: 'You’re already in a unit. Leave it first.' };
      const blocker = units.cooldownBlocker(me);
      if (blocker) return { error: blocker };
      if (unitRepo.memberCount(unit.id) >= units.capacity(unit)) return { error: `${unit.name} is full now. Ask their officers to make room.` };
      if (!unitRepo.join(unit.id, me.id)) return { error: 'You’re already in a unit.' };
      const by = invite.invited_by ? players.findById(invite.invited_by) : null;
      unitRepo.log(unit.id, 'join', `${me.username} joined, invited by ${by ? by.username : 'an officer'}.`);
      players.log(me.id, 'unit', `Joined ${unit.name} [${unit.tag}].`, `/units/${unit.id}`);
      const told = new Set([...unitRepo.officerIds(unit.id), ...(by && by.unit_id === unit.id ? [by.id] : [])]);
      notifyAll(told, `${me.username} accepted ${by ? `${by.username}’s` : 'your'} invitation and joined ${unit.name}.`, `/units/${unit.id}#roster`, me.id);
      return { ok: `Welcome to ${unit.name}.`, redirect: `/units/${unit.id}` };
    });
    req.flash(out.error ? 'error' : 'success', out.error || out.ok);
    res.redirect(out.redirect || '/units#invites');
  });

  router.get('/units/:id/recruits', requireAuth, loadUnit, (req, res) => {
    const { unit, role } = req;
    if (!units.can.review(role)) {
      req.flash('error', 'Only Sergeants and above can invite recruits.');
      return res.redirect(urlOf(unit));
    }
    const now = Date.now();
    const members = unitRepo.memberCount(unit.id);
    res.render('unit-recruits', {
      title: `Recruits · ${unit.name}`,
      nav: 'unit',
      unit: { ...unit, capacity: units.capacity(unit) },
      members,
      sentToday: unitRepo.invitesSentToday(unit.id, now),
      maxInvites: units.MAX_INVITES_PER_DAY,
      requirements: units.requirementList(unit),
      recruits: unitRepo.looking(unit.id, { now }).map((r) => {
        const rank = game.rankFor(r.level);
        return {
          ...r,
          avatarUrl: `/avatars/${r.id}?v=${r.avatar_v || 0}`,
          rank: rank.name,
          grade: rank.grade,
          online: presence.isOnline(r, now),
          lastSeen: presence.timeAgo(r.last_seen_at, now),
          since: presence.timeAgo(r.lfu_at, now),
          unmet: units.unmetRequirement(r, unit),
        };
      }),
    });
  });

  router.post('/units/:id/invite', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit, role }) => {
    const target = players.findById(Number(req.body.user));
    const now = Date.now();
    const blocker = units.inviteBlocker(role, unit, target, {
      members: unitRepo.memberCount(unit.id),
      sentToday: unitRepo.invitesSentToday(unit.id, now),
      invited: target ? unitRepo.invitedRecently(unit.id, target.id, now) : false,
    });
    if (blocker) return { error: blocker, redirect: units.can.review(role) ? undefined : urlOf(unit) };
    unitRepo.pruneInvites(now);
    unitRepo.invite(unit.id, target.id, me.id, now);
    unitRepo.log(unit.id, 'invite', `${me.username} invited ${target.username} to join.`);
    players.notify(target.id, 'unit', `${units.roleLabel(role)} ${me.username} invited you to join ${unit.name} [${unit.tag}]. Accept it on the Units page.`, '/units#invites');
    return { ok: `Invitation sent to ${target.username}. It lasts a week.` };
  }, `${urlOf(req.unit)}/recruits`));

  router.post('/units/:id/war', requireAuth, loadUnit, (req, res) => act(req, res, ({ me, unit: target }) => {
    if (me.unit_role !== 'leader') return { error: 'Only a unit Commander can declare war.' };
    const mine = unitRepo.findById(me.unit_id);
    const out = warService.declare({ me, attacker: mine, target });
    if (out.error) return out;
    return { ok: `War declared on ${target.name}! It lasts 24 hours. Every PvP win against them scores.`, redirect: `/wars/${out.warId}` };
  }));

  router.get('/wars', requireAuth, (req, res) => {
    warService.finishDue();
    const now = Date.now();
    res.render('wars', {
      title: 'Unit wars',
      nav: 'unit',
      active: warService.active().map((w) => warView(w, req.player.unit_id, now)),
      recent: warService.recent(15).map((w) => warView(w, req.player.unit_id, now)),
      rules: { stake: wars.WAR_STAKE, minMembers: wars.MIN_WAR_MEMBERS, hours: wars.WAR_DURATION_MS / 3_600_000, rematchHours: wars.REMATCH_COOLDOWN_MS / 3_600_000 },
    });
  });

  router.get('/wars/:warId', requireAuth, (req, res, next) => {
    warService.finishDue();
    const id = Number(req.params.warId);
    const war = Number.isInteger(id) ? warService.findById(id) : null;
    if (!war) return next();
    const now = Date.now();
    const top = warService.top(war.id);
    res.render('war', {
      title: `${war.attacker_tag} vs ${war.defender_tag}`,
      nav: 'unit',
      war: warView(war, req.player.unit_id, now),
      top: { attacker: top.filter((t) => t.side === 'attacker'), defender: top.filter((t) => t.side === 'defender') },
      fights: warService.fights(war.id).map((f) => ({ ...f, ago: presence.timeAgo(f.created_at, now) })),
      yourSide: req.player.unit_id === war.attacker_unit_id ? 'attacker' : req.player.unit_id === war.defender_unit_id ? 'defender' : null,
    });
  });

  // Admin moderation: rename an offensive unit or disband it outright.
  const adminOnly = (req, res, next) => (req.player.is_admin ? next() : next('route'));

  router.post('/units/:id/admin/rename', requireAuth, adminOnly, loadUnit, (req, res) => act(req, res, ({ me, unit }) => {
    const v = units.validateUnit({ name: req.body.name, tag: req.body.tag, description: '' });
    if (v.error) return v;
    const taken = unitRepo.taken(v.name, v.tag);
    if (taken.name && v.name.toLowerCase() !== unit.name.toLowerCase()) return { error: `There’s already a unit called ${v.name}.` };
    if (taken.tag && v.tag !== unit.tag.toUpperCase()) return { error: `The tag [${v.tag}] is taken.` };
    unitRepo.rename(unit.id, v.name, v.tag);
    unitRepo.log(unit.id, 'admin', `HQ renamed the unit from ${unit.name} [${unit.tag}] to ${v.name} [${v.tag}].`);
    adminRepo.log(me.id, null, 'unit-rename', `${unit.name} [${unit.tag}] → ${v.name} [${v.tag}] (unit ${unit.id})`);
    notifyAll(unitRepo.memberIds(unit.id), `HQ renamed your unit to ${v.name} [${v.tag}].`, `/units/${unit.id}`);
    return { ok: `Renamed to ${v.name} [${v.tag}].` };
  }));

  // Admin: give a unit a crest, or take one back.
  router.post('/units/:id/admin/cosmetics', requireAuth, adminOnly, loadUnit, (req, res) => act(req, res, ({ me, unit }) => {
    if (!cosmetics) return { error: 'Not available.' };
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
    const revoke = req.body.action === 'revoke';
    const out = revoke ? cosmetics.revoke({ unitId: unit.id, id: req.body.cosmetic }) : cosmetics.grant({ unitId: unit.id, id: req.body.cosmetic, by: me.id });
    if (out.error) return out;
    adminRepo.log(me.id, null, revoke ? 'cosmetic-revoke' : 'cosmetic-grant', `${revoke ? 'Took' : 'Gave'} the ${out.cosmetic.name} crest ${revoke ? 'from' : 'to'} ${unit.name} [${unit.tag}] (unit ${unit.id}). Reason: ${reason}`);
    if (!revoke) notifyAll(unitRepo.officerIds(unit.id), `HQ gave ${unit.name} the ${out.cosmetic.name} crest. The Commander can put it on from the unit page.`, `/units/${unit.id}#crest`);
    return { ok: `${revoke ? 'Took back' : 'Gave'} the ${out.cosmetic.name} crest.` };
  }, `${urlOf(req.unit)}#admin`));

  router.post('/units/:id/admin/disband', requireAuth, adminOnly, loadUnit, (req, res) => act(req, res, ({ me, unit }) => {
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    const ids = unitRepo.memberIds(unit.id);
    disband(unit.id);
    adminRepo.log(me.id, null, 'unit-disband', `${unit.name} [${unit.tag}] (unit ${unit.id})${reason ? `: ${reason}` : ''}`);
    notifyAll(ids, `HQ disbanded ${unit.name}${reason ? `: ${reason}` : '.'}`, '/units');
    return { ok: `${unit.name} disbanded.`, redirect: '/units' };
  }));

  return router;
}

module.exports = { unitRoutes };
