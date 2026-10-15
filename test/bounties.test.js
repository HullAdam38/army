'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bounties = require('../src/bounties');
const { createBountyService } = require('../src/bounty-service');
const { createPlayerRepo } = require('../src/players');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

test('bounty amounts, fees and who can post', () => {
  assert.deepEqual(bounties.parseAmount('$2,500'), { amount: 2500, fee: 250, total: 2750 });
  assert.deepEqual(bounties.parseAmount('501'), { amount: 501, fee: 51, total: 552 });
  assert.match(bounties.parseAmount('499').error, /start at \$500/);
  assert.match(bounties.parseAmount('abc').error, /start at/);
  assert.match(bounties.parseAmount('2000000').error, /largest/);

  const me = { id: 1, username: 'Hunter', level: 5 };
  const them = { id: 2, username: 'Prey', level: 5 };
  const ctx = { minPvpLevel: 3, openByPlacer: 0, linked: false };
  assert.equal(bounties.placeBlocker(me, them, ctx), null);
  assert.match(bounties.placeBlocker(me, me, ctx), /yourself/);
  assert.match(bounties.placeBlocker(me, { ...them, level: 2 }, ctx), /Recruit/);
  assert.match(bounties.placeBlocker(me, them, { ...ctx, linked: true }), /same device or network/);
  assert.match(bounties.placeBlocker(me, them, { ...ctx, openByPlacer: 5 }), /5 open bounties/);
  assert.match(bounties.placeBlocker(me, { ...them, banned_at: 1 }, ctx), /suspended/);

  const b = { placer_id: 7 };
  assert.equal(bounties.claimable(b, 7, () => false), false);
  assert.equal(bounties.claimable(b, 8, () => true), false);
  assert.equal(bounties.claimable(b, 8, () => false), true);
});

test('bounty service: post, claim, skip linked placers, expire with refund', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const linkedPairs = new Set(['1:4', '4:1']);
  const svc = createBountyService(db, players, (a, b) => linkedPairs.has(`${a}:${b}`));
  const now = Date.now();
  for (const n of ['Placer', 'Prey', 'Hunter', 'PlacerAlt']) {
    const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, cash)
                                  VALUES (?, ?, 'x', ?, ?, ?, 5, 10000)`).run(n, `${n}@x.com`, now, now, now).lastInsertRowid);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) VALUES (?, 10000, 'test', 0)").run(id);
  }
  const [placer, prey, hunter, alt] = [1, 2, 3, 4];
  const target = players.findById(prey);
  let out = players.transaction(() => svc.place({ placerId: placer, target, amountInput: '1000', now }));
  assert.deepEqual(out, { amount: 1000, fee: 100, total: 1100 });
  assert.equal(players.findById(placer).cash, 8900);
  out = players.transaction(() => svc.place({ placerId: alt, target, amountInput: '600', anonymous: true, now }));
  assert.ok(!out.error);
  assert.match(players.transaction(() => svc.place({ placerId: placer, target, amountInput: '20000', now })).error, /You have \$8,900/);
  assert.deepEqual(svc.totalOn(prey, now), { total: 1600, count: 2 });
  assert.deepEqual(svc.onTarget(prey, now).map((b) => b.placer), ['Placer', 'Someone']);

  // The placer's linked alt beats the prey: it may only take the bounty its account didn't place… and not the linked one.
  const battle = (a, d) => Number(db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, report, created_at) VALUES (?, ?, 1, 0, '{}', ?)").run(a, d, now).lastInsertRowid);
  const b1 = battle(alt, prey);
  assert.equal(players.transaction(() => svc.claim({ claimerId: alt, targetId: prey, battleId: b1, now })), null);
  // A real hunter collects both.
  const b2 = battle(hunter, prey);
  assert.deepEqual(players.transaction(() => svc.claim({ claimerId: hunter, targetId: prey, battleId: b2, now })), { total: 1600, count: 2 });
  assert.equal(players.findById(hunter).cash, 11600);
  assert.equal(svc.totalOn(prey, now).total, 0);
  assert.equal(svc.claimedCount(hunter), 1);
  assert.deepEqual(svc.forBattle(b2), { total: 1600, count: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'bounty' AND user_id = ?").get(placer).n, 1);

  // Expiry refunds the bounty but keeps the fee.
  players.transaction(() => svc.place({ placerId: placer, target, amountInput: '500', now }));
  const before = players.findById(placer).cash;
  assert.equal(svc.expireDue(now + bounties.DURATION_MS + 1), 1);
  assert.equal(players.findById(placer).cash, before + 500);
  assert.equal(svc.expireDue(now + bounties.DURATION_MS + 2), 0);

  // Every balance still matches the ledger, and the fees left the economy.
  const off = db.prepare('SELECT username FROM users u WHERE cash != (SELECT SUM(delta_cash) FROM ledger WHERE user_id = u.id)').all();
  assert.deepEqual(off, []);
  const total = db.prepare('SELECT SUM(cash) AS n FROM users').get().n;
  assert.equal(total, 40000 - 100 - 60 - 50);
});

test('bounties end to end: post from a profile, collect by winning a fight, medal', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
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
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return {
      request,
      post: async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } }),
      async enlist(username) {
        await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username, email: `${username}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
  };
  try {
    const placer = client(); await placer.enlist('Contractor');
    const prey = client(); await prey.enlist('Outlaw');
    const hunter = client(); await hunter.enlist('Marshal');
    db.prepare("UPDATE users SET level = 5, cash = 5000").run();
    db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) SELECT id, 4900, 'test', 0 FROM users").run();

    // Post from the profile; it shows as Wanted there and on the board.
    let r = await placer.post('/bounties', { target: 'Outlaw', amount: '2,000', back: 'profile' });
    assert.equal(r.location, '/profile/Outlaw#bounty');
    assert.match((await placer.request('/profile/Outlaw')).text, /Wanted · <strong>\$2,000<\/strong>/);
    assert.match((await hunter.request('/bounties')).text, /Outlaw[\s\S]*\$2,000/);
    assert.match((await prey.request('/bounties')).text, /\$2,000 on your head/);
    assert.match((await placer.post('/bounties', { target: 'Nobody', amount: '600' })).location, /\/bounties/);

    // The hunter beats the prey (made fragile so the fight is certain).
    db.prepare("UPDATE users SET health = 1 WHERE username = 'Outlaw'").run();
    r = await hunter.post('/attack/Outlaw');
    assert.match(r.location, /^\/battles\/\d+$/);
    const report = (await hunter.request(r.location)).text;
    assert.match(report, /collected a bounty worth \$2,000/);
    assert.equal(db.prepare("SELECT cash FROM users WHERE username = 'Marshal'").get().cash > 5000 + 1999, true);
    assert.equal(db.prepare("SELECT status FROM bounties").get().status, 'claimed');
    assert.ok(db.prepare("SELECT 1 FROM user_medals m JOIN users u ON u.id = m.user_id WHERE u.username = 'Marshal' AND m.medal_id = 'hunter'").get(), 'Bounty Hunter medal awarded');
  } finally {
    server.close();
  }
});
