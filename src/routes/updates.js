'use strict';

const express = require('express');
const { createRequireAuth } = require('../require-auth');

const when = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Patch notes: the public Updates page, and Admin › Patch notes for writing them. */
function updateRoutes(players, notes, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  // Public: anyone can read what's changed. Opening it clears the HQ notice.
  router.get('/updates', (req, res) => {
    if (req.session.userId) notes.markSeen(req.session.userId);
    res.render('updates', { title: 'Updates', nav: null, notes: notes.list(30).map((n) => ({ ...n, date: when(n.created_at), edited: n.updated_at - n.created_at > 60_000 ? when(n.updated_at) : null })) });
  });

  router.get('/admin/updates', adminOnly, requireAuth, (req, res) => {
    const editing = req.query.edit ? notes.byId(Number(req.query.edit)) : null;
    const draft = req.session.updateDraft || (editing ? { title: editing.title, body: editing.body } : {});
    delete req.session.updateDraft;
    res.render('admin/updates', { title: 'Admin · Patch notes', nav: 'admin', list: notes.list(50).map((n) => ({ ...n, date: when(n.created_at) })), editing, draft, limits: { title: notes.MAX_TITLE, body: notes.MAX_BODY } });
  });

  router.post('/admin/updates', adminOnly, requireAuth, (req, res) => {
    const id = Number(req.body.id) || null;
    const out = id ? notes.edit(id, req.body) : notes.post(req.body, req.player.id);
    if (out.error) {
      req.session.updateDraft = { title: String(req.body.title || '').slice(0, notes.MAX_TITLE), body: String(req.body.body || '').slice(0, notes.MAX_BODY) };
      req.flash('error', out.error);
      return res.redirect(`/admin/updates${id ? `?edit=${id}` : ''}#write`);
    }
    adminRepo.log(req.player.id, null, id ? 'patch-notes-edit' : 'patch-notes-post', `${id ? 'Edited' : 'Posted'} the update “${out.note.title}”.`);
    req.flash('success', id ? 'Update saved.' : 'Update posted. Players see a notice at HQ until they read it.');
    res.redirect('/admin/updates');
  });

  router.post('/admin/updates/:id/delete', adminOnly, requireAuth, (req, res) => {
    const note = notes.byId(Number(req.params.id));
    if (note && notes.remove(note.id)) {
      adminRepo.log(req.player.id, null, 'patch-notes-delete', `Deleted the update “${note.title}”.`);
      req.flash('success', 'Update deleted.');
    } else req.flash('error', 'No such update.');
    res.redirect('/admin/updates');
  });

  return router;
}

module.exports = { updateRoutes };
