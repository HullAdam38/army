'use strict';

const express = require('express');
const game = require('../game');
const presence = require('../presence');
const { BOARDS, TOP, createLeaderboards } = require('../leaderboards');
const { createRequireAuth } = require('../require-auth');

function leaderboardRoutes(players, db) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const boards = createLeaderboards(db);

  router.get('/leaderboards', requireAuth, (req, res) => {
    const key = Object.hasOwn(BOARDS, req.query.board) ? req.query.board : 'level';
    const now = Date.now();
    const shape = (r) => {
      const rank = game.rankFor(r.level);
      return { ...r, grade: rank.grade, rank: rank.name, online: presence.isOnline(r, now), isYou: r.id === req.player.id };
    };
    const { rows, me } = boards.board(key, req.player.id, now);
    res.render('leaderboards', {
      title: 'Leaderboards',
      nav: 'players',
      key,
      board: BOARDS[key],
      boards: Object.entries(BOARDS).map(([k, b]) => ({ key: k, label: b.label })),
      rows: rows.map(shape),
      me: me ? shape(me) : null,
      top: TOP,
    });
  });

  return router;
}

module.exports = { leaderboardRoutes };
