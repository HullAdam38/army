'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const events = require('../src/events');
const { createEventService } = require('../src/event-service');
const { createDailyService } = require('../src/daily-service');
const { createPlayerRepo } = require('../src/players');
const { createBountyService } = require('../src/bounty-service');
const bounties = require('../src/bounties');
const rules = require('../src/anticheat/rules');
const game = require('../src/game');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const HOUR = 3600 * 1000;

test('event validation and combined effects', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const ok = events.validateEvent({ type: 'double_xp', start: 'now', hours: '24' }, now);
  assert.deepEqual([ok.title, ok.startsAt, ok.endsAt], ['Double XP', now, now + 24 * HOUR]);
  const later = events.validateEvent({ type: 'payday', title: '  Founders   Weekend ', start: 'later', startAt: '2026-10-17T18:00', hours: 48 }, now);
  assert.deepEqual([later.title, later.startsAt], ['Founders Weekend', Date.parse('2026-10-17T18:00:00Z')]);
  assert.match(events.validateEvent({ type: 'nope', hours: 1 }, now).error, /Pick an event type/);
  assert.match(events.validateEvent({ type: 'payday', hours: 0 }, now).error, /1–168 hours/);
  assert.match(events.validateEvent({ type: 'payday', hours: 200 }, now).error, /1–168 hours/);
  assert.match(events.validateEvent({ type: 'payday', hours: 2, start: 'later', startAt: 'tomorrow' }, now).error, /start date/);
  assert.match(events.validateEvent({ type: 'payday', hours: 2, start: 'later', startAt: '2026-10-14T10:00' }, now).error, /already passed/);
  assert.match(events.validateEvent({ type: 'payday', hours: 2, start: 'later', startAt: '2027-03-01T10:00' }, now).error, /60 days/);

  assert.deepEqual(events.effectsOf([]), { ...events.NEUTRAL });
  const all = events.effectsOf(Object.keys(events.TYPES));
  assert.deepEqual(all, { xpMult: 2, cashMult: 1.5, supplyMult: 2, ordersMult: 2, warPointsMult: 2, warPrizeMult: 1.5, bountyFeeFree: true });
  assert.equal(events.MAX_CASH_MULT, 1.5);
});

test('event service: schedule, overlap rules, live effects, one announcement, cancel and end', () => {
  const db = openDatabase(':memory:');
  const svc = createEventService(db);
  const now = Date.now();
  db.prepare("INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at) VALUES ('A', 'a@x', 'x', 0, 0, 0), ('B', 'b@x', 'x', 0, 0, 0)").run();

  const xp = svc.create({ type: 'double_xp', start: 'now', hours: 2 }, 1, now);
  assert.ok(xp.id);
  assert.match(svc.create({ type: 'double_xp', start: 'now', hours: 1 }, 1, now).error, /already overlaps/);
  assert.ok(svc.create({ type: 'payday', start: 'now', hours: 1 }, 1, now).id); // different types can overlap
  const later = new Date(now + 5 * HOUR).toISOString().slice(0, 16);
  const soon = svc.create({ type: 'double_xp', start: 'later', startAt: later, hours: 1 }, 1, now);
  assert.ok(soon.id, 'same type is fine once the first has ended');

  const fx = svc.effects(now);
  assert.equal(fx.xpMult, 2);
  assert.equal(fx.cashMult, 1.5);
  assert.equal(svc.live(now).length, 2);
  assert.equal(svc.upcoming(now).length, 1);

  assert.equal(svc.announce(now), 2);
  assert.equal(svc.announce(now), 0); // never twice
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'event'").get().n, 4); // 2 events × 2 players

  assert.equal(svc.endNow(xp.id, now + 1000), true);
  assert.equal(svc.effects(now + 2000).xpMult, 1);
  assert.equal(svc.cancel(soon.id, now), true);
  assert.equal(svc.upcoming(now).length, 0);
  assert.equal(svc.cancel(soon.id, now), false);
  assert.equal(svc.maxCashMultSince(now - 24 * HOUR, now + 3 * HOUR), 1.5);
});

test('events change missions, daily rewards, bounties and the anti-cheat cap', () => {
  const now = Date.now();
  const p = { id: 1, level: 20, xp: 0, cash: 0, energy: 200, max_energy: 200, health: 300, max_health: 300, energy_updated_at: now, health_updated_at: now, missions_completed: 0, missions_failed: 0, stat_str: 0, stat_agi: 0, stat_end: 0, hospital_until: null };
  const plain = game.runMission('night-raid', { ...p }, { now, rng: () => 0 }).result;
  const fx = events.effectsOf(['double_xp', 'payday']);
  const boosted = game.runMission('night-raid', { ...p }, { now, rng: () => 0, xpBonus: fx.xpMult - 1, cashBonus: fx.cashMult - 1 }).result;
  assert.equal(boosted.xp, plain.xp * 2);
  assert.equal(boosted.cash, Math.round(plain.cash * 1.5));

  // Supply Surge doubles supply drops and order rewards.
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level)
                                VALUES ('S', 's@x', 'x', ?, ?, ?, 10)`).run(now, now, now).lastInsertRowid);
  const surge = createDailyService(db, players, { effects: () => events.effectsOf(['supply_surge']) });
  const drop = players.transaction(() => surge.claimSupplyDrop(players.findById(id), now));
  assert.equal(drop.cash, (25 + 15 * 10) * 2);
  const order = surge.ordersFor(players.findById(id), now)[0];
  surge.progress(id, order.type, order.target, { param: order.param, now });
  const claimed = players.transaction(() => surge.claimOrder(players.findById(id), order.slot, now));
  assert.equal(claimed.order.reward_cash, order.reward_cash * 2);

  // Most Wanted: no bounty fee.
  assert.deepEqual(bounties.parseAmount('1000', { feeFree: true }), { amount: 1000, fee: 0, total: 1000 });
  const t = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level) VALUES ('T', 't@x', 'x', 0, 0, 0, 5)`).run().lastInsertRowid);
  db.prepare('UPDATE users SET cash = 5000 WHERE id = ?').run(id);
  const free = createBountyService(db, players, () => false, { effects: () => events.effectsOf(['most_wanted']) });
  assert.equal(players.transaction(() => free.place({ placerId: id, target: players.findById(t), amountInput: '1000' })).fee, 0);

  // The energy cap allows for Payday (and rank perks), so honest players aren't flagged.
  const base = rules.missionCashCap({ missions: game.MISSIONS, level: 20, maxEnergy: 145, refills: 0, energyRegenMs: game.ENERGY_REGEN_MS });
  const payday = rules.missionCashCap({ missions: game.MISSIONS, level: 20, maxEnergy: 145, refills: 0, energyRegenMs: game.ENERGY_REGEN_MS, cashMult: 1.5 });
  assert.ok(payday >= base * 1.49);
});

test('events through the app: admin scheduling, banner, events page, doubled mission XP', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
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
    const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
    return { request, csrf, post };
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return c;
  };
  try {
    const boss = await enlist('Overseer');
    const grunt = await enlist('Grunt');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Overseer'").run();

    assert.equal((await grunt.request('/admin/events')).res.status, 404);
    assert.equal((await grunt.post('/admin/events', { type: 'double_xp', start: 'now', hours: 2 })).res.status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);

    // A bad form keeps the draft.
    await boss.post('/admin/events', { type: 'double_xp', start: 'now', hours: 500, title: 'Too long', message: '[b]hi[/b]' });
    assert.match((await boss.request('/admin/events')).text, /value="Too long"/);

    await boss.post('/admin/events', { type: 'double_xp', start: 'now', hours: 2, title: 'Founders Weekend', message: '[b]Thanks for enlisting![/b] <script>x</script>' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'event'").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event'").get().n, 1);

    const hq = (await grunt.request('/hq')).text;
    assert.match(hq, /class="event-banner"[\s\S]*Founders Weekend<\/strong> is live: Missions and operations pay double XP/);
    const page = (await grunt.request('/events')).text;
    assert.match(page, /<strong>Thanks for enlisting!<\/strong>/);
    assert.doesNotMatch(page, /<script>x/);

    // Double XP shows in real mission results: a successful patrol (normally 8–12 XP) pays 16–24.
    let gained = null;
    for (let i = 0; i < 10 && gained === null; i += 1) {
      db.prepare("UPDATE users SET energy = max_energy, health = max_health WHERE username = 'Grunt'").run();
      await grunt.post('/missions/perimeter-patrol');
      const log = db.prepare("SELECT message FROM activity WHERE kind = 'success' ORDER BY id DESC").get();
      if (log) gained = Number(log.message.match(/\+(\d+) XP/)[1]);
    }
    assert.ok(gained >= 16 && gained <= 24, `double XP applied (gained ${gained})`);

    // End it: the banner goes.
    const id = db.prepare('SELECT id FROM events').get().id;
    await boss.post(`/admin/events/${id}/end`);
    assert.doesNotMatch((await grunt.request('/hq')).text, /class="event-banner"/);

    // Schedule one ahead: shows as "coming up" on HQ.
    const ahead = new Date(Date.now() + 3 * HOUR).toISOString().slice(0, 16);
    await boss.post('/admin/events', { type: 'payday', start: 'later', startAt: ahead, hours: 24 });
    assert.match((await grunt.request('/hq')).text, /Coming up: <a href="\/events"><strong>Payday<\/strong>/);
  } finally {
    server.close();
  }
});

test('War Season doubles war points', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const { createUnitRepo } = require('../src/units-repo');
  const { createWarService } = require('../src/war-service');
  const unitRepo = createUnitRepo(db);
  const add = (n) => Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at) VALUES (?, ?, 'x', 0, 0, 0)`).run(n, `${n}@x`).lastInsertRowid);
  const a = add('A');
  const d = add('D');
  const u1 = unitRepo.create({ name: 'Iron Wolves', tag: 'IW', description: '', leaderId: a });
  const u2 = unitRepo.create({ name: 'Steel Rain', tag: 'SR', description: '', leaderId: d });
  const now = Date.now();
  db.prepare('UPDATE users SET unit_joined_at = ?').run(now - 60_000); // both joined before the war
  db.prepare("INSERT INTO unit_wars (attacker_unit_id, defender_unit_id, attacker_name, attacker_tag, defender_name, defender_tag, stake, started_at, ends_at) VALUES (?, ?, 'Iron Wolves', 'IW', 'Steel Rain', 'SR', 2500, ?, ?)").run(u1, u2, now - 1000, now + HOUR);
  const battle = Number(db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, report, created_at) VALUES (?, ?, 1, 1, '{}', ?)").run(a, d, now).lastInsertRowid);
  const svc = createWarService(db, players, unitRepo, { effects: () => events.effectsOf(['war_season']) });
  const scored = svc.recordFight({ battleId: battle, a: players.findById(a), d: players.findById(d), attackerWon: true, knockout: true, fullRewards: true, now });
  assert.equal(scored.points, 4); // knockout 2 × War Season
  assert.equal(db.prepare('SELECT attacker_score FROM unit_wars').get().attacker_score, 4);
});
