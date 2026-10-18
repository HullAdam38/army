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
