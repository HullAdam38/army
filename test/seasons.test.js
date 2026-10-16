'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seasons = require('../src/seasons');
const { createSeasonService } = require('../src/season-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const FULL = { attacker: 1, defender: 1, note: null };

test('ratings, divisions, rewards and the soft reset', () => {
  // Even match: the winner gains 16, the defender moves less.
  assert.deepEqual(seasons.ratingChange(1000, 1000, true), { attacker: 16, defender: -10 });
  assert.deepEqual(seasons.ratingChange(1000, 1000, false), { attacker: -16, defender: 10 });
  // Upsets pay more than beating someone weaker.
  const upset = seasons.ratingChange(1000, 1300, true).attacker;
  const easy = seasons.ratingChange(1300, 1000, true).attacker;
  assert.ok(upset > 25 && easy >= 1 && easy < 6, `${upset} / ${easy}`);
  // A huge favourite still gains at least 1.
  assert.equal(seasons.ratingChange(3000, 100, true).attacker, 1);
  assert.equal(seasons.applyDelta(110, -40), seasons.RATING_FLOOR);

  assert.equal(seasons.divisionFor(1000).id, 'bronze');
  assert.equal(seasons.divisionFor(1050).id, 'silver');
  assert.equal(seasons.divisionFor(1349).id, 'gold');
  assert.equal(seasons.divisionFor(1600).id, 'elite');
  assert.deepEqual({ ...seasons.progressFor(1100), next: seasons.progressFor(1100).next.id }, { next: 'gold', needed: 100, pct: 33 });
  assert.equal(seasons.progressFor(1400), null);

  assert.equal(seasons.startingRating(null), 1000);
  assert.equal(seasons.startingRating(1400), 1200);
  assert.equal(seasons.startingRating(800), 900);

  assert.deepEqual([seasons.rewardFor(1400, 1).cash, seasons.rewardFor(1400, 4).cash, seasons.rewardFor(1000, 2).cash], [45000, 20000, 16000]);
  assert.equal(seasons.isRanked(FULL), true);
  assert.equal(seasons.isRanked({ attacker: 0.5, defender: 1 }), false);
  assert.equal(seasons.badgeFor({ number: 2, rank: 1, division: 'elite' }).label, 'S2 Champion');
  assert.equal(seasons.badgeFor({ number: 3, rank: 7, division: 'gold' }).label, 'S3 · Top 10 · Gold');
  assert.equal(seasons.badgeFor({ number: 3, rank: 40, division: 'silver' }).label, 'S3 · Silver');
});

test('season service: ranked fights, placement, payouts, reversal and the next season', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  const svc = createSeasonService(db, players);
  const now = Date.now();
  const add = (name) => Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, cash)
                                           VALUES (?, ?, 'x', ?, ?, ?, 10, 0)`).run(name, `${name}@x`, now, now, now).lastInsertRowid);
  const ace = add('Ace');
  const rook = add('Rook');
  const alt = add('Alt');
  let battleNo = 0;
  const fight = (a, d, won, rewards = FULL, at = now, linked = false) => {
    const id = Number(db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, report, created_at) VALUES (?, ?, ?, 0, '{}', ?)")
      .run(a, d, won ? 1 : 0, at).lastInsertRowid);
    battleNo += 1;
    return { id, out: players.transaction(() => svc.recordFight({ battleId: id, attackerId: a, defenderId: d, attackerWon: won, rewards, linked, now: at })) };
  };

  const s1 = svc.rollover(now);
  assert.equal(s1.number, 1);
  assert.equal(svc.rollover(now).id, s1.id); // idempotent while running
  assert.equal(s1.ends_at - s1.starts_at, 28 * seasons.DAY);

  // Unranked fights (linked accounts, repeat wins) change nothing.
  assert.deepEqual(fight(ace, alt, true, { attacker: 0, defender: 0, note: 'No rewards: same device.' }).out, { ranked: false, reason: 'No rewards: same device.' });
  assert.equal(fight(ace, alt, true, { attacker: 0.5, defender: 1, note: 'Half' }).out.ranked, false);
  // Full rewards but a shared network: still unranked.
  assert.deepEqual(fight(ace, alt, true, FULL, now, true).out, { ranked: false, reason: 'Unranked: these accounts are linked.' });
  assert.equal(svc.standing(s1, alt).fights, 0);

  // A ranked fight moves both ratings and is stored with the battle.
  const first = fight(ace, rook, true);
  assert.deepEqual(first.out, { ranked: true, number: 1, attacker: { delta: 16, rating: 1016 }, defender: { delta: -10, rating: 990 } });
  assert.equal(svc.forBattle(first.id).attacker_after, 1016);

  // Not placed until 5 ranked fights.
  let me = svc.standing(s1, ace);
  assert.deepEqual([me.placed, me.rank, me.fights], [false, null, 1]);
  assert.deepEqual(svc.standings(s1), []);
  for (let i = 0; i < 4; i += 1) fight(ace, rook, true, FULL, now + i + 1);
  me = svc.standing(s1, ace);
  assert.deepEqual([me.placed, me.rank, me.wins, me.division.id], [true, 1, 5, 'silver']);
  assert.deepEqual(svc.standings(s1).map((r) => [r.username, r.rank]), [['Ace', 1], ['Rook', 2]]);

  // Reversing a farmed fight takes its rating back off.
  const before = svc.standing(s1, ace).rating;
  const farmed = fight(ace, rook, true, FULL, now + 10);
  const gained = farmed.out.attacker.delta;
  assert.equal(players.transaction(() => svc.reverseBattles([farmed.id, farmed.id, 999999])), 1);
  me = svc.standing(s1, ace);
  assert.deepEqual([me.rating, me.wins, me.fights], [before, 5, 5]);
  assert.ok(gained > 0);
  assert.ok(svc.forBattle(farmed.id).reversed_at);

  // Time's up: the season is ranked and paid through the ledger, and season 2 begins.
  const end = s1.ends_at + 1;
  const s2 = svc.rollover(end);
  assert.equal(s2.number, 2);
  assert.equal(svc.byNumber(1).status, 'ended');
  const results = svc.results(svc.byNumber(1));
  assert.deepEqual(results.map((r) => [r.username, r.rank, r.division.id]), [['Ace', 1, 'silver'], ['Rook', 2, 'bronze']]);
  // Ace: Silver $3,000 + champion $25,000. Rook: Bronze $1,000 + runner-up $15,000.
  const ledger = (id) => { const r = db.prepare("SELECT SUM(delta_cash) AS n, MIN(ref) AS ref FROM ledger WHERE user_id = ? AND reason = 'season-reward'").get(id); return [r.n, r.ref]; };
  assert.deepEqual(ledger(ace), [28000, 'season:1']);
  assert.deepEqual(ledger(rook), [16000, 'season:1']);
  assert.equal(players.findById(ace).cash, 28000);
  assert.ok(players.findById(ace).level > 10 || players.findById(ace).xp > 0); // XP paid too
  assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'season' AND user_id = ? ORDER BY id").get(ace).message, /as Champion in Silver/);
  assert.equal(svc.badgesFor(ace)[0].label, 'S1 Champion');
  assert.equal(svc.past()[0].champion, 'Ace');
  // Settling only happens once.
  assert.equal(svc.rollover(end + 1).id, s2.id);
  assert.equal(ledger(ace)[0], 28000);
  // Old battles can't be reversed once their season is over.
  assert.equal(players.transaction(() => svc.reverseBattles([first.id])), 0);

  // The new season starts everyone halfway back toward 1,000.
  const ace1 = results[0].rating;
  assert.equal(svc.standing(s2, ace).rating, seasons.startingRating(ace1));
  fight(rook, ace, false, FULL, end + 5);
  assert.equal(svc.standing(s2, ace).fights, 1);

  // Admin can end a season early.
  assert.equal(svc.endNow(end + 10).number, 2);
  assert.equal(svc.current().number, 3);
});

test('seasons in the app: ranked attacks, the season page, profile badges, admin end', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return {
      request,
      post: async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } }),
      async enlist(username) {
        await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username, email: `${username}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
  };
  try {
    const ace = client(); await ace.enlist('Ace');
    const rook = client(); await rook.enlist('Rook');
    db.prepare('UPDATE users SET level = 5').run();

    let page = (await ace.request('/seasons')).text;
    assert.match(page, /Season 1/);
    assert.match(page, /Placement: <strong>0\/5<\/strong>/);
    assert.match(page, /Nobody has placed yet/);
    assert.doesNotMatch(page, /end season now/); // admins only
    assert.match((await ace.request('/hq')).text, /Season 1 · placement 0\/5 · 1,000 rating/);

    // A ranked attack moves ratings and says so on the battle report.
    db.prepare("UPDATE users SET health = 1 WHERE username = 'Rook'").run();
    const r = await ace.post('/attack/Rook');
    const battle = (await ace.request(r.location)).text;
    assert.match(battle, /Season 1<\/a> ranked fight:\s*Ace \+16 \(1016\) · Rook −10 \(990\)/);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = 'Rook') AND kind = 'attacked-lost'").get().message, /Season rating −10 \(990\)/);
    assert.match((await rook.request('/profile/Ace')).text, /Season 1 · Placing · 1,016/);

    // Admin ends the season; a non-admin can't.
    assert.equal((await rook.post('/admin/seasons/end')).res.status, 404);
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Ace'").run();
    assert.match((await ace.request('/seasons')).text, /end season now/);
    assert.equal((await ace.post('/admin/seasons/end')).location, '/seasons/1');
    page = (await ace.request('/seasons/1')).text;
    assert.match(page, /Season 1 results/);
    assert.match(page, /Nobody placed this season/); // one fight isn't enough to place
    assert.match((await ace.request('/seasons')).text, /Season 2/);
    assert.equal((await ace.request('/seasons/2')).location, '/seasons');
    assert.equal((await ace.request('/seasons/99')).res.status, 404);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'season-end'").get().n, 1);
    assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'season' AND user_id = (SELECT id FROM users WHERE username = 'Rook')").get().message, /1 ranked fight; 5 are needed/);
  } finally {
    server.close();
  }
});
