'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

async function startServer() {
  const app = createApp({ db: openDatabase(':memory:'), secret: 'test-secret' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Tiny cookie-aware client. */
function client(base) {
  let cookie = '';
  return {
    async request(path, { method = 'GET', form, headers = {} } = {}) {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { res, text: await res.text() };
    },
    async csrf(path) {
      const { text } = await this.request(path);
      return text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
  };
}

test('full game loop: register, play, logout, login', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  let { res } = await c.request('/hq');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');

  let token = await c.csrf('/register');
  ({ res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username: 'Nightjar', email: 'nj@example.com', password: 'hunter2hunter2', confirm: 'hunter2hunter2', adult: 'on', terms: 'on' },
  }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/hq');

  let text;
  ({ res, text } = await c.request('/hq'));
  assert.equal(res.status, 200);
  assert.match(text, /Nightjar/);
  assert.match(text, /Recruit/);

  token = await c.csrf('/missions');
  ({ res, text } = await c.request('/missions/perimeter-patrol', {
    method: 'POST', form: { _csrf: token }, headers: { accept: 'application/json' },
  }));
  const data = JSON.parse(text);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.player.energy, 45);

  ({ res } = await c.request('/missions/perimeter-patrol', { method: 'POST', form: { _csrf: 'wrong' } }));
  assert.equal(res.status, 403);

  ({ res } = await c.request('/logout', { method: 'POST', form: { _csrf: token } }));
  assert.equal(res.status, 302);
  ({ res } = await c.request('/hq'));
  assert.equal(res.status, 302);

  token = await c.csrf('/login');
  ({ res } = await c.request('/login', { method: 'POST', form: { _csrf: token, login: 'nightjar', password: 'bad-password' } }));
  assert.equal(res.status, 401);

  token = await c.csrf('/login');
  ({ res } = await c.request('/login', { method: 'POST', form: { _csrf: token, login: 'NJ@example.com', password: 'hunter2hunter2' } }));
  assert.equal(res.status, 302);
  ({ res, text } = await c.request('/hq'));
  assert.equal(res.status, 200);
  assert.match(text, /Perimeter Patrol/);
});

test('registration validates input and the 18+ confirmation', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  const token = await c.csrf('/register');
  const { res, text } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username: 'x', email: 'nope', password: 'short', confirm: 'other' },
  });
  assert.equal(res.status, 422);
  assert.match(text, /18 or older/);
  assert.match(text, /valid email/);
  assert.match(text, /do not match/);
});

test('public pages render and unknown routes 404', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  const { res, text } = await c.request('/');
  assert.equal(res.status, 200);
  assert.match(text, /Earn your/);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal((await c.request('/nowhere')).res.status, 404);
});

async function register(c, username) {
  const token = await c.csrf('/register');
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
}

test('online page lists active players and profiles show public info only', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const alpha = client(base);
  const bravo = client(base);
  await register(alpha, 'Alpha');
  await register(bravo, 'Bravo');

  let { res, text } = await alpha.request('/online');
  assert.equal(res.status, 200);
  assert.match(text, /href="\/profile\/Alpha"/);
  assert.match(text, /href="\/profile\/Bravo"/);
  assert.match(text, /2 soldiers/);

  ({ res, text } = await alpha.request('/profile/bravo'));
  assert.equal(res.status, 200);
  assert.match(text, /Bravo/);
  assert.match(text, /Online now/);
  assert.doesNotMatch(text, /bravo@example\.com/);
  assert.doesNotMatch(text, /how other soldiers see you/);

  ({ text } = await alpha.request('/profile/Alpha'));
  assert.match(text, /how other soldiers see you/);

  assert.equal((await alpha.request('/profile/nobody')).res.status, 404);

  // Signing out drops you from the roll call and shows "last seen" instead.
  const token = await bravo.csrf('/hq');
  await bravo.request('/logout', { method: 'POST', form: { _csrf: token } });
  ({ text } = await alpha.request('/online'));
  assert.doesNotMatch(text, /href="\/profile\/Bravo"/);
  assert.match(text, />1 soldier</);
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.match(text, /Last seen/);
});

test('online and profile pages require sign-in', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  assert.equal((await c.request('/online')).res.status, 302);
  assert.equal((await c.request('/profile/anyone')).res.status, 302);
});
