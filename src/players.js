'use strict';

const { newPlayerDefaults } = require('./game');

const MUTABLE_FIELDS = [
  'level', 'xp', 'cash', 'energy', 'max_energy', 'health', 'max_health',
  'energy_updated_at', 'health_updated_at', 'missions_completed', 'missions_failed',
];

function createPlayerRepo(db) {
  const stmts = {
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byLogin: db.prepare('SELECT * FROM users WHERE username = ? OR email = ?'),
    exists: db.prepare('SELECT username = ? AS sameName FROM users WHERE username = ? OR email = ?'),
    insert: db.prepare(`
      INSERT INTO users (username, email, password_hash, level, xp, cash, energy, max_energy,
                         health, max_health, energy_updated_at, health_updated_at, created_at)
      VALUES (@username, @email, @password_hash, @level, @xp, @cash, @energy, @max_energy,
              @health, @max_health, @energy_updated_at, @health_updated_at, @created_at)`),
    save: db.prepare(`UPDATE users SET ${MUTABLE_FIELDS.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    log: db.prepare('INSERT INTO activity (user_id, kind, message, created_at) VALUES (?, ?, ?, ?)'),
    recent: db.prepare('SELECT kind, message, created_at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
  };

  return {
    findById: (id) => stmts.byId.get(id),
    findByLogin: (login) => stmts.byLogin.get(login, login),

    /** Returns 'username' or 'email' if either is already taken, else null. */
    conflict(username, email) {
      const row = stmts.exists.get(username, username, email);
      if (!row) return null;
      return row.sameName ? 'username' : 'email';
    },

    create({ username, email, passwordHash }) {
      const now = Date.now();
      const info = stmts.insert.run({
        ...newPlayerDefaults(now),
        username,
        email,
        password_hash: passwordHash,
        created_at: now,
      });
      const id = Number(info.lastInsertRowid);
      stmts.log.run(id, 'system', 'Enlisted with EliteForces. Welcome to the unit, soldier.', now);
      return id;
    },

    save(player) {
      const values = { id: player.id };
      for (const f of MUTABLE_FIELDS) values[f] = player[f];
      stmts.save.run(values);
    },

    touchLogin: (id) => stmts.touchLogin.run(Date.now(), id),
    log: (id, kind, message) => stmts.log.run(id, kind, message, Date.now()),
    recentActivity: (id, limit = 8) => stmts.recent.all(id, limit),

    /** Run `fn` inside a write transaction so concurrent requests can't double-spend. */
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

module.exports = { createPlayerRepo };
