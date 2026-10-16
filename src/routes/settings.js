'use strict';

const express = require('express');
const tuning = require('../tuning');
const presence = require('../presence');
const { createRequireAuth } = require('../require-auth');

/** Admin › Game settings: tune the economy and limits without a restart. */
function settingsRoutes(players, settingsService, adminRepo) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);
  // Non-admins get the ordinary 404, like the rest of the admin area.
  const adminOnly = (req, res, next) => {
    const user = req.session.userId && players.findById(req.session.userId);
    if (!user || !user.is_admin || user.banned_at) return next('route');
    next();
  };

  const audit = (adminId, changes, note) => {
    for (const c of changes) {
      adminRepo.log(adminId, null, 'setting', `${c.setting.label}: ${tuning.format(c.setting, c.before)} → ${tuning.format(c.setting, c.after)}${note ? ` (${note})` : ''}`);
    }
  };

  router.get('/admin/settings', adminOnly, requireAuth, (req, res) => {
    const now = Date.now();
    const draft = req.session.settingsDraft || null;
    const errors = req.session.settingsErrors || [];
    delete req.session.settingsDraft;
    delete req.session.settingsErrors;
    const live = tuning.all();
    res.render('admin/settings', {
      title: 'Admin · Game settings',
      nav: 'admin',
      groups: tuning.GROUPS.map((g) => ({
        ...g,
        settings: tuning.SETTINGS.filter((s) => s.group === g.id).map((s) => ({
          ...s,
          value: draft && s.key in draft ? draft[s.key] : live[s.key],
          changed: live[s.key] !== s.default,
          defaultLabel: tuning.format(s, s.default),
        })),
      })),
      changedCount: tuning.SETTINGS.filter((s) => live[s.key] !== s.default).length,
      errors,
      history: settingsService.recent(20).map((h) => ({ ...h, ago: presence.timeAgo(h.changed_at, now) })),
    });
  });

  router.post('/admin/settings', adminOnly, requireAuth, (req, res) => {
    const note = String(req.body._note || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const out = settingsService.update(req.body, req.player.id, { note });
    if (out.errors) {
      req.session.settingsDraft = Object.fromEntries(tuning.SETTINGS.filter((s) => s.key in req.body).map((s) => [s.key, req.body[s.key]]));
      req.session.settingsErrors = out.errors;
      req.flash('error', 'Nothing was saved. Fix the highlighted settings and try again.');
      return res.redirect('/admin/settings');
    }
    audit(req.player.id, out.changes, note);
    req.flash(out.changes.length ? 'success' : 'info', out.changes.length
      ? `Saved ${out.changes.length} change${out.changes.length === 1 ? '' : 's'}: ${out.changes.map((c) => `${c.setting.label} ${tuning.format(c.setting, c.after)}`).join(', ')}. Live now.`
      : 'Nothing changed.');
    res.redirect('/admin/settings');
  });

  router.post('/admin/settings/reset', adminOnly, requireAuth, (req, res) => {
    const out = settingsService.resetAll(req.player.id);
    audit(req.player.id, out.changes || [], 'reset to defaults');
    req.flash('success', out.changes && out.changes.length ? `Reset ${out.changes.length} setting${out.changes.length === 1 ? '' : 's'} to the defaults.` : 'Everything is already on the defaults.');
    res.redirect('/admin/settings');
  });

  return router;
}

module.exports = { settingsRoutes };
