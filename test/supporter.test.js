'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supporter = require('../src/supporter');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'whsec-test';
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

// A Lemon Squeezy subscription webhook body.
const subEvent = (event, { userId, id = '501', status = 'active', renewsAt = null, endsAt = null, updatedAt = null, extra = '' } = {}) => JSON.stringify({
  meta: { event_name: event, custom_data: userId ? { user_id: String(userId) } : undefined, extra },
  data: { type: 'subscriptions', id, attributes: { status, renews_at: renewsAt, ends_at: endsAt, updated_at: updatedAt, user_email: 'x@x.com', urls: { customer_portal: 'https://store.lemonsqueezy.com/billing?x=1' } } },
});

test('supporter rules: who is a member, signatures and webhooks', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(supporter.isActive(null, now), false);
  assert.equal(supporter.isActive({ supporter_until: now + 1 }, now), true);
  assert.equal(supporter.isActive({ supporter_until: now }, now), false);

  const url = new URL(supporter.checkoutUrl('https://gf.lemonsqueezy.com/checkout/buy/abcdef12', { id: 7, email: 'a@b.com' }));
  assert.equal(url.searchParams.get('checkout[custom][user_id]'), '7');
  assert.equal(url.searchParams.get('checkout[email]'), 'a@b.com');
  assert.equal(supporter.checkoutUrl('', { id: 7 }), null);

  const body = Buffer.from('{"a":1}');
  assert.equal(supporter.verifySignature(body, sign(body), SECRET), true);
  assert.equal(supporter.verifySignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(supporter.verifySignature(body, 'short', SECRET), false);
  assert.equal(supporter.verifySignature(body, sign(body), ''), false, 'no secret, no trust');

  const renews = '2026-11-01T00:00:00Z';
  let c = supporter.readWebhook(JSON.parse(subEvent('subscription_created', { userId: 3, renewsAt: renews })), now);
  assert.equal(c.userId, 3);
  assert.equal(c.subscriptionId, '501');
  assert.equal(c.until, Date.parse(renews) + supporter.GRACE_MS);
  c = supporter.readWebhook(JSON.parse(subEvent('subscription_cancelled', { status: 'cancelled', endsAt: renews })), now);
  assert.equal(c.until, Date.parse(renews));
  assert.equal(c.userId, null);
  assert.equal(supporter.readWebhook(JSON.parse(subEvent('subscription_expired', { status: 'expired' })), now).until, 0);
  const inv = supporter.readWebhook({ meta: { event_name: 'subscription_payment_success' }, data: { type: 'subscription-invoices', id: '9', attributes: { subscription_id: 501, total: 400, currency: 'GBP', status: 'paid' } } }, now);
  assert.deepEqual([inv.invoiceOnly, inv.amount, inv.currency, inv.subscriptionId], [true, 400, 'GBP', '501']);
  assert.equal(supporter.readWebhook({ meta: { event_name: 'order_created' }, data: { type: 'orders', attributes: {} } }, now), null);
  assert.equal(supporter.readWebhook({}, now), null);
});

test('Supporter membership: checkout, webhooks, perks, lapsing and HQ gifts', async () => {
  const saved = Object.fromEntries(['SUPPORTER_CHECKOUT_URL', 'SUPPORTER_PRICE', 'LEMONSQUEEZY_WEBHOOK_SECRET'].map((k) => [k, process.env[k]]));
  delete process.env.SUPPORTER_CHECKOUT_URL;
  delete process.env.SUPPORTER_PRICE;
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;

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
      async post(p, form = {}) { return c.request(p, { method: 'POST', form: { _csrf: await c.csrf(), ...form } }); },
      async flash(p, form = {}) {
        const r = await c.post(p, form);
        const page = (await c.request(r.location)).text;
        const m = page.match(/<p class="flash flash--(\w+)">([^<]*)<\/p>/);
        return { message: m ? m[2] : '', page };
      },
    };
    return c;
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const hook = (body, signature = sign(body)) => fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body });
  const lastNote = (id) => db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id).message;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  try {
    const boss = await enlist('Boss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const ace = await enlist('Ace');
    const cy = await enlist('Cyrus');

    // Not open yet: the page says so and joining goes nowhere.
    assert.match((await ace.request('/supporter')).text, /Supporter membership opens soon/);
    let r = await ace.request('/supporter/join');
    assert.equal(r.location, '/supporter');

    // Open: joining sends the player to the checkout with their account on it.
    process.env.SUPPORTER_CHECKOUT_URL = 'https://gf.lemonsqueezy.com/checkout/buy/abcdef12-3456';
    process.env.SUPPORTER_PRICE = '£4 a month';
    let page = (await ace.request('/supporter')).text;
    assert.match(page, /£4 a month/);
    assert.match(page, /href="\/supporter\/join"/);
    r = await ace.request('/supporter/join');
    assert.equal(r.res.status, 303);
    const to = new URL(r.location);
    assert.equal(to.host, 'gf.lemonsqueezy.com');
    assert.equal(to.searchParams.get('checkout[custom][user_id]'), String(ace.id));
    assert.equal(to.searchParams.get('checkout[email]'), 'ace@x.com');

    // Webhooks must be signed, and must be JSON.
    const renews = new Date(Date.now() + 30 * DAY).toISOString();
    const created = subEvent('subscription_created', { userId: ace.id, renewsAt: renews });
    assert.equal((await hook(created, sign(created, 'wrong'))).status, 401);
    assert.equal((await hook(created, '')).status, 401);
    assert.equal((await hook('not json')).status, 400);
    assert.equal(user(ace.id).supporter_until, null);

    // A new subscription: Ace is a Supporter and is thanked.
    assert.equal((await hook(created)).status, 200);
    let u = user(ace.id);
    assert.equal(u.supporter_until, Date.parse(renews) + supporter.GRACE_MS);
    assert.equal(u.supporter_source, 'lemonsqueezy');
    assert.equal(u.supporter_sub_id, '501');
    assert.match(lastNote(ace.id), /Thank you for becoming a Supporter/);
    const notes = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(ace.id).n;
    // The same delivery twice changes nothing.
    assert.equal((await hook(created)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(ace.id).n, notes);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n, 1);

    page = (await ace.request('/supporter')).text;
    assert.match(page, /Active, renewing around/);
    assert.match(page, /href="https:\/\/gf\.lemonsqueezy\.com\/billing"/);
    // The tag shows on their profile and in the players list.
    assert.match((await boss.request('/profile/Ace')).text, /tag--supporter/);

    // Perks: every Supporter look, and six medal pins.
    let f = await ace.flash('/account/wardrobe', { kind: 'name', id: 'name-crimson' });
    assert.doesNotMatch(f.message, /locked/);
    await ace.flash('/account/wardrobe', { kind: 'banner', id: 'banner-night' });
    assert.equal(user(ace.id).profile_banner, 'banner-night');
    assert.ok(app.avatars && app.cosmetics.ownedSet);
    const medalIds = ['operator', 'combat', 'knockout', 'ironwall', 'drill', 'service', 'merit'];
    for (const m of medalIds) db.prepare('INSERT INTO user_medals (user_id, medal_id, tier, awarded_at) VALUES (?, ?, 1, 0)').run(ace.id, m);
    const pinForm = [['_csrf', await ace.csrf('/medals')], ...medalIds.map((m) => ['pin', m])];
    r = await ace.request('/medals/pins', { method: 'POST', form: pinForm });
    assert.match((await ace.request(r.location)).text, /up to 6 medals/);
    assert.equal(user(ace.id).pinned_medals.split(',').length, 6);

    // A renewal payment is logged for Admin › Supporters (found by its subscription).
    const paid = JSON.stringify({ meta: { event_name: 'subscription_payment_success' }, data: { type: 'subscription-invoices', id: '77', attributes: { subscription_id: 501, total: 400, currency: 'GBP', status: 'paid' } } });
    assert.equal((await hook(paid)).status, 200);
    page = (await boss.request('/admin/supporters')).text;
    assert.match(page, /£4\.00 \(1\)/);
    assert.match(page, /subscription_payment_success/);
    assert.match(page, /href="\/admin\/players\/\d+#supporter">Ace</);

    // Someone else's subscription naming Ace's account can't end Ace's membership.
    const untilNow = user(ace.id).supporter_until;
    assert.equal((await hook(subEvent('subscription_expired', { userId: ace.id, id: '999', status: 'expired' }))).status, 200);
    assert.equal(user(ace.id).supporter_until, untilNow);
    assert.equal(user(ace.id).supporter_sub_id, '501');
    // Deliveries out of order: an older update doesn't undo a newer one.
    const later = new Date(Date.now() + 40 * DAY).toISOString();
    await hook(subEvent('subscription_updated', { renewsAt: later, updatedAt: '2026-10-20T12:00:00Z' }));
    assert.equal(user(ace.id).supporter_until, Date.parse(later) + supporter.GRACE_MS);
    await hook(subEvent('subscription_updated', { status: 'expired', updatedAt: '2026-10-20T11:00:00Z' }));
    assert.equal(user(ace.id).supporter_until, Date.parse(later) + supporter.GRACE_MS, 'the stale "expired" is ignored');

    // Cancelling keeps the perks to the end of the paid month (found by subscription id, no custom data).
    const ends = new Date(Date.now() + 10 * DAY).toISOString();
    assert.equal((await hook(subEvent('subscription_cancelled', { status: 'cancelled', endsAt: ends, updatedAt: '2026-10-20T13:00:00Z' }))).status, 200);
    assert.equal(user(ace.id).supporter_until, Date.parse(ends));
    assert.match(lastNote(ace.id), /cancelled and ends on/);
    assert.match((await ace.request('/supporter')).text, /Cancelled: your perks last until/);

    // Expired: perks off at once, and Supporter-only looks come off.
    assert.equal((await hook(subEvent('subscription_expired', { status: 'expired', updatedAt: '2026-10-20T14:00:00Z' }))).status, 200);
    u = user(ace.id);
    assert.equal(supporter.isActive(u), false);
    assert.equal(u.profile_banner, null);
    assert.notEqual(u.supporter_lapsed_at, null);
    assert.doesNotMatch((await boss.request('/profile/Ace')).text, /tag--supporter/);
    assert.match((await ace.request('/supporter')).text, /Become a Supporter/);

    // The sweep catches memberships that just ran out (no webhook needed), once.
    db.prepare("UPDATE users SET supporter_until = ?, supporter_since = 1, supporter_source = 'lemonsqueezy', profile_banner = 'banner-night' WHERE id = ?").run(Date.now() - 1, cy.id);
    assert.equal(app.supporters.sweep(), 1);
    assert.equal(user(cy.id).profile_banner, null);
    assert.match(lastNote(cy.id), /membership has ended/);
    assert.equal(app.supporters.sweep(), 0);

    // HQ gifts: admins only, a reason, a sensible length, all audited.
    assert.equal((await ace.post(`/admin/players/${ace.id}/supporter`, { days: '30', reason: 'x', action: 'gift' })).res.status, 404);
    f = await boss.flash(`/admin/players/${ace.id}/supporter`, { days: '30', reason: '', action: 'gift' });
    assert.match(f.message, /Give a reason/);
    f = await boss.flash(`/admin/players/${ace.id}/supporter`, { days: '0', reason: 'x', action: 'gift' });
    assert.match(f.message, /1 to 3,660/);
    f = await boss.flash(`/admin/players/${ace.id}/supporter`, { days: '30', reason: 'Bug bounty', action: 'gift' });
    assert.match(f.message, /Ace is a Supporter until/);
    u = user(ace.id);
    assert.equal(u.supporter_source, 'admin');
    assert.ok(Math.abs(u.supporter_until - (Date.now() + 30 * DAY)) < 60 * 1000);
    assert.match(lastNote(ace.id), /HQ made you a Supporter/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'supporter-gift'").get().details, /30 days.*Reason: Bug bounty/);
    assert.match((await ace.request('/supporter')).text, /A gift from HQ/);
    assert.match((await boss.request(`/admin/players/${ace.id}`)).text, /id="supporter"/);

    // A paid renewal that ends sooner doesn't cut the gift short.
    const soon = new Date(Date.now() + 2 * DAY).toISOString();
    await hook(subEvent('subscription_updated', { userId: ace.id, renewsAt: soon, extra: 'again' }));
    assert.equal(user(ace.id).supporter_until, u.supporter_until);

    // Ending a gift: only gifts, and the looks come off.
    db.prepare("UPDATE users SET supporter_source = 'admin', profile_banner = 'banner-night' WHERE id = ?").run(ace.id);
    f = await boss.flash(`/admin/players/${ace.id}/supporter`, { reason: 'Ended early', action: 'end' });
    assert.match(f.message, /Gift membership ended/);
    assert.equal(supporter.isActive(user(ace.id)), false);
    assert.equal(user(ace.id).profile_banner, null);
    f = await boss.flash(`/admin/players/${ace.id}/supporter`, { reason: 'Again', action: 'end' });
    assert.match(f.message, /don’t have a gift/);
    assert.ok(db.prepare("SELECT 1 FROM admin_actions WHERE action = 'supporter-end'").get());
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the site address never takes an odd Host header', async () => {
  const saved = process.env.SITE_URL;
  delete process.env.SITE_URL;
  const app = createApp({ db: openDatabase(':memory:'), secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  const get = (host) => new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port, path: '/sitemap.xml', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  try {
    assert.match(await get('play.example.com:8080'), /<loc>http:\/\/play\.example\.com:8080\/<\/loc>/);
    const evil = await get('x"><evil>');
    assert.doesNotMatch(evil, /evil/);
    assert.match(evil, /<loc>http:\/\/localhost\/<\/loc>/);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved;
  }
});
