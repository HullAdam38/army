'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const market = require('../src/market');
const tuning = require('../src/tuning');
const { ITEMS_BY_ID } = require('../src/items');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('market rules: price ranges, fees and who can trade', () => {
  const rifle = ITEMS_BY_ID.get('assault-rifle'); // $1,800, level 6
  assert.deepEqual(market.priceRange('gear', rifle), { min: 720, max: 2700 });
  assert.equal(market.priceRange('gear', rifle, { condition: 0 }).min, 360, 'worn gear can go cheaper');
  assert.equal(market.priceRange('gear', rifle, { upgrade: 2 }).max, 4050, 'upgraded gear can go higher');
  const scrap = market.thingOf('material', 'scrap');
  assert.deepEqual(market.priceRange('material', scrap, { qty: 10 }), { min: 125, max: 750 });
  assert.equal(market.thingOf('gear', 'nope'), null);
  assert.equal(market.listingFee(100), 10, 'at least $10');
  assert.equal(market.listingFee(10000), 200);
  assert.equal(market.proceeds(10000), 9500);
  tuning.set({ marketTaxRate: 0.1 });
  try { assert.equal(market.proceeds(10000), 9000); } finally { tuning.reset(); }
  assert.equal(market.parsePrice('$2,500'), 2500);
  assert.equal(market.nameOf({ kind: 'gear', ref_id: 'assault-rifle', upgrade: 2, condition: 62.5 }), 'Assault Rifle Mk II (62%)');
  assert.equal(market.nameOf({ kind: 'material', ref_id: 'core', qty: 3 }), '3 Prototype core');

  const range = market.priceRange('gear', rifle);
  const seller = { id: 1, level: 6, cash: 1000 };
  assert.equal(market.listBlocker(seller, { price: 1000, active: 0, range }), null);
  assert.match(market.listBlocker({ ...seller, level: 4 }, { price: 1000, active: 0, range }), /opens at level 5/);
  assert.match(market.listBlocker(seller, { price: 1000, active: 10, range }), /10 things/);
  assert.match(market.listBlocker(seller, { price: 100, active: 0, range }), /lowest price .* \$720/);
  assert.match(market.listBlocker(seller, { price: 9999, active: 0, range }), /highest price .* \$2,700/);
  assert.match(market.listBlocker({ ...seller, cash: 5 }, { price: 1000, active: 0, range }), /costs a \$20 fee/);

  const listing = { seller_id: 1, kind: 'gear', ref_id: 'assault-rifle', price: 1500 };
  const buyer = { id: 2, level: 6, cash: 5000 };
  assert.equal(market.buyBlocker(buyer, listing, { linked: false, owns: false }), null);
  assert.match(market.buyBlocker({ ...buyer, id: 1 }, listing, { linked: false, owns: false }), /your own listing/);
  assert.match(market.buyBlocker({ ...buyer, level: 5 }, listing, { linked: false, owns: false }), /Needs level 6/);
  assert.match(market.buyBlocker(buyer, listing, { linked: false, owns: true }), /already own/);
  assert.match(market.buyBlocker(buyer, listing, { linked: true, owns: false }), /same device or network/);
  assert.match(market.buyBlocker({ ...buyer, cash: 10 }, listing, { linked: false, owns: false }), /Costs \$1,500/);
});

test('the market through the app: list, buy, withdraw, expire', async () => {
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
        return { message: [...page.matchAll(/<p class="flash flash--(\w+)">([^<]*)<\/p>/g)].map((m) => m[2]).join(' | '), page };
      },
    };
    return c;
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    db.prepare('UPDATE users SET level = 8, cash = 20000 WHERE id = ?').run(c.id);
    return c;
  };
  const cash = (id) => db.prepare('SELECT cash FROM users WHERE id = ?').get(id).cash;
  const lastId = () => db.prepare('SELECT MAX(id) AS id FROM market_listings').get().id;

  try {
    const sam = await enlist('Sam'); // the seller
    const bo = await enlist('Bob'); // the buyer
    app.players.addItem(sam.id, 'assault-rifle');
    app.players.equip(sam.id, 'weapon', 'assault-rifle');
    app.players.setCondition(sam.id, 'assault-rifle', 80);
    app.players.setUpgrade(sam.id, 'assault-rifle', 1);
    app.workshop.add(sam.id, { scrap: 50 });
    app.vehicles.grant(sam.id, 'trail-bike');
    app.vehicles.assign(sam.id, 'trail-bike');

    // The market is in the Armory menu; the sell form lists what Sam owns, with price ranges.
    let page = (await sam.request('/armory/market')).text;
    assert.match(page, /href="\/armory\/market" aria-current="page">Market/);
    assert.match(page, /<option value="gear:assault-rifle">Assault Rifle Mk I \(80%\) · equipped · \$648–\$3,375<\/option>/);
    assert.match(page, /<option value="material:scrap">Scrap metal \(you have 50\)/);

    // Listing: price checked, fee paid, the rifle comes off Sam and out of his inventory.
    let f = await sam.flash('/armory/market', { thing: 'gear:assault-rifle', price: '100' });
    assert.match(f.message, /lowest price for that is \$648/);
    app.medals.check(sam.id); // (any medals for what Sam owns, out of the way first)
    const listedFrom = cash(sam.id);
    f = await sam.flash('/armory/market', { thing: 'gear:assault-rifle', price: '3,000' });
    assert.match(f.message, /Listed: Assault Rifle Mk I \(80%\) for \$3,000 \(fee \$60\)/);
    const rifleId = lastId();
    assert.equal(cash(sam.id), listedFrom - 60);
    assert.ok(!app.players.ownedItemIds(sam.id).has('assault-rifle'));
    assert.equal(app.players.equipment(sam.id).weapon, undefined);
    f = await sam.flash('/armory/market', { thing: 'gear:assault-rifle', price: '3000' });
    assert.match(f.message, /don’t own that/);
    // Materials and the vehicle too.
    f = await sam.flash('/armory/market', { thing: 'material:scrap', qty: '60', price: '1000' });
    assert.match(f.message, /don’t have 60 Scrap metal/);
    f = await sam.flash('/armory/market', { thing: 'material:scrap', qty: '20', price: '1000' });
    assert.match(f.message, /Listed: 20 Scrap metal for \$1,000/);
    const scrapId = lastId();
    assert.equal(app.workshop.materials(sam.id).get('scrap'), 30);
    await sam.flash('/armory/market', { thing: 'vehicle:trail-bike', price: '900' });
    const bikeId = lastId();
    assert.equal(db.prepare('SELECT vehicle_id FROM users WHERE id = ?').get(sam.id).vehicle_id, null);

    // Bo sees them; Sam's own listing has no Buy button for Sam.
    page = (await bo.request('/armory/market')).text;
    assert.match(page, /Assault Rifle Mk I \(80%\)[\s\S]*\$3,000[\s\S]*action="\/armory\/market\/\d+\/buy"/);
    assert.match((await sam.request('/armory/market')).text, /Your listing/);
    assert.match((await bo.request('/armory/market?kind=material')).text, /20 Scrap metal/);
    assert.doesNotMatch((await bo.request('/armory/market?kind=material')).text, /Assault Rifle/);

    // Buying: Bo pays the price, Sam gets it less 5% tax, the rifle arrives worn and upgraded.
    f = await sam.flash(`/armory/market/${rifleId}/buy`);
    assert.match(f.message, /your own listing/);
    const samBefore = cash(sam.id);
    f = await bo.flash(`/armory/market/${rifleId}/buy`);
    assert.match(f.message, /Bought: Assault Rifle Mk I \(80%\) for \$3,000/);
    assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'market-buy'").get(bo.id).delta_cash, -3000);
    assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'market-sale'").get(sam.id).delta_cash, 2850);
    assert.ok(cash(sam.id) >= samBefore + 2850);
    assert.equal(app.players.conditions(bo.id).get('assault-rifle'), 80);
    assert.equal(app.players.upgrades(bo.id).get('assault-rifle'), 1);
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(sam.id).message, /Sold on the market: Assault Rifle Mk I \(80%\) to Bob for \$3,000\. You get \$2,850/);
    f = await bo.flash(`/armory/market/${rifleId}/buy`);
    assert.match(f.message, /no longer for sale/);
    await bo.flash(`/armory/market/${scrapId}/buy`);
    assert.equal(app.workshop.materials(bo.id).get('scrap'), 20);

    // Withdrawing gives the bike back (the fee isn't refunded).
    f = await sam.flash(`/armory/market/${bikeId}/cancel`);
    assert.match(f.message, /Trail Bike withdrawn and back with you/);
    assert.ok(app.vehicles.owned(sam.id).has('trail-bike'));
    f = await bo.flash(`/armory/market/${bikeId}/cancel`);
    assert.match(f.message, /isn’t one of your listings/);

    // Expiry: back to the seller, or sold to the Armory if they've bought another meanwhile.
    await sam.flash('/armory/market', { thing: 'vehicle:trail-bike', price: '900' });
    const again = lastId();
    app.vehicles.grant(sam.id, 'trail-bike'); // a new one from the motor pool
    const before = cash(sam.id);
    app.market.expireDue(Date.now() + 4 * 24 * 3600e3);
    assert.equal(db.prepare('SELECT status FROM market_listings WHERE id = ?').get(again).status, 'expired');
    assert.ok(cash(sam.id) > before, 'the Armory bought the spare');
    assert.match(db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(sam.id).message, /Armory bought it/);

    // Levels: under 5 can't trade; a buyer needs the item's level.
    db.prepare('UPDATE users SET level = 4 WHERE id = ?').run(bo.id);
    assert.match((await bo.request('/armory/market')).text, /The market opens at level 5/);
    // The money adds up: fees and tax are destroyed, nothing else is made or lost.
    const sum = (r) => db.prepare('SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger WHERE reason = ?').get(r).n;
    const tax = db.prepare("SELECT COALESCE(SUM(price), 0) AS n FROM market_listings WHERE status = 'sold'").get().n * 0.05;
    assert.equal(-sum('market-buy') - sum('market-sale'), Math.round(tax));
    assert.equal((await bo.post('/armory/market/1/steal')).res.status, 404);
  } finally {
    server.close();
  }
});
