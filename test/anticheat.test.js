'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const rules = require('../src/anticheat/rules');

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, db, anti: app.anti, base: `http://127.0.0.1:${server.address().port}` };
}

/** Browser-like client; pass `jar` to share cookies (i.e. the same device). */
function client(base, jar = new Map()) {
  return {
    jar,
    async request(p, { method = 'GET', form } = {}) {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: {
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { res, text: await res.text() };
    },
    async csrf(p = '/login') {
      return (await this.request(p)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
    async post(p, form = {}, from = '/hq') {
      return this.request(p, { method: 'POST', form: { _csrf: await this.csrf(from), ...form } });
    },
  };
}

async function register(c, username) {
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: await c.csrf('/register'), username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302, `register ${username}`);
}

const idOf = (db, name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
const flagsFor = (db, rule) => db.prepare('SELECT * FROM flags WHERE rule = ?').all(rule);

/** Makes the next attack a guaranteed knockout win and clears the pair cooldown. */
function primeKnockout(db, defenderName) {
  db.prepare("UPDATE users SET health = 1, hospital_until = NULL WHERE username = ?").run(defenderName);
  db.prepare('UPDATE battles SET created_at = created_at - 16 * 60 * 1000').run();
}

test('rules: repeat wins pay less, linked devices pay nothing', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(rules.repeatWinFactor), [1, 1, 0.5, 0.5, 0, 0]);
  assert.deepEqual(rules.pvpRewardPlan({ linkedDevice: false, priorWinsToday: 0 }), { attacker: 1, defender: 1, note: null });
  assert.match(rules.pvpRewardPlan({ linkedDevice: false, priorWinsToday: 2 }).note, /Half rewards: win #3/);
  const linked = rules.pvpRewardPlan({ linkedDevice: true, priorWinsToday: 0 });
  assert.equal(linked.attacker + linked.defender, 0);
});

test('rules: farming verdicts', () => {
  const base = { attacks: 8, attackerWins: 8, reverseAttacks: 0, linkedDevice: false, linkedNetwork: false };
  assert.equal(rules.farmingVerdict(base).severity, 2);
  assert.equal(rules.farmingVerdict({ ...base, reverseAttacks: 1 }), null); // a real rivalry
  assert.equal(rules.farmingVerdict({ ...base, attackerWins: 4 }), null);
  assert.equal(rules.farmingVerdict({ ...base, attacks: 6, attackerWins: 6, linkedNetwork: true }).severity, 3);
  assert.equal(rules.farmingVerdict({ ...base, attacks: 3, attackerWins: 0, linkedDevice: true }).severity, 3);
  assert.equal(rules.farmingVerdict({ ...base, attacks: 2 }), null);
});

test('every money change is in the ledger and the audit catches tampering', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Banker');
  const id = idOf(db, 'Banker');
  await c.post('/bank/deposit', { amount: '50' }, '/bank');
  await c.post('/missions/perimeter-patrol', {}, '/missions');
  const reasons = db.prepare('SELECT reason FROM ledger WHERE user_id = ? ORDER BY id').all(id).map((r) => r.reason);
  assert.deepEqual(reasons.slice(0, 2), ['signup', 'bank-deposit']);
  assert.equal(anti.runScan().newFlags, 0); // everything adds up

  db.prepare('UPDATE users SET cash = cash + 5000 WHERE id = ?').run(id); // a direct database edit
  anti.runScan();
  const [flag] = flagsFor(db, 'ledger-mismatch');
  assert.equal(flag.severity, 3);
  assert.match(flag.summary, /Banker's balances don't match/);

  db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) VALUES (?, 5000, 'mission', ?)").run(id, Date.now());
  anti.runScan();
  assert.match(flagsFor(db, 'impossible-payout')[0].summary, /larger than the game allows/);
});

test('a save that moves money without a reason is flagged', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  await register(client(base), 'Glitch');
  const { createPlayerRepo } = require('../src/players');
  const repo = createPlayerRepo(db);
  const p = repo.findById(idOf(db, 'Glitch'));
  repo.save({ ...p, cash: p.cash + 999 }); // no reason given, like a buggy new feature
  anti.runScan();
  assert.match(flagsFor(db, 'unknown-money')[0].summary, /outside normal game actions \(net \$999\)/);
  assert.equal(flagsFor(db, 'ledger-mismatch').length, 0);
});

test('accounts on the same device are linked, flagged, and earn nothing from fighting each other', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const laptop = new Map(); // one browser, two accounts
  const main = client(base, laptop);
  await register(main, 'MainGuy');
  await main.post('/logout');
  const alt = client(base, laptop);
  await register(alt, 'AltGuy');
  await alt.post('/logout');

  const [flag] = flagsFor(db, 'linked-device');
  assert.equal(flag.severity, 2);
  assert.match(flag.summary, /AltGuy and MainGuy|MainGuy and AltGuy/);

  db.prepare('UPDATE users SET level = 5, max_health = 140, health = 140, cash = 1000').run();
  primeKnockout(db, 'AltGuy');
  const pc = client(base); // signing in elsewhere doesn't un-link them
  await pc.request('/login', { method: 'POST', form: { _csrf: await pc.csrf(), login: 'MainGuy', password: 'password123' } });
  const { res } = await pc.post('/attack/AltGuy');
  const { text } = await pc.request(res.headers.get('location'));
  assert.match(text, /No rewards: these accounts have been used on the same device/);
  assert.equal(db.prepare("SELECT cash FROM users WHERE username = 'MainGuy'").get().cash, 1000);
  assert.equal(db.prepare("SELECT cash FROM users WHERE username = 'AltGuy'").get().cash, 1000);
});

test('IPs are stored only as hashes; shared networks raise a low flag and make farming high severity', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  await register(client(base), 'Sib1');
  await register(client(base), 'Sib2');
  const [a, b] = [idOf(db, 'Sib1'), idOf(db, 'Sib2')];
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sign_ins WHERE ip_hash IS NOT NULL').get().n, 0); // loopback isn't linked
  anti.recordSignIn(a, { ip: '203.0.113.7', deviceId: 'dev-aaaaaaaaaaaaaaaa' });
  anti.recordSignIn(b, { ip: '203.0.113.7', deviceId: 'dev-bbbbbbbbbbbbbbbb' });
  const hash = db.prepare('SELECT ip_hash FROM sign_ins WHERE ip_hash IS NOT NULL').get().ip_hash;
  assert.ok(!hash.includes('203'));
  assert.equal(flagsFor(db, 'linked-network')[0].severity, 1);

  const ins = db.prepare('INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, cash_taken, report, created_at) VALUES (?, ?, 1, 1, 50, ?, ?)');
  for (let i = 0; i < 6; i += 1) ins.run(a, b, '{}', Date.now() - i * 60000);
  anti.afterBattle(a, b);
  const [farm] = flagsFor(db, 'pvp-farming');
  assert.equal(farm.severity, 3);
  assert.match(farm.summary, /Sib1 attacked Sib2 6 times in 48 hours \(6 wins, \$300 taken\)/);
});

test('repeat wins against the same player pay half, then nothing', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const bully = client(base);
  await register(bully, 'Bully');
  await register(client(base), 'Victim');
  db.prepare('UPDATE users SET level = 5, max_health = 140, health = 140, max_energy = 100, energy = 100, cash = 2000').run();
  const taken = [];
  const fullPrize = [];
  for (let i = 0; i < 5; i += 1) {
    primeKnockout(db, 'Victim');
    const before = db.prepare("SELECT cash FROM users WHERE username = 'Victim'").get().cash;
    fullPrize.push(Math.floor(before * 0.05)); // the normal 5% prize
    const { res } = await bully.post('/attack/Victim');
    assert.match(res.headers.get('location'), /^\/battles\//);
    taken.push(before - db.prepare("SELECT cash FROM users WHERE username = 'Victim'").get().cash);
  }
  assert.deepEqual(taken, [
    fullPrize[0],
    fullPrize[1],
    Math.floor(fullPrize[2] / 2),
    Math.floor(fullPrize[3] / 2),
    0,
  ]);
});

test('admin review queue: list, warn, dismiss (sticks), reverse, suspend; hidden from players', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  const boss = client(base);
  await register(boss, 'Boss');
  await register(client(base), 'Farmer');
  await register(client(base), 'Feeder');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
  const [farmer, feeder] = [idOf(db, 'Farmer'), idOf(db, 'Feeder')];

  // Eight one-sided wins worth $400 that the farmer was paid for.
  const ins = db.prepare('INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, cash_taken, report, created_at) VALUES (?, ?, 1, 1, 50, ?, ?)');
  for (let i = 0; i < 8; i += 1) ins.run(farmer, feeder, '{}', Date.now() - i * 60000);
  db.prepare('UPDATE users SET cash = cash + 400 WHERE id = ?').run(farmer);
  db.prepare('UPDATE users SET cash = cash + 400 WHERE id = ?').run(feeder); // so the feeder had it to lose
  db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) VALUES (?, 400, 'pvp', ?), (?, 400, 'opening-balance', ?)").run(farmer, Date.now(), feeder, Date.now());
  anti.runScan();
  const flag = flagsFor(db, 'pvp-farming')[0];
  assert.equal(flag.severity, 2);

  const outsider = client(base);
  await register(outsider, 'Nosy');
  assert.equal((await outsider.request('/admin/flags')).res.status, 404);
  assert.equal((await outsider.post(`/admin/flags/${flag.id}/dismiss`)).res.status, 404);

  let { text } = await boss.request('/admin');
  assert.match(text, /Open flags<\/dt><dd><a href="\/admin\/flags">1/);
  ({ text } = await boss.request('/admin/flags'));
  assert.match(text, /Farmer attacked Feeder 8 times/);
  ({ text } = await boss.request(`/admin/flags/${flag.id}`));
  assert.match(text, /8 attacks, 8 wins, \$400 taken, 0 counter-attacks/);

  await boss.post(`/admin/flags/${flag.id}/reverse`, {}, `/admin/flags/${flag.id}`);
  assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(farmer).cash, 100);
  assert.equal(db.prepare('SELECT cash FROM users WHERE id = ?').get(feeder).cash, 900);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM battles WHERE reversed_at IS NOT NULL').get().n, 8);
  assert.equal(db.prepare("SELECT status FROM flags WHERE id = ?").get(flag.id).status, 'actioned');
  assert.equal(anti.runScan().newFlags, 0); // reversed via the ledger, so balances still add up

  // A low flag gets dismissed and isn't raised again straight away.
  anti.recordSignIn(farmer, { ip: '198.51.100.9', deviceId: 'dev-cccccccccccccccc' });
  anti.recordSignIn(feeder, { ip: '198.51.100.9', deviceId: 'dev-dddddddddddddddd' });
  const net = flagsFor(db, 'linked-network')[0];
  await boss.post(`/admin/flags/${net.id}/dismiss`, { note: 'Same school wifi' }, `/admin/flags/${net.id}`);
  anti.runScan();
  assert.equal(flagsFor(db, 'linked-network').length, 1);

  // Warn and suspend from a new flag.
  db.prepare('UPDATE users SET cash = cash + 1 WHERE id = ?').run(farmer);
  anti.runScan();
  const mismatch = flagsFor(db, 'ledger-mismatch')[0];
  await boss.post(`/admin/flags/${mismatch.id}/warn`, { userId: String(farmer) }, `/admin/flags/${mismatch.id}`);
  assert.match(db.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC").get(farmer).message, /^Warning from HQ/);
  db.prepare("UPDATE flags SET status = 'open' WHERE id = ?").run(mismatch.id);
  await boss.post(`/admin/flags/${mismatch.id}/suspend`, { userId: String(feeder), reason: 'x' }, `/admin/flags/${mismatch.id}`);
  assert.equal(db.prepare('SELECT banned_at FROM users WHERE id = ?').get(feeder).banned_at, null); // not part of this flag
  await boss.post(`/admin/flags/${mismatch.id}/suspend`, { userId: String(farmer), reason: 'Exploiting' }, `/admin/flags/${mismatch.id}`);
  assert.ok(db.prepare('SELECT banned_at FROM users WHERE id = ?').get(farmer).banned_at);

  ({ text } = await boss.request(`/admin/players/${farmer}`));
  assert.match(text, /Money history/);
  assert.match(text, /reversal · battle:/);
  assert.match(text, /same network/);
  ({ text } = await boss.request('/admin'));
  assert.match(text, /flag-dismissed/);
});

test('old sign-in records are deleted after 90 days', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  await register(client(base), 'Oldtimer');
  db.prepare('INSERT INTO sign_ins (user_id, created_at) VALUES (?, ?)').run(idOf(db, 'Oldtimer'), Date.now() - 91 * rules.DAY);
  assert.equal(anti.runScan().purgedSignIns, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sign_ins').get().n, 1);
});
