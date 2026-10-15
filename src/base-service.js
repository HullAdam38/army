'use strict';

const base = require('./base');
const game = require('./game');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * The forward base backed by the database: start, cancel and finish builds.
 * start() and cancel() must run inside players.transaction(); completeDue()
 * opens its own and is safe to call often (it also runs every minute).
 */
function createBaseService(db, players) {
  const setBuild = db.prepare('UPDATE users SET base_build = ?, base_build_until = ?, base_build_cost = ? WHERE id = ?');
  const due = db.prepare('SELECT id FROM users WHERE base_build IS NOT NULL AND base_build_until <= ?');
  const dueFor = db.prepare('SELECT id FROM users WHERE id = ? AND base_build IS NOT NULL AND base_build_until <= ?');
  // Facility ids come from the fixed list in base.js, never from user input.
  const finish = Object.fromEntries(base.FACILITIES.map((f) => [f.id, db.prepare(
    `UPDATE users SET base_${f.id} = base_${f.id} + 1${f.id === 'barracks' ? ', max_energy = max_energy + 5' : ''},
     base_build = NULL, base_build_until = NULL, base_build_cost = NULL WHERE id = ? AND base_build = ?`,
  )]));

  function finishOne(userId, now) {
    return players.transaction(() => {
      const p = players.findById(userId);
      if (!p || !p.base_build || p.base_build_until > now) return null;
      const f = base.FACILITIES_BY_ID.get(p.base_build);
      if (!f || !finish[f.id].run(userId, f.id).changes) return null;
      const level = base.levelOf(p, f.id) + 1;
      players.log(userId, 'success', `Forward base: ${f.name} upgraded to level ${level} (${f.effect(level)}).`, '/base');
      players.notify(userId, 'base', `Construction complete: ${f.name} level ${level}. ${f.effect(level)[0].toUpperCase()}${f.effect(level).slice(1)}.`, '/base');
      return { facility: f, level };
    });
  }

  return {
    /** Starts building the next level of a facility. Returns { error } or { facility, next, until }. */
    start(userId, facilityId, now = Date.now()) {
      const f = base.FACILITIES_BY_ID.get(facilityId);
      if (!f) return { error: 'Unknown facility.' };
      const p = game.applyRegen(players.findById(userId), now);
      const blocker = base.buildBlocker(p, f.id, now);
      if (blocker) return { error: `${f.name}: ${blocker}.` };
      const next = base.nextLevel(p, f.id);
      p.cash -= next.cost;
      players.save(p, { reason: 'base', ref: `${f.id}:${next.level}` });
      const until = now + next.hours * base.HOUR;
      setBuild.run(f.id, until, next.cost, userId);
      players.log(userId, 'success', `Forward base: started ${f.name} level ${next.level} for ${money(next.cost)}. Ready in ${next.hours}h.`, '/base');
      return { facility: f, next, until };
    },

    /** Cancels the current build and refunds half its cost. */
    cancel(userId, now = Date.now()) {
      const p = game.applyRegen(players.findById(userId), now);
      if (!p.base_build || p.base_build_until <= now) return { error: 'Nothing is being built.' };
      const f = base.FACILITIES_BY_ID.get(p.base_build);
      const refund = Math.floor((p.base_build_cost || 0) * base.REFUND_RATE);
      p.cash += refund;
      players.save(p, { reason: 'base-refund', ref: p.base_build });
      setBuild.run(null, null, null, userId);
      return { facility: f, refund };
    },

    /** Finishes every build whose time is up (all players, or just one). */
    completeDue(now = Date.now(), userId = null) {
      const ids = userId ? dueFor.all(userId, now) : due.all(now);
      return ids.map(({ id }) => finishOne(id, now)).filter(Boolean);
    },

    schedule(ms = 60 * 1000) {
      setInterval(() => {
        try { this.completeDue(); } catch (err) { console.error('[base] completing builds failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createBaseService };
