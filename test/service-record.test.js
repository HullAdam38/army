'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { longestStreak, rankUps } = require('../src/service-record');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('service record rules: winning streaks and rank-ups', () => {
  const w = { won: true, counts: true };
  const l = { won: false, counts: true };
  const skip = { won: true, counts: false };
  assert.equal(longestStreak([]), 0);
  assert.equal(longestStreak([w, w, l, w, w, w, l]), 3);
  assert.equal(longestStreak([w, skip, w, skip, w]), 3, 'fights that paid nothing neither extend nor break a run');

  const ups = rankUps([
    { message: 'Promoted to level 2 — Private (E-2).', created_at: 1 },
    { message: 'Promoted to level 3 — Private (E-2).', created_at: 2 },
    { message: 'Promoted to level 6 — whatever.', created_at: 3 },
    { message: 'Something else', created_at: 4 },
  ]);
  assert.ok(ups.length >= 1);
  assert.ok(ups.every((u) => u.kind === 'rank' && /^Promoted to .+ at level \d+$/.test(u.text)));
  assert.equal(new Set(ups.map((u) => u.text.split(' at ')[0])).size, ups.length, 'each rank once');
});

test('the service record page: public career, private money, milestones', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {
      async request(p, { method = 'GET', form } = {}) {
        const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
        for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
        return { res, text: await res.text(), location: res.headers.get('location') };
      },
      async csrf(from = '/hq') { return (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1]; },
    };
    return c;
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const row = (page, label) => {
    const m = page.match(new RegExp(`<dt>${label}</dt><dd>(.*?)</dd>`));
    return m ? m[1].replace(/<[^>]+>/g, '') : null;
  };

  try {
    const ace = await enlist('Ace');
    const bea = await enlist('Bea');
    db.prepare('UPDATE users SET missions_completed = 30, missions_failed = 10, pvp_wins = 4, pvp_losses = 1, vehicle_missions = 7, upgrades_made = 2, wars_won = 1 WHERE id = ?').run(ace.id);
    const fight = (a, d, won, xp, cash, at, reversed = null) => db.prepare(`INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, cash_taken, attacker_xp, defender_xp, report, created_at, reversed_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, '{}', ?, ?)`).run(a, d, won, cash, won ? xp : 0, won ? 0 : xp, at, reversed);
    const t0 = Date.now() - 10 * 86400e3;
    db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(t0 - 1000, ace.id);
    fight(ace.id, bea.id, 1, 50, 300, t0);
    fight(ace.id, bea.id, 1, 50, 900, t0 + 1);
    fight(bea.id, ace.id, 0, 40, 0, t0 + 2); // Ace held off Bea: a win for Ace
    fight(ace.id, bea.id, 1, 0, 5000, t0 + 3); // paid no XP: doesn't count either way
    fight(ace.id, bea.id, 1, 50, 99999, t0 + 4, Date.now()); // reversed by an admin
    fight(bea.id, ace.id, 1, 40, 100, t0 + 5); // Ace lost
    fight(ace.id, bea.id, 1, 50, 200, t0 + 6);
    db.prepare("INSERT INTO user_medals (user_id, medal_id, tier, awarded_at) VALUES (?, 'operator', 1, ?)").run(ace.id, t0 + 100);
    db.prepare("INSERT INTO activity (user_id, kind, message, created_at) VALUES (?, 'promotion', 'Promoted to level 3 — x.', ?)").run(ace.id, t0 + 50);
    app.vehicles.grant(ace.id, 'trail-bike');

    // Bea sees Ace's public record.
    let page = (await bea.request('/profile/Ace/record')).text;
    assert.match(page, /<h1 class="page-head__title"[^>]*>Ace<\/h1>/);
    assert.equal(row(page, 'Missions won'), '30');
    assert.equal(row(page, 'Success rate'), '75%');
    assert.equal(row(page, 'Longest winning streak'), '3');
    assert.equal(row(page, 'Biggest haul'), '$900', 'no-XP and reversed fights don’t count');
    assert.match(page, /href="\/battles\/2">\$900/);
    assert.equal(row(page, 'Unit wars won'), '1');
    assert.equal(row(page, 'Vehicles in the motor pool'), '1');
    assert.equal(row(page, 'Missions won with a vehicle out'), '7');
    assert.doesNotMatch(page, /Only you can see this/);
    assert.doesNotMatch(page, /Earned from missions/);
    // Milestones, newest first.
    assert.match(page, /First vehicle: Trail Bike[\s\S]*Bronze Field Operator[\s\S]*First PvP win[\s\S]*<span>Enlisted<\/span>/);

    // Ace sees their money too.
    page = (await ace.request('/profile/Ace/record')).text;
    assert.match(page, /Only you can see this/);
    assert.equal(row(page, 'Taken in PvP'), '$1,400');
    assert.match(page, /Training/);

    // Linked from the profile; unknown soldiers are a 404.
    assert.match((await bea.request('/profile/Ace')).text, /href="\/profile\/Ace\/record"/);
    assert.equal((await bea.request('/profile/Nobody/record')).res.status, 404);
    assert.equal((await client().request('/profile/Ace/record')).res.status, 302, 'signed in only');
  } finally {
    server.close();
  }
});
