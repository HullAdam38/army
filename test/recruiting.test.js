'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../src/units');
const { createUnitRepo } = require('../src/units-repo');
const { announceLevels } = require('../src/notify');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const DAY = 24 * 60 * 60 * 1000;

function makeUser(db, name, { level = 10, seen = Date.now(), unitId = null, role = null } = {}) {
  return Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, energy_updated_at, health_updated_at, created_at, last_seen_at, unit_id, unit_role, unit_joined_at)
    VALUES (?, ?, 'x', ?, 0, 0, 0, ?, ?, ?, ?)`).run(name, `${name}@x.com`, level, seen, unitId, role, unitId ? 0 : null).lastInsertRowid);
}
const makeUnit = (db, name, tag, extra = {}) => Number(db.prepare(`INSERT INTO units (name, tag, description, founded_by, created_at, recruiting, min_level, barracks)
  VALUES (?, ?, '', NULL, 0, ?, ?, ?)`).run(name, tag, extra.recruiting ?? 1, extra.minLevel ?? 0, extra.barracks ?? 0).lastInsertRowid);

test('recommended units: recruiting, room to spare, requirements met and active', () => {
  const db = openDatabase(':memory:');
  const repo = createUnitRepo(db);
  const now = Date.now();
  const busy = makeUnit(db, 'Busy Bees', 'BB');
  const quiet = makeUnit(db, 'Ghost Town', 'GT');
  const closed = makeUnit(db, 'Closed Shop', 'CS', { recruiting: 0 });
  const picky = makeUnit(db, 'Picky Pack', 'PP', { minLevel: 30 });
  const full = makeUnit(db, 'Packed House', 'PH');
  for (let i = 0; i < 3; i += 1) makeUser(db, `bee${i}`, { unitId: busy, role: i ? 'member' : 'leader' });
  makeUser(db, 'ghost', { unitId: quiet, role: 'leader', seen: now - 10 * DAY });
  makeUser(db, 'shut', { unitId: closed, role: 'leader' });
  makeUser(db, 'pick', { unitId: picky, role: 'leader' });
  for (let i = 0; i < units.BASE_CAPACITY; i += 1) makeUser(db, `ph${i}`, { unitId: full, role: i ? 'member' : 'leader' });
  const small = makeUnit(db, 'Small Fry', 'SF');
  makeUser(db, 'fry', { unitId: small, role: 'leader' });

  const me = { level: 10, pvp_wins: 0, missions_completed: 0 };
  assert.deepEqual(repo.recommended(me, { now }).map((u) => u.tag), ['BB', 'SF'], 'busiest first; quiet, closed, picky and full units left out');
  assert.equal(repo.recommended(me, { now })[0].active, 3);
  assert.deepEqual(repo.recommended({ ...me, level: 30 }, { now, limit: 5 }).map((u) => u.tag).sort(), ['BB', 'PP', 'SF']);
  assert.deepEqual(repo.recommended(me, { now, limit: 1 }).map((u) => u.tag), ['BB']);
});

test('invite rules', () => {
  const unit = { id: 1, name: 'Wolves', barracks: 0 };
  const target = { id: 9, username: 'Rook', unit_id: null, lfu_at: 1 };
  const ctx = { members: 3, sentToday: 0, invited: false };
  assert.equal(units.inviteBlocker('sergeant', unit, target, ctx), null);
  assert.match(units.inviteBlocker('member', unit, target, ctx), /Sergeants and above/);
  assert.match(units.inviteBlocker('sergeant', unit, { ...target, lfu_at: null }, ctx), /isn’t looking/);
  assert.match(units.inviteBlocker('sergeant', unit, { ...target, unit_id: 4 }, ctx), /already joined/);
  assert.match(units.inviteBlocker('sergeant', unit, { ...target, banned_at: 1 }, ctx), /can’t be found/);
  assert.match(units.inviteBlocker('leader', unit, target, { ...ctx, members: 10 }), /full/);
  assert.match(units.inviteBlocker('leader', unit, target, { ...ctx, invited: true }), /already invited/);
  assert.match(units.inviteBlocker('leader', unit, target, { ...ctx, sentToday: units.MAX_INVITES_PER_DAY }), /invitations today/);
});

test('reaching level 5 without a unit points the player to recruiting units', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const loner = makeUser(db, 'Loner', { level: 5 });
  const unit = makeUnit(db, 'Wolves', 'WV');
  const member = makeUser(db, 'Member', { level: 5, unitId: unit, role: 'leader' });
  announceLevels(players, loner, [4, 5]);
  announceLevels(players, member, [5]);
  const nudges = (id) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'unit' AND message LIKE 'Still on your own%'").get(id).n;
  assert.equal(nudges(loner), 1);
  assert.equal(nudges(member), 0);
});

test('looking for a unit, invitations and joining through the app', async () => {
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
      /** POSTs and returns the flash message on the page it redirects to. */
      async flash(p, form = {}) {
        const r = await c.request(p, { method: 'POST', form: { _csrf: await c.csrf(), ...form } });
        const page = (await c.request(r.location)).text;
        const m = page.match(/<p class="flash flash--(\w+)">([^<]*)<\/p>/);
        return { message: m ? m[2] : '', location: r.location, page };
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
    const lead = await enlist('Wolfe');
    const sarge = await enlist('Sarge');
    const pte = await enlist('Private');
    const rook = await enlist('Rook');
    const shy = await enlist('Shy');
    const unit = makeUnit(db, 'Iron Wolves', 'IW');
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'leader', unit_joined_at = 0 WHERE id = ?").run(unit, lead.id);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'sergeant', unit_joined_at = 0 WHERE id = ?").run(unit, sarge.id);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member', unit_joined_at = 0 WHERE id = ?").run(unit, pte.id);
    db.prepare("UPDATE users SET level = 4 WHERE id IN (?, ?)").run(rook.id, shy.id);

    // Unit-less players see who's recruiting, on the Units page and at HQ.
    let page = (await rook.request('/units')).text;
    assert.match(page, /Recruiting now/);
    assert.match(page, /Iron Wolves/);
    assert.match(page, /I’m looking for a unit/);
    page = (await rook.request('/hq')).text;
    assert.match(page, /Join a unit/);
    assert.match(page, /href="\/units\/\d+#apply"/);
    assert.doesNotMatch((await lead.request('/hq')).text, /Join a unit/, 'not for players already in one');

    // Rook goes on the list; Shy doesn't.
    let f = await rook.flash('/units/looking', { looking: 'on' });
    assert.match(f.message, /on the list/);
    assert.match(f.page, /Take me off the list/);
    assert.ok(db.prepare('SELECT lfu_at FROM users WHERE id = ?').get(rook.id).lfu_at);

    // Only Sergeants and above can see recruits and invite.
    f = await pte.flash('/units/' + unit + '/invite', { user: String(rook.id) });
    assert.match(f.message, /Sergeants and above/);
    assert.match((await pte.request(`/units/${unit}/recruits`)).location, new RegExp(`/units/${unit}$`));
    assert.match((await sarge.request(`/units/${unit}`)).text, /Find recruits/);
    page = (await sarge.request(`/units/${unit}/recruits`)).text;
    assert.match(page, /Rook/);
    assert.doesNotMatch(page, /Shy/, 'only players who are looking');
    f = await sarge.flash(`/units/${unit}/invite`, { user: String(shy.id) });
    assert.match(f.message, /isn’t looking/);
    f = await sarge.flash(`/units/${unit}/invite`, { user: String(rook.id) });
    assert.match(f.message, /Invitation sent to Rook/);
    assert.match(f.page, /Invited/);
    f = await lead.flash(`/units/${unit}/invite`, { user: String(rook.id) });
    assert.match(f.message, /already invited/);

    // Rook is told, and sees it on Units and at HQ.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'unit' AND message LIKE '%invited you to join Iron Wolves%'").get(rook.id).n, 1);
    assert.match((await rook.request('/hq')).text, /You have an invitation to join a unit/);
    page = (await rook.request('/units')).text;
    assert.match(page, /Invitations/);
    const inviteId = page.match(/\/units\/invites\/(\d+)\/accept/)[1];

    // Someone else can't use it.
    f = await shy.flash(`/units/invites/${inviteId}/accept`);
    assert.match(f.message, /expired/);

    // Rook joins, bypassing the application, and comes off the list.
    f = await rook.flash(`/units/invites/${inviteId}/accept`);
    assert.match(f.message, /Welcome to Iron Wolves/);
    assert.match(f.location, new RegExp(`/units/${unit}$`));
    const r = db.prepare('SELECT unit_id, unit_role, lfu_at FROM users WHERE id = ?').get(rook.id);
    assert.deepEqual({ ...r }, { unit_id: unit, unit_role: 'member', lfu_at: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unit_invites WHERE user_id = ?').get(rook.id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND message LIKE 'Rook accepted Sarge%'").get(sarge.id).n, 1);
    assert.match(db.prepare('SELECT message FROM unit_log WHERE unit_id = ? ORDER BY id DESC LIMIT 1').get(unit).message, /Rook joined, invited by Sarge/);

    // Declining.
    await shy.flash('/units/looking', { looking: 'on' });
    await lead.flash(`/units/${unit}/invite`, { user: String(shy.id) });
    const shyInvite = (await shy.request('/units')).text.match(/\/units\/invites\/(\d+)\/decline/)[1];
    f = await shy.flash(`/units/invites/${shyInvite}/decline`);
    assert.match(f.message, /turned down/);
    assert.equal(db.prepare('SELECT unit_id FROM users WHERE id = ?').get(shy.id).unit_id, null);
    f = await shy.flash('/units/looking');
    assert.match(f.message, /off the list/);
    assert.equal(db.prepare('SELECT lfu_at FROM users WHERE id = ?').get(shy.id).lfu_at, null);

    // Players in a unit can't go on the list.
    f = await rook.flash('/units/looking', { looking: 'on' });
    assert.match(f.message, /already in a unit/);
  } finally {
    server.close();
  }
});
