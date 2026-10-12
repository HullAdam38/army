'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const daily = require('../src/daily');
const { createDailyService } = require('../src/daily-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const DAY = Date.parse('2026-05-10T12:00:00Z');

function setup(level = 5) {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, energy, max_energy)
                                VALUES ('Alpha', 'a@example.com', 'x', ?, ?, ?, ?, 10, 60)`).run(now, now, now, level).lastInsertRowid);
  return { db, players, svc: createDailyService(db, players), user: () => players.findById(id), id };
}

test('days are UTC and orders are stable per player and day', () => {
  assert.equal(daily.dayKey(Date.parse('2026-05-10T23:59:59Z')), '2026-05-10');
  assert.equal(daily.dayKey(Date.parse('2026-05-11T00:00:00Z')), '2026-05-11');
  assert.equal(daily.previousDay('2026-03-01'), '2026-02-28');
  assert.equal(daily.msUntilReset(Date.parse('2026-05-10T23:00:00Z')), 3_600_000);

  const a = daily.generateOrders(7, 5, '2026-05-10');
  assert.deepEqual(daily.generateOrders(7, 5, '2026-05-10'), a);
  assert.equal(a.length, daily.ORDERS_PER_DAY);
  assert.equal(new Set(a.map((o) => o.type)).size, 3);

  // Low-level players never get PvP or scouting orders.
  for (let d = 1; d <= 28; d += 1) {
    const types = daily.generateOrders(3, 1, `2026-02-${String(d).padStart(2, '0')}`).map((o) => o.type);
    assert.ok(!types.includes('pvp_wins') && !types.includes('scout'), types.join());
  }
});

test('supply drops follow a 7-day cycle and reset after a missed day', () => {
  let p = { level: 2, streak_count: 0, streak_day: null, streak_best: 0 };
  let day = '2026-05-01';
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    const drop = daily.supplyDrop(p, day);
    seen.push([drop.cycleDay, drop.cash, drop.refillEnergy]);
    p = { ...p, streak_count: drop.streak, streak_day: day, streak_best: drop.best };
    day = daily.dayKey(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  }
  assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5, 6, 7, 1]);
  assert.deepEqual(seen.map((s) => s[1]), [55, 55, 83, 83, 110, 110, 165, 55]);
  assert.deepEqual(seen.map((s) => s[2]), [false, false, false, false, false, false, true, false]);
  assert.equal(p.streak_count, 8);

  assert.match(daily.supplyDrop(p, p.streak_day).error, /already claimed/);
  const late = daily.supplyDrop(p, daily.dayKey(Date.parse(`${p.streak_day}T00:00:00Z`) + 2 * 86_400_000));
  assert.deepEqual([late.streak, late.broken, late.best], [1, true, 8]);

  const view = daily.streakView(p, daily.dayKey(Date.parse(`${p.streak_day}T00:00:00Z`) + 2 * 86_400_000));
  assert.equal(view.current, 0); // a lapsed streak shows as zero
  assert.equal(view.best, 8);
});

test('orders progress, notify once, pay through the ledger and unlock the commendation', () => {
  const { db, players, svc, user, id } = setup(5);
  const orders = svc.ordersFor(user(), DAY);
  assert.equal(orders.length, 3);

  assert.match(svc.claimOrder(user(), 0, DAY).error, /isn’t complete/);
  assert.match(svc.claimBonus(user(), DAY).error, /all three/);

  for (const o of orders) svc.progress(id, o.type, o.target + 5, { param: o.param, now: DAY });
  const after = svc.view(user(), DAY).orders;
  assert.ok(after.every((o) => o.done && o.progress === o.target)); // capped at target
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'order'").get(id).n, 3);
  svc.progress(id, orders[0].type, 1, { param: orders[0].param, now: DAY });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'order'").get(id).n, 3);

  const cashBefore = user().cash;
  for (const o of orders) {
    const out = players.transaction(() => svc.claimOrder(user(), o.slot, DAY));
    assert.ok(!out.error, out.error);
  }
  assert.match(svc.claimOrder(user(), 0, DAY).error, /Already claimed/);
  const reward = daily.orderReward(5);
  assert.equal(user().cash, cashBefore + 3 * reward.cash);

  const bonus = players.transaction(() => svc.claimBonus(user(), DAY));
  assert.deepEqual(bonus.reward, reward);
  assert.match(svc.claimBonus(user(), DAY).error, /already claimed/);
  assert.equal(user().cash, cashBefore + 4 * reward.cash);

  const ledger = db.prepare("SELECT reason, SUM(delta_cash) AS cash FROM ledger WHERE user_id = ? AND reason LIKE 'daily-%' GROUP BY reason ORDER BY reason").all(id);
  assert.deepEqual(ledger.map((r) => [r.reason, r.cash]), [['daily-bonus', reward.cash], ['daily-order', 3 * reward.cash]]);

  // Yesterday's unclaimed orders are gone the next day; new ones appear.
  const tomorrow = svc.view(user(), DAY + 86_400_000);
  assert.ok(tomorrow.orders.every((o) => o.progress === 0 && !o.claimed));
  assert.equal(tomorrow.bonusClaimed, false);
});

test('a specific-mission order only counts that mission', () => {
  const { db, svc, user, id } = setup(5);
  svc.ordersFor(user(), DAY);
  db.prepare("UPDATE daily_orders SET type = 'mission_specific', param = 'convoy-escort', target = 2 WHERE user_id = ? AND slot = 0").run(id);
  svc.progress(id, 'mission_specific', 1, { param: 'perimeter-patrol', now: DAY });
  assert.equal(svc.ordersFor(user(), DAY)[0].progress, 0);
  svc.progress(id, 'mission_specific', 1, { param: 'convoy-escort', now: DAY });
  assert.equal(svc.ordersFor(user(), DAY)[0].progress, 1);
});

test('supply drop refills energy on day 7 and is recorded in the ledger', () => {
  const { db, players, svc, user, id } = setup(4);
  const yesterday = daily.dayKey(DAY - 86_400_000);
  db.prepare('UPDATE users SET streak_count = 6, streak_day = ?, streak_best = 6 WHERE id = ?').run(yesterday, id);
  const out = players.transaction(() => svc.claimSupplyDrop(user(), DAY));
  assert.deepEqual([out.streak, out.cycleDay, out.refillEnergy], [7, 7, true]);
  const u = user();
  assert.deepEqual([u.streak_count, u.streak_day, u.streak_best, u.energy], [7, daily.dayKey(DAY), 7, 60]);
  assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'supply-drop'").get(id).delta_cash, out.cash);
  assert.match(svc.claimSupplyDrop(user(), DAY).error, /already claimed/);
});

test('HQ shows daily orders; missions advance them and claims work over HTTP', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: {
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { res, text: await res.text() };
  };
  const csrf = async (from) => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf('/hq'), ...form } });

  try {
    await request('/register', {
      method: 'POST',
      form: { _csrf: await csrf('/register'), username: 'Dailyman', email: 'd@example.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
    });
    const hq = (await request('/hq')).text;
    assert.match(hq, /Daily orders/);
    assert.match(hq, /Supply drop/);
    assert.match(hq, /Next mission/);

    const id = db.prepare("SELECT id FROM users WHERE username = 'Dailyman'").get().id;
    // Make the first order "win missions" and the patrol a sure thing.
    db.prepare("UPDATE daily_orders SET type = 'missions_won', param = NULL, target = 1 WHERE user_id = ? AND slot = 0").run(id);
    let won = false;
    for (let i = 0; i < 6 && !won; i += 1) {
      db.prepare('UPDATE users SET energy = 60, health = max_health WHERE id = ?').run(id);
      await post('/missions/perimeter-patrol');
      won = db.prepare('SELECT progress FROM daily_orders WHERE user_id = ? AND slot = 0').get(id).progress === 1;
    }
    assert.ok(won, 'a won mission advances the order');

    const cash = db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
    const claim = await post('/daily/orders/0/claim');
    assert.equal(claim.res.headers.get('location'), '/hq#daily-title');
    const reward = db.prepare('SELECT reward_cash FROM daily_orders WHERE user_id = ? AND slot = 0').get(id).reward_cash;
    assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash, cash + reward);
    assert.match((await request('/hq')).text, /Claimed/);

    await post('/daily/supply/claim');
    const u = db.prepare('SELECT streak_count, streak_day FROM users WHERE id = ?').get(id);
    assert.deepEqual([u.streak_count, u.streak_day], [1, daily.dayKey()]);
    await post('/daily/supply/claim');
    assert.match((await request('/hq')).text, /already claimed|Today’s drop is in/);
    assert.equal(db.prepare('SELECT streak_count FROM users WHERE id = ?').get(id).streak_count, 1);

    assert.equal((await post('/daily/orders/abc/claim')).res.status, 302);
  } finally {
    server.close();
    app.anti.stop && app.anti.stop();
  }
});
