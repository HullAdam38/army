'use strict';

const specialOps = require('./special-ops');
const game = require('./game');
const tuning = require('./tuning');
const vehicles = require('./vehicles');
const workshop = require('./workshop');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/** The mission a special operation is built from: the newest one open to the player's level. */
const baseMission = (level) => game.MISSIONS.filter((m) => m.minLevel <= level).sort((a, b) => b.minLevel - a.minLevel)[0];

/**
 * Special operations backed by the database (rules in src/special-ops.js).
 * run() goes inside the caller's transaction, after the same checks and
 * bonuses as a mission. `vehicles` and `workshop` are the motor pool and
 * workshop services, for the completion rewards.
 */
function createSpecialOpService(db, players, { vehicleService = null, workshopService = null } = {}) {
  const stmts = {
    run: db.prepare('SELECT * FROM special_runs WHERE user_id = ? AND window_key = ?'),
    start: db.prepare("INSERT OR IGNORE INTO special_runs (user_id, window_key, op_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
    advance: db.prepare('UPDATE special_runs SET stage = stage + 1, assaults = assaults + ?, updated_at = ? WHERE user_id = ? AND window_key = ? AND stage = ?'),
    finish: db.prepare("UPDATE special_runs SET status = ?, assaults = assaults + ?, updated_at = ? WHERE user_id = ? AND window_key = ? AND status = 'active'"),
    done: db.prepare('UPDATE users SET specials_done = specials_done + 1 WHERE id = ?'),
    recent: db.prepare("SELECT COUNT(*) AS n FROM special_runs WHERE window_key = ? AND status = 'done'"),
  };

  /** Why `player` can't run a stage now, or null. */
  function blocker(player, w, run) {
    if (player.level < specialOps.MIN_LEVEL) return `Special operations open at level ${specialOps.MIN_LEVEL}`;
    if (!w.open) return 'The special operation has closed';
    if (run && run.status === 'done') return 'You’ve completed this one. The next opens soon';
    if (run && run.status === 'failed') return 'Your run is over. The next special operation opens soon';
    if (!run && !tuning.get('specialOpsEnabled')) return 'Special operations are paused';
    return null;
  }

  const service = {
    baseMission,
    // The clock and dice, replaceable in tests (a special operation is only open 3 hours in 6).
    clock: () => Date.now(),
    rng: Math.random,

    /** What the Missions page and HQ show. `stats` and `chanceBonus` as for missions. */
    view(player, now = service.clock(), stats = undefined, chanceBonus = 0) {
      const w = specialOps.windowAt(now);
      const run = stmts.run.get(player.id, w.key) || null;
      const base = baseMission(player.level);
      const stageNo = run ? run.stage : 1;
      const choices = Object.values(specialOps.APPROACHES).map((a) => {
        const m = specialOps.stageMission(w.op, Math.min(stageNo, 3), a.id, base);
        return { ...a, label: w.op.stages[Math.min(stageNo, 3) - 1][a.id], energy: m.energy, chancePct: Math.round(game.successChance(m, game.applyRegen(player, now), stats, chanceBonus) * 100), cash: m.cash };
      });
      return {
        op: w.op,
        open: w.open,
        closesAt: w.closesAt,
        nextAt: specialOps.nextOpening(now),
        enabled: tuning.get('specialOpsEnabled'),
        locked: player.level < specialOps.MIN_LEVEL,
        minLevel: specialOps.MIN_LEVEL,
        run,
        stage: stageNo,
        stageName: w.op.stages[Math.min(stageNo, 3) - 1].name,
        choices,
        bonus: specialOps.completionBonus(base, run ? run.assaults : 0),
        blocker: blocker(player, w, run),
        missionBlocker: game.missionBlocker({ ...base, energy: base.energy }, game.applyRegen(player, now), now),
        completedBy: stmts.recent.get(w.key).n,
      };
    },

    /**
     * Plays the next stage with `approachId` (inside the caller's transaction).
     * Returns { error } or { result, stage, completed, failed, bonus, found, vehicle, player }.
     */
    run(userId, approachId, { stats, xpBonus = 0, cashBonus = 0, chanceBonus = 0, now = service.clock(), rng = service.rng } = {}) {
      const approach = specialOps.APPROACHES[approachId];
      if (!approach) return { error: 'Choose stealth or assault.' };
      const w = specialOps.windowAt(now);
      const fresh = players.findById(userId);
      let run = stmts.run.get(userId, w.key) || null;
      const why = blocker(fresh, w, run);
      if (why) return { error: `${why}.` };
      const base = baseMission(fresh.level);
      const stageNo = run ? run.stage : 1;
      const mission = specialOps.stageMission(w.op, stageNo, approach.id, base);
      const out = game.resolveMission(mission, fresh, { now, rng, stats, xpBonus, cashBonus, chanceBonus });
      if (out.error) return out;
      if (!run) { stmts.start.run(userId, w.key, w.op.id, now, now); run = stmts.run.get(userId, w.key); }
      const p = out.player;
      const r = out.result;
      const assault = approach.id === 'assault' ? 1 : 0;
      let completed = false;
      let bonus = null;
      let found = {};
      let vehicle = null;
      const levels = [...r.levelsGained];
      if (!r.success) {
        stmts.finish.run('failed', assault, now, userId, w.key);
      } else if (stageNo < w.op.stages.length) {
        stmts.advance.run(assault, now, userId, w.key, stageNo);
      } else {
        completed = true;
        stmts.finish.run('done', assault, now, userId, w.key);
        stmts.done.run(userId);
        const b = specialOps.completionBonus(base, run.assaults + assault);
        bonus = { cash: Math.round(b.cash * (1 + cashBonus)), xp: Math.round(b.xp * (1 + xpBonus)) };
        p.cash += bonus.cash;
        levels.push(...game.grantXp(p, bonus.xp));
      }
      players.save(p, { reason: 'special-op', ref: `${w.op.id}:${w.key}:${stageNo}` });
      if (completed) {
        // A haul for the workshop, rich in cores, and sometimes a vehicle they don't have yet.
        if (workshopService) {
          for (const bag of [workshopService.find(userId, bonus.cash, 'operation', rng), workshopService.find(userId, bonus.cash, 'operation', rng)]) {
            for (const [k, n] of Object.entries(bag)) found[k] = (found[k] || 0) + n;
          }
        }
        if (vehicleService && rng() < specialOps.VEHICLE_CHANCE) {
          const owned = vehicleService.owned(userId);
          const options = vehicles.VEHICLES.filter((v) => v.minLevel <= p.level && !owned.has(v.id));
          if (options.length) {
            vehicle = options[Math.floor(rng() * options.length)];
            vehicleService.grant(userId, vehicle.id);
            players.notify(userId, 'system', `Captured on ${w.op.name}: a ${vehicle.name}! It’s waiting in your motor pool.`, '/armory/motor-pool');
          }
        }
        players.log(userId, 'success', `${w.op.name} complete! Bonus +${money(bonus.cash)}, +${bonus.xp} XP${workshop.describe(found) ? `, ${workshop.describe(found)}` : ''}${vehicle ? `, and a captured ${vehicle.name}` : ''}.`, '/missions#special');
      } else {
        players.log(userId, r.success ? 'success' : 'failure', r.success
          ? `${mission.name} (${approach.name.toLowerCase()}): done. +${r.xp} XP, +${money(r.cash)}.`
          : `${mission.name} (${approach.name.toLowerCase()}): failed, and the run is over. Took ${r.damage} damage.`, '/missions#special');
      }
      for (const lvl of levels) {
        const rank = game.rankFor(lvl);
        players.log(userId, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
      }
      return { op: w.op, mission, approach, result: r, stage: stageNo, completed, failed: !r.success, bonus, found, vehicle, levelsGained: levels };
    },
  };
  return service;
}

module.exports = { createSpecialOpService };
