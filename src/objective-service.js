'use strict';

const objectives = require('./objectives');
const game = require('./game');
const { announceLevels } = require('./notify');

/**
 * Weekly unit objectives backed by the database. track() is called from game
 * actions (through the daily-progress hook, and directly for deployments and
 * donations); it runs inside the caller's transaction and never opens one.
 */
function createObjectiveService(db, players, unitRepo) {
  const stmts = {
    list: db.prepare('SELECT * FROM unit_objectives WHERE week = ? AND unit_id = ? ORDER BY slot'),
    insert: db.prepare('INSERT OR IGNORE INTO unit_objectives (week, unit_id, slot, type, target, reward_cash) VALUES (?, ?, ?, ?, ?, ?)'),
    bump: db.prepare('UPDATE unit_objectives SET progress = MIN(target, progress + ?) WHERE week = ? AND unit_id = ? AND slot = ? AND completed_at IS NULL'),
    complete: db.prepare('UPDATE unit_objectives SET completed_at = ? WHERE week = ? AND unit_id = ? AND slot = ? AND completed_at IS NULL AND progress >= target'),
    nudge: db.prepare('UPDATE unit_objectives SET nudged_at = ? WHERE week = ? AND unit_id = ? AND slot = ? AND nudged_at IS NULL'),
    contrib: db.prepare(`INSERT INTO unit_objective_contrib (week, unit_id, user_id, type, amount) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(week, unit_id, user_id, type) DO UPDATE SET amount = amount + excluded.amount`),
    helpers: db.prepare(`SELECT c.user_id FROM unit_objective_contrib c JOIN users u ON u.id = c.user_id
                         WHERE c.week = ? AND c.unit_id = ? AND c.type = ? AND c.amount > 0 AND u.unit_id = c.unit_id AND u.banned_at IS NULL`),
    top: db.prepare(`SELECT c.user_id, u.username, u.avatar_v, c.type, c.amount FROM unit_objective_contrib c JOIN users u ON u.id = c.user_id
                     WHERE c.week = ? AND c.unit_id = ? AND c.amount > 0 ORDER BY c.amount DESC`),
    members: db.prepare('SELECT COUNT(*) AS n, AVG(level) AS level FROM users WHERE unit_id = ? AND banned_at IS NULL'),
    prune: db.prepare('DELETE FROM unit_objective_contrib WHERE week < ?'),
    pruneObjectives: db.prepare('DELETE FROM unit_objectives WHERE week < ?'),
  };
  const METRIC_TO_TYPES = new Map();
  for (const t of objectives.TYPES) METRIC_TO_TYPES.set(t.metric, [...(METRIC_TO_TYPES.get(t.metric) || []), t.id]);

  /** This week's objectives for a unit, setting them on first look. */
  function current(unitId, now = Date.now()) {
    const week = objectives.weekKey(now);
    let rows = stmts.list.all(week, unitId);
    if (!rows.length) {
      const m = stmts.members.get(unitId);
      for (const o of objectives.generate(unitId, week, { members: m.n, avgLevel: m.level || 1 })) {
        stmts.insert.run(week, unitId, o.slot, o.type, o.target, o.rewardCash);
      }
      rows = stmts.list.all(week, unitId);
    }
    return { week, rows };
  }

  function finish(o, unitId, week, now) {
    if (!stmts.complete.run(now, week, unitId, o.slot).changes) return;
    const unit = unitRepo.findById(unitId);
    if (!unit) return;
    unitRepo.addTreasury(unitId, o.reward_cash);
    const what = objectives.describe(o);
    const link = `/units/${unitId}#objectives`;
    // XP to each current member who helped with this one.
    const helped = new Set(stmts.helpers.all(week, unitId, o.type).map((r) => r.user_id));
    for (const id of helped) {
      const found = players.findById(id);
      if (!found) continue;
      const p = game.applyRegen(found, now);
      const xp = objectives.memberXp(p.level);
      const levels = game.grantXp(p, xp);
      players.save(p, { reason: 'unit-objective', ref: `unit:${unitId}:${week}:${o.slot}` });
      players.log(id, 'unit', `Unit objective complete: ${what}. +${xp} XP for helping.`, link);
      for (const lvl of levels) {
        const r = game.rankFor(lvl);
        players.log(id, 'promotion', `Promoted to level ${lvl} — ${r.name} (${r.grade}).`);
      }
      announceLevels(players, id, levels);
    }
    unitRepo.log(unitId, 'objective', `Weekly objective complete: ${what}. ${objectives.money(o.reward_cash)} paid into the treasury.`, now);
    for (const id of unitRepo.memberIds(unitId)) {
      players.notify(id, 'unit', `[${unit.tag}] objective complete: ${what}. ${objectives.money(o.reward_cash)} to the treasury${helped.has(id) ? `, +${objectives.memberXp(players.findById(id).level)} XP to you` : ''}.`, link);
    }
  }

  return {
    current,

    /**
     * A member did something that may count: `metric` is missions,
     * pvp_wins, deployments, training or donations.
     */
    track(userId, metric, amount = 1, now = Date.now()) {
      const types = METRIC_TO_TYPES.get(metric);
      if (!types || amount <= 0) return;
      const user = players.findById(userId);
      if (!user || !user.unit_id || user.banned_at) return;
      const unitId = user.unit_id;
      const { week, rows } = current(unitId, now);
      for (const o of rows) {
        if (!types.includes(o.type) || o.completed_at) continue;
        stmts.bump.run(amount, week, unitId, o.slot);
        stmts.contrib.run(week, unitId, userId, o.type, amount);
        const progress = Math.min(o.target, o.progress + amount);
        if (progress >= o.target) {
          finish({ ...o, progress }, unitId, week, now);
        } else if (progress >= o.target * objectives.NUDGE_AT && stmts.nudge.run(now, week, unitId, o.slot).changes) {
          const unit = unitRepo.findById(unitId);
          for (const id of unitRepo.memberIds(unitId)) {
            players.notify(id, 'unit', `[${unit.tag}] is ${Math.floor((progress / o.target) * 100)}% of the way to a weekly objective: ${objectives.describe(o)}. One more push!`, `/units/${unitId}#objectives`);
          }
        }
      }
    },

    /** The objectives card for a unit page. */
    view(unitId, now = Date.now()) {
      const { week, rows } = current(unitId, now);
      const contributions = stmts.top.all(week, unitId);
      const totals = new Map();
      for (const c of contributions) {
        const t = totals.get(c.user_id) || { userId: c.user_id, username: c.username, avatarV: c.avatar_v, objectives: 0 };
        // Share of each objective they did, so different metrics compare fairly.
        const o = rows.find((r) => r.type === c.type);
        if (o) t.objectives += Math.min(1, c.amount / o.target);
        totals.set(c.user_id, t);
      }
      return {
        week,
        endsAt: objectives.weekEnds(week),
        items: rows.map((o) => {
          const type = objectives.TYPES_BY_ID.get(o.type);
          return {
            ...o,
            name: type ? type.name : o.type,
            icon: type ? type.icon : 'i-star',
            text: objectives.describe(o),
            pct: Math.floor((o.progress / o.target) * 100),
            done: Boolean(o.completed_at),
            progressLabel: o.type === 'donations' ? `${objectives.money(o.progress)} / ${objectives.money(o.target)}` : `${o.progress.toLocaleString('en-US')} / ${o.target.toLocaleString('en-US')}`,
          };
        }),
        top: [...totals.values()].sort((a, b) => b.objectives - a.objectives).slice(0, 5).map((t) => ({ ...t, sharePct: Math.round((t.objectives / Math.max(1, rows.length)) * 100) })),
        memberXpAt: (level) => objectives.memberXp(level),
      };
    },

    /** Drops records older than a month. */
    prune(now = Date.now()) {
      const cutoff = objectives.weekKey(now - 5 * objectives.WEEK_MS);
      stmts.prune.run(cutoff);
      stmts.pruneObjectives.run(cutoff);
    },
  };
}

module.exports = { createObjectiveService };
