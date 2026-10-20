'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerSettings, parse, FIELDS } = require('../src/server-settings');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-server-')), 'admin-settings.env');

test('only known, valid settings are read from the file', () => {
  const out = parse([
    'LEGAL_OPERATOR=Hull Games',
    'SESSION_SECRET=stolen',
    'SITE_URL=javascript:alert(1)',
    'BACKUP_REMOTE=--config=/etc/passwd',
    'BACKUP_REMOTE_KEEP_DAYS=$(reboot)',
    '# a comment',
    'LEGAL_CONTACT_EMAIL=support@generalforces.com',
  ].join('\n'));
  assert.deepEqual(out, { LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@generalforces.com' });
  assert.ok(!FIELDS.some((f) => ['SESSION_SECRET', 'NODE_ENV', 'DB_FILE', 'PORT', 'TRUST_PROXY'].includes(f.key)), 'nothing that could take over the server');
});

test('saving overrides the server file, and clearing goes back to it', () => {
  const file = tmpFile();
  const env = { LEGAL_OPERATOR: 'Your name or company', LEGAL_JURISDICTION: 'England and Wales', SESSION_SECRET: 'abc' };
  const s = createServerSettings(file, env);
  let legal = s.view().find((g) => g.id === 'legal').fields;
  assert.deepEqual(legal.map((f) => f.source), ['server', 'unset', 'server']);

  let out = s.save({ LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'not an email', SITE_URL: 'https://generalforces.com/' });
  assert.match(out.errors.LEGAL_CONTACT_EMAIL, /email address/);
  assert.match(out.errors.SITE_URL, /just the address/);
  assert.equal(env.LEGAL_OPERATOR, 'Your name or company', 'nothing saved while anything is wrong');
  assert.ok(!fs.existsSync(file));

  out = s.save({ LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@generalforces.com', SITE_URL: 'https://generalforces.com', BACKUP_REMOTE: 'b2:bucket/gf' });
  assert.deepEqual(out.changed, ['LEGAL_OPERATOR', 'LEGAL_CONTACT_EMAIL', 'SITE_URL', 'BACKUP_REMOTE']);
  assert.equal(env.LEGAL_OPERATOR, 'Hull Games');
  assert.equal(env.SITE_URL, 'https://generalforces.com');
  assert.equal(env.SESSION_SECRET, 'abc');
  assert.match(fs.readFileSync(file, 'utf8'), /^LEGAL_OPERATOR=Hull Games$/m);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SESSION_SECRET/);
  assert.deepEqual(s.save({ LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@generalforces.com', SITE_URL: 'https://generalforces.com', BACKUP_REMOTE: 'b2:bucket/gf' }).changed, []);

  // A fresh start reads the saved file.
  const env2 = { LEGAL_OPERATOR: 'Your name or company' };
  createServerSettings(file, env2);
  assert.equal(env2.LEGAL_OPERATOR, 'Hull Games');

  // Clearing a field: the server file's value applies again.
  s.save({ LEGAL_CONTACT_EMAIL: 'support@generalforces.com' });
  assert.equal(env.LEGAL_OPERATOR, 'Your name or company');
  assert.equal(env.SITE_URL, undefined);
  legal = s.view().find((g) => g.id === 'legal').fields;
  assert.deepEqual(legal.map((f) => f.source), ['server', 'here', 'server']);
  assert.deepEqual(s.serverOnly().find((x) => x.key === 'SESSION_SECRET'), { key: 'SESSION_SECRET', value: 'set (hidden)' });
});

test('Admin › Server settings: password to save, live terms, audit log', async () => {
  const keys = FIELDS.map((f) => f.key);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const file = tmpFile();
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false, serverSettingsFile: file });
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
        await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
    return c;
  };
  try {
    const boss = client();
    await boss.register('Boss');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
    const pleb = client();
    await pleb.register('Pleb');
    assert.equal((await pleb.request('/admin/server')).res.status, 404);
    assert.equal((await pleb.request('/admin/server', { method: 'POST', form: { _csrf: await pleb.csrf(), LEGAL_OPERATOR: 'Pwned', password: 'password123' } })).res.status, 404);

    let page = (await boss.request('/admin/server')).text;
    assert.match(page, /Server settings/);
    assert.match(page, /name="LEGAL_OPERATOR"/);
    assert.doesNotMatch(page, /name="SESSION_SECRET"/);
    assert.match(page, /Only changeable on the server/);

    // Wrong password: nothing changes.
    let r = await boss.request('/admin/server', { method: 'POST', form: { _csrf: await boss.csrf('/admin/server'), LEGAL_OPERATOR: 'Hull Games', password: 'nope' } });
    assert.equal(r.res.status, 422);
    assert.match(r.text, /That password isn’t right/);
    assert.match(r.text, /value="Hull Games"/, 'what they typed is kept');
    assert.ok(!fs.existsSync(file));
    // Guessing is throttled: five wrong tries lock the form for a while, even with the right password.
    const deputy = client();
    await deputy.register('Deputy');
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Deputy'").run();
    for (let i = 0; i < 5; i += 1) await deputy.request('/admin/server', { method: 'POST', form: { _csrf: await deputy.csrf('/admin/server'), password: `guess${i}` } });
    r = await deputy.request('/admin/server', { method: 'POST', form: { _csrf: await deputy.csrf('/admin/server'), LEGAL_OPERATOR: 'Hull Games', password: 'password123' } });
    assert.equal(r.res.status, 429);
    assert.match(r.text, /Too many wrong attempts/);
    assert.ok(!fs.existsSync(file));

    // Saved: the terms show it at once, and it's in the audit log.
    r = await boss.request('/admin/server', { method: 'POST', form: { _csrf: await boss.csrf('/admin/server'), LEGAL_OPERATOR: 'Hull Games', LEGAL_CONTACT_EMAIL: 'support@generalforces.com', LEGAL_JURISDICTION: 'England and Wales', SESSION_SECRET: 'ignored', password: 'password123' } });
    assert.equal(r.location, '/admin/server');
    page = (await boss.request('/admin/server')).text;
    assert.match(page, /Saved: LEGAL_OPERATOR, LEGAL_CONTACT_EMAIL, LEGAL_JURISDICTION/);
    assert.match((await boss.request('/terms')).text, /Hull Games/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'server-settings'").get().details, /LEGAL_OPERATOR/);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SESSION_SECRET/);
    assert.match((await boss.request('/admin/launch')).text, /Hull Games/, 'the launch checklist sees it too');

    // Invalid values are shown against their field.
    r = await boss.request('/admin/server', { method: 'POST', form: { _csrf: await boss.csrf('/admin/server'), LEGAL_CONTACT_EMAIL: 'nope', password: 'password123' } });
    assert.equal(r.res.status, 422);
    assert.match(r.text, /Enter an email address/);
  } finally {
    server.close();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
