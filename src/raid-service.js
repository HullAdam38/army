'use strict';

const raids = require('./raids');
const units = require('./units');
const game = require('./game');
const { statsOf } = require('./armory');
const { announceLevels } = require('./notify');

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Unit raids backed by the database. launch() and strike() run inside the
 * caller's transaction; finishDue() settles raids that have run out of time.
 */
function createRaidService(db, players, unitRepo, { onStrike = () => {} } = {}) {
  const stmts = {
    active: db.prepare("SELECT * FROM raids WHERE unit_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"),
    byId: db.prepare('SELECT * FROM raids WHERE id = ?'),
    recent: db.prepare("SELECT * FROM raids WHERE unit_id = ? AND status != 'active' ORDER BY id DESC LIMIT ?"),
    insert: db.prepare(`INSERT INTO raids (unit_id, stronghold, hp, max_hp, cash_pool, xp_pool, launched_by, started_at, ends_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // The stronghold only loses what it has left, so it can't go below zero.
    damage: db.prepare("UPDATE raids SET hp = MAX(0, hp - ?) WHERE id = ? AND status = 'active'"),
    hit: db.prepare(`INSERT INTO raid_hits (raid_id, user_id, damage, strikes, last_at) VALUES (?, ?, ?, 1, ?)
                     ON CONFLICT(raid_id, user_id) DO UPDATE SET damage = damage + excluded.damage, strikes = strikes + 1, last_at = excluded.last_at`),
    hits: db.prepare(`SELECT h.*, u.username, u.avatar_v, u.unit_id AS current_unit, u.banned_at FROM raid_hits h JOIN users u ON u.id = h.user_id
                      WHERE h.raid_id = ? ORDER BY h.damage DESC`),
    myHit: db.prepare('SELECT * FROM raid_hits WHERE raid_id = ? AND user_id = ?'),
    settle: db.prepare("UPDATE raids SET status = ?, finished_at = ? WHERE id = ? AND status = 'active'"),
    paid: db.prepare('UPDATE raid_hits SET cash = ?, xp = ? WHERE raid_id = ? AND user_id = ?'),
    nudge: db.prepare('UPDATE raids SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL'),
    remind: db.prepare('UPDATE raids SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL'),
    overdue: db.prepare("SELECT * FROM raids WHERE status = 'active' AND ends_at <= ?"),
    endingSoon: db.prepare("SELECT * FROM raids WHERE status = 'active' AND reminded_at IS NULL AND ends_at > ?1 AND ends_at <= ?2"),
    members: db.prepare('SELECT COUNT(*) AS n, AVG(level) AS level FROM users WHERE unit_id = ? AND banned_at IS NULL'),
  };

  const strongholdOf = (raid) => raids.STRONGHOLDS_BY_ID.get(raid.stronghold);
  const unitSize = (unitId) => {
    const m = stmts.members.get(unitId);
    return { members: m.n, avgLevel: m.level || 1 };
  };
  const tell = (unitId, message, link, exceptId = null) => {
    for (const id of unitRepo.memberIds(unitId)) if (id !== exceptId) players.notify(id, 'unit', message, link);
  };

  /** Pays out a defeated stronghold, split by damage. */
  function win(raid, now) {
    if (!stmts.settle.run('won', now, raid.id).changes) return;
    const unit = unitRepo.findById(raid.unit_id);
    const s = strongholdOf(raid);
    // Only people still in the unit (and not banned) share the loot; the rest split what leavers would have had.
    const hits = stmts.hits.all(raid.id).filter((h) => h.current_unit === raid.unit_id && !h.banned_at);
    const loot = raids.splitLoot({ cash: raid.cash_pool, xp: raid.xp_pool }, hits);
    if (unit && loot.treasury) unitRepo.addTreasury(unit.id, loot.treasury);
    const link = `/units/${raid.unit_id}#raid`;
    for (const share of loot.players) {
      const p = game.applyRegen(players.findById(share.userId), now);
      p.cash += share.cash;
      const levels = game.grantXp(p, share.xp);
      players.save(p, { reason: 'raid-loot', ref: `raid:${raid.id}` });
      stmts.paid.run(share.cash, share.xp, raid.id, share.userId);
      players.log(share.userId, 'success', `${s.name} taken! Your share (${Math.round(share.share * 100)}% of the damage): +${money(share.cash)}, +${share.xp} XP.`, link);
      for (const lvl of levels) {
        const r = game.rankFor(lvl);
        players.log(share.userId, 'promotion', `Promoted to level ${lvl} — ${r.name} (${r.grade}).`);
      }
      announceLevels(players, share.userId, levels);
    }
    if (unit) {
      unitRepo.log(unit.id, 'raid', `${s.name} taken! ${money(raid.cash_pool)} in loot: ${money(loot.treasury)} to the treasury, the rest shared by damage.`, now);
      tell(unit.id, `[${unit.tag}] took the ${s.name}! Loot is shared by damage dealt, and ${money(loot.treasury)} went to the treasury.`, link);
    }
  }

  function fail(raid, now) {
    if (!stmts.settle.run('failed', now, raid.id).changes) return;
    const unit = unitRepo.findById(raid.unit_id);
    if (!unit) return;
    const s = strongholdOf(raid);
    const pct = Math.round(((raid.max_hp - raid.hp) / raid.max_hp) * 100);
    unitRepo.log(unit.id, 'raid', `The raid on the ${s.name} ran out of time at ${pct}%. No loot.`, now);
    tell(unit.id, `[${unit.tag}] ran out of time on the ${s.name} (${pct}% down). No loot this time.`, `/units/${unit.id}#raid`);
  }

  return {
    /** Launch a raid (Lieutenant+). Returns { raid } or { error }. */
    launch({ unit, role, me, strongholdId, now = Date.now() }) {
      if (!units.can.raid(role)) return { error: 'Only Lieutenants and the Commander can launch a raid.' };
      if (stmts.active.get(unit.id)) return { error: 'Your unit is already on a raid. Finish it first.' };
      const size = unitSize(unit.id);
      const s = raids.STRONGHOLDS_BY_ID.get(String(strongholdId || ''));
      if (!s) return { error: 'Pick a stronghold.' };
      if (size.avgLevel < s.minLevel) return { error: `The ${s.name} needs a unit average of level ${s.minLevel}.` };
      const p = raids.plan(s, size);
      if (!unitRepo.spendTreasury(unit.id, p.cost)) return { error: `Supplies for this raid cost ${money(p.cost)} from the treasury, which has ${money(unit.treasury)}.` };
      const id = Number(stmts.insert.run(unit.id, s.id, p.hp, p.hp, p.cash, p.xp, me.id, now, now + raids.DURATION_MS).lastInsertRowid);
      unitRepo.log(unit.id, 'raid', `${me.username} launched a raid on the ${s.name} (${money(p.cost)} in supplies). 48 hours on the clock.`, now);
      tell(unit.id, `${units.roleLabel(role)} ${me.username} launched a raid on the ${s.name}! Strike it together within 48 hours to share ${money(p.cash)} in loot.`, `/units/${unit.id}#raid`, me.id);
      return { raid: stmts.byId.get(id), stronghold: s, plan: p };
    },

    /** One strike by a member. Returns { damage, hurt, raid, won } or { error }. */
    strike({ unitId, userId, now = Date.now(), rng = Math.random }) {
      const raid = stmts.active.get(unitId);
      if (!raid) return { error: 'There’s no raid under way.' };
      if (raid.ends_at <= now) { fail(raid, now); return { error: 'The raid has run out of time.' }; }
      const player = game.applyRegen(players.findById(userId), now);
      if (player.unit_id !== unitId) return { error: 'You’re not in this unit.' };
      const blocker = raids.strikeBlocker(player, now);
      if (blocker) return { error: `${blocker}.` };
      const hit = raids.strike(statsOf(players, player), player, rng);
      if (player.energy >= player.max_energy) player.energy_updated_at = now; // regen starts again from here
      player.energy -= raids.STRIKE_ENERGY;
      if (player.health >= player.max_health) player.health_updated_at = now;
      player.health = Math.max(1, player.health - hit.hurt);
      players.save(player, { reason: 'raid-strike', ref: `raid:${raid.id}` });
      const dealt = Math.min(hit.damage, raid.hp);
      stmts.damage.run(dealt, raid.id);
      stmts.hit.run(raid.id, userId, dealt, now);
      onStrike(userId, now);
      const after = stmts.byId.get(raid.id);
      const s = strongholdOf(raid);
      if (after.hp <= 0) {
        win(after, now);
      } else if (after.hp <= after.max_hp * (1 - raids.NUDGE_AT) && stmts.nudge.run(now, raid.id).changes) {
        const unit = unitRepo.findById(unitId);
        tell(unitId, `[${unit.tag}] has the ${s.name} at ${Math.round((after.hp / after.max_hp) * 100)}% health. Finish it!`, `/units/${unitId}#raid`);
      }
      return { damage: dealt, hurt: hit.hurt, raid: stmts.byId.get(raid.id), won: after.hp <= 0, stronghold: s };
    },

    /** The raid card for a unit page. */
    view(unit, me, role, now = Date.now()) {
      const raid = stmts.active.get(unit.id);
      const size = unitSize(unit.id);
      const last = stmts.recent.all(unit.id, 1)[0] || null;
      const card = {
        canLaunch: units.can.raid(role),
        options: raids.available(size).map((s) => ({ ...s, affordable: unit.treasury >= s.cost })),
        next: raids.STRONGHOLDS.find((s) => s.minLevel > size.avgLevel) || null,
        energy: raids.STRIKE_ENERGY,
        last: last ? { ...last, name: strongholdOf(last).name } : null,
      };
      if (!raid) return card;
      const hits = stmts.hits.all(raid.id);
      const mine = hits.find((h) => h.user_id === me.id);
      const p = game.applyRegen(me, now);
      return {
        ...card,
        raid: {
          ...raid,
          name: strongholdOf(raid).name,
          blurb: strongholdOf(raid).blurb,
          pct: Math.round((raid.hp / raid.max_hp) * 100),
          strikers: hits.length,
          top: hits.slice(0, 5).map((h) => ({ userId: h.user_id, username: h.username, avatarV: h.avatar_v, damage: h.damage, strikes: h.strikes, share: Math.round((h.damage / Math.max(1, raid.max_hp - raid.hp)) * 100) })),
          mine: mine ? { damage: mine.damage, strikes: mine.strikes } : null,
          blocker: raid.ends_at <= now ? 'The raid has run out of time' : raids.strikeBlocker(p, now),
        },
      };
    },

    recent: (unitId, limit = 5) => stmts.recent.all(unitId, limit).map((r) => ({ ...r, name: strongholdOf(r).name })),

    /** Settles raids that ran out of time, and reminds units with 6 hours left. */
    finishDue(now = Date.now()) {
      for (const raid of stmts.overdue.all(now)) players.transaction(() => fail(raid, now));
      for (const raid of stmts.endingSoon.all(now, now + raids.REMIND_BEFORE_MS)) {
        if (!stmts.remind.run(now, raid.id).changes) continue;
        const unit = unitRepo.findById(raid.unit_id);
        if (unit) tell(unit.id, `6 hours left on the raid: the ${strongholdOf(raid).name} still has ${Math.round((raid.hp / raid.max_hp) * 100)}% health.`, `/units/${unit.id}#raid`);
      }
    },

    schedule() {
      const timer = setInterval(() => { try { this.finishDue(); } catch (err) { console.error('[raids] settle failed', err); } }, 5 * 60 * 1000);
      timer.unref();
    },
  };
}

module.exports = { createRaidService };
