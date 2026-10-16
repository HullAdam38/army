'use strict';

/**
 * Balance simulation: plays three kinds of player for 30 days with the game's
 * own rules (missions, XP curve, gear, deployments, daily orders, supply drops)
 * and prints how fast they level and where their money and XP come from.
 * PvP, operations and the bank aren't simulated. Run: npm run balance
 */
const path = '../src/';
const game = require(path + 'game');
const deployments = require(path + 'deployments');
const daily = require(path + 'daily');
const perks = require(path + 'perks');
const { ITEMS } = require(path + 'items');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
let seed = 12345;
const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function newPlayer(t0) {
  return { id: 1, level: 1, xp: 0, cash: 100, energy: 50, max_energy: 50, health: 100, max_health: 100,
    energy_updated_at: t0, health_updated_at: t0, missions_completed: 0, missions_failed: 0, stat_str: 0, stat_agi: 0, stat_end: 0,
    streak_day: null, streak_count: 0, streak_best: 0 };
}

function run(profile, days = 30) {
  seed = 12345;
  const t0 = Date.UTC(2026, 9, 1, 7, 0);
  let p = newPlayer(t0);
  const gear = {}; // slot -> item
  const income = { missions: 0, deployments: 0, daily: 0 };
  const xpFrom = { missions: 0, deployments: 0, daily: 0 };
  let gearSpend = 0;
  const levelAt = {};
  let energySpent = 0, missionCount = 0;

  const buyGear = () => {
    for (const slot of ['weapon', 'body', 'helmet', 'kit']) {
      const best = ITEMS.filter((i) => i.slot === slot && i.minLevel <= p.level && (!gear[slot] || i.price > gear[slot].price))
        .sort((a, b) => b.price - a.price)[0];
      if (best && best.price <= p.cash * 0.6) { p.cash -= best.price; gearSpend += best.price; gear[slot] = best; }
    }
  };
  const stats = () => game.statsFor(p.level, Object.values(gear).map((g) => g.id), p);

  const session = (now) => {
    p = game.applyRegen(p, now);
    for (;;) {
      const options = game.MISSIONS.filter((m) => m.minLevel <= p.level && m.energy <= p.energy);
      if (!options.length || p.health < game.MIN_DEPLOY_HEALTH + 10) break;
      const st = stats();
      const best = options.map((m) => ({ m, ev: (game.successChance(m, p, st) * (m.cash[0] + m.cash[1]) / 2) / m.energy }))
        .sort((a, b) => b.ev - a.ev)[0].m;
      const pk = perks.perksFor(p.level);
      const before = { cash: p.cash, xp: p.xp, level: p.level };
      const out = game.resolveMission(best, p, { now, rng, stats: st, xpBonus: pk.missionXp, cashBonus: pk.missionCash });
      if (out.error) break;
      p = out.player;
      income.missions += out.result.cash; xpFrom.missions += out.result.xp;
      energySpent += best.energy; missionCount += 1;
    }
    buyGear();
  };
  const deploy = (kindId, now) => {
    let kind = deployments.KINDS_BY_ID.get(kindId);
    if (p.level < kind.minLevel) kind = deployments.KINDS_BY_ID.get('recon');
    const pk = perks.perksFor(p.level);
    const r = deployments.resolve(kind, p, { cashMult: 1 + pk.missionCash, xpMult: 1 + pk.missionXp, rng });
    p.cash += r.cash; income.deployments += r.cash; xpFrom.deployments += r.xp;
    game.grantXp(p, r.xp);
    if (r.injury) p.health = Math.max(1, p.health - r.injury);
    return kind.hours;
  };
  const dailies = (now, orders) => {
    const day = daily.dayKey(now);
    const drop = daily.supplyDrop(p, day);
    if (!drop.error) { p.cash += drop.cash; income.daily += drop.cash; p.streak_day = day; p.streak_count = drop.streak; p.streak_best = drop.best; if (drop.refillEnergy) p.energy = p.max_energy; }
    const r = daily.orderReward(p.level);
    const n = orders === 3 ? 4 : orders; // all three plus the commendation
    p.cash += r.cash * n; income.daily += r.cash * n; xpFrom.daily += r.xp * n; game.grantXp(p, r.xp * n);
  };

  for (let d = 0; d < days; d += 1) {
    const dayStart = t0 + d * DAY; // 07:00
    dailies(dayStart, profile.orders);
    for (const h of profile.sessions) session(dayStart + h * HOUR);
    // Deployments while away (their hours count toward the 16h daily cap).
    for (const [kind, at] of profile.deploys) {
      p = game.applyRegen(p, dayStart + at * HOUR);
      if (p.health >= p.max_health * 0.25) deploy(kind, dayStart + at * HOUR);
    }
    levelAt[d + 1] = p.level;
  }
  return { profile: profile.name, levelAt, income, xpFrom, gearSpend, cash: p.cash, gear: Object.values(gear).map((g) => g.name), missionCount, energySpent };
}

const profiles = [
  // Plays every ~2 hours while awake; deploys overnight (8h).
  { name: 'Grinder', sessions: [0, 2, 4, 6, 8, 10, 12, 14, 15.5], orders: 3, deploys: [['long-range', 16]] },
  // Morning, lunch, evening; deploys during work (8h) and overnight (8h).
  { name: 'Regular', sessions: [0, 5.5, 12], orders: 3, deploys: [['long-range', 1], ['long-range', 16]] },
  // Once a day; deploys the rest (16h).
  { name: 'Casual', sessions: [12], orders: 2, deploys: [['long-range', 0], ['long-range', 16]] },
];

const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
for (const pr of profiles) {
  const r = run(pr);
  const total = r.income.missions + r.income.deployments + r.income.daily;
  const xpTotal = r.xpFrom.missions + r.xpFrom.deployments + r.xpFrom.daily;
  console.log(`\n== ${r.profile}`);
  console.log('Level by day:', [1, 2, 3, 7, 14, 21, 30].map((d) => `d${d}:${r.levelAt[d]}`).join('  '));
  console.log('Income 30d:', fmt(total), '| missions', Math.round(100 * r.income.missions / total) + '%', '| deployments', Math.round(100 * r.income.deployments / total) + '%', '| daily', Math.round(100 * r.income.daily / total) + '%');
  console.log('XP share: missions', Math.round(100 * r.xpFrom.missions / xpTotal) + '%', '| deployments', Math.round(100 * r.xpFrom.deployments / xpTotal) + '%', '| daily', Math.round(100 * r.xpFrom.daily / xpTotal) + '%');
  console.log('Gear spend:', fmt(r.gearSpend), '| cash left:', fmt(r.cash), '| missions run:', r.missionCount);
  console.log('Gear:', r.gear.join(', '));
}

// Pay per hour of play time at a few levels: one full energy bar of missions vs an hour deployed.
console.log('\n== Pay rates by level (no gear, no perks)');
for (const level of [1, 5, 10, 15, 20, 25, 30]) {
  const p = { ...newPlayer(0), level, max_energy: 50 + 5 * (level - 1), max_health: 100 + 10 * (level - 1), health: 100 + 10 * (level - 1) };
  const ms = game.MISSIONS.filter((m) => m.minLevel <= level).map((m) => ({ m, ev: game.successChance(m, p) * (m.cash[0] + m.cash[1]) / 2 / m.energy }))
    .sort((a, b) => b.ev - a.ev)[0];
  const energyPerHour = 30; // 1 per 2 min
  const missionPerHour = ms.ev * energyPerHour;
  const dep = deployments.rewardFor(deployments.KINDS_BY_ID.get('long-range'), level).cash / 8;
  const order = daily.orderReward(level).cash * 4;
  console.log(`L${level}: missions ≈ ${fmt(missionPerHour)}/h of energy (${ms.m.name}) | long-range deployment ${fmt(dep)}/h (${Math.round(100 * dep / missionPerHour)}% of missions) | all daily orders ${fmt(order)}/day`);
}
