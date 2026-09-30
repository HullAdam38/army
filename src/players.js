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
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?1, last_seen_at = ?1 WHERE id = ?2'),
    touchSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    signOut: db.prepare('UPDATE users SET signed_out_at = ? WHERE id = ?'),
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    online: db.prepare(`
      SELECT username, level, xp, last_seen_at
      FROM users
      WHERE last_seen_at >= ? AND (signed_out_at IS NULL OR signed_out_at < last_seen_at)
      ORDER BY level DESC, xp DESC, username
      LIMIT ?`),
    owned: db.prepare('SELECT item_id FROM inventory WHERE user_id = ?'),
    addItem: db.prepare('INSERT OR IGNORE INTO inventory (user_id, item_id, acquired_at) VALUES (?, ?, ?)'),
    equipped: db.prepare('SELECT slot, item_id FROM equipment WHERE user_id = ?'),
    equip: db.prepare(`INSERT INTO equipment (user_id, slot, item_id) VALUES (?, ?, ?)
                       ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id`),
    unequip: db.prepare('DELETE FROM equipment WHERE user_id = ? AND slot = ?'),
    publicLog: db.prepare(`
      SELECT kind, message, created_at FROM activity
      WHERE user_id = ? AND kind IN ('success', 'failure', 'promotion')
      ORDER BY id DESC LIMIT ?`),
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

    findByUsername: (username) => stmts.byUsername.get(username),
    touchLogin: (id) => stmts.touchLogin.run(Date.now(), id),
    touchSeen: (id, now = Date.now()) => stmts.touchSeen.run(now, id),
    signOut: (id) => stmts.signOut.run(Date.now(), id),
    listOnline: (since, limit = 200) => stmts.online.all(since, limit),
    ownedItemIds: (id) => new Set(stmts.owned.all(id).map((r) => r.item_id)),
    addItem: (id, itemId) => stmts.addItem.run(id, itemId, Date.now()),
    /** { weapon: 'carbine', body: 'flak-vest', ... } for filled slots only. */
    equipment: (id) => Object.fromEntries(stmts.equipped.all(id).map((r) => [r.slot, r.item_id])),
    equip: (id, slot, itemId) => stmts.equip.run(id, slot, itemId),
    unequip: (id, slot) => stmts.unequip.run(id, slot),

    /** Mission results and promotions only; hospital visits and the like stay private. */
    publicActivity: (id, limit = 8) => stmts.publicLog.all(id, limit),
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
