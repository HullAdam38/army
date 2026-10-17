'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStatsService } = require('../src/stats-service');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-17T12:00:00Z'); // a Saturday
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function addPlayer(db, name, { joinedDaysAgo, activeDaysAfterJoin = [], level = 1, missions = 0, lastSeenDaysAgo = null }) {
  const joined = NOW - joinedDaysAgo * DAY;
  const lastSeen = lastSeenDaysAgo === null ? joined : NOW - lastSeenDaysAgo * DAY;
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, missions_completed, energy_updated_at, health_updated_at, created_at, last_seen_at)
    VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?)`).run(name, `${name}@x.com`, level, missions, joined, joined, joined, lastSeen).lastInsertRowid);
  for (const d of [0, ...activeDaysAfterJoin]) db.prepare('INSERT OR IGNORE INTO player_days (user_id, day) VALUES (?, ?)').run(id, dayKey(joined + d * DAY));
  return id;
}

test('player stats: activity, retention, funnel and drop-off', () => {
  const db = openDatabase(':memory:');
  const stats = createStatsService(db);
  // A cohort that joined 20 days ago: 4 players.
  addPlayer(db, 'Loyal', { joinedDaysAgo: 20, activeDaysAfterJoin: [1, 8, 20], level: 12, missions: 40, lastSeenDaysAgo: 0 });
  addPlayer(db, 'Weekly', { joinedDaysAgo: 20, activeDaysAfterJoin: [9], level: 5, missions: 10, lastSeenDaysAgo: 11 });
  addPlayer(db, 'Once', { joinedDaysAgo: 20, activeDaysAfterJoin: [1], level: 2, missions: 1, lastSeenDaysAgo: 19 });
  addPlayer(db, 'Ghost', { joinedDaysAgo: 20, level: 1, lastSeenDaysAgo: 20 });
  // Someone who joined today.
  addPlayer(db, 'Fresh', { joinedDaysAgo: 0, level: 1, lastSeenDaysAgo: 0 });

  const s = stats.overview(NOW);
  assert.deepEqual([s.kpis.players, s.kpis.dau, s.kpis.newWeek], [5, 2, 1]);
  assert.equal(s.kpis.mau, 5);
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.at(-1).day, '2026-10-17');
  assert.equal(s.daily.at(-1).active, 2);
  assert.equal(s.daily.find((d) => d.day === dayKey(NOW - 20 * DAY)).signups, 4);

  // The cohort that joined 20 days ago: 2 of 4 came back the next day, 2 of 4 in their second week.
  const cohort = s.cohorts.find((c) => c.size === 4);
  assert.deepEqual(cohort.rates.d1, { n: 2, pct: 50 });
  assert.deepEqual(cohort.rates.d7, { n: 2, pct: 50 });
  assert.equal(cohort.rates.d30, null, 'too early to tell');
  // This week's cohort is too new for any return rate.
  assert.equal(s.cohorts[0].size, 1);
  assert.equal(s.cohorts[0].rates.d1, null);

  // Funnel over players who joined in the last 30 days.
  const f = Object.fromEntries(s.funnel.map((r) => [r.key, r.n]));
  assert.deepEqual([f.joined, f.mission, f.level3, f.level5, f.level10], [5, 3, 2, 2, 1]);
  assert.equal(s.funnel[1].pct, 60);

  // Gone for 7+ days: Weekly (5), Once (2), Ghost (1).
  assert.equal(s.dropOff.total, 3);
  const lv = Object.fromEntries(s.dropOff.levels.map((r) => [r.label, r.n]));
  assert.deepEqual([lv['Level 1'], lv['Level 2'], lv['Level 5–9']], [1, 1, 1]);
});

test('active days are backfilled once from existing history', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-stats-')), 'game.db');
  let db = openDatabase(file);
  const id = Number(db.prepare("INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at) VALUES ('Old', 'old@x.com', 'x', 0, 0, ?)").run(NOW - 40 * DAY).lastInsertRowid);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 5, 0, 'mission', ?)").run(id, NOW - 39 * DAY);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 5, 0, 'mission', ?)").run(id, NOW - 33 * DAY);
  db.prepare('DELETE FROM player_days').run(); // as if upgrading from a version without it
  db.close();
  db = openDatabase(file);
  const days = db.prepare('SELECT day FROM player_days WHERE user_id = ? ORDER BY day').all(id).map((r) => r.day);
  assert.deepEqual(days, [dayKey(NOW - 40 * DAY), dayKey(NOW - 39 * DAY), dayKey(NOW - 33 * DAY)]);
  db.close();
});

test('the stats page, activity recording and app use through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const c = {};
    c.request = async (p, { method = 'GET', form, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text() };
    };
    c.csrf = async (from = '/hq') => (await c.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  try {
    const boss = await join('Boss');
    const player = await join('Player');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    // Playing marks today as an active day.
    await player.request('/hq');
    assert.ok(db.prepare('SELECT 1 FROM player_days WHERE user_id = ? AND day = ?').get(player.id, dayKey(Date.now())));
    // The installed app reports itself through the notification poll.
    await player.request('/notifications/poll?after=0&visible=1&app=1', { headers: { accept: 'application/json' } });
    assert.ok(db.prepare('SELECT app_seen_at FROM users WHERE id = ?').get(player.id).app_seen_at > 0);

    assert.equal((await player.request('/admin/stats')).res.status, 404);
    const page = (await boss.request('/admin/stats')).text;
    for (const s of ['Player stats', 'Active players per day', 'Sign-ups per day', 'Do players come back?', 'How far players get', 'Basic training steps', 'Where players stop', 'PvP fights per day', 'Using the app']) assert.ok(page.includes(s), s);
    assert.match(page, /class="admin-nav__link" href="\/admin\/stats" aria-current="page"/);
    assert.match((await boss.request('/admin/stats?range=all')).text, /href="\/admin\/stats\?range=all" aria-current="page"/);
  } finally {
    server.close();
  }
});
