'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const base = require('../src/base');
const game = require('../src/game');
const bank = require('../src/bank');
const training = require('../src/training');
const scouting = require('../src/scouting');
const admin = require('../src/admin');
const { createBaseService } = require('../src/base-service');
const { createPlayerRepo } = require('../src/players');
const { createDailyService } = require('../src/daily-service');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('facility costs, requirements and perks', () => {
  const p = { level: 30, cash: 1e9 };
  assert.deepEqual(base.nextLevel(p, 'barracks'), { level: 1, cost: 4000, hours: 1, requiredLevel: 8 });
  assert.deepEqual(base.nextLevel({ ...p, base_barracks: 4 }, 'barracks'), { level: 5, cost: 120000, hours: 24, requiredLevel: 28 });
  assert.equal(base.nextLevel({ ...p, base_vault: 3 }, 'vault'), null); // the vault stops at 3
  assert.equal(base.nextLevel(p, 'nope'), null);

  const now = Date.now();
  assert.match(base.buildBlocker({ level: 7, cash: 1e9 }, 'barracks', now), /unlocks at level 8/);
  assert.match(base.buildBlocker({ level: 10, cash: 1e9, base_barracks: 1 }, 'barracks', now), /needs you to be level 12/);
  assert.match(base.buildBlocker({ level: 10, cash: 100 }, 'barracks', now), /Costs \$4,000/);
  assert.match(base.buildBlocker({ level: 10, cash: 1e9, base_build: 'medbay', base_build_until: now + 1000 }, 'barracks', now), /busy/);
  assert.match(base.buildBlocker({ level: 30, cash: 1e9, base_vault: 3 }, 'vault', now), /Fully upgraded/);
  assert.equal(base.buildBlocker({ level: 10, cash: 1e9 }, 'barracks', now), null);

  assert.deepEqual(base.effectsOf({}), { maxEnergyBonus: 0, healthRegenFactor: 1, depositFeeRate: 0.02, scoutDiscount: 0, trainingDiscount: 0, ordersBonus: 0 });
  const maxed = Object.fromEntries(base.FACILITIES.map((f) => [`base_${f.id}`, f.maxLevel]));
  const fx = base.effectsOf(maxed);
  assert.equal(fx.maxEnergyBonus, 25);
  assert.ok(Math.abs(fx.healthRegenFactor - 0.5) < 1e-9);
  assert.ok(Math.abs(fx.depositFeeRate - 0.005) < 1e-9);
  assert.equal(base.baseRating(maxed), base.maxRating);
  assert.equal(base.maxRating, 28);
});

test('base perks reach every system they touch', () => {
  const now = Date.now();
  const p = { id: 1, level: 20, cash: 10000, bank_balance: 0, base_vault: 2, base_range: 4, base_intel: 3, base_medbay: 5, stat_str: 0, stat_agi: 0, stat_end: 0 };
  assert.equal(bank.deposit(p, '1000').fee, 10); // 1% instead of 2%
  assert.equal(bank.deposit({ ...p, base_vault: 0 }, '1000').fee, 20);
  assert.equal(training.train({ ...p, energy: 50, max_energy: 50, hospital_until: null }, 'strength').cash, 20); // $25 −20%
  assert.equal(scouting.scoutCost(p, { level: 10 }), Math.round(300 * 0.7));
  // Med Bay 5: health back twice as fast.
  const hurt = { ...p, health: 100, max_health: 300, health_updated_at: now - 10 * 60 * 1000, energy: 50, max_energy: 50, energy_updated_at: now };
  assert.equal(game.applyRegen(hurt, now).health, 120);
  assert.equal(game.applyRegen({ ...hurt, base_medbay: 0 }, now).health, 110);
  // Admins setting a level keep the Barracks energy.
  assert.equal(admin.setLevel({ ...p, base_barracks: 3 }, '10', 'test').player.max_energy, 50 + 45 + 15);
});

test('building: start, one at a time, cancel with refund, finish on time', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const svc = createBaseService(db, players);
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, cash, max_energy, energy)
                                VALUES ('Builder', 'b@x', 'x', ?, ?, ?, 12, 50000, 105, 105)`).run(now, now, now).lastInsertRowid);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) VALUES (?, 50000, 'test', 0)").run(id);

  let out = players.transaction(() => svc.start(id, 'barracks', now));
  assert.equal(out.next.cost, 4000);
  assert.equal(players.findById(id).cash, 46000);
  assert.match(players.transaction(() => svc.start(id, 'medbay', now)).error, /busy/);

  // Cancel refunds half.
  assert.equal(players.transaction(() => svc.cancel(id, now)).refund, 2000);
  assert.equal(players.findById(id).cash, 48000);
  assert.equal(players.findById(id).base_build, null);

  // Build again and let it finish.
  out = players.transaction(() => svc.start(id, 'barracks', now));
  assert.deepEqual(svc.completeDue(now + 30 * 60 * 1000), []); // not yet
  const done = svc.completeDue(now + base.HOUR + 1);
  assert.equal(done.length, 1);
  const u = players.findById(id);
  assert.deepEqual([u.base_barracks, u.max_energy, u.base_build], [1, 110, null]);
  assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'base'").get().message, /Barracks level 1/);
  assert.deepEqual(svc.completeDue(now + 2 * base.HOUR), []); // only once

  const ledger = db.prepare("SELECT reason, SUM(delta_cash) AS n FROM ledger WHERE user_id = ? AND reason LIKE 'base%' GROUP BY reason ORDER BY reason").all(id);
  assert.deepEqual(ledger.map((r) => [r.reason, r.n]), [['base', -8000], ['base-refund', 2000]]);

  // The Comms Tower lifts daily order rewards.
  db.prepare('UPDATE users SET base_comms = 3 WHERE id = ?').run(id);
  const daily = createDailyService(db, players);
  const order = daily.ordersFor(players.findById(id), now)[0];
  daily.progress(id, order.type, order.target, { param: order.param, now });
  const claimed = players.transaction(() => daily.claimOrder(players.findById(id), order.slot, now));
  assert.equal(claimed.order.reward_cash, Math.round(order.reward_cash * 1.3));
});

test('forward base page and building through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base_ = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base_ + p, {
      method, redirect: 'manual',
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p) => request(p, { method: 'POST', form: { _csrf: await csrf() } });
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username: 'Engineer', email: 'e@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    assert.match((await request('/hq')).text, /Forward base unlocks at level 8/);
    assert.match((await request('/base')).text, /unlocks at level 8/);
    await post('/base/build/barracks');
    assert.equal(db.prepare('SELECT base_build FROM users').get().base_build, null);

    db.prepare('UPDATE users SET level = 10, cash = 20000').run();
    await post('/base/build/medbay');
    let page = (await request('/base')).text;
    assert.match(page, /Building <strong>Med Bay level 1<\/strong>/);
    assert.match((await request('/hq')).text, /Base: building Med Bay/);
    await post('/base/build/vault');
    assert.equal(db.prepare('SELECT base_build FROM users').get().base_build, 'medbay'); // one at a time

    // Time passes: viewing the base finishes the build.
    db.prepare('UPDATE users SET base_build_until = ?').run(Date.now() - 1);
    page = (await request('/base')).text;
    assert.match(page, /Lv 1\/5[\s\S]*health regenerates 10% faster/);
    assert.equal(db.prepare('SELECT base_medbay FROM users').get().base_medbay, 1);
    assert.equal((await post('/base/build/nonsense')).location, '/base');
  } finally {
    server.close();
  }
});
