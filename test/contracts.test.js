'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/contracts');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

const HOUR = 3600e3;

test('contract rules: terms, who can post and take them, and shares', () => {
  assert.match(contracts.parseTerms({ kind: 'nope' }).error, /Pick a kind/);
  assert.match(contracts.parseTerms({ kind: 'hit', jobs: 4, amount: 5000, hours: 72 }).error, /1–3 wins/);
  assert.match(contracts.parseTerms({ kind: 'hit', jobs: 1, amount: 999, hours: 24 }).error, /start at \$1,000/);
  assert.match(contracts.parseTerms({ kind: 'hit', jobs: 1, amount: 2_000_000, hours: 24 }).error, /largest/);
  assert.match(contracts.parseTerms({ kind: 'hit', jobs: 1, amount: 5000, hours: 12 }).error, /24, 48, 72 hours/);
  assert.match(contracts.parseTerms({ kind: 'hit', jobs: 2, amount: 5000, hours: 24 }).error, /2 wins need at least 48 hours/);
  assert.deepEqual(contracts.parseTerms({ kind: 'hit', jobs: '2', knockout: 'on', amount: '$5,000', hours: '48' }), { kind: 'hit', jobs: 2, knockout: true, amount: 5000, fee: 500, hours: 48 });
  assert.equal(contracts.parseTerms({ kind: 'guard', jobs: 5, knockout: 'on', amount: 5000, hours: 24 }).knockout, false, 'knockouts are for hits');
  tuning.set({ contractFeeRate: 0.25 });
  try { assert.equal(contracts.parseTerms({ kind: 'guard', jobs: 1, amount: 4000, hours: 24 }).fee, 1000); } finally { tuning.reset(); }

  const terms = contracts.parseTerms({ kind: 'hit', jobs: 1, amount: 5000, hours: 24 });
  const client = { id: 1, level: 8, cash: 10000 };
  const target = { id: 2, username: 'Tara', level: 8 };
  const merc = { id: 3, username: 'Max', level: 8 };
  const none = () => false;
  assert.equal(contracts.postBlocker(client, terms, { target, posted: 0, linked: none }), null);
  assert.match(contracts.postBlocker({ ...client, level: 2 }, terms, { target, posted: 0, linked: none }), /open at level 3/);
  assert.match(contracts.postBlocker(client, terms, { target, posted: 3, linked: none }), /3 contracts/);
  assert.match(contracts.postBlocker({ ...client, cash: 5499 }, terms, { target, posted: 0, linked: none }), /needs \$5,500/);
  assert.match(contracts.postBlocker(client, terms, { target: null, posted: 0, linked: none }), /Name the soldier/);
  assert.match(contracts.postBlocker(client, terms, { target: { ...client, username: 'Me' }, posted: 0, linked: none }), /on yourself/);
  assert.match(contracts.postBlocker(client, terms, { target, posted: 0, linked: () => true }), /same device or network/);
  assert.match(contracts.postBlocker(client, terms, { target, offeredTo: target, posted: 0, linked: none }), /is the target/);
  assert.match(contracts.postBlocker(client, terms, { target, offeredTo: { ...merc, is_bot: 1 }, posted: 0, linked: none }), /reserve soldier/);
  assert.match(contracts.postBlocker(client, terms, { target, offeredTo: merc, posted: 0, linked: (a, b) => a === 3 && b === 2 }), /Max can’t take a contract on Tara/);

  const c = { client_id: 1, target_id: 2 };
  assert.equal(contracts.mercBlocker(merc, c, { jobs: 0, linked: none, client, target }), null);
  assert.match(contracts.mercBlocker({ ...client }, c, { jobs: 0, linked: none, client, target }), /your own contract/);
  assert.match(contracts.mercBlocker({ ...target }, c, { jobs: 0, linked: none, client, target }), /on yourself/);
  assert.match(contracts.mercBlocker(merc, c, { jobs: 2, linked: none, client, target }), /2 contracts at once/);
  assert.match(contracts.mercBlocker(merc, c, { jobs: 0, linked: (a, b) => b === 1, client, target }), /work for this client/);

  assert.deepEqual([1, 2, 3].map((n) => contracts.shareOf({ amount: 1000, jobs: 3 }, n)), [333, 333, 334]);
  assert.equal(contracts.describe({ kind: 'hit', jobs: 2, knockout: 1 }, { target }), 'Beat Tara 2 times by knockout');
  assert.equal(contracts.describe({ kind: 'guard', jobs: 1 }, { client: { username: 'Cal' } }), 'Beat a soldier who attacks Cal');
});

test('contracts through the app: hits, bodyguard duty, refunds and reputation', async () => {
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
        const all = [...page.matchAll(/<p class="flash flash--(\w+)">([^<]*)<\/p>/g)].map((m) => m[2]);
        return { message: all.join(' | '), page };
      },
    };
    return c;
  };
  const enlist = async (name) => {
    const c = client();
    await c.request('/register', { method: 'POST', form: { _csrf: await c.csrf('/login'), username: name, email: `${name}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    db.prepare('UPDATE users SET level = 8, energy = 200, max_energy = 200, health = 400, max_health = 400 WHERE id = ?').run(c.id);
    return c;
  };
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const contract = (id) => db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  const lastId = () => db.prepare('SELECT MAX(id) AS id FROM contracts').get().id;
  const notes = (id) => db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id').all(id).map((n) => n.message).join('\n');

  try {
    const cal = await enlist('Cal'); // the client
    const max = await enlist('Max'); // the mercenary
    const tara = await enlist('Tara'); // the target
    const fox = await enlist('Fox'); // attacks Cal later
    db.prepare('UPDATE users SET cash = 100000 WHERE id = ?').run(cal.id);
    // Max is heavily armed, so his wins don't depend on luck.
    for (const [slot, item] of [['weapon', 'the-last-word'], ['body', 'flak-vest']]) { app.players.addItem(max.id, item); app.players.equip(max.id, slot, item); }

    // The board is in the Players menu; profiles link to it.
    let page = (await cal.request('/contracts')).text;
    assert.match(page, /href="\/contracts" aria-current="page">Contracts/);
    assert.match((await cal.request('/profile/Max')).text, /href="\/contracts\?offer=Max#post">Hire/);

    // Posting a hit: pay plus fee from cash, through the ledger.
    let f = await cal.flash('/contracts', { kind: 'hit', target: 'Tara', jobs: '1', amount: '10000', hours: '24' });
    assert.match(f.message, /Contract posted: Beat Tara, for \$10,000 \(fee \$1,000\)/);
    const hitId = lastId();
    assert.equal(user(cal.id).cash, 100000 - 11000);
    assert.equal(db.prepare("SELECT delta_cash FROM ledger WHERE user_id = ? AND reason = 'contract-posted'").get(cal.id).delta_cash, -11000);
    // Tara never sees the hit on her; Max does.
    assert.doesNotMatch((await tara.request('/contracts')).text, /Beat Tara/);
    page = (await max.request('/contracts')).text;
    assert.match(page, /Beat Tara[\s\S]*Take the job/);
    f = await cal.flash(`/contracts/${hitId}/accept`);
    assert.match(f.message, /your own contract/);

    // Max takes it; Cal and Tara are told.
    f = await max.flash(`/contracts/${hitId}/accept`);
    assert.match(f.message, /Contract taken: Beat Tara/);
    assert.equal(contract(hitId).status, 'active');
    assert.match(notes(cal.id), /Max took your contract/);
    assert.match(notes(tara.id), /hired a mercenary to take you down/);
    f = await fox.flash(`/contracts/${hitId}/accept`);
    assert.match(f.message, /isn’t open any more/);

    // Max beats Tara: paid in full, contract complete, reputation and medal.
    const maxCash = user(max.id).cash;
    f = await max.flash('/attack/Tara');
    assert.match(f.message, /Contract complete: Beat Tara\. \+\$10,000/);
    const c1 = contract(hitId);
    assert.deepEqual([c1.status, c1.paid, c1.progress], ['completed', 10000, 1]);
    assert.ok(user(max.id).cash >= maxCash + 10000);
    assert.equal(user(max.id).contracts_done, 1);
    assert.match(notes(max.id), /Soldier of Fortune/);
    assert.match((await cal.request('/profile/Max')).text, /Mercenary: 1 contract completed/);
    assert.match((await cal.request('/profile/Max/record')).text, /<dt>Contracts completed<\/dt><dd>1<\/dd>/);

    // Bodyguard duty, offered to Max: a share for each soldier who attacked Cal.
    db.prepare('UPDATE users SET hospital_until = NULL, health = max_health WHERE id IN (?, ?, ?, ?)').run(cal.id, max.id, tara.id, fox.id);
    f = await cal.flash('/contracts', { kind: 'guard', jobs: '2', amount: '6000', hours: '48', offer: 'Max' });
    const guardId = lastId();
    assert.match(notes(max.id), /Cal offers you a contract: Beat 2 soldiers who attack Cal within 48 hours, for \$6,000/);
    page = (await max.request('/contracts')).text;
    assert.match(page, /Offers for you[\s\S]*Offered to you/);
    assert.doesNotMatch((await fox.request('/contracts')).text, /soldiers who attack Cal/, 'offers are private');
    await max.flash(`/contracts/${guardId}/accept`);
    // Beating Fox before he has attacked Cal doesn't count…
    let before = user(max.id).cash;
    await max.flash('/attack/Fox');
    assert.equal(contract(guardId).progress, 0);
    // …once Fox has attacked Cal, it does.
    db.prepare('UPDATE users SET hospital_until = NULL, health = max_health WHERE id IN (?, ?)').run(fox.id, cal.id);
    await fox.flash('/attack/Cal');
    db.prepare('UPDATE users SET hospital_until = NULL, health = max_health WHERE id = ?').run(fox.id);
    db.prepare('DELETE FROM battles WHERE attacker_id = ? AND defender_id = ?').run(max.id, fox.id); // as if a day had passed: no pair cooldown, full rewards again
    before = user(max.id).cash;
    f = await max.flash('/attack/Fox');
    assert.match(f.message, /Contract progress: 1 of 2, \+\$3,000/);
    assert.equal(contract(guardId).paid, 3000);
    assert.ok(user(max.id).cash >= before + 3000);
    // Time runs out with one of two done: the rest goes back to Cal, and it counts as done for Max.
    const calCash = user(cal.id).cash;
    app.contracts.expireDue(Date.now() + 49 * HOUR);
    assert.equal(contract(guardId).status, 'completed');
    assert.equal(user(cal.id).cash, calCash + 3000);
    assert.equal(user(max.id).contracts_done, 2);

    // Withdrawing an open contract refunds the pay, not the fee.
    let cash = user(cal.id).cash;
    await cal.flash('/contracts', { kind: 'hit', target: 'Fox', jobs: '1', amount: '2000', hours: '24' });
    f = await cal.flash(`/contracts/${lastId()}/cancel`);
    assert.match(f.message, /Contract withdrawn\. \$2,000 is back/);
    assert.equal(user(cal.id).cash, cash - 200);
    f = await max.flash(`/contracts/${lastId()}/cancel`);
    assert.match(f.message, /isn’t your contract/);

    // Turning down an offer refunds the client.
    cash = user(cal.id).cash;
    await cal.flash('/contracts', { kind: 'guard', jobs: '1', amount: '1000', hours: '24', offer: 'Fox' });
    f = await fox.flash(`/contracts/${lastId()}/decline`);
    assert.match(f.message, /Offer turned down/);
    assert.equal(user(cal.id).cash, cash - 100);
    assert.equal(contract(lastId()).status, 'declined');

    // Abandoning a job: refund, and a failure on Max's record.
    cash = user(cal.id).cash;
    await cal.flash('/contracts', { kind: 'hit', target: 'Fox', jobs: '1', amount: '4000', hours: '24' });
    await max.flash(`/contracts/${lastId()}/accept`);
    f = await max.flash(`/contracts/${lastId()}/abandon`);
    assert.match(f.message, /walked away/);
    assert.equal(user(cal.id).cash, cash - 400);
    assert.equal(user(max.id).contracts_failed, 1);

    // A hit nobody finishes in time fails, and is refunded; one nobody takes expires after a week.
    await cal.flash('/contracts', { kind: 'hit', target: 'Tara', jobs: '1', amount: '3000', hours: '24' });
    const lateId = lastId();
    await max.flash(`/contracts/${lateId}/accept`);
    await cal.flash('/contracts', { kind: 'hit', target: 'Fox', jobs: '1', amount: '1500', hours: '24' });
    const staleId = lastId();
    cash = user(cal.id).cash;
    app.contracts.expireDue(Date.now() + 8 * 24 * HOUR);
    assert.equal(contract(lateId).status, 'failed');
    assert.equal(contract(staleId).status, 'expired');
    assert.equal(user(cal.id).cash, cash + 3000 + 1500);
    assert.equal(user(max.id).contracts_failed, 2);

    // Limits and checks.
    f = await cal.flash('/contracts', { kind: 'hit', target: 'Nobody', jobs: '1', amount: '1000', hours: '24' });
    assert.match(f.message, /No soldier called Nobody/);
    f = await cal.flash('/contracts', { kind: 'hit', target: 'Tara', jobs: '1', amount: '10', hours: '24' });
    assert.match(f.message, /start at \$1,000/);
    assert.equal((await cal.post('/contracts/1/explode')).res.status, 404);

    // The money adds up: every dollar posted was paid out, refunded or burned as fees.
    const sum = (reason) => db.prepare('SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger WHERE reason = ?').get(reason).n;
    const fees = db.prepare('SELECT COALESCE(SUM(fee), 0) AS n FROM contracts').get().n;
    assert.equal(-sum('contract-posted'), sum('contract-pay') + sum('contract-refund') + fees);
  } finally {
    server.close();
  }
});
