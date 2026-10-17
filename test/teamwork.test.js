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
