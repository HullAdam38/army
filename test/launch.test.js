'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launch = require('../src/launch');
const tuning = require('../src/tuning');
const { legalSettings } = require('../src/legal');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const HOUR = 60 * 60 * 1000;

test('the installer’s example legal details count as not filled in', () => {
  const s = legalSettings({ LEGAL_OPERATOR: 'Your name or company', LEGAL_CONTACT_EMAIL: 'support@generalforces.com', LEGAL_JURISDICTION: 'England and Wales' });
  assert.deepEqual(s.missing, ['LEGAL_OPERATOR']);
  assert.match(s.operator, /set LEGAL_OPERATOR/);
});

test('launch checklist items', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const legal = legalSettings({ LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@generalforces.com', LEGAL_JURISDICTION: 'England and Wales' });
  const base = { legal, production: true, host: 'www.generalforces.com', errors24h: 0, signupsOpen: true, signupsPerIp: 3, reserve: 12, now };
  const good = { at: new Date(now - 3 * HOUR).toISOString(), atMs: now - 3 * HOUR, stale: false, size: 2_000_000, restore: { ok: true, users: 120 }, offsite: { ok: true, remote: 'b2:gf', at: new Date(now - 3 * HOUR).toISOString() } };
  const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

  let c = byId(launch.checklist({ ...base, backup: good }));
  assert.deepEqual(['legal', 'email', 'production', 'backup', 'offsite', 'errors'].map((k) => c[k].state), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(c.supporter.state, 'info', 'Supporter payments are optional');
  assert.equal(byId(launch.checklist({ ...base, store: { checkout: true, webhook: true } })).supporter.state, 'ok');
  assert.match(byId(launch.checklist({ ...base, store: { checkout: true, webhook: false } })).supporter.detail, /WEBHOOK_SECRET/);
  assert.match(c.backup.detail, /3 h ago.*120 players/);
  assert.match(c.uptime.detail, /https:\/\/generalforces\.com\/healthz/);

  c = byId(launch.checklist({ ...base, legal: legalSettings({}), production: false, backup: null, errors24h: 4, host: 'generalforces.com' }));
  assert.equal(c.legal.state, 'todo');
  assert.match(c.legal.fix, /Server settings/);
  assert.equal(c.email.state, 'todo');
  assert.equal(c.production.state, 'todo');
  assert.equal(c.backup.state, 'todo');
  assert.equal(c.offsite, undefined, 'nothing to say about off-site copies until a backup has run');
  assert.match(c.errors.detail, /^4 errors/);

  c = byId(launch.checklist({ ...base, legal: legalSettings({ LEGAL_OPERATOR: 'X', LEGAL_CONTACT_EMAIL: 'me@gmail.com', LEGAL_JURISDICTION: 'Y' }), backup: { ...good, stale: true, offsite: { remote: 'b2:gf', ok: false, error: 'bad key' } } }));
  assert.equal(c.email.state, 'todo');
  assert.match(c.email.detail, /isn’t on generalforces\.com/);
  assert.equal(c.backup.state, 'todo');
  assert.match(c.backup.fix, /over a day old/);
  assert.match(c.offsite.detail, /failed: bad key/);
});

test('server errors are recorded and admins alerted at most every half hour', () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const admin = Number(db.prepare(`INSERT INTO users (username, email, password_hash, is_admin, energy_updated_at, health_updated_at, created_at)
    VALUES ('Boss', 'b@x.com', 'x', 1, 0, 0, 0)`).run().lastInsertRowid);
  const t0 = Date.now();
  app.health.record(new Error('kaboom'), { method: 'GET', originalUrl: '/missions', session: { userId: admin } }, t0);
  app.health.record(new Error('kaboom again'), { method: 'POST', originalUrl: '/bank' }, t0 + 60_000);
  assert.equal(app.health.countSince(t0 - 1), 2);
  assert.equal(app.health.recent(5)[0].message, 'kaboom again');
  const alerts = () => db.prepare("SELECT message FROM notifications WHERE user_id = ? AND message LIKE 'Server error%' ORDER BY id").all(admin);
  assert.equal(alerts().length, 1, 'one alert, not one per error');
  assert.match(alerts()[0].message, /GET \/missions/);
  app.health.record(new Error('later'), null, t0 + 31 * 60_000);
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].message, /3 in the last hour.*background job/);
});

test('health check, error page recording, the checklist page and the sign-up limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-launch-'));
  const statusFile = path.join(dir, 'backup-status.json');
  const db = openDatabase(':memory:');
  const before = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = 'loopback'; // so the test can say which network a sign-up comes from
  const app = createApp({ db, secret: 'test-secret', tutorial: false, backupStatusFile: statusFile });
  process.env.TRUST_PROXY = before;
  if (before === undefined) delete process.env.TRUST_PROXY;
  // A route that fails, to see the error handler record it.
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (ip = null) => {
    const jar = new Map();
    const c = {
      async request(p, { method = 'GET', form } = {}) {
        const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
        for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
        return { res, text: await res.text() };
      },
      async csrf(from) { return (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1]; },
      async register(name, extra = {}) {
        return c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on', ...extra } });
      },
    };
    return c;
  };
  try {
    let r = await client().request('/healthz');
    assert.equal(r.res.status, 200);
    assert.equal(r.text, 'ok');
    assert.equal(r.res.headers.get('cache-control'), 'no-store');

    // The sign-up form has a trap field bots fill in; filling it gets nowhere.
    assert.match((await client().request('/register')).text, /name="website"/);
    r = await client('203.0.113.9').register('Botty', { website: 'http://spam.example' });
    assert.equal(r.res.status, 422);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'Botty'").get().n, 0);

    // Three sign-ups per network a day (the trap doesn't count), then no more.
    tuning.set({ signupsPerIpPerDay: 3 });
    for (const name of ['NetA', 'NetB', 'NetC']) assert.equal((await client('203.0.113.5').register(name)).res.status, 302);
    r = await client('203.0.113.5').register('NetD');
    assert.equal(r.res.status, 429);
    assert.match(r.text, /Too many new accounts/);
    assert.equal((await client('198.51.100.7').register('Elsewhere')).res.status, 302, 'other networks are fine');

    // The checklist page: admins only.
    const boss = client('192.0.2.1');
    await boss.register('Boss');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
    const pleb = client('192.0.2.2');
    await pleb.register('Pleb');
    assert.equal((await pleb.request('/admin/launch')).res.status, 404);
    let page = (await boss.request('/admin/launch')).text;
    assert.match(page, /Launch checklist/);
    assert.match(page, /No backup has reported in yet/);
    assert.match(page, /\/healthz/);
    assert.match(page, /No errors in the last 14 days/);

    // With a backup report, and after a server error.
    fs.writeFileSync(statusFile, JSON.stringify({ at: new Date().toISOString(), ok: true, size: 1048576, restore: { ok: true, users: 9, error: '' }, offsite: { remote: '', ok: false, error: '' } }));
    app.health.record(new Error('Something broke'), { method: 'GET', originalUrl: '/hq' });
    page = (await boss.request('/admin/launch')).text;
    assert.match(page, /Test restore passed: 9 players/);
    assert.match(page, /Backups only live on the game server/);
    assert.match(page, /Something broke/);
    assert.match(page, /GET \/hq/);
  } finally {
    server.close();
    tuning.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
