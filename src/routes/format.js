'use strict';

const express = require('express');
const bbcode = require('../bbcode');
const { createRequireAuth } = require('../require-auth');

const MAX_PREVIEW = 10000;

/** Shared endpoint behind every BBCode editor's Preview tab. */
function formatRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  // Renders a draft exactly as it will appear. Returns { html }.
  router.post('/format/preview', requireAuth, (req, res) => {
    const body = String((req.body && req.body.body) || '').slice(0, MAX_PREVIEW);
    res.set('Cache-Control', 'no-store');
    res.json({ html: bbcode.render(body) });
  });

  return router;
}

module.exports = { formatRoutes };
