'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../src/units');
const game = require('../src/game');
const pvp = require('../src/pvp');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test('unit names, tags and permissions', () => {
  assert.deepEqual(units.validateUnit({ name: '  Iron   Wolves ', tag: 'iw', description: '' }), { name: 'Iron Wolves', tag: 'IW', description: '' });
  assert.match(units.validateUnit({ name: 'ab', tag: 'IW' }).error, /3–24/);
  assert.match(units.validateUnit({ name: '<script>', tag: 'IW' }).error, /letters, numbers/);
  assert.match(units.validateUnit({ name: 'Iron Wolves', tag: 'TOOLONG' }).error, /Tags/);
  assert.match(units.validateUnit({ name: 'Iron Wolves', tag: 'I W' }).error, /Tags/);

  const now = Date.now();
  const p = { level: 5, cash: 3000, unit_id: null, unit_left_at: null };
  assert.equal(units.foundBlocker(p, now), null);
  assert.match(units.foundBlocker({ ...p, level: 4 }, now), /level 5/);
  assert.match(units.foundBlocker({ ...p, cash: 100 }, now), /\$2,500/);
  assert.match(units.foundBlocker({ ...p, unit_left_at: now - 3600_000 }, now), /11 hours/);

  const unit = { id: 1, name: 'Iron Wolves', recruiting: 1, barracks: 0 };
  const ok = { members: 3, pending: 0, alreadyApplied: false };
  assert.equal(units.applyBlocker(p, unit, ok, now), null);
  assert.match(units.applyBlocker(p, { ...unit, recruiting: 0 }, ok, now), /isn’t taking applications/);
  assert.match(units.applyBlocker(p, unit, { ...ok, members: 10 }, now), /full/);
  assert.equal(units.applyBlocker(p, { ...unit, barracks: 1 }, { ...ok, members: 10 }, now), null);
  assert.match(units.applyBlocker(p, unit, { ...ok, pending: 3 }, now), /3 applications/);
  assert.match(units.applyBlocker({ ...p, unit_id: 2 }, unit, ok, now), /already in a unit/);

  assert.equal(units.can.kick('leader', 'officer'), true);
  assert.equal(units.can.kick('officer', 'member'), true);
  assert.equal(units.can.kick('officer', 'officer'), false);
  assert.equal(units.can.kick('member', 'member'), false);
  assert.equal(units.can.manage('officer'), false);

  assert.deepEqual(units.nextUpgrade({ drill: 0 }, 'drill'), { key: 'drill', level: 1, cost: 3000 });
  assert.equal(units.nextUpgrade({ barracks: 3 }, 'barracks'), null);
  assert.deepEqual(units.parseDonation('1,500', 2000), { amount: 1500 });
  assert.deepEqual(units.parseDonation('all', 900), { amount: 900 });
  assert.match(units.parseDonation('5', 900).error, /at least/);
  assert.match(units.parseDonation('1000', 900).error, /don’t have/);
});

test('drill ground boosts mission XP; unit members can’t attack each other', () => {
  const now = Date.now();
  const p = { id: 1, username: 'A', level: 5, xp: 0, cash: 0, energy: 50, max_energy: 50, health: 100, max_health: 100, energy_updated_at: now, health_updated_at: now, missions_completed: 0, missions_failed: 0, stat_str: 0, stat_agi: 0, stat_end: 0, hospital_until: null };
  const rng = () => 0; // success, minimum rolls
  const plain = game.runMission('perimeter-patrol', { ...p }, { now, rng }).result.xp;
  const boosted = game.runMission('perimeter-patrol', { ...p }, { now, rng, xpBonus: units.xpBonus({ drill: 5 }) }).result.xp;
  assert.equal(boosted, Math.round(plain * 1.1));

  const a = { id: 1, username: 'A', level: 5, unit_id: 7 };
  const d = { id: 2, username: 'D', level: 5, unit_id: 7 };
  assert.match(pvp.targetBlocker(a, d, { now }), /in your unit/);
  assert.equal(pvp.targetBlocker(a, { ...d, unit_id: 8 }, { now }), null);
  assert.equal(pvp.targetBlocker({ ...a, unit_id: null }, { ...d, unit_id: null }, { now }), null);
});

async function startServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

function client(base) {
  const jar = new Map();
  return {
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
    async csrf(from = '/hq') {
      return (await this.request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
    async post(p, form = {}) {
      const r = await this.request(p, { method: 'POST', form: { _csrf: await this.csrf(), ...form } });
      return { ...r, location: r.res.headers.get('location') };
    },
    /** The flash message shown on the page a POST redirected to. */
    async flash(p, form) {
      const r = await this.post(p, form);
      const page = (await this.request(r.location)).text;
      const m = page.match(/<p class="flash flash--(\w+)">([^<]*)<\/p>/);
      return m ? { type: m[1], message: m[2], location: r.location } : { type: null, message: '', location: r.location };
    },
  };
}

async function enlist(base, username) {
  const c = client(base);
  const { res } = await c.request('/register', {
    method: 'POST',
    form: { _csrf: await c.csrf('/register'), username, email: `${username}@example.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' },
  });
  assert.equal(res.status, 302);
  return c;
}

test('units end to end: found, apply, accept, donate, upgrade, board, roles, leave, disband', async () => {
  const { app, server, db, base } = await startServer();
  try {
    const lead = await enlist(base, 'Wolfe');
    const recruit = await enlist(base, 'Rookie');
    const third = await enlist(base, 'Drifter');
    const id = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    const user = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    const ledger = (name, reason) => db.prepare('SELECT COALESCE(SUM(delta_cash), 0) AS n FROM ledger WHERE user_id = ? AND reason = ?').get(id(name), reason).n;

    // Founding needs level 5 and $2,500.
    let f = await lead.flash('/units', { name: 'Iron Wolves', tag: 'iw', description: 'We hunt in packs.' });
    assert.match(f.message, /level 5/);
    db.prepare("UPDATE users SET level = 5, cash = 10000 WHERE username IN ('Wolfe', 'Drifter')").run();
    db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) SELECT id, 10000 - 100, 'test', 0 FROM users WHERE username IN ('Wolfe', 'Drifter')").run();
    f = await lead.flash('/units', { name: 'Iron Wolves', tag: 'iw', description: 'We hunt in packs.' });
    assert.match(f.message, /Iron Wolves is formed/);
    const unitId = Number(f.location.split('/').pop());
    assert.equal(user('Wolfe').unit_role, 'leader');
    assert.equal(user('Wolfe').cash, 7500);
    assert.equal(ledger('Wolfe', 'unit-founded'), -2500);
    assert.match((await third.flash('/units', { name: 'iron wolves', tag: 'XX' })).message, /already a unit called/);
    assert.match((await third.flash('/units', { name: 'Steel Rain', tag: 'IW' })).message, /tag \[IW\] is taken/);

    // Apply and accept.
    f = await recruit.flash(`/units/${unitId}/apply`, { message: 'Ready to <b>serve</b>' });
    assert.match(f.message, /Application sent/);
    assert.match((await recruit.flash(`/units/${unitId}/apply`)).message, /already with their officers/);
    const leaderPage = (await lead.request(`/units/${unitId}`)).text;
    assert.match(leaderPage, /Ready to &lt;b&gt;serve&lt;\/b&gt;/); // escaped
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'unit'").get(id('Wolfe')).n, 1);
    const appId = db.prepare('SELECT id FROM unit_applications WHERE user_id = ?').get(id('Rookie')).id;
    assert.match((await recruit.flash(`/units/${unitId}/applications/${appId}/accept`)).message, /Only officers/);
    assert.match((await lead.flash(`/units/${unitId}/applications/${appId}/accept`)).message, /Rookie has joined/);
    assert.equal(user('Rookie').unit_id, unitId);
    assert.equal((await lead.post(`/units/${unitId}/applications/${appId}/approve`)).res.status, 404);

    // Friendly fire: Rookie is no longer a target for Wolfe.
    db.prepare("UPDATE users SET level = 5 WHERE username = 'Rookie'").run();
    assert.match((await lead.request('/profile/Rookie')).text, /Rookie is in your unit/);
    assert.match((await lead.request('/profile/Rookie')).text, /\[IW\]<\/span> Iron Wolves/);
    assert.doesNotMatch((await lead.request('/players?filter=targets')).text, /href="\/profile\/Rookie"/);

    // Donate and upgrade.
    assert.match((await recruit.flash(`/units/${unitId}/donate`, { amount: '50' })).message, /Donated \$50/);
    assert.match((await lead.flash(`/units/${unitId}/donate`, { amount: '3000' })).message, /Donated \$3,000/);
    assert.equal(ledger('Wolfe', 'unit-donation'), -3000);
    assert.match((await recruit.flash(`/units/${unitId}/upgrades/drill`)).message, /Only the Commander/);
    assert.match((await lead.flash(`/units/${unitId}/upgrades/barracks`)).message, /costs \$5,000/);
    assert.match((await lead.flash(`/units/${unitId}/upgrades/drill`)).message, /Drill ground upgraded to level 1/);
    assert.deepEqual({ ...db.prepare('SELECT treasury, drill FROM units WHERE id = ?').get(unitId) }, { treasury: 50, drill: 1 });
    assert.equal((await lead.post(`/units/${unitId}/upgrades/armoury`)).res.status, 404);

    // Board: members only, escaped, rate limited.
    assert.match((await third.flash(`/units/${unitId}/posts`, { body: 'hi' })).message, /Only members/);
    assert.match((await recruit.flash(`/units/${unitId}/posts`, { body: '<img src=x onerror=alert(1)>' })).message, /Posted/);
    assert.match((await recruit.flash(`/units/${unitId}/posts`, { body: 'again' })).message, /Slow down/);
    const page = (await lead.request(`/units/${unitId}`)).text;
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(page, /<img src=x/);
    assert.doesNotMatch((await third.request(`/units/${unitId}`)).text, /onerror/); // outsiders can't read it

    // Roles.
    assert.match((await recruit.flash(`/units/${unitId}/members/${id('Wolfe')}/kick`)).message, /below your rank/);
    assert.match((await lead.flash(`/units/${unitId}/members/${id('Rookie')}/promote`)).message, /now an officer/);
    assert.match((await lead.flash(`/units/${unitId}/transfer`, { to: String(id('Rookie')), confirm: 'nope' })).message, /Type Rookie/);
    assert.match((await lead.flash(`/units/${unitId}/leave`)).message, /Hand command/);
    assert.match((await lead.flash(`/units/${unitId}/transfer`, { to: String(id('Rookie')), confirm: 'rookie' })).message, /Rookie now commands/);
    assert.deepEqual([user('Rookie').unit_role, user('Wolfe').unit_role], ['leader', 'officer']);

    // Leaving starts a cooldown.
    assert.match((await lead.flash(`/units/${unitId}/leave`)).message, /You left Iron Wolves/);
    assert.equal(user('Wolfe').unit_id, null);
    assert.match((await lead.flash('/units', { name: 'Lone Wolf', tag: 'LW' })).message, /left a unit recently/);

    // Disband needs the tag typed out.
    assert.match((await recruit.flash(`/units/${unitId}/disband`, { confirm: 'no' })).message, /Type the tag IW/);
    assert.match((await recruit.flash(`/units/${unitId}/disband`, { confirm: 'iw' })).message, /disbanded/);
    assert.equal(user('Rookie').unit_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM units').get().n, 0);
    assert.equal((await recruit.request(`/units/${unitId}`)).res.status, 404);

    // The ledger still balances for everyone.
    const off = db.prepare(`SELECT u.username FROM users u WHERE u.cash != (SELECT COALESCE(SUM(delta_cash), 0) FROM ledger l WHERE l.user_id = u.id)`).all();
    assert.deepEqual(off, []);
  } finally {
    server.close();
  }
});

test('admins can rename or disband a unit; others get a 404', async () => {
  const { server, db, base } = await startServer();
  try {
    const boss = await enlist(base, 'Overseer');
    const lead = await enlist(base, 'Edgelord');
    db.prepare("UPDATE users SET level = 5, cash = 5000 WHERE username = 'Edgelord'").run();
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'Overseer'").run();
    const f = await lead.flash('/units', { name: 'Bad Name', tag: 'BAD' });
    const unitId = Number(f.location.split('/').pop());

    assert.equal((await lead.post(`/units/${unitId}/admin/rename`, { name: 'Hacked', tag: 'HAX' })).res.status, 404);
    assert.match((await boss.flash(`/units/${unitId}/admin/rename`, { name: 'Renamed Unit', tag: 'RU' })).message, /Renamed to Renamed Unit \[RU\]/);
    assert.equal(db.prepare('SELECT name FROM units WHERE id = ?').get(unitId).name, 'Renamed Unit');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'unit-rename'").get().n, 1);
    assert.match((await boss.flash(`/units/${unitId}/admin/disband`, { reason: 'Offensive name' })).message, /disbanded/);
    assert.match(db.prepare("SELECT message FROM notifications WHERE kind = 'unit' ORDER BY id DESC").get().message, /Offensive name/);
  } finally {
    server.close();
  }
});

test('application requirements', () => {
  assert.deepEqual(units.parseRequirements({ min_level: '10', min_pvp_wins: '', min_missions: '0' }), { min_level: 10, min_pvp_wins: 0, min_missions: 0 });
  assert.match(units.parseRequirements({ min_level: '-1' }).error, /Level requirement/);
  assert.match(units.parseRequirements({ min_level: '2.5' }).error, /whole number/);
  const unit = { id: 1, name: 'Iron Wolves', recruiting: 1, barracks: 0, min_level: 10, min_pvp_wins: 5, min_missions: 0 };
  assert.deepEqual(units.requirementList(unit).map((r) => r.text), ['Lv 10+', '5+ PvP wins']);
  const ctx = { members: 1, pending: 0, alreadyApplied: false };
  assert.match(units.applyBlocker({ level: 9, pvp_wins: 9 }, unit, ctx), /requires Lv 10\+\. You have 9/);
  assert.match(units.applyBlocker({ level: 12, pvp_wins: 2 }, unit, ctx), /5\+ PvP wins/);
  assert.equal(units.applyBlocker({ level: 12, pvp_wins: 5 }, unit, ctx), null);
});

test('war rules: declaring, scoring and settling', () => {
  const wars = require('../src/wars');
  const now = Date.now();
  const a = { id: 1, name: 'Iron Wolves', treasury: 3000 };
  const t = { id: 2, name: 'Steel Rain', treasury: 0 };
  const ctx = { attackerAtWar: false, targetAtWar: false, attackerMembers: 3, targetMembers: 4, lastPairWarAt: null };
  assert.equal(wars.declareBlocker(a, t, ctx, now), null);
  assert.match(wars.declareBlocker(a, a, ctx, now), /itself/);
  assert.match(wars.declareBlocker(a, t, { ...ctx, targetAtWar: true }, now), /Steel Rain is already at war/);
  assert.match(wars.declareBlocker(a, t, { ...ctx, attackerMembers: 2 }, now), /at least 3 members/);
  assert.match(wars.declareBlocker({ ...a, treasury: 100 }, t, ctx, now), /costs \$2,500/);
  assert.match(wars.declareBlocker(a, { ...t, war_protected_until: now + 3600_000 }, ctx, now), /protected for 1h/);
  assert.match(wars.declareBlocker(a, t, { ...ctx, lastPairWarAt: now - 3600_000 }, now), /rematch is possible in 71h/);

  const war = { attacker_unit_id: 1, defender_unit_id: 2, started_at: now - 1000 };
  const p = (id, unit, joined = now - 5000) => ({ id, unit_id: unit, unit_joined_at: joined });
  assert.deepEqual(wars.scoreFight(war, { a: p(1, 1), d: p(2, 2), attackerWon: true, knockout: false, fullRewards: true }), { side: 'attacker', points: 1 });
  assert.deepEqual(wars.scoreFight(war, { a: p(1, 1), d: p(2, 2), attackerWon: false, knockout: true, fullRewards: true }), { side: 'defender', points: 2 });
  assert.equal(wars.scoreFight(war, { a: p(1, 1), d: p(2, 2), attackerWon: true, knockout: false, fullRewards: false }), null);
  assert.equal(wars.scoreFight(war, { a: p(1, 1, now), d: p(2, 2), attackerWon: true, knockout: false, fullRewards: true }), null); // joined mid-war
  assert.equal(wars.scoreFight(war, { a: p(1, 1), d: p(2, 3), attackerWon: true, knockout: false, fullRewards: true }), null);

  assert.deepEqual(wars.settle({ stake: 2500, attacker_score: 5, defender_score: 3 }), { winner: 'attacker', attackerPrize: 5000, defenderPrize: 0 });
  assert.deepEqual(wars.settle({ stake: 2500, attacker_score: 1, defender_score: 3 }), { winner: 'defender', attackerPrize: 0, defenderPrize: 5000 });
  assert.deepEqual(wars.settle({ stake: 2500, attacker_score: 2, defender_score: 2 }), { winner: null, attackerPrize: 2500, defenderPrize: 0 });
});

test('war end to end: declare, score PvP fights, settle, forfeit', async () => {
  const { server, db, base } = await startServer();
  const { createWarService } = require('../src/war-service');
  const { createPlayerRepo } = require('../src/players');
  const { createUnitRepo } = require('../src/units-repo');
  try {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    const c = {};
    for (const n of names) c[n] = await enlist(base, n);
    const id = (n) => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;
    db.prepare('UPDATE users SET level = 6, cash = 20000').run();
    db.prepare("INSERT INTO ledger (user_id, delta_cash, reason, created_at) SELECT id, 20000 - 100, 'test', 0 FROM users").run();
    const found = async (lead, name, tag) => Number((await c[lead].flash('/units', { name, tag })).location.split('/').pop());
    const wolves = await found('Alpha', 'Iron Wolves', 'IW');
    const rain = await found('Delta', 'Steel Rain', 'SR');
    const join = (n, unit) => db.prepare("UPDATE users SET unit_id = ?, unit_role = 'member', unit_joined_at = ? WHERE username = ?").run(unit, Date.now() - 60_000, n);
    join('Bravo', wolves); join('Charlie', wolves); join('Echo', rain); join('Foxtrot', rain);

    // Requirements block applicants who fall short.
    assert.match((await c.Delta.flash(`/units/${rain}/settings`, { description: '', recruiting: 'on', min_level: '30' })).message, /saved/);
    const outsider = await enlist(base, 'Golf');
    assert.match((await outsider.flash(`/units/${rain}/apply`)).message, /requires Lv 30\+/);
    assert.match((await outsider.request(`/units/${rain}`)).text, /Lv 30\+/);
    assert.match((await c.Delta.flash(`/units/${rain}/settings`, { description: '' })).message, /saved/); // closes applications
    assert.match((await outsider.flash(`/units/${rain}/apply`)).message, /isn’t taking applications/);

    // Declaring needs the stake in the treasury, and only a Commander can declare.
    assert.match((await c.Bravo.flash(`/units/${rain}/war`)).message, /Only a unit Commander/);
    assert.match((await c.Alpha.flash(`/units/${rain}/war`)).message, /costs \$2,500 from the treasury/);
    await c.Alpha.flash(`/units/${wolves}/donate`, { amount: '3000' });
    let f = await c.Alpha.flash(`/units/${rain}/war`);
    assert.match(f.message, /War declared on Steel Rain/);
    const warId = Number(f.location.split('/').pop());
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(wolves).treasury, 500);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'war'").get().n, 6);
    assert.match((await c.Echo.request(`/units/${rain}`)).text, /At war with/);
    assert.match((await c.Echo.request('/players?filter=war')).text, /href="\/profile\/Alpha"/);
    assert.doesNotMatch((await c.Echo.request('/players?filter=war')).text, /href="\/profile\/Foxtrot"/);

    // A PvP win scores; force the outcome by making the defender fragile.
    db.prepare("UPDATE users SET health = 1, max_health = 100 WHERE username = 'Echo'").run();
    db.prepare("UPDATE users SET energy = 50 WHERE username = 'Bravo'").run();
    const fight = await c.Bravo.post('/attack/Echo');
    assert.match(fight.location, /^\/battles\/\d+$/);
    const war = () => db.prepare('SELECT * FROM unit_wars WHERE id = ?').get(warId);
    assert.ok(war().attacker_score >= 1, 'the win scored');
    assert.match((await c.Bravo.request(fight.location)).text, /War fight: \+\d point/);
    assert.match((await c.Alpha.request(`/wars/${warId}`)).text, /Bravo/);

    // Time's up: the declaring unit is ahead, so it gets double the stake.
    db.prepare('UPDATE unit_wars SET ends_at = ? WHERE id = ?').run(Date.now() - 1, warId);
    const players = createPlayerRepo(db);
    const service = createWarService(db, players, createUnitRepo(db));
    assert.equal(service.finishDue(), 1);
    assert.equal(war().status, 'ended');
    assert.equal(war().winner, 'attacker');
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(wolves).treasury, 500 + 5000);
    const rec = (u) => ({ ...db.prepare('SELECT war_wins, war_losses FROM units WHERE id = ?').get(u) });
    assert.deepEqual(rec(wolves), { war_wins: 1, war_losses: 0 });
    assert.deepEqual(rec(rain), { war_wins: 0, war_losses: 1 });
    assert.match((await c.Alpha.request(`/units/${wolves}`)).text, /Won<\/span>/);
    assert.match((await c.Alpha.flash(`/units/${rain}/war`)).message, /protected/);

    // A unit that disbands mid-war forfeits.
    db.prepare('UPDATE units SET war_protected_until = NULL, treasury = 10000').run();
    db.prepare('DELETE FROM unit_wars').run();
    f = await c.Delta.flash(`/units/${wolves}/war`);
    assert.match(f.message, /War declared on Iron Wolves/);
    assert.match((await c.Alpha.flash(`/units/${wolves}/disband`, { confirm: 'IW' })).message, /disbanded/);
    const ended = db.prepare('SELECT * FROM unit_wars').get();
    assert.deepEqual([ended.status, ended.winner], ['ended', 'attacker']);
    assert.equal(db.prepare('SELECT treasury FROM units WHERE id = ?').get(rain).treasury, 10000); // stake back, no profit
    assert.match((await c.Delta.request('/wars')).text, /forfeit/);
  } finally {
    server.close();
  }
});
