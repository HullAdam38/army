'use strict';

const express = require('express');
const game = require('../game');
const { wantsJson } = require('../middleware');

function gameRoutes(players) {
  const router = express.Router();

  function requireAuth(req, res, next) {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user) {
      if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Signed out.' });
      if (req.method === 'GET') req.session.returnTo = req.originalUrl;
      req.flash('info', 'Sign in to report for duty.');
      return res.redirect('/login');
    }
    req.player = user;
    res.locals.player = game.playerView(user);
    next();
  }

  router.get('/hq', requireAuth, (req, res) => {
    const missions = game.missionViews(req.player);
    const nextMission = missions.find((m) => !m.blocker) || null;
    res.render('hq', {
      title: 'Headquarters',
      nav: 'hq',
      activity: players.recentActivity(req.player.id),
      nextMission,
      nextRank: game.nextRankFor(req.player.level),
    });
  });

  router.get('/missions', requireAuth, (req, res) => {
    res.render('missions', {
      title: 'Missions',
      nav: 'missions',
      missions: game.missionViews(req.player),
      result: null,
    });
  });

  router.post('/missions/:id', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      // Re-read inside the transaction so we act on the freshest state.
      const fresh = players.findById(req.player.id);
      const out = game.runMission(req.params.id, fresh);
      if (out.error) return out;
      players.save(out.player);
      const r = out.result;
      players.log(
        fresh.id,
        r.success ? 'success' : 'failure',
        r.success
          ? `${r.missionName}: objective secured. +${r.xp} XP, +$${r.cash}.`
          : `${r.missionName}: mission failed. Took ${r.damage} damage, +${r.xp} XP.`,
      );
      for (const lvl of r.levelsGained) {
        const rank = game.rankFor(lvl);
        players.log(fresh.id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
      }
      return out;
    });

    const latest = players.findById(req.player.id);
    if (wantsJson(req)) {
      return res.status(outcome.error ? 409 : 200).json({
        ok: !outcome.error,
        error: outcome.error || null,
        result: outcome.result || null,
        player: game.playerView(latest),
        missions: game.missionViews(latest).map(({ id, blocker, chancePct, locked }) => ({ id, blocker, chancePct, locked })),
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
          : `${r.missionName} failed. You took ${r.damage} damage but earned ${r.xp} XP.`,
      );
      if (r.levelsGained.length) {
        req.flash('success', `Promotion! You are now level ${r.levelsGained.at(-1)}.`);
      }
    }
    res.redirect('/missions');
  });

  router.post('/hospital', requireAuth, (req, res) => {
    const outcome = players.transaction(() => {
      const out = game.visitHospital(players.findById(req.player.id));
      if (out.error) return out;
      players.save(out.player);
      players.log(req.player.id, 'system', `Treated at the field hospital for $${out.cost}.`);
      return out;
    });
    req.flash(outcome.error ? 'error' : 'success', outcome.error || `Patched up for $${outcome.cost}. Back to full strength.`);
    res.redirect('/hq');
  });

  return router;
}

module.exports = { gameRoutes };
