'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gear = require('../src/gear');
const tuning = require('../src/tuning');
const { ITEMS_BY_ID } = require('../src/items');
const { statsOf } = require('../src/armory');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('gear rules: power, repair cost and sale value by condition', () => {
  assert.equal(gear.effectiveness(100), 1);
  assert.equal(gear.effectiveness(50), 1, 'full power down to 50%');
  assert.equal(gear.effectiveness(25), 0.75);
  assert.equal(gear.effectiveness(0), 0.5, 'never worse than half power');

  const rifle = ITEMS_BY_ID.get('assault-rifle'); // $1,800
  assert.equal(gear.repairCost(rifle, 100), 0);
  assert.equal(gear.repairCost(rifle, 50), 270, '30% of the price for a full repair, pro rata');
  assert.equal(gear.repairCost(rifle, 0), 540);
  assert.equal(gear.saleValue(rifle, 100), 720, '40% of the price in perfect condition');
  assert.equal(gear.saleValue(rifle, 0), 360, 'half that when worn out');
  assert.ok(gear.saleValue(rifle, 100) < rifle.price, 'buying and selling never makes money');

  const worn = gear.scaledMods(rifle, 0);
  assert.equal(worn.find((m) => m.stat === 'attack').value, rifle.mods.find((m) => m.stat === 'attack').value / 2);
  assert.equal(gear.scaledMods(rifle, 80), rifle.mods, 'untouched above 50%');
  assert.equal(gear.conditionLabel(95), 'Good');
  assert.equal(gear.conditionLabel(10), 'Badly worn');
});

function setup() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const id = Number(db.prepare(`INSERT INTO users (username, email, password_hash, level, cash, energy_updated_at, health_updated_at, created_at)
    VALUES ('Grunt', 'g@x.com', 'x', 12, 10000, 0, 0, 0)`).run().lastInsertRowid);
  db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 10000, 0, 'test', 0)").run(id);
  for (const item of ['assault-rifle', 'flak-vest', 'carbine']) app.players.addItem(id, item);
  app.players.equip(id, 'weapon', 'assault-rifle');
  app.players.equip(id, 'body', 'flak-vest');
  const cond = (item) => app.players.conditions(id).get(item);
  return { db, app, id, cond };
}

test('fighting wears equipped gear, worn gear loses power, and players are told', () => {
  const { app, id, cond } = setup();
  const t = (fn) => app.players.transaction(fn);
  t(() => gear.wear(app.players, id, 'mission'));
  assert.equal(cond('assault-rifle'), 99.5);
  assert.equal(cond('flak-vest'), 100, 'a successful mission doesn’t touch armour');
  assert.equal(cond('carbine'), 100, 'gear in the inventory never wears');
  t(() => gear.wear(app.players, id, 'missionFailed'));
  assert.equal(cond('flak-vest'), 99);
  t(() => gear.wear(app.players, id, 'attack'));
  assert.equal(cond('assault-rifle'), 98);

  // Power drops below 50%.
  const fresh = statsOf(app.players, app.players.findById(id)).attack;
  app.players.setCondition(id, 'assault-rifle', 50.5);
  t(() => gear.wear(app.players, id, 'attack'));
  const note = app.players.notifications(id, 1)[0];
  assert.match(note.message, /Assault Rifle is getting worn \(49%\)/);
  app.players.setCondition(id, 'assault-rifle', 0);
  assert.ok(statsOf(app.players, app.players.findById(id)).attack < fresh, 'a worn-out rifle hits softer');

  // The admin setting scales it, and 0 turns it off.
  assert.equal(cond('flak-vest'), 97, 'two attacks and a failed mission so far');
  tuning.set({ gearWearMult: 2 });
  t(() => gear.wear(app.players, id, 'defend'));
  assert.equal(cond('flak-vest'), 95);
  tuning.set({ gearWearMult: 0 });
  t(() => gear.wear(app.players, id, 'defend'));
  assert.equal(cond('flak-vest'), 95);
  tuning.reset();
});

test('missions wear your weapon through the app; repairs and sales through the Armory', async () => {
  const { db, app, id, cond } = setup();
  db.prepare("UPDATE users SET username = 'Grunt', password_hash = ? WHERE id = ?").run(require('bcryptjs').hashSync('password123', 4), id);
  app.players.acceptTerms(id, require('../src/legal').TERMS_VERSION);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (p, { method = 'GET', form } = {}) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
    for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { res, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async (from = '/armory') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } });
  const cash = () => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
  try {
    await request('/login', { method: 'POST', form: { _csrf: await csrf('/login'), login: 'Grunt', password: 'password123' } });
    await post('/missions/perimeter-patrol');
    assert.ok(cond('assault-rifle') < 100, 'a mission wears the weapon');

    // The inventory shows condition, a repair price and a sale price.
    app.players.setCondition(id, 'assault-rifle', 40);
    app.players.setCondition(id, 'carbine', 80);
    let page = (await request('/armory')).text;
    assert.match(page, /Worn · 40% · 90% power/);
    assert.match(page, /Repair \$324/);
    assert.match(page, /Repair everything · \$\d/);
    assert.match(page, /Sell \$504/, "worn gear sells for less");
    assert.match(page, /Worn: 40% condition/, 'the loadout flags worn gear');

    // Repair one item.
    let before = cash();
    let r = await post('/armory/repair/assault-rifle');
    assert.equal(r.location, '/armory#inv-weapon');
    assert.equal(cond('assault-rifle'), 100);
    assert.equal(cash(), before - 324);
    assert.match(db.prepare("SELECT reason FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(id).reason, /armory-repair/);
    assert.match((await post('/armory/repair/assault-rifle')).location, /inv-weapon/);
    assert.match((await request('/armory')).text, /already in perfect condition/);

    // Repair everything, and not without the cash.
    app.players.setCondition(id, 'flak-vest', 0);
    db.prepare('UPDATE users SET cash = 10 WHERE id = ?').run(id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'test', 0)").run(id, 10 - before + 324);
    await post('/armory/repair/all');
    assert.match((await request('/armory')).text, /That repair costs \$\d+/);
    db.prepare('UPDATE users SET cash = 10000 WHERE id = ?').run(id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 9990, 0, 'test', 0)").run(id);
    await post('/armory/repair/all');
    assert.match((await request('/armory')).text, /2 items repaired to 100%/);
    assert.deepEqual([cond('flak-vest'), cond('carbine')], [100, 100]);

    // Sell the equipped rifle: the slot empties, the cash arrives.
    before = cash();
    r = await post('/armory/sell/assault-rifle');
    assert.equal(r.location, '/armory#inv-weapon');
    assert.equal(cash(), before + 720);
    assert.equal(app.players.conditions(id).has('assault-rifle'), false);
    assert.equal(app.players.equipment(id).weapon, undefined);
    assert.match((await request('/armory')).text, /Assault Rifle sold for \$720/);
    await post('/armory/sell/assault-rifle');
    assert.match((await request('/armory')).text, /don’t own that/);

    // It can be bought again, good as new.
    await post('/armory/buy/assault-rifle');
    assert.equal(cond('assault-rifle'), 100);
    assert.equal(app.anti.runScan().newFlags, 0, 'every dollar went through the ledger');
  } finally {
    server.close();
  }
});

test('reserve soldiers’ gear doesn’t wear', () => {
  const { db, app, id, cond } = setup();
  db.prepare('UPDATE users SET is_bot = 1 WHERE id = ?').run(id);
  app.players.transaction(() => gear.wear(app.players, id, 'attack'));
  assert.equal(cond('assault-rifle'), 100);
});
