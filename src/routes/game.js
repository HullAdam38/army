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

const PLAYER_FILTERS = ['all', 'targets', 'online'];
const PAGE_SIZE = 25;

function gameRoutes(players) {
  const router = express.Router();

  const requireAuth = createRequireAuth(players);
  const statsOf = (user) => armory.statsOf(players, user);

  router.get('/hq', requireAuth, (req, res) => {
    const missions = game.missionViews(req.player, Date.now(), statsOf(req.player));
    const nextMission = missions.find((m) => !m.blocker) || null;
    res.render('hq', {
      title: 'Headquarters',
      nav: 'hq',
      activity: players.recentActivity(req.player.id),
      nextMission,
      nextRank: game.nextRankFor(req.player.level),
      loadout: loadoutView(req.player.level, players.equipment(req.player.id)),
      feed: players.recentBattles(6).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at) })),
    });
  });

  router.get('/missions', requireAuth, (req, res) => {
    res.render('missions', {
      title: 'Missions',
      nav: 'missions',
      missions: game.missionViews(req.player, Date.now(), statsOf(req.player)),
      result: null,
    });
  });

  router.post('/missions/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      // Re-read inside the transaction so we act on the freshest state.
      const fresh = players.findById(req.player.id);
      const out = game.runMission(req.params.id, fresh, { stats: statsOf(fresh) });
      if (out.error) return out;
      players.save(out.player);
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
      return out;
    });

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

  router.get('/online', requireAuth, (req, res) => {
    const now = Date.now();
    const soldiers = players.listOnline(now - presence.ONLINE_WINDOW_MS).map((u) => {
      const rank = game.rankFor(u.level);
      return {
        username: u.username,
        level: u.level,
        rank: rank.name,
        grade: rank.grade,
        lastSeen: presence.timeAgo(u.last_seen_at, now),
        hospitalized: Boolean(u.hospital_until && u.hospital_until > now),
        isYou: u.username === req.player.username,
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
    const filter = PLAYER_FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const sort = Object.hasOwn(PLAYER_SORTS, req.query.sort) ? req.query.sort : 'level';
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);

    const me = game.applyRegen(req.player, now);
    const { rows, total } = players.searchPlayers({
      q, filter, sort, me, now,
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
        level: u.level,
        rank: rank.name,
        grade: rank.grade,
        rating: loadoutView(u.level, players.equipment(u.id)).rating,
        wins: u.pvp_wins,
        losses: u.pvp_losses,
        hospitalized: game.isHospitalized(u, now),
        hospitalUntil: u.hospital_until,
        online: presence.isOnline(u, now),
        lastSeen: presence.timeAgo(u.last_seen_at, now),
        isYou,
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
      sorts: [['level', 'Level'], ['wins', 'PvP wins'], ['newest', 'Newest'], ['name', 'Name']],
      urlFor,
      selfBlocker,
      myRating: loadoutView(me.level, players.equipment(me.id)).rating,
      attackEnergy: pvp.ATTACK_ENERGY,
      backUrl: req.originalUrl,
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
      yourRating: loadoutView(me.level, players.equipment(me.id)).rating,
    };
    res.render('profile', {
      title: user.username,
      nav: user.id === req.player.id ? 'profile' : null,
      soldier: {
        username: user.username,
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
        hospitalReason: them.hospital_reason,
        isYou,
      },
      attack,
      battles: players.battlesFor(user.id, 6).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at, now) })),
      loadout: loadoutView(user.level, players.equipment(user.id)),
      activity: players.publicActivity(user.id).map((a) => ({ ...a, ago: presence.timeAgo(a.created_at, now) })),
    });
  });

  return router;
}

module.exports = { gameRoutes };
