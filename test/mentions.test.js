'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('chat mentions flag the chat icon until read, and notify (rate-limited)', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text() };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return { request, csrf };
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return c;
  };
  const say = async (c, body) => c.request('/chat/global', { method: 'POST', form: { _csrf: await c.csrf('/chat/global'), body } });
  const poll = async (c) => JSON.parse((await c.request('/notifications/poll?after=0', { headers: { accept: 'application/json' } })).text);
  try {
    const alpha = await join('Alpha');
    const bravo = await join('Bravo');
    db.prepare('UPDATE users SET level = 5').run();

    // No mention yet: no @ on the chat icon.
    assert.match((await bravo.request('/hq')).text, /data-chat-mention hidden/);

    await say(alpha, 'Morning @bravo, ready?');
    let data = await poll(bravo);
    assert.deepEqual(data.chat.mentions, { global: 1, unit: 0 });
    assert.equal(data.items.filter((n) => n.kind === 'chat').length, 1);
    assert.match(data.items.find((n) => n.kind === 'chat').message, /Alpha mentioned you in Global chat/);
    let page = (await bravo.request('/hq')).text;
    assert.match(page, /bell--chat is-mentioned" href="\/chat\/global"/);
    assert.match(page, /aria-label="Chat, you were mentioned"/);

    // A second mention soon after still flags the icon, but the bell notification is rate-limited.
    await new Promise((r) => setTimeout(r, 3100)); // chat cooldown
    await say(alpha, '@Bravo again');
    data = await poll(bravo);
    assert.equal(data.chat.mentions.global, 2);
    assert.equal(data.items.filter((n) => n.kind === 'chat').length, 1);
    assert.match((await bravo.request('/hq')).text, />@2<\/span>/);

    // Reading the channel clears the mentions.
    page = (await bravo.request('/chat/global')).text;
    assert.match(page, /chat-msg--mention/);
    assert.deepEqual((await poll(bravo)).chat.mentions, { global: 0, unit: 0 });

    // Mentions from a blocked player don't count.
    await bravo.request('/messages/block', { method: 'POST', form: { _csrf: await bravo.csrf(), username: 'Alpha' } });
    await new Promise((r) => setTimeout(r, 3100));
    await say(alpha, 'hey @Bravo');
    assert.equal((await poll(bravo)).chat.mentions.global, 0);

    // Deleting chat history removes its mentions too.
    db.prepare('DELETE FROM chat_messages').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_mentions').get().n, 0);
  } finally {
    server.close();
  }
});
