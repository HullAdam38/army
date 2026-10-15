'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { legalSettings, TERMS_VERSION } = require('../src/legal');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('legal settings show placeholders until configured', () => {
  const blank = legalSettings({});
  assert.deepEqual(blank.missing, ['LEGAL_OPERATOR', 'LEGAL_CONTACT_EMAIL', 'LEGAL_JURISDICTION']);
  assert.match(blank.operator, /set LEGAL_OPERATOR/);
  assert.equal(blank.hasContact, false);
  const set = legalSettings({ LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@example.com', LEGAL_JURISDICTION: 'England and Wales' });
  assert.deepEqual(set.missing, []);
  assert.equal(set.operator, 'Hull Games');
  assert.equal(set.retention.signInDays, 90);
  assert.equal(set.retention.actionDays, 14);
});

test('terms page, acceptance at sign-up, and re-acceptance when the terms change', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async (from) => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  try {
    // Public, with every section, real retention figures and placeholders.
    const page = await request('/terms');
    assert.equal(page.res.status, 200);
    for (const h of ['Who can play', 'Fair play', 'Virtual items and currency', 'Your data', 'Governing law']) assert.match(page.text, new RegExp(h));
    assert.match(page.text, /kept for 90 days/);
    assert.match(page.text, /set LEGAL_OPERATOR/);
    assert.match((await request('/')).text, /href="\/terms"/); // footer link
    assert.match((await request('/register')).text, /href="\/terms" target="_blank"/);

    // Registering records the accepted version.
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username: 'Signer', email: 's@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    const row = db.prepare("SELECT terms_version, terms_accepted_at FROM users WHERE username = 'Signer'").get();
    assert.equal(row.terms_version, TERMS_VERSION);
    assert.ok(row.terms_accepted_at > 0);
    assert.equal((await request('/hq')).res.status, 200);

    // The terms change: the player must accept again before playing.
    db.prepare("UPDATE users SET terms_version = '2000-01-01' WHERE username = 'Signer'").run();
    let r = await request('/missions');
    assert.equal(r.location, '/terms/accept');
    assert.equal((await request('/missions', { headers: { accept: 'application/json' } })).res.status, 403);
    const acceptPage = (await request('/terms/accept')).text;
    assert.match(acceptPage, /Our Terms of Service have changed/);
    const token = acceptPage.match(/name="_csrf" value="([^"]+)"/)[1];
    r = await request('/terms/accept', { method: 'POST', form: { _csrf: token } });
    assert.equal(r.location, '/terms/accept#accept');
    assert.equal(db.prepare("SELECT terms_version FROM users WHERE username = 'Signer'").get().terms_version, '2000-01-01');
    r = await request('/terms/accept', { method: 'POST', form: { _csrf: token, agree: 'on' } });
    assert.equal(r.location, '/missions'); // back to where they were going
    assert.equal(db.prepare("SELECT terms_version FROM users WHERE username = 'Signer'").get().terms_version, TERMS_VERSION);
    assert.equal((await request('/missions')).res.status, 200);
    assert.equal((await request('/terms/accept')).location, '/hq');
  } finally {
    server.close();
  }
});
