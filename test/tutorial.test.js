'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tutorial = require('../src/tutorial');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const blank = { level: 1, missions: 0, training: 0, inUnit: 0, supplyDrops: 0, equipped: 0, deposits: 0, applications: 0, pvpWins: 0 };

test('steps are detected from real state', () => {
  assert.deepEqual(tutorial.newlyDone(blank, new Set()), []);
  const some = { ...blank, missions: 2, equipped: 1, applications: 1 };
  assert.deepEqual(tutorial.newlyDone(some, new Set(['mission'])).map((s) => s.id), ['gear', 'unit']);
  const all = { ...blank, level: 3, missions: 1, training: 1, inUnit: 1, supplyDrops: 1, equipped: 1, deposits: 1, pvpWins: 1 };
  assert.equal(tutorial.newlyDone(all, new Set()).length, tutorial.STEPS.length);

  const v = tutorial.view(new Set(['mission', 'gear']));
  assert.deepEqual([v.count, v.total, v.pct, v.next.id, v.complete, v.graduated], [2, 8, 25, 'train', false, false]);
  assert.equal(tutorial.view(new Set([...tutorial.STEP_IDS, 'graduate'])).graduated, true);
});

test('basic training: a new player works through the checklist and graduates once', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text() };
  };
  const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username: 'Recruit', email: 'r@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    const id = db.prepare("SELECT id FROM users WHERE username = 'Recruit'").get().id;
    const tutorialCash = () => db.prepare("SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger WHERE user_id = ? AND reason = 'tutorial'").get(id).n;

    let hq = (await request('/hq')).text;
    assert.match(hq, /Basic training/);
    assert.match(hq, /0<small>\/8<\/small>/);
    assert.match(hq, /Next: <strong>Run your first mission<\/strong>/);

    // Doing the thing ticks the step off and pays for it.
    await post('/missions/perimeter-patrol');
    assert.equal(tutorialCash(), 100);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'tutorial'").get(id).message, /Run your first mission/);
    hq = (await request('/hq')).text;
    assert.match(hq, /1<small>\/8<\/small>/);
    assert.match(hq, /Next: <strong>Equip gear/);

    // Hiding it leaves a way back.
    await post('/tutorial/hide');
    hq = (await request('/hq')).text;
    assert.doesNotMatch(hq, /id="training-title"/);
    assert.match(hq, /Show basic training \(1\/8\)/);
    await post('/tutorial/show');
    assert.match((await request('/hq')).text, /id="training-title"/);

    // Finish the rest (state set directly), then graduate exactly once.
    db.prepare('UPDATE users SET level = 3, stat_str = 1, streak_best = 1 WHERE id = ?').run(id);
    db.prepare("INSERT INTO equipment (user_id, slot, item_id) VALUES (?, 'weapon', 'service-pistol')").run(id);
    db.prepare("INSERT INTO bank_transactions (user_id, type, amount, fee, balance_after, created_at) VALUES (?, 'deposit', 10, 1, 9, 0)").run(id);
    const other = Number(db.prepare("INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at) VALUES ('Target', 't@x.com', 'x', 0, 0, 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, attacker_xp, report, created_at) VALUES (?, ?, 1, 0, 10, '{}', 0)").run(id, other);
    db.prepare("INSERT INTO units (name, tag, created_at) VALUES ('Iron Wolves', 'IW', 0)").run();
    db.prepare('INSERT INTO unit_applications (unit_id, user_id, created_at) VALUES (1, ?, 0)').run(id);
    hq = (await request('/hq')).text;
    const all = tutorial.STEPS.reduce((n, s) => n + s.cash, 0) + tutorial.GRADUATION.cash;
    assert.equal(tutorialCash(), all);
    assert.doesNotMatch(hq, /id="training-title"/); // graduated: the card is gone for good
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'tutorial' ORDER BY id DESC").get(id).message, /Basic training complete/);
    await request('/hq');
    assert.equal(tutorialCash(), all); // never paid twice
    const off = db.prepare('SELECT username FROM users u WHERE cash != (SELECT SUM(delta_cash) FROM ledger WHERE user_id = u.id) AND id = ?').all(id);
    assert.deepEqual(off, []);
  } finally {
    server.close();
  }
});
