'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const medals = require('../src/medals');
const { createMedalService } = require('../src/medal-service');
const { createPlayerRepo } = require('../src/players');
const { createDailyService } = require('../src/daily-service');
const { createUnitRepo } = require('../src/units-repo');
const { createWarService } = require('../src/war-service');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

function setup() {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const now = Date.now();
  const add = (name, extra = '') => Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at)
    VALUES (?, ?, 'x', ?, ?, ?)`).run(name, `${name}@x.com`, now, now, now).lastInsertRowid);
  return { db, players, svc: createMedalService(db, players), add };
}

test('tiers, progress and pins', () => {
  const op = medals.MEDALS_BY_ID.get('operator');
  assert.deepEqual([0, 24, 25, 99, 100, 500, 9999].map((v) => medals.tierFor(op, v)), [0, 0, 1, 1, 2, 3, 3]);
  const fresh = medals.newTiers({ missions: 120 }, new Map([['operator', 1]]));
  assert.deepEqual(fresh.map((f) => `${f.medal.id}:${f.tier.key}`), ['operator:silver']);
  assert.equal(medals.medalView(op, 60, 1).pct, 47); // 35 of the 75 between bronze and silver
  assert.equal(medals.medalView(op, 600, 3).pct, 100);
  const owned = new Map([['operator', 1], ['combat', 2], ['drill', 1], ['merit', 1]]);
  assert.deepEqual(medals.parsePins(['combat', 'nope', 'victory', 'combat', 'operator', 'drill', 'merit'], owned), ['combat', 'operator', 'drill']);
  assert.equal(new Set(medals.MEDALS.map((m) => m.id)).size, medals.MEDALS.length);
  for (const m of medals.MEDALS) assert.ok(m.thresholds[0] < m.thresholds[1] && m.thresholds[1] < m.thresholds[2], m.id);
});

test('awards reached tiers once, pays through the ledger, cascades level-ups', () => {
  const { db, svc, add } = setup();
  const id = add('Alpha');
  db.prepare('UPDATE users SET missions_completed = 120, stat_str = 20, stat_agi = 10 WHERE id = ?').run(id);
  const won = svc.check(id).map((w) => `${w.medal.id}:${w.tier.key}`).sort();
  assert.deepEqual(won, ['drill:bronze', 'operator:bronze', 'operator:silver']);
  assert.deepEqual(svc.check(id), []); // nothing twice
  const cash = db.prepare("SELECT SUM(delta_cash) AS n FROM ledger WHERE user_id = ? AND reason = 'medal'").get(id).n;
  assert.equal(cash, 250 + 1000 + 250);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'medal'").get(id).n, 3);

  // Reaching level 10 through medal XP earns the Commission medal on the next pass.
  const b = add('Bravo');
  db.prepare('UPDATE users SET level = 9, xp = ?, missions_completed = 500 WHERE id = ?').run(Math.round(100 * Math.pow(9, 1.6)) - 10, b);
  const cascade = svc.check(b).map((w) => w.medal.id);
  assert.ok(cascade.includes('commission'), cascade.join());
});

test('PvP medals ignore fights that paid nothing or were reversed', () => {
  const { db, svc, add } = setup();
  const a = add('Attacker');
  const d = add('Defender');
  const fight = db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, cash_taken, attacker_xp, defender_xp, report, created_at, reversed_at) VALUES (?, ?, ?, ?, 0, ?, ?, '{}', 0, ?)");
  for (let i = 0; i < 6; i += 1) fight.run(a, d, 1, 1, 20, 0, null); // paid wins with knockouts
  for (let i = 0; i < 6; i += 1) fight.run(a, d, 1, 1, 0, 0, null); // linked accounts: no XP
  for (let i = 0; i < 6; i += 1) fight.run(a, d, 1, 1, 20, 0, Date.now()); // reversed by an admin
  for (let i = 0; i < 5; i += 1) fight.run(d, a, 0, 0, 0, 10, null); // a holds off d
  const m = svc.metrics(a);
  assert.deepEqual([m.pvpWins, m.knockouts, m.defenses], [6, 6, 5]);
  assert.deepEqual(svc.check(a).map((w) => w.medal.id).sort(), ['ironwall', 'knockout']);
});

test('daily orders and won wars feed their medals', () => {
  const { db, players, svc, add } = setup();
  const id = add('Orderly');
  const daily = createDailyService(db, players);
  const now = Date.parse('2026-05-10T12:00:00Z');
  for (const o of daily.ordersFor(players.findById(id), now)) {
    daily.progress(id, o.type, o.target, { param: o.param, now });
    players.transaction(() => daily.claimOrder(players.findById(id), o.slot, now));
  }
  assert.equal(svc.metrics(id).orders, 3);

  const unitRepo = createUnitRepo(db);
  const wars = createWarService(db, players, unitRepo);
  const u1 = unitRepo.create({ name: 'Iron Wolves', tag: 'IW', description: '', leaderId: id });
  const vet = add('Veteran');
  const merc = add('Merc');
  const foe = add('Foe');
  const u2 = unitRepo.create({ name: 'Steel Rain', tag: 'SR', description: '', leaderId: foe });
  db.prepare('UPDATE users SET unit_joined_at = 0 WHERE id IN (?, ?)').run(id, foe);
  db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member', unit_joined_at = 0 WHERE id = ?").run(u1, vet);
  const start = Date.now() - 1000;
  db.prepare("INSERT INTO unit_wars (attacker_unit_id, defender_unit_id, attacker_name, attacker_tag, defender_name, defender_tag, stake, attacker_score, defender_score, started_at, ends_at) VALUES (?, ?, 'Iron Wolves', 'IW', 'Steel Rain', 'SR', 2500, 3, 1, ?, ?)").run(u1, u2, start, start + 10);
  db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member', unit_joined_at = ? WHERE id = ?").run(u1, Date.now(), merc); // joined mid-war
  assert.equal(wars.finishDue(), 1);
  const won = (uid) => db.prepare('SELECT wars_won FROM users WHERE id = ?').get(uid).wars_won;
  assert.deepEqual([won(id), won(vet), won(merc), won(foe)], [1, 1, 0, 0]);
  assert.ok(svc.check(vet).some((w) => w.medal.id === 'victory'));
});

test('medal case page, pins and profile rack', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form,
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text() };
  };
  const csrf = async (from) => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  try {
    const reg = new URLSearchParams({ _csrf: await csrf('/register'), username: 'Decorated', email: 'd@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' });
    await request('/register', { method: 'POST', form: reg });
    const id = db.prepare("SELECT id FROM users WHERE username = 'Decorated'").get().id;
    let page = (await request('/medals')).text;
    assert.match(page, /0<small>\/57<\/small>/);
    assert.match(page, /Field Operator/);

    db.prepare('UPDATE users SET missions_completed = 30, stat_str = 40, streak_best = 8, orders_completed = 20 WHERE id = ?').run(id);
    page = (await request('/medals')).text; // viewing the case awards what's due
    assert.match(page, /4<small>\/57<\/small>/);
    assert.match((await request('/hq')).text, /4 medals earned/);

    const pins = new URLSearchParams({ _csrf: await csrf('/medals') });
    for (const p of ['merit', 'victory', 'service']) pins.append('pin', p); // victory isn't held
    await request('/medals/pins', { method: 'POST', form: pins });
    assert.equal(db.prepare('SELECT pinned_medals FROM users WHERE id = ?').get(id).pinned_medals, 'merit,service');
    const profile = (await request('/profile/Decorated')).text;
    assert.match(profile, /Featured medals/);
    assert.ok(profile.indexOf('Bronze Order of Merit') < profile.indexOf('Bronze Long Service'), 'pinned order kept');
    assert.match(profile, /medal-rack/);
  } finally {
    server.close();
  }
});
