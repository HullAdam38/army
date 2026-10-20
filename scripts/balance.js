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
  return { profile: profile.name, levelAt, income, xpFrom, gearSpend, cash: p.cash, gear: Object.values(gear).map((g) => g.name), gearItems: Object.values(gear), missionCount, missionsFailed: p.missions_failed, energySpent };
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

// ---- Team play: what raids pay a member, against spending the same energy on missions ----
const raids = require(path + 'raids');
const objectives = require(path + 'objectives');
const units = require(path + 'units');
const theatre = require(path + 'theatre');
/** The best mission's expected cash and XP per point of energy at a level (no gear). */
const missionPerEnergy = (level) => {
  const p = { ...newPlayer(0), level, max_energy: 50 + 5 * (level - 1), max_health: 100 + 10 * (level - 1), health: 100 + 10 * (level - 1) };
  return game.MISSIONS.filter((m) => m.minLevel <= level)
    .map((m) => ({ cash: game.successChance(m, p) * (m.cash[0] + m.cash[1]) / 2 / m.energy, xp: game.successChance(m, p) * (m.xp[0] + m.xp[1]) / 2 / m.energy }))
    .sort((a, b) => b.cash - a.cash)[0];
};
console.log(`\n== Raids: a 5-member unit, everyone striking equally (no gear). One raid per ${require(path + 'tuning').get('raidCooldownHours')}h at most`);
const MEMBERS = 5;
for (const level of [5, 10, 20, 35, 50, 75]) {
  const s = [...raids.STRONGHOLDS].reverse().find((x) => x.minLevel <= level);
  const plan = raids.plan(s, { members: MEMBERS, avgLevel: level });
  // A strike averages 1.025 × a typical strike, so each member needs this much energy for their share of the health.
  const energy = (plan.hp / MEMBERS / (raids.typicalStrike(level) * 1.025)) * raids.STRIKE_ENERGY;
  const share = (plan.cash * (1 - raids.TREASURY_SHARE)) / MEMBERS;
  const m = missionPerEnergy(level);
  const xpEach = plan.xp / MEMBERS;
  console.log(`L${level} ${s.name}: ${Math.round(energy)} energy each → ${fmt(share)} + ${Math.round(xpEach)} XP each (cash ${(share / energy / m.cash).toFixed(2)}× missions, XP ${(xpEach / energy / m.xp).toFixed(2)}×); supplies ${fmt(plan.cost)} from the treasury, ${fmt(plan.cash * raids.TREASURY_SHARE)} back`);
}

console.log('\n== Unit treasury income per week (5 members)');
for (const level of [10, 30, 50]) {
  const objectivesWeek = 3 * Math.round((12 * MEMBERS * objectives.hourPay(level)) / 100) * 100;
  const capital = theatre.REGIONS_BY_ID.get('capital').income * 7;
  const rally = units.rallyCost(MEMBERS, level);
  console.log(`L${level}: three objectives ${fmt(objectivesWeek)} · holding the Capital District ${fmt(capital)} · one rally costs ${fmt(rally)} (+${Math.round(units.RALLY.bonus * 100)}% mission pay for an hour each)`);
}

// ---- The casino: how much cash it takes out of the game ----
const slots = require(path + 'slots');
const blackjack = require(path + 'blackjack');
const houseEdge = { 'Slot machine': 1 - slots.returnToPlayer().rtp, Roulette: 1 / 37, 'Blackjack (perfect play)': 1 - blackjack.RTP, 'Blackjack (typical play)': 0.02 };
console.log('\n== Casino: expected cash removed from the game');
const regular = run(profiles[1]);
const monthly = regular.income.missions + regular.income.deployments + regular.income.daily;
for (const [name, edge] of Object.entries(houseEdge)) {
  console.log(`${name}: house edge ${(edge * 100).toFixed(2)}% → keeps ${fmt(edge * 100000)} of every $100,000 bet; a Regular player betting their whole month's income (${fmt(monthly)}) once loses about ${fmt(edge * monthly)}`);
}
console.log('Casino play is optional, so it is a cash sink for those who choose it and never adds money to the game on average.');

// ---- Gear upkeep: repairs as a cash sink, and what selling outgrown gear gives back ----
const gearRules = require(path + 'gear');
const tuningRules = require(path + 'tuning');
console.log('\n== Gear upkeep over 30 days (missions only; PvP and raids wear gear faster)');
for (const pr of profiles) {
  const r = run(pr);
  const income = r.income.missions + r.income.deployments + r.income.daily;
  const mult = tuningRules.get('gearWearMult');
  const fails = r.missionsFailed || Math.round(r.missionCount * 0.15);
  const points = { weapon: (r.missionCount * gearRules.WEAR.mission.weapon) * mult, kit: (r.missionCount * gearRules.WEAR.mission.kit) * mult, body: fails * gearRules.WEAR.missionFailed.body * mult, helmet: fails * gearRules.WEAR.missionFailed.helmet * mult };
  // Priced at the gear they end the month with, so an upper bound.
  const repairs = r.gearItems.reduce((n, item) => n + (item.price * tuningRules.get('gearRepairShare') * (points[item.slot] || 0)) / 100, 0);
  const resale = Math.max(0, r.gearSpend - r.gearItems.reduce((n, i) => n + i.price, 0)) * tuningRules.get('gearSellShare') * 0.75;
  console.log(`${r.profile}: weapon wear ${Math.round(points.weapon)} points (${(points.weapon / 100).toFixed(1)} full repairs) · repairs about ${fmt(repairs)} (${(100 * repairs / income).toFixed(1)}% of income) · selling outgrown gear returns about ${fmt(resale)}`);
}

// ---- Vehicles: what each one is worth to a player who spends all their energy on missions ----
const vehicleRules = require(path + 'vehicles');
console.log('\n== Vehicles at their unlock level (a full day of energy on the best mission, ~720 energy; repairs included)');
for (const v of vehicleRules.VEHICLES) {
  const level = v.minLevel;
  const p = { ...newPlayer(0), level, max_energy: 50 + 5 * (level - 1), max_health: 100 + 10 * (level - 1), health: 100 + 10 * (level - 1) };
  const best = game.MISSIONS.filter((m) => m.minLevel <= level).map((m) => ({ m, ev: game.successChance(m, p) * (m.cash[0] + m.cash[1]) / 2 / m.energy })).sort((a, b) => b.ev - a.ev)[0].m;
  const runs = 720 / best.energy;
  const avg = (best.cash[0] + best.cash[1]) / 2;
  const b = vehicleRules.bonusesOf(v);
  const chance = game.successChance(best, p);
  const gain = runs * avg * ((Math.min(0.97, chance + b.missionChance) - chance) + chance * b.missionCash);
  const dep = b.deployCash * deployments.rewardFor(deployments.KINDS_BY_ID.get(level >= 5 ? 'long-range' : 'recon'), level).cash * (level >= 5 ? 1 : 2); // one overnight patrol a day
  const wear = runs * vehicleRules.WEAR.mission * tuningRules.get('vehicleWearMult');
  const upkeep = (v.price * tuningRules.get('gearRepairShare') * wear) / 100;
  const net = gain + dep - upkeep;
  const what = v.cls === 'armour' ? `raid strikes +${Math.round(b.raidDamage * 100)}% damage (no mission pay)` : `≈ ${fmt(gain + dep)}/day extra, ${fmt(upkeep)}/day repairs`;
  console.log(`${v.name} (L${level}, ${fmt(v.price)}): ${what}${net > 0 && v.cls !== 'armour' ? ` → pays for itself in ${Math.ceil(v.price / net)} days` : ''}`);
}
