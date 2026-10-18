'use strict';

const theatre = require('./theatre');
const units = require('./units');
const tuning = require('./tuning');

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The theatre of war backed by the database. track() and setFront() run inside
 * the caller's transaction; settleDue() hands regions over when a week ends and
 * payIncome() pays each holder once a day.
 */
function createTheatreService(db, players, unitRepo) {
  const stmts = {
    holders: db.prepare(`SELECT r.region, r.unit_id, r.held_since, u.name, u.tag FROM theatre_regions r
                         JOIN units u ON u.id = r.unit_id`),
    heldBy: db.prepare('SELECT region FROM theatre_regions WHERE unit_id = ?'),
    hold: db.prepare(`INSERT INTO theatre_regions (region, unit_id, held_since) VALUES (?, ?, ?)
                      ON CONFLICT(region) DO UPDATE SET unit_id = excluded.unit_id, held_since = excluded.held_since`),
    front: db.prepare('SELECT * FROM theatre_fronts WHERE week = ? AND unit_id = ?'),
    lastFront: db.prepare('SELECT * FROM theatre_fronts WHERE unit_id = ? ORDER BY week DESC LIMIT 1'),
    setFront: db.prepare(`INSERT INTO theatre_fronts (week, unit_id, region, set_by, set_at) VALUES (?, ?, ?, ?, ?)
                          ON CONFLICT(week, unit_id) DO UPDATE SET region = excluded.region, set_by = excluded.set_by, set_at = excluded.set_at`),
    fronts: db.prepare('SELECT region, COUNT(*) AS n FROM theatre_fronts WHERE week = ? GROUP BY region'),
    score: db.prepare(`INSERT INTO theatre_scores (week, region, unit_id, points) VALUES (?, ?, ?, ?)
                       ON CONFLICT(week, region, unit_id) DO UPDATE SET points = points + excluded.points`),
    contrib: db.prepare(`INSERT INTO theatre_contrib (week, unit_id, user_id, points) VALUES (?, ?, ?, ?)
                         ON CONFLICT(week, unit_id, user_id) DO UPDATE SET points = points + excluded.points`),
    standings: db.prepare(`SELECT s.region, s.unit_id, s.points, u.name, u.tag FROM theatre_scores s
                           JOIN units u ON u.id = s.unit_id WHERE s.week = ? ORDER BY s.points DESC`),
    myPoints: db.prepare('SELECT points FROM theatre_contrib WHERE week = ? AND unit_id = ? AND user_id = ?'),
    unitPoints: db.prepare('SELECT COALESCE(SUM(points), 0) AS points FROM theatre_scores WHERE week = ? AND unit_id = ?'),
    topContrib: db.prepare(`SELECT c.user_id, c.points, u.username, u.avatar_v FROM theatre_contrib c JOIN users u ON u.id = c.user_id
                            WHERE c.week = ? AND c.unit_id = ? ORDER BY c.points DESC LIMIT ?`),
    pendingWeeks: db.prepare(`SELECT week FROM (SELECT week FROM theatre_scores UNION SELECT week FROM theatre_fronts)
                              WHERE week < ? AND week NOT IN (SELECT week FROM theatre_weeks) ORDER BY week`),
    settled: db.prepare('INSERT OR IGNORE INTO theatre_weeks (week, settled_at) VALUES (?, ?)'),
    result: db.prepare(`INSERT OR REPLACE INTO theatre_results (week, region, from_unit, to_unit, from_name, to_name, points)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`),
    results: db.prepare('SELECT * FROM theatre_results WHERE week = (SELECT MAX(week) FROM theatre_results)'),
    paid: db.prepare('INSERT OR IGNORE INTO theatre_income (day, region, unit_id, amount) VALUES (?, ?, ?, ?)'),
    members: db.prepare('SELECT COUNT(*) AS n FROM users WHERE unit_id = ? AND banned_at IS NULL'),
    // Admin tools.
    release: db.prepare('DELETE FROM theatre_regions WHERE region = ?'),
    history: db.prepare('SELECT * FROM theatre_results WHERE week >= ? ORDER BY week DESC, region'),
    frontsFull: db.prepare(`SELECT f.unit_id, f.region, f.set_at, u.name, u.tag FROM theatre_fronts f JOIN units u ON u.id = f.unit_id
                            WHERE f.week = ? ORDER BY f.region, u.name`),
    wipeScores: db.prepare('DELETE FROM theatre_scores WHERE week = ? AND unit_id = ?'),
    wipeContrib: db.prepare('DELETE FROM theatre_contrib WHERE week = ? AND unit_id = ?'),
  };

  const tell = (unitId, message, link = '/theatre') => {
    for (const id of unitRepo.memberIds(unitId)) players.notify(id, 'unit', message, link);
  };
  const holderMap = () => new Map(stmts.holders.all().map((h) => [h.region, h]));
  const incomeOf = (region) => Math.round(region.income * tuning.get('theatreIncomeMult'));

  /** Hands regions over for a finished week. */
  function settleWeek(week, now) {
    if (!stmts.settled.run(week, now).changes) return;
    const holders = holderMap();
    const scores = stmts.standings.all(week);
    for (const region of theatre.REGIONS) {
      const here = scores.filter((s) => s.region === region.id);
      const holder = holders.get(region.id) || null;
      const holderId = holder ? holder.unit_id : null;
      const winnerId = theatre.decide(here, holderId);
      const top = here.find((s) => s.unit_id === winnerId);
      if (winnerId === holderId) {
        if (holder && here.length) {
          stmts.result.run(week, region.id, holderId, holderId, holder.name, holder.name, top ? top.points : 0);
          unitRepo.log(holderId, 'theatre', `Held ${region.name} for another week.`, now);
        }
        continue;
      }
      stmts.hold.run(region.id, winnerId, now);
      stmts.result.run(week, region.id, holderId, winnerId, holder ? holder.name : null, top.name, top.points);
      unitRepo.log(winnerId, 'theatre', `Took ${region.name}${holder ? ` from [${holder.tag}] ${holder.name}` : ''} with ${top.points.toLocaleString('en-US')} points.`, now);
      tell(winnerId, `[${top.tag}] took ${region.name} on the theatre of war! It pays ${money(incomeOf(region))} a day into the treasury${region.xp ? ` and gives every member +${Math.round(region.xp * 100)}% mission XP` : ''}.`);
      if (holder) {
        unitRepo.log(holderId, 'theatre', `Lost ${region.name} to [${top.tag}] ${top.name}.`, now);
        tell(holderId, `[${holder.tag}] lost ${region.name} to [${top.tag}] ${top.name}. Set it as your front to win it back.`);
      }
    }
  }

  return {
    /** Scores a member's play on their unit's front this week. */
    track(userId, metric, amount = 1, now = Date.now()) {
      const per = theatre.POINTS[metric];
      if (!per || amount <= 0) return;
      const user = players.findById(userId);
      if (!user || !user.unit_id || user.banned_at) return;
      const week = theatre.weekKey(now);
      const front = stmts.front.get(week, user.unit_id);
      if (!front) return;
      stmts.score.run(week, front.region, user.unit_id, per * amount);
      stmts.contrib.run(week, user.unit_id, userId, per * amount);
    },

    /** Opens (or moves) this week's front (Lieutenant+). Returns { region } or { error }. */
    setFront({ unit, role, me, regionId, now = Date.now() }) {
      if (!units.can.front(role)) return { error: 'Only Lieutenants and the Commander can choose the front.' };
      const week = theatre.weekKey(now);
      const current = stmts.front.get(week, unit.id);
      const blocker = theatre.frontBlocker({
        members: stmts.members.get(unit.id).n,
        current: current ? current.region : null,
        setAt: current ? current.set_at : 0,
      }, String(regionId || ''), now);
      if (blocker) return { error: `${blocker}.` };
      const region = theatre.REGIONS_BY_ID.get(String(regionId));
      stmts.setFront.run(week, unit.id, region.id, me.id, now);
      const verb = current ? 'moved the front to' : 'opened a front in';
      unitRepo.log(unit.id, 'theatre', `${me.username} ${verb} ${region.name}.`, now);
      for (const id of unitRepo.memberIds(unit.id)) {
        if (id !== me.id) players.notify(id, 'unit', `${units.roleLabel(role)} ${me.username} ${verb} ${region.name}. Missions, training, PvP wins, deployments and raid strikes now score there this week.`, '/theatre');
      }
      return { region, moved: Boolean(current) };
    },

    /** Mission XP bonus for a unit from the regions it holds. */
    xpBonus: (unitId) => (unitId ? theatre.xpBonus(stmts.heldBy.all(unitId).map((r) => r.region)) : 0),

    /** Everything the map page shows, from `player`'s point of view. */
    view(player, now = Date.now()) {
      const week = theatre.weekKey(now);
      const holders = holderMap();
      const standings = stmts.standings.all(week);
      const fronts = new Map(stmts.fronts.all(week).map((f) => [f.region, f.n]));
      const unitId = player.unit_id || null;
      const myFront = unitId ? stmts.front.get(week, unitId) : null;
      const regions = theatre.REGIONS.map((r) => {
        const holder = holders.get(r.id) || null;
        const here = standings.filter((s) => s.region === r.id).map((s) => {
          const isHolder = holder && s.unit_id === holder.unit_id;
          return { unitId: s.unit_id, name: s.name, tag: s.tag, points: theatre.effectivePoints(s.points, isHolder), isHolder, mine: s.unit_id === unitId };
        }).sort((a, b) => b.points - a.points);
        return {
          ...r,
          income: incomeOf(r),
          holder: holder ? { unitId: holder.unit_id, name: holder.name, tag: holder.tag, since: holder.held_since } : null,
          color: holder ? (holder.unit_id === unitId ? 'var(--accent)' : theatre.colorFor(holder.unit_id)) : null,
          mine: Boolean(holder && holder.unit_id === unitId),
          front: Boolean(myFront && myFront.region === r.id),
          contenders: fronts.get(r.id) || 0,
          standings: here.slice(0, 3),
          myRank: here.findIndex((s) => s.mine) + 1,
        };
      });
      const held = regions.filter((r) => r.mine);
      const role = unitId ? player.unit_role : null;
      const unit = unitId ? unitRepo.findById(unitId) : null;
      return {
        week,
        endsAt: Date.parse(`${week}T00:00:00Z`) + theatre.WEEK_MS,
        regions,
        legend: [...new Map(regions.filter((r) => r.holder).map((r) => [r.holder.unitId, { ...r.holder, color: r.color, mine: r.mine, count: regions.filter((x) => x.holder && x.holder.unitId === r.holder.unitId).length }])).values()]
          .sort((a, b) => b.count - a.count),
        mine: unit ? {
          unit,
          front: myFront ? { ...theatre.REGIONS_BY_ID.get(myFront.region), setAt: myFront.set_at } : null,
          canSet: units.can.front(role),
          blockerFor: (regionId) => theatre.frontBlocker({ members: stmts.members.get(unit.id).n, current: myFront ? myFront.region : null, setAt: myFront ? myFront.set_at : 0 }, regionId, now),
          points: stmts.unitPoints.get(week, unit.id).points,
          myPoints: (stmts.myPoints.get(week, unit.id, player.id) || { points: 0 }).points,
          top: stmts.topContrib.all(week, unit.id, 5),
          held,
          income: held.reduce((n, r) => n + r.income, 0),
          xpPct: Math.round(theatre.xpBonus(held.map((r) => r.id)) * 100),
        } : null,
        lastWeek: stmts.results.all().map((r) => ({ ...r, region: theatre.REGIONS_BY_ID.get(r.region) })).filter((r) => r.region),
      };
    },

    /** A short summary for the unit page. */
    summary(unitId, now = Date.now()) {
      const week = theatre.weekKey(now);
      const front = stmts.front.get(week, unitId);
      const held = stmts.heldBy.all(unitId).map((r) => theatre.REGIONS_BY_ID.get(r.region)).filter(Boolean);
      return {
        front: front ? theatre.REGIONS_BY_ID.get(front.region) : null,
        points: stmts.unitPoints.get(week, unitId).points,
        held,
        income: held.reduce((n, r) => n + incomeOf(r), 0),
        xpPct: Math.round(theatre.xpBonus(held.map((r) => r.id)) * 100),
      };
    },

    /** Everything Admin › Raids & map shows about the theatre. */
    adminView(now = Date.now()) {
      const week = theatre.weekKey(now);
      const holders = holderMap();
      const standings = stmts.standings.all(week);
      const fronts = stmts.frontsFull.all(week);
      return {
        week,
        endsAt: Date.parse(`${week}T00:00:00Z`) + theatre.WEEK_MS,
        regions: theatre.REGIONS.map((r) => {
          const holder = holders.get(r.id) || null;
          return {
            ...r,
            income: incomeOf(r),
            holder,
            fronts: fronts.filter((f) => f.region === r.id),
            standings: standings.filter((s) => s.region === r.id)
              .map((s) => ({ ...s, effective: theatre.effectivePoints(s.points, Boolean(holder && holder.unit_id === s.unit_id)) }))
              .sort((a, b) => b.effective - a.effective).slice(0, 5),
          };
        }),
        // Units with points this week, for wiping a cheating unit's score.
        scorers: [...new Map(standings.map((s) => [s.unit_id, { unitId: s.unit_id, name: s.name, tag: s.tag, points: standings.filter((x) => x.unit_id === s.unit_id).reduce((n, x) => n + x.points, 0) }])).values()],
        history: stmts.history.all(theatre.weekKey(now - 8 * theatre.WEEK_MS))
          .map((h) => ({ ...h, region: theatre.REGIONS_BY_ID.get(h.region) })).filter((h) => h.region),
      };
    },

    /**
     * Admin: hands a region to `unit` (or frees it when null). The units involved
     * are told. Returns { region, from } or { error }.
     */
    setHolder(regionId, unit, now = Date.now()) {
      const region = theatre.REGIONS_BY_ID.get(String(regionId || ''));
      if (!region) return { error: 'That region doesn’t exist.' };
      const from = holderMap().get(region.id) || null;
      if ((from ? from.unit_id : null) === (unit ? unit.id : null)) return { error: unit ? `[${unit.tag}] already holds ${region.name}.` : `${region.name} is already unheld.` };
      if (unit) stmts.hold.run(region.id, unit.id, now);
      else stmts.release.run(region.id);
      if (from) {
        unitRepo.log(from.unit_id, 'theatre', `HQ took ${region.name} from the unit.`, now);
        tell(from.unit_id, `HQ has taken ${region.name} from [${from.tag}].`);
      }
      if (unit) {
        unitRepo.log(unit.id, 'theatre', `HQ handed ${region.name} to the unit.`, now);
        tell(unit.id, `HQ has handed ${region.name} to [${unit.tag}]. It pays ${money(incomeOf(region))} a day into the treasury.`);
      }
      return { region, from };
    },

    /** Admin: wipes a unit's theatre points for the current week (its front stays). Returns the points removed. */
    wipePoints(unitId, now = Date.now()) {
      const week = theatre.weekKey(now);
      const points = stmts.unitPoints.get(week, unitId).points;
      stmts.wipeScores.run(week, unitId);
      stmts.wipeContrib.run(week, unitId);
      if (points) unitRepo.log(unitId, 'theatre', `HQ removed the unit’s ${points.toLocaleString('en-US')} theatre points for this week.`, now);
      return points;
    },

    /** Settles weeks that have ended. */
    settleDue(now = Date.now()) {
      for (const { week } of stmts.pendingWeeks.all(theatre.weekKey(now))) players.transaction(() => settleWeek(week, now));
    },

    /** Pays each holder its daily income, once per region per UTC day. */
    payIncome(now = Date.now()) {
      const day = dayKey(now);
      for (const h of stmts.holders.all()) {
        const region = theatre.REGIONS_BY_ID.get(h.region);
        const amount = region ? incomeOf(region) : 0;
        if (!amount) continue;
        players.transaction(() => {
          if (!stmts.paid.run(day, h.region, h.unit_id, amount).changes) return;
          unitRepo.addTreasury(h.unit_id, amount);
          unitRepo.log(h.unit_id, 'theatre', `${region.name} paid ${money(amount)} into the treasury.`, now);
        });
      }
    },

    schedule() {
      const tick = () => {
        try {
          this.settleDue();
          this.payIncome();
        } catch (err) { console.error('[theatre] tick failed', err); }
      };
      setTimeout(tick, 60 * 1000).unref(); // soon after start-up (settles a week that ended while the game was down)
      setInterval(tick, 10 * 60 * 1000).unref();
    },
  };
}

module.exports = { createTheatreService };
