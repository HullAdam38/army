'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const objectives = require('../src/objectives');
const target = require('../src/target');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test.afterEach(() => tuning.reset());

test('objective rules: weeks, picks and scaling', () => {
  // Weeks run Monday to Monday, UTC.
  assert.equal(objectives.weekKey(Date.parse('2026-10-17T12:00:00Z')), '2026-10-12'); // a Saturday
  assert.equal(objectives.weekKey(Date.parse('2026-10-12T00:00:00Z')), '2026-10-12');
  assert.equal(objectives.weekKey(Date.parse('2026-10-11T23:59:59Z')), '2026-10-05'); // Sunday night
  assert.equal(objectives.weekEnds('2026-10-12'), Date.parse('2026-10-19T00:00:00Z'));

  // Three different objectives per unit, the same every time for a given week.
  const a = objectives.generate(7, '2026-10-12', { members: 10, avgLevel: 20 });
  assert.equal(a.length, 3);
  assert.equal(new Set(a.map((o) => o.type)).size, 3);
  assert.deepEqual(objectives.generate(7, '2026-10-12', { members: 10, avgLevel: 20 }), a);
  // Units get different mixes across weeks.
  const mixes = new Set();
  for (let u = 1; u <= 20; u += 1) mixes.add(objectives.generate(u, '2026-10-12', { members: 5, avgLevel: 10 }).map((o) => o.type).sort().join());
  assert.ok(mixes.size >= 4);

  // Targets and rewards grow with the unit; tiny units count as three members.
  const target10 = (type, m, level = 20) => objectives.TYPES_BY_ID.get(type).target(Math.max(3, m), level);
  assert.equal(target10('missions', 10), 250);
  assert.equal(target10('missions', 1), 75);
  assert.equal(target10('donations', 10, 20), 31000);
  assert.equal(a[0].rewardCash, 36600); // 12 deployment-hours × 10 members at level 20
  assert.equal(objectives.memberXp(20), 180);
  tuning.set({ unitObjectiveRewardMult: 0 });
  assert.equal(objectives.generate(7, '2026-10-12', { members: 10, avgLevel: 20 })[0].rewardCash, 0);
  assert.match(objectives.describe({ type: 'donations', target: 31000 }), /Donate \$31,000 to the treasury/);
});

test('high-value target rules', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const day = '2026-10-17';
  const first = target.pick(list, day);
  assert.equal(target.pick(list, day), first); // stable for the day
  assert.notEqual(target.pick(list, day, first.id).id, first.id); // never yesterday's again
  assert.equal(target.pick([{ id: 9 }], day, 9).id, 9); // unless they're the only one
  assert.equal(target.pick([], day), null);
  assert.deepEqual(target.bonus(30), { cash: 2670, xp: 260 });
  assert.equal(target.defenseBonus(30), 890);
  tuning.set({ targetBonusMult: 2 });
  assert.deepEqual(target.bonus(30), { cash: 5340, xp: 520 });
});

test('unit objectives and the high-value target through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  try {
    const lead = await join('Lead');
    const grunt = await join('Grunt');
    const idle = await join('Idle');
    const outsider = await join('Outsider');
    // Level them up with cash to spend, keeping the ledger in step with their balances.
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) SELECT id, 100000 - cash, 0, 'test-setup', ? FROM users").run(Date.now());
    db.prepare('UPDATE users SET level = 10, cash = 100000, energy = 95, max_energy = 95, health = 190, max_health = 190').run();
    const unitId = Number(db.prepare("INSERT INTO units (name, tag, founded_by, created_at) VALUES ('Iron Wolves', 'IW', ?, ?)").run(lead.id, Date.now()).lastInsertRowid);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member', unit_joined_at = ? WHERE id IN (?, ?, ?)").run(unitId, Date.now(), lead.id, grunt.id, idle.id);
    db.prepare("UPDATE users SET unit_role = 'leader' WHERE id = ?").run(lead.id);

    // The unit page sets this week's three objectives and shows them.
    let page = (await lead.request(`/units/${unitId}`)).text;
    assert.match(page, /Weekly objectives/);
    const rows = db.prepare('SELECT * FROM unit_objectives WHERE unit_id = ? ORDER BY slot').all(unitId);
    assert.equal(rows.length, 3);
    for (const o of rows) assert.ok(page.includes(objectives.describe(o)), o.type);

    // Real actions count: a mission win, and a donation.
    const before = (type) => db.prepare('SELECT progress FROM unit_objectives WHERE unit_id = ? AND type = ?').get(unitId, type);
    // Fix this week's mix so the test knows what to expect.
    [['missions', 1000], ['donations', 100000], ['pvp', 50]].forEach(([t, goal], slot) => db.prepare('UPDATE unit_objectives SET type = ?, target = ? WHERE unit_id = ? AND slot = ?').run(t, goal, unitId, slot));
    for (let i = 0; i < 6 && !before('missions').progress; i += 1) {
      await grunt.request('/missions/perimeter-patrol', { method: 'POST', form: { _csrf: await grunt.csrf('/missions') } });
    }
    assert.ok(before('missions').progress >= 1, 'a mission win counts');
    await grunt.request(`/units/${unitId}/donate`, { method: 'POST', form: { _csrf: await grunt.csrf(`/units/${unitId}`), amount: '2500' } });
    assert.equal(before('donations').progress, 2500);

    // Close to the target, everyone hears once; completing pays the treasury and XP to helpers only.
    const o = db.prepare("SELECT * FROM unit_objectives WHERE unit_id = ? AND type = 'missions'").get(unitId);
    db.prepare("UPDATE unit_objectives SET target = 10, progress = 7 WHERE unit_id = ? AND type = 'missions'").run(unitId);
    app.objectives.track(lead.id, 'missions', 1);
    app.objectives.track(lead.id, 'missions', 0); // ignored
    const nudges = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'unit' AND message LIKE '%of the way%'").get().n;
    assert.equal(nudges, 3);
    app.objectives.track(lead.id, 'missions', 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'unit' AND message LIKE '%of the way%'").get().n, 3);
    const treasury = db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury;
    const xpBefore = { lead: user(lead.id), grunt: user(grunt.id), idle: user(idle.id) };
    app.objectives.track(grunt.id, 'missions', 5);
    const done = db.prepare("SELECT * FROM unit_objectives WHERE unit_id = ? AND type = 'missions'").get(unitId);
    assert.ok(done.completed_at);
    assert.equal(done.progress, 10);
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury, treasury + o.reward_cash);
    const gained = (who, name) => (user(who.id).level - xpBefore[name].level) * 1e9 + (user(who.id).xp - xpBefore[name].xp);
    assert.ok(gained(lead, 'lead') > 0 && gained(grunt, 'grunt') > 0, 'helpers get XP');
    assert.equal(gained(idle, 'idle'), 0, 'members who didn’t help get none');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND message LIKE '%objective complete%'").get(idle.id).n, 1);
    assert.match(db.prepare("SELECT message FROM unit_log WHERE unit_id = ? AND kind = 'objective'").get(unitId).message, /paid into the treasury/);
    // Done is done: more progress changes nothing.
    app.objectives.track(grunt.id, 'missions', 5);
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury, treasury + o.reward_cash);
    // Outsiders' play doesn't count for the unit.
    app.objectives.track(outsider.id, 'donations', 1000);
    assert.equal(before('donations').progress, 2500);
    page = (await lead.request(`/units/${unitId}`)).text;
    assert.match(page, /Top contributors this week/);
    assert.match(page, /objective is-done/);

    // ----- High-value target -----
    db.prepare('UPDATE users SET last_seen_at = ?').run(Date.now());
    db.prepare('UPDATE users SET level = 30 WHERE id = ?').run(outsider.id); // the highest level, so in the pool
    const t = app.target.today();
    assert.ok(t);
    const targetId = t.user_id;
    assert.equal(app.target.today().user_id, targetId); // fixed for the day
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'target'").get(targetId).n, 1);
    const targetName = user(targetId).username;
    const hunter = [lead, grunt, idle, outsider].find((c) => c.id !== targetId);
    page = (await hunter.request('/players')).text;
    assert.match(page, /High-value target/);
    assert.ok(page.includes(`/attack/${targetName}`));
    assert.match((await hunter.request(`/profile/${targetName}`)).text, /Today’s high-value target/);
    assert.match((await hunter.request('/hq')).text, /class="card hvt/);

    // Beating them pays once per attacker per day, through its own ledger reason.
    const cashBefore = user(hunter.id).cash;
    const b = target.bonus(user(targetId).level);
    assert.deepEqual(app.target.afterFight({ battleId: 1, attackerId: hunter.id, defenderId: targetId, attackerWon: true, rewards: { attacker: 1, defender: 1 } }), { claim: b });
    assert.equal(user(hunter.id).cash, cashBefore + b.cash);
    assert.equal(db.prepare("SELECT SUM(delta_cash) AS n FROM ledger WHERE user_id = ? AND reason = 'target-bonus'").get(hunter.id).n, b.cash);
    assert.equal(app.target.afterFight({ battleId: 2, attackerId: hunter.id, defenderId: targetId, attackerWon: true, rewards: { attacker: 1, defender: 1 } }), null);
    // Linked accounts or repeat wins (reduced rewards) don't collect.
    const other = [lead, grunt, idle, outsider].find((c) => c.id !== targetId && c.id !== hunter.id);
    assert.equal(app.target.afterFight({ battleId: 3, attackerId: other.id, defenderId: targetId, attackerWon: true, rewards: { attacker: 0, defender: 0 } }), null);
    // Fights against anyone else don't count.
    assert.equal(app.target.afterFight({ battleId: 4, attackerId: other.id, defenderId: hunter.id, attackerWon: true, rewards: { attacker: 1, defender: 1 } }), null);
    // Accounts that share a device or network never collect, win or lose.
    assert.equal(app.target.afterFight({ battleId: 5, attackerId: other.id, defenderId: targetId, attackerWon: true, rewards: { attacker: 1, defender: 1 }, linked: true }), null);
    assert.equal(app.target.afterFight({ battleId: 6, attackerId: other.id, defenderId: targetId, attackerWon: false, rewards: { attacker: 1, defender: 1 }, linked: true }), null);
    // The target earns for each attacker they hold off: once per attacker per day, up to the cap.
    const tCash = user(targetId).cash;
    assert.ok(app.target.afterFight({ battleId: 7, attackerId: other.id, defenderId: targetId, attackerWon: false, rewards: { attacker: 1, defender: 1 } }));
    assert.equal(app.target.afterFight({ battleId: 8, attackerId: other.id, defenderId: targetId, attackerWon: false, rewards: { attacker: 1, defender: 1 } }), null);
    const extras = Array.from({ length: target.MAX_DEFENSE_PAYOUTS + 2 }, (_, i) => Number(db.prepare(
      'INSERT INTO users (username, email, password_hash, cash, energy_updated_at, health_updated_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    ).run(`Extra${i}`, `extra${i}@x.com`, 'x', Date.now(), Date.now(), Date.now()).lastInsertRowid));
    let paid = 1;
    for (const [i, id] of extras.entries()) {
      if (app.target.afterFight({ battleId: 100 + i, attackerId: id, defenderId: targetId, attackerWon: false, rewards: { attacker: 1, defender: 1 } })) paid += 1;
    }
    assert.equal(paid, target.MAX_DEFENSE_PAYOUTS);
    assert.equal(user(targetId).cash, tCash + target.MAX_DEFENSE_PAYOUTS * target.defenseBonus(user(targetId).level));
    page = (await hunter.request('/players')).text;
    assert.match(page, /You’ve collected today’s bonus/);
    // The ledger still balances for everyone.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM (SELECT u.id FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id HAVING COALESCE(SUM(l.delta_cash), 0) != u.cash)').get().n, 0);
  } finally {
    server.close();
  }
});
