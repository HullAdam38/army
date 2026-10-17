'use strict';

const deployments = require('./deployments');
const game = require('./game');
const perks = require('./perks');
const { NEUTRAL } = require('./events');
const tuning = require('./tuning');
const { announceLevels } = require('./notify');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Deployments backed by the database. start() and recall() run inside
 * players.transaction(); completeDue() opens its own and runs every minute.
 * `effects(now)` supplies live event multipliers (Double XP, Payday).
 */
function createDeploymentService(db, players, { effects = () => NEUTRAL, onReturn = null } = {}) {
  const stmts = {
    insert: db.prepare('INSERT INTO deployments (user_id, kind, started_at, ends_at) VALUES (?, ?, ?, ?)'),
    active: db.prepare("SELECT * FROM deployments WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"),
    recent: db.prepare('SELECT * FROM deployments WHERE user_id = ? AND started_at >= ? ORDER BY id'),
    history: db.prepare("SELECT * FROM deployments WHERE user_id = ? AND status != 'active' ORDER BY id DESC LIMIT ?"),
    due: db.prepare("SELECT id, user_id FROM deployments WHERE status = 'active' AND ends_at <= ?"),
    dueFor: db.prepare("SELECT id, user_id FROM deployments WHERE status = 'active' AND ends_at <= ? AND user_id = ?"),
    byId: db.prepare('SELECT * FROM deployments WHERE id = ?'),
    finish: db.prepare("UPDATE deployments SET status = 'returned', cash = ?, xp = ?, report = ?, returned_at = ? WHERE id = ? AND status = 'active'"),
    recall: db.prepare("UPDATE deployments SET status = 'recalled', returned_at = ? WHERE id = ? AND status = 'active'"),
    setUntil: db.prepare('UPDATE users SET deploy_until = ? WHERE id = ?'),
  };

  /** Multipliers that apply when a soldier returns: rank perks × live events. */
  const multipliers = (level, now) => {
    const p = perks.perksFor(level);
    const e = effects(now);
    const admin = tuning.get('deploymentPayMult'); // Admin › Game settings
    return { cashMult: (1 + p.missionCash) * e.cashMult * admin, xpMult: (1 + p.missionXp) * e.xpMult * admin };
  };

  const hoursUsed = (userId, now) => deployments.hoursUsed(stmts.recent.all(userId, now - 48 * deployments.HOUR), now);

  function finishOne(id, now, rng) {
    return players.transaction(() => {
      const d = stmts.byId.get(id);
      if (!d || d.status !== 'active' || d.ends_at > now) return null;
      const kind = deployments.KINDS_BY_ID.get(d.kind);
      const p = game.applyRegen(players.findById(d.user_id), now);
      const r = deployments.resolve(kind, p, { ...multipliers(p.level, now), rng });
      p.cash += r.cash;
      if (r.injury) {
        if (p.health >= p.max_health) p.health_updated_at = now;
        p.health = Math.max(1, p.health - r.injury);
      }
      const levels = game.grantXp(p, r.xp);
      p.deploy_until = null;
      const report = [r.story, r.find, r.injury ? `Ran into an ambush on the way back and took ${r.injury} damage.` : null].filter(Boolean).join(' ');
      stmts.finish.run(r.cash, r.xp, report, now, d.id);
      players.save(p, { reason: 'deployment', ref: `deployment:${d.id}` });
      stmts.setUntil.run(null, d.user_id);
      if (onReturn) onReturn(d.user_id, now); // counts towards unit objectives
      players.log(d.user_id, 'success', `Back from ${kind.name}: +${r.xp} XP, +${money(r.cash)}. ${report}`, '/deployments');
      players.notify(d.user_id, 'deployment', `Your soldier is back from the ${kind.name.toLowerCase()}: +${money(r.cash)}, +${r.xp} XP.${r.find ? ' Found a supply cache!' : ''}${r.injury ? ` Took ${r.injury} damage.` : ''}`, '/deployments');
      for (const lvl of levels) {
        const rank = game.rankFor(lvl);
        players.log(d.user_id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
      }
      announceLevels(players, d.user_id, levels);
      return { id: d.id, userId: d.user_id, kind, ...r, levelsGained: levels };
    });
  }

  return {
    multipliers,
    hoursUsed,
    active: (userId) => stmts.active.get(userId) || null,
    history: (userId, limit = 10) => stmts.history.all(userId, limit),

    /** Sends the soldier out. Returns { error } or { kind, until }. */
    start(userId, kindId, now = Date.now()) {
      const kind = deployments.KINDS_BY_ID.get(kindId);
      const p = game.applyRegen(players.findById(userId), now);
      const blocker = deployments.deployBlocker(p, kind, hoursUsed(userId, now), now);
      if (blocker) return { error: `${kind ? kind.name : 'Deployment'}: ${blocker}.` };
      const until = now + kind.hours * deployments.HOUR;
      stmts.insert.run(userId, kind.id, now, until);
      stmts.setUntil.run(until, userId);
      return { kind, until };
    },

    /** Brings the soldier back early, with nothing to show for it. */
    recall(userId, now = Date.now()) {
      const d = stmts.active.get(userId);
      if (!d || d.ends_at <= now) return { error: 'You’re not on deployment.' };
      stmts.recall.run(now, d.id);
      stmts.setUntil.run(null, userId);
      return { kind: deployments.KINDS_BY_ID.get(d.kind) };
    },

    /** Brings back every soldier whose deployment has ended (all players, or one). */
    completeDue(now = Date.now(), userId = null, rng = Math.random) {
      const rows = userId ? stmts.dueFor.all(now, userId) : stmts.due.all(now);
      return rows.map((r) => finishOne(r.id, now, rng)).filter(Boolean);
    },

    schedule(ms = 60 * 1000) {
      setInterval(() => {
        try { this.completeDue(); } catch (err) { console.error('[deployments] return failed', err); }
      }, ms).unref();
    },
  };
}

module.exports = { createDeploymentService };
