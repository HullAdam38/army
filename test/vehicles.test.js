'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vehicles = require('../src/vehicles');
const raids = require('../src/raids');
const game = require('../src/game');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('vehicle rules: classes, bonuses, wear and purchases', () => {
  const v = (id) => vehicles.VEHICLES_BY_ID.get(id);
  // Every class has a full ladder, cheapest first, and every vehicle has a bonus.
  for (const c of vehicles.CLASSES) {
    const list = vehicles.VEHICLES.filter((x) => x.cls === c.id);
    assert.equal(list.length, 5, c.id);
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(list[i].minLevel > list[i - 1].minLevel && list[i].price > list[i - 1].price, `${c.id} ladder`);
    }
    for (const x of list) assert.ok(vehicles.describe(vehicles.bonusesOf(x)).length, x.id);
  }

  assert.deepEqual(vehicles.bonusesOf(null), vehicles.NO_BONUS);
  assert.equal(vehicles.bonusesOf(v('trail-bike')).missionChance, 0.03);
  assert.equal(vehicles.bonusesOf(v('trail-bike'), 50).missionChance, 0.03, 'full power down to 50%');
  assert.equal(vehicles.bonusesOf(v('trail-bike'), 0).missionChance, 0.015, 'half power at 0%');
  assert.deepEqual(vehicles.describe(vehicles.bonusesOf(v('utility-pickup'))), ['+4% mission pay', '+10% deployment pay']);
  assert.deepEqual(vehicles.describe(vehicles.bonusesOf(v('light-tank'))), ['+6% raid damage']);
  assert.equal(vehicles.bestMissionCash(4), 0);
  assert.equal(vehicles.bestMissionCash(15), 0.06);

  // Admin settings scale the bonuses and the wear.
  tuning.set({ vehicleBonusMult: 2, vehicleWearMult: 3 });
  try {
    assert.equal(vehicles.bonusesOf(v('trail-bike')).missionChance, 0.06);
    assert.equal(vehicles.worn(100, vehicles.WEAR.mission), 99.55);
  } finally { tuning.reset(); }
  assert.equal(vehicles.worn(0.2, 1), 0, 'never below 0');

  assert.match(vehicles.checkPurchase('nope', { level: 1, cash: 0 }, new Map()).error, /isn’t in the motor pool/);
  assert.match(vehicles.checkPurchase('patrol-jeep', { level: 9, cash: 1e9 }, new Map()).error, /requires level 10/);
  assert.match(vehicles.checkPurchase('trail-bike', { level: 3, cash: 100 }, new Map()).error, /costs \$1,200/);
  assert.match(vehicles.checkPurchase('trail-bike', { level: 3, cash: 5000 }, new Map([['trail-bike', 100]])).error, /already own/);
  assert.equal(vehicles.checkPurchase('trail-bike', { level: 3, cash: 5000 }, new Map()).vehicle.id, 'trail-bike');

  // Light vehicles raise the success chance; armour raises raid damage.
  const mission = game.MISSIONS[0];
  const p = { level: 1, health: 100, max_health: 100 };
  assert.ok(Math.abs(game.successChance(mission, p, undefined, 0.03) - Math.min(0.97, game.successChance(mission, p) + 0.03)) < 1e-9);
  const stats = game.statsFor(10);
  const fixed = () => 0.5;
  const plain = raids.strike(stats, { max_health: 100 }, fixed).damage;
  assert.equal(raids.strike(stats, { max_health: 100 }, fixed, 0.1).damage, Math.round(plain * 1.1));
});

test('the motor pool: buying, taking out, wear, repairs, selling and admin grants', async () => {
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
        return { message: m ? m[2] : '', page, location: r.location };
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
  const condition = (id, v) => (db.prepare('SELECT condition FROM vehicles WHERE user_id = ? AND vehicle_id = ?').get(id, v) || {}).condition;
  const lastLedger = (id) => db.prepare('SELECT reason, ref, delta_cash FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);

  try {
    const boss = await enlist('Boss');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boss.id);
    const ace = await enlist('Ace');
    db.prepare('UPDATE users SET level = 6, cash = 20000 WHERE id = ?').run(ace.id);

    // The motor pool is in the Armory menu and lists every class.
    let page = (await ace.request('/armory/motor-pool')).text;
    assert.match(page, /href="\/armory\/motor-pool" aria-current="page">Motor pool/);
    assert.match(page, /Light vehicles[\s\S]*Transports[\s\S]*Armour/);
    assert.match(page, /You don’t own a vehicle yet/);
    assert.match((await ace.request('/armory')).text, /href="\/armory\/motor-pool"/);

    // Buying: level and cash checked, paid through the ledger, taken out at once.
    let f = await ace.flash('/armory/motor-pool/buy/patrol-jeep');
    assert.match(f.message, /requires level 10/);
    f = await ace.flash('/armory/motor-pool/buy/trail-bike');
    assert.match(f.message, /Trail Bike bought and taken out/);
    assert.equal(user(ace.id).cash, 20000 - 1200);
    assert.deepEqual({ ...lastLedger(ace.id) }, { reason: 'vehicle', ref: 'trail-bike', delta_cash: -1200 });
    assert.equal(user(ace.id).vehicle_id, 'trail-bike');
    f = await ace.flash('/armory/motor-pool/buy/trail-bike');
    assert.match(f.message, /already own/);
    // A second vehicle waits in the motor pool.
    f = await ace.flash('/armory/motor-pool/buy/utility-pickup');
    assert.match(f.message, /Utility Pickup bought\. Take it out/);
    assert.equal(user(ace.id).vehicle_id, 'trail-bike');

    // Missions: the bike shows, raises the chance and wears.
    page = (await ace.request('/missions')).text;
    assert.match(page, /Vehicle: <a href="\/armory\/motor-pool">Trail Bike<\/a> \(100%\): <strong>\+3% mission success/);
    assert.ok(Math.abs(app.vehicles.bonuses(ace.id).missionChance - 0.03) < 1e-9);
    await ace.post(`/missions/${game.MISSIONS[0].id}`);
    assert.ok([99.85, 99.7].includes(condition(ace.id, 'trail-bike')), 'wears 0.15 points on success, 0.3 on failure');
    assert.equal(condition(ace.id, 'utility-pickup'), 100, 'only the vehicle taken out wears');

    // Take the pickup out: more mission pay, more deployment pay.
    f = await ace.flash('/armory/motor-pool/assign/utility-pickup');
    assert.match(f.message, /taking the Utility Pickup out/);
    assert.equal(app.vehicles.bonuses(ace.id).missionCash, 0.04);
    const mult = app.deployments.multipliers(6, Date.now(), ace.id);
    const plainMult = app.deployments.multipliers(6, Date.now());
    assert.ok(Math.abs(mult.cashMult - plainMult.cashMult * 1.1) < 1e-9);
    assert.match((await ace.request('/deployments')).text, /Your vehicle adds <strong>\+10%<\/strong> pay/);
    // Coming home from a deployment wears it 0.2 points an hour.
    app.deployments.start(ace.id, 'recon', Date.now() - 5 * 3600e3);
    app.deployments.completeDue(Date.now(), ace.id);
    assert.equal(condition(ace.id, 'utility-pickup'), 99.2);
    assert.match((await boss.request('/profile/Ace')).text, /Vehicle: <strong>Utility Pickup<\/strong>/);

    // Worn vehicles lose bonus below 50%, and the player is told once.
    db.prepare("UPDATE vehicles SET condition = 50.2 WHERE user_id = ? AND vehicle_id = 'utility-pickup'").run(ace.id);
    app.players.transaction(() => app.vehicles.wear(ace.id, 'missionFailed'));
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(ace.id).message, /Utility Pickup is getting worn \(49%\)/);
    db.prepare("UPDATE vehicles SET condition = 0 WHERE user_id = ? AND vehicle_id = 'utility-pickup'").run(ace.id);
    assert.equal(app.vehicles.bonuses(ace.id).missionCash, 0.02);

    // Repairs cost a share of the price (30% from 0%), sales pay less when worn.
    const cash = user(ace.id).cash;
    f = await ace.flash('/armory/motor-pool/repair/utility-pickup');
    assert.match(f.message, /Utility Pickup repaired to 100% for \$750/);
    assert.equal(user(ace.id).cash, cash - 750);
    assert.equal(lastLedger(ace.id).reason, 'vehicle-repair');
    f = await ace.flash('/armory/motor-pool/repair/utility-pickup');
    assert.match(f.message, /already in perfect condition/);
    f = await ace.flash('/armory/motor-pool/sell/utility-pickup');
    assert.match(f.message, /Utility Pickup sold for \$1,000/); // 40% of $2,500 at 100%
    assert.equal(lastLedger(ace.id).reason, 'vehicle-sale');
    assert.equal(user(ace.id).vehicle_id, null, 'selling the vehicle taken out leaves nothing out');
    assert.deepEqual(app.vehicles.bonuses(ace.id), vehicles.NO_BONUS);
    f = await ace.flash('/armory/motor-pool/sell/utility-pickup');
    assert.match(f.message, /don’t own/);

    // Parking.
    await ace.flash('/armory/motor-pool/assign/trail-bike');
    f = await ace.flash('/armory/motor-pool/park');
    assert.match(f.message, /Trail Bike left in the motor pool/);
    f = await ace.flash('/armory/motor-pool/park');
    assert.match(f.message, /haven’t taken a vehicle out/);
    f = await ace.flash('/armory/motor-pool/assign/light-tank');
    assert.match(f.message, /don’t own that vehicle/);

    // Admins give and take vehicles from the Gear card, with a reason and an audit entry.
    page = (await boss.request(`/admin/players/${ace.id}`)).text;
    assert.match(page, /Gear and vehicles/);
    assert.match(page, /<option value="veh:light-tank">Light Tank \(Lv 12\)/);
    assert.equal((await ace.post(`/admin/players/${ace.id}/items`, { item: 'veh:light-tank', reason: 'x', action: 'grant' })).res.status, 404);
    f = await boss.flash(`/admin/players/${ace.id}/items`, { item: 'veh:light-tank', reason: '', action: 'grant' });
    assert.match(f.message, /Give a reason/);
    f = await boss.flash(`/admin/players/${ace.id}/items`, { item: 'veh:light-tank', reason: 'Tournament prize', action: 'grant' });
    assert.match(f.message, /Light Tank given to Ace/);
    assert.match(db.prepare("SELECT details FROM admin_actions WHERE action = 'vehicle-grant'").get().details, /Light Tank\. Reason: Tournament prize/);
    assert.equal(condition(ace.id, 'light-tank'), 100);
    await ace.flash('/armory/motor-pool/assign/light-tank');
    assert.equal(app.vehicles.bonuses(ace.id).raidDamage, 0.06);
    f = await boss.flash(`/admin/players/${ace.id}/items`, { item: 'veh:light-tank', reason: 'Given by mistake', action: 'remove' });
    assert.match(f.message, /Light Tank removed/);
    assert.equal(user(ace.id).vehicle_id, null);
    // Gear still goes through the same form.
    f = await boss.flash(`/admin/players/${ace.id}/items`, { item: 'carbine', reason: 'Lost to a bug', action: 'grant' });
    assert.match(f.message, /M4 Carbine given to Ace/);

    // Admins can turn the bonuses off.
    await ace.flash('/armory/motor-pool/assign/trail-bike');
    tuning.set({ vehicleBonusMult: 0 });
    assert.deepEqual(app.vehicles.bonuses(ace.id), vehicles.NO_BONUS);
  } finally {
    tuning.reset();
    server.close();
  }
});
