'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const push = require('../src/push');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const fakeSub = (host = 'fcm.googleapis.com') => ({
  endpoint: `https://${host}/fcm/send/${crypto.randomBytes(12).toString('hex')}`,
  keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
});

test('push rules: subscriptions, categories, quiet hours, payloads', () => {
  // Only real browser push services, over HTTPS.
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']) {
    assert.ok(!push.validateSubscription(fakeSub(host)).error, host);
  }
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url']) {
    assert.ok(push.validateSubscription({ ...fakeSub(), endpoint }).error, endpoint);
  }
  assert.ok(push.validateSubscription({ ...fakeSub(), keys: { p256dh: 'short', auth: 'x' } }).error);

  assert.equal(push.categoryForKind('chat'), 'mentions');
  assert.equal(push.categoryForKind('attacked-lost'), 'attacks');
  assert.equal(push.categoryForKind('tutorial'), null);

  const defaults = push.normalizePrefs({}, { useDefaults: true });
  assert.ok(defaults.categories.includes('mentions') && !defaults.categories.includes('energy'));
  assert.deepEqual(push.normalizePrefs({ categories: ['energy', 'bogus'], quietFrom: '5', quietTo: '5', tz: 'Mars/Base' }), { categories: ['energy'], quietFrom: null, quietTo: null, tz: 'UTC' });

  // Quiet hours wrap past midnight and follow the player's time zone.
  const at = (iso) => Date.parse(iso);
  const night = { quietFrom: 23, quietTo: 7, tz: 'UTC' };
  assert.equal(push.inQuietHours(night, at('2026-10-17T23:30:00Z')), true);
  assert.equal(push.inQuietHours(night, at('2026-10-17T06:59:00Z')), true);
  assert.equal(push.inQuietHours(night, at('2026-10-17T07:00:00Z')), false);
  assert.equal(push.inQuietHours({ quietFrom: 9, quietTo: 17, tz: 'UTC' }, at('2026-10-17T12:00:00Z')), true);
  assert.equal(push.inQuietHours({ ...night, tz: 'America/New_York' }, at('2026-10-17T12:00:00Z')), false); // 08:00 there
  assert.equal(push.inQuietHours({ ...night, tz: 'America/New_York' }, at('2026-10-17T05:00:00Z')), true); // 01:00 there

  // Links stay on the site.
  assert.equal(push.payloadFor('attacks', 'x', 'https://evil.example').url, '/notifications');
  assert.equal(push.payloadFor('attacks', 'x', '//evil.example').url, '/notifications');
  assert.deepEqual(push.payloadFor('mentions', 'Hi', '/chat/global#m-4'), { title: 'You were mentioned', body: 'Hi', url: '/chat/global#m-4', tag: 'mentions' });
  assert.equal(push.deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(push.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari on iPhone/iPad');
});

test('push alerts end to end', async () => {
  const sent = [];
  let failWith = null;
  const pushSender = async (sub, payload, options) => {
    if (failWith) { const e = new Error('push failed'); e.statusCode = failWith; throw e; }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
  };
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false, pushSender });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form, json, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: {
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(json ? { 'content-type': 'application/json', accept: 'application/json' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text() };
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
  const settle = async () => { await new Promise((r) => setImmediate(r)); await app.push.settle(); };
  try {
    // The app shell: manifest and a service worker that browsers re-check.
    const sw = await client().request('/sw.js');
    assert.equal(sw.res.headers.get('cache-control'), 'no-cache');
    assert.match(sw.res.headers.get('content-type'), /javascript/);
    assert.match(sw.text, /const VERSION = '[0-9a-f]{12}'/);
    const manifest = JSON.parse((await client().request('/manifest.webmanifest')).text);
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    assert.match((await client().request('/offline.html')).text, /You’re offline/);

    const alpha = await join('Alpha');
    const bravo = await join('Bravo');
    db.prepare('UPDATE users SET level = 5').run();

    // The page shows the server's public key and every category.
    let page = (await alpha.request('/account/alerts')).text;
    const key = page.match(/data-public-key="([^"]+)"/)[1];
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    for (const c of push.CATEGORIES) assert.ok(page.includes(c.name), c.name);
    assert.match((await alpha.request('/notifications')).text, /href="\/account\/alerts"/);

    // Subscribing needs the CSRF token and a real push service.
    const token = await alpha.csrf('/account/alerts');
    const sub = fakeSub();
    assert.equal((await alpha.request('/push/subscribe', { method: 'POST', json: { subscription: sub } })).res.status, 403);
    assert.equal((await alpha.request('/push/subscribe', { method: 'POST', json: { subscription: { ...sub, endpoint: 'https://169.254.169.254/latest' } }, headers: { 'x-csrf-token': token } })).res.status, 400);
    let r = await alpha.request('/push/subscribe', { method: 'POST', json: { subscription: sub, tz: 'Europe/London' }, headers: { 'x-csrf-token': token, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36' } });
    assert.deepEqual(JSON.parse(r.text), { ok: true, device: 'Chrome on Android' });
    let prefs = JSON.parse(db.prepare('SELECT push_prefs FROM users WHERE id = ?').get(alpha.id).push_prefs);
    assert.ok(prefs.categories.includes('mentions'));
    assert.equal(prefs.tz, 'Europe/London');
    assert.match((await alpha.request('/account/alerts')).text, /Chrome on Android/);

    // A chat mention reaches Alpha's phone.
    await bravo.request('/chat/global', { method: 'POST', form: { _csrf: await bravo.csrf('/chat/global'), body: 'Over here @Alpha' } });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, sub.endpoint);
    assert.equal(sent[0].payload.title, 'You were mentioned');
    assert.match(sent[0].payload.body, /Bravo mentioned you in Global chat/);
    assert.match(sent[0].payload.url, /^\/chat\/global#m-\d+$/);
    assert.equal(sent[0].options.urgency, 'high');

    // A private message too.
    await bravo.request('/messages', { method: 'POST', form: { _csrf: await bravo.csrf('/messages/new'), to: 'Alpha', subject: 'Truce?', body: 'Let’s talk' } });
    await settle();
    assert.equal(sent.at(-1).payload.title, 'New message');
    assert.equal(sent.at(-1).payload.body, 'Bravo: Truce?');

    // While Alpha has the game open in front of them, nothing is pushed.
    await alpha.request('/notifications/poll?after=0&visible=1', { headers: { accept: 'application/json' } });
    const before = sent.length;
    players(app).notify(alpha.id, 'attacked-lost', 'Bravo attacked you', '/battles/1');
    await settle();
    assert.equal(sent.length, before);
    app.push.markVisible(alpha.id, 0); // tab closed long ago

    // Categories they switched off don't push; kinds with no category never do.
    await alpha.request('/account/alerts', { method: 'POST', form: { _csrf: await alpha.csrf('/account/alerts'), categories: 'messages', tz: 'UTC' } });
    players(app).notify(alpha.id, 'chat', 'Bravo mentioned you', '/chat/global');
    players(app).notify(alpha.id, 'tutorial', 'Step done', '/hq');
    players(app).notify(alpha.id, 'attacked-lost', 'Bravo attacked you', '/battles/1');
    await settle();
    assert.equal(sent.length, before);

    // Quiet hours hold alerts back.
    const hour = new Date().getUTCHours();
    await alpha.request('/account/alerts', { method: 'POST', form: [['_csrf', await alpha.csrf('/account/alerts')], ['categories', 'messages'], ['categories', 'attacks'], ['quiet', 'on'], ['quietFrom', String(hour)], ['quietTo', String((hour + 2) % 24)], ['tz', 'UTC']] });
    assert.deepEqual(JSON.parse(db.prepare('SELECT push_prefs FROM users WHERE id = ?').get(alpha.id).push_prefs).categories, ['messages', 'attacks']);
    players(app).notify(alpha.id, 'attacked-lost', 'Bravo attacked you', '/battles/1');
    await settle();
    assert.equal(sent.length, before);
    await alpha.request('/account/alerts', { method: 'POST', form: [['_csrf', await alpha.csrf('/account/alerts')], ['categories', 'messages'], ['categories', 'attacks'], ['categories', 'energy'], ['tz', 'UTC']] });
    players(app).notify(alpha.id, 'attacked-lost', 'Bravo attacked you', '/battles/1');
    await settle();
    assert.equal(sent.at(-1).payload.title, 'You were attacked');

    // "Energy full" once per refill.
    db.prepare('UPDATE users SET energy = 0, energy_updated_at = ? WHERE id = ?').run(Date.now() - 24 * 60 * 60 * 1000, alpha.id);
    assert.equal(await app.push.checkEnergy(), 1);
    assert.equal(sent.at(-1).payload.title, 'Energy full');
    assert.equal(await app.push.checkEnergy(), 0);

    // The test button ignores settings.
    r = await alpha.request('/account/alerts/test', { method: 'POST', json: { _csrf: await alpha.csrf('/account/alerts') } });
    assert.equal(JSON.parse(r.text).ok, true);

    // The browser swapped its subscription: the service worker reports it without a CSRF token.
    const fresh = fakeSub();
    assert.equal((await client().request('/push/renew', { method: 'POST', form: { old: sub.endpoint } })).res.status, 415);
    assert.equal((await client().request('/push/renew', { method: 'POST', json: { old: 'https://fcm.googleapis.com/fcm/send/nope', subscription: fresh } })).res.status, 404);
    assert.equal((await client().request('/push/renew', { method: 'POST', json: { old: sub.endpoint, subscription: fresh } })).res.status, 200);
    assert.equal(db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').get(alpha.id).endpoint, fresh.endpoint);

    // A subscription the browser dropped (410) is deleted.
    failWith = 410;
    players(app).notify(alpha.id, 'attacked-won', 'You held off Bravo', '/battles/2');
    await settle();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
    failWith = null;

    // Turning alerts off and removing devices.
    const again = fakeSub();
    const t2 = await alpha.csrf('/account/alerts');
    await alpha.request('/push/subscribe', { method: 'POST', json: { subscription: again }, headers: { 'x-csrf-token': t2 } });
    assert.equal(JSON.parse((await bravo.request('/push/unsubscribe', { method: 'POST', json: { endpoint: again.endpoint }, headers: { 'x-csrf-token': await bravo.csrf() } })).text).removed, false);
    assert.equal(JSON.parse((await alpha.request('/push/unsubscribe', { method: 'POST', json: { endpoint: again.endpoint }, headers: { 'x-csrf-token': t2 } })).text).removed, true);
  } finally {
    server.close();
  }
});

// The player repository the app was built with (notify() is what game code calls).
function players(app) {
  return app.players;
}
