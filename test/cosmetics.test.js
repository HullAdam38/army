'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cosmetics = require('../src/cosmetics');
const avatars = require('../src/avatars');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('cosmetic rules: earned, Supporter, and safe output', () => {
  const c = (id) => cosmetics.BY_ID.get(id);
  assert.equal(cosmetics.isUnlocked(c('name-olive'), { level: 9 }), false);
  assert.equal(cosmetics.isUnlocked(c('name-olive'), { level: 10 }), true);
  assert.equal(cosmetics.isUnlocked(c('name-crimson'), { level: 100 }), false, 'Supporter items are never earned');
  assert.equal(cosmetics.isUnlocked(c('name-crimson'), { owned: new Set(['name-crimson']) }), true);
  assert.equal(cosmetics.isUnlocked(c('banner-ribbons'), { titles: new Set(['veteran']) }), true);
  assert.equal(cosmetics.isUnlocked(c('crest-veteran'), { unitWarWins: 5 }), true);
  assert.equal(cosmetics.howText(c('name-gold')), 'Reach level 35');
  assert.equal(cosmetics.howText(c('crest-gold')), 'Supporter item');

  assert.equal(cosmetics.nameStyle('name-sky'), 'color:#7cc0ff');
  assert.equal(cosmetics.nameStyle('banner-night'), '', 'only colours make a colour');
  assert.equal(cosmetics.nameStyle('"><script>'), '', 'unknown ids produce nothing');
  assert.equal(cosmetics.cssClass('unit-crest', 'crest-gold', 'crest'), 'unit-crest--crest-gold');
  assert.equal(cosmetics.cssClass('unit-crest', 'name-sky', 'crest'), '');

  // Badge pack parts need the pack.
  const tiger = avatars.SECTIONS.find((s) => s.key === 'pattern').parts.find((p) => p.id === 'tiger');
  assert.equal(avatars.isUnlocked(tiger, { level: 100 }), false);
  assert.equal(avatars.isUnlocked(tiger, { cosmetics: new Set(['pack-special-forces']) }), true);
  assert.match(avatars.unlockText(tiger), /Special Forces pack/);
});

test('the wardrobe, unit crests and admin grants', async () => {
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
  try {
    const boss = await enlist('Boss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const ace = await enlist('Ace');
    db.prepare('UPDATE users SET level = 12 WHERE id = ?').run(ace.id);

    // The wardrobe: earned items can be worn, Supporter ones are locked.
    let page = (await ace.request('/account/wardrobe')).text;
    assert.match(page, /Field olive/);
    assert.match(page, /Supporter item, coming soon/);
    let f = await ace.flash('/account/wardrobe', { kind: 'name', id: 'name-olive' });
    assert.match(f.message, /Field olive on/);
    f = await ace.flash('/account/wardrobe', { kind: 'name', id: 'name-crimson' });
    assert.match(f.message, /locked: supporter item/);
    f = await ace.flash('/account/wardrobe', { kind: 'name', id: 'banner-night' });
    assert.match(f.message, /isn’t in the wardrobe/);

    // It shows on their profile and in chat.
    assert.match((await ace.request('/profile/Ace')).text, /id="profile-name" class="profile-hero__name" style="color:#b5c47a"/);
    await ace.post('/chat/global', { body: 'hello' });
    assert.match((await boss.request('/chat/global')).text, /class="chat-msg__name" href="\/profile\/Ace" style="color:#b5c47a"/);

    // An admin gives a Supporter banner; Ace is told and can wear it.
    assert.equal((await ace.post(`/admin/players/${ace.id}/cosmetics`, { cosmetic: 'banner-night', reason: 'x', action: 'grant' })).res.status, 404, 'admins only');
    f = await boss.flash(`/admin/players/${ace.id}/cosmetics`, { cosmetic: 'banner-night', reason: 'Launch giveaway', action: 'grant' });
    assert.match(f.message, /Gave Night ops/);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(ace.id).message, /HQ gave you Night ops/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'cosmetic-grant'").get().details, /Night ops\. Reason: Launch giveaway/);
    await ace.flash('/account/wardrobe', { kind: 'banner', id: 'banner-night' });
    assert.match((await ace.request('/profile/Ace')).text, /profile-hero profile-hero--banner-night/);
    // Taking it back takes it off too.
    await boss.flash(`/admin/players/${ace.id}/cosmetics`, { cosmetic: 'banner-night', reason: 'Given by mistake', action: 'revoke' });
    assert.doesNotMatch((await ace.request('/profile/Ace')).text, /profile-hero--banner-night/);

    // A badge pack opens up its parts in the builder.
    await boss.flash(`/admin/players/${ace.id}/cosmetics`, { cosmetic: 'pack-special-forces', reason: 'Prize', action: 'grant' });
    const owner = app.cosmetics.ownedSet(ace.id);
    assert.ok(owner.has('pack-special-forces'));

    // Unit crests: owned by the unit, picked by the Commander.
    const unitId = Number(db.prepare("INSERT INTO units (name, tag, description, founded_by, created_at) VALUES ('Iron Wolves', 'IW', '', ?, 0)").run(ace.id).lastInsertRowid);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'leader', unit_joined_at = 0 WHERE id = ?").run(unitId, ace.id);
    page = (await ace.request(`/units/${unitId}`)).text;
    assert.match(page, /Unit crest/);
    assert.match(page, /Your unit wins 5 wars/);
    f = await ace.flash(`/units/${unitId}/crest`, { crest: 'crest-gold' });
    assert.match(f.message, /locked/);
    await boss.flash(`/units/${unitId}/admin/cosmetics`, { cosmetic: 'crest-gold', reason: 'Tournament winners', action: 'grant' });
    f = await ace.flash(`/units/${unitId}/crest`, { crest: 'crest-gold' });
    assert.match(f.message, /now carries the Gold crest/);
    assert.match((await boss.request('/units')).text, /unit-crest unit-crest--crest-gold/);
    db.prepare('UPDATE units SET war_wins = 5 WHERE id = ?').run(unitId);
    f = await ace.flash(`/units/${unitId}/crest`, { crest: 'crest-veteran' });
    assert.match(f.message, /Veteran crest/);
  } finally {
    server.close();
  }
});
