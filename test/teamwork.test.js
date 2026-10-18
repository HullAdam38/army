'use strict';

// Teamwork features: the chain of command and rally orders, unit raids, and the theatre of war.

const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../src/units');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

/** A test app with a ready-made unit: Commander, Lieutenant, Sergeant and Private. */
async function setup() {
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
    c.act = async (path, form = {}, from = '/hq') => {
      const r = await c.request(path, { method: 'POST', form: { _csrf: await c.csrf(from), ...form } });
      if (r.res.status >= 400) return { status: r.res.status, message: '' };
      const page = (await c.request(r.location)).text;
      return { status: r.res.status, location: r.location, message: (page.match(/class="flash flash--\w+"[^>]*>([^<]*)</) || [])[1] || '' };
    };
    return c;
  };
  const join = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    return c;
  };
  let c;
  try {
    c = { cmd: await join('Cmdr'), lt: await join('Lieut'), sgt: await join('Sarge'), pvt: await join('Private1') };
  } catch (err) {
    server.close(); // don't leave the test server running if setup fails
    throw err;
  }
  db.prepare('UPDATE users SET level = 10, max_energy = 95, energy = 95, max_health = 190, health = 190').run();
  const unitId = Number(db.prepare("INSERT INTO units (name, tag, treasury, created_at) VALUES ('Iron Wolves', 'IW', 100000, ?)").run(Date.now()).lastInsertRowid);
  for (const [k, role] of [['cmd', 'leader'], ['lt', 'officer'], ['sgt', 'sergeant'], ['pvt', 'member']]) {
    db.prepare('UPDATE users SET unit_id = ?, unit_role = ?, unit_joined_at = ? WHERE id = ?').run(unitId, role, Date.now(), c[k].id);
  }
  return { db, app, server, c, unitId, join, U: `/units/${unitId}` };
}

test('rally orders: Lieutenants and up, paid from the treasury, alert everyone', async () => {
  const { db, server, c, unitId, U } = await setup();
  try {
    let page = (await c.pvt.request(U)).text;
    assert.match(page, /Rally order: Advance!/);
    assert.match(page, /Ask a Lieutenant or the Commander/);
    assert.match((await c.sgt.act(`${U}/rally`, {}, U)).message, /Only Lieutenants and the Commander/);

    const cost = units.rallyCost(4, 10);
    assert.match((await c.lt.act(`${U}/rally`, {}, U)).message, /Rally called: \+15%/);
    const unit = db.prepare('SELECT treasury, rally_until FROM units WHERE id = ?').get(unitId);
    assert.equal(unit.treasury, 100000 - cost);
    assert.ok(unit.rally_until > Date.now() + 55 * 60 * 1000);
    // Everyone else hears about it (and it pushes as a unit alert).
    for (const k of ['cmd', 'sgt', 'pvt']) {
      assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(c[k].id).message, /called a rally/);
    }
    assert.match((await c.pvt.request(U)).text, /Rally under way/);
    assert.match((await c.cmd.act(`${U}/rally`, {}, U)).message, /already under way/);
    // When it ends, the 12-hour cooldown still applies.
    db.prepare('UPDATE units SET rally_until = ? WHERE id = ?').run(Date.now() - 1, unitId);
    assert.match((await c.cmd.act(`${U}/rally`, {}, U)).message, /another rally in 12 hours/);
    // And the treasury must cover it.
    db.prepare('UPDATE units SET rally_at = NULL, treasury = 10 WHERE id = ?').run(unitId);
    assert.match((await c.cmd.act(`${U}/rally`, {}, U)).message, /costs \$/);
    assert.match(db.prepare("SELECT message FROM unit_log WHERE unit_id = ? AND kind = 'rally'").get(unitId).message, /Lieut called a rally/);

  } finally {
    server.close();
  }
});

test('promotions follow the chain of command', async () => {
  const { db, server, c, U } = await setup();
  const role = (k) => db.prepare('SELECT unit_role FROM users WHERE id = ?').get(c[k].id).unit_role;
  try {
    // A Lieutenant makes Privates into Sergeants, but can't make Lieutenants.
    assert.match((await c.lt.act(`${U}/members/${c.pvt.id}/promote`, {}, U)).message, /Private1 is now a Sergeant/);
    assert.match((await c.lt.act(`${U}/members/${c.pvt.id}/promote`, {}, U)).message, /any further/);
    assert.match((await c.lt.act(`${U}/members/${c.pvt.id}/demote`, {}, U)).message, /Private1 is now a Private/);
    // Nobody below the Commander can touch the Commander.
    assert.match((await c.lt.act(`${U}/members/${c.cmd.id}/promote`, {}, U)).message, /any further/);
    assert.match((await c.lt.act(`${U}/members/${c.cmd.id}/demote`, {}, U)).message, /below your rank/);
    assert.equal(role('cmd'), 'leader');
    // A Sergeant can't promote, demote or remove anyone.
    assert.match((await c.sgt.act(`${U}/members/${c.pvt.id}/promote`, {}, U)).message, /Only Lieutenants/);
    assert.match((await c.sgt.act(`${U}/members/${c.pvt.id}/kick`, {}, U)).message, /below your rank/);
    // The Commander makes Lieutenants; nobody can demote someone of their own rank.
    assert.match((await c.cmd.act(`${U}/members/${c.sgt.id}/promote`, {}, U)).message, /Sarge is now a Lieutenant/);
    assert.match((await c.lt.act(`${U}/members/${c.sgt.id}/demote`, {}, U)).message, /below your rank/);
    assert.deepEqual([role('lt'), role('sgt'), role('pvt')], ['officer', 'officer', 'member']);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(c.sgt.id).message, /promoted to Lieutenant.*rally orders/);
    // The roster shows the new rank names.
    const page = (await c.pvt.request(U)).text;
    for (const label of ['Commander', 'Lieutenant', 'Private']) assert.match(page, new RegExp(`unit-role--\\w+">${label}<`));
  } finally {
    server.close();
  }
});

test('raids: Lieutenants launch from the treasury, members strike, loot is shared by damage', async () => {
  const raids = require('../src/raids');
  const { db, app, server, c, unitId, U } = await setup();
  const raid = () => db.prepare('SELECT * FROM raids WHERE unit_id = ? ORDER BY id DESC').get(unitId);
  try {
    let page = (await c.pvt.request(U)).text;
    assert.match(page, /id="raid"/);
    assert.match(page, /Ask a Lieutenant or the Commander to launch one/);
    assert.match((await c.sgt.act(`${U}/raid`, { stronghold: 'outpost' }, U)).message, /Only Lieutenants and the Commander/);
    // The unit averages level 10, so the bunker (level 20) is locked.
    assert.match((await c.lt.act(`${U}/raid`, { stronghold: 'bunker' }, U)).message, /needs a unit average of level 20/);
    assert.match((await c.lt.act(`${U}/raid`, { stronghold: 'nope' }, U)).message, /Pick a stronghold/);

    const plan = raids.plan(raids.STRONGHOLDS_BY_ID.get('compound'), { members: 4, avgLevel: 10 });
    assert.match((await c.lt.act(`${U}/raid`, { stronghold: 'compound' }, U)).message, /Raid launched on the Fortified Compound/);
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury, 100000 - plan.cost);
    assert.deepEqual([raid().hp, raid().max_hp, raid().cash_pool], [plan.hp, plan.hp, plan.cash]);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(c.pvt.id).message, /launched a raid on the Fortified Compound/);
    assert.match((await c.cmd.act(`${U}/raid`, { stronghold: 'outpost' }, U)).message, /already on a raid/);

    // A strike spends energy, costs a little health and is recorded.
    assert.match((await c.pvt.act(`${U}/raid/strike`, {}, U)).message, /Strike for [\d,]+ damage/);
    const me = db.prepare('SELECT energy, health FROM users WHERE id = ?').get(c.pvt.id);
    assert.equal(me.energy, 95 - raids.STRIKE_ENERGY);
    assert.ok(me.health < 190);
    const hit = db.prepare('SELECT * FROM raid_hits WHERE user_id = ?').get(c.pvt.id);
    assert.equal(hit.strikes, 1);
    assert.equal(raid().hp, plan.hp - hit.damage);
    page = (await c.pvt.request(U)).text;
    assert.match(page, /Your damage: [\d,]+ in 1 strike\./);
    assert.match(page, /Top strikers/);

    // Out of energy: no strike.
    db.prepare('UPDATE users SET energy = 5, energy_updated_at = ? WHERE id = ?').run(Date.now(), c.sgt.id);
    assert.match((await c.sgt.act(`${U}/raid/strike`, {}, U)).message, /need 10 energy/);
    // Not a member: no strike.
    db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL WHERE id = ?').run(c.sgt.id);
    assert.match((await c.sgt.act(`${U}/raid/strike`, {}, U)).message, /Only members/);
    db.prepare("UPDATE users SET unit_id = ?, unit_role = 'sergeant' WHERE id = ?").run(unitId, c.sgt.id);

    // Just above a quarter left: the next strike takes it 75% down and members are told.
    db.prepare('UPDATE raids SET hp = ? WHERE id = ?').run(Math.round(plan.hp * 0.25) + 5, raid().id);
    await c.cmd.act(`${U}/raid/strike`, {}, U);
    assert.ok(raid().nudged_at);
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(c.lt.id).message, /Finish it!/);

    // The final blow: loot shared by damage, a quarter to the treasury.
    db.prepare('UPDATE raids SET hp = 1 WHERE id = ?').run(raid().id);
    const before = Object.fromEntries(['cmd', 'pvt', 'lt'].map((k) => [k, db.prepare('SELECT cash FROM users WHERE id = ?').get(c[k].id).cash]));
    const treasury = db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury;
    assert.match((await c.lt.act(`${U}/raid/strike`, {}, U)).message, /has fallen/);
    assert.equal(raid().status, 'won');
    const hits = db.prepare('SELECT * FROM raid_hits WHERE raid_id = ?').all(raid().id);
    const total = hits.reduce((n, h) => n + h.damage, 0);
    const pool = plan.cash - Math.round(plan.cash * raids.TREASURY_SHARE);
    for (const h of hits) {
      const k = Object.keys(c).find((key) => c[key].id === h.user_id);
      assert.equal(h.cash, Math.floor(pool * (h.damage / total)));
      assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(h.user_id).cash, before[k] + h.cash);
      assert.ok(db.prepare("SELECT 1 FROM ledger WHERE user_id = ? AND reason = 'raid-loot'").get(h.user_id));
    }
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury, treasury + Math.round(plan.cash * raids.TREASURY_SHARE));
    assert.match((await c.pvt.request(U)).text, /Last raid: Fortified Compound, taken/);

    // A raid that runs out of time pays nothing.
    assert.match((await c.cmd.act(`${U}/raid`, { stronghold: 'outpost' }, U)).message, /Raid launched/);
    await c.pvt.act(`${U}/raid/strike`, {}, U);
    const cash = db.prepare('SELECT cash FROM users WHERE id = ?').get(c.pvt.id).cash;
    db.prepare('UPDATE raids SET ends_at = ? WHERE id = ?').run(Date.now() + 60 * 60 * 1000, raid().id);
    app.raids.finishDue();
    assert.ok(raid().reminded_at, '6-hour reminder');
    assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(c.pvt.id).message, /6 hours left/);
    db.prepare('UPDATE raids SET ends_at = ? WHERE id = ?').run(Date.now() - 1, raid().id);
    app.raids.finishDue();
    assert.equal(raid().status, 'failed');
    assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(c.pvt.id).cash, cash);
    assert.match(db.prepare("SELECT message FROM unit_log WHERE unit_id = ? AND kind = 'raid' ORDER BY id DESC").get(unitId).message, /ran out of time/);
  } finally {
    server.close();
  }
});

test('raid maths: health scales with the unit, loot splits by damage', () => {
  const raids = require('../src/raids');
  const outpost = raids.STRONGHOLDS_BY_ID.get('outpost');
  // Small units are sized as three members.
  assert.deepEqual(raids.plan(outpost, { members: 1, avgLevel: 5 }), raids.plan(outpost, { members: 3, avgLevel: 5 }));
  assert.ok(raids.plan(outpost, { members: 10, avgLevel: 5 }).hp > raids.plan(outpost, { members: 3, avgLevel: 5 }).hp);
  assert.deepEqual(raids.available({ members: 5, avgLevel: 20 }).map((s) => s.id), ['outpost', 'compound', 'bunker']);
  const loot = raids.splitLoot({ cash: 1000, xp: 100 }, [{ user_id: 1, damage: 300 }, { user_id: 2, damage: 100 }]);
  assert.equal(loot.treasury, 250);
  assert.deepEqual(loot.players.map((p) => [p.userId, p.cash, p.xp]), [[1, 562, 75], [2, 187, 25]]);
  assert.deepEqual(raids.splitLoot({ cash: 1000, xp: 100 }, []).players, []);
});

test('theatre of war: fronts, scoring, weekly handover, holder bonus and daily income', async () => {
  const theatre = require('../src/theatre');
  const { db, app, server, c, unitId, join, U } = await setup();
  const DAY = 24 * 60 * 60 * 1000;
  const monday = Date.parse(`${theatre.weekKey(Date.now())}T12:00:00Z`);
  const week = (n) => monday + n * 7 * DAY; // midday on the Monday n weeks from this one
  const holder = (region) => (db.prepare('SELECT unit_id FROM theatre_regions WHERE region = ?').get(region) || {}).unit_id || null;
  const lastNote = (id) => db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(id).message;
  try {
    // A rival unit with three members.
    const rivals = [await join('Rival1'), await join('Rival2'), await join('Rival3')];
    const rivalId = Number(db.prepare("INSERT INTO units (name, tag, treasury, created_at) VALUES ('Red Fox', 'RF', 0, ?)").run(Date.now()).lastInsertRowid);
    rivals.forEach((r, i) => db.prepare('UPDATE users SET unit_id = ?, unit_role = ?, unit_joined_at = ? WHERE id = ?').run(rivalId, i ? 'member' : 'leader', Date.now(), r.id));

    let page = (await c.pvt.request('/theatre')).text;
    assert.match(page, /Theatre of war/);
    assert.match(page, /has no front this week/);
    assert.match(page, /Lieutenants and the Commander choose the front/);
    assert.match((await c.lt.request('/theatre')).text, /<select id="front-region" name="region"/);
    assert.match((await c.sgt.act('/theatre/front', { region: 'capital' }, '/theatre')).message, /Only Lieutenants/);
    assert.match((await c.lt.act('/theatre/front', { region: 'atlantis' }, '/theatre')).message, /Pick a region/);
    assert.match((await c.lt.act('/theatre/front', { region: 'capital' }, '/theatre')).message, /Front opened in Capital District/);
    assert.match(lastNote(c.pvt.id), /opened a front in Capital District/);
    assert.match((await c.cmd.act('/theatre/front', { region: 'port' }, '/theatre')).message, /move the front again in 6 hours/);
    assert.match((await c.cmd.request(U)).text, /Fighting for <strong class="unit-theatre__front">Capital District/);

    // Play scores on the front: missions 1, PvP wins 3, and raid strikes (through the real route) 2.
    app.theatre.track(c.pvt.id, 'missions', 2);
    app.theatre.track(c.sgt.id, 'pvp_wins', 1);
    await c.lt.act(`${U}/raid`, { stronghold: 'outpost' }, U);
    await c.pvt.act(`${U}/raid/strike`, {}, U);
    const pts = () => db.prepare('SELECT points FROM theatre_scores WHERE unit_id = ? AND region = ?').get(unitId, 'capital').points;
    assert.equal(pts(), 2 + 3 + 2);
    assert.equal(db.prepare('SELECT points FROM theatre_contrib WHERE user_id = ?').get(c.pvt.id).points, 4);
    page = (await c.pvt.request('/theatre')).text;
    assert.match(page, /<dt>Unit points<\/dt><dd>7<\/dd>/);
    assert.match(page, /<dt>Your points<\/dt><dd>4<\/dd>/);
    // Someone not in a unit scores nothing; a unit with no front scores nothing.
    app.theatre.track(rivals[0].id, 'missions', 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM theatre_scores WHERE unit_id = ?').get(rivalId).n, 0);

    // The rival opens a front in the same region but scores less: [IW] takes it when the week ends.
    const rivalUnit = db.prepare('SELECT * FROM units WHERE id = ?').get(rivalId);
    const leader = db.prepare('SELECT * FROM users WHERE id = ?').get(rivals[0].id);
    db.exec('BEGIN'); app.theatre.setFront({ unit: rivalUnit, role: 'leader', me: leader, regionId: 'capital' }); db.exec('COMMIT');
    app.theatre.track(rivals[1].id, 'missions', 5);
    app.theatre.settleDue(week(1));
    assert.equal(holder('capital'), unitId);
    assert.match(lastNote(c.pvt.id), /took Capital District/);
    assert.equal(app.theatre.xpBonus(unitId), 0.03);
    app.theatre.settleDue(week(1)); // settling twice changes nothing
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM theatre_weeks').get().n, 1);

    // Daily income, once per region per day.
    const treasury = () => db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury;
    const before = treasury();
    app.theatre.payIncome(week(1));
    app.theatre.payIncome(week(1) + 60 * 1000);
    assert.equal(treasury(), before + 6000);
    app.theatre.payIncome(week(1) + DAY);
    assert.equal(treasury(), before + 12000);

    // Week 2: [IW] defends with 9 points (+25% = 11) against 11: a tie keeps the holder.
    for (const [unit, by, n] of [[unitId, c.cmd.id, 9], [rivalId, rivals[0].id, 11]]) {
      db.prepare('INSERT INTO theatre_fronts (week, unit_id, region, set_by, set_at) VALUES (?, ?, ?, ?, ?)').run(theatre.weekKey(week(1)), unit, 'capital', by, week(1));
      app.theatre.track(by, 'missions', n, week(1));
    }
    app.theatre.settleDue(week(2));
    assert.equal(holder('capital'), unitId);
    // Week 3: 13 beats 9 + 25%, and the region changes hands.
    for (const [unit, by, n] of [[unitId, c.cmd.id, 9], [rivalId, rivals[0].id, 13]]) {
      db.prepare('INSERT INTO theatre_fronts (week, unit_id, region, set_by, set_at) VALUES (?, ?, ?, ?, ?)').run(theatre.weekKey(week(2)), unit, 'capital', by, week(2));
      app.theatre.track(by, 'missions', n, week(2));
    }
    app.theatre.settleDue(week(3));
    assert.equal(holder('capital'), rivalId);
    assert.match(lastNote(c.pvt.id), /lost Capital District to \[RF\] Red Fox/);
    assert.match(lastNote(rivals[2].id), /\[RF\] took Capital District/);
    assert.equal(app.theatre.xpBonus(unitId), 0);
    assert.match((await c.pvt.request('/theatre')).text, /Red Fox took it from Iron Wolves/);

    // Too small to open a front.
    db.prepare('UPDATE users SET unit_id = NULL, unit_role = NULL WHERE id = ?').run(rivals[2].id);
    db.exec('BEGIN');
    const out = app.theatre.setFront({ unit: rivalUnit, role: 'leader', me: leader, regionId: 'port', now: week(3) });
    db.exec('COMMIT');
    assert.match(out.error, /at least 3 members/);
  } finally {
    server.close();
  }
});

test('theatre maths: deciding a region', () => {
  const theatre = require('../src/theatre');
  assert.equal(theatre.decide([], 5), 5);
  assert.equal(theatre.decide([{ unit_id: 1, points: 0 }], null), null);
  assert.equal(theatre.decide([{ unit_id: 1, points: 4 }, { unit_id: 2, points: 4 }], null), null, 'a tie between challengers leaves it unheld');
  assert.equal(theatre.decide([{ unit_id: 1, points: 10 }, { unit_id: 2, points: 12 }], 1), 1, '10 + 25% beats 12');
  assert.equal(theatre.decide([{ unit_id: 1, points: 10 }, { unit_id: 2, points: 13 }], 1), 2);
  assert.equal(theatre.xpBonus(theatre.REGIONS.map((r) => r.id)), theatre.MAX_XP_BONUS);
});

test('admin raids & map: extend and call off raids, hand over regions, wipe points', async () => {
  const { db, app, server, c, unitId, join, U } = await setup();
  const raid = () => db.prepare('SELECT * FROM raids WHERE unit_id = ? ORDER BY id DESC').get(unitId);
  const treasury = () => db.prepare('SELECT treasury FROM units WHERE id = ?').get(unitId).treasury;
  const lastNote = (id) => db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'unit' ORDER BY id DESC").get(id).message;
  const audit = () => ({ ...db.prepare('SELECT action, details FROM admin_actions ORDER BY id DESC').get() });
  try {
    const hq = await join('HQBoss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(hq.id);
    const A = '/admin/teamwork';
    assert.equal((await c.cmd.request(A)).res.status, 404, 'admins only');

    await c.lt.act(`${U}/raid`, { stronghold: 'outpost' }, U);
    await c.pvt.act(`${U}/raid/strike`, {}, U);
    const cost = raid().supply_cost;
    assert.ok(cost > 0, 'supplies are recorded');
    let page = (await hq.request(A)).text;
    assert.match(page, /Raids under way \(1\)/);
    assert.match(page, /Insurgent Outpost · launched by Lieut/);
    assert.match(page, /class="admin-nav__link" href="\/admin\/teamwork" aria-current="page"/);

    // More time: needs a reason and 1–48 hours.
    const R = `/admin/raids/${raid().id}`;
    assert.match((await hq.act(`${R}/extend`, { hours: '12', reason: '' }, A)).message, /Give a reason/);
    assert.match((await hq.act(`${R}/extend`, { hours: '99', reason: 'Outage' }, A)).message, /between 1 and 48/);
    const ends = raid().ends_at;
    assert.match((await hq.act(`${R}/extend`, { hours: '12', reason: 'Outage' }, A)).message, /Gave \[IW\] Iron Wolves(?:'|&#39;)s raid on the Insurgent Outpost 12 more hours/);
    assert.equal(raid().ends_at, ends + 12 * 3_600_000);
    assert.match(lastNote(c.pvt.id), /12 more hours/);
    assert.deepEqual(audit(), { action: 'raid-extend', details: "Gave [IW] Iron Wolves's raid on the Insurgent Outpost 12 more hours. Reason: Outage" });

    // Calling it off: no loot, supplies refunded when asked, and it can't be called off twice.
    const before = treasury();
    const cash = db.prepare('SELECT cash FROM users WHERE id = ?').get(c.pvt.id).cash;
    assert.match((await hq.act(`${R}/cancel`, { reason: 'Alt accounts striking', refund: 'on' }, A)).message, /Called off .* and refunded \$/);
    assert.equal(raid().status, 'cancelled');
    assert.equal(treasury(), before + cost);
    assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(c.pvt.id).cash, cash);
    assert.match(lastNote(c.pvt.id), /HQ called off \[IW\](?:'|&#39;)s raid on the Insurgent Outpost: Alt accounts striking/);
    assert.match((await hq.act(`${R}/cancel`, { reason: 'Again' }, A)).message, /isn’t under way/);
    assert.match((await c.pvt.request(U)).text, /Last raid: Insurgent Outpost, called off by HQ/);
    assert.match((await hq.request(A)).text, /called off by HQ/);
    // Without the refund box, the supplies stay spent.
    await c.lt.act(`${U}/raid`, { stronghold: 'outpost' }, U);
    const t2 = treasury();
    assert.match((await hq.act(`/admin/raids/${raid().id}/cancel`, { reason: 'Test' }, A)).message, /with no refund/);
    assert.equal(treasury(), t2);

    // Regions: hand one over by tag, refuse unknown tags and no-ops, then free it.
    assert.match((await hq.act('/admin/theatre/capital/holder', { tag: 'ZZ', reason: 'x' }, A)).message, /No unit has the tag \[ZZ\]/);
    assert.match((await hq.act('/admin/theatre/capital/holder', { tag: '[iw]', reason: 'Compensation' }, A)).message, /Handed Capital District to \[IW\] Iron Wolves \(was nobody\)/);
    assert.equal(app.theatre.xpBonus(unitId), 0.03);
    assert.match(lastNote(c.cmd.id), /HQ has handed Capital District to \[IW\]/);
    assert.match((await hq.act('/admin/theatre/capital/holder', { tag: 'IW', reason: 'x' }, A)).message, /already holds/);
    assert.match((await hq.request(A)).text, /Held by <a href="\/units\/\d+">\[IW\] Iron Wolves<\/a>/);
    assert.match((await hq.act('/admin/theatre/capital/holder', { tag: '', reason: 'Undo' }, A)).message, /Freed Capital District \(was \[IW\] Iron Wolves\)/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theatre_regions WHERE region = 'capital'").get().n, 0);
    assert.match(lastNote(c.cmd.id), /HQ has taken Capital District from \[IW\]/);
    assert.equal((await hq.act('/admin/theatre/atlantis/holder', { tag: 'IW', reason: 'x' }, A)).message.includes('doesn’t exist'), true);

    // Wiping a unit's points for the week.
    await c.lt.act('/theatre/front', { region: 'port' }, '/theatre');
    app.theatre.track(c.pvt.id, 'missions', 4);
    assert.match((await hq.request(A)).text, /\[IW\] Iron Wolves<\/a> <span class="muted">· 4 points/);
    assert.match((await hq.act(`/admin/theatre/units/${unitId}/wipe`, { reason: 'Farmed' }, A)).message, /Removed \[IW\] Iron Wolves(?:'|&#39;)s 4 theatre points/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM theatre_scores WHERE unit_id = ?').get(unitId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM theatre_contrib WHERE unit_id = ?').get(unitId).n, 0);
    assert.match((await hq.act(`/admin/theatre/units/${unitId}/wipe`, { reason: 'Again' }, A)).message, /no theatre points this week/);
    assert.equal(audit().action, 'theatre-wipe');
  } finally {
    server.close();
  }
});
