'use strict';

const ops = require('./operations');
const game = require('./game');
const { announceLevels } = require('./notify');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/** Operations backed by the database. run() must be called inside players.transaction(). */
function createOperationService(db, players) {
  const stmts = {
    get: db.prepare('SELECT * FROM operation_progress WHERE user_id = ? AND op_id = ?'),
    all: db.prepare('SELECT * FROM operation_progress WHERE user_id = ?'),
    upsert: db.prepare(`INSERT INTO operation_progress (user_id, op_id, stage, completed_at, completions, updated_at)
                        VALUES (@user_id, @op_id, @stage, @completed_at, @completions, @updated_at)
                        ON CONFLICT(user_id, op_id) DO UPDATE SET stage = @stage, completed_at = @completed_at, completions = @completions, updated_at = @updated_at`),
  };

  return {
    /** Progress for every operation, keyed by op id. */
    progressFor(userId, now = Date.now()) {
      const rows = new Map(stmts.all.all(userId).map((r) => [r.op_id, r]));
      return new Map(ops.OPERATIONS.map((op) => [op.id, ops.progressOf(op, rows.get(op.id) || null, now)]));
    },

    /**
     * Plays the next stage of an operation. Returns { error } or
     * { stage, result, completed, bonus, levelsGained, player }.
     */
    run(userId, opId, { stats, xpBonus = 0, cashBonus = 0, chanceBonus = 0, now = Date.now(), rng } = {}) {
      const op = ops.OPERATIONS_BY_ID.get(opId);
      if (!op) return { error: 'Unknown operation.' };
      const row = stmts.get.get(userId, opId) || null;
      const progress = ops.progressOf(op, row, now);
      if (progress.coolingUntil) return { error: `${op.name} is complete. The next one is ready in ${Math.ceil((progress.coolingUntil - now) / 3_600_000)}h.` };
      const stage = op.stages[progress.stage - 1];
      const fresh = players.findById(userId);
      const out = game.resolveMission(stage, fresh, { now, rng, stats, xpBonus, cashBonus, chanceBonus });
      if (out.error) return out;
      const p = out.player;
      const r = out.result;
      const levels = [...r.levelsGained];
      let completed = false;
      let bonus = null;
      const next = { user_id: userId, op_id: opId, stage: progress.stage, completed_at: row ? row.completed_at : null, completions: row ? row.completions : 0, updated_at: now };
      if (r.success) {
        if (stage.stage === op.stages.length) {
          completed = true;
          bonus = { xp: Math.round(op.bonus.xp * (1 + xpBonus)), cash: Math.round(op.bonus.cash * (1 + cashBonus)) };
          p.cash += bonus.cash;
          levels.push(...game.grantXp(p, bonus.xp));
          Object.assign(next, { stage: 1, completed_at: now, completions: next.completions + 1 });
        } else {
          next.stage = stage.stage + 1;
        }
      }
      stmts.upsert.run(next);
      players.save(p, { reason: 'operation', ref: `${opId}:${stage.stage}` });
      const label = `${op.name}, stage ${stage.stage}/${op.stages.length} (${stage.name})`;
      players.log(userId, r.success ? 'success' : 'failure', r.success
        ? `${label}: done. +${r.xp} XP, +${money(r.cash)}.`
        : `${label}: failed. Took ${r.damage} damage, +${r.xp} XP.`);
      if (completed) {
        players.log(userId, 'promotion', `${op.name} complete! Bonus +${bonus.xp} XP, +${money(bonus.cash)}.`);
        players.notify(userId, 'unlock', `${op.name} complete! Bonus: +${money(bonus.cash)} and +${bonus.xp} XP. It can be run again in 20 hours.`, '/missions#operations');
      }
      for (const lvl of levels) {
        const rank = game.rankFor(lvl);
        players.log(userId, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
      }
      announceLevels(players, userId, levels);
      return { op, stage, result: r, completed, bonus, levelsGained: levels, player: p };
    },
  };
}

module.exports = { createOperationService };
