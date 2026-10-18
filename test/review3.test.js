'use strict';

// Regression tests for the third security review (raids, the theatre, support,
// and the casino). Each test names the problem it guards against.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createPlayerRepo } = require('../src/players');
const { createUnitRepo } = require('../src/units-repo');
const { createRaidService } = require('../src/raid-service');
const { createSupportService } = require('../src/support-service');
const { createBlackjackService } = require('../src/blackjack-service');

function world() {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const make = (name, extra = '') => {
    const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, cash, energy, max_energy, health, max_health, energy_updated_at, health_updated_at, created_at${extra ? ', is_admin' : ''})
      VALUES (?, ?, 'x', 10, 1000, 95, 95, 190, 190, ?, ?, 0${extra ? ', 1' : ''})`).run(name, `${name}@x.com`, Date.now(), Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 1000, 0, 'test', 0)").run(id);
    return id;
  };
  const cash = (id) => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
  return { db, players, make, cash };
}

test('raids: removing a striker before the final blow doesn’t take their share', () => {
  const { db, players, make, cash } = world();
  const units = createUnitRepo(db);
  const raids = createRaidService(db, players, units);
  const cmd = make('Cmdr');
  const top = make('TopGun');
  const pvt = make('Private1');
  const unitId = Number(db.prepare("INSERT INTO units (name, tag, treasury, created_at) VALUES ('Iron Wolves', 'IW', 100000, 0)").run().lastInsertRowid);
  for (const [id, role] of [[cmd, 'leader'], [top, 'member'], [pvt, 'member']]) db.prepare('UPDATE users SET unit_id = ?, unit_role = ? WHERE id = ?').run(unitId, role, id);
  const me = players.findById(cmd);
  players.transaction(() => raids.launch({ unit: units.findById(unitId), role: 'leader', me, strongholdId: 'outpost' }));
  const raid = () => db.prepare('SELECT * FROM raids WHERE unit_id = ?').get(unitId);
  let now = Date.now();
  players.transaction(() => raids.strike({ unitId, userId: top, now, rng: () => 0.99 }));
  now += 1000;
  players.transaction(() => raids.strike({ unitId, userId: pvt, now, rng: () => 0 }));
  // The Commander removes the top striker, then lands the final blow.
  db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL WHERE id = ?').run(top);
  db.prepare('UPDATE raids SET hp = 1 WHERE id = ?').run(raid().id);
  const before = cash(top);
  players.transaction(() => raids.strike({ unitId, userId: cmd, now: now + 1000, rng: () => 0 }));
  assert.equal(raid().status, 'won');
  const share = db.prepare('SELECT cash FROM raid_hits WHERE user_id = ?').get(top).cash;
  assert.ok(share > 0, 'the removed striker is still paid');
  assert.equal(cash(top), before + share);
});

test('support: rapid replies on a waiting ticket don’t keep alerting admins', () => {
  const { db, players, make } = world();
  const alerts = [];
  const support = createSupportService(db, players, { alertStaff: (id, msg) => alerts.push(msg) });
  make('Boss', 'admin');
  const rook = players.findById(make('Rook'));
  let now = Date.now();
  const { ticket } = players.transaction(() => support.open({ me: rook, category: 'bug', subject: 'Something broke', body: 'Here is what happened in detail.', now }));
  assert.equal(alerts.length, 1, 'a new ticket alerts');
  for (let i = 1; i <= 5; i += 1) {
    now += 11 * 1000; // past the reply cooldown each time
    players.transaction(() => support.playerReply({ me: rook, ticketId: ticket.id, body: `More detail ${i}`, now }));
  }
  assert.equal(alerts.length, 1, 'replies on a ticket already waiting for HQ stay quiet');
  now += 16 * 60 * 1000;
  players.transaction(() => support.playerReply({ me: rook, ticketId: ticket.id, body: 'Still waiting', now }));
  assert.equal(alerts.length, 2, 'after 15 minutes it alerts again');
  // Once HQ has answered, the player's next reply always alerts.
  players.transaction(() => support.staffReply({ admin: { id: 1 }, ticketId: ticket.id, body: 'Looking into it', now }));
  now += 11 * 1000;
  players.transaction(() => support.playerReply({ me: rook, ticketId: ticket.id, body: 'Thanks', now }));
  assert.equal(alerts.length, 3);
});

test('blackjack: a change that fails leaves the table as it was saved', () => {
  const { db, players, make, cash } = world();
  const bj = createBlackjackService(db, players);
  const ace = make('Ace');
  let now = 1_000_000;
  players.transaction(() => bj.sit({ tableId: 1, userId: ace, now }));
  // Ace 10 9 (19); dealer 9 7 draws a 2 (18). Ace stands and wins, so there's a payout to fail.
  bj._state(1).shoe = [...Array(200).fill('2C'), ...['10S', '9C', '9H', '7D'].reverse()];
  players.transaction(() => bj.bet({ tableId: 1, userId: ace, amount: '100', now }));
  now += 16 * 1000;
  bj.tick(now); // the betting window closes and the cards are dealt
  assert.equal(bj._state(1).phase, 'playing');
  const cashBefore = cash(ace);
  // Make the payout fail part-way: the database rolls back, and so must the table.
  const realSave = players.save;
  players.save = () => { throw new Error('disk full'); };
  assert.throws(() => players.transaction(() => bj.act({ tableId: 1, userId: ace, action: 'stand', now })), /disk full/);
  players.save = realSave;
  assert.equal(bj._state(1).phase, 'playing', 'not marked as settled');
  assert.deepEqual(bj._state(1).turn, { seat: 0, hand: 0 });
  assert.equal(cash(ace), cashBefore);
  // Trying again works, and pays exactly once.
  players.transaction(() => bj.act({ tableId: 1, userId: ace, action: 'stand', now }));
  assert.equal(bj._state(1).phase, 'done');
  const won = bj._state(1).seats[0].hands[0].payout;
  assert.equal(cash(ace), cashBefore + won);
});
