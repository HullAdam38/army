'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const { createLeaderboards } = require('../src/leaderboards');
const admin = require('../src/admin');

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

function client(base) {
  const jar = new Map();
  return {
    async request(p, { method = 'GET', form, headers = {} } = {}) {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: {
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
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
    async csrf(from) {
      return (await this.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
    async post(p, form = {}, from = '/hq') {
      return this.request(p, { method: 'POST', form: { _csrf: await this.csrf(from), ...form } });
    },
    async login(login, password) {
      return this.request('/login', { method: 'POST', form: { _csrf: await this.csrf('/login'), login, password } });
    },
  };
}

async function register(c, username) {
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: await c.csrf('/register'), username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
}

function seed(db, n) {
  const ins = db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, xp, pvp_wins, pvp_losses, missions_completed)
                          VALUES (?, ?, 'x', 0, 0, 0, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < n; i += 1) ins.run(`Seed${i}`, `seed${i}@example.com`, 2 + (i % 5), i * 7, i % 9, i % 4, i % 6);
}

test('boards rank correctly, skip suspended players and pin you when outside the top 50', () => {
  const db = openDatabase(':memory:');
  seed(db, 60);
  const lb = createLeaderboards(db);
  const { rows } = lb.board('level', 0);
  assert.equal(rows.length, 50);
  for (let i = 1; i < rows.length; i += 1) {
    const [a, b] = [rows[i - 1], rows[i]];
    assert.ok(a.value > b.value || (a.value === b.value && a.detail >= b.detail), `${a.username} before ${b.username}`);
  }
  assert.deepEqual(rows.map((r) => r.position).slice(0, 3), [1, 2, 3]);

  const lowest = db.prepare('SELECT id FROM users ORDER BY level, xp LIMIT 1').get().id;
  const mine = lb.board('level', lowest).me;
  assert.equal(mine.position, 60);
  assert.equal(mine.outside, true);

  const leader = rows[0];
  db.prepare('UPDATE users SET banned_at = 1 WHERE id = ?').run(leader.id);
  assert.notEqual(lb.board('level', 0).rows[0].id, leader.id);

  assert.ok(lb.board('pvp', 0).rows.every((r) => r.value > 0)); // no zero-win players on the PvP board
});

test('the weekly board counts only the last 7 days of XP', () => {
  const db = openDatabase(':memory:');
  seed(db, 3);
  const [a, b, c] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  const now = Date.now();
  const act = db.prepare("INSERT INTO actions (user_id, kind, xp, created_at) VALUES (?, 'mission', ?, ?)");
  act.run(a, 100, now - 60_000);
  act.run(b, 40, now - 60_000);
  act.run(b, 40, now - 2 * 86_400_000);
  act.run(c, 999, now - 8 * 86_400_000); // too old
  const { rows } = createLeaderboards(db).board('weekly', c, now);
  assert.deepEqual(rows.map((r) => [r.id, r.value]), [[a, 100], [b, 80]]);
});

test('leaderboards page: tabs, medals, your position', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const me = client(base);
  await register(me, 'Climber');
  seed(db, 55);
  let { res, text } = await me.request('/leaderboards');
  assert.equal(res.status, 200);
  assert.match(text, /board__row--gold/);
  assert.match(text, /Your position<\/span>\s*<span class="standing__pos">#56</);
  assert.match(text, /id="you"/);
  assert.match(text, /board__gap/); // pinned below the top 50
  ({ text } = await me.request('/leaderboards?board=missions'));
  assert.match(text, /You’re not on this board yet\. Complete a mission/);
  ({ res } = await me.request('/leaderboards?board=nonsense'));
  assert.equal(res.status, 200);
  ({ text } = await me.request('/players'));
  assert.match(text, /href="\/leaderboards"/);
});

test('temporary passwords are readable and random', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const p = admin.generateTempPassword();
    assert.match(p, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});

test('admin reset: temp password shown once, player signed out, must set a new one, old ones stop working', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const boss = client(base);
  const grunt = client(base);
  await register(boss, 'Boss');
  await register(grunt, 'Grunt');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
  const gruntId = db.prepare("SELECT id FROM users WHERE username = 'Grunt'").get().id;

  const outsider = client(base);
  await register(outsider, 'Nosy');
  assert.equal((await outsider.post(`/admin/players/${gruntId}/reset-password`)).res.status, 404);

  const { res, text } = await boss.post(`/admin/players/${gruntId}/reset-password`, {}, `/admin/players/${gruntId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const temp = text.match(/class="temp-pass__code"[^>]*>([A-Z0-9-]+)</)[1];
  const log = db.prepare("SELECT details FROM admin_actions WHERE action = 'password-reset'").get().details;
  assert.ok(!log.includes(temp), 'the password never goes in the audit log');

  // Grunt was signed out, and the old password no longer works.
  assert.equal((await grunt.request('/hq')).res.headers.get('location'), '/login');
  assert.equal((await client(base).login('Grunt', 'password123')).res.status, 401);

  // Signing in with the temporary password forces a new one before anything else.
  const g = client(base);
  assert.equal((await g.login('Grunt', temp)).res.headers.get('location'), '/account/password');
  assert.equal((await g.request('/missions')).res.headers.get('location'), '/account/password');
  assert.equal((await g.request('/notifications/poll', { headers: { accept: 'application/json' } })).res.status, 403);
  let page = await g.request('/account/password');
  assert.match(page.text, /Set a new password/);

  const change = (form) => g.post('/account/password', form, '/account/password');
  page = await change({ current: 'wrong', password: 'brandnew123', confirm: 'brandnew123' });
  assert.match(page.text, /isn’t your current password/);
  page = await change({ current: temp, password: temp, confirm: temp });
  assert.match(page.text, /different from the current one/);
  page = await change({ current: temp, password: 'brandnew123', confirm: 'nope' });
  assert.match(page.text, /do not match/);
  const ok = await change({ current: temp, password: 'brandnew123', confirm: 'brandnew123' });
  assert.equal(ok.res.headers.get('location'), '/hq');
  assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(gruntId).must_change_password, 0);
  assert.equal((await g.request('/missions')).res.status, 200);
  assert.equal((await client(base).login('Grunt', temp)).res.status, 401);
  assert.equal((await client(base).login('Grunt', 'brandnew123')).res.headers.get('location'), '/hq');

  // Admins can't reset themselves or other admins here.
  const bossId = db.prepare("SELECT id FROM users WHERE username = 'Boss'").get().id;
  await boss.post(`/admin/players/${bossId}/reset-password`, {}, `/admin/players/${bossId}`);
  assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(bossId).must_change_password, 0);
});

test('temporary passwords expire after 24 hours', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const boss = client(base);
  await register(boss, 'Boss');
  await register(client(base), 'Sleepy');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
  const id = db.prepare("SELECT id FROM users WHERE username = 'Sleepy'").get().id;
  const { text } = await boss.post(`/admin/players/${id}/reset-password`, {}, `/admin/players/${id}`);
  const temp = text.match(/class="temp-pass__code"[^>]*>([A-Z0-9-]+)</)[1];
  db.prepare('UPDATE users SET password_reset_at = ? WHERE id = ?').run(Date.now() - 25 * 3600_000, id);
  const r = await client(base).login('Sleepy', temp);
  assert.equal(r.res.status, 403);
  assert.match(r.text, /temporary password has expired/);
});

test('changing your own password signs out your other devices but not this one', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const laptop = client(base);
  await register(laptop, 'Careful');
  const phone = client(base);
  await phone.login('Careful', 'password123');
  assert.equal((await phone.request('/hq')).res.status, 200);
  const { res } = await laptop.post('/account/password', { current: 'password123', password: 'evenbetter1', confirm: 'evenbetter1' }, '/account/password');
  assert.equal(res.headers.get('location'), '/hq');
  assert.equal((await laptop.request('/hq')).res.status, 200);
  assert.equal((await phone.request('/hq')).res.headers.get('location'), '/login');
  const { text } = await laptop.request('/profile/Careful');
  assert.match(text, /href="\/account\/password"/);
});
