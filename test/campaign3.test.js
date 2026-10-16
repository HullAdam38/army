'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');
const combat = require('../src/combat');
const { ITEMS } = require('../src/items');
const perks = require('../src/perks');
const ops = require('../src/operations');
const daily = require('../src/daily');
const titles = require('../src/titles');
const { unlocksAt } = require('../src/notify');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('campaign 3: missions, ranks and perks continue the curve to level 50', () => {
  const c3 = game.MISSIONS.filter((m) => m.campaign === 3);
  assert.equal(c3.length, 6);
  assert.ok(c3.every((m) => m.minLevel >= 35 && m.minLevel <= 50));
  assert.equal(game.CAMPAIGNS[2].id, 3);
  // Expected pay per energy keeps rising across every mission in the game.
  const ev = (m) => (m.chance * (m.cash[0] + m.cash[1])) / 2 / m.energy;
  const sorted = [...game.MISSIONS].sort((a, b) => a.minLevel - b.minLevel);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(ev(sorted[i]) > ev(sorted[i - 1]), `${sorted[i].id} pays more per energy`);
  // Even the biggest mission fits a level-50 energy bar.
  const maxEnergy50 = 50 + 5 * 49;
  assert.ok(Math.max(...c3.map((m) => m.energy)) < maxEnergy50 / 3);

  // A new rank every 2 levels to 49, the top rank after that.
  assert.equal(game.rankFor(49).name, 'Commander-in-Chief');
  assert.equal(game.rankFor(49).grade, 'O-17');
  assert.equal(new Set(game.RANKS.map((r) => r.name)).size, game.RANKS.length);

  // Perks line up with ranks and keep coming.
  assert.equal(perks.nextPerk(35).rank, 'Field Marshal');
  const p50 = perks.perksFor(50);
  assert.ok(Math.abs(p50.missionCash - 0.15) < 1e-9 && Math.abs(p50.missionXp - 0.15) < 1e-9);
  assert.equal(p50.supplyDrop, 1);
  assert.equal(daily.supplyDrop({ level: 49, streak_count: 0, streak_day: null, streak_best: 0 }, '2026-05-01').cash, Math.round((25 + 15 * 49) * 2));

  // Unlock messages and the level-50 title.
  assert.ok(unlocksAt(35).some((u) => /Campaign 3 is open/.test(u.message)));
  assert.ok(unlocksAt(36).some((u) => /Seize the Satellite Uplink/.test(u.message)));
  assert.ok(unlocksAt(40).some((u) => /Operation Black Tide/.test(u.message)));
  assert.ok(unlocksAt(38).some((u) => /EM Railgun Prototype/.test(u.message)));
  assert.equal(titles.TITLES_BY_ID.get('legend').test({ level: 50 }), true);
});

test('campaign 3 gear and operations', () => {
  const bestAt = (level) => {
    const by = {};
    for (const i of ITEMS) if (i.minLevel <= level && (!by[i.slot] || by[i.slot].price < i.price)) by[i.slot] = i;
    return Object.values(by).map((i) => i.id);
  };
  let last = combat.combatRating(game.statsFor(35, bestAt(35)));
  for (const level of [38, 41, 45, 48, 50]) {
    const stats = game.statsFor(level, bestAt(level));
    const rating = combat.combatRating(stats);
    assert.ok(rating > last, `best gear at level ${level} beats the level before`);
    last = rating;
    assert.ok(combat.mitigation(stats.armor) < 0.7, `armour reduction stays under the cap at level ${level}`);
  }
  assert.equal(ITEMS.filter((i) => i.minLevel > 35 && i.minLevel <= 50).length, 8);

  const tide = ops.OPERATIONS_BY_ID.get('black-tide');
  const crown = ops.OPERATIONS_BY_ID.get('iron-crown');
  assert.deepEqual([tide.minLevel, crown.minLevel], [40, 47]);
  for (const op of [tide, crown]) {
    assert.equal(op.stages.length, 3);
    assert.ok(op.stages[0].energy < op.stages[2].energy);
    assert.ok(op.bonus.cash > ops.OPERATIONS_BY_ID.get('last-light').bonus.cash);
  }
});

test('the missions page shows campaign 3 and its operations', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
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
  const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username: 'Marshal', email: 'm@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    let page = (await request('/missions')).text;
    // Far-off campaigns are a one-line teaser for a new player.
    assert.match(page, /Campaign 3: Global war<\/h2>[\s\S]*First mission at level 36/);
    assert.doesNotMatch(page, /Zero Hour/);
    db.prepare('UPDATE users SET level = 41, max_energy = 300, energy = 300, max_health = 500, health = 500').run();
    page = (await request('/missions')).text;
    assert.match(page, /Zero Hour/);
    assert.match(page, /Operation Black Tide/);
    assert.match((await request('/hq')).text, /Field Marshal/);
    // Run the first stage of Black Tide.
    const r = await request('/operations/black-tide', { method: 'POST', form: { _csrf: await csrf('/missions') } });
    assert.ok(r.res.status < 400);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'operation'").get().n + db.prepare('SELECT missions_failed AS n FROM users').get().n >= 1);
  } finally {
    server.close();
  }
});
