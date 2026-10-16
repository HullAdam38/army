'use strict';

const wars = require('./wars');
const { NEUTRAL } = require('./events');
const tuning = require('./tuning');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Unit wars backed by the database. declare() and finish() change treasuries,
 * so call them inside players.transaction(); finishDue() opens its own.
 */
function createWarService(db, players, unitRepo, { effects = () => NEUTRAL } = {}) {
  const ACTIVE_BETWEEN = `status = 'active' AND ((attacker_unit_id = ?1 AND defender_unit_id = ?2) OR (attacker_unit_id = ?2 AND defender_unit_id = ?1))`;
  const stmts = {
    insert: db.prepare(`INSERT INTO unit_wars (attacker_unit_id, defender_unit_id, attacker_name, attacker_tag, defender_name, defender_tag, stake, started_at, ends_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    byId: db.prepare('SELECT * FROM unit_wars WHERE id = ?'),
    activeFor: db.prepare(`SELECT * FROM unit_wars WHERE status = 'active' AND (attacker_unit_id = ?1 OR defender_unit_id = ?1) ORDER BY id DESC LIMIT 1`),
    between: db.prepare(`SELECT * FROM unit_wars WHERE ${ACTIVE_BETWEEN} LIMIT 1`),
    lastPair: db.prepare(`SELECT MAX(started_at) AS at FROM unit_wars
                          WHERE (attacker_unit_id = ?1 AND defender_unit_id = ?2) OR (attacker_unit_id = ?2 AND defender_unit_id = ?1)`),
    due: db.prepare("SELECT id FROM unit_wars WHERE status = 'active' AND ends_at <= ?"),
    score: {
      attacker: db.prepare('UPDATE unit_wars SET attacker_score = attacker_score + ? WHERE id = ?'),
      defender: db.prepare('UPDATE unit_wars SET defender_score = defender_score + ? WHERE id = ?'),
    },
    addFight: db.prepare('INSERT OR IGNORE INTO unit_war_battles (war_id, battle_id, side, user_id, points, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    end: db.prepare("UPDATE unit_wars SET status = 'ended', winner = ?, result_note = ?, ended_at = ? WHERE id = ? AND status = 'active'"),
    record: {
      win: db.prepare('UPDATE units SET war_wins = war_wins + 1, war_protected_until = ? WHERE id = ?'),
      loss: db.prepare('UPDATE units SET war_losses = war_losses + 1, war_protected_until = ? WHERE id = ?'),
      draw: db.prepare('UPDATE units SET war_draws = war_draws + 1, war_protected_until = ? WHERE id = ?'),
    },
    prize: db.prepare('UPDATE units SET treasury = treasury + ? WHERE id = ?'),
    // Victory Medal: only soldiers who were in the winning unit when the war began.
    veterans: db.prepare('UPDATE users SET wars_won = wars_won + 1 WHERE unit_id = ? AND unit_joined_at <= ?'),
    spend: db.prepare('UPDATE units SET treasury = treasury - ?1 WHERE id = ?2 AND treasury >= ?1'),
    history: db.prepare(`SELECT * FROM unit_wars WHERE attacker_unit_id = ?1 OR defender_unit_id = ?1 ORDER BY id DESC LIMIT ?2`),
    recent: db.prepare(`SELECT * FROM unit_wars WHERE status = 'ended' ORDER BY ended_at DESC LIMIT ?`),
    active: db.prepare(`SELECT * FROM unit_wars WHERE status = 'active' ORDER BY ends_at ASC`),
    fights: db.prepare(`
      SELECT f.side, f.points, f.created_at, b.id AS battle_id, b.knockout, b.attacker_won,
             a.username AS attacker_name, d.username AS defender_name
      FROM unit_war_battles f JOIN battles b ON b.id = f.battle_id
      JOIN users a ON a.id = b.attacker_id JOIN users d ON d.id = b.defender_id
      WHERE f.war_id = ? ORDER BY f.created_at DESC LIMIT ?`),
    top: db.prepare(`
      SELECT f.side, u.username, SUM(f.points) AS points, COUNT(*) AS wins
      FROM unit_war_battles f JOIN users u ON u.id = f.user_id
      WHERE f.war_id = ? GROUP BY f.side, f.user_id ORDER BY points DESC, wins DESC LIMIT 20`),
    forBattle: db.prepare(`SELECT f.side, f.points, w.* FROM unit_war_battles f JOIN unit_wars w ON w.id = f.war_id WHERE f.battle_id = ?`),
  };

  const tagged = (name, tag) => `${name} [${tag}]`;
  const notifyUnit = (unitId, message, link) => {
    if (!unitId) return;
    for (const id of unitRepo.memberIds(unitId)) players.notify(id, 'war', message, link);
  };

  /** Settles a war: prizes, records, protection, logs and notifications. */
  function finish(war, now = Date.now(), { forfeit = null } = {}) {
    let result;
    let note = null;
    if (forfeit) {
      // The side that disbanded loses. The attacker only ever gets its own stake back.
      const winner = forfeit === 'attacker' ? 'defender' : 'attacker';
      result = { winner, attackerPrize: winner === 'attacker' ? war.stake : 0, defenderPrize: 0 };
      note = `${forfeit === 'attacker' ? tagged(war.attacker_name, war.attacker_tag) : tagged(war.defender_name, war.defender_tag)} disbanded.`;
    } else {
      result = wars.settle(war);
      const mult = effects(now).warPrizeMult * tuning.get('warPrizeMult'); // War Season event × admin setting
      result = { ...result, attackerPrize: Math.round(result.attackerPrize * mult), defenderPrize: Math.round(result.defenderPrize * mult) };
    }
    if (!stmts.end.run(result.winner, note, now, war.id).changes) return null; // already settled
    const protectUntil = now + wars.PROTECTION_MS;
    const sides = [
      ['attacker', war.attacker_unit_id, result.attackerPrize],
      ['defender', war.defender_unit_id, result.defenderPrize],
    ];
    for (const [side, unitId, prize] of sides) {
      if (!unitId || forfeit === side) continue;
      const outcome = result.winner === null ? 'draw' : result.winner === side ? 'win' : 'loss';
      stmts.record[outcome].run(protectUntil, unitId);
      if (outcome === 'win') stmts.veterans.run(unitId, war.started_at);
      if (prize) stmts.prize.run(prize, unitId);
    }
    const a = tagged(war.attacker_name, war.attacker_tag);
    const d = tagged(war.defender_name, war.defender_tag);
    const score = `${war.attacker_score}–${war.defender_score}`;
    const link = `/wars/${war.id}`;
    const headline = result.winner === null
      ? `War between ${a} and ${d} ended in a draw (${score}).`
      : `${result.winner === 'attacker' ? a : d} won the war against ${result.winner === 'attacker' ? d : a}${forfeit ? ' by forfeit' : ` (${score})`}.`;
    for (const [side, unitId, prize] of sides) {
      if (!unitId || forfeit === side) continue;
      unitRepo.log(unitId, 'war', `${headline}${prize ? ` ${money(prize)} added to the treasury.` : ''}`, now);
      notifyUnit(unitId, `${headline}${prize ? ` ${money(prize)} added to the treasury.` : ''}`, link);
    }
    return { ...result, headline };
  }

  return {
    activeFor: (unitId) => (unitId ? stmts.activeFor.get(unitId) || null : null),
    findById: (id) => stmts.byId.get(id) || null,

    /** Facts declareBlocker() needs about a pair of units. */
    context(attacker, target) {
      return {
        attackerAtWar: Boolean(stmts.activeFor.get(attacker.id)),
        targetAtWar: Boolean(stmts.activeFor.get(target.id)),
        attackerMembers: unitRepo.memberCount(attacker.id),
        targetMembers: unitRepo.memberCount(target.id),
        lastPairWarAt: stmts.lastPair.get(attacker.id, target.id).at,
      };
    },

    /** Declares war. Returns { error } or { warId }. */
    declare({ me, attacker, target, now = Date.now() }) {
      const blocker = wars.declareBlocker(attacker, target, this.context(attacker, target), now);
      if (blocker) return { error: blocker };
      if (!stmts.spend.run(wars.WAR_STAKE, attacker.id).changes) return { error: 'The treasury changed. Try again.' };
      const warId = Number(stmts.insert.run(attacker.id, target.id, attacker.name, attacker.tag, target.name, target.tag, wars.WAR_STAKE, now, now + wars.WAR_DURATION_MS).lastInsertRowid);
      const link = `/wars/${warId}`;
      unitRepo.log(attacker.id, 'war', `${me.username} declared war on ${tagged(target.name, target.tag)}, staking ${money(wars.WAR_STAKE)}.`, now);
      unitRepo.log(target.id, 'war', `${tagged(attacker.name, attacker.tag)} declared war on us.`, now);
      notifyUnit(attacker.id, `${me.username} declared war on ${tagged(target.name, target.tag)}. You have 24 hours: every PvP win against them scores.`, link);
      notifyUnit(target.id, `${tagged(attacker.name, attacker.tag)} has declared war on your unit! Every PvP win against them in the next 24 hours scores.`, link);
      return { warId };
    },

    /**
     * Scores a finished PvP fight if the two players' units are at war.
     * Returns { warId, side, points, unitTag } or null.
     */
    recordFight({ battleId, a, d, attackerWon, knockout, fullRewards, now = Date.now() }) {
      if (!a.unit_id || !d.unit_id || a.unit_id === d.unit_id) return null;
      const war = stmts.between.get(a.unit_id, d.unit_id);
      if (!war || war.ends_at <= now) return null;
      const found = wars.scoreFight(war, { a, d, attackerWon, knockout, fullRewards });
      if (!found) return null;
      const scored = { ...found, points: found.points * effects(now).warPointsMult }; // War Season event
      const winner = attackerWon ? a : d;
      if (!stmts.addFight.run(war.id, battleId, scored.side, winner.id, scored.points, now).changes) return null;
      stmts.score[scored.side].run(scored.points, war.id);
      return { warId: war.id, ...scored, unitTag: scored.side === 'attacker' ? war.attacker_tag : war.defender_tag };
    },

    /** Settles every war whose time is up. Safe to call often. */
    finishDue(now = Date.now()) {
      let n = 0;
      for (const { id } of stmts.due.all(now)) {
        players.transaction(() => {
          const war = stmts.byId.get(id);
          if (war && war.status === 'active' && finish(war, now)) n += 1;
        });
      }
      return n;
    },

    /** A unit is disbanding: any war it's in ends as a loss for it. */
    forfeit(unitId, now = Date.now()) {
      const war = stmts.activeFor.get(unitId);
      if (!war) return null;
      return finish(war, now, { forfeit: war.attacker_unit_id === unitId ? 'attacker' : 'defender' });
    },

    history: (unitId, limit = 10) => stmts.history.all(unitId, limit),
    active: () => stmts.active.all(),
    recent: (limit = 10) => stmts.recent.all(limit),
    fights: (warId, limit = 25) => stmts.fights.all(warId, limit),
    top: (warId) => stmts.top.all(warId),
    forBattle: (battleId) => stmts.forBattle.get(battleId) || null,

    /** Runs finishDue() every minute in the background. */
    schedule(ms = 60 * 1000) {
      const run = () => {
        try { this.finishDue(); } catch (err) { console.error('[wars] settling failed', err); }
      };
      setInterval(run, ms).unref();
    },
  };
}

module.exports = { createWarService };
