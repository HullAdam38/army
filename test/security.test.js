'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const { safeRedirectPath } = require('../src/middleware');
const admin = require('../src/admin');

async function startServer(opts = {}) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  server.db = db;
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function client(base) {
  let cookie = '';
  return {
    async request(p, { method = 'GET', form, headers = {} } = {}) {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        body: form ? new URLSearchParams(form) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { res, text: await res.text() };
    },
    async csrf(p = '/login') {
      const { text } = await this.request(p);
      return text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
    async post(p, form, from = '/hq') {
      return this.request(p, { method: 'POST', form: { _csrf: await this.csrf(from), ...form } });
    },
  };
}

async function register(c, username, password = 'password123') {
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: await c.csrf('/register'), username, email: `${username}@example.com`, password, confirm: password, adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
}

test('safeRedirectPath only allows same-site paths', () => {
  assert.equal(safeRedirectPath('/armory?x=1'), '/armory?x=1');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/a\r\nSet-Cookie: x', '', undefined]) {
    assert.equal(safeRedirectPath(bad), '/hq', String(bad));
  }
});

test('admin change rules validate input', () => {
  const p = { username: 'X', cash: 100, level: 3, max_energy: 60, max_health: 120, energy: 0, health: 1 };
  assert.match(admin.adjustCash(p, '50', '').error, /reason/);
  assert.match(admin.adjustCash(p, '-101', 'oops').error, /only has \$100/);
  assert.match(admin.adjustCash(p, 'lots', 'x').error, /whole amount/);
  assert.match(admin.adjustCash(p, '0', 'x').error, /non-zero/);
  assert.equal(admin.adjustCash(p, '-100', 'refund').player.cash, 0);
  assert.equal(admin.adjustCash(p, '$1,000', 'gift').player.cash, 1100);
  assert.match(admin.setLevel(p, '0', 'x').error, /between 1/);
  assert.match(admin.setLevel(p, '61', 'x').error, /between 1/);
  const lv = admin.setLevel(p, '10', 'testing').player;
  assert.deepEqual([lv.level, lv.xp, lv.max_energy, lv.energy, lv.max_health, lv.health], [10, 0, 95, 95, 190, 190]);
});

test('login returns you to the page you were trying to reach', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Traveller');
  await c.post('/logout', {});
  await c.request('/armory'); // bounced to sign in
  const { res } = await c.request('/login', { method: 'POST', form: { _csrf: await c.csrf(), login: 'Traveller', password: 'password123' } });
  assert.equal(res.headers.get('location'), '/armory');
});

test('an account locks after 8 wrong passwords, even from a fresh session', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  await register(client(base), 'Target');
  for (let i = 0; i < 8; i += 1) {
    const c = client(base);
    const { res } = await c.request('/login', { method: 'POST', form: { _csrf: await c.csrf(), login: 'target', password: `wrong${i}` } });
    assert.equal(res.status, 401);
  }
  const c = client(base);
  const { res, text } = await c.request('/login', { method: 'POST', form: { _csrf: await c.csrf(), login: 'Target', password: 'password123' } });
  assert.equal(res.status, 429);
  assert.match(text, /Too many failed sign-ins for this account/);
});

test('simultaneous sign-ups with the same callsign: one wins, the other gets a friendly error', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const a = client(base);
  const b = client(base);
  const [ta, tb] = [await a.csrf('/register'), await b.csrf('/register')];
  const form = (tok, email) => ({ _csrf: tok, username: 'Twin', email, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' });
  const results = await Promise.all([
    a.request('/register', { method: 'POST', form: form(ta, 'a@example.com') }),
    b.request('/register', { method: 'POST', form: form(tb, 'b@example.com') }),
  ]);
  assert.deepEqual(results.map((r) => r.res.status).sort(), [302, 422]);
  assert.match(results.find((r) => r.res.status === 422).text, /already taken/);
});

test('production behind a local reverse proxy: secure cookies work and HSTS is sent', async (t) => {
  const { server, base } = await startServer({ production: true });
  t.after(() => server.close());
  const viaProxy = await fetch(`${base}/login`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(viaProxy.headers.get('set-cookie'), /ef\.sid=.*Secure/i);
  assert.match(viaProxy.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(viaProxy.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  const plain = await fetch(`${base}/login`);
  assert.equal(plain.headers.get('strict-transport-security'), null);
});

test('players are limited to 120 actions a minute', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Spammer');
  const token = await c.csrf('/bank');
  let last;
  for (let i = 0; i < 121; i += 1) last = await c.request('/bank/deposit', { method: 'POST', form: { _csrf: token, amount: 'x' } });
  assert.equal(last.res.status, 429);
});

test('admin area is invisible to non-admins and guests', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const guest = client(base);
  const user = client(base);
  await register(user, 'Regular');
  for (const c of [guest, user]) {
    assert.equal((await c.request('/admin')).res.status, 404);
    assert.equal((await c.request('/admin/players/1')).res.status, 404);
  }
  const { res } = await user.post('/admin/players/1/cash', { amount: '1000000', reason: 'free money' });
  assert.equal(res.status, 404);
  assert.equal(server.db.prepare("SELECT cash FROM users WHERE username = 'Regular'").get().cash, 100);
  assert.doesNotMatch((await user.request('/hq')).text, /href="\/admin"/);
});

test('admin tools: cash, level, restore, message, broadcast, ban/unban, audit log', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const boss = client(base);
  const grunt = client(base);
  await register(boss, 'Boss');
  await register(grunt, 'Grunt');
  server.db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
  const gruntId = server.db.prepare("SELECT id FROM users WHERE username = 'Grunt'").get().id;
  const row = () => server.db.prepare('SELECT * FROM users WHERE id = ?').get(gruntId);
  const url = `/admin/players/${gruntId}`;

  let { text } = await boss.request('/admin');
  assert.match(text, /Players<\/dt><dd>2/);
  ({ text } = await boss.request('/admin/players?q=example.com'));
  assert.match(text, /grunt@example\.com/);

  await boss.post(`${url}/cash`, { amount: '500', reason: 'bug compensation' });
  assert.equal(row().cash, 600);
  await boss.post(`${url}/cash`, { amount: '-9999', reason: 'x' });
  assert.equal(row().cash, 600);
  await boss.post(`${url}/level`, { level: '8', reason: 'testing' });
  assert.equal(row().level, 8);
  server.db.prepare('UPDATE users SET energy = 0, hospital_until = ? WHERE id = ?').run(Date.now() + 60000, gruntId);
  await boss.post(`${url}/restore`, {});
  assert.equal(row().energy, row().max_energy);
  assert.equal(row().hospital_until, null);
  await boss.post(`${url}/notify`, { message: 'Welcome to the test squad' });
  await boss.post('/admin/broadcast', { message: 'Maintenance at 22:00' });
  ({ text } = await grunt.request('/notifications'));
  assert.match(text, /Message from HQ: Welcome to the test squad/);
  assert.match(text, /Announcement: Maintenance at 22:00/);

  // Ban signs them out immediately and blocks sign-in; they vanish from lists.
  await boss.post(`${url}/ban`, { reason: 'Multiple accounts' });
  assert.ok(row().banned_at);
  let res;
  ({ res } = await grunt.request('/hq'));
  assert.equal(res.headers.get('location'), '/login');
  const g2 = client(base);
  ({ res, text } = await g2.request('/login', { method: 'POST', form: { _csrf: await g2.csrf(), login: 'Grunt', password: 'password123' } }));
  assert.equal(res.status, 403);
  assert.match(text, /suspended: Multiple accounts/);
  const g3 = client(base);
  ({ text } = await g3.request('/login', { method: 'POST', form: { _csrf: await g3.csrf(), login: 'Grunt', password: 'wrongpass' } }));
  assert.doesNotMatch(text, /suspended/); // a wrong password doesn't reveal the ban
  ({ text } = await boss.request('/players'));
  assert.doesNotMatch(text, />Grunt</);

  await boss.post(`${url}/unban`, {});
  assert.equal(row().banned_at, null);

  // Admins can't ban themselves or each other from the web.
  const bossId = server.db.prepare("SELECT id FROM users WHERE username = 'Boss'").get().id;
  await boss.post(`/admin/players/${bossId}/ban`, { reason: 'oops' });
  assert.equal(server.db.prepare('SELECT banned_at FROM users WHERE id = ?').get(bossId).banned_at, null);

  ({ text } = await boss.request(url));
  for (const action of ['cash', 'level', 'restore', 'message', 'ban', 'unban']) assert.match(text, new RegExp(`audit__action--${action}`));
  assert.match(text, /Added \$500 cash \(now \$600\)\. Reason: bug compensation/);
});

test('admin CLI grants, lists and revokes admin rights', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-'));
  const file = path.join(dir, 'cli.db');
  const db = openDatabase(file);
  db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at)
              VALUES ('Chief', 'chief@example.com', 'x', 0, 0, 0)`).run();
  db.close();
  const run = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', ...args], {
    env: { ...process.env, DB_FILE: file }, encoding: 'utf8',
  });
  assert.match(run('grant', 'Chief'), /Chief is now an admin/);
  assert.match(run('list'), /Chief <chief@example\.com>/);
  assert.match(run('revoke', 'Chief'), /no longer an admin/);
  assert.throws(() => run('grant', 'Nobody'), /No player called "Nobody"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
