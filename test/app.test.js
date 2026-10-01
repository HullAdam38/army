'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  server.db = db; // lets tests set up state directly
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Tiny cookie-aware client. */
function client(base) {
  let cookie = '';
  return {
    async request(path, { method = 'GET', form, headers = {} } = {}) {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { res, text: await res.text() };
    },
    async csrf(path) {
      const { text } = await this.request(path);
      return text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
  };
}

test('full game loop: register, play, logout, login', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  let { res } = await c.request('/hq');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');

  let token = await c.csrf('/register');
  ({ res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username: 'Nightjar', email: 'nj@example.com', password: 'hunter2hunter2', confirm: 'hunter2hunter2', adult: 'on', terms: 'on' },
  }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/hq');

  let text;
  ({ res, text } = await c.request('/hq'));
  assert.equal(res.status, 200);
  assert.match(text, /Nightjar/);
  assert.match(text, /Recruit/);

  token = await c.csrf('/missions');
  ({ res, text } = await c.request('/missions/perimeter-patrol', {
    method: 'POST', form: { _csrf: token }, headers: { accept: 'application/json' },
  }));
  const data = JSON.parse(text);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.player.energy, 45);

  ({ res } = await c.request('/missions/perimeter-patrol', { method: 'POST', form: { _csrf: 'wrong' } }));
  assert.equal(res.status, 403);

  ({ res } = await c.request('/logout', { method: 'POST', form: { _csrf: token } }));
  assert.equal(res.status, 302);
  ({ res } = await c.request('/hq'));
  assert.equal(res.status, 302);

  token = await c.csrf('/login');
  ({ res } = await c.request('/login', { method: 'POST', form: { _csrf: token, login: 'nightjar', password: 'bad-password' } }));
  assert.equal(res.status, 401);

  token = await c.csrf('/login');
  ({ res } = await c.request('/login', { method: 'POST', form: { _csrf: token, login: 'NJ@example.com', password: 'hunter2hunter2' } }));
  assert.equal(res.status, 302);
  ({ res, text } = await c.request('/hq'));
  assert.equal(res.status, 200);
  assert.match(text, /Perimeter Patrol/);
});

test('registration validates input and the 18+ confirmation', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  const token = await c.csrf('/register');
  const { res, text } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username: 'x', email: 'nope', password: 'short', confirm: 'other' },
  });
  assert.equal(res.status, 422);
  assert.match(text, /18 or older/);
  assert.match(text, /valid email/);
  assert.match(text, /do not match/);
});

test('public pages render and unknown routes 404', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  const { res, text } = await c.request('/');
  assert.equal(res.status, 200);
  assert.match(text, /Earn your/);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal((await c.request('/nowhere')).res.status, 404);
});

async function register(c, username) {
  const token = await c.csrf('/register');
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
}

test('online page lists active players and profiles show public info only', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const alpha = client(base);
  const bravo = client(base);
  await register(alpha, 'Alpha');
  await register(bravo, 'Bravo');

  let { res, text } = await alpha.request('/online');
  assert.equal(res.status, 200);
  assert.match(text, /href="\/profile\/Alpha"/);
  assert.match(text, /href="\/profile\/Bravo"/);
  assert.match(text, /2 soldiers/);

  ({ res, text } = await alpha.request('/profile/bravo'));
  assert.equal(res.status, 200);
  assert.match(text, /Bravo/);
  assert.match(text, /Online now/);
  assert.doesNotMatch(text, /bravo@example\.com/);
  assert.doesNotMatch(text, /how other soldiers see you/);

  ({ text } = await alpha.request('/profile/Alpha'));
  assert.match(text, /how other soldiers see you/);

  assert.equal((await alpha.request('/profile/nobody')).res.status, 404);

  // Signing out drops you from the roll call and shows "last seen" instead.
  const token = await bravo.csrf('/hq');
  await bravo.request('/logout', { method: 'POST', form: { _csrf: token } });
  ({ text } = await alpha.request('/online'));
  assert.doesNotMatch(text, /href="\/profile\/Bravo"/);
  assert.match(text, />1 soldier</);
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.match(text, /Last seen/);
});

test('online and profile pages require sign-in', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  assert.equal((await c.request('/online')).res.status, 302);
  assert.equal((await c.request('/profile/anyone')).res.status, 302);
});

test('armory: buy, auto-equip, stow, re-equip; loadout shows on profile', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await register(c, 'Quartermaster'); // starts with $100

  let { res, text } = await c.request('/armory');
  assert.equal(res.status, 200);
  assert.match(text, /Combat rating/);

  let token = await c.csrf('/armory');
  ({ res } = await c.request('/armory/buy/flak-vest', { method: 'POST', form: { _csrf: token } }));
  assert.equal(res.status, 302);
  ({ text } = await c.request('/armory'));
  assert.match(text, /costs \$120/); // not enough cash yet

  // Earn cash the honest way isn't deterministic, so top up directly.
  server.db.prepare("UPDATE users SET cash = 1000 WHERE username = 'Quartermaster'").run();
  ({ res } = await c.request('/armory/buy/flak-vest', { method: 'POST', form: { _csrf: token } }));
  assert.equal(res.headers.get('location'), '/armory#slot-body');
  ({ text } = await c.request('/armory'));
  assert.match(text, /Flak Vest purchased and equipped/);
  assert.match(text, /data-stat="cash">880</);

  ({ text } = await c.request('/profile/Quartermaster'));
  assert.match(text, /loadout__name">Flak Vest/);

  await c.request('/armory/unequip/body', { method: 'POST', form: { _csrf: token } });
  ({ text } = await c.request('/profile/Quartermaster'));
  assert.doesNotMatch(text, /loadout__name">Flak Vest/);

  await c.request('/armory/equip/flak-vest', { method: 'POST', form: { _csrf: token } });
  ({ text } = await c.request('/profile/Quartermaster'));
  assert.match(text, /loadout__name">Flak Vest/);

  // Can't buy twice, can't equip what you don't own.
  await c.request('/armory/buy/flak-vest', { method: 'POST', form: { _csrf: token } });
  ({ text } = await c.request('/armory'));
  assert.match(text, /already own/);
  await c.request('/armory/equip/service-pistol', { method: 'POST', form: { _csrf: token } });
  ({ text } = await c.request('/armory'));
  assert.match(text, /don’t own/);
});

test('pvp: attack, battle report, hospital, discharge and cooldown', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const alpha = client(base);
  const bravo = client(base);
  await register(alpha, 'Alpha');
  await register(bravo, 'Bravo');

  // Recruits are protected.
  let { text } = await alpha.request('/profile/Bravo');
  assert.match(text, /PvP unlocks at level 3/);

  server.db.prepare("UPDATE users SET level = 5, max_health = 140, health = 140, cash = 1000").run();
  server.db.prepare("UPDATE users SET health = 1 WHERE username = 'Bravo'").run(); // guarantees a knockout
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.match(text, /Costs 10 energy/);

  const token = await alpha.csrf('/hq');
  let { res } = await alpha.request('/attack/Bravo', { method: 'POST', form: { _csrf: token } });
  assert.equal(res.status, 302);
  const reportUrl = res.headers.get('location');
  assert.match(reportUrl, /^\/battles\/\d+$/);

  ({ res, text } = await alpha.request(reportUrl));
  assert.equal(res.status, 200);
  assert.match(text, /Victory/);
  assert.match(text, /Knockout in round 1/);
  ({ text } = await bravo.request(reportUrl));
  assert.match(text, /Defeat/);

  // Bravo is now in hospital: listed on the ward, can't be attacked, can't run missions.
  ({ text } = await alpha.request('/hospital'));
  assert.match(text, /Knocked out by Alpha/);
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.match(text, /Bravo is in hospital/);
  ({ text } = await bravo.request('/hq'));
  assert.match(text, /You're in hospital/);
  assert.match(text, /Alpha attacked you and won/);
  const bt = await bravo.csrf('/hq');
  ({ text } = await bravo.request('/missions/perimeter-patrol', { method: 'POST', form: { _csrf: bt }, headers: { accept: 'application/json' } }));
  assert.match(JSON.parse(text).error, /hospital/);

  // Bravo pays to leave early; Alpha is still on cooldown for this target.
  await bravo.request('/hospital/discharge', { method: 'POST', form: { _csrf: bt } });
  ({ text } = await bravo.request('/hospital'));
  assert.match(text, /Discharged for \$/);
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.match(text, /attacked Bravo recently/);

  // Both profiles list the battle and record the result.
  assert.match(text, /href="\/battles\/\d+"/);
  assert.match(text, /PvP losses<\/dt><dd>1/);

  assert.equal((await alpha.request('/battles/99999')).res.status, 404);
  assert.equal((await alpha.request('/attack/Nobody', { method: 'POST', form: { _csrf: token } })).res.status, 404);
});

test('players directory: search, filters, sorting, paging and attacking from the list', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const me = client(base);
  await register(me, 'Hunter');
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Rookie', 'Patient', 'Low_One']) {
    await register(client(base), name);
  }
  const set = (sql, ...args) => server.db.prepare(sql).run(...args);
  set('UPDATE users SET level = 8, max_health = 170, health = 170, max_energy = 85, energy = 85');
  set("UPDATE users SET level = 1 WHERE username = 'Rookie'");
  set("UPDATE users SET level = 4 WHERE username = 'Low_One'"); // more than 3 below Hunter
  set("UPDATE users SET pvp_wins = 9 WHERE username = 'Charlie'");
  set("UPDATE users SET hospital_until = ?, hospital_reason = 'x' WHERE username = 'Patient'", Date.now() + 600_000);

  let { res, text } = await me.request('/players');
  assert.equal(res.status, 200);
  assert.match(text, /7 soldiers/);
  assert.match(text, /aria-label="Attack Alpha"/);
  assert.match(text, /Rookie is a Recruit/);
  assert.match(text, /Patient is in hospital/);
  assert.match(text, /Low_One is too far below your level/);

  ({ text } = await me.request('/players?filter=targets'));
  assert.match(text, /3 soldiers you can target/);
  for (const hidden of ['Rookie', 'Patient', 'Low_One', '>Hunter<']) assert.ok(!text.includes(hidden), hidden);

  ({ text } = await me.request('/players?q=char'));
  assert.match(text, /1 soldier matching “char”/);
  ({ text } = await me.request('/players?q=_'));
  assert.match(text, /1 soldier matching/); // _ is matched literally, not as a wildcard
  ({ text } = await me.request('/players?q=%25'));
  assert.match(text, /0 soldiers/);

  ({ text } = await me.request('/players?sort=wins'));
  assert.ok(text.indexOf('>Charlie<') < text.indexOf('>Alpha<'), 'most PvP wins first');
  ({ res } = await me.request('/players?sort=bogus;DROP&page=-4&filter=nope'));
  assert.equal(res.status, 200);

  // Paging: 25 per page.
  // (Inserted directly: registering this many accounts would trip the sign-up rate limiter.)
  const now = Date.now();
  const insert = server.db.prepare(`INSERT INTO users (username, email, password_hash, energy_updated_at, health_updated_at, created_at)
                                    VALUES (?, ?, 'x', ?, ?, ?)`);
  for (let i = 0; i < 25; i += 1) insert.run(`Grunt${i}`, `grunt${i}@example.com`, now, now, now);
  ({ text } = await me.request('/players'));
  assert.match(text, /Page 1 of 2/);
  ({ text } = await me.request('/players?page=2'));
  assert.match(text, /Page 2 of 2/);

  // Attack from the list: success goes to the report, a failure returns to the list.
  const token = await me.csrf('/players');
  ({ res } = await me.request('/attack/Alpha', { method: 'POST', form: { _csrf: token, back: '/players?filter=targets' } }));
  assert.match(res.headers.get('location'), /^\/battles\/\d+$/);
  ({ res } = await me.request('/attack/Alpha', { method: 'POST', form: { _csrf: token, back: '/players?filter=targets' } }));
  assert.equal(res.headers.get('location'), '/players?filter=targets'); // cooldown
  ({ res } = await me.request('/attack/Alpha', { method: 'POST', form: { _csrf: token, back: '//evil.example' } }));
  assert.equal(res.headers.get('location'), '/profile/Alpha');
  // Fights are random; if Alpha was knocked out the hospital message would show first.
  set("UPDATE users SET hospital_until = NULL WHERE username = 'Alpha'");
  ({ text } = await me.request('/players?q=alpha'));
  assert.match(text, /attacked Alpha recently/);
});

test('notifications: welcome, attack alerts, polling, read state, unlocks and the combat feed', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const alpha = client(base);
  const bravo = client(base);
  await register(alpha, 'Alpha');
  await register(bravo, 'Bravo');

  let { text } = await bravo.request('/notifications');
  assert.match(text, /Welcome to EliteForces/);
  ({ text } = await bravo.request('/hq'));
  assert.doesNotMatch(text, /data-bell-count >/); // read after visiting the page
  const latestId = Number(text.match(/data-latest-id="(\d+)"/)[1]);

  // Alpha attacks Bravo; Bravo is told even though they weren't looking.
  const set = (sql, ...args) => server.db.prepare(sql).run(...args);
  set('UPDATE users SET level = 5, max_health = 140, health = 140, cash = 1000');
  set("UPDATE users SET health = 1 WHERE username = 'Bravo'");
  const token = await alpha.csrf('/hq');
  await alpha.request('/attack/Bravo', { method: 'POST', form: { _csrf: token } });

  let res;
  ({ res, text } = await bravo.request(`/notifications/poll?after=${latestId}`, { headers: { accept: 'application/json' } }));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const poll = JSON.parse(text);
  assert.equal(poll.unread, 1);
  assert.equal(poll.items.length, 1);
  assert.equal(poll.items[0].kind, 'attacked-lost');
  assert.match(poll.items[0].message, /Alpha attacked you and won\. You lost \$50\. You were knocked out/);
  assert.match(poll.items[0].link, /^\/battles\/\d+$/);
  assert.equal(poll.player.hospitalized, true);
  // Nothing new after the latest id; the attacker gets no notification for their own attack.
  assert.equal(JSON.parse((await bravo.request(`/notifications/poll?after=${poll.latestId}`, { headers: { accept: 'application/json' } })).text).items.length, 0);
  assert.equal(JSON.parse((await alpha.request('/notifications/poll?after=0', { headers: { accept: 'application/json' } })).text).items.length, 1); // just the welcome

  ({ text } = await bravo.request('/hq'));
  assert.match(text, /aria-label="Notifications, 1 unread"/);
  ({ text } = await bravo.request('/notifications'));
  assert.match(text, /note--unread/);
  ({ text } = await bravo.request('/notifications'));
  assert.doesNotMatch(text, /note--unread/);

  // Combat feed on HQ shows the fight to everyone.
  ({ text } = await alpha.request('/hq'));
  assert.match(text, /<strong>Alpha<\/strong> knocked out <strong>Bravo<\/strong> and took \$50/);

  // Levelling to 3 via a mission announces the promotion and the PvP unlock.
  const charlie = client(base);
  await register(charlie, 'Charlie');
  set("UPDATE users SET level = 2, xp = 302 WHERE username = 'Charlie'"); // 1 XP short of level 3
  const ct = await charlie.csrf('/missions');
  await charlie.request('/missions/perimeter-patrol', { method: 'POST', form: { _csrf: ct } });
  ({ text } = await charlie.request('/notifications'));
  assert.match(text, /Promoted to level 3: Private/);
  assert.match(text, /PvP unlocked/);
  assert.match(text, /New mission unlocked: Forward Recon/);
  assert.match(text, /New gear in the Armory: M4 Carbine/);

  assert.equal((await client(base).request('/notifications/poll', { headers: { accept: 'application/json' } })).res.status, 401);
});

test('bank: deposit, withdraw, history, privacy, and PvP only takes cash on hand', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const alpha = client(base);
  const bravo = client(base);
  await register(alpha, 'Alpha');
  await register(bravo, 'Bravo');
  const set = (sql, ...args) => server.db.prepare(sql).run(...args);
  const bravoRow = () => server.db.prepare("SELECT cash, bank_balance FROM users WHERE username = 'Bravo'").get();

  set("UPDATE users SET cash = 1000 WHERE username = 'Bravo'");
  const token = await bravo.csrf('/bank');
  let { res } = await bravo.request('/bank/deposit', { method: 'POST', form: { _csrf: token, amount: '1,000' } });
  assert.equal(res.headers.get('location'), '/bank');
  assert.deepEqual({ ...bravoRow() }, { cash: 0, bank_balance: 980 });

  let text;
  ({ text } = await bravo.request('/bank'));
  assert.match(text, /980 banked after the \$20 fee/);
  assert.match(text, /\(fee \$20\)/);

  await bravo.request('/bank/withdraw', { method: 'POST', form: { _csrf: token, amount: '200' } });
  assert.deepEqual({ ...bravoRow() }, { cash: 200, bank_balance: 780 });
  await bravo.request('/bank/withdraw', { method: 'POST', form: { _csrf: token, amount: '99999' } });
  ({ text } = await bravo.request('/bank'));
  assert.match(text, /Your balance is \$780/);

  // Balance is private: not on the public profile.
  ({ text } = await alpha.request('/profile/Bravo'));
  assert.doesNotMatch(text, /780/);

  // A knockout only takes 5% of the $200 on hand; the $780 in the bank is untouched.
  set('UPDATE users SET level = 5, max_health = 140, health = 140');
  set("UPDATE users SET health = 1 WHERE username = 'Bravo'");
  const at = await alpha.csrf('/hq');
  await alpha.request('/attack/Bravo', { method: 'POST', form: { _csrf: at } });
  assert.deepEqual({ ...bravoRow() }, { cash: 190, bank_balance: 780 });
});
