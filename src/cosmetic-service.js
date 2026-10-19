'use strict';

const cosmetics = require('./cosmetics');

/**
 * Cosmetics backed by the database: what each player and unit owns, what
 * they wear, and admin grants (rules and catalogue in src/cosmetics.js).
 */
function createCosmeticService(db) {
  const stmts = {
    user: db.prepare('SELECT id, level, name_color, profile_banner, unit_id, unit_role FROM users WHERE id = ?'),
    titles: db.prepare('SELECT title_id FROM user_titles WHERE user_id = ?'),
    owned: db.prepare('SELECT cosmetic_id, source, granted_at FROM user_cosmetics WHERE user_id = ?'),
    grant: db.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, cosmetic_id, source, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)'),
    revoke: db.prepare('DELETE FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = ?'),
    wear: { name: db.prepare('UPDATE users SET name_color = ? WHERE id = ?'), banner: db.prepare('UPDATE users SET profile_banner = ? WHERE id = ?') },
    unit: db.prepare('SELECT id, name, crest, war_wins FROM units WHERE id = ?'),
    unitOwned: db.prepare('SELECT cosmetic_id FROM unit_cosmetics WHERE unit_id = ?'),
    unitGrant: db.prepare('INSERT OR IGNORE INTO unit_cosmetics (unit_id, cosmetic_id, source, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)'),
    unitRevoke: db.prepare('DELETE FROM unit_cosmetics WHERE unit_id = ? AND cosmetic_id = ?'),
    setCrest: db.prepare('UPDATE units SET crest = ? WHERE id = ?'),
  };

  const ownedSet = (userId) => new Set(stmts.owned.all(userId).map((r) => r.cosmetic_id));
  const contextFor = (user) => ({ level: user.level, titles: new Set(stmts.titles.all(user.id).map((r) => r.title_id)), owned: ownedSet(user.id) });
  const unitContext = (unit) => ({ owned: new Set(stmts.unitOwned.all(unit.id).map((r) => r.cosmetic_id)), unitWarWins: unit.war_wins || 0 });
  const WORN = { name: 'name_color', banner: 'profile_banner' };

  return {
    ownedSet,

    /** The wardrobe for a player: every personal cosmetic with whether they have it and are wearing it. */
    wardrobe(userId) {
      const user = stmts.user.get(userId);
      const ctx = contextFor(user);
      return cosmetics.KINDS.filter((k) => k.id !== 'crest').map((k) => ({
        ...k,
        items: cosmetics.COSMETICS.filter((c) => c.kind === k.id).map((c) => ({
          ...c,
          unlocked: cosmetics.isUnlocked(c, ctx),
          granted: ctx.owned.has(c.id),
          premium: Boolean(c.unlock && c.unlock.premium),
          how: cosmetics.howText(c),
          wearing: WORN[k.id] ? user[WORN[k.id]] === c.id : false,
        })),
      }));
    },

    /** Wears a callsign colour or profile banner (null/'' takes it off). Returns { ok } or { error }. */
    wear(userId, kind, id) {
      if (!WORN[kind]) return { error: 'That can’t be worn.' };
      if (!id) {
        stmts.wear[kind].run(null, userId);
        return { ok: 'Back to the standard look.' };
      }
      const c = cosmetics.BY_ID.get(String(id));
      if (!c || c.kind !== kind) return { error: 'That isn’t in the wardrobe.' };
      const user = stmts.user.get(userId);
      if (!cosmetics.isUnlocked(c, contextFor(user))) return { error: `${c.name} is locked: ${cosmetics.howText(c).toLowerCase()}.` };
      stmts.wear[kind].run(c.id, userId);
      return { ok: `${c.name} on.` };
    },

    /** Unit crests the unit can use (earned or owned), with the one in use. */
    crests(unitId) {
      const unit = stmts.unit.get(unitId);
      if (!unit) return [];
      const ctx = unitContext(unit);
      return cosmetics.COSMETICS.filter((c) => c.kind === 'crest').map((c) => ({
        ...c, unlocked: cosmetics.isUnlocked(c, ctx), how: cosmetics.howText(c), wearing: unit.crest === c.id,
      }));
    },

    /** The Commander sets the unit's crest (null for the standard one). */
    setCrest(unitId, id) {
      const unit = stmts.unit.get(unitId);
      if (!unit) return { error: 'That unit is gone.' };
      if (!id) { stmts.setCrest.run(null, unitId); return { ok: 'Standard crest back on.' }; }
      const c = cosmetics.BY_ID.get(String(id));
      if (!c || c.kind !== 'crest') return { error: 'That isn’t a crest.' };
      if (!cosmetics.isUnlocked(c, unitContext(unit))) return { error: `The ${c.name} crest is locked: ${cosmetics.howText(c).toLowerCase()}.` };
      stmts.setCrest.run(c.id, unitId);
      return { ok: `${unit.name} now carries the ${c.name} crest.` };
    },

    /** Admin: gives a player (or, for crests, a unit) a cosmetic. Returns { cosmetic } or { error }. */
    grant({ userId = null, unitId = null, id, by = null, source = 'admin', now = Date.now() }) {
      const c = cosmetics.BY_ID.get(String(id || ''));
      if (!c) return { error: 'Pick a cosmetic.' };
      if ((c.kind === 'crest') !== Boolean(unitId)) return { error: c.kind === 'crest' ? 'Crests belong to units.' : 'That belongs to a player, not a unit.' };
      const changes = unitId ? stmts.unitGrant.run(unitId, c.id, source, by, now).changes : stmts.grant.run(userId, c.id, source, by, now).changes;
      return changes ? { cosmetic: c } : { error: `They already have ${c.name}.` };
    },

    /** Admin: takes a granted cosmetic back, and takes it off if it was being worn. */
    revoke({ userId = null, unitId = null, id }) {
      const c = cosmetics.BY_ID.get(String(id || ''));
      if (!c) return { error: 'Pick a cosmetic.' };
      if (unitId) {
        if (!stmts.unitRevoke.run(unitId, c.id).changes) return { error: `The unit doesn’t own ${c.name}.` };
        const unit = stmts.unit.get(unitId);
        if (unit && unit.crest === c.id && !cosmetics.isUnlocked(c, unitContext(unit))) stmts.setCrest.run(null, unitId);
        return { cosmetic: c };
      }
      if (!stmts.revoke.run(userId, c.id).changes) return { error: `They don’t own ${c.name}.` };
      const user = stmts.user.get(userId);
      const col = WORN[c.kind];
      if (col && user[col] === c.id && !cosmetics.isUnlocked(c, contextFor(user))) stmts.wear[c.kind].run(null, userId);
      return { cosmetic: c };
    },

    /** Admin: what a player was given (not earned). */
    grantsFor: (userId) => stmts.owned.all(userId).map((r) => ({ ...r, cosmetic: cosmetics.BY_ID.get(r.cosmetic_id) })).filter((r) => r.cosmetic),
    unitGrantsFor: (unitId) => stmts.unitOwned.all(unitId).map((r) => cosmetics.BY_ID.get(r.cosmetic_id)).filter(Boolean),
  };
}

module.exports = { createCosmeticService };
