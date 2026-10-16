'use strict';

const tuning = require('./tuning');

/**
 * Game settings backed by the database. load() runs at startup and pushes
 * the stored values into tuning.js; update() validates an admin's changes,
 * stores them with a history row each, and applies them at once.
 */
function createSettingsService(db) {
  const stmts = {
    all: db.prepare('SELECT key, value FROM game_settings'),
    upsert: db.prepare(`INSERT INTO game_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    remove: db.prepare('DELETE FROM game_settings WHERE key = ?'),
    history: db.prepare('INSERT INTO game_settings_history (key, old_value, new_value, changed_at, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)'),
    recent: db.prepare(`SELECT h.*, u.username FROM game_settings_history h LEFT JOIN users u ON u.id = h.changed_by
                        ORDER BY h.changed_at DESC, h.id DESC LIMIT ?`),
    // Values a setting had at any point since `since` (from its history), for anti-cheat limits.
    since: db.prepare('SELECT old_value, new_value FROM game_settings_history WHERE key = ? AND changed_at >= ?'),
  };

  const decode = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };

  /** Reads stored settings into the live values. Unknown or broken rows are ignored. */
  function load() {
    const values = {};
    for (const row of stmts.all.all()) {
      const s = tuning.BY_KEY.get(row.key);
      const v = decode(row.value);
      if (!s || v === undefined) continue;
      const checked = tuning.parse(s, v);
      if (!checked.error) values[row.key] = checked.value;
    }
    tuning.set(values);
    return tuning.all();
  }

  return {
    load,

    /**
     * Applies submitted values (key → raw input). Only settings that are
     * present and changed are written. Returns { errors } or { changes }.
     */
    update(input, adminId, { note = null, now = Date.now() } = {}) {
      const errors = [];
      const changes = [];
      for (const s of tuning.SETTINGS) {
        if (s.type !== 'bool' && !(s.key in input)) continue;
        // Unticked checkboxes aren't sent, so a bool is "off" when the form has its marker but no value.
        if (s.type === 'bool' && !(s.key in input) && !(`${s.key}__present` in input)) continue;
        const parsed = tuning.parse(s, input[s.key]);
        if (parsed.error) { errors.push(parsed.error); continue; }
        const before = tuning.get(s.key);
        if (parsed.value !== before) changes.push({ setting: s, before, after: parsed.value });
      }
      if (errors.length) return { errors };
      for (const c of changes) {
        if (c.after === c.setting.default) stmts.remove.run(c.setting.key); // back to default: nothing to store
        else stmts.upsert.run(c.setting.key, JSON.stringify(c.after), now, adminId);
        stmts.history.run(c.setting.key, JSON.stringify(c.before), JSON.stringify(c.after), now, adminId, note);
      }
      if (changes.length) load();
      return { changes };
    },

    /** Puts every setting back to its default. Returns the changes made. */
    resetAll(adminId, { now = Date.now() } = {}) {
      const input = { ...tuning.DEFAULTS };
      for (const s of tuning.SETTINGS) if (s.type === 'bool') input[`${s.key}__present`] = '1';
      return this.update(input, adminId, { note: 'Reset to defaults', now });
    },

    recent: (limit = 25) => stmts.recent.all(limit).map((h) => {
      const s = tuning.BY_KEY.get(h.key);
      return { ...h, setting: s, before: s ? tuning.format(s, decode(h.old_value)) : h.old_value, after: s ? tuning.format(s, decode(h.new_value)) : h.new_value };
    }),

    /**
     * The most generous value a numeric setting had in the window [since, now]
     * (`pick` is Math.max or Math.min). Anti-cheat uses this so honest players
     * aren't flagged after an admin makes the game stingier mid-day.
     */
    extreme(key, since, pick = Math.max) {
      const values = [tuning.get(key)];
      for (const r of stmts.since.all(key, since)) values.push(decode(r.old_value), decode(r.new_value));
      return pick(...values.filter((v) => typeof v === 'number'));
    },
  };
}

module.exports = { createSettingsService };
