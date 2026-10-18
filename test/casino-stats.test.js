'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const roulette = require('../src/roulette');
const slots = require('../src/slots');
const { createCasinoStats } = require('../src/casino-stats');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function seed(db) {
  const user = (name) => Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at)
    VALUES (?, ?, 'x', 0, 0, 0)`).run(name, `${name}@x.com`).lastInsertRowid);
  const play = (userId, game, bet, payout, variance, at) => db.prepare(`INSERT INTO casino_plays (user_id, game, bet, payout, mult, result, created_at, variance)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`).run(userId, game, bet, payout, payout / bet, at, variance);
  const steady = user('Steady');
  const lucky = user('Lucky');
  const oneHit = user('OneHit');
  const slotsVar = slots.returnToPlayer().variance;
  // Steady: 200 slot spins of $100 that pay back exactly the expected 94.9%.
  for (let i = 0; i < 200; i += 1) play(steady, 'slots', 100, i % 2 ? 190 : 0, 100 * 100 * slotsVar, NOW - 2 * DAY);
  // Lucky: 40 single-number roulette bets of $100, winning 10 of them (about 1 in 37 is normal).
  const straight = roulette.varianceOf({ 17: 100 });
  for (let i = 0; i < 40; i += 1) play(lucky, 'roulette', 100, i < 10 ? 3600 : 0, straight, NOW - DAY);
  // OneHit: a jackpot in a handful of spins: big, but too few plays to judge.
  for (let i = 0; i < 5; i += 1) play(oneHit, 'slots', 1000, i === 0 ? 100000 : 0, 1000 * 1000 * slotsVar, NOW - 3 * DAY);
  // Old plays outside a 7-day window.
  play(steady, 'blackjack', 500, 0, 500 * 500 * 1.3, NOW - 20 * DAY);
  // What players earned elsewhere.
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 100000, 0, 'mission', ?)").run(steady, NOW - DAY);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 5000, 0, 'casino-slots', ?)").run(steady, NOW - DAY);
  return { steady, lucky, oneHit };
}

test('casino stats: take, return, daily chart, winners and luck', () => {
  const db = openDatabase(':memory:');
  const ids = seed(db);
  const c = createCasinoStats(db).overview({ days: 7, now: NOW });

  const games = Object.fromEntries(c.games.map((g) => [g.id, g]));
  assert.deepEqual([games.slots.plays, games.slots.players, games.slots.wagered, games.slots.paid], [205, 2, 25000, 19000 + 100000]);
  assert.deepEqual([games.roulette.plays, games.roulette.wagered, games.roulette.paid], [40, 4000, 36000]);
  assert.equal(games.blackjack.plays, 0, 'the 20-day-old hand is outside the window');
  assert.equal(games.roulette.take, -32000);
  assert.ok(Math.abs(games.roulette.actualRtp - 9) < 1e-9);
  assert.equal(games.slots.biggest.username, 'OneHit');
  assert.equal(c.total.take, 25000 - 119000 + 4000 - 36000);
  assert.equal(c.earned, 100000, 'casino wins and opening balances aren’t earnings');
  assert.equal(c.takeShare, c.total.take / 100000);

  assert.equal(c.daily.length, 7);
  assert.equal(c.daily.at(-1).day, '2026-10-18');
  assert.equal(c.daily.find((d) => d.day === '2026-10-17').take, -32000);

  assert.deepEqual(c.winners.map((w) => w.username), ['OneHit', 'Lucky']);
  assert.deepEqual(c.losers.map((w) => w.username), ['Steady']);

  // Only Lucky is flagged: 10 straight-up hits in 40 is far beyond chance.
  // Steady matches the odds, and OneHit hasn't played enough to judge.
  assert.deepEqual(c.lucky.map((r) => r.username), ['Lucky']);
  assert.ok(c.lucky[0].z > 5, `z ${c.lucky[0].z}`);
  assert.equal(c.lucky[0].user_id, ids.lucky);

  // A 30-day window includes the old blackjack hand.
  assert.equal(createCasinoStats(db).overview({ days: 30, now: NOW }).games.find((g) => g.id === 'blackjack').plays, 1);
});

test('plays record their variance for the luck check', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, cash, energy_updated_at, health_updated_at, created_at)
    VALUES ('Spinner', 'spin@x.com', 'x', 10, 5000, 0, 0, 0)`).run().lastInsertRowid);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 5000, 0, 'test', 0)").run(id);
  app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 100, now: 1000 }));
  app.players.transaction(() => app.casino.spinRoulette({ userId: id, bets: { red: 100, 17: 10 }, now: 5000 }));
  const rows = db.prepare('SELECT game, variance FROM casino_plays ORDER BY id').all();
  assert.ok(Math.abs(rows[0].variance - 100 * 100 * slots.returnToPlayer().variance) < 1e-6);
  assert.ok(Math.abs(rows[1].variance - roulette.varianceOf({ red: 100, 17: 10 })) < 1e-6);
});

test('the Admin › Casino page', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jarFor = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text() };
    };
    return request;
  };
  const join = async (name) => {
    const request = jarFor();
    const token = (await request('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
    await request('/register', { method: 'POST', form: { _csrf: token, username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return request;
  };
  try {
    const boss = await join('Boss');
    const pleb = await join('Pleb');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
    seed(db);
    assert.equal((await pleb('/admin/casino')).res.status, 404);
    let page = (await boss('/admin/casino')).text;
    for (const s of ['House take', 'Of cash earned', 'By game', 'House take per day', 'Unusually lucky', 'Top winners', 'Biggest losers']) assert.ok(page.includes(s), s);
    assert.match(page, /class="admin-nav__link" href="\/admin\/casino" aria-current="page"/);
    assert.match(page, /href="\/admin\/casino\?days=7" aria-current="page"/);
    page = (await boss('/admin/casino?days=30')).text;
    assert.match(page, /href="\/admin\/casino\?days=30" aria-current="page"/);
    assert.equal((await boss('/admin/casino?days=999')).res.status, 200, 'bad periods fall back to 7 days');
  } finally {
    server.close();
  }
});
