'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('../src/slots');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('slot machine rules: lines, payouts, bets and the house edge', () => {
  assert.deepEqual(slots.evaluate(['star', 'star', 'star']), { mult: 100, kind: 'three', symbol: 'star' });
  assert.equal(slots.evaluate(['crest', 'crest', 'crest']).mult, 40);
  assert.equal(slots.evaluate(['target', 'target', 'target']).mult, 5);
  assert.equal(slots.evaluate(['cash', 'cash', 'helmet']).mult, 3, 'pair on the first two reels');
  assert.equal(slots.evaluate(['helmet', 'cash', 'cash']).mult, 0, 'a pair on reels 2–3 doesn’t pay');
  assert.equal(slots.evaluate(['star', 'helmet', 'cash']).mult, 1.5, 'one Star anywhere');
  assert.equal(slots.evaluate(['cash', 'star', 'star']).mult, 5, 'two Stars anywhere');
  assert.equal(slots.evaluate(['crest', 'crest', 'star']).mult, 5, 'the best win on the line pays');
  assert.equal(slots.evaluate(['target', 'target', 'star']).mult, 1.5);
  assert.equal(slots.describe(slots.evaluate(['star', 'star', 'star'])), 'JACKPOT! Three Stars: 100×');
  assert.equal(slots.describe(slots.evaluate(['weapon', 'weapon', 'cash'])), 'Pair of Rifles: 2×');
  assert.equal(slots.describe(slots.evaluate(['weapon', 'cash', 'helmet'])), 'No win');
  assert.equal(slots.payout(15, 1.5), 22, 'wins round down to whole dollars');

  // Reels pick by weight: 0 is the (rarest) Star, the top of the range the (commonest) Target.
  assert.equal(slots.pickSymbol(() => 0), 'star');
  assert.equal(slots.pickSymbol(() => 1), 'crest');
  assert.equal(slots.pickSymbol(() => 20), 'target');

  assert.match(slots.checkBet('5', { cash: 100, maxBet: 1000 }).error, /minimum bet is \$10/);
  assert.match(slots.checkBet('2000', { cash: 5000, maxBet: 1000 }).error, /maximum bet is \$1,000/);
  assert.match(slots.checkBet('500', { cash: 100, maxBet: 1000 }).error, /only have \$100 in cash/);
  assert.match(slots.checkBet('12.5', { cash: 100, maxBet: 1000 }).error, /whole-dollar/);
  assert.equal(slots.checkBet('$1,000', { cash: 5000, maxBet: 1000 }).bet, 1000);

  // Over every possible line the machine keeps about 5%.
  const r = slots.returnToPlayer();
  assert.ok(r.rtp > 0.94 && r.rtp < 0.96, `RTP ${r.rtp}`);
  assert.ok(r.winRate > 0.3 && r.winRate < 0.36);
  assert.equal(r.bigWinOdds, 257);
});

test('casino lobby and slot machine through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form, json = false } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(json ? { accept: 'application/json' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    c.spin = async (bet, { json = true } = {}) => {
      const r = await c.request('/casino/slots/spin', { method: 'POST', form: { _csrf: await c.csrf('/casino/slots'), bet: String(bet) }, json });
      return json ? { status: r.res.status, ...JSON.parse(r.text) } : r;
    };
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const cash = (id) => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
  const age = () => db.prepare('UPDATE casino_plays SET created_at = created_at - 5000').run(); // past the spin cooldown
  try {
    const ace = await join('Ace');
    // The menu links to the casino, which lists its games.
    assert.match((await ace.request('/hq')).text, /href="\/casino"/);
    let page = (await ace.request('/casino')).text;
    assert.match(page, /Choose a game/);
    assert.match(page, /href="\/casino\/slots"/);
    // New players have to reach the minimum level first.
    assert.match(page, /The casino opens at level 3/);
    assert.match((await ace.spin(100)).error, /opens at level 3/);

    // Top them up to $1,000, through the ledger like real money.
    const topUp = 1000 - cash(ace.id);
    db.prepare('UPDATE users SET level = 5, cash = 1000 WHERE id = ?').run(ace.id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'test', 0)").run(ace.id, topUp);
    page = (await ace.request('/casino/slots')).text;
    assert.match(page, /Paytable/);
    assert.match(page, /Three Stars \(jackpot\)/);
    assert.match(page, /pays back about 94\.9%/);

    // Bad bets are refused and cost nothing.
    assert.match((await ace.spin(5)).error, /minimum bet/);
    assert.match((await ace.spin(5000)).error, /only have \$1,000/);
    assert.equal(cash(ace.id), 1000);

    // A spin: cash moves by exactly the net result, written to the ledger.
    const s = await ace.spin(100);
    assert.equal(s.ok, true);
    assert.equal(s.line.length, 3);
    assert.equal(s.payout, slots.payout(100, slots.evaluate(s.line).mult));
    assert.equal(s.net, s.payout - 100);
    assert.equal(cash(ace.id), 1000 + s.net);
    assert.equal(s.player.cash, 1000 + s.net);
    assert.deepEqual(s.today, { plays: 1, wagered: 100, won: s.payout, best: s.payout - 100, net: s.net });
    if (s.net) assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'casino-slots'").get(ace.id).delta_cash, s.net);
    // Spinning again straight away is too fast.
    assert.match((await ace.spin(100)).error, /still turning/);

    // Without JavaScript: the form posts, and the page shows the result once.
    age();
    const before = cash(ace.id);
    const r = await ace.spin(50, { json: false });
    assert.equal(r.location, '/casino/slots#machine');
    page = (await ace.request('/casino/slots')).text;
    assert.match(page, /class="slots__result is-(win|loss)"/);
    assert.match(page, /value="50"/, 'the bet is remembered');
    assert.match((await ace.request('/casino/slots')).text, /Good luck, soldier\./, 'shown once');
    const last = db.prepare('SELECT * FROM casino_plays WHERE user_id = ? ORDER BY id DESC').get(ace.id);
    assert.equal(cash(ace.id), before + last.payout - 50);

    // A jackpot (forced reels) pays 100× and makes the big wins board.
    age();
    db.prepare('UPDATE users SET cash = cash + 1000 WHERE id = ?').run(ace.id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 1000, 0, 'test', 0)").run(ace.id);
    const c0 = cash(ace.id);
    const jackpot = app.players.transaction(() => app.casino.spinSlots({ userId: ace.id, bet: 200, randomInt: () => 0 }));
    assert.deepEqual(jackpot.line, ['star', 'star', 'star']);
    assert.equal(jackpot.payout, 20000);
    assert.equal(cash(ace.id), c0 + 19800);
    page = (await ace.request('/casino/slots')).text;
    assert.match(page, /Big wins this week[\s\S]*Ace[\s\S]*100× on \$200/);
    assert.match(page, /Your recent spins/);
    // The money adds up for anti-cheat.
    const scan = app.anti.runScan();
    assert.equal(scan.newFlags, 0, JSON.stringify(app.anti.listFlags().map((f) => f.summary)));

    // Admin settings: the maximum bet, and closing the casino.
    age();
    tuning.set({ slotsMaxBet: 100 });
    assert.match((await ace.spin(200)).error, /maximum bet is \$100/);
    tuning.set({ slotsMaxBet: 100, casinoOpen: false });
    assert.match((await ace.spin(50)).error, /casino is closed/);
    assert.match((await ace.request('/casino')).text, /casino is closed/);
  } finally {
    tuning.reset();
    server.close();
  }
});

test('roulette rules: the wheel, bets, payouts and the house edge', () => {
  const roulette = require('../src/roulette');
  assert.equal(roulette.WHEEL.length, 37);
  assert.deepEqual([...roulette.WHEEL].sort((a, b) => a - b), Array.from({ length: 37 }, (_, i) => i), 'every number once');
  assert.equal(roulette.RED.size, 18);
  assert.deepEqual([roulette.colorOf(0), roulette.colorOf(1), roulette.colorOf(2), roulette.colorOf(36)], ['green', 'red', 'black', 'red']);
  // Every bet on the table pays back 36/37.
  for (const spot of ['0', '17', '36', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen2', 'dozen3', 'col1', 'col2', 'col3']) {
    assert.ok(Math.abs(roulette.returnToPlayer(spot) - 36 / 37) < 1e-12, spot);
  }
  // Settling: stakes come back with the winnings; zero loses outside bets.
  assert.deepEqual(roulette.settle({ 17: 10, red: 100, dozen2: 50, col2: 20 }, 17), {
    payout: 360 + 150 + 60,
    winners: [{ spot: '17', name: '17', amount: 10, won: 360 }, { spot: 'dozen2', name: '2nd 12', amount: 50, won: 150 }, { spot: 'col2', name: 'Column 2', amount: 20, won: 60 }],
  });
  assert.equal(roulette.settle({ red: 100, black: 100, even: 50, low: 50, dozen1: 50, col3: 50 }, 0).payout, 0);
  assert.equal(roulette.settle({ 0: 10 }, 0).payout, 360);
  assert.equal(roulette.spin(() => 0).number, 0);
  assert.deepEqual(roulette.spin(() => 8), { pocket: 8, number: 17, color: 'black' });

  const limits = { cash: 1000, maxBet: 500 };
  assert.match(roulette.checkBets({}, limits).error, /Place a bet/);
  assert.match(roulette.checkBets({ 37: 10 }, limits).error, /isn’t a place/);
  assert.match(roulette.checkBets({ __proto__: 10 }, limits).error, /Place a bet/);
  assert.match(roulette.checkBets(Object.fromEntries([['__proto__', 10]]), limits).error, /isn’t a place/);
  assert.match(roulette.checkBets({ red: 5 }, limits).error, /least you can put on one place is \$10/);
  assert.match(roulette.checkBets({ red: 300, black: 300 }, limits).error, /table limit is \$500/);
  assert.match(roulette.checkBets({ red: 300 }, { cash: 100, maxBet: 500 }).error, /only have \$100 in cash/);
  assert.match(roulette.checkBets({ red: 1.5 }, limits).error, /whole dollars/);
  assert.deepEqual({ ...roulette.checkBets({ red: '100', 7: 20, black: '' }, limits) }, { bets: Object.assign(Object.create(null), { red: 100, 7: 20 }), total: 120 });
});

test('roulette through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form, json = false } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(json ? { accept: 'application/json' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async (from) => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const spin = async (fields, { json = true } = {}) => {
    const r = await request('/casino/roulette/spin', { method: 'POST', form: { _csrf: await csrf('/casino/roulette'), ...fields }, json });
    return json ? { status: r.res.status, ...JSON.parse(r.text) } : r;
  };
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username: 'Wheel', email: 'wheel@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    const id = db.prepare("SELECT id FROM users WHERE username = 'Wheel'").get().id;
    const cash = () => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
    const topUp = 2000 - cash();
    db.prepare('UPDATE users SET level = 5, cash = 2000 WHERE id = ?').run(id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'test', 0)").run(id, topUp);
    const age = () => db.prepare('UPDATE casino_plays SET created_at = created_at - 5000').run();

    // The lobby lists it; the page has the wheel and the whole table.
    assert.match((await request('/casino')).text, /href="\/casino\/roulette"/);
    const page = (await request('/casino/roulette')).text;
    assert.match(page, /data-wheel/);
    for (const spot of ['0', '17', '36', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen3', 'col1', 'col3']) assert.ok(page.includes(`data-spot="${spot}"`), spot);
    assert.match(page, /every bet pays back 97\.3%/);

    // Several bets at once (JavaScript table): cash moves by the net result.
    let s = await spin({ 'b-red': '100', 'b-17': '20', 'b-dozen2': '50' });
    assert.equal(s.ok, true);
    assert.equal(s.total, 170);
    const expected = require('../src/roulette').settle({ red: 100, 17: 20, dozen2: 50 }, s.number).payout;
    assert.equal(s.payout, expected);
    assert.equal(cash(), 2000 + s.payout - 170);
    assert.equal(s.player.cash, cash());
    assert.equal(s.today.plays, 1);
    if (s.net) assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'casino-roulette'").get(id).delta_cash, s.net);
    assert.match((await spin({ 'b-red': '100' })).error, /still turning/);

    // Bad bets cost nothing.
    age();
    const c0 = cash();
    assert.match((await spin({ 'b-red': '5' })).error, /least you can put/);
    assert.match((await spin({ 'b-49': '50' })).error, /isn’t a place/);
    assert.match((await spin({ 'b-__proto__': '50' })).error, /isn’t a place/);
    assert.match((await spin({})).error, /Place a bet/);
    assert.match((await spin({ 'b-red': String(c0 + 100) })).error, /table limit|only have/);
    assert.equal(cash(), c0);

    // Without JavaScript: one place, the amount in the box, and the result on the page once.
    const r = await spin({ spot: 'black', amount: '50' }, { json: false });
    assert.equal(r.location, '/casino/roulette#table');
    const after = (await request('/casino/roulette')).text;
    assert.match(after, /class="roulette__outcome is-(win|loss)"/);
    assert.match(after, /class="rnum rnum--(red|black|green)"/);
    assert.match(after, /value="50"/, 'the amount is remembered');

    // A straight-up hit (forced wheel) pays 35 to 1 and makes the big wins board.
    age();
    const before = cash();
    const hit = app.players.transaction(() => app.casino.spinRoulette({ userId: id, bets: { 17: 20, red: 30 }, randomInt: () => 8 }));
    assert.equal(hit.number, 17, '17 is black, so the Red bet loses');
    assert.equal(hit.payout, 720);
    assert.equal(cash(), before + 670);
    assert.doesNotMatch((await request('/casino/roulette')).text, /Big wins this week[\s\S]*Wheel/, '14.4× the total bet is not a big win');
    age();
    const lone = app.players.transaction(() => app.casino.spinRoulette({ userId: id, bets: { 0: 10 }, randomInt: () => 0 }));
    assert.equal(lone.payout, 360);
    assert.match((await request('/casino/roulette')).text, /Big wins this week[\s\S]*Wheel/);
    assert.equal(app.anti.runScan().newFlags, 0, 'the money adds up');

    // The table limit is an admin setting.
    age();
    tuning.set({ rouletteMaxBet: 100 });
    assert.match((await spin({ 'b-red': '60', 'b-black': '60' })).error, /table limit is \$100/);
  } finally {
    tuning.reset();
    server.close();
  }
});
