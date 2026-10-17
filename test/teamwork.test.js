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
