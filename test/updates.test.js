'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('patch notes: admins post them, everyone can read them, HQ flags unread ones', async () => {
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
    db.prepare('UPDATE users SET created_at = created_at - 86400000 WHERE id = ?').run(c.id); // signed up yesterday
    return c;
  };
  try {
    const boss = await enlist('Boss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const ace = await enlist('Ace');

    // Nothing yet: no notice, an empty page anyone can open.
    assert.doesNotMatch((await ace.request('/hq')).text, /New update:/);
    assert.match((await client().request('/updates')).text, /No updates posted yet/);
    assert.match((await client().request('/robots.txt')).text, /Allow: \/updates/);

    // Admins only, with a title and a body.
    assert.equal((await ace.request('/admin/updates')).res.status, 404);
    assert.equal((await ace.post('/admin/updates', { title: 'x', body: 'y' })).res.status, 404);
    let f = await boss.flash('/admin/updates', { title: '', body: 'stuff' });
    assert.match(f.message, /Give the update a title/);
    assert.match(f.page, /stuff/, 'the draft is kept');
    f = await boss.flash('/admin/updates', { title: 'Update 0.4: the market opens', body: '[b]New[/b]\n[list]\n[*]The market\n[*]Special operations\n[/list]\n<script>alert(1)</script>' });
    assert.match(f.message, /Update posted/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'patch-notes-post'").get().details, /the market opens/);

    // The page renders BBCode, safely, for everyone.
    let page = (await client().request('/updates')).text;
    assert.match(page, /Update 0\.4: the market opens/);
    assert.match(page, /<strong>New<\/strong>/);
    assert.match(page, /<li>The market<\/li>/);
    assert.doesNotMatch(page, /<script>alert/);

    // HQ flags it until Ace reads it.
    assert.match((await ace.request('/hq')).text, /New update: <a href="\/updates#u-\d+"><strong>Update 0\.4: the market opens/);
    await ace.request('/updates');
    assert.doesNotMatch((await ace.request('/hq')).text, /New update:/);
    // New players don't get notes from before they joined.
    const cy = client();
    await cy.request('/register', { method: 'POST', form: { _csrf: await cy.csrf('/login'), username: 'Cyrus', email: 'c@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    db.prepare('UPDATE patch_notes SET created_at = created_at - 3600000').run();
    assert.doesNotMatch((await cy.request('/hq')).text, /New update:/);

    // Editing and deleting.
    const id = db.prepare('SELECT id FROM patch_notes').get().id;
    page = (await boss.request(`/admin/updates?edit=${id}`)).text;
    assert.match(page, /Edit “Update 0\.4: the market opens”/);
    f = await boss.flash('/admin/updates', { id: String(id), title: 'Update 0.4', body: 'Fixed.' });
    assert.match(f.message, /Update saved/);
    assert.match((await client().request('/updates')).text, /Update 0\.4[\s\S]*Fixed\./);
    f = await boss.flash(`/admin/updates/${id}/delete`);
    assert.match(f.message, /Update deleted/);
    assert.match((await client().request('/updates')).text, /No updates posted yet/);
    assert.match((await boss.request('/admin')).text, /href="\/admin\/updates"/);
  } finally {
    server.close();
  }
});
