'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('unit board, unit descriptions, applications and profile bios all use BBCode safely', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form, json, headers = {} } = {}) => {
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
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
    return { request, csrf, post };
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/register'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    return c;
  };
  const evil = '<script>alert(1)</script>[url=javascript:alert(1)]x[/url]';
  try {
    const lead = await enlist('Leader');
    const recruit = await enlist('Recruit');
    db.prepare("UPDATE users SET level = 6, cash = 5000 WHERE username = 'Leader'").run();

    // Unit description with formatting, at founding.
    const founded = await lead.post('/units', { name: 'Iron Wolves', tag: 'IW', description: `[b]We hunt in packs[/b]\n[list][*]Daily[*]PvP[/list]${evil}` });
    const unitUrl = founded.location;
    let page = (await lead.request(unitUrl)).text;
    assert.match(page, /<div class="unit-hero__desc bb-content"><strong>We hunt in packs<\/strong><br><ul class="bb-list"><li>Daily<\/li><li>PvP<\/li><\/ul>/);
    assert.doesNotMatch(page, /<script>alert|href="javascript/);
    assert.match(page, /data-bb-editor[\s\S]*id="post-body"/); // the board uses the editor
    assert.match(page, /id="settings-desc"/); // and so do the settings

    // Application message with formatting, rendered for the officers.
    await recruit.post(`${unitUrl}/apply`, { message: `[i]Level 1 but keen[/i] ${evil}` });
    page = (await lead.request(unitUrl)).text;
    assert.match(page, /<div class="unit-quote bb-content"><em>Level 1 but keen<\/em>/);
    assert.doesNotMatch(page, /<script>alert/);

    // Board post with formatting and a quote button carrying the raw source.
    await lead.post(`${unitUrl}/posts`, { body: `[color=orange]Muster at 2200[/color] [player]Recruit[/player] ${evil}` });
    page = (await lead.request(unitUrl)).text;
    assert.match(page, /<span class="bb-color" style="color:orange">Muster at 2200<\/span> <a class="bb-player" href="\/profile\/Recruit">Recruit<\/a>/);
    assert.match(page, /data-bb-quote="#post-body" data-author="Leader" data-body="\[color=orange\]Muster at 2200/);
    assert.doesNotMatch(page, /<script>alert/);
    // Longer posts fit now that tags count towards the limit.
    const long = `[b]${'x'.repeat(1500)}[/b]`;
    await new Promise((r) => setTimeout(r, 10));
    db.prepare('UPDATE unit_posts SET created_at = created_at - 60000').run(); // step past the post cooldown
    await lead.post(`${unitUrl}/posts`, { body: long });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_posts').get().n, 2);

    // Profile bio: editor page, rendered on the profile, length limit, admin can clear it.
    assert.match((await recruit.request('/account/profile')).text, /data-bb-editor[\s\S]*name="bio"/);
    let r = await recruit.post('/account/profile', { bio: `[size=large]Sniper[/size]\nFavourite rifle: [b]Marksman[/b] ${evil}` });
    assert.equal(r.location, '/profile/Recruit#about');
    page = (await lead.request('/profile/Recruit')).text;
    assert.match(page, /<div class="bb-content profile-about__body"><span class="bb-size-large">Sniper<\/span><br>Favourite rifle: <strong>Marksman<\/strong>/);
    assert.doesNotMatch(page, /<script>alert|href="javascript/);
    r = await recruit.post('/account/profile', { bio: 'x'.repeat(2001) });
    assert.equal(r.location, '/account/profile');
    assert.match((await recruit.request('/account/profile')).text, /x{2001}/); // the draft is kept
    assert.match((await recruit.request('/profile/Recruit')).text, /Sniper/); // and the old bio is untouched

    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Leader'").run();
    const recruitId = db.prepare("SELECT id FROM users WHERE username = 'Recruit'").get().id;
    assert.match((await lead.request(`/admin/players/${recruitId}`)).text, /admin-bio bb-content[\s\S]*Sniper/);
    await lead.post(`/admin/players/${recruitId}/clear-bio`);
    assert.equal(db.prepare('SELECT bio FROM users WHERE id = ?').get(recruitId).bio, '');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'clear-bio'").get().n, 1);
    assert.doesNotMatch((await lead.request('/profile/Recruit')).text, /id="about"/); // nothing to show to others

    // The shared preview endpoint.
    const token = await lead.csrf();
    const prev = await lead.request('/format/preview', { method: 'POST', json: { body: '[u]ok[/u]' }, headers: { 'x-csrf-token': token } });
    assert.equal(JSON.parse(prev.text).html, '<span class="bb-u">ok</span>');
  } finally {
    server.close();
  }
});
