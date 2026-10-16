'use strict';

const express = require('express');
const seasons = require('../seasons');
const { createRequireAuth } = require('../require-auth');

const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function seasonRoutes(players, seasonService, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  // Non-admins get the ordinary 404, like the rest of the admin area.
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  const rules = {
    divisions: seasons.DIVISIONS,
    podium: seasons.PODIUM,
    placement: seasons.PLACEMENT_FIGHTS,
    days: seasons.SEASON_DAYS,
    start: seasons.START_RATING,
    carry: seasons.CARRY_OVER,
  };

  router.get('/seasons', requireAuth, (req, res) => {
    const season = seasonService.rollover();
    const me = seasonService.standing(season, req.player.id);
    const standings = seasonService.standings(season, 50);
    res.render('seasons', {
      title: `Season ${season.number}`,
      nav: 'players',
      season: { ...season, startsLabel: fmtDate(season.starts_at), endsLabel: fmtDate(season.ends_at) },
      me,
      standings,
      youListed: standings.some((s) => s.user_id === req.player.id),
      placedCount: seasonService.placedCount(season),
      past: seasonService.past(12).map((s) => ({ ...s, you: seasonService.resultFor(s, req.player.id) })),
      rules,
    });
  });

  router.get('/seasons/:number', requireAuth, (req, res, next) => {
    const n = Number(req.params.number);
    const season = Number.isInteger(n) ? seasonService.byNumber(n) : null;
    if (!season) return next();
    if (season.status === 'active') return res.redirect('/seasons');
    const you = seasonService.resultFor(season, req.player.id);
    res.render('season', {
      title: `Season ${season.number} results`,
      nav: 'players',
      season: { ...season, startsLabel: fmtDate(season.starts_at), endsLabel: fmtDate(season.ended_at || season.ends_at) },
      results: seasonService.results(season, 100),
      you: you ? { ...you, division: seasons.DIVISIONS_BY_ID.get(you.division) } : null,
    });
  });

  router.post('/admin/seasons/end', adminOnly, requireAuth, (req, res) => {
    const ended = seasonService.endNow();
    if (!ended) {
      req.flash('error', 'No season is running.');
      return res.redirect('/seasons');
    }
    adminRepo.log(req.player.id, null, 'season-end', `Ended season ${ended.number} early`);
    req.flash('success', `Season ${ended.number} ended. Rewards paid and season ${ended.number + 1} has begun.`);
    res.redirect(`/seasons/${ended.number}`);
  });

  return router;
}

module.exports = { seasonRoutes };
