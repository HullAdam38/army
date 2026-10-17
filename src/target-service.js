'use strict';

const target = require('./target');
const game = require('./game');
const pvp = require('./pvp');
const { announceLevels } = require('./notify');

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The daily high-value target, backed by the database. afterFight() runs
 * inside the attack's transaction.
 */
function createTargetService(db, players) {
  const stmts = {
    day: db.prepare(`SELECT t.*, u.username, u.level, u.avatar_v, u.banned_at, u.hospital_until, u.deploy_until
                     FROM daily_targets t JOIN users u ON u.id = t.user_id WHERE t.day = ?`),
    candidates: db.prepare(`SELECT id, username, level FROM users
                            WHERE banned_at IS NULL AND is_admin = 0 AND level >= ? AND last_seen_at >= ?
                            ORDER BY level DESC, xp DESC, id LIMIT ?`),
    insert: db.prepare('INSERT OR IGNORE INTO daily_targets (day, user_id, created_at) VALUES (?, ?, ?)'),
    claim: db.prepare('INSERT OR IGNORE INTO daily_target_claims (day, attacker_id, battle_id, cash, xp, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    claimed: db.prepare('SELECT 1 FROM daily_target_claims WHERE day = ? AND attacker_id = ?'),
    claimForBattle: db.prepare('SELECT * FROM daily_target_claims WHERE battle_id = ?'),
    claimCount: db.prepare('SELECT COUNT(*) AS n FROM daily_target_claims WHERE day = ?'),
    beaten: db.prepare('UPDATE daily_targets SET beaten = beaten + 1 WHERE day = ?'),
    defended: db.prepare('UPDATE daily_targets SET defenses = defenses + 1 WHERE day = ? AND defenses < ?'),
    defenseFrom: db.prepare('INSERT OR IGNORE INTO daily_target_defenses (day, attacker_id, battle_id) VALUES (?, ?, ?)'),
    pruneDefenses: db.prepare('DELETE FROM daily_target_defenses WHERE day < ?'),
    prune: db.prepare('DELETE FROM daily_target_claims WHERE day < ?'),
  };

  /** Today's target row (picking one on first look), or null if nobody qualifies yet. */
  function today(now = Date.now()) {
    const day = target.dayKey(now);
    let row = stmts.day.get(day);
    if (row) return row;
    const yesterday = stmts.day.get(target.dayKey(now - 24 * 60 * 60 * 1000));
    const chosen = target.pick(stmts.candidates.all(Math.max(pvp.MIN_PVP_LEVEL, 5), now - target.ACTIVE_MS, target.POOL), day, yesterday ? yesterday.user_id : null);
    if (!chosen) return null;
    if (stmts.insert.run(day, chosen.id, now).changes) {
      players.notify(chosen.id, 'target', `You’re today’s high-value target. Anyone who beats you earns a bonus, but every attack you fight off pays you ${money(target.defenseBonus(chosen.level))} (up to ${target.MAX_DEFENSE_PAYOUTS} today). Gear up.`, '/players#target');
    }
    return stmts.day.get(day);
  }

  function pay(userId, cash, xp, ref, now) {
    const p = game.applyRegen(players.findById(userId), now);
    p.cash += cash;
    const levels = xp ? game.grantXp(p, xp) : [];
    players.save(p, { reason: 'target-bonus', ref });
    for (const lvl of levels) {
      const r = game.rankFor(lvl);
      players.log(userId, 'promotion', `Promoted to level ${lvl} — ${r.name} (${r.grade}).`);
    }
    announceLevels(players, userId, levels);
  }

  return {
    today,

    /** The card shown on Players and HQ, from `me`'s point of view. */
    view(me, now = Date.now()) {
      const t = today(now);
      if (!t || t.banned_at) return null;
      const b = target.bonus(t.level);
      const isYou = t.user_id === me.id;
      return {
        id: t.user_id,
        username: t.username,
        level: t.level,
        rank: game.rankFor(t.level),
        avatarUrl: `/avatars/${t.user_id}?v=${t.avatar_v || 0}`,
        isYou,
        cash: b.cash,
        xp: b.xp,
        defenseCash: target.defenseBonus(t.level),
        defenses: t.defenses,
        maxDefenses: target.MAX_DEFENSE_PAYOUTS,
        beaten: t.beaten,
        claimed: !isYou && Boolean(stmts.claimed.get(t.day, me.id)),
        hospitalized: Boolean(t.hospital_until && t.hospital_until > now),
        deployed: Boolean(t.deploy_until && t.deploy_until > now),
        endsAt: target.dayEnds(t.day),
        // Why `me` can't attack them right now, if they can't.
        blocker: isYou ? null : pvp.attackBlocker(game.applyRegen(me, now), game.applyRegen(players.findById(t.user_id), now), { now, lastAttackAt: players.lastAttackAt(me.id, t.user_id) }),
      };
    },

    /** Is this player today's target? */
    isTarget: (userId, now = Date.now()) => {
      const t = stmts.day.get(target.dayKey(now));
      return Boolean(t && t.user_id === userId);
    },

    /**
     * Pays out after a fight with today's target. Only full-reward fights between
     * unlinked accounts count: `linked` is true when they share a device or a
     * network (anti.linked), since a second account could otherwise feed the
     * target wins or deliberate losses. Returns { claim } / { defense } / null.
     */
    afterFight({ battleId, attackerId, defenderId, attackerWon, rewards, linked = false, now = Date.now() }) {
      const t = stmts.day.get(target.dayKey(now));
      if (!t || t.user_id !== defenderId || linked) return null;
      if (attackerWon && rewards.attacker === 1) {
        const b = target.bonus(t.level);
        if (!stmts.claim.run(t.day, attackerId, battleId, b.cash, b.xp, now).changes) return null; // already collected today
        stmts.beaten.run(t.day);
        pay(attackerId, b.cash, b.xp, `battle:${battleId}`, now);
        players.log(attackerId, 'success', `Beat the high-value target ${t.username}: +${money(b.cash)}, +${b.xp} XP bonus.`, `/battles/${battleId}`);
        return { claim: b };
      }
      // A defence pays once per attacker per day, so one friend losing on purpose can't fill the cap.
      if (!attackerWon && rewards.defender === 1 && t.defenses < target.MAX_DEFENSE_PAYOUTS
        && stmts.defenseFrom.run(t.day, attackerId, battleId).changes && stmts.defended.run(t.day, target.MAX_DEFENSE_PAYOUTS).changes) {
        const cash = target.defenseBonus(t.level);
        pay(defenderId, cash, 0, `battle:${battleId}`, now);
        players.log(defenderId, 'success', `Held off an attack as the high-value target: +${money(cash)}.`, `/battles/${battleId}`);
        return { defense: { cash } };
      }
      return null;
    },

    forBattle: (battleId) => stmts.claimForBattle.get(battleId) || null,

    schedule() {
      // Picks the day's target soon after midnight, so they're told in good time.
      const timer = setInterval(() => {
        try {
          today();
          const cutoff = target.dayKey(Date.now() - 30 * 24 * 60 * 60 * 1000);
          stmts.prune.run(cutoff);
          stmts.pruneDefenses.run(cutoff);
        } catch (err) { console.error('[target] daily pick failed', err); }
      }, 10 * 60 * 1000);
      timer.unref();
    },
  };
}

module.exports = { createTargetService };
