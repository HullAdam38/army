'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const workshop = require('../src/workshop');
const gear = require('../src/gear');
const game = require('../src/game');
const tuning = require('../src/tuning');
const vehicles = require('../src/vehicles');
const { ITEMS_BY_ID } = require('../src/items');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('workshop rules: drops, recipes, salvage and upgrade power', () => {
  const rifle = ITEMS_BY_ID.get('assault-rifle'); // $1,800
  const vest = ITEMS_BY_ID.get('flak-vest');
  assert.equal(workshop.specialty(rifle), 'circuits');
  assert.equal(workshop.specialty(vest), 'composite');
  assert.equal(workshop.specialty(vehicles.VEHICLES_BY_ID.get('trail-bike')), 'circuits');
  assert.equal(workshop.specialty(vehicles.VEHICLES_BY_ID.get('apc')), 'composite');

  // Drops: worth a share of the pay, rounded at random. A sure roll gives the ceiling, a zero roll the floor.
  const high = workshop.drop(10000, () => 0);
  const low = workshop.drop(10000, () => 0.999);
  assert.deepEqual(low, { scrap: 28, circuits: 2, composite: 2 }); // $1,200 of worth: 28.8 scrap, 2.04 of each…
  assert.deepEqual(high, { scrap: 29, circuits: 3, composite: 3, core: 1 }); // …and a 7% chance of a core
  assert.deepEqual(workshop.drop(0), {});
  assert.ok((workshop.drop(10000, () => 0, 'operation').core || 0) >= 1, 'operations are rich in cores');
  tuning.set({ workshopDropMult: 0 });
  try { assert.deepEqual(workshop.drop(10000, () => 0), {}); } finally { tuning.reset(); }

  // Recipes: Mk n needs materials worth 8% × n of the price; cores from Mk II.
  const mk1 = workshop.recipe(rifle, 1);
  assert.deepEqual(mk1, { materials: { scrap: 4, circuits: 1 }, cash: 72 });
  const mk3 = workshop.recipe(rifle, 3);
  assert.deepEqual(mk3, { materials: { scrap: 10, circuits: 2, core: 1 }, cash: 216 }); // $432 of materials, rounded up
  assert.equal(workshop.describe(mk3.materials), '10 Scrap metal, 2 Circuit boards, 1 Prototype core');
  tuning.set({ workshopCostMult: 2 });
  try { assert.equal(workshop.recipe(rifle, 1).materials.scrap, 7); } finally { tuning.reset(); }

  // Salvage: a share of the price (less when worn), plus half the upgrade materials.
  assert.deepEqual(workshop.salvageYield(rifle, 100, 0), { scrap: 8, circuits: 1 });
  assert.deepEqual(workshop.salvageYield(rifle, 0, 0), { scrap: 4 });
  assert.deepEqual(workshop.salvageYield(rifle, 100, 2), { scrap: 8 + 2 + 3, circuits: 1 + 0 + 1 }); // plus half of Mk I (4, 1) and Mk II (7, 2), rounded down
  assert.ok(workshop.covers(new Map([['scrap', 4], ['circuits', 1]]), mk1.materials));
  assert.ok(!workshop.covers(new Map([['scrap', 4]]), mk1.materials));

  // Upgrades raise every stat of an item: +5% per level, on top of condition.
  assert.equal(workshop.nameOf(rifle, 2), 'Assault Rifle Mk II');
  const attack = (mods) => mods.find((m) => m.stat === 'attack').value;
  assert.equal(attack(gear.scaledMods(rifle, 100, 0)), 18);
  assert.ok(Math.abs(attack(gear.scaledMods(rifle, 100, 3)) - 18 * 1.15) < 1e-9);
  assert.ok(Math.abs(attack(gear.scaledMods(rifle, 0, 2)) - 18 * 0.5 * 1.1) < 1e-9);
  const plain = game.statsFor(10, ['assault-rifle']);
  const upgraded = game.statsFor(10, ['assault-rifle'], null, null, new Map([['assault-rifle', 3]]));
  assert.ok(upgraded.attack > plain.attack);
  // …and vehicles' bonuses: +10% per level.
  assert.ok(Math.abs(vehicles.bonusesOf(vehicles.VEHICLES_BY_ID.get('patrol-jeep'), 100, 2).missionChance - 0.048) < 1e-9);
});

test('the workshop: drops, upgrades, salvage and admin grants', async () => {
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
      async post(p, form = {}) { return c.request(p, { method: 'POST', form: { _csrf: await c.csrf(), ...form } }); },
      async flash(p, form = {}) {
        const r = await c.post(p, form);
        const page = (await c.request(r.location)).text;
        const m = page.match(/<p class="flash flash--(\w+)">([^<]*)<\/p>/);
        return { message: m ? m[2] : '', page };
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
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const qty = (id, m) => app.workshop.materials(id).get(m) || 0;

  try {
    const boss = await enlist('Boss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const ace = await enlist('Ace');
    db.prepare('UPDATE users SET level = 8, cash = 10000, energy = 200, max_energy = 200 WHERE id = ?').run(ace.id);
    app.players.addItem(ace.id, 'assault-rifle');
    app.players.equip(ace.id, 'weapon', 'assault-rifle');

    // The workshop is in the Armory menu and lists what you own.
    let page = (await ace.request('/armory/workshop')).text;
    assert.match(page, /href="\/armory\/workshop" aria-current="page">Workshop/);
    assert.match(page, /Assault Rifle/);
    assert.match(page, /Not enough yet/);

    // Won missions turn up materials now and then (always, with a big enough payout).
    tuning.set({ workshopDropMult: 5 });
    let found = 0;
    for (let i = 0; i < 6; i += 1) {
      await ace.post(`/missions/${game.MISSIONS[2].id}`);
      found = [...app.workshop.materials(ace.id).values()].reduce((a, b) => a + b, 0);
      if (found) break;
    }
    tuning.reset();
    assert.ok(found > 0, 'materials dropped');
    // Deployments bring some back too, and say so in the report.
    db.prepare('UPDATE users SET level = 20 WHERE id = ?').run(ace.id);
    const before = qty(ace.id, 'scrap');
    app.deployments.start(ace.id, 'long-range', Date.now() - 9 * 3600e3);
    const [back] = app.deployments.completeDue(Date.now(), ace.id);
    assert.ok(back);
    assert.ok(qty(ace.id, 'scrap') > before);
    assert.match(db.prepare("SELECT report FROM deployments WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(ace.id).report, /Brought back [^.]*Scrap metal[^.]* for the workshop/);

    // Upgrading: short of materials first, then enough.
    db.prepare('DELETE FROM materials WHERE user_id = ?').run(ace.id);
    let f = await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    assert.match(f.message, /Not enough materials\. Mk I needs 4 Scrap metal, 1 Circuit boards/);
    app.workshop.add(ace.id, { scrap: 100, circuits: 20, core: 1 });
    const rating = () => app.players.transaction(() => require('../src/armory').loadoutOf(app.players, user(ace.id)).rating);
    const r0 = rating();
    const cash = user(ace.id).cash;
    f = await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    assert.match(f.message, /Upgraded: Assault Rifle Mk I/);
    assert.equal(qty(ace.id, 'scrap'), 96);
    assert.equal(qty(ace.id, 'circuits'), 19);
    assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'workshop' AND ref = 'gear:assault-rifle:1'").get(ace.id).delta_cash, -72);
    assert.equal(user(ace.id).cash, cash - 72 + 250, 'the fee, then the Master Mechanic bronze');
    assert.ok(rating() > r0, 'stronger in combat');
    assert.match((await ace.request('/armory')).text, /Assault Rifle <span class="tag tag--mk">Mk I<\/span>/);
    assert.match((await boss.request('/profile/Ace')).text, /tag--mk">Mk I</);
    // The Master Mechanic medal.
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(ace.id).map((n) => n.message).join('\n'), /Master Mechanic/);
    await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    f = await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    assert.match(f.message, /Not enough materials|already fully upgraded/);
    app.workshop.add(ace.id, { core: 5 });
    f = await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    const level = app.players.upgrades(ace.id).get('assault-rifle');
    assert.ok(level >= 2);
    if (level < 3) { app.workshop.add(ace.id, { core: 5 }); await ace.flash('/armory/workshop/upgrade/gear/assault-rifle'); }
    assert.equal(app.players.upgrades(ace.id).get('assault-rifle'), 3);
    f = await ace.flash('/armory/workshop/upgrade/gear/assault-rifle');
    assert.match(f.message, /already fully upgraded/);
    f = await ace.flash('/armory/workshop/upgrade/gear/carbine');
    assert.match(f.message, /don’t own that/);
    assert.equal((await ace.post('/armory/workshop/upgrade/nope/carbine')).res.status, 404, 'unknown kinds are a 404');

    // Vehicles upgrade too.
    app.vehicles.grant(ace.id, 'patrol-jeep');
    app.vehicles.assign(ace.id, 'patrol-jeep');
    app.workshop.add(ace.id, { scrap: 1000, circuits: 200 });
    f = await ace.flash('/armory/workshop/upgrade/vehicle/patrol-jeep');
    assert.match(f.message, /Upgraded: Patrol Jeep Mk I/);
    assert.ok(Math.abs(app.vehicles.bonuses(ace.id).missionChance - 0.044) < 1e-9);
    assert.match((await ace.request('/armory/motor-pool')).text, /Patrol Jeep <span class="tag tag--mk">Mk I/);

    // Salvage: the item goes, materials come back (with half the upgrade materials).
    const scrapBefore = qty(ace.id, 'scrap');
    f = await ace.flash('/armory/workshop/salvage/gear/assault-rifle');
    assert.match(f.message, /Assault Rifle Mk III salvaged for \d+ Scrap metal/);
    assert.ok(qty(ace.id, 'scrap') > scrapBefore + 8);
    assert.ok(!app.players.ownedItemIds(ace.id).has('assault-rifle'));
    assert.equal(app.players.equipment(ace.id).weapon, undefined);
    // Bought again, it starts from scratch.
    app.players.addItem(ace.id, 'assault-rifle');
    assert.equal(app.players.upgrades(ace.id).get('assault-rifle'), undefined);
    f = await ace.flash('/armory/workshop/salvage/vehicle/patrol-jeep');
    assert.match(f.message, /Patrol Jeep Mk I salvaged/);
    assert.equal(user(ace.id).vehicle_id, null);

    // Admins give and take materials, audit-logged.
    page = (await boss.request(`/admin/players/${ace.id}`)).text;
    assert.match(page, /Workshop materials: [\d,]+ Scrap metal/);
    f = await boss.flash(`/admin/players/${ace.id}/materials`, { material: 'core', qty: '3', reason: 'Event prize' });
    assert.match(f.message, /Gave 3 Prototype core/);
    const cores = qty(ace.id, 'core');
    f = await boss.flash(`/admin/players/${ace.id}/materials`, { material: 'core', qty: '-100', reason: 'Bug' });
    assert.match(f.message, /Took away 100 Prototype core/);
    assert.equal(qty(ace.id, 'core'), 0, 'never below zero');
    assert.ok(cores >= 3);
    f = await boss.flash(`/admin/players/${ace.id}/materials`, { material: 'core', qty: '0', reason: 'x' });
    assert.match(f.message, /Give an amount/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'materials-grant'").get().details, /Gave 3 Prototype core\. Reason: Event prize/);
    assert.equal((await ace.post(`/admin/players/${ace.id}/materials`, { material: 'core', qty: '5', reason: 'x' })).res.status, 404);
  } finally {
    tuning.reset();
    server.close();
  }
});
