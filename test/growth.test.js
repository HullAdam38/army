'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

async function start() {
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
      async register(name) {
        const r = await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
        c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
        return r;
      },
    };
    return c;
  };
  return { db, app, server, base, client };
}

test('recruit a friend: invite link, sign-up, reward at level 10, and no reward for linked accounts', async () => {
  const { db, app, server, client } = await start();
  try {
    const rec = client();
    await rec.register('Recruiter');
    const cash = (id) => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;

    // The recruit page shows the link.
    let page = (await rec.request('/account/recruit')).text;
    assert.match(page, /\/join\/Recruiter/);
    assert.match(page, /Nobody has joined from your link yet/);

    // A friend follows it: sign-up shows who invited them, and the recruiter hears about it.
    const friend = client();
    assert.equal((await friend.request('/join/Recruiter')).location, '/register');
    assert.match((await friend.request('/register')).text, /<strong>Recruiter<\/strong> invited you/);
    await friend.register('Friend');
    assert.equal(db.prepare('SELECT referred_by FROM users WHERE id = ?').get(friend.id).referred_by, rec.id);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(rec.id).message, /Friend joined GeneralForces from your invite link/);
    assert.match((await rec.request('/account/recruit')).text, /Level 1 of 10/);

    // Nothing until level 10, then both are paid once.
    assert.equal(app.referrals.check(friend.id), null);
    db.prepare('UPDATE users SET level = 10 WHERE id = ?').run(friend.id);
    const before = { rec: cash(rec.id), friend: cash(friend.id) };
    const out = app.referrals.check(friend.id);
    assert.deepEqual(out.paid, { cash: 2500, xp: 250, recruit: 1000 });
    assert.equal(cash(rec.id), before.rec + 2500);
    assert.equal(cash(friend.id), before.friend + 1000);
    assert.equal(app.referrals.check(friend.id), null, 'once only');
    page = (await rec.request('/account/recruit')).text;
    assert.match(page, /Rewarded · \+\$2,500/);

    // A "friend" on the recruiter's own device earns nothing.
    const alt = client();
    await alt.request('/join/Recruiter');
    await alt.register('AltAccount');
    const device = db.prepare('SELECT device_id FROM sign_ins WHERE user_id = ? AND device_id IS NOT NULL LIMIT 1').get(rec.id).device_id;
    db.prepare('INSERT INTO sign_ins (user_id, ip_hash, device_id, user_agent, created_at) VALUES (?, NULL, ?, NULL, ?)').run(alt.id, device, Date.now());
    db.prepare('UPDATE users SET level = 12 WHERE id = ?').run(alt.id);
    const r2 = app.referrals.check(alt.id);
    assert.match(r2.void, /share a device or network/);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(rec.id).message, /no recruit reward was paid/);
    assert.match((await rec.request('/account/recruit')).text, /No reward/);

    // The monthly cap.
    tuning.set({ referralMaxPerMonth: 1 });
    const late = client();
    await late.request('/join/Recruiter');
    await late.register('LateFriend');
    db.prepare('UPDATE users SET level = 10 WHERE id = ?').run(late.id);
    assert.match(app.referrals.check(late.id).void, /monthly limit/);

    // Anti-cheat flags the shared device for staff too.
    assert.ok(app.anti.runScan().newFlags > 0);
  } finally {
    server.close();
    tuning.reset();
  }
});

test('invite links ignore unknown players and reserve soldiers', async () => {
  const { db, app, server, client } = await start();
  tuning.set({ reserveSoldiers: 5 });
  try {
    app.reserve.tick();
    const bot = db.prepare('SELECT username FROM users WHERE is_bot = 1 LIMIT 1').get().username;
    for (const name of ['Nobody', bot]) {
      const c = client();
      await c.request(`/join/${name}`);
      assert.doesNotMatch((await c.request('/register')).text, /invited you/);
    }
  } finally {
    server.close();
    tuning.reset();
  }
});

test('search engines and link previews', async () => {
  const { server, client } = await start();
  try {
    const guest = client();
    let r = await guest.request('/robots.txt');
    assert.match(r.text, /Disallow: \//);
    assert.match(r.text, /Allow: \/register/);
    assert.match(r.text, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/);
    r = await guest.request('/sitemap.xml');
    assert.match(r.res.headers.get('content-type'), /xml/);
    assert.match(r.text, /<loc>http:\/\/127\.0\.0\.1:\d+\/terms<\/loc>/);

    const home = (await guest.request('/')).text;
    assert.match(home, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/img\/og\.png">/);
    assert.match(home, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(home, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/">/);
    assert.match(home, /"@type":"VideoGame"/);
    assert.match(home, /img\/screens\/missions\.jpg/);
    assert.doesNotMatch(home, /noindex/);

    // Game pages are private: signed-in pages ask search engines not to index them.
    await guest.register('Indexed');
    assert.match((await guest.request('/hq')).text, /<meta name="robots" content="noindex">/);
  } finally {
    server.close();
  }
});
