'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const specialOps = require('../src/special-ops');
const game = require('../src/game');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const HOUR = 3600e3;

test('special operation rules: openings, stages and bonuses', () => {
  const t = Date.parse('2026-10-21T06:30:00Z');
  const w = specialOps.windowAt(t);
  assert.equal(w.opensAt, Date.parse('2026-10-21T06:00:00Z'));
  assert.equal(w.closesAt, Date.parse('2026-10-21T09:00:00Z'));
  assert.equal(w.open, true);
  assert.equal(specialOps.windowAt(Date.parse('2026-10-21T10:00:00Z')).open, false, 'closed for the second half');
  assert.equal(specialOps.windowAt(Date.parse('2026-10-21T08:59:00Z')).op.id, w.op.id, 'the same op all window');
  assert.equal(specialOps.nextOpening(Date.parse('2026-10-21T10:00:00Z')), Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(specialOps.nextOpening(t), w.opensAt, 'an open one counts as next');
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add(specialOps.windowAt(i * specialOps.EVERY_MS).op.id);
  assert.ok(seen.size >= 6, 'they rotate');
  for (const op of specialOps.OPS) assert.equal(op.stages.length, 3, op.id);

  const base = game.MISSIONS.find((m) => m.minLevel === 12);
  const op = specialOps.OPS[0];
  const stealth = specialOps.stageMission(op, 1, 'stealth', base);
  const assault = specialOps.stageMission(op, 1, 'assault', base);
  assert.ok(stealth.chance > base.chance && assault.chance < base.chance);
  assert.ok(assault.cash[1] > stealth.cash[1] * 1.5);
  assert.ok(assault.damage[1] > stealth.damage[1]);
  assert.equal(stealth.favours, 'agility');
  assert.equal(assault.favours, 'strength');
  assert.equal(stealth.energy, base.energy);
  assert.ok(specialOps.completionBonus(base, 3).cash > specialOps.completionBonus(base, 0).cash);
  tuning.set({ specialOpPayMult: 2 });
  try { assert.equal(specialOps.stageMission(op, 1, 'stealth', base).cash[1], stealth.cash[1] * 2); } finally { tuning.reset(); }
});

test('special operations through the app: choices, a run to the end, one run per opening', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
    for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const flash = async (p) => {
    const r = await request(p, { method: 'POST', form: { _csrf: await csrf() } });
    const page = (await request(r.location)).text;
    return { message: [...page.matchAll(/<p class="flash flash--(\w+)">([^<]*)<\/p>/g)].map((m) => m[2]).join(' | '), page, r };
  };
  // An open window: now if one is open, else the next one.
  const now = Date.now();
  const at = specialOps.windowAt(now).open ? now : specialOps.nextOpening(now) + 60e3;
  app.specialOps.clock = () => at;
  let dice = 0; // every roll succeeds
  app.specialOps.rng = () => dice;

  try {
    await request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username: 'Ace', email: 'a@x.com', password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    const id = db.prepare("SELECT id FROM users WHERE username = 'Ace'").get().id;
    const op = specialOps.windowAt(at).op;

    // Below level 10 it doesn't show.
    assert.doesNotMatch((await request('/missions')).text, /id="special"/);
    db.prepare('UPDATE users SET level = 12, energy = 300, max_energy = 300, health = 400, max_health = 400 WHERE id = ?').run(id);
    let page = (await request('/missions')).text;
    assert.match(page, new RegExp(`Special operation[\\s\\S]*${op.name}`));
    assert.match(page, /Stage 1 of 3/);
    assert.match(page, /action="\/special\/stealth"[\s\S]*action="\/special\/assault"/);
    assert.match((await request('/hq')).text, new RegExp(`Special operation: ${op.name} · open now`));

    // Stage 1 by stealth, stage 2 by assault, stage 3 by assault: complete.
    let f = await flash('/special/stealth');
    assert.match(f.message, new RegExp(`${op.name}: ${op.stages[0].name} \\(stealth\\): done`));
    assert.match(f.page, /Stage 2 of 3/);
    await flash('/special/assault');
    const cash = db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
    app.specialOps.rng = () => (dice++ === 0 ? 0 : 0.99); // the stage succeeds; then no vehicle, few materials
    f = await flash('/special/assault');
    assert.match(f.message, new RegExp(`${op.name} complete! Bonus \\+\\$[\\d,]+ and \\+[\\d,]+ XP`));
    assert.ok(db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash > cash);
    const run = db.prepare('SELECT * FROM special_runs WHERE user_id = ?').get(id);
    assert.deepEqual([run.status, run.assaults, run.op_id], ['done', 2, op.id]);
    assert.equal(db.prepare('SELECT specials_done FROM users WHERE id = ?').get(id).specials_done, 1);
    assert.ok(db.prepare("SELECT 1 FROM ledger WHERE user_id = ? AND reason = 'special-op'").get(id));
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id').all(id).map((n) => n.message).join('\n'), /Special Forces Tab/);
    assert.match(f.page, /Operation complete\. 1 soldier finished it/);

    // One run per opening.
    f = await flash('/special/stealth');
    assert.match(f.message, /You’ve completed this one/);
    assert.equal((await request('/special/sideways', { method: 'POST', form: { _csrf: await csrf() } })).res.status, 302);
    assert.match((await request('/missions')).text, /Choose stealth or assault|Operation complete/);

    // The next opening: a failed stage ends the run.
    const later = at + specialOps.EVERY_MS;
    app.specialOps.clock = () => later;
    app.specialOps.rng = () => 0.999; // every roll fails
    f = await flash('/special/assault');
    assert.match(f.message, /failed\. You took \d+ damage, and this run is over/);
    assert.equal(db.prepare('SELECT status FROM special_runs WHERE user_id = ? AND window_key = ?').get(id, specialOps.windowAt(later).key).status, 'failed');
    f = await flash('/special/stealth');
    assert.match(f.message, /Your run is over/);

    // A completed run can capture a vehicle.
    const third = later + specialOps.EVERY_MS;
    app.specialOps.clock = () => third;
    app.specialOps.rng = () => 0;
    db.prepare('UPDATE users SET energy = max_energy, health = max_health, hospital_until = NULL WHERE id = ?').run(id);
    for (let i = 0; i < 3; i += 1) f = await flash('/special/stealth');
    assert.match(f.message, /plus .*a captured /);
    assert.ok(app.vehicles.owned(id).size >= 1);

    // After it closes, the result stays up; a closed one they never ran says when the next opens, and refuses runs.
    app.specialOps.clock = () => specialOps.windowAt(third).closesAt + 60e3;
    assert.match((await request('/missions')).text, /Operation complete/);
    app.specialOps.clock = () => specialOps.windowAt(third + specialOps.EVERY_MS).closesAt + 60e3;
    page = (await request('/missions')).text;
    assert.match(page, /Next special operation in/);
    f = await flash('/special/stealth');
    assert.match(f.message, /has closed/);
    // Admins can pause them.
    app.specialOps.clock = () => third + 2 * specialOps.EVERY_MS;
    tuning.set({ specialOpsEnabled: false });
    f = await flash('/special/stealth');
    assert.match(f.message, /paused/);
  } finally {
    tuning.reset();
    server.close();
  }
});
