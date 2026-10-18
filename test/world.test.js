'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reserve = require('../src/reserve');
const wars = require('../src/wars');
const tuning = require('../src/tuning');
const { announceLevels } = require('../src/notify');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

/** A repeatable random number generator, so ticks play out the same every run. */
function seeded(seed = 42) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

test('reserve rules: names, levels, gear and pacing', () => {
  assert.equal(reserve.NAMES.length, 400);
  assert.equal(new Set(reserve.NAMES).size, 400);
  for (const n of reserve.NAMES) assert.match(n, /^[A-Za-z0-9_-]{3,20}$/, 'valid callsigns');
  assert.equal(reserve.wanted(30, 4), 26);
  assert.equal(reserve.wanted(30, 45), 0);
  assert.equal(reserve.startLevel(0, 30), 3);
  assert.equal(reserve.startLevel(29, 30), 25);
  assert.ok(reserve.startLevel(10, 30) < 8, 'mostly low levels');
  assert.ok(reserve.gearFor(1).weapon, 'a starting weapon');
  assert.ok(Object.keys(reserve.gearFor(20)).length >= 3);
  const r = seeded();
  const t = reserve.trainedStats(20, r);
  assert.equal(t.stat_str + t.stat_agi + t.stat_end, 30);
  // XP per play slows as they climb: a fraction of a level each time.
  assert.ok(reserve.xpPerPlay(5, 1, () => 0.5) < 0.015 * 100 * Math.pow(5, 1.6));
});

test('reserve soldiers enlist, play, fight and stand down as real players arrive', () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  tuning.set({ reserveSoldiers: 30 });
  try {
    const now = Date.now();
    let r = app.reserve.tick(now);
    assert.equal(r.enlisted, 30);
    assert.equal(r.founded, 3);
    const bots = db.prepare('SELECT * FROM users WHERE is_bot = 1').all();
    assert.equal(bots.length, 30);
    assert.ok(bots.every((b) => b.email.endsWith('@reserve.invalid') && b.level >= 3));
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM equipment e JOIN users u ON u.id = e.user_id WHERE u.is_bot = 1').get().n >= 30, 'they carry gear');

    // Three HQ starter units, each led by a reserve soldier, recruiting with no requirements.
    const hq = db.prepare('SELECT * FROM units WHERE hq = 1').all();
    assert.deepEqual(hq.map((u) => u.tag).sort(), ['DRG', 'IVG', 'NWT']);
    for (const u of hq) {
      assert.equal(u.recruiting, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE unit_id = ?').get(u.id).n, reserve.HQ_MEMBERS);
    }

    // A day of ticks: they play, level up (to the cap at most) and fight each other.
    const startXp = db.prepare('SELECT SUM(level * 100000 + xp) AS n FROM users WHERE is_bot = 1').get().n;
    for (let i = 1; i <= 144; i += 1) app.reserve.tick(now + i * reserve.TICK_MS);
    assert.ok(db.prepare('SELECT SUM(level * 100000 + xp) AS n FROM users WHERE is_bot = 1').get().n > startXp, 'they progress');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM battles').get().n > 10, 'skirmishes fill the combat feed');
    assert.ok(db.prepare('SELECT MAX(level) AS n FROM users WHERE is_bot = 1').get().n <= tuning.get('reserveMaxLevel'));
    assert.equal(app.anti.runScan().newFlags, 0, 'every dollar went through the ledger, and their skirmishes raise no flags');

    // Real players arrive: one reserve soldier stands down for each, but not the HQ Commanders.
    const later = now + 145 * reserve.TICK_MS;
    for (let i = 0; i < 25; i += 1) {
      db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, last_seen_at)
        VALUES (?, ?, 'x', 0, 0, 0, ?)`).run(`real${i}`, `real${i}@x.com`, later);
      db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) SELECT id, cash, 0, 'signup', 0 FROM users WHERE username = ?").run(`real${i}`);
    }
    r = app.reserve.tick(later);
    assert.equal(r.want, 5);
    assert.equal(app.reserve.count(), 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users u JOIN units n ON n.id = u.unit_id WHERE n.hq = 1 AND u.unit_role = 'leader' AND u.is_bot = 1 AND u.banned_at IS NULL").get().n, 3);
    // Stood-down soldiers drop off the lists (the ban hides them everywhere).
    assert.match(db.prepare('SELECT ban_reason FROM users WHERE is_bot = 1 AND banned_at IS NOT NULL LIMIT 1').get().ban_reason, /stood down/);

    // Switched off: the empty HQ units are disbanded and everyone stands down.
    tuning.set({ reserveSoldiers: 0 });
    r = app.reserve.tick(later + 1);
    assert.equal(app.reserve.count(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM units WHERE hq = 1').get().n, 0);
    assert.equal(app.anti.runScan().newFlags, 0);
  } finally {
    tuning.reset();
  }
});

test('promotions to officer ranks make the news, which admins can turn off', () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  try {
    const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, energy_updated_at, health_updated_at, created_at)
      VALUES ('Rising', 'r@x.com', 'x', 17, 0, 0, 0)`).run().lastInsertRowid);
    announceLevels(app.players, id, [16, 17, 18]);
    const news = db.prepare("SELECT body FROM chat_messages WHERE kind = 'news'").all().map((r) => r.body);
    assert.deepEqual(news, ['[b]Rising[/b] was promoted to [b]Second Lieutenant[/b] (level 17).'], 'only a new rank, from Second Lieutenant up');
    tuning.set({ chatNews: false });
    announceLevels(app.players, id, [19]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'news'").get().n, 1);
  } finally {
    tuning.reset();
  }
});

test('HQ starter units: no wars, and nobody messages reserve soldiers', () => {
  const ctx = { attackerMembers: 5, targetMembers: 5 };
  assert.match(wars.declareBlocker({ id: 1, name: 'A' }, { id: 2, name: 'Iron Vanguard', hq: 1 }, ctx), /HQ starter unit/);
  assert.match(wars.declareBlocker({ id: 2, name: 'Iron Vanguard', hq: 1 }, { id: 1, name: 'A' }, ctx), /don’t declare wars/);
  assert.equal(wars.declareBlocker({ id: 1, name: 'A' }, { id: 2, name: 'B', hq: 2 }, ctx), null, 'a handed-over unit is a normal unit');
});

test('joining an HQ unit, its handover to players, and reserve soldiers in the game', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  tuning.set({ reserveSoldiers: 20 });
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
    app.reserve.tick();
    const unit = db.prepare("SELECT * FROM units WHERE tag = 'IVG'").get();
    const bot = db.prepare("SELECT * FROM users WHERE is_bot = 1 AND unit_id IS NULL AND level >= 3 LIMIT 1").get();
    const a = await enlist('Alpha');
    const b = await enlist('Bravo');
    const c = await enlist('Charlie');
    db.prepare('UPDATE users SET level = 8 WHERE id IN (?, ?, ?)').run(a.id, b.id, c.id);
    db.prepare('UPDATE users SET level = 12 WHERE id = ?').run(b.id);

    // Reserve soldiers are marked wherever players see them.
    assert.match((await a.request('/players')).text, /tag--reserve/);
    let page = (await a.request(`/profile/${bot.username}`)).text;
    assert.match(page, /A reserve soldier run by HQ/);
    assert.doesNotMatch(page, /href="\/messages\/new\?to=/, 'no Message button');
    let f = await a.flash('/messages', { to: bot.username, subject: 'hi', body: 'hello' });
    assert.match(f.message, /doesn’t read messages/);
    // They can't sign in, even if someone guessed a password.
    const anon = client();
    const r = await anon.request('/login', { method: 'POST', form: { _csrf: await anon.csrf('/login'), login: bot.username, password: 'whatever' } });
    assert.equal(r.res.status, 401);

    // HQ units take applicants at once.
    page = (await a.request(`/units/${unit.id}`)).text;
    assert.match(page, /HQ starter unit/);
    assert.match(page, /Join now/);
    f = await a.flash(`/units/${unit.id}/apply`);
    assert.match(f.message, /Welcome to Iron Vanguard/);
    await b.flash(`/units/${unit.id}/apply`);
    app.reserve.tick();
    assert.equal(db.prepare('SELECT hq FROM units WHERE id = ?').get(unit.id).hq, 1, 'two real members isn’t enough yet');
    await c.flash(`/units/${unit.id}/apply`);

    // The third real member: command passes to the most senior, and the reserve soldiers leave.
    app.reserve.tick();
    assert.equal(db.prepare('SELECT hq FROM units WHERE id = ?').get(unit.id).hq, 2);
    const roles = Object.fromEntries(db.prepare('SELECT username, unit_role FROM users WHERE unit_id = ?').all(unit.id).map((m) => [m.username, m.unit_role]));
    assert.deepEqual(roles, { Alpha: 'officer', Bravo: 'leader', Charlie: 'member' }, 'the next most senior becomes a Lieutenant');
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(b.id).message, /you are its Commander/);
    assert.match(db.prepare("SELECT body FROM chat_messages WHERE kind = 'news' ORDER BY id DESC LIMIT 1").get().body, /handed \[b\]Iron Vanguard\[\/b\] \(IVG\) over to its soldiers/);
    page = (await b.request('/chat/global')).text;
    assert.match(page, /chat-msg--news/);
  } finally {
    server.close();
    tuning.reset();
  }
});
