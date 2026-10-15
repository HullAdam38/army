'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const training = require('../src/training');
const scouting = require('../src/scouting');
const combat = require('../src/combat');
const game = require('../src/game');
const admin = require('../src/admin');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const soldier = (o = {}) => ({
  id: 1, username: 'Alpha', level: 3, cash: 1000, bank_balance: 0, energy: 60, max_energy: 60,
  health: 120, max_health: 120, energy_updated_at: Date.now(), health_updated_at: Date.now(),
  stat_str: 0, stat_agi: 0, stat_end: 0, hospital_until: null, ...o,
});

test('training costs rise per point and stats are capped by level', () => {
  assert.deepEqual([0, 1, 10].map((p) => training.sessionCost(p)), [25, 30, 75]);
  assert.equal(training.sessionCost(10, 0.25), 56); // Firing Range level 5
  assert.equal(training.statCap(3), 30);

  const once = training.train(soldier(), 'strength');
  assert.deepEqual([once.sessions, once.cash, once.energy, once.player.stat_str], [1, 25, 5, 1]);
  const five = training.train(soldier(), 'agility', 5);
  assert.deepEqual([five.sessions, five.cash, five.player.stat_agi, five.player.energy], [5, 25 + 30 + 35 + 40 + 45, 5, 35]);

  assert.equal(training.train(soldier({ energy: 12 }), 'strength', 5).sessions, 2); // stops when energy runs out
  assert.equal(training.train(soldier({ cash: 60 }), 'strength', 5).sessions, 2); // …or cash
  assert.equal(training.train(soldier({ stat_str: 29 }), 'strength', 5).sessions, 1); // …or the cap
  assert.match(training.train(soldier({ stat_str: 30 }), 'strength').error, /limit for your level \(30\)/);
  assert.match(training.train(soldier({ energy: 2 }), 'strength').error, /needs 5 energy/);
  assert.match(training.train(soldier({ cash: 5 }), 'strength').error, /costs \$25/);
  assert.match(training.train(soldier(), 'charisma').error, /Pick Strength/);
  assert.match(training.train(soldier({ hospital_until: Date.now() + 60000 }), 'strength').error, /hospital/);

  const end = training.train(soldier(), 'endurance', 2).player;
  assert.deepEqual([end.stat_end, end.max_health, end.health], [2, 124, 124]);
});

test('training points become combat modifiers; dodge is capped', () => {
  const trained = soldier({ stat_str: 20, stat_agi: 50, stat_end: 40 });
  const plain = game.statsFor(3);
  const real = game.statsFor(3, [], trained);
  assert.equal(real.attack - plain.attack, 10);
  assert.ok(Math.abs(real.critChance - plain.critChance - 0.1) < 1e-9);
  assert.ok(Math.abs(real.dodge - 0.1) < 1e-9);
  assert.equal(real.armor, 20);
  assert.ok(combat.combatRating(real) > combat.combatRating(plain));
  assert.equal(game.statsFor(60, [], soldier({ stat_agi: 600 })).dodge, 0.25);
});

test('a dodge avoids the whole hit; no dodge roll when there is no dodge', () => {
  const attacker = combat.buildStats(1);
  const dodger = { ...combat.buildStats(1), dodge: 0.2 };
  assert.deepEqual(combat.rollHit(attacker, dodger, { rng: () => 0.1 }), { damage: 0, crit: false, mitigated: 0, dodged: true });
  let calls = 0;
  combat.rollHit(attacker, combat.buildStats(1), { rng: () => { calls += 1; return 0.5; } });
  assert.equal(calls, 2); // variance + crit only, exactly as before training existed
});

test('missions favour a stat, up to +10%', () => {
  const recon = game.MISSIONS.find((m) => m.id === 'forward-recon');
  assert.equal(recon.favours, 'agility');
  assert.equal(training.missionBonus(recon, soldier({ stat_agi: 25 })), 0.05);
  assert.equal(training.missionBonus(recon, soldier({ stat_agi: 500 })), 0.1);
  assert.equal(training.missionBonus(recon, soldier({ stat_str: 500 })), 0);
  const p = soldier();
  assert.ok(game.successChance(recon, soldier({ stat_agi: 25 })) > game.successChance(recon, p));
});

test('scouting price scales with the target and costs more against higher ranks', () => {
  assert.equal(scouting.scoutCost(soldier({ level: 5 }), soldier({ level: 5 })), 175);
  assert.equal(scouting.scoutCost(soldier({ level: 5 }), soldier({ level: 2 })), 100);
  assert.equal(scouting.scoutCost(soldier({ level: 5 }), soldier({ level: 10 })), Math.round(300 * 1.5));
  const me = soldier({ id: 1 });
  assert.match(scouting.scoutBlocker(me, me), /own record/);
  assert.match(scouting.scoutBlocker(soldier({ energy: 1 }), soldier({ id: 2 })), /3 energy/);
  assert.match(scouting.scoutBlocker(soldier({ cash: 10 }), soldier({ id: 2, username: 'Bravo' })), /Scouting Bravo costs \$125/);
  assert.equal(scouting.scoutBlocker(me, soldier({ id: 2 })), null);
});

test('admin "set level" keeps health earned through Endurance', () => {
  const out = admin.setLevel(soldier({ stat_end: 15 }), '5', 'testing');
  assert.equal(out.player.max_health, 100 + 40 + 30);
});

// ---- Through the app ----

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

function client(base) {
  const jar = new Map();
  return {
    async request(p, { method = 'GET', form } = {}) {
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
    },
    async post(p, form = {}) {
      const token = (await this.request('/hq')).text.match(/name="_csrf" value="([^"]+)"/)[1];
      return this.request(p, { method: 'POST', form: { _csrf: token, ...form } });
    },
  };
}

async function register(c, username) {
  const page = await c.request('/register');
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
}

const row = (db, name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);

test('training through the app: costs, ledger, cap message', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Trainee');
  let { res } = await c.post('/training/strength');
  assert.equal(res.headers.get('location'), '/training#stat-strength');
  assert.deepEqual([row(db, 'Trainee').stat_str, row(db, 'Trainee').cash, row(db, 'Trainee').energy], [1, 75, 45]);
  assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE reason = 'training'").get().delta_cash, -25);
  assert.equal(db.prepare("SELECT kind FROM actions ORDER BY id DESC").get().kind, 'training');

  db.prepare("UPDATE users SET cash = 5000, stat_str = 9 WHERE username = 'Trainee'").run();
  await c.post('/training/strength', { times: '5' });
  assert.equal(row(db, 'Trainee').stat_str, 10); // level 1 cap
  const { text } = await c.request('/training');
  assert.match(text, /Strength \+1, now 10/);
  assert.match(text, /At the limit for your level/);
  assert.match(text, /Your training is secret/);
});

test('training stays hidden; scouting reveals it to the scout only', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const spy = client(base);
  const target = client(base);
  const bystander = client(base);
  await register(spy, 'Spy');
  await register(target, 'Tank');
  await register(bystander, 'Bystander');
  db.prepare('UPDATE users SET level = 5, cash = 2000').run();
  db.prepare("UPDATE users SET stat_str = 37, stat_agi = 41, stat_end = 23 WHERE username = 'Tank'").run();
  const gearRating = combat.combatRating(game.statsFor(5));
  const trueRating = combat.combatRating(game.statsFor(5, [], row(db, 'Tank')));
  assert.ok(trueRating > gearRating);

  // Before scouting: only the gear rating, no stat values.
  let { text } = await spy.request('/profile/Tank');
  assert.match(text, new RegExp(`Gear rating</span>\\s*<span class="combat-profile__value">${gearRating}<`));
  assert.doesNotMatch(text, /Strength<\/dt><dd>37/);
  assert.match(text, /Gather intel · \$175/);
  ({ text } = await spy.request('/players'));
  assert.match(text, new RegExp(`data-label="Rating">${gearRating}<`));
  assert.doesNotMatch(text, new RegExp(`>${trueRating}<`));

  // Tank sees their own training.
  ({ text } = await target.request('/profile/Tank'));
  assert.match(text, /Your training \(only you can see this\)/);
  assert.match(text, /Strength<\/dt><dd>37/);

  // Scout: pay, see the real numbers.
  const { res } = await spy.post('/scout/Tank');
  assert.equal(res.headers.get('location'), '/profile/Tank#intel');
  assert.equal(row(db, 'Spy').cash, 2000 - 175);
  assert.equal(row(db, 'Spy').energy, 47);
  ({ text } = await spy.request('/profile/Tank'));
  assert.match(text, /Intel on Tank acquired for \$175/);
  assert.match(text, new RegExp(`True combat rating</dt><dd>${trueRating}<`));
  assert.match(text, /Strength<\/dt><dd>37/);
  assert.match(text, /Agility<\/dt><dd>41/);
  assert.match(text, /Scout again/);

  // The target is told, anonymously; nobody else sees the intel.
  const note = db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC').get(row(db, 'Tank').id).message;
  assert.match(note, /Enemy reconnaissance detected/);
  assert.doesNotMatch(note, /Spy/);
  ({ text } = await bystander.request('/profile/Tank'));
  assert.doesNotMatch(text, /True combat rating/);
  assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE reason = 'scout'").get().delta_cash, -175);
});
