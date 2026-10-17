'use strict';

const express = require('express');
const presence = require('../presence');
const avatars = require('../avatars');
const { createRequireAuth } = require('../require-auth');

// Served pictures can't run anything, even if opened directly.
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function avatarRoutes(players, avatarService, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  const sendImage = (res, { mime, body }, cache) => {
    res.set({
      'Content-Type': mime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : mime,
      'Content-Security-Policy': IMAGE_CSP,
      'Content-Disposition': 'inline; filename="avatar"',
      'Cache-Control': cache,
    });
    res.send(body);
  };

  // The signed-in viewer, unless their account is gone or suspended.
  const viewerOf = (req) => {
    const user = req.session.userId && players.findById(req.session.userId);
    return user && !user.banned_at ? user : null;
  };

  // Live preview for the badge builder: the badge described by the query, unsaved.
  router.get('/avatars/preview', (req, res) => {
    if (!viewerOf(req)) return res.sendStatus(401);
    sendImage(res, { mime: 'image/svg+xml', body: avatarService.preview(req.session.userId, req.query) }, 'private, no-store');
  });

  // Avatars are for signed-in players only, like the profiles they sit on.
  router.get('/avatars/:id', (req, res, next) => {
    if (!/^\d{1,10}$/.test(req.params.id)) return next();
    const viewer = viewerOf(req);
    if (!viewer) return res.sendStatus(401);
    const id = Number(req.params.id);
    // Owners and admins can see an uploaded picture even while it isn't in use.
    if (req.query.kind === 'upload') {
      const up = viewer.id === id || viewer.is_admin ? avatarService.uploaded(id) : null;
      if (!up) return res.sendStatus(404);
      return sendImage(res, up, 'private, no-cache');
    }
    const user = avatarService.findUser(id);
    const current = user && String(req.query.v) === String(user.avatar_v);
    // A versioned URL never changes, so browsers can keep it; others revalidate.
    sendImage(res, avatarService.image(id), current ? 'private, max-age=31536000, immutable' : 'private, no-cache');
  });

  // ----- The builder -----
  router.get('/account/avatar', requireAuth, (req, res) => {
    const ed = avatarService.editor(req.player.id);
    // "Preview" without JavaScript submits the builder here with GET.
    const previewing = req.query.preview !== undefined;
    const chosen = previewing ? { ...ed.badge, ...Object.fromEntries(ed.sections.map((s) => [s.key, typeof req.query[s.key] === 'string' ? req.query[s.key] : ed.badge[s.key]])) } : ed.badge;
    const query = new URLSearchParams(Object.entries(chosen)).toString();
    res.render('account-avatar', {
      title: 'Avatar',
      nav: 'profile',
      ed,
      chosen,
      previewUrl: previewing ? `/avatars/preview?${query}` : ed.kind === 'upload' ? `/avatars/preview?${query}` : ed.url,
      maxKb: Math.round(avatarService.MAX_UPLOAD_BYTES / 1024),
      previewing,
      sample: avatars.renderPartSample,
    });
  });

  router.post('/account/avatar/badge', requireAuth, (req, res) => {
    const out = avatarService.saveBadge(req.player.id, req.body);
    req.flash(out.error ? 'error' : 'success', out.error || 'Badge saved. It’s now your avatar.');
    res.redirect('/account/avatar');
  });

  router.post('/account/avatar/upload', requireAuth, (req, res) => {
    let out;
    if (req.uploadTooLarge) out = { error: `That picture is too big. The limit is ${Math.round(avatarService.MAX_UPLOAD_BYTES / 1024)} KB.` };
    else out = avatarService.saveUpload(req.player.id, req.files && req.files.picture ? req.files.picture.data : null);
    req.flash(out.error ? 'error' : 'success', out.error || 'Picture uploaded. It’s now your avatar.');
    res.redirect('/account/avatar#upload');
  });

  router.post('/account/avatar/use', requireAuth, (req, res) => {
    const out = avatarService.use(req.player.id, String(req.body.kind || ''));
    req.flash(out.error ? 'error' : 'success', out.error || (out.kind === 'upload' ? 'Now using your picture.' : 'Now using your badge.'));
    res.redirect('/account/avatar');
  });

  router.post('/account/avatar/upload/delete', requireAuth, (req, res) => {
    const had = avatarService.removeUpload(req.player.id);
    req.flash('success', had ? 'Picture deleted. Your badge is your avatar again.' : 'You had no picture uploaded.');
    res.redirect('/account/avatar');
  });

  router.post('/avatars/:id/report', requireAuth, (req, res) => {
    const target = players.findById(Number(req.params.id));
    if (!target) return res.redirect('/players');
    const out = avatarService.report(target.id, req.player, req.body.reason);
    req.flash(out.error ? 'error' : 'success', out.error || 'Thanks. An admin will look at that picture.');
    res.redirect(`/profile/${encodeURIComponent(target.username)}`);
  });

  // ----- Admin moderation -----
  router.get('/admin/avatars', adminOnly, requireAuth, (req, res) => {
    const now = Date.now();
    const tab = ['resolved', 'recent'].includes(req.query.tab) ? req.query.tab : 'open';
    const withUrl = (r, id) => ({ ...r, url: avatarService.urlFor({ id, avatar_v: r.avatar_v }) });
    res.render('admin/avatars', {
      title: 'Admin · Avatars',
      nav: 'admin',
      tab,
      openReports: avatarService.openReportCount(),
      reports: tab === 'recent' ? [] : avatarService.reports(tab).map((r) => ({
        ...withUrl(r, r.target_id),
        ago: presence.timeAgo(r.last_at, now),
        resolvedAgo: r.resolved_at ? presence.timeAgo(r.resolved_at, now) : null,
        reasons: String(r.reasons || '').split('\n'),
      })),
      uploads: tab === 'recent' ? avatarService.recentUploads(60).map((u) => ({ ...withUrl(u, u.user_id), ago: presence.timeAgo(u.created_at, now) })) : [],
    });
  });

  const loadTarget = (req, res, next) => {
    const user = players.findById(Number(req.params.id));
    if (!user) return res.redirect('/admin/avatars');
    req.target = user;
    next();
  };
  const backTo = (req) => (req.body.back === 'recent' ? '/admin/avatars?tab=recent' : '/admin/avatars');

  router.post('/admin/avatars/:id/remove', adminOnly, requireAuth, loadTarget, (req, res) => {
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const block = req.body.block === '1';
    avatarService.removeUpload(req.target.id);
    if (block) avatarService.blockUploads(req.target.id, true);
    const resolution = `picture removed${block ? ', uploads blocked' : ''}${reason ? `: ${reason}` : ''}`;
    avatarService.resolveReports(req.target.id, req.player.id, resolution);
    players.notify(req.target.id, 'system', `An admin removed your avatar picture${reason ? `: ${reason}` : ''}.${block ? ' You can no longer upload pictures, but you can still build a badge.' : ''}`, '/account/avatar');
    adminRepo.log(req.player.id, req.target.id, 'avatar-remove', `Removed avatar picture${block ? ' and blocked uploads' : ''}${reason ? `: ${reason}` : ''}`);
    req.flash('success', `${req.target.username}’s picture was removed.`);
    res.redirect(backTo(req));
  });

  router.post('/admin/avatars/:id/dismiss', adminOnly, requireAuth, loadTarget, (req, res) => {
    const n = avatarService.resolveReports(req.target.id, req.player.id, 'dismissed');
    if (n) adminRepo.log(req.player.id, req.target.id, 'avatar-report', `Dismissed ${n} avatar report${n === 1 ? '' : 's'}`);
    req.flash('success', 'Report dismissed.');
    res.redirect('/admin/avatars');
  });

  router.post('/admin/avatars/:id/uploads', adminOnly, requireAuth, loadTarget, (req, res) => {
    const blocked = req.body.blocked === '1';
    avatarService.blockUploads(req.target.id, blocked);
    adminRepo.log(req.player.id, req.target.id, 'avatar-uploads', blocked ? 'Blocked avatar uploads' : 'Allowed avatar uploads again');
    req.flash('success', blocked ? `${req.target.username} can no longer upload pictures.` : `${req.target.username} can upload pictures again.`);
    res.redirect(backTo(req));
  });

  return router;
}

module.exports = { avatarRoutes };
