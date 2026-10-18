'use strict';

const express = require('express');
const game = require('../game');
const { wantsJson } = require('../middleware');
const presence = require('../presence');
const armory = require('../armory');
const { loadoutView } = armory;
const pvp = require('../pvp');
const { createRequireAuth } = require('../require-auth');
const { PLAYER_SORTS } = require('../players');
const { announceLevels } = require('../notify');
const scouting = require('../scouting');
const training = require('../training');
const units = require('../units');
const bounties = require('../bounties');
const bbcode = require('../bbcode');
const perks = require('../perks');
const operations = require('../operations');
const baseRules = require('../base');
const seasonRules = require('../seasons');
const tuning = require('../tuning');
const titles = require('../titles');

const PLAYER_FILTERS = ['all', 'targets', 'online', 'war'];
const PAGE_SIZE = 25;

function gameRoutes(players, daily, unitRepo, warService, medalService, bountyService, tutorialService, operationService, eventService, seasonService, targetService = null, theatreService = null) {
  const router = express.Router();

  const requireAuth = createRequireAuth(players);
  const statsOf = (user) => armory.statsOf(players, user);
  /** Mission XP and pay bonuses from the player's unit Drill ground and rank perks. */
  const bonusesFor = (user) => {
    const unit = user.unit_id ? unitRepo.findById(user.unit_id) : null;
    const p = perks.perksFor(user.level);
    const e = eventService.effects(); // Double XP / Payday multiply everything else
    // …and so do the admin pay and XP settings.
    const rally = units.rallyBonus(unit); // a unit's "Advance!" rally order
    const region = theatreService && unit ? theatreService.xpBonus(unit.id) : 0; // regions held on the theatre of war
    return {
      xpBonus: (1 + units.xpBonus(unit) + rally + region + p.missionXp) * e.xpMult * tuning.get('missionXpMult') - 1,
      cashBonus: (1 + rally + p.missionCash) * e.cashMult * tuning.get('missionCashMult') - 1,
    };
  };

  router.get('/hq', requireAuth, (req, res) => {
    tutorialService.check(req.player.id);
    medalService.check(req.player.id); // e.g. defences or war wins since the last action
    const missions = game.missionViews(req.player, Date.now(), statsOf(req.player));
    const nextMission = missions.find((m) => !m.blocker) || null;
    res.render('hq', {
      title: 'Headquarters',
      nav: 'hq',
      activity: players.recentActivity(req.player.id),
      nextMission,
      daily: daily.view(req.player),
      medalCount: medalService.rackFor(req.player.id).length,
      recruitReward: tuning.get('referralCash'),
      training: tutorialService.view(req.player.id),
      nextRank: game.nextRankFor(req.player.level),
      nextPerk: perks.nextPerk(req.player.level),
      base: (() => {
        const p = req.player;
        const building = p.base_build && p.base_build_until > Date.now() ? baseRules.FACILITIES_BY_ID.get(p.base_build) : null;
        return { unlocked: p.level >= baseRules.UNLOCK_LEVEL, unlockLevel: baseRules.UNLOCK_LEVEL, rating: baseRules.baseRating(p), maxRating: baseRules.maxRating, building, until: p.base_build_until };
      })(),
      season: (() => {
        const s = seasonService.current();
        return s ? { number: s.number, placement: seasonRules.placementFights(), ...seasonService.standing(s, req.player.id) } : null;
      })(),
      upcomingEvents: eventService.upcoming(Date.now(), 3).filter((e) => e.starts_at - Date.now() < 7 * 24 * 3600 * 1000),
      loadout: loadoutView(req.player.level, players.equipment(req.player.id), req.player),
      feed: players.recentBattles(6).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at) })),
      target: targetService && req.player.level >= pvp.MIN_PVP_LEVEL ? targetService.view(req.player) : null,
      // No unit yet: invitations waiting, and a few units recruiting players like them.
      unitHelp: !req.player.unit_id && req.player.level >= pvp.MIN_PVP_LEVEL ? (() => {
        const invites = unitRepo.invitesFor(req.player.id).length;
        const recommended = unitRepo.recommended(req.player, { limit: 2 }).map((u) => ({ ...u, capacity: units.capacity(u) }));
        return invites || recommended.length ? { invites, recommended, looking: Boolean(req.player.lfu_at) } : null;
      })() : null,
    });
  });

  // Basic training checklist: hide it, or bring it back.
  router.post('/tutorial/:action', requireAuth, (req, res, next) => {
    if (!['hide', 'show'].includes(req.params.action)) return next();
    tutorialService.setDismissed(req.player.id, req.params.action === 'hide');
    res.redirect(req.params.action === 'show' ? '/hq#training-title' : '/hq');
  });

  router.get('/missions', requireAuth, (req, res) => {
    const now = Date.now();
    const me = game.applyRegen(req.player, now);
    const stats = statsOf(req.player);
    const missions = game.missionViews(req.player, now, stats);
    const progress = operationService.progressFor(me.id, now);
    const bonus = bonusesFor(me);
    res.render('missions', {
      title: 'Missions',
      nav: 'missions',
      // Campaigns you've reached and the next one show in full; later ones collapse to a teaser.
      campaigns: (() => {
        let nextShown = false;
        return game.CAMPAIGNS.map((c) => {
          const list = missions.filter((m) => m.campaign === c.id);
          const opensAt = Math.min(...list.map((m) => m.minLevel));
          let state = 'open';
          if (opensAt > me.level) { state = nextShown ? 'teaser' : 'next'; nextShown = true; }
          return { ...c, missions: list, opensAt, state };
        });
      })(),
      missions,
      laterOps: operations.OPERATIONS.filter((op) => op.minLevel > me.level).length - (operations.OPERATIONS.some((op) => op.minLevel > me.level) ? 1 : 0),
      operations: operations.OPERATIONS.filter((op, i, all) => op.minLevel <= me.level || all.findIndex((o) => o.minLevel > me.level) === i).map((op) => {
        const pr = progress.get(op.id);
        const stage = pr.stage ? op.stages[pr.stage - 1] : null;
        return {
          ...op,
          ...pr,
          locked: me.level < op.minLevel,
          next: stage ? { ...stage, blocker: game.missionBlocker(stage, me, now), chancePct: Math.round(game.successChance(stage, me, stats) * 100) } : null,
        };
      }),
      perks: { unlocked: perks.unlocked(me.level), next: perks.nextPerk(me.level), bonus },
      result: null,
    });
  });

  router.post('/missions/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      // Re-read inside the transaction so we act on the freshest state.
      const fresh = players.findById(req.player.id);
      const out = game.runMission(req.params.id, fresh, { stats: statsOf(fresh), ...bonusesFor(fresh) });
      if (out.error) return out;
      players.save(out.player, { reason: 'mission', ref: req.params.id });
      const r = out.result;
      players.log(
        fresh.id,
        r.success ? 'success' : 'failure',
        r.success
          ? `${r.missionName}: objective secured. +${r.xp} XP, +$${r.cash}.`
          : `${r.missionName}: mission failed. Took ${r.damage} damage${r.absorbed ? ` (armour absorbed ${r.absorbed})` : ''}, +${r.xp} XP.`,
      );
      for (const lvl of r.levelsGained) {
        const rank = game.rankFor(lvl);
        players.log(fresh.id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
      }
      announceLevels(players, fresh.id, r.levelsGained);
      if (r.success) {
        daily.progress(fresh.id, 'missions_won', 1);
        daily.progress(fresh.id, 'mission_specific', 1, { param: req.params.id });
        daily.progress(fresh.id, 'mission_cash', r.cash);
      }
      return out;
    });

    if (!outcome.error) res.locals.gains = { xp: outcome.result.xp, cash: outcome.result.cash }; // for anti-cheat
    const latest = players.findById(req.player.id);
    if (wantsJson(req)) {
      return res.status(outcome.error ? 409 : 200).json({
        ok: !outcome.error,
        error: outcome.error || null,
        result: outcome.result || null,
        player: game.playerView(latest),
        missions: game.missionViews(latest, Date.now(), statsOf(latest)).map(({ id, blocker, chancePct, locked }) => ({ id, blocker, chancePct, locked })),
      });
    }

    if (outcome.error) {
      req.flash('error', outcome.error);
    } else {
      const r = outcome.result;
      req.flash(
        r.success ? 'success' : 'error',
        r.success
          ? `${r.missionName} complete. +${r.xp} XP, +$${r.cash}.`
          : `${r.missionName} failed. You took ${r.damage} damage${r.absorbed ? ` (armour absorbed ${r.absorbed})` : ''} but earned ${r.xp} XP.`,
      );
      if (r.levelsGained.length) {
        req.flash('success', `Promotion! You are now level ${r.levelsGained.at(-1)}.`);
      }
    }
    res.redirect('/missions');
  });

  router.post('/operations/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      return operationService.run(fresh.id, String(req.params.id), { stats: statsOf(fresh), ...bonusesFor(fresh) });
    });
    if (outcome.error) {
      req.flash('error', outcome.error);
    } else {
      const { op, stage, result: r, completed, bonus } = outcome;
      res.locals.gains = { xp: r.xp + (bonus ? bonus.xp : 0), cash: r.cash + (bonus ? bonus.cash : 0) }; // for anti-cheat
      if (r.success) daily.progress(req.player.id, 'missions_won', 1);
      req.flash(r.success ? 'success' : 'error', r.success
        ? `${op.name} · ${stage.name}: done. +${r.xp} XP, +$${r.cash.toLocaleString('en-US')}.`
        : `${op.name} · ${stage.name}: failed. You took ${r.damage} damage but earned ${r.xp} XP. Try the stage again.`);
      if (completed) req.flash('success', `${op.name} complete! Bonus +$${bonus.cash.toLocaleString('en-US')} and +${bonus.xp} XP.`);
      if (outcome.levelsGained.length) req.flash('success', `Promotion! You are now level ${outcome.levelsGained.at(-1)}.`);
    }
    res.redirect(`/missions#op-${req.params.id}`);
  });

  router.get('/online', requireAuth, (req, res) => {
    const now = Date.now();
    const soldiers = players.listOnline(now - presence.ONLINE_WINDOW_MS).map((u) => {
      const rank = game.rankFor(u.level);
      return {
        username: u.username,
        avatarUrl: `/avatars/${u.id}?v=${u.avatar_v || 0}`,
        level: u.level,
        rank: rank.name,
        grade: rank.grade,
        lastSeen: presence.timeAgo(u.last_seen_at, now),
        hospitalized: Boolean(u.hospital_until && u.hospital_until > now),
        isYou: u.username === req.player.username,
        isBot: Boolean(u.is_bot),
      };
    });
    res.render('online', {
      title: 'Online',
      nav: 'online',
      soldiers,
      windowMinutes: presence.ONLINE_WINDOW_MS / 60000,
    });
  });

  router.get('/players', requireAuth, (req, res) => {
    const now = Date.now();
    const q = String(req.query.q || '').trim().slice(0, 20);
    const war = warService.activeFor(req.player.unit_id);
    const enemyUnitId = war ? (war.attacker_unit_id === req.player.unit_id ? war.defender_unit_id : war.attacker_unit_id) : null;
    let filter = PLAYER_FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    if (filter === 'war' && !enemyUnitId) filter = 'all';
    const sort = Object.hasOwn(PLAYER_SORTS, req.query.sort) ? req.query.sort : 'level';
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);

    const me = game.applyRegen(req.player, now);
    const { rows, total } = players.searchPlayers({
      q, filter, sort, me, now, enemyUnitId,
      onlineSince: now - presence.ONLINE_WINDOW_MS,
      targetRules: { minLevel: pvp.MIN_PVP_LEVEL, maxLevelsBelow: pvp.MAX_LEVELS_BELOW },
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    const cooldowns = players.recentTargets(me.id, now - pvp.PAIR_COOLDOWN_MS);
    const selfBlocker = pvp.selfBlocker(me, now);

    const list = rows.map((u) => {
      const rank = game.rankFor(u.level);
      const isYou = u.id === me.id;
      const targetBlocker = isYou ? null : pvp.targetBlocker(me, u, { now, lastAttackAt: cooldowns.get(u.id) || null });
      return {
        username: u.username,
        avatarUrl: `/avatars/${u.id}?v=${u.avatar_v || 0}`,
        level: u.level,
        rank: rank.name,
        grade: rank.grade,
        rating: loadoutView(u.level, players.equipment(u.id)).rating,
        wins: u.pvp_wins,
        losses: u.pvp_losses,
        hospitalized: game.isHospitalized(u, now),
        hospitalUntil: u.hospital_until,
        deployed: game.isDeployed(u, now),
        online: presence.isOnline(u, now),
        lastSeen: presence.timeAgo(u.last_seen_at, now),
        isYou,
        isBot: Boolean(u.is_bot),
        canAttack: !isYou && !selfBlocker && !targetBlocker,
        // Short reason for the row; the full sentence goes in the tooltip.
        blocker: targetBlocker,
      };
    });

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const urlFor = (changes) => {
      const params = new URLSearchParams({ q, filter, sort, page: String(page), ...changes });
      for (const [k, v] of [...params]) if (!v || (k === 'filter' && v === 'all') || (k === 'sort' && v === 'level') || (k === 'page' && v === '1')) params.delete(k);
      const qs = params.toString();
      return qs ? `/players?${qs}` : '/players';
    };

    res.render('players', {
      title: 'Players',
      nav: 'players',
      list, total, page, pages, q, filter, sort,
      war: war ? { id: war.id, enemyTag: war.attacker_unit_id === req.player.unit_id ? war.defender_tag : war.attacker_tag } : null,
      sorts: [['level', 'Level'], ['wins', 'PvP wins'], ['newest', 'Newest'], ['name', 'Name']],
      urlFor,
      selfBlocker,
      myRating: loadoutView(me.level, players.equipment(me.id), me).rating,
      attackEnergy: pvp.ATTACK_ENERGY,
      backUrl: req.originalUrl,
      target: targetService ? targetService.view(me) : null,
    });
  });

  router.get('/profile/:username', requireAuth, (req, res, next) => {
    const user = players.findByUsername(String(req.params.username));
    if (!user) return next(); // falls through to the 404 page
    const now = Date.now();
    const rank = game.rankFor(user.level);
    const total = user.missions_completed + user.missions_failed;
    const isYou = user.id === req.player.id;
    const me = game.applyRegen(req.player, now);
    const them = game.applyRegen(user, now);
    const attack = isYou ? null : {
      blocker: pvp.attackBlocker(me, them, { now, lastAttackAt: players.lastAttackAt(me.id, them.id) }),
      energy: pvp.ATTACK_ENERGY,
      yourRating: loadoutView(me.level, players.equipment(me.id), me).rating,
    };
    res.render('profile', {
      title: user.username,
      nav: user.id === req.player.id ? 'profile' : null,
      soldier: {
        id: user.id,
        isTarget: Boolean(targetService && targetService.isTarget(user.id)),
        username: user.username,
        avatarUrl: `/avatars/${user.id}?v=${user.avatar_v || 0}`,
        avatarIsUpload: user.avatar_kind === 'upload',
        title: titles.nameOf(user.title),
        level: user.level,
        rank: rank.name,
        grade: rank.grade,
        nextRank: game.nextRankFor(user.level),
        online: presence.isOnline(user, now),
        lastSeen: presence.timeAgo(user.last_seen_at, now),
        enlisted: new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        enlistedIso: new Date(user.created_at).toISOString(),
        missionsCompleted: user.missions_completed,
        missionsFailed: user.missions_failed,
        successRate: total ? Math.round((user.missions_completed / total) * 100) : null,
        pvpWins: user.pvp_wins,
        pvpLosses: user.pvp_losses,
        hospitalized: game.isHospitalized(them, now),
        hospitalUntil: them.hospital_until,
        deployed: game.isDeployed(them, now),
        deployedUntil: them.deploy_until,
        hospitalReason: them.hospital_reason,
        isYou,
        isBot: Boolean(user.is_bot),
        unit: (() => {
          const u = user.unit_id ? unitRepo.findById(user.unit_id) : null;
          return u ? { id: u.id, name: u.name, tag: u.tag, role: units.roleLabel(user.unit_role) } : null;
        })(),
      },
      attack,
      // Hidden stats: yours on your own profile, otherwise only intel you've paid for.
      ownTraining: isYou ? Object.keys(training.STATS).map((k) => training.statView(me, k)) : null,
      scout: isYou ? null : {
        cost: scouting.scoutCost(me, them),
        energy: scouting.SCOUT_ENERGY,
        blocker: scouting.scoutBlocker(me, them, now),
        intel: (() => {
          const r = players.latestScoutReport(me.id, them.id);
          return r ? { ...r.report, ago: presence.timeAgo(r.created_at, now) } : null;
        })(),
      },
      medals: medalService.rackFor(user.id),
      season: (() => {
        const s = seasonService.current();
        const st = s && seasonService.standing(s, user.id);
        return st && st.fights ? { number: s.number, ...st } : null;
      })(),
      seasonBadges: seasonService.badgesFor(user.id, 8),
      bioHtml: user.bio ? bbcode.render(user.bio) : '',
      blocked: isYou ? false : players.hasBlocked(req.player.id, user.id),
      bounty: {
        ...bountyService.totalOn(user.id, now),
        canPost: !isYou && user.level >= pvp.MIN_PVP_LEVEL && !user.banned_at,
        rules: { min: bounties.MIN_BOUNTY, feePct: Math.round(bounties.FEE_RATE * 100) },
      },
      battles: players.battlesFor(user.id, 6).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at, now) })),
      loadout: loadoutView(user.level, players.equipment(user.id)),
      activity: players.publicActivity(user.id).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
    });
  });

  return router;
}

module.exports = { gameRoutes };
