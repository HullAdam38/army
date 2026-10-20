'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tuning = require('../src/tuning');
const { createCasinoPlayer, parseLimit, LIMIT_DELAY_MS } = require('../src/casino-player');
const { createBlackjackService } = require('../src/blackjack-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const HOUR = 60 * 60 * 1000;

function makeUser(db, name, cash = 100000) {
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, cash, energy_updated_at, health_updated_at, created_at, last_seen_at)
    VALUES (?, ?, 'x', 10, ?, 0, 0, 0, 0)`).run(name, `${name}@x.com`, cash).lastInsertRowid);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'test', 0)").run(id, cash);
  return id;
}

test('loss limits: tighter at once, looser after 24 hours; breaks only get longer', () => {
  const db = openDatabase(':memory:');
  const cp = createCasinoPlayer(db);
  const id = makeUser(db, 'Ace');
  const now = Date.parse('2026-10-18T12:00:00Z');

  assert.match(parseLimit('50').error, /\$100/);
  assert.match(parseLimit('12.5').error, /whole-dollar/);
  assert.deepEqual(parseLimit(''), { limit: null });
  assert.deepEqual(parseLimit('$5,000'), { limit: 5000 });

  assert.equal(cp.status(id, now).limit, null);
  assert.equal(cp.room(id, now), Infinity);
  assert.match(cp.setLimit(id, '5000', now).ok, /works from now/);
  assert.equal(cp.status(id, now).limit, 5000);
  assert.match(cp.setLimit(id, '2000', now).ok, /works from now/, 'lowering is immediate');
  assert.equal(cp.status(id, now).limit, 2000);

  // Raising waits a day, and can be called off.
  assert.match(cp.setLimit(id, '9000', now).ok, /in 24 hours/);
  let s = cp.status(id, now + HOUR);
  assert.deepEqual([s.limit, s.next, s.nextAt], [2000, 9000, now + LIMIT_DELAY_MS]);
  assert.match(cp.cancelPending(id, now + HOUR).ok, /cancelled/);
  assert.equal(cp.status(id, now + 2 * LIMIT_DELAY_MS).limit, 2000);
  assert.match(cp.cancelPending(id, now + HOUR).error, /no change/);

  // Removing also waits, then applies by itself.
  assert.match(cp.setLimit(id, '', now).ok, /removed in 24 hours/);
  assert.equal(cp.status(id, now + LIMIT_DELAY_MS - 1).limit, 2000);
  s = cp.status(id, now + LIMIT_DELAY_MS);
  assert.deepEqual([s.limit, s.next], [null, undefined]);

  // Losses in the last 24 hours (net of wins) count against the limit.
  cp.setLimit(id, '1000', now);
  const play = (bet, payout, at) => db.prepare("INSERT INTO casino_plays (user_id, game, bet, payout, mult, result, created_at) VALUES (?, 'slots', ?, ?, 0, '{}', ?)").run(id, bet, payout, at);
  play(800, 0, now - 2 * HOUR);
  play(300, 400, now - HOUR);
  play(5000, 0, now - 25 * HOUR); // too old to count
  assert.equal(cp.status(id, now).lost, 700);
  assert.equal(cp.room(id, now), 300);
  assert.equal(cp.stakeBlocker(id, 300, now), null);
  assert.match(cp.stakeBlocker(id, 301, now), /stake \$300 more/);
  play(300, 0, now);
  assert.match(cp.stakeBlocker(id, 10, now), /reached your daily loss limit/);

  // Breaks.
  const me = () => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.equal(cp.breakBlocker(me(), now), null);
  assert.match(cp.takeBreak(id, 'forever', now).error, /how long/);
  assert.match(cp.takeBreak(id, 'week', now).ok, /7 days/);
  assert.match(cp.breakBlocker(me(), now + HOUR), /taking a break from the casino until 2026-10-25|until Sun, 25 Oct 2026/);
  assert.match(cp.takeBreak(id, 'day', now + HOUR).error, /already on a break/, 'a break can’t be shortened');
  assert.ok(cp.takeBreak(id, 'month', now + HOUR).ok, 'but it can be made longer');
  assert.equal(cp.breakBlocker(me(), now + 31 * 24 * HOUR), null, 'and it ends by itself');
});

test('limits and breaks apply to every game, and blackjack bets on the table count', () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const id = makeUser(db, 'Ace', 50000);
  const t0 = Date.now();
  // Stacked slot reels for a loss.
  const reels = (...picks) => { let i = 0; return () => picks[i++ % picks.length]; };

  app.casino.player.setLimit(id, '1000');
  assert.match(app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 1500, now: t0 })).error, /past your daily loss limit/);
  assert.match(app.players.transaction(() => app.casino.spinRoulette({ userId: id, bets: { red: 1001 }, now: t0 })).error, /past your daily loss limit/);
  const ok = app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 600, now: t0, randomInt: reels(20, 10, 15) }));
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.payout, 0, 'a losing line');
  assert.match(app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 500, now: t0 + 5000 })).error, /stake \$400 more/);

  // Blackjack: the bet counts until the hand is paid, so it can't be doubled past the limit.
  const players = app.players;
  const bj = app.blackjack;
  bj._state(1).shoe = [...Array(200).fill('2C'), ...['5S', '9H', '6D', 'KC'].reverse()];
  players.transaction(() => bj.sit({ tableId: 1, userId: id, now: t0 }));
  assert.match(players.transaction(() => bj.bet({ tableId: 1, userId: id, amount: 500, now: t0 })).error, /past your daily loss limit/);
  assert.ok(!players.transaction(() => bj.bet({ tableId: 1, userId: id, amount: 300, now: t0 })).error);
  assert.equal(app.casino.player.status(id).lost, 900, 'the $300 on the table counts as lost until it is settled');
  // Everyone has bet, so the cards are dealt: 5+6 = 11, a classic double, but only $100 is left under the limit.
  const view = bj.view(1, id, t0 + 1);
  assert.equal(view.phase, 'playing');
  assert.deepEqual(view.you.actions, ['hit', 'stand'], 'double isn’t offered past the limit');
  assert.match(players.transaction(() => bj.act({ tableId: 1, userId: id, action: 'double', now: t0 + 1 })).error, /loss limit/);
  players.transaction(() => bj.act({ tableId: 1, userId: id, action: 'stand', now: t0 + 2 }));
  assert.equal(bj.view(1, id, t0 + 3).phase, 'done');
  assert.equal(app.casino.player.status(id).lost, 900, 'settled: now in casino_plays, not counted twice');

  // A break closes every game.
  app.casino.player.takeBreak(id, 'day');
  const me = players.findById(id);
  assert.match(app.casino.blocker(me), /taking a break/);
  assert.match(bj.blocker(me), /taking a break/);
  assert.match(players.transaction(() => app.casino.spinSlots({ userId: id, bet: 10, now: t0 + 60000 })).error, /taking a break/);
  assert.equal(app.anti.runScan().newFlags, 0, 'every bet went through the ledger');
});

test('big wins are shouted in global chat and count towards the casino medals', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  tuning.set({ casinoShoutMin: 10000 });
  try {
    const id = makeUser(db, 'Lucky', 50000);
    const t0 = Date.now();
    // Three Stars: the 100× jackpot.
    const small = app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 50, now: t0, randomInt: () => 0 }));
    assert.equal(small.payout, 5000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'casino'").get().n, 0, 'a $4,950 win is below the shout');
    const big = app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 1000, now: t0 + 5000, randomInt: () => 0 }));
    assert.equal(big.payout, 100000);
    const shout = db.prepare("SELECT * FROM chat_messages WHERE kind = 'casino'").get();
    assert.equal(shout.channel, 'global');
    assert.equal(shout.body, '[b]Lucky[/b] won [b]$99,000[/b] at the slot machine with a 100× jackpot!');

    let u = db.prepare('SELECT casino_wagered, casino_big_wins, casino_blackjacks FROM users WHERE id = ?').get(id);
    assert.deepEqual({ ...u }, { casino_wagered: 1050, casino_big_wins: 2, casino_blackjacks: 0 });
    const awarded = app.medals.check(id).map((w) => `${w.medal.id}:${w.tier.tier}`);
    assert.ok(awarded.includes('bigwinner:1') && !awarded.some((a) => a.startsWith('highroller')), awarded.join());

    // A shout isn't the player's own chat: it doesn't trip their chat cooldown or anyone's unread count.
    const other = makeUser(db, 'Reader');
    assert.equal(app.players.chatUnread(app.players.findById(other)).global, false);

    // Turned off at 0.
    tuning.set({ casinoShoutMin: 0 });
    app.players.transaction(() => app.casino.spinSlots({ userId: id, bet: 1000, now: t0 + 10000, randomInt: () => 0 }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'casino'").get().n, 1);
    u = db.prepare('SELECT casino_wagered FROM users WHERE id = ?').get(id);
    assert.equal(u.casino_wagered, 2050);
  } finally {
    tuning.reset();
  }
});

test('blackjacks count for Card Sharp', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const cp = createCasinoPlayer(db);
  const svc = createBlackjackService(db, players, { casinoPlayer: cp });
  const id = makeUser(db, 'Sharp', 5000);
  const t0 = Date.now();
  // Player: A, K (blackjack). Dealer: 9, 7.
  svc._state(1).shoe = [...Array(200).fill('2C'), ...['AS', '9H', 'KD', '7C'].reverse()];
  players.transaction(() => svc.sit({ tableId: 1, userId: id, now: t0 }));
  players.transaction(() => svc.bet({ tableId: 1, userId: id, amount: 100, now: t0 }));
  assert.equal(svc._state(1).phase, 'done');
  const u = db.prepare('SELECT casino_wagered, casino_blackjacks FROM users WHERE id = ?').get(id);
  assert.deepEqual({ ...u }, { casino_wagered: 100, casino_blackjacks: 1 });
});

test('the limits page, breaks through the app, and shouts in chat', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
    for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text() };
  };
  const csrf = async (from) => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username: 'Ace', email: 'ace@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    const id = db.prepare("SELECT id FROM users WHERE username = 'Ace'").get().id;
    db.prepare('UPDATE users SET level = 10 WHERE id = ?').run(id);

    let page = (await request('/casino')).text;
    assert.match(page, /No daily loss limit set/);
    assert.match(page, /href="\/casino\/limits"/);
    page = (await request('/casino/limits')).text;
    assert.match(page, /Daily loss limit/);
    assert.match(page, /Take a break/);

    await request('/casino/limits', { method: 'POST', form: { _csrf: await csrf('/casino/limits'), limit: '2,500' } });
    page = (await request('/casino/limits')).text;
    assert.match(page, /Daily loss limit set to \$2,500/);
    assert.match((await request('/casino')).text, /Daily loss limit \$2,500: \$2,500 left to stake/);
    await request('/casino/limits', { method: 'POST', form: { _csrf: await csrf('/casino/limits'), limit: '5000' } });
    page = (await request('/casino/limits')).text;
    assert.match(page, /goes up to \$5,000 at/);
    assert.match(page, /Keep my current limit/);

    // The break needs the box ticking, then shuts the casino and stands you up from blackjack.
    await request('/casino/blackjack/1/sit', { method: 'POST', form: { _csrf: await csrf('/casino/blackjack/1') } });
    assert.equal(app.blackjack.tableOf(id), 1);
    await request('/casino/break', { method: 'POST', form: { _csrf: await csrf('/casino/limits'), length: 'week' } });
    assert.match((await request('/casino/limits')).text, /Tick the box to confirm/);
    await request('/casino/break', { method: 'POST', form: { _csrf: await csrf('/casino/limits'), length: 'week', confirm: 'on' } });
    page = (await request('/casino/limits')).text;
    assert.match(page, /on a break from the casino for 7 days/);
    assert.match(page, /You’re on a break until/);
    assert.equal(app.blackjack.tableOf(id), null);
    assert.match((await request('/casino')).text, /taking a break from the casino until/);
    assert.match((await request('/casino/slots')).text, /taking a break from the casino until/);

    // A shout shows in global chat as an announcement, without the report menu.
    db.prepare("INSERT INTO chat_messages (channel, user_id, body, created_at, kind) VALUES ('global', ?, '[b]Ace[/b] won [b]$50,000[/b] at roulette!', ?, 'casino')").run(id, Date.now());
    page = (await request('/chat/global')).text;
    assert.match(page, /chat-msg--shout/);
    assert.match(page, /<strong>Ace<\/strong> won <strong>\$50,000<\/strong> at roulette!/);
    assert.match(page, /Delete announcement/, 'the winner can take it down');
    assert.doesNotMatch(page.slice(page.indexOf('chat-msg--shout')), /Report to admins/);
    // …and it doesn't stop them chatting.
    const r = await request('/chat/global', { method: 'POST', form: { _csrf: await csrf('/chat/global'), body: 'gg' } });
    assert.ok(r.res.status < 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind IS NULL AND body = 'gg'").get().n, 1);
  } finally {
    server.close();
  }
});
