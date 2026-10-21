'use strict';

const bbcode = require('./bbcode');

const MAX_TITLE = 100;
const MAX_BODY = 6000;

/**
 * Patch notes: what changed in the game, written by admins (BBCode) and shown
 * on /updates. HQ points players at notes they haven't read: anything posted
 * after they last opened /updates, and after they signed up.
 */
function createPatchNotes(db) {
  const stmts = {
    insert: db.prepare('INSERT INTO patch_notes (title, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE patch_notes SET title = ?, body = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM patch_notes WHERE id = ?'),
    byId: db.prepare('SELECT * FROM patch_notes WHERE id = ?'),
    list: db.prepare('SELECT n.*, u.username AS author FROM patch_notes n LEFT JOIN users u ON u.id = n.author_id ORDER BY n.created_at DESC, n.id DESC LIMIT ?'),
    latest: db.prepare('SELECT id, title, created_at FROM patch_notes ORDER BY created_at DESC, id DESC LIMIT 1'),
    seen: db.prepare('UPDATE users SET updates_seen_at = ? WHERE id = ?'),
  };

  /** Checks the form. Returns { error } or { title, body }. */
  function clean(input) {
    const title = String(input.title || '').replace(/\s+/g, ' ').trim();
    const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
    if (!title) return { error: 'Give the update a title.' };
    if (title.length > MAX_TITLE) return { error: `Titles are up to ${MAX_TITLE} characters.` };
    if (!body) return { error: 'Write what changed.' };
    if (body.length > MAX_BODY) return { error: `Patch notes are up to ${MAX_BODY.toLocaleString('en-US')} characters.` };
    return { title, body };
  }

  return {
    MAX_TITLE,
    MAX_BODY,
    list: (limit = 30) => stmts.list.all(limit).map((n) => ({ ...n, html: bbcode.render(n.body) })),
    byId: (id) => stmts.byId.get(id) || null,

    post(input, authorId, now = Date.now()) {
      const c = clean(input);
      if (c.error) return c;
      const id = Number(stmts.insert.run(c.title, c.body, authorId, now, now).lastInsertRowid);
      return { note: stmts.byId.get(id) };
    },
    edit(id, input, now = Date.now()) {
      if (!stmts.byId.get(id)) return { error: 'No such update.' };
      const c = clean(input);
      if (c.error) return c;
      stmts.update.run(c.title, c.body, now, id);
      return { note: stmts.byId.get(id) };
    },
    remove: (id) => stmts.remove.run(id).changes > 0,

    /** The newest note `user` hasn't seen, or null. */
    unseenFor(user) {
      const n = stmts.latest.get();
      if (!n) return null;
      return n.created_at > Math.max(user.updates_seen_at || 0, user.created_at || 0) ? n : null;
    },
    markSeen: (userId, now = Date.now()) => stmts.seen.run(now, userId),
  };
}

module.exports = { createPatchNotes };
