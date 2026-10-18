'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const reserve = require('./reserve');
const game = require('./game');
const pvp = require('./pvp');
const tuning = require('./tuning');
const { statsOf } = require('./armory');
const { announceLevels } = require('./notify');

/**
 * Reserve soldiers backed by the database (rules in src/reserve.js). Every
 * tick (10 minutes) it keeps the right number on duty, lets the ones "on"
 * play a little (missions, the odd fight between themselves), runs the HQ
 * starter units and hands those over to real players once enough join.
 *
 * Money: reserve soldiers' cash moves through the ledger like anyone's
 * (reason `reserve` for what the game gives them, `pvp` for fights). They
 * only ever fight each other on their own; real players fight them as normal.
 */
function createReserveService(db, players, unitRepo, { rng = Math.random } = {}) {
  const stmts = {
    realActive: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND is_admin = 0 AND banned_at IS NULL AND last_seen_at >= ?'),
    onDuty: db.prepare('SELECT * FROM users WHERE is_bot = 1 AND banned_at IS NULL ORDER BY id'),
    taken: db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE'),
    insert: db.prepare(`
      INSERT INTO users (username, email, password_hash, level, xp, cash, energy, max_energy, health, max_health,
                         energy_updated_at, health_updated_at, created_at, last_seen_at, is_bot, bot_pace,
                         stat_str, stat_agi, stat_end, missions_completed, missions_failed, pvp_wins, pvp_losses)
      VALUES (@username, @email, @password_hash, @level, 0, @cash, @max_energy, @max_energy, @max_health, @max_health,
              @now, @now, @created_at, @last_seen_at, 1, @pace, @stat_str, @stat_agi, @stat_end, @missions, @failed, @wins, @losses)`),
    ledger: db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, ref, created_at) VALUES (?, ?, 0, 'reserve', 'joined', ?)"),
    equip: db.prepare('INSERT INTO equipment (user_id, slot, item_id) VALUES (?, ?, ?) ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id'),
    seen: db.prepare('UPDATE users SET last_seen_at = ?, missions_completed = missions_completed + ?, missions_failed = missions_failed + ? WHERE id = ?'),
    train: db.prepare('UPDATE users SET stat_str = stat_str + ?, stat_agi = stat_agi + ?, stat_end = stat_end + ? WHERE id = ?'),
    standDown: db.prepare("UPDATE users SET banned_at = ?, ban_reason = 'Reserve soldier stood down' WHERE id = ? AND is_bot = 1"),
    hqUnitsEver: db.prepare('SELECT COUNT(*) AS n FROM units WHERE hq > 0'),
    hqUnits: db.prepare('SELECT * FROM units WHERE hq = 1'),
    setHq: db.prepare('UPDATE units SET hq = ? WHERE id = ?'),
    makeHq: db.prepare('UPDATE units SET hq = 1, recruiting = 1 WHERE id = ?'),
    roster: db.prepare('SELECT id, username, level, is_bot, unit_role, last_seen_at FROM users WHERE unit_id = ? AND banned_at IS NULL ORDER BY level DESC, xp DESC, id'),
    lastAttack: db.prepare('SELECT MAX(created_at) AS at FROM battles WHERE attacker_id = ? AND defender_id = ?'),
  };

  const realActive = (now) => stmts.realActive.get(now - reserve.ACTIVE_MS).n;
  const onDuty = () => stmts.onDuty.all();
  const gearUp = (id, level) => { for (const [slot, item] of Object.entries(reserve.gearFor(level))) stmts.equip.run(id, slot, item); };

  /** Signs up `count` new reserve soldiers. Returns their ids. */
  function enlist(count, now) {
    const ids = [];
    const used = new Set();
    for (const name of reserve.NAMES) {
      if (ids.length >= count) break;
      const email = `${name.toLowerCase()}@reserve.invalid`;
      if (used.has(name) || stmts.taken.get(name, email)) continue;
      used.add(name);
      const level = reserve.startLevel(ids.length, count);
      const missions = Math.round(level * level * (1 + rng()));
      const fights = Math.round(Math.max(0, level - 3) * (1 + 2 * rng()));
      const id = Number(stmts.insert.run({
        username: name,
        email,
        // They can never sign in (sign-in also refuses reserve soldiers outright).
        password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4),
        level,
        cash: reserve.cashTarget(level),
        max_energy: 50 + 5 * (level - 1),
        max_health: 100 + 10 * (level - 1),
        now,
        created_at: now - Math.floor((1 + rng() * 29) * 24 * 3_600_000),
        last_seen_at: now - Math.floor(rng() * 48 * 3_600_000),
        pace: reserve.pace(rng),
        ...reserve.trainedStats(level, rng),
        missions,
        failed: Math.round(missions * 0.15 * rng()),
        wins: Math.round(fights * 0.6),
        losses: Math.round(fights * 0.4),
      }).lastInsertRowid);
      stmts.ledger.run(id, reserve.cashTarget(level), now);
      gearUp(id, level);
      ids.push(id);
    }
    return ids;
  }

  /** Stands down `count` reserve soldiers, never the Commanders of HQ starter units. */
  function standDown(list, count, now) {
    const hqLeaders = new Set(stmts.hqUnits.all().map((u) => stmts.roster.all(u.id).find((m) => m.unit_role === 'leader')).filter(Boolean).map((m) => m.id));
    const out = [];
    for (const b of [...list].sort(() => rng() - 0.5)) {
      if (out.length >= count) break;
      if (hqLeaders.has(b.id)) continue;
      if (b.unit_id) unitRepo.kick(b.unit_id, b.id);
      stmts.standDown.run(now, b.id);
      out.push(b.id);
    }
    return out;
  }

  /** Founds the HQ starter units (once, ever), each with a few reserve soldiers. */
  function foundHqUnits(now) {
    if (stmts.hqUnitsEver.get().n) return [];
    const free = onDuty().filter((b) => !b.unit_id && b.level >= 5).sort((a, b) => b.level - a.level);
    const made = [];
    for (const def of reserve.HQ_UNITS) {
      if (free.length < reserve.HQ_MEMBERS) break;
      const taken = unitRepo.taken(def.name, def.tag);
      if (taken.name || taken.tag) continue;
      const [leader, ...rest] = free.splice(0, reserve.HQ_MEMBERS);
      const id = unitRepo.create({ name: def.name, tag: def.tag, description: def.description, leaderId: leader.id, now });
      stmts.makeHq.run(id);
      for (const m of rest) unitRepo.join(id, m.id, now);
      unitRepo.log(id, 'founded', `HQ formed ${def.name} as a starter unit.`, now);
      made.push(id);
    }
    return made;
  }

  /**
   * HQ starter units pass to their players once enough have joined: the most
   * senior real member takes command and the reserve soldiers leave. With
   * `all` (reserve soldiers switched off) every HQ unit goes: to its players
   * if it has any, otherwise it's disbanded.
   */
  function handOver(now, { all = false } = {}) {
    const out = [];
    for (const unit of stmts.hqUnits.all()) {
      const roster = stmts.roster.all(unit.id);
      const real = roster.filter((m) => !m.is_bot);
      if (all && !real.length) {
        unitRepo.disband(unit.id);
        out.push(unit.id);
        continue;
      }
      if (real.length < (all ? 1 : reserve.HQ_HANDOVER_AT)) continue;
      const chief = real[0];
      unitRepo.setRole(unit.id, chief.id, 'leader');
      if (real[1]) unitRepo.setRole(unit.id, real[1].id, 'officer');
      for (const m of roster.filter((r) => r.is_bot)) unitRepo.kick(unit.id, m.id);
      stmts.setHq.run(2, unit.id);
      unitRepo.log(unit.id, 'transfer', `HQ handed ${unit.name} over to its soldiers. ${chief.username} is now Commander.`, now);
      for (const m of real) {
        players.notify(m.id, 'unit', m.id === chief.id
          ? `HQ has handed ${unit.name} over to its soldiers, and you are its Commander. You now run applications, the treasury, raids and wars.`
          : `HQ has handed ${unit.name} over to its soldiers. ${chief.username} is now Commander.`, `/units/${unit.id}`);
      }
      players.news(chief.id, `HQ handed [b]${unit.name}[/b] (${unit.tag}) over to its soldiers, with [b]${chief.username}[/b] in command.`, now);
      out.push(unit.id);
    }
    return out;
  }

  /** One tick of play for the reserve soldiers who are "on". */
  function play(list, now) {
    const maxLevel = tuning.get('reserveMaxLevel');
    const on = [];
    for (const raw of list) {
      const p = raw.bot_pace || 1;
      if (rng() >= reserve.PLAY_CHANCE * p) continue;
      const b = game.applyRegen(raw, now);
      on.push(b);
      const runs = 1 + Math.floor(rng() * 3);
      stmts.seen.run(now, runs, rng() < 0.2 ? 1 : 0, b.id);
      b.last_seen_at = now;
      const levels = b.level < maxLevel ? game.grantXp(b, reserve.xpPerPlay(b.level, p, rng)) : [];
      if (b.cash < reserve.cashTarget(b.level)) b.cash += Math.min(reserve.cashTarget(b.level) - b.cash, b.level * 40);
      players.save(b, { reason: 'reserve', ref: 'missions' });
      if (levels.length) {
        gearUp(b.id, b.level);
        for (let i = 0; i < levels.length; i += 1) {
          const pick = Math.floor(rng() * 3);
          stmts.train.run(pick === 0 ? 1 : 0, pick === 1 ? 1 : 0, pick === 2 ? 1 : 0, b.id);
        }
        announceLevels(players, b.id, levels);
      }
    }
    return on;
  }

  /** A skirmish or two between reserve soldiers who are on, for the combat feed. */
  function skirmish(on, list, now) {
    const fights = [];
    for (let n = 0; n < 2 && on.length; n += 1) {
      const attacker = players.findById(on[Math.floor(rng() * on.length)].id);
      const foes = list.filter((d) => d.id !== attacker.id && !(attacker.unit_id && attacker.unit_id === d.unit_id));
      if (!foes.length) break;
      const defender = players.findById(foes[Math.floor(rng() * foes.length)].id);
      const out = pvp.resolveAttack(attacker, defender, {
        aStats: statsOf(players, attacker),
        dStats: statsOf(players, defender),
        lastAttackAt: stmts.lastAttack.get(attacker.id, defender.id).at,
        rng,
        now,
      });
      if (out.error) continue;
      const id = players.recordBattle(attacker.id, defender.id, out.report, now);
      players.save(out.attacker, { reason: 'pvp', ref: `battle:${id}` });
      players.save(out.defender, { reason: 'pvp', ref: `battle:${id}` });
      fights.push(id);
    }
    return fights;
  }

  return {
    /** The whole tick. Returns what happened, for tests and the log. */
    tick(now = Date.now()) {
      return players.transaction(() => {
        const want = reserve.wanted(tuning.get('reserveSoldiers'), realActive(now));
        if (want === 0) handOver(now, { all: true }); // switched off (or outgrown): HQ units go first, so their Commanders can stand down too
        let list = onDuty();
        const enlisted = list.length < want ? enlist(Math.min(50, want - list.length), now) : [];
        const stoodDown = list.length > want ? standDown(list, list.length - want, now) : [];
        if (enlisted.length || stoodDown.length) list = onDuty();
        const founded = want >= reserve.HQ_UNITS.length * reserve.HQ_MEMBERS ? foundHqUnits(now) : [];
        const handed = handOver(now);
        if (founded.length || handed.length) list = onDuty();
        const on = play(list, now);
        const fights = skirmish(on, onDuty(), now);
        return { want, enlisted: enlisted.length, stoodDown: stoodDown.length, founded: founded.length, handed: handed.length, on: on.length, fights: fights.length };
      });
    },

    /** Admin › Game settings shows how many there are. */
    count: () => onDuty().length,

    schedule() {
      const timer = setInterval(() => { try { this.tick(); } catch (err) { console.error('[reserve] tick failed', err); } }, reserve.TICK_MS);
      timer.unref();
    },
  };
}

/** Whether `unit` is an HQ starter unit that takes applicants straight away. */
const autoAccepts = (unit) => Boolean(unit && unit.hq === 1 && unit.recruiting);

module.exports = { autoAccepts, createReserveService };
