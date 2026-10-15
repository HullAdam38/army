'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');
const combat = require('../src/combat');
const { ITEMS } = require('../src/items');
const perks = require('../src/perks');
const ops = require('../src/operations');
const supplies = require('../src/supplies');
const daily = require('../src/daily');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('campaign 2 missions get steadily better per energy and unlock in order', () => {
  const ratio = (m) => (m.xp[0] + m.xp[1]) / 2 / m.energy;
  const sorted = [...game.MISSIONS].sort((a, b) => a.minLevel - b.minLevel);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(ratio(sorted[i]) > ratio(sorted[i - 1]), `${sorted[i].id} should pay more XP per energy than ${sorted[i - 1].id}`);
  }
  const c2 = game.MISSIONS.filter((m) => m.campaign === 2);
  assert.equal(c2.length, 6);
  assert.ok(c2.every((m) => m.minLevel >= 15 && m.minLevel <= 34));
  assert.ok(game.MISSIONS.filter((m) => m.campaign === 1).every((m) => m.minLevel < 15));
  assert.equal(new Set(game.MISSIONS.map((m) => m.id)).size, game.MISSIONS.length);
});

test('the new gear tier scales up without hitting the armour cap', () => {
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  const bestAt = (level) => {
    const by = {};
    for (const i of ITEMS) if (i.minLevel <= level && (!by[i.slot] || by[i.slot].price < i.price)) by[i.slot] = i;
    return Object.values(by).map((i) => i.id);
  };
  let last = 0;
  for (const level of [14, 18, 24, 30, 35]) {
    const stats = game.statsFor(level, bestAt(level));
    const rating = combat.combatRating(stats);
    assert.ok(rating > last, `best gear at level ${level} beats the level before`);
    last = rating;
    assert.ok(combat.mitigation(stats.armor) < 0.7, `armour reduction stays under the cap at level ${level}`);
  }
  // Prices rise with level within each slot.
  for (const slot of ['weapon', 'body', 'helmet', 'kit']) {
    const list = ITEMS.filter((i) => i.slot === slot).sort((a, b) => a.minLevel - b.minLevel);
    for (let i = 1; i < list.length; i += 1) assert.ok(list[i].price > list[i - 1].price, `${list[i].id} costs more`);
  }
});

test('rank perks add up and feed missions, the hospital and supply drops', () => {
  assert.deepEqual(perks.perksFor(16), { missionCash: 0, missionXp: 0, hospitalDiscount: 0, supplyDrop: 0 });
  const p30 = perks.perksFor(30);
  assert.ok(Math.abs(p30.missionCash - 0.1) < 1e-9 && Math.abs(p30.missionXp - 0.1) < 1e-9);
  assert.equal(p30.hospitalDiscount, 0.25);
  assert.equal(perks.nextPerk(30).rank, 'General');
  assert.equal(perks.perksAt(17)[0].rank, 'Second Lieutenant');
  // Perk ranks line up with the real rank ladder.
  for (const p of perks.PERKS) assert.equal(game.rankFor(p.level).name, p.rank);

  const hurt = { level: 23, max_health: 300, health: 100 };
  assert.equal(game.hospitalCost(hurt), 300); // 200 HP × $2, minus 25%
  assert.equal(game.hospitalCost({ ...hurt, level: 22 }), 400);

  const general = daily.supplyDrop({ level: 35, streak_count: 0, streak_day: null, streak_best: 0 }, '2026-05-01').cash;
  const colonel = daily.supplyDrop({ level: 34, streak_count: 0, streak_day: null, streak_best: 0 }, '2026-05-01').cash;
  assert.equal(general, Math.round((25 + 15 * 35) * 1.5));
  assert.equal(colonel, 25 + 15 * 34);

  const now = Date.now();
  const p = { id: 1, level: 30, xp: 0, cash: 0, energy: 200, max_energy: 200, health: 300, max_health: 300, energy_updated_at: now, health_updated_at: now, missions_completed: 0, missions_failed: 0, stat_str: 0, stat_agi: 0, stat_end: 0, hospital_until: null };
  const base = game.runMission('citadel-siege', { ...p }, { now, rng: () => 0 }).result;
  const boosted = game.runMission('citadel-siege', { ...p }, { now, rng: () => 0, cashBonus: 0.1, xpBonus: 0.1 }).result;
  assert.equal(boosted.cash, Math.round(base.cash * 1.1));
  assert.equal(boosted.xp, Math.round(base.xp * 1.1));
});

test('operation progress and cooldown', () => {
  const op = ops.OPERATIONS_BY_ID.get('iron-gate');
  assert.equal(op.stages.length, 3);
  assert.deepEqual(op.stages.map((s) => s.id), ['iron-gate:1', 'iron-gate:2', 'iron-gate:3']);
  const now = Date.now();
  assert.deepEqual(ops.progressOf(op, null, now), { stage: 1, cleared: 0, coolingUntil: null, completions: 0 });
  assert.deepEqual(ops.progressOf(op, { stage: 3, completed_at: null, completions: 0 }, now), { stage: 3, cleared: 2, coolingUntil: null, completions: 0 });
  const justDone = ops.progressOf(op, { stage: 1, completed_at: now - 1000, completions: 1 }, now);
  assert.equal(justDone.stage, null);
  assert.equal(justDone.cleared, 3);
  assert.equal(justDone.coolingUntil, now - 1000 + ops.COOLDOWN_MS);
  // After the cooldown, progress made in the new run is kept.
  const later = ops.progressOf(op, { stage: 2, completed_at: now - ops.COOLDOWN_MS - 1, completions: 1 }, now);
  assert.deepEqual([later.stage, later.cleared, later.coolingUntil], [2, 1, null]);
});

test('supplies: limits, effects and the stim', () => {
  const now = Date.now();
  const adrenaline = supplies.SUPPLIES_BY_ID.get('adrenaline');
  const stim = supplies.SUPPLIES_BY_ID.get('stim');
  const p = { level: 15, cash: 10000, energy: 100, max_energy: 120, energy_updated_at: now, adrenaline_at: null, stim_loaded: 0 };
  assert.equal(supplies.buyBlocker(adrenaline, p, now), null);
  assert.match(supplies.buyBlocker(adrenaline, { ...p, level: 14 }, now), /level 15/);
  assert.match(supplies.buyBlocker(adrenaline, { ...p, cash: 100 }, now), /Costs \$2,500/);
  assert.match(supplies.buyBlocker(adrenaline, { ...p, energy: 120 }, now), /already full/);
  assert.match(supplies.buyBlocker(adrenaline, { ...p, adrenaline_at: now - 3600_000 }, now), /19h/);
  const used = supplies.use(adrenaline, p, now).player;
  assert.deepEqual([used.energy, used.cash, used.adrenaline_at], [120, 7500, now]); // capped at max
  assert.match(supplies.buyBlocker(stim, { ...p, stim_loaded: 1 }, now), /already have/);
  assert.equal(supplies.use(stim, p, now).player.stim_loaded, 1);
  const s = combat.buildStats(20);
  assert.ok(Math.abs(supplies.withStim(s).damage - s.damage * 1.15) < 1e-9);
});

test('operations, supplies and stims through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async () => (await request('/hq')).text.match(/name="_csrf" value="([^"]+)"/)[1];
    const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
    return { request, post };
  };
  const enlist = async (name) => {
    const c = client();
    const page = (await c.request('/register')).text;
    const token = page.match(/name="_csrf" value="([^"]+)"/)[1];
    await c.request('/register', { method: 'POST', form: { _csrf: token, username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return c;
  };
  try {
    const vet = await enlist('Veteran');
    const foe = await enlist('Opfor');
    const user = () => db.prepare("SELECT * FROM users WHERE username = 'Veteran'").get();
    const refill = () => db.prepare("UPDATE users SET energy = max_energy, health = max_health, hospital_until = NULL WHERE username = 'Veteran'").run();

    // A level 1 player sees campaign 2 and the operations, locked.
    let page = (await vet.request('/missions')).text;
    assert.match(page, /Campaign 2: Forward operations/);
    assert.match(page, /Operation Iron Gate[\s\S]*Unlocks at level 16/);
    assert.equal((await vet.post('/operations/iron-gate')).location, '/missions#op-iron-gate');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_progress').get().n, 0);

    // At level 40 (high success chance) run Iron Gate to completion.
    db.prepare("UPDATE users SET level = 40, max_energy = 300, max_health = 500 WHERE username = 'Veteran'").run();
    let completed = false;
    for (let i = 0; i < 30 && !completed; i += 1) {
      refill();
      await vet.post('/operations/iron-gate');
      completed = Boolean(db.prepare("SELECT completions FROM operation_progress WHERE op_id = 'iron-gate'").get()?.completions);
    }
    assert.ok(completed, 'the operation completes');
    const bonus = db.prepare("SELECT SUM(delta_cash) AS n FROM ledger WHERE reason = 'operation'").get().n;
    assert.ok(bonus >= Math.round(4000 * 1.1), 'completion bonus paid through the ledger, with rank perks');
    page = (await vet.request('/missions')).text;
    assert.match(page, /id="op-iron-gate" class="card op op--done"/);
    assert.match(page, /Rank perks: <strong>\+5% mission pay/);
    refill();
    const before = user().cash;
    await vet.post('/operations/iron-gate'); // on cooldown
    assert.equal(user().cash, before);
    assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'unlock' AND message LIKE '%Iron Gate complete%'").get().message, /20 hours/);

    // Supplies: adrenaline restores energy once; a stim is used on the next attack.
    db.prepare("UPDATE users SET cash = 20000, energy = 10 WHERE username = 'Veteran'").run();
    await vet.post('/armory/supplies/adrenaline');
    assert.equal(user().energy, 40);
    await vet.post('/armory/supplies/adrenaline');
    assert.equal(user().energy, 40); // cooldown
    await vet.post('/armory/supplies/stim');
    assert.equal(user().stim_loaded, 1);
    assert.match((await vet.request('/armory')).text, /Stim ready/);
    db.prepare("UPDATE users SET level = 40, health = 1 WHERE username = 'Opfor'").run();
    refill();
    const fight = await vet.post('/attack/Opfor');
    assert.match(fight.location, /^\/battles\/\d+$/);
    assert.equal(user().stim_loaded, 0);
    assert.match((await vet.request(fight.location)).text, /used a Combat Stim/);
    const spent = db.prepare("SELECT SUM(delta_cash) AS n FROM ledger WHERE reason = 'supplies'").get().n;
    assert.equal(spent, -5500);
  } finally {
    server.close();
  }
});
