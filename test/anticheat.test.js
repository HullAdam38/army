'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const rules = require('../src/anticheat/rules');

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
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

// ---- Bot detection & unusual gains ----

const { MISSIONS, ENERGY_REGEN_MS } = require('../src/game');
const MIN = 60 * 1000;

/** A believable human session: clicks 3–40s apart, in a few sittings with sleep in between. */
function humanTimes(now, seed = 1) {
  let x = seed;
  const rand = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const out = [];
  for (const sittingStart of [20, 14, 9, 3]) { // hours ago
    let t = now - sittingStart * rules.HOUR;
    for (let i = 0; i < 25; i += 1) out.push((t += 3000 + rand() * 37000));
  }
  return out;
}

test('rules: bot verdicts', () => {
  const now = Date.now();
  const metronome = Array.from({ length: 60 }, (_, i) => now - i * 6000);
  const v = rules.botVerdict(metronome);
  assert.equal(v.severity, 3);
  assert.match(v.reasons[0], /near-identical intervals \(every ~6s/);

  assert.equal(rules.botVerdict(humanTimes(now)), null);

  // A script with a little jitter, running all day.
  const allDay = [];
  for (let h = 0; h < 22; h += 1) for (let i = 0; i < 4; i += 1) allDay.push(now - h * rules.HOUR - i * (60000 + (i % 2) * 3000));
  const day = rules.botVerdict(allDay);
  assert.ok(day.reasons.some((r) => /active in 2[23] of the last 24 hours/.test(r)), day.reasons.join(' | ')); // 22 or 23 clock hours, depending on the time

  const burst = Array.from({ length: 40 }, (_, i) => now - i * 250 - (i % 3) * 40);
  assert.ok(rules.botVerdict(burst).reasons.some((r) => /less than 400ms apart/.test(r)), JSON.stringify(rules.botVerdict(burst)));

  assert.equal(rules.botVerdict([now, now - 5000, now - 10000]), null); // too little to judge
});

test('rules: gains ceiling and peer outliers', () => {
  const cap = rules.missionCashCap({ missions: MISSIONS, level: 1, maxEnergy: 50, refills: 0, energyRegenMs: ENERGY_REGEN_MS });
  // 720 energy regenerated + 50 starting, at Convoy Escort's best $75 per 8 energy, plus 10%.
  assert.equal(cap, Math.ceil((720 + 50) * (75 / 8) * 1.1));
  assert.ok(rules.missionCashCap({ missions: MISSIONS, level: 1, maxEnergy: 50, refills: 2, energyRegenMs: ENERGY_REGEN_MS }) > cap);

  assert.equal(rules.median([5, 1, 3]), 3);
  assert.equal(rules.median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(rules.gainsOutlier(2000, [100, 120, 90, 110, 100], 'xp'), { median: 100, multiple: 20 });
  assert.equal(rules.gainsOutlier(2000, [100, 120, 90, 110], 'xp'), null); // not enough peers
  assert.equal(rules.gainsOutlier(390, [90, 95, 100, 80, 85], 'xp'), null); // 4×, but too small to matter
  assert.equal(rules.gainsOutlier(700, [300, 250, 280, 310, 260], 'xp'), null); // keen, not suspicious
});

test('real actions are recorded with their gains; sign-in and admin requests are not', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Grinder');
  await c.post('/missions/perimeter-patrol', {}, '/missions');
  await c.post('/bank/deposit', { amount: '10' }, '/bank');
  await c.post('/missions/nonexistent', {}, '/missions'); // a failed attempt still counts as an action
  await c.post('/logout');
  const rows = db.prepare('SELECT kind, xp, cash FROM actions ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.kind), ['mission', 'bank', 'mission']);
  assert.ok(rows[0].xp > 0);
  const missionLedger = db.prepare("SELECT COALESCE(SUM(delta_cash), 0) AS c FROM ledger WHERE reason = 'mission'").get().c;
  assert.equal(rows[0].cash, missionLedger); // matches what the ledger recorded
  assert.equal(rows[1].xp + rows[1].cash, 0);
});

test('scripted play is flagged as bot-like and shown to admins with the evidence', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  const boss = client(base);
  await register(boss, 'Boss');
  await register(client(base), 'Clockwork');
  await register(client(base), 'Normal_Nora');
  db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Boss'").run();
  const now = Date.now();
  for (let i = 0; i < 80; i += 1) anti.recordAction(idOf(db, 'Clockwork'), 'mission', { xp: 10 }, now - i * 8000);
  for (const at of humanTimes(now, 7)) anti.recordAction(idOf(db, 'Normal_Nora'), 'mission', { xp: 10 }, at);

  anti.runScan(now);
  const flags = flagsFor(db, 'bot-like');
  assert.equal(flags.length, 1);
  assert.match(flags[0].summary, /^Clockwork: actions at near-identical intervals \(every ~8s, only 0% variation\)/);
  assert.equal(flags[0].severity, 3);

  let { text } = await boss.request(`/admin/flags/${flags[0].id}`);
  assert.match(text, /Why this was flagged/);
  assert.match(text, /Gap variation<\/dt><dd>0%/);
  ({ text } = await boss.request(`/admin/players/${idOf(db, 'Clockwork')}`));
  assert.match(text, /80 actions in 1 of 24 hours/);
  assert.match(text, /class="hour-strip"/);
});

test('earning more than energy allows is flagged high; big outliers vs peers are flagged medium', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  const names = ['Exploiter', 'Whale', 'Peer1', 'Peer2', 'Peer3', 'Peer4', 'Peer5', 'Peer6'];
  for (const n of names) await register(client(base), n);
  const now = Date.now();
  // Level 1 can earn ~$7,900/day from missions at most.
  anti.recordAction(idOf(db, 'Exploiter'), 'mission', { xp: 50, cash: 20000 }, now - 5 * MIN);
  // Whale: within the energy ceiling but far above five ordinary level-1 peers.
  anti.recordAction(idOf(db, 'Whale'), 'mission', { xp: 2400, cash: 6000 }, now - 5 * MIN);
  for (const n of ['Peer1', 'Peer2', 'Peer3', 'Peer4', 'Peer5', 'Peer6']) anti.recordAction(idOf(db, n), 'mission', { xp: 120, cash: 300 }, now - 5 * MIN);

  anti.runScan(now);
  const gains = flagsFor(db, 'unusual-gains');
  const byName = Object.fromEntries(gains.map((f) => [JSON.parse(f.evidence).player, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['Exploiter', 'Whale']);
  assert.equal(byName.Exploiter.severity, 3);
  assert.match(byName.Exploiter.summary, /earned \$20,000 from missions in 24 hours; the most their energy allows is about \$7,941/);
  assert.equal(byName.Whale.severity, 2);
  assert.match(byName.Whale.summary, /2400 XP in 24 hours, 20× the typical 120/);
  assert.match(byName.Whale.summary, /\$6,000 earned in 24 hours, 20× the typical \$300/);
});

test('promotions raise the energy ceiling, banned players are skipped, old actions are purged', async (t) => {
  const { server, db, anti, base } = await startServer();
  t.after(() => server.close());
  await register(client(base), 'Climber');
  await register(client(base), 'Gone');
  const now = Date.now();
  const climber = idOf(db, 'Climber');
  anti.recordAction(climber, 'mission', { cash: 8500 }, now - MIN); // above one day's ceiling ($7,941)…
  const ins = db.prepare("INSERT INTO activity (user_id, kind, message, created_at) VALUES (?, 'promotion', 'x', ?)");
  ins.run(climber, now - rules.HOUR); // …but two promotions refilled their energy
  ins.run(climber, now - 2 * rules.HOUR); // ceiling with two refills: ~$8,972
  anti.recordAction(idOf(db, 'Gone'), 'mission', { cash: 50000 }, now - MIN);
  db.prepare("UPDATE users SET banned_at = ? WHERE username = 'Gone'").run(now);
  anti.recordAction(climber, 'mission', {}, now - 15 * rules.DAY);

  anti.runScan(now);
  assert.equal(flagsFor(db, 'unusual-gains').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM actions WHERE created_at < ?').get(now - 14 * rules.DAY).n, 0);
});
