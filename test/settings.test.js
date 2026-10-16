'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tuning = require('../src/tuning');
const game = require('../src/game');
const bank = require('../src/bank');
const chat = require('../src/chat');
const seasons = require('../src/seasons');
const deployments = require('../src/deployments');
const { createSettingsService } = require('../src/settings-service');
const { createDeploymentService } = require('../src/deployment-service');
const { createPlayerRepo } = require('../src/players');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

test.afterEach(() => tuning.reset());

test('settings registry: parsing, limits and formatting', () => {
  const mult = tuning.BY_KEY.get('missionCashMult');
  assert.deepEqual(tuning.parse(mult, '1.5'), { value: 1.5 });
  assert.deepEqual(tuning.parse(mult, '×1.52'), { value: 1.5 }); // snapped to the 0.05 step
  assert.match(tuning.parse(mult, '9').error, /between 0.25 and 3/);
  assert.match(tuning.parse(mult, 'lots').error, /isn’t a number/);
  assert.match(tuning.parse(mult, '').error, /enter a value/);
  assert.match(tuning.parse(tuning.BY_KEY.get('hospitalStayMinutes'), '2.5').error, /whole number/);
  assert.deepEqual(tuning.parse(tuning.BY_KEY.get('registrationOpen'), undefined), { value: false });
  assert.equal(tuning.format(mult, 1.5), '×1.5');
  assert.equal(tuning.format(tuning.BY_KEY.get('depositFeePct'), 1), '1%');
  assert.equal(tuning.format(tuning.BY_KEY.get('energyRegenMinutes'), 1.5), '1.5 min per point');
  assert.equal(tuning.format(tuning.BY_KEY.get('registrationOpen'), false), 'off');
  assert.throws(() => tuning.get('nope'), /Unknown game setting/);
  // Every setting has a group, a default inside its limits, and help text.
  for (const s of tuning.SETTINGS) {
    assert.ok(tuning.GROUPS.some((g) => g.id === s.group), s.key);
    assert.ok(s.help && s.label, s.key);
    if (s.type !== 'bool') assert.ok(s.default >= s.min && s.default <= s.max, s.key);
  }
});

test('settings service: save, history, load, reset and the anti-cheat window', () => {
  const db = openDatabase(':memory:');
  const svc = createSettingsService(db);
  svc.load();
  const now = Date.now();

  assert.deepEqual(svc.update({ missionCashMult: '5', chatCooldownSeconds: '10' }, null, { now }).errors.length, 1);
  assert.equal(tuning.get('chatCooldownSeconds'), 3); // nothing saved when anything is invalid

  const out = svc.update({ missionCashMult: '1.5', chatCooldownSeconds: '3', registrationOpen__present: '1' }, null, { note: 'launch', now });
  // Only real changes: cooldown is unchanged, the unticked checkbox turns sign-ups off.
  assert.deepEqual(out.changes.map((c) => [c.setting.key, c.before, c.after]), [['missionCashMult', 1, 1.5], ['registrationOpen', true, false]]);
  assert.equal(tuning.get('missionCashMult'), 1.5);
  assert.equal(svc.recent()[0].note, 'launch');
  assert.match(`${svc.recent().map((h) => `${h.before}→${h.after}`)}`, /×1→×1.5/);

  // A fresh process loads what was saved.
  tuning.reset();
  createSettingsService(db).load();
  assert.deepEqual([tuning.get('missionCashMult'), tuning.get('registrationOpen')], [1.5, false]);

  // Anti-cheat sees the most generous value in its window.
  svc.update({ missionCashMult: '0.5' }, null, { now: now + 1000 });
  assert.equal(svc.extreme('missionCashMult', now - 1000, Math.max), 1.5);
  assert.equal(svc.extreme('missionCashMult', now + 5000, Math.max), 0.5);

  // Back to defaults: rows removed, history kept.
  assert.equal(svc.resetAll(null).changes.length, 2);
  assert.deepEqual(tuning.all(), { ...tuning.DEFAULTS });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_settings').get().n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM game_settings_history').get().n >= 5);
});

test('settings change the game: energy, hospital, fees, chat, seasons, deployments', () => {
  const now = Date.now();
  const p = { energy: 0, max_energy: 50, energy_updated_at: now - 10 * 60 * 1000, health: 100, max_health: 100, health_updated_at: now, level: 5, cash: 0 };
  assert.equal(game.applyRegen(p, now).energy, 5); // default: 1 per 2 min
  tuning.set({ energyRegenMinutes: 1 });
  assert.equal(game.applyRegen(p, now).energy, 10);
  assert.equal(game.playerView(p, now).energyRegenSeconds, 60);

  tuning.set({ hospitalStayMinutes: 30 });
  assert.equal(game.admitToHospital({ ...p }, now, 'x').hospital_until, now + 30 * 60 * 1000);

  tuning.set({ depositFeePct: 0 });
  assert.equal(bank.depositFee(1000, bank.feeRateFor({})), 0);
  tuning.set({ depositFeePct: 5 });
  assert.equal(bank.depositFee(1000, bank.feeRateFor({ base_vault: 2 })), 40); // 5% − 2 × 0.5

  tuning.set({ chatCooldownSeconds: 30, chatMinLevel: 6 });
  assert.match(chat.postBlocker({ level: 5 }, 'hi', null, now), /level 6/);
  assert.match(chat.postBlocker({ level: 6 }, 'hi', { body: 'x', created_at: now - 10000 }, now), /Slow mode is on: you can send another message in 20s/);

  tuning.set({ seasonRewardsMult: 2, seasonPlacementFights: 10, seasonDays: 14 });
  assert.deepEqual([seasons.rewardFor(1400, 1).cash, seasons.placementFights(), seasons.seasonDays()], [90000, 10, 14]);

  tuning.set({ deploymentCapHours: 4 });
  assert.match(deployments.deployBlocker({ level: 10, health: 100, max_health: 100 }, deployments.KINDS_BY_ID.get('recon'), 1, now), /Only 3h/);
  const db = openDatabase(':memory:');
  tuning.set({ deploymentPayMult: 0.5 });
  assert.deepEqual(createDeploymentService(db, createPlayerRepo(db)).multipliers(1, now), { cashMult: 0.5, xpMult: 0.5 });
});

test('admin game settings page and closing sign-ups', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret', tutorial: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    const request = async (p, { method = 'GET', form } = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      return { res, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async (from = '/hq') => (await request(from)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return {
      request,
      post: async (p, form = {}) => request(p, { method: 'POST', form: { _csrf: await csrf(), ...form } }),
      async enlist(username) {
        return request('/register', { method: 'POST', form: { _csrf: await csrf('/login'), username, email: `${username}@x.com`, password: 'password123', confirm: 'password123', adult: 'on', terms: 'on' } });
      },
    };
  };
  try {
    const admin = client(); await admin.enlist('Brass');
    assert.equal((await admin.request('/admin/settings')).res.status, 404); // admins only
    db.prepare('UPDATE users SET is_admin = 1').run();
    let page = (await admin.request('/admin/settings')).text;
    assert.match(page, /Mission &amp; operation pay[\s\S]*Default: ×1/);
    assert.match(page, /<span class="base-rating__value">0<\/span>/);

    // A bad value saves nothing and is reported.
    await admin.post('/admin/settings', { missionCashMult: '99', registrationOpen__present: '1', registrationOpen: '1' });
    page = (await admin.request('/admin/settings')).text;
    assert.match(page, /Mission &amp; operation pay: must be between 0.25 and 3/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_settings').get().n, 0);

    // Save: live straight away, audited, and shown as changed.
    await admin.post('/admin/settings', { missionCashMult: '2', energyRegenMinutes: '1', registrationOpen__present: '1', _note: 'launch weekend' });
    assert.deepEqual([tuning.get('missionCashMult'), tuning.get('energyRegenMinutes'), tuning.get('registrationOpen')], [2, 1, false]);
    page = (await admin.request('/admin/settings')).text;
    assert.match(page, /<span class="base-rating__value">3<\/span>/);
    assert.match(page, /Energy regeneration<\/strong> 2 min per point → <strong>1 min per point/);
    assert.match((await admin.request('/admin')).text, /Mission &amp; operation pay: ×1 → ×2 \(launch weekend\)/);

    // Sign-ups are closed.
    const late = client();
    assert.match((await late.request('/register')).text, /Enlistment is closed/);
    assert.equal((await late.enlist('Latecomer')).res.status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'Latecomer'").get().n, 0);

    // Reset everything.
    await admin.post('/admin/settings/reset');
    assert.deepEqual(tuning.all(), { ...tuning.DEFAULTS });
    assert.equal((await late.enlist('Latecomer')).location, '/hq');
  } finally {
    server.close();
  }
});
