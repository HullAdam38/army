'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../src/admin');
const { USERNAME_RE, EMAIL_RE } = require('../src/routes/auth');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('admin edits: bank, XP, stats and identity checks', () => {
  const p = { id: 1, username: 'Ace', level: 10, xp: 0, cash: 100, bank_balance: 500, stat_str: 5, stat_agi: 5, stat_end: 5, health: 150, max_health: 200 };
  assert.match(admin.adjustBank(p, '-600', 'x').error, /only has \$500 in the bank/);
  assert.match(admin.adjustBank(p, '200', '').error, /reason/);
  assert.equal(admin.adjustBank(p, '-500', 'Refund reversed').player.bank_balance, 0);

  const xp = admin.grantXp(p, '1000000', 'Prize');
  assert.ok(xp.player.level > 10 && xp.levelsGained.length > 0);
  assert.match(admin.grantXp(p, '0', 'x').error, /from 1/);
  assert.match(admin.grantXp({ ...p, level: 119 }, '1000000', 'x').error, /past level 120/);

  const cap = require('../src/training').statCap(10);
  assert.match(admin.setStats(p, { stat_str: cap + 1, stat_agi: 0, stat_end: 0 }, 'x').error, new RegExp(`0 to ${cap}`));
  const up = admin.setStats(p, { stat_str: 1, stat_agi: 2, stat_end: 15 }, 'Bug');
  assert.deepEqual([up.player.stat_end, up.player.max_health, up.player.health], [15, 220, 170]); // +10 endurance = +20 max health
  const down = admin.setStats(p, { stat_str: 1, stat_agi: 2, stat_end: 0 }, 'Bug');
  assert.deepEqual([down.player.max_health, down.player.health], [190, 150]);

  assert.deepEqual(admin.validateIdentity({ username: ' New_Name ' }, { USERNAME_RE, EMAIL_RE }), { username: 'New_Name' });
  assert.ok(admin.validateIdentity({ username: 'no spaces' }, { USERNAME_RE, EMAIL_RE }).error);
  assert.deepEqual(admin.validateIdentity({ email: ' A@B.co ' }, { USERNAME_RE, EMAIL_RE }), { email: 'a@b.co' });
  assert.ok(admin.validateIdentity({ email: 'nope' }, { USERNAME_RE, EMAIL_RE }).error);
});

test('admin player editor and new admin pages through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    // Posts a form and returns the flash message shown after the redirect.
    c.act = async (path, form = {}, from = '/hq') => {
      const r = await c.request(path, { method: 'POST', form: { _csrf: await c.csrf(from), ...form } });
      if (r.res.status >= 400) return { status: r.res.status };
      const page = (await c.request(r.location)).text;
      return { status: r.res.status, location: r.location, message: (page.match(/class="flash flash--\w+"[^>]*>([^<]*)</) || [])[1] || '' };
    };
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name.toLowerCase()}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  try {
    const boss = await join('Boss');
    const vic = await join('Vic');
    const other = await join('Other');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const P = `/admin/players/${vic.id}`;

    // Players get the ordinary 404 for everything new.
    for (const path of ['/admin/units', '/admin/economy', '/admin/audit']) assert.equal((await vic.request(path)).res.status, 404, path);
    assert.equal((await vic.act(`/admin/players/${other.id}/bank`, { amount: '500', reason: 'x' })).status, 404);

    // The editor shows the new sections, and the admin menu is on every admin page.
    let page = (await boss.request(P)).text;
    for (const s of ['Callsign &amp; email', 'Adjust bank', 'Grant XP', 'Trained stats', 'Gear', 'Title, chat &amp; sessions']) assert.ok(page.includes(s), s);
    for (const path of ['/admin', '/admin/players', P, '/admin/units', '/admin/economy', '/admin/audit', '/admin/settings', '/admin/chat', '/admin/avatars', '/admin/flags', '/admin/reports', '/admin/events']) {
      assert.match((await boss.request(path)).text, /class="admin-nav"/, path);
    }

    // Bank: through the ledger, never below zero.
    assert.match((await boss.act(`${P}/bank`, { amount: '2500', reason: 'Refund' }, P)).message, /Added \$2,500 in the bank/);
    assert.equal(user(vic.id).bank_balance, 2500);
    assert.equal(db.prepare("SELECT delta_bank FROM ledger WHERE user_id = ? AND reason = 'admin-bank'").get(vic.id).delta_bank, 2500);
    assert.match((await boss.act(`${P}/bank`, { amount: '-9999', reason: 'x' }, P)).message, /only has \$2,500/);

    // XP: levels up with the usual notices.
    await boss.act(`${P}/xp`, { amount: '5000', reason: 'Event prize' }, P);
    assert.ok(user(vic.id).level > 1);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'promotion'").get(vic.id).n > 0);

    // Clearing a player's notifications: shown with a count, logged, and only theirs go.
    const notes = (id) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(id).n;
    const total = notes(vic.id);
    const bossNotes = notes(boss.id);
    assert.match((await boss.request(P)).text, new RegExp(`Notifications: <strong>${total}</strong>`));
    assert.match((await boss.act(`${P}/clear-notifications`, {}, P)).message, new RegExp(`Cleared ${total} of Vic’s notifications`));
    assert.equal(notes(vic.id), 0);
    assert.equal(notes(boss.id), bossNotes);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'clear-notifications'").get().details, new RegExp(`Cleared ${total} notification`));
    assert.match((await boss.request(P)).text, /Notifications: <span class="muted">none<\/span>/);
    assert.match((await boss.act(`${P}/clear-notifications`, {}, P)).message, /no notifications to clear/);
    assert.equal((await vic.act(`${P}/clear-notifications`, {}, '/hq')).status, 404, 'admins only');

    // Stats within the level's cap.
    assert.match((await boss.act(`${P}/stats`, { stat_str: '2', stat_agi: '1', stat_end: '3', reason: 'Bug refund' }, P)).message, /Set trained stats 0\/0\/0 → 2\/1\/3/);
    assert.deepEqual([user(vic.id).stat_str, user(vic.id).stat_agi, user(vic.id).stat_end], [2, 1, 3]);

    // Callsign and email: valid, unique (case-insensitive), with a reason; the player is told.
    assert.match((await boss.act(`${P}/identity`, { field: 'username', value: 'other', reason: 'x' }, P)).message, /already uses that callsign/);
    assert.match((await boss.act(`${P}/identity`, { field: 'username', value: 'bad name', reason: 'x' }, P)).message, /3–20 characters/);
    assert.match((await boss.act(`${P}/identity`, { field: 'username', value: 'Victor', reason: '' }, P)).message, /reason/);
    assert.match((await boss.act(`${P}/identity`, { field: 'username', value: 'Victor', reason: 'Asked to change' }, P)).message, /Vic is now Victor/);
    assert.equal(user(vic.id).username, 'Victor');
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'system' ORDER BY id DESC").get(vic.id).message, /from Vic to Victor/);
    assert.equal((await vic.request('/profile/Victor')).res.status, 200);
    assert.match((await boss.act(`${P}/identity`, { field: 'email', value: 'other@x.com', reason: 'x' }, P)).message, /already uses that email/);
    assert.match((await boss.act(`${P}/identity`, { field: 'email', value: 'New@X.com', reason: 'Lost access' }, P)).message, /email is now new@x\.com/);
    // Another admin's details stay put.
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(other.id);
    assert.match((await boss.act(`/admin/players/${other.id}/identity`, { field: 'username', value: 'Renamed', reason: 'x' }, `/admin/players/${other.id}`)).message, /only be changed on the server/);
    db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(other.id);

    // Gear: give, refuse duplicates, take away (unequipping first).
    assert.match((await boss.act(`${P}/items`, { action: 'grant', item: 'carbine', reason: 'Lost in bug' }, P)).message, /M4 Carbine given to Victor/);
    assert.match((await boss.act(`${P}/items`, { action: 'grant', item: 'carbine', reason: 'again' }, P)).message, /already owns/);
    db.prepare("INSERT INTO equipment (user_id, slot, item_id) VALUES (?, 'weapon', 'carbine')").run(vic.id);
    assert.match((await boss.act(`${P}/items`, { action: 'remove', item: 'carbine', reason: 'Exploit' }, P)).message, /M4 Carbine removed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM equipment WHERE user_id = ?').get(vic.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory WHERE user_id = ? AND item_id = ?').get(vic.id, 'carbine').n, 0);

    // Unit: members can be removed, the Commander can't.
    const unitId = Number(db.prepare("INSERT INTO units (name, tag, created_at) VALUES ('Iron Wolves', 'IW', ?)").run(Date.now()).lastInsertRowid);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'leader' WHERE id = ?").run(unitId, other.id);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member' WHERE id = ?").run(unitId, vic.id);
    assert.match((await boss.act(`/admin/players/${other.id}/unit-remove`, { reason: 'x' }, `/admin/players/${other.id}`)).message, /Commander/);
    assert.match((await boss.act(`${P}/unit-remove`, { reason: 'Inactive' }, P)).message, /removed from Iron Wolves/);
    assert.equal(user(vic.id).unit_id, null);

    // Title and sessions.
    db.prepare("UPDATE users SET title = 'veteran' WHERE id = ?").run(vic.id);
    assert.match((await boss.request(P)).text, /The Veteran|Veteran/);
    await boss.act(`${P}/clear-title`, {}, P);
    assert.equal(user(vic.id).title, null);
    assert.equal((await vic.request('/hq')).res.status, 200);
    assert.match((await boss.act(`${P}/sign-out`, {}, P)).message, /signed out everywhere/);
    assert.match((await vic.request('/hq')).location || '', /\/login/);

    // Units page and treasury adjustments.
    page = (await boss.request('/admin/units?q=wolv')).text;
    assert.match(page, /Iron Wolves/);
    let r = await boss.act(`/admin/units/${unitId}/treasury`, { amount: '-1', reason: 'x' }, '/admin/units');
    assert.match(r.message, /only has \$0/);
    r = await boss.act(`/admin/units/${unitId}/treasury`, { amount: '7500', reason: 'War correction' }, '/admin/units');
    assert.match(r.message, /treasury \+\$7,500/);
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury, 7500);
    assert.match(db.prepare("SELECT message FROM unit_log WHERE unit_id = ? ORDER BY id DESC").get(unitId).message, /HQ added \$7,500/);

    // Economy page: sources and admin changes.
    page = (await boss.request('/admin/economy')).text;
    assert.match(page, /Admin: bank/);
    assert.match(page, /Unit treasuries/);
    assert.match(page, /\$7,500/);

    // Audit log: everything above, filterable.
    page = (await boss.request('/admin/audit')).text;
    for (const action of ['bank', 'xp', 'stats', 'rename', 'email', 'item-grant', 'item-remove', 'unit-remove', 'clear-title', 'sign-out', 'unit-treasury']) assert.ok(page.includes(`audit__action--${action}"`), action);
    page = (await boss.request('/admin/audit?action=rename')).text;
    assert.match(page, /Callsign Vic → Victor/);
    assert.doesNotMatch(page, /audit__action--bank"/);
    page = (await boss.request('/admin/audit?q=Iron')).text;
    assert.match(page, /audit__action--unit-treasury"/);
    assert.doesNotMatch(page, /audit__action--xp"/);

    // Every balance still matches its ledger.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM (SELECT u.id FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id HAVING COALESCE(SUM(l.delta_cash), 0) != u.cash OR COALESCE(SUM(l.delta_bank), 0) != u.bank_balance)').get().n, 0);
  } finally {
    server.close();
  }
});
