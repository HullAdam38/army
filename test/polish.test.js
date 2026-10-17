'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const titles = require('../src/titles');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('titles: rules', () => {
  const none = { missions: 0, deployments: 0, pvpWins: 0, knockouts: 0, defenses: 0, bounties: 0, training: 0, streak: 0, base: 0, warPoints: 0, warsWon: 0, level: 1, seasonsGold: 0, seasonBestRank: 0 };
  assert.deepEqual(titles.newlyEarned(none, new Set()), []);
  const earned = titles.newlyEarned({ ...none, deployments: 50, level: 20, seasonBestRank: 1, seasonsGold: 1 }, new Set(['veteran']));
  assert.deepEqual(earned.map((t) => t.id), ['ghost', 'contender', 'topten', 'champion']);
  assert.equal(titles.newlyEarned({ ...none, seasonBestRank: 11 }, new Set()).length, 0);
  assert.equal(titles.nameOf('ghost'), 'Ghost');
  assert.equal(titles.nameOf('nope'), null);
  assert.equal(titles.nameOf(null), null);
  assert.equal(new Set(titles.TITLES.map((t) => t.id)).size, titles.TITLES.length);
});

test('titles and chat unread through the app', async () => {
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
    return {
      request,
      post: async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } }),
      async enlist(username) {
        await request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username, email: `${username}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
  };
  try {
    const ace = client(); await ace.enlist('Ace');
    const rook = client(); await rook.enlist('Rook');
    db.prepare('UPDATE users SET level = 5').run();
    const id = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;

    // ----- Titles -----
    let page = (await ace.request('/account/profile')).text;
    assert.match(page, /0 of 19 earned/);
    assert.match(page, /Come back from 50 deployments/);
    // Can't pick a title you haven't earned.
    await ace.post('/account/title', { title: 'ghost' });
    assert.equal(db.prepare('SELECT title FROM users WHERE id = ?').get(id('Ace')).title, null);
    // Earn it: 50 completed deployments, then any action runs the check.
    const ins = db.prepare("INSERT INTO deployments (user_id, kind, started_at, ends_at, status) VALUES (?, 'patrol', 0, 1, 'returned')");
    for (let i = 0; i < 50; i += 1) ins.run(id('Ace'));
    page = (await ace.request('/account/profile')).text;
    assert.match(page, /1 of 19 earned/);
    assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'title' AND user_id = ?").get(id('Ace')).message, /New title unlocked: “Ghost”/);
    assert.equal((await ace.post('/account/title', { title: 'ghost' })).location, '/account/profile#title');
    assert.match((await rook.request('/profile/Ace')).text, /class="profile-hero__title callsign-title">“Ghost”/);
    // It shows in chat too.
    await ace.post('/chat/global', { body: 'Reporting in' });
    assert.match((await rook.request('/chat/global')).text, /chat-msg__name[^>]*>Ace<\/a>\s*<span class="callsign-title chat-msg__title">Ghost<\/span>/);
    // And can be removed.
    await ace.post('/account/title', { title: '' });
    assert.doesNotMatch((await rook.request('/profile/Ace')).text, /profile-hero__title/);

    // ----- Chat unread -----
    // Rook has read Global (just opened it). New messages from Ace light the dot, not a count.
    db.prepare('UPDATE chat_messages SET created_at = created_at - 60000').run(); // past the cooldown
    await ace.post('/chat/global', { body: 'Anyone about?' });
    let hq = (await rook.request('/hq')).text;
    assert.match(hq, /data-chat-dot >|data-chat-dot>/);
    assert.match(hq, /aria-label="Chat, new messages"/);
    // Opening the channel clears it.
    await rook.request('/chat/global');
    hq = (await rook.request('/hq')).text;
    assert.match(hq, /data-chat-dot hidden/);
    // Your own messages never count as unread.
    db.prepare('UPDATE chat_messages SET created_at = created_at - 60000').run();
    await rook.post('/chat/global', { body: 'Here' });
    assert.match((await rook.request('/hq')).text, /aria-label="Chat"/);

    // Unit channel: a count, linked straight to the unit channel, and in the live poll.
    db.prepare("INSERT INTO units (name, tag, founded_by, created_at) VALUES ('Ghost Company', 'GHO', ?, 0)").run(id('Ace'));
    db.prepare("UPDATE users SET unit_id = (SELECT id FROM units), unit_role = 'member'").run();
    db.prepare('UPDATE chat_messages SET created_at = created_at - 60000').run();
    await ace.post('/chat/unit', { body: 'Muster at 1900' });
    db.prepare('UPDATE chat_messages SET created_at = created_at - 60000').run();
    await ace.post('/chat/unit', { body: 'Bring stims' });
    hq = (await rook.request('/hq')).text;
    assert.match(hq, /href="\/chat\/unit" data-chat-bell/);
    assert.match(hq, /data-chat-count >2<|data-chat-count>2</);
    const poll = JSON.parse((await rook.request('/notifications/poll?after=0')).text);
    assert.deepEqual(poll.chat, { unit: 2, global: false, mentions: { global: 0, unit: 0 } });
    // The Global page shows the unit's count on its tab.
    assert.match((await rook.request('/chat/global')).text, /\[GHO\] Unit <span class="chat__unread">2<\/span>/);
    await rook.request('/chat/unit');
    assert.deepEqual(JSON.parse((await rook.request('/notifications/poll?after=0')).text).chat, { unit: 0, global: false, mentions: { global: 0, unit: 0 } });
  } finally {
    server.close();
  }
});
