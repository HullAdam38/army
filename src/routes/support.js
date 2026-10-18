'use strict';

const express = require('express');
const support = require('../support');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

/** Help & support: a player's tickets with HQ Support. */
function supportRoutes(players, supportService) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const limits = { subject: support.MAX_SUBJECT, body: support.MAX_BODY };

  router.get('/support', requireAuth, (req, res) => {
    const now = Date.now();
    res.render('support', {
      title: 'Help & support',
      nav: 'support',
      tickets: supportService.mine(req.player.id).map((t) => ({ ...t, ago: presence.timeAgo(t.updated_at, now) })),
      blocker: supportService.canOpen(req.player.id, now),
    });
  });

  router.get('/support/new', requireAuth, (req, res) => {
    const draft = req.session.supportDraft || {};
    delete req.session.supportDraft;
    res.render('support-new', {
      title: 'New support ticket',
      nav: 'support',
      categories: support.CATEGORIES,
      draft: { category: draft.category || String(req.query.category || ''), subject: draft.subject || '', body: draft.body || '' },
      limits,
      blocker: supportService.canOpen(req.player.id),
    });
  });

  router.post('/support', requireAuth, (req, res) => {
    const me = players.findById(req.player.id);
    const out = players.transaction(() => supportService.open({ me, category: req.body.category, subject: req.body.subject, body: req.body.body }));
    if (out.error) {
      // Keep what they wrote so nothing is lost.
      req.session.supportDraft = {
        category: String(req.body.category || '').slice(0, 20),
        subject: String(req.body.subject || '').slice(0, support.MAX_SUBJECT),
        body: String(req.body.body || '').slice(0, support.MAX_BODY),
      };
      req.flash('error', out.error);
      return res.redirect('/support/new');
    }
    req.flash('success', `Ticket #${out.ticket.id} sent. HQ Support will reply here, and you’ll get a notification.`);
    res.redirect(`/support/${out.ticket.id}`);
  });

  router.get('/support/:id', requireAuth, (req, res, next) => {
    const view = supportService.forPlayer(req.player.id, req.params.id);
    if (!view) return next();
    const now = Date.now();
    const draft = req.session.supportReply || '';
    delete req.session.supportReply;
    res.render('support-ticket', {
      title: view.ticket.subject,
      nav: 'support',
      ...view,
      messages: view.messages.map((m) => ({ ...m, ago: presence.timeAgo(m.created_at, now), when: new Date(m.created_at).toISOString() })),
      draft,
      limits,
    });
  });

  router.post('/support/:id/reply', requireAuth, (req, res) => {
    const me = players.findById(req.player.id);
    const out = players.transaction(() => supportService.playerReply({ me, ticketId: req.params.id, body: req.body.body }));
    if (out.error) {
      req.session.supportReply = String(req.body.body || '').slice(0, support.MAX_BODY);
      req.flash('error', out.error);
    } else if (out.reopened) req.flash('success', 'Ticket reopened. HQ Support will take another look.');
    res.redirect(`/support/${Number(req.params.id) || ''}#latest`);
  });

  router.post('/support/:id/close', requireAuth, (req, res) => {
    const me = players.findById(req.player.id);
    const out = players.transaction(() => supportService.playerClose({ me, ticketId: req.params.id }));
    req.flash(out.error ? 'error' : 'success', out.error || 'Ticket closed. Reply on it any time to reopen it.');
    res.redirect(`/support/${Number(req.params.id) || ''}`);
  });

  return router;
}

module.exports = { supportRoutes };
