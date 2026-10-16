'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deployments = require('../src/deployments');
const game = require('../src/game');
const pvp = require('../src/pvp');
const training = require('../src/training');
const scouting = require('../src/scouting');
const { NEUTRAL } = require('../src/events');
const { createDeploymentService } = require('../src/deployment-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const { HOUR, KINDS_BY_ID } = deployments;
// Returns the given values in turn: story pick, find roll, injury roll.
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('deployment pay, the daily cap and who can deploy', () => {
  assert.deepEqual(deployments.hourlyRate(10), { cash: 360, xp: 38 });
  // Longer patrols pay less per hour.
  const patrol = deployments.rewardFor(KINDS_BY_ID.get('patrol'), 10);
  const extended = deployments.rewardFor(KINDS_BY_ID.get('extended'), 10);
  assert.deepEqual(patrol, { cash: 360, xp: 38 });
  assert.ok(extended.cash / 12 < patrol.cash);
  assert.deepEqual(deployments.rewardFor(KINDS_BY_ID.get('patrol'), 10, { cashMult: 1.5, xpMult: 2 }), { cash: 540, xp: 76 });

  const now = Date.now();
  // Rolling 24 hours: recalled deployments count until they were recalled; older time drops out.
  const used = deployments.hoursUsed([
    { started_at: now - 30 * HOUR, ends_at: now - 22 * HOUR, status: 'returned' }, // 2h inside the window
    { started_at: now - 10 * HOUR, ends_at: now - 6 * HOUR, status: 'returned' }, // 4h
    { started_at: now - 3 * HOUR, ends_at: now + 9 * HOUR, returned_at: now - 2 * HOUR, status: 'recalled' }, // 1h
  ], now);
  assert.ok(Math.abs(used - 7) < 1e-9);

  const p = { level: 10, health: 100, max_health: 100 };
  const recon = KINDS_BY_ID.get('recon');
  assert.equal(deployments.deployBlocker(p, recon, 0, now), null);
  assert.match(deployments.deployBlocker(p, null, 0, now), /Pick/);
  assert.match(deployments.deployBlocker({ ...p, deploy_until: now + 1 }, recon, 0, now), /already deployed/);
  assert.match(deployments.deployBlocker({ ...p, hospital_until: now + 1 }, recon, 0, now), /hospital/);
  assert.match(deployments.deployBlocker({ ...p, level: 3 }, KINDS_BY_ID.get('long-range'), 0, now), /level 5/);
  assert.match(deployments.deployBlocker({ ...p, health: 20 }, recon, 0, now), /Too injured/);
  assert.match(deployments.deployBlocker(p, recon, 13, now), /Only 3h/);
  assert.equal(deployments.deployBlocker(p, recon, 12, now), null); // exactly 16
  assert.match(deployments.deployBlocker(p, KINDS_BY_ID.get('patrol'), 15.5, now), /used today’s 16 hours/);

  // Finds and ambushes.
  const quiet = deployments.resolve(recon, p, { rng: seq(0, 0.9, 0.9) });
  assert.deepEqual([quiet.cash, quiet.find, quiet.injury], [1296, null, 0]);
  const eventful = deployments.resolve(recon, p, { rng: seq(0, 0.1, 0.05) });
  assert.deepEqual([eventful.cash, eventful.injury], [1296 + 648, 20]);
  assert.match(eventful.find, /\$648/);
});

test('a deployed soldier can’t act and can’t be attacked', () => {
  const now = Date.now();
  const me = { id: 1, username: 'A', level: 10, energy: 100, max_energy: 100, health: 100, max_health: 100, cash: 1e6, deploy_until: now + HOUR };
  const other = { id: 2, username: 'B', level: 10, health: 100, max_health: 100 };
  assert.match(game.missionBlocker(game.MISSIONS[0], me, now), /deployment/);
  assert.match(pvp.selfBlocker(me, now), /deployment/);
  assert.match(pvp.targetBlocker(other, me, { now }), /out of reach/);
  assert.match(scouting.scoutBlocker(me, other, now), /deployment/);
  assert.match(training.train(me, 'strength').error, /deployment/);
  // Once the time is up they're back.
  assert.equal(game.missionBlocker(game.MISSIONS[0], me, now + HOUR + 1), null);
});

test('deployment service: start, cap, recall, return through the ledger', () => {
  const db = openDatabase(':memory:');
  const players = createPlayerRepo(db);
  let fx = NEUTRAL;
  const svc = createDeploymentService(db, players, { effects: () => fx });
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at, level, cash)
                                VALUES ('Ranger', 'r@x', 'x', ?, ?, ?, 10, 0)`).run(now, now, now).lastInsertRowid);

  assert.match(players.transaction(() => svc.start(id, 'nope', now)).error, /Pick/);
  const out = players.transaction(() => svc.start(id, 'recon', now));
  assert.equal(out.until, now + 4 * HOUR);
  assert.equal(players.findById(id).deploy_until, now + 4 * HOUR);
  assert.match(players.transaction(() => svc.start(id, 'patrol', now)).error, /already deployed/);

  // Nothing comes back early; then it returns once, paid through the ledger.
  assert.deepEqual(svc.completeDue(now + HOUR), []);
  const [done] = svc.completeDue(now + 4 * HOUR, null, seq(0, 0.9, 0.9));
  assert.deepEqual([done.cash, done.xp], [1296, 137]);
  assert.deepEqual(svc.completeDue(now + 5 * HOUR), []);
  let u = players.findById(id);
  assert.deepEqual([u.cash, u.deploy_until], [1296, null]);
  assert.deepEqual({ ...db.prepare("SELECT reason, delta_cash, ref FROM ledger WHERE user_id = ? AND reason = 'deployment'").get(id) },
    { reason: 'deployment', delta_cash: 1296, ref: `deployment:${done.id}` });
  assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'deployment'").get().message, /recon sweep/);
  assert.equal(svc.history(id)[0].status, 'returned');

  // Recalling pays nothing but the hours still count.
  const t = now + 5 * HOUR;
  players.transaction(() => svc.start(id, 'long-range', t));
  assert.equal(players.transaction(() => svc.recall(id, t + 2 * HOUR)).kind.id, 'long-range');
  assert.equal(players.findById(id).deploy_until, null);
  assert.match(players.transaction(() => svc.recall(id, t + 2 * HOUR)).error, /not on deployment/);
  assert.ok(Math.abs(svc.hoursUsed(id, t + 2 * HOUR) - 6) < 1e-9);
  // 6 used: an 8h and a 12h won't both fit; the 12h alone won't either after the 8h.
  players.transaction(() => svc.start(id, 'long-range', t + 2 * HOUR));
  svc.completeDue(t + 10 * HOUR, null, seq(0, 0.9, 0.9));
  assert.match(players.transaction(() => svc.start(id, 'recon', t + 10 * HOUR)).error, /Only 2h|used today/);

  // Events multiply the return, and an ambush hurts.
  db.prepare("DELETE FROM deployments").run();
  fx = { ...NEUTRAL, cashMult: 1.5, xpMult: 2 };
  const t2 = t + 11 * HOUR;
  const cashBefore = players.findById(id).cash;
  players.transaction(() => svc.start(id, 'patrol', t2));
  const [boosted] = svc.completeDue(t2 + HOUR, id, seq(0, 0.9, 0.01));
  assert.equal(boosted.cash, 540);
  u = players.findById(id);
  assert.equal(u.cash, cashBefore + 540);
  assert.ok(u.health < u.max_health);
  assert.match(svc.history(id)[0].report, /ambush/);
});

test('deployments page and flow through the app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
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
  const post = async (p, extra = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...extra } });
  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/register'), username: 'Scout', email: 's@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    let page = (await request('/deployments')).text;
    assert.match(page, /Perimeter patrol/);
    assert.match(page, /Unlocks at level 5/);
    assert.match((await request('/hq')).text, /earn while you’re away/);

    await post('/deployments/start/recon');
    const until = db.prepare('SELECT deploy_until FROM users').get().deploy_until;
    assert.ok(until > Date.now());
    page = (await request('/hq')).text;
    assert.match(page, /You're on deployment/);
    assert.match(page, /Missions resume when you're back/);

    // Missions and training are off while away.
    const cash = db.prepare('SELECT cash FROM users').get().cash;
    await post(`/missions/${game.MISSIONS[0].id}`);
    await post('/training/strength');
    assert.deepEqual({ ...db.prepare('SELECT missions_completed + missions_failed AS runs, stat_str FROM users').get() }, { runs: 0, stat_str: 0 });
    assert.equal(db.prepare('SELECT cash FROM users').get().cash, cash);

    // Time passes: viewing the page brings the soldier home with pay.
    db.prepare('UPDATE deployments SET ends_at = ?').run(Date.now() - 1);
    db.prepare('UPDATE users SET deploy_until = ?').run(Date.now() - 1);
    page = (await request('/deployments')).text;
    assert.match(page, /After-action reports[\s\S]*Recon sweep[\s\S]*\+\$/);
    assert.ok(db.prepare('SELECT cash FROM users').get().cash > cash);
    assert.doesNotMatch(page, /You're on deployment/);

    // Start and recall.
    await post('/deployments/start/patrol');
    await post('/deployments/recall');
    assert.equal(db.prepare("SELECT status FROM deployments ORDER BY id DESC").get().status, 'recalled');
    assert.match((await request('/deployments')).text, /Recalled early/);
  } finally {
    server.close();
  }
});
