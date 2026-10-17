'use strict';

const express = require('express');
const chat = require('../chat');
const presence = require('../presence');
const { wantsJson } = require('../middleware');
const { createRequireAuth } = require('../require-auth');

const slugOf = (channel) => (channel === 'global' ? 'global' : 'unit');
const timeLeft = (ms) => {
  const mins = Math.ceil(ms / 60000);
  return mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.ceil(mins / 60)}h` : `${Math.ceil(mins / 1440)}d`;
};

function chatRoutes(players, chatService, unitRepo, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  // Non-admins get the ordinary 404, like the rest of the admin area.
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  const channelFor = (slug, me) => chat.channelFor(slug, me, me.unit_id ? unitRepo.findById(me.unit_id) : null);
  // Can `user` read the channel a message lives in? Unit channels are members only.
  const canRead = (channel, user) => channel === 'global' || channel === `unit:${user.unit_id}`;

  /** Renders message rows to HTML with the same partial the page uses. */
  const renderRows = (req, res, rows) => Promise.all(rows.map((m) => new Promise((resolve, reject) => {
    req.app.render('partials/chat-message', { m, isAdmin: res.locals.isAdmin, csrfToken: res.locals.csrfToken, mutes: chat.MUTES }, (err, html) => (err ? reject(err) : resolve({ id: m.id, html })));
  })));

  router.get('/chat', requireAuth, (req, res) => res.redirect('/chat/global'));

  router.get('/chat/:slug', requireAuth, (req, res, next) => {
    const me = req.player;
    const channel = channelFor(String(req.params.slug), me);
    if (!channel) {
      if (req.params.slug !== 'unit') return next();
      req.flash('info', 'Join a unit to get a private unit channel.');
      return res.redirect('/chat/global');
    }
    const before = Number(req.query.before) || null;
    const messages = chatService.history(channel.key, me, { before });
    const unit = me.unit_id ? unitRepo.findById(me.unit_id) : null;
    // Opening the latest page reads the channel; refresh the header's unread marks to match.
    if (!before) {
      chatService.markRead(me.id, channel.key);
      res.locals.chatUnread = players.chatUnread(me);
    }
    const unread = res.locals.chatUnread;
    const draft = req.session.chatDraft && req.session.chatDraft.channel === channel.key ? req.session.chatDraft.body : '';
    delete req.session.chatDraft;
    res.render('chat', {
      title: `${channel.slug === 'global' ? 'Global' : 'Unit'} chat`,
      nav: 'chat',
      channel,
      channels: [{ slug: 'global', name: 'Global', unread: unread.global ? 1 : 0, dot: true, mentions: unread.mentions.global }, ...(unit ? [{ slug: 'unit', name: `[${unit.tag}] Unit`, unread: unread.unit, mentions: unread.mentions.unit }] : [])],
      messages,
      older: messages.length === chat.PAGE_SIZE ? messages[0].id : null,
      viewingOlder: Boolean(before),
      blocker: chat.postBlocker(me, null, null, Date.now()),
      draft,
      limits: { max: chat.MAX_LENGTH, minLevel: chat.minLevel() },
      mutes: chat.MUTES,
    });
  });

  // Live updates are polled every few seconds; cap it per player so a script can't hammer the database.
  const polls = new Map();
  const POLL_LIMIT = 60; // per minute: plenty for several open tabs
  setInterval(() => { const now = Date.now(); for (const [k, e] of polls) if (e.reset <= now) polls.delete(k); }, 60 * 1000).unref();
  const pollLimit = (req, res, next) => {
    const now = Date.now();
    let e = polls.get(req.player.id);
    if (!e || e.reset <= now) { e = { n: 0, reset: now + 60 * 1000 }; polls.set(req.player.id, e); }
    e.n += 1;
    if (e.n > POLL_LIMIT) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ ok: false, error: 'Too many requests.' });
    }
    next();
  };

  // Live updates: new messages since `after`, and recently deleted ones.
  router.get('/chat/:slug/poll', requireAuth, pollLimit, async (req, res, next) => {
    const channel = channelFor(String(req.params.slug), req.player);
    if (!channel) return res.status(404).json({ ok: false });
    try {
      const out = chatService.poll(channel.key, req.player, Number(req.query.after) || 0);
      // The page is open, so whatever arrives has been seen.
      if (out.messages.length) chatService.markRead(req.player.id, channel.key, out.messages.at(-1).id);
      res.json({ ok: true, messages: await renderRows(req, res, out.messages), deleted: out.deleted });
    } catch (err) { next(err); }
  });

  router.post('/chat/:slug', requireAuth, async (req, res, next) => {
    const me = req.player;
    const channel = channelFor(String(req.params.slug), me);
    if (!channel) return next();
    const out = chatService.post({
      me, channel: channel.key, channelName: channel.slug === 'global' ? 'Global' : `[${channel.tag}] unit`, raw: req.body.body,
      canSee: (u) => canRead(channel.key, u),
    });
    if (wantsJson(req)) {
      if (out.error) return res.status(400).json({ ok: false, error: out.error });
      try {
        const [row] = await renderRows(req, res, [out.message]);
        return res.json({ ok: true, ...row });
      } catch (err) { return next(err); }
    }
    if (out.error) {
      req.flash('error', out.error);
      req.session.chatDraft = { channel: channel.key, body: String(req.body.body || '').slice(0, chat.MAX_LENGTH * 2) };
    }
    res.redirect(`/chat/${channel.slug}${out.message ? `#m-${out.message.id}` : '#composer'}`);
  });

  // Message actions: load the message and check the player can see it.
  const loadMessage = (req, res, next) => {
    const m = chatService.findById(Number(req.params.id));
    if (!m || (!canRead(m.channel, req.player) && !req.player.is_admin)) return next('route');
    req.chatMessage = m;
    next();
  };
  const back = (req, res, m, hash = '') => (wantsJson(req) ? res.json({ ok: true }) : res.redirect(`/chat/${slugOf(m.channel)}${hash}`));

  router.post('/chat/messages/:id/delete', requireAuth, loadMessage, (req, res) => {
    const out = chatService.remove(req.chatMessage.id, req.player);
    if (out.error) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: out.error });
      req.flash('error', out.error);
    } else if (out.byAdmin) {
      adminRepo.log(req.player.id, out.message.user_id, 'chat-delete', `Deleted chat message #${out.message.id}: “${out.message.body.slice(0, 120)}”`);
    }
    back(req, res, req.chatMessage);
  });

  router.post('/chat/messages/:id/report', requireAuth, loadMessage, (req, res) => {
    const out = chatService.report(req.chatMessage.id, req.player, req.body.reason);
    if (wantsJson(req)) return out.error ? res.status(400).json({ ok: false, error: out.error }) : res.json({ ok: true });
    req.flash(out.error ? 'error' : 'success', out.error || 'Thanks. The message has been reported to the admins.');
    back(req, res, req.chatMessage, `#m-${req.chatMessage.id}`);
  });

  // Admin: mute the author straight from the chat (and optionally delete the message).
  router.post('/chat/messages/:id/mute', adminOnly, requireAuth, loadMessage, (req, res) => {
    const m = req.chatMessage;
    const length = chat.muteFor(String(req.body.duration || ''));
    const author = players.findById(m.user_id);
    if (!length || !author || author.id === req.player.id) {
      req.flash('error', 'Pick how long to mute them for.');
      return back(req, res, m);
    }
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    chatService.mute(author.id, length.ms, reason);
    if (req.body.delete) chatService.remove(m.id, req.player);
    adminRepo.log(req.player.id, author.id, 'chat-mute', `Muted for ${length.label}${reason ? `: ${reason}` : ''} (message #${m.id})`);
    players.notify(author.id, 'system', `You’ve been muted in chat for ${length.label}${reason ? `: ${reason}` : ''}.`, '/chat/global');
    req.flash('success', `${author.username} is muted for ${length.label}.`);
    back(req, res, m);
  });

  // ----- Admin moderation page -----
  router.get('/admin/chat', adminOnly, requireAuth, (req, res) => {
    const now = Date.now();
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.render('admin/chat', {
      title: 'Admin · Chat',
      nav: 'admin',
      status,
      reports: chatService.reports(status).map((r) => ({
        ...r,
        ago: presence.timeAgo(r.created_at, now),
        resolvedAgo: r.resolved_at ? presence.timeAgo(r.resolved_at, now) : null,
        mutedNow: Boolean(r.chat_muted_until && r.chat_muted_until > now),
        where: r.channel === 'global' ? 'Global' : 'a unit channel',
      })),
      openReports: chatService.openReportCount(),
      muted: chatService.muted(now).map((u) => ({ ...u, left: timeLeft(u.chat_muted_until - now) })),
      mutes: chat.MUTES,
    });
  });

  router.post('/admin/chat/reports/:id', adminOnly, requireAuth, (req, res) => {
    const report = chatService.reportById(Number(req.params.id));
    if (!report || report.status !== 'open') return res.redirect('/admin/chat');
    const action = String(req.body.action || '');
    const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let resolution = 'dismissed';
    if (action === 'delete' || action === 'mute') {
      chatService.remove(report.message_id, req.player);
      resolution = 'message deleted';
      if (action === 'mute' && report.author_id) {
        const length = chat.muteFor(String(req.body.duration || '')) || chat.MUTES['1h'];
        chatService.mute(report.author_id, length.ms, note);
        players.notify(report.author_id, 'system', `You’ve been muted in chat for ${length.label}${note ? `: ${note}` : ''}.`, '/chat/global');
        resolution = `message deleted, author muted for ${length.label}`;
      }
    }
    const full = note ? `${resolution}: ${note}` : resolution;
    const n = chatService.resolveReports(report.message_id, req.player.id, full);
    adminRepo.log(req.player.id, report.author_id, 'chat-report', `Chat report #${report.id} (${n} report${n === 1 ? '' : 's'}): ${full}`);
    req.flash('success', `Report resolved: ${resolution}.`);
    res.redirect('/admin/chat');
  });

  router.post('/admin/chat/unmute/:id', adminOnly, requireAuth, (req, res) => {
    const user = players.findById(Number(req.params.id));
    if (user) {
      chatService.unmute(user.id);
      adminRepo.log(req.player.id, user.id, 'chat-unmute', 'Unmuted in chat');
      req.flash('success', `${user.username} can chat again.`);
    }
    res.redirect('/admin/chat');
  });

  return router;
}

module.exports = { chatRoutes };
