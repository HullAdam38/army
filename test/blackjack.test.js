'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bj = require('../src/blackjack');
const { BET_MS, TURN_MS, DONE_MS, IDLE_MS, createBlackjackService } = require('../src/blackjack-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const tuning = require('../src/tuning');

test('blackjack rules: hand values, the dealer and settling', () => {
  assert.deepEqual(bj.handValue(['AS', '6H']), { total: 17, soft: true });
  assert.deepEqual(bj.handValue(['AS', '6H', 'KD']), { total: 17, soft: false });
  assert.deepEqual(bj.handValue(['AS', 'AD', '9C']), { total: 21, soft: true });
  assert.equal(bj.handValue(['KS', 'QH', '5D']).total, 25);
  assert.ok(bj.isBlackjack(['AS', 'KD']));
  assert.ok(!bj.isBlackjack(['AS', '5D', '5C']));

  // The dealer draws to 17 and stands on soft 17.
  const deck = ['5C', '10H'];
  assert.deepEqual(bj.dealerPlay(['AS', '6H'], () => deck.shift()), ['AS', '6H']);
  assert.deepEqual(bj.dealerPlay(['10S', '6H'], () => deck.shift()), ['10S', '6H', '5C']);
  assert.ok(bj.dealerPeeks('AS') && bj.dealerPeeks('KD') && !bj.dealerPeeks('9C'));

  const hand = (cards, bet = 100, extra = {}) => ({ cards, bet, ...extra });
  assert.deepEqual(bj.settleHand(hand(['AS', 'KD']), ['10S', '7H']), { result: 'blackjack', payout: 250 });
  assert.deepEqual(bj.settleHand(hand(['AS', 'KD'], 15), ['10S', '7H']), { result: 'blackjack', payout: 37 }, '3:2 rounds down');
  assert.deepEqual(bj.settleHand(hand(['AS', 'KD']), ['AH', 'QD']), { result: 'push', payout: 100 });
  assert.deepEqual(bj.settleHand(hand(['10S', '9H']), ['AH', 'QD']), { result: 'lose', payout: 0 });
  assert.deepEqual(bj.settleHand(hand(['10S', '9H']), ['10H', '8D']), { result: 'win', payout: 200 });
  assert.deepEqual(bj.settleHand(hand(['10S', '8H']), ['10H', '8D']), { result: 'push', payout: 100 });
  assert.deepEqual(bj.settleHand(hand(['10S', '5H', '9C']), ['10H', '6D', 'KS']), { result: 'bust', payout: 0 }, 'a player bust loses even if the dealer busts');
  assert.deepEqual(bj.settleHand(hand(['10S', '5H']), ['10H', '6D', 'KS']), { result: 'win', payout: 200 });
  assert.deepEqual(bj.settleHand(hand(['AS', 'KD'], 100, { split: true }), ['10H', '7D']), { result: 'win', payout: 200 }, '21 after a split is not blackjack');

  assert.deepEqual(bj.actionsFor(hand(['8S', '8H']), { handsInSeat: 1, cash: 500 }), ['hit', 'stand', 'double', 'split']);
  assert.deepEqual(bj.actionsFor(hand(['8S', '8H']), { handsInSeat: 2, cash: 500 }), ['hit', 'stand', 'double'], 'no re-splits');
  assert.deepEqual(bj.actionsFor(hand(['8S', '8H']), { handsInSeat: 1, cash: 50 }), ['hit', 'stand'], 'doubling needs the cash');
  assert.deepEqual(bj.actionsFor(hand(['8S', '2H', '3C']), { handsInSeat: 1, cash: 500 }), ['hit', 'stand']);
  assert.deepEqual(bj.actionsFor(hand(['KS', 'KH']), { handsInSeat: 1, cash: 500 }), ['hit', 'stand', 'double', 'split']);
  assert.deepEqual(bj.actionsFor(hand(['KS', 'QH']), { handsInSeat: 1, cash: 500 }), ['hit', 'stand', 'double'], 'only a true pair splits');

  const shoe = bj.newShoe();
  assert.equal(shoe.length, 312);
  assert.equal(new Set(shoe).size, 52);
  assert.equal(shoe.filter((c) => c === 'AS').length, 6);
  assert.ok(!bj.needsShuffle(shoe) && !bj.needsShuffle(shoe.slice(0, 160)) && bj.needsShuffle(shoe.slice(0, 150)), 'reshuffles at half the shoe');
});

/** A service with two seated players and a stacked shoe. */
function setup() {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const make = (name) => {
    const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, cash, energy_updated_at, health_updated_at, created_at)
      VALUES (?, ?, 'x', 10, 5000, 0, 0, 0)`).run(name, `${name}@x.com`).lastInsertRowid);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 5000, 0, 'test', 0)").run(id);
    return id;
  };
  const svc = createBlackjackService(db, players);
  const ace = make('Ace');
  const bea = make('Bea');
  const cash = (id) => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
  // Cards are drawn from the end of the shoe; filler keeps it from reshuffling.
  const stack = (order) => { svc._state(1).shoe = [...Array(200).fill('2C'), ...[...order].reverse()]; };
  const tx = (fn) => players.transaction(fn);
  return { db, players, svc, ace, bea, cash, stack, tx };
}

test('blackjack table: two players, a natural, a split and a double', () => {
  const { db, svc, ace, bea, cash, stack, tx } = setup();
  let now = 1_000_000;
  assert.equal(tx(() => svc.sit({ tableId: 1, userId: ace, seat: 0, now })).seat, 0);
  assert.equal(tx(() => svc.sit({ tableId: 1, userId: bea, now })).seat, 1, 'first free seat');
  assert.match(tx(() => svc.sit({ tableId: 2, userId: ace, now })).error, /sitting at the Mess Hall/);
  assert.match(tx(() => svc.sit({ tableId: 1, userId: bea, seat: 0, now })).error, /already at this table/);

  // Round 1. Ace: 10 6, hits 5 → 21. Bea: blackjack. Dealer: 9 7, draws 2 → 18.
  stack(['10S', 'AS', '9C', '6H', 'KD', '7D', '5C', '2H']);
  assert.match(tx(() => svc.bet({ tableId: 1, userId: ace, amount: '5', now })).error, /\$10 to \$500/);
  assert.match(tx(() => svc.bet({ tableId: 1, userId: ace, amount: '600', now })).error, /\$10 to \$500/);
  tx(() => svc.bet({ tableId: 1, userId: ace, amount: '100', now }));
  assert.equal(svc._state(1).phase, 'betting');
  assert.equal(svc._state(1).deadline, now + BET_MS);
  assert.equal(cash(ace), 4900, 'the bet is taken at once');
  assert.match(tx(() => svc.bet({ tableId: 1, userId: ace, amount: '100', now })).error, /already down/);
  tx(() => svc.bet({ tableId: 1, userId: bea, amount: '50', now })); // everyone has bet: deal now
  let s = svc._state(1);
  assert.equal(s.phase, 'playing');
  assert.deepEqual(s.turn, { seat: 0, hand: 0 });
  // Bea's natural doesn't need a turn; nobody sees the dealer's hole card yet.
  let view = svc.view(1, bea, now);
  assert.equal(view.dealer.cards[1], null);
  assert.equal(view.dealer.total, 9);
  assert.deepEqual(view.you.actions, []);
  assert.deepEqual(svc.view(1, ace, now).you.actions, ['hit', 'stand', 'double']);
  assert.match(tx(() => svc.act({ tableId: 1, userId: bea, action: 'hit', now })).error, /isn’t your turn/);
  assert.match(tx(() => svc.act({ tableId: 1, userId: ace, action: 'hit', round: 0, now })).error, /round is over/);
  tx(() => svc.act({ tableId: 1, userId: ace, action: 'hit', round: 1, now }));
  s = svc._state(1);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.dealer, ['9C', '7D', '2H']);
  assert.equal(cash(ace), 4900 + 200);
  assert.equal(cash(bea), 4950 + 125, 'blackjack pays 3 to 2');
  view = svc.view(1, ace, now);
  assert.equal(view.dealer.cards.length, 3, 'revealed');
  assert.equal(view.seats[0].hands[0].resultLabel, 'Win');
  assert.equal(view.seats[1].hands[0].resultLabel, 'Blackjack!');
  const plays = db.prepare("SELECT user_id, bet, payout FROM casino_plays WHERE game = 'blackjack' ORDER BY user_id").all().map((r) => ({ ...r }));
  assert.deepEqual(plays, [{ user_id: ace, bet: 100, payout: 200 }, { user_id: bea, bet: 50, payout: 125 }]);

  // The results stay up, then the table clears for the next round.
  now += DONE_MS + 1;
  svc.tick(now);
  assert.equal(svc._state(1).phase, 'idle');
  assert.equal(svc._state(1).seats.filter(Boolean).length, 2);

  // Round 2. Ace: 8 8, splits (8+3, 8+10), doubles the first (+K → 21), stands on 18.
  // Bea: 5 6, doubles (+9 → 20). Dealer: 10 7 stands on 17.
  stack(['8S', '5D', '10H', '8H', '6C', '7S', '3D', '10C', 'KS', '9H']);
  const a0 = cash(ace);
  const b0 = cash(bea);
  tx(() => svc.bet({ tableId: 1, userId: ace, amount: '100', now }));
  tx(() => svc.bet({ tableId: 1, userId: bea, amount: '100', now }));
  assert.deepEqual(svc.view(1, ace, now).you.actions, ['hit', 'stand', 'double', 'split']);
  tx(() => svc.act({ tableId: 1, userId: ace, action: 'split', now }));
  assert.deepEqual(svc._state(1).seats[0].hands.map((h) => h.cards), [['8S', '3D'], ['8H', '10C']]);
  tx(() => svc.act({ tableId: 1, userId: ace, action: 'double', now }));
  assert.deepEqual(svc._state(1).turn, { seat: 0, hand: 1 });
  tx(() => svc.act({ tableId: 1, userId: ace, action: 'stand', now }));
  assert.deepEqual(svc._state(1).turn, { seat: 1, hand: 0 });
  tx(() => svc.act({ tableId: 1, userId: bea, action: 'double', now }));
  s = svc._state(1);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.seats[0].hands.map((h) => [h.bet, h.result]), [[200, 'win'], [100, 'win']]);
  assert.equal(cash(ace), a0 - 300 + 600);
  assert.equal(cash(bea), b0 - 200 + 400);
  // Every cash move went through the ledger.
  const ledger = db.prepare("SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger WHERE user_id = ? AND reason = 'casino-blackjack'").get(ace).n;
  assert.equal(5000 + ledger, cash(ace));
});

test('blackjack table: timeouts, dealer blackjack, leaving, idle players and restarts', () => {
  const { db, players, svc, ace, bea, cash, stack, tx } = setup();
  let now = 2_000_000;
  tx(() => svc.sit({ tableId: 1, userId: ace, now }));
  tx(() => svc.sit({ tableId: 1, userId: bea, now }));

  // Only Ace bets: the window closes after 15 seconds and the round deals.
  stack(['10S', '6H', '7C', '10D', '9S']); // Ace 17; dealer 6 10, draws 9 → bust
  tx(() => svc.bet({ tableId: 1, userId: ace, amount: '100', now }));
  now += BET_MS - 1;
  svc.tick(now);
  assert.equal(svc._state(1).phase, 'betting');
  now += 2;
  svc.tick(now);
  assert.equal(svc._state(1).phase, 'playing');
  assert.equal(svc._state(1).seats[1].hands.length, 0, 'Bea sits this one out');
  // Ace doesn't act: after 20 seconds the hand stands and the dealer plays.
  now += TURN_MS + 1;
  svc.view(1, ace, now); svc.view(1, bea, now); // both still watching
  svc.tick(now);
  const s = svc._state(1);
  assert.equal(s.phase, 'done');
  assert.ok(s.log.some((l) => /Ace ran out of time and stands/.test(l)));
  assert.equal(s.seats[0].hands[0].result, 'win', 'the dealer bust');

  // Restart mid-round: a new service on the same database carries on.
  now += DONE_MS + 1;
  svc.tick(now);
  stack(['AS', '9D', 'AH', '7C', '8D', 'KC']); // dealer A K: blackjack
  tx(() => svc.bet({ tableId: 1, userId: ace, amount: '50', now }));
  const again = createBlackjackService(db, players);
  assert.equal(again._state(1).phase, 'betting');
  assert.equal(again._state(1).seats[0].bet, 50);
  // Dealer blackjack: settled straight away, before anyone acts.
  const a0 = cash(ace);
  players.transaction(() => again.bet({ tableId: 1, userId: bea, amount: '50', now }));
  const r = again._state(1);
  assert.equal(r.phase, 'done');
  assert.deepEqual(r.dealer, ['AH', 'KC']);
  assert.equal(r.seats[0].hands[0].result, 'lose');
  assert.equal(r.seats[1].hands[0].result, 'lose');
  assert.equal(cash(ace), a0);

  // Leaving during betting refunds the bet; leaving mid-hand stands it.
  now += DONE_MS + 1;
  again.tick(now); // runs its own transaction
  players.transaction(() => again.bet({ tableId: 1, userId: ace, amount: '40', now }));
  const before = cash(ace);
  assert.ok(players.transaction(() => again.leave({ tableId: 1, userId: ace, now })).left);
  assert.equal(cash(ace), before + 40);
  assert.equal(again._state(1).phase, 'idle', 'no bets left: betting closes');
  players.transaction(() => again.sit({ tableId: 1, userId: ace, now }));
  // Seats are kept in order: Ace took seat 0 again, Bea is in seat 1.
  again._state(1).shoe = [...Array(200).fill('2C'), ...['10S', '10H', '9C', '7S', '9D', '8C'].reverse()]; // Ace 17, Bea 19, dealer 9 8 = 17
  players.transaction(() => again.bet({ tableId: 1, userId: ace, amount: '10', now }));
  players.transaction(() => again.bet({ tableId: 1, userId: bea, amount: '10', now }));
  assert.deepEqual(again._state(1).turn, { seat: 0, hand: 0 });
  assert.ok(players.transaction(() => again.leave({ tableId: 1, userId: ace, now })).leaving);
  assert.deepEqual(again._state(1).turn, { seat: 1, hand: 0 }, 'it moves on at once');
  players.transaction(() => again.act({ tableId: 1, userId: bea, action: 'stand', now }));
  assert.equal(again._state(1).seats[0].hands[0].result, 'push', 'still settled');
  now += DONE_MS + 1;
  again.tick(now); // runs its own transaction
  assert.equal(again._state(1).seats[0], null, 'gone after the round');

  // Someone who stops looking at the table loses their seat between rounds.
  now += IDLE_MS + 1;
  again.tick(now); // runs its own transaction
  assert.equal(again._state(1).seats[1], null);
  assert.ok(again._state(1).log.some((l) => /Bea left the table/.test(l)));
});

test('blackjack through the app: lobby, table page, polling and forms', async () => {
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
    c.post = async (p, form = {}, { json = false } = {}) => {
      const token = (await c.request('/casino/blackjack/1')).text.match(/name="_csrf" value="([^"]+)"/)[1];
      const r = await c.request(p, { method: 'POST', form: { _csrf: token, ...form }, json });
      return json ? JSON.parse(r.text) : r;
    };
    return c;
  };
  const join = async (name) => {
    const c = client();
    const token = (await c.request('/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
    await c.request('/register', { method: 'POST', form: { _csrf: token, username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    const top = 2000 - db.prepare('SELECT cash FROM users WHERE id = ?').get(c.id).cash;
    db.prepare('UPDATE users SET level = 5, cash = 2000 WHERE id = ?').run(c.id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'test', 0)").run(c.id, top);
    return c;
  };
  try {
    const ace = await join('Ace');
    const bea = await join('Bea');
    assert.match((await ace.request('/casino')).text, /href="\/casino\/blackjack"/);
    let page = (await ace.request('/casino/blackjack')).text;
    for (const name of ['Mess Hall', 'Officers’ Lounge', 'War Room']) assert.ok(page.includes(name), name);
    assert.match(page, /\$1,000 to \$25,000 a hand/);

    // Watching, then sitting with the plain form (no JavaScript).
    page = (await ace.request('/casino/blackjack/1')).text;
    assert.match(page, /You’re watching/);
    assert.match(page, /Sit here/);
    let r = await ace.post('/casino/blackjack/1/sit', { seat: '2' });
    assert.equal(r.location, '/casino/blackjack/1#table');
    page = (await ace.request('/casino/blackjack/1')).text;
    assert.match(page, /bj-seat is-you/);
    assert.match(page, /Place your bet/);

    // The JavaScript table: polling answers "nothing new" until something changes.
    const v = Number(page.match(/data-version="(\d+)"/)[1]);
    let st = JSON.parse((await ace.request(`/casino/blackjack/1/state?v=${v}`, { json: true })).text);
    assert.equal(st.same, true);
    const j = await bea.post('/casino/blackjack/1/sit', { seat: '0' }, { json: true });
    assert.equal(j.ok, true);
    assert.match(j.html, /Bea/);
    st = JSON.parse((await ace.request(`/casino/blackjack/1/state?v=${v}`, { json: true })).text);
    assert.ok(st.version > v);
    assert.match(st.html, /Bea[\s\S]*Ace/, 'seat 0 then seat 2');

    // Bets through the API; errors come back with the table.
    let b = await ace.post('/casino/blackjack/1/bet', { amount: '9999' }, { json: true });
    assert.equal(b.ok, false);
    assert.match(b.error, /\$10 to \$500/);
    b = await ace.post('/casino/blackjack/1/bet', { amount: '50' }, { json: true });
    assert.equal(b.ok, true);
    assert.equal(b.phase, 'betting');
    assert.equal(b.player.cash, 1950);
    assert.match(b.html, /Betting is open/);
    b = await bea.post('/casino/blackjack/1/bet', { amount: '10' }, { json: true });
    assert.equal(b.phase === 'playing' || b.phase === 'done', true, 'everyone bet: dealt');
    if (b.phase === 'playing') assert.match(b.html, /pcard--back/, 'the hole card stays face down while players act');
    else assert.doesNotMatch(b.html, /pcard--back/);

    // Whoever's turn it is can act (or the round may already be over on naturals).
    const state = app.blackjack._state(1);
    if (state.phase === 'playing') {
      const turnUser = state.seats[state.turn.seat].userId === ace.id ? ace : bea;
      const other = turnUser === ace ? bea : ace;
      const bad = await other.post('/casino/blackjack/1/act', { action: 'stand', round: String(state.round) }, { json: true });
      assert.match(bad.error, /isn’t your turn/);
      const good = await turnUser.post('/casino/blackjack/1/act', { action: 'stand', round: String(state.round) }, { json: true });
      assert.equal(good.ok, true);
    }
    // The money adds up for anti-cheat.
    assert.equal(app.anti.runScan().newFlags, 0);

    // The War Room limit follows the admin setting; closing the casino stops new bets.
    tuning.set({ blackjackMaxBet: 2000 });
    assert.match((await ace.request('/casino/blackjack')).text, /\$1,000 to \$2,000 a hand/);
    tuning.set({ casinoOpen: false });
    const closed = await bea.post('/casino/blackjack/2/sit', {}, { json: true });
    assert.match(closed.error, /casino is closed|sitting at the Mess Hall/);
  } finally {
    tuning.reset();
    server.close();
  }
});
