'use strict';

const express = require('express');
const bbcode = require('../bbcode');
const rules = require('../messages');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

const PAGE_SIZE = 25;

function messageRoutes(players, messages, push = null) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const limits = { body: rules.MAX_BODY, subject: rules.MAX_SUBJECT, reason: rules.MAX_REPORT_REASON };

  router.get('/messages', requireAuth, (req, res) => {
    const now = Date.now();
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const { rows, total } = messages.inbox(req.player.id, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    res.render('messages', {
      title: 'Messages',
      nav: 'messages',
      conversations: rows.map((c) => ({ ...c, ago: presence.timeAgo(c.last_message_at, now) })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  });

  router.get('/messages/new', requireAuth, (req, res) => {
    const draft = req.session.messageDraft || {};
    delete req.session.messageDraft;
    res.render('message-new', {
      title: 'New message',
      nav: 'messages',
      draft: { to: String(req.query.to || draft.to || '').slice(0, 20), subject: draft.subject || '', body: draft.body || '' },
      limits,
      canStart: req.player.level >= rules.MIN_LEVEL_TO_START,
      minLevel: rules.MIN_LEVEL_TO_START,
    });
  });

  router.post('/messages', requireAuth, (req, res) => {
    const out = players.transaction(() => messages.start({
      senderId: req.player.id,
      recipientName: req.body.to,
      subject: req.body.subject,
      body: req.body.body,
    }));
    if (out.error) {
      // Keep what they wrote so nothing is lost.
      req.session.messageDraft = {
        to: String(req.body.to || '').slice(0, 20),
        subject: String(req.body.subject || '').slice(0, rules.MAX_SUBJECT),
        body: String(req.body.body || '').slice(0, rules.MAX_BODY),
      };
      req.flash('error', out.error);
      return res.redirect('/messages/new');
    }
    if (push) push.message(out.recipientId, `${req.player.username}: ${out.subject}`, out.id);
    req.flash('success', `Message sent to ${out.recipient}.`);
    res.redirect(`/messages/${out.id}`);
  });

  router.get('/messages/blocked', requireAuth, (req, res) => {
    const now = Date.now();
    res.render('messages-blocked', {
      title: 'Blocked players',
      nav: 'messages',
      blocked: messages.blockedList(req.player.id).map((b) => ({ ...b, ago: presence.timeAgo(b.created_at, now) })),
    });
  });

  router.post('/messages/block', requireAuth, (req, res) => {
    const target = players.findByUsername(String(req.body.username || '').trim());
    const back = String(req.body.back || '');
    const to = back.startsWith('/') && !back.startsWith('//') ? back : '/messages/blocked';
    if (!target || target.id === req.player.id) {
      req.flash('error', target ? 'You can’t block yourself.' : 'No soldier by that callsign.');
      return res.redirect(to);
    }
    messages.block(req.player.id, target.id);
    req.flash('success', `${target.username} is blocked. They can’t message you, and you won’t see new messages from them.`);
    res.redirect(to);
  });

  router.post('/messages/unblock', requireAuth, (req, res) => {
    const target = players.findByUsername(String(req.body.username || '').trim());
    const back = String(req.body.back || '');
    if (target && messages.unblock(req.player.id, target.id)) req.flash('success', `${target.username} is unblocked.`);
    res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/messages/blocked');
  });

  router.post('/messages/report/:messageId', requireAuth, (req, res) => {
    const out = messages.report({ reporterId: req.player.id, messageId: Number(req.params.messageId), reason: req.body.reason });
    req.flash(out.error ? 'error' : 'success', out.error || 'Thanks. The message has been sent to the moderators, who will review it. You can also block the sender.');
    const back = String(req.body.back || '');
    res.redirect(back.startsWith('/messages/') && !back.startsWith('//') ? back : '/messages');
  });

  router.get('/messages/:id', requireAuth, (req, res, next) => {
    const id = Number(req.params.id);
    const thread = Number.isInteger(id) ? messages.thread(req.player.id, id) : null;
    if (!thread) return next();
    const now = Date.now();
    res.locals.unreadMessages = players.unreadMessageCount(req.player.id); // just marked read
    const draft = req.session.replyDraft && req.session.replyDraft.id === id ? req.session.replyDraft.body : '';
    delete req.session.replyDraft;
    res.render('message-thread', {
      title: thread.conversation.subject,
      nav: 'messages',
      ...thread,
      messages: thread.messages.map((m) => ({ ...m, ago: presence.timeAgo(m.created_at, now), when: new Date(m.created_at).toISOString() })),
      limits,
      draft,
      backUrl: `/messages/${id}`,
    });
  });

  router.post('/messages/:id/reply', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const out = players.transaction(() => messages.reply({ senderId: req.player.id, conversationId: id, body: req.body.body }));
    if (out.error) {
      req.session.replyDraft = { id, body: String(req.body.body || '').slice(0, rules.MAX_BODY) };
      req.flash('error', out.error);
    } else if (push) {
      push.message(out.recipientId, `${req.player.username} replied: ${bbcode.toPlain(String(req.body.body || '')).slice(0, 120)}`, id);
    }
    res.redirect(`/messages/${id}#${out.error ? 'reply' : 'latest'}`);
  });

  router.post('/messages/:id/hide', requireAuth, (req, res) => {
    if (messages.hide(req.player.id, Number(req.params.id))) req.flash('success', 'Conversation removed from your inbox. It comes back if a new message arrives.');
    res.redirect('/messages');
  });

  return router;
}

module.exports = { messageRoutes };
