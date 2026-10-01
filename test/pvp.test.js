'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');
const pvp = require('../src/pvp');

const T0 = 1_700_000_000_000;
const soldier = (overrides = {}) => ({
  id: 1, username: 'Alpha', missions_completed: 0, missions_failed: 0, pvp_wins: 0, pvp_losses: 0,
  hospital_until: null, hospital_reason: null,
  ...game.newPlayerDefaults(T0), level: 5, max_health: 140, health: 140, cash: 1000,
  ...overrides,
});
const seq = (...values) => () => (values.length > 1 ? values.shift() : values[0]);

test('hospital: admission blocks missions, release restores half health', () => {
  const p = game.admitToHospital(soldier(), T0, 'Knocked out by Bravo');
  assert.equal(game.isHospitalized(p, T0 + 1000), true);
  assert.match(game.runMission('perimeter-patrol', p, { now: T0 + 1000 }).error, /hospital/);
  assert.match(game.visitHospital(p, { now: T0 + 1000 }).error, /admitted/);

  const after = game.applyRegen(p, T0 + game.HOSPITAL_STAY_MS + 60_000);
  assert.equal(after.hospital_until, null);
  assert.equal(after.health, 71); // 70 on release (50% of 140) + 1 minute of regen
});

test('hospital: early discharge costs per remaining minute', () => {
  const p = game.admitToHospital(soldier({ cash: 500 }), T0, 'x');
  assert.equal(game.dischargeCost(p, T0), 10 * (10 + 2 * 5));
  const out = game.dischargeEarly(p, { now: T0 });
  assert.equal(out.cost, 200);
  assert.equal(out.player.cash, 300);
  assert.equal(out.player.health, 70);
  assert.equal(game.isHospitalized(out.player, T0), false);
  assert.match(game.dischargeEarly(soldier(), { now: T0 }).error, /aren’t in hospital/);
  assert.match(game.dischargeEarly(game.admitToHospital(soldier({ cash: 5 }), T0, 'x'), { now: T0 }).error, /costs/);
});

test('attack blockers', () => {
  const a = soldier({ id: 1, username: 'Alpha' });
  const d = soldier({ id: 2, username: 'Bravo' });
  const opts = { now: T0 };
  assert.equal(pvp.attackBlocker(a, d, opts), null);
  assert.match(pvp.attackBlocker(a, a, opts), /yourself/);
  assert.match(pvp.attackBlocker(soldier({ level: 2 }), d, opts), /unlocks at level 3/);
  assert.match(pvp.attackBlocker(a, soldier({ id: 2, level: 2 }), opts), /protected/);
  assert.match(pvp.attackBlocker(a, game.admitToHospital(soldier({ id: 2, username: 'Bravo' }), T0, 'x'), opts), /Bravo is in hospital/);
  assert.match(pvp.attackBlocker(game.admitToHospital(soldier(), T0, 'x'), d, opts), /You’re in hospital/);
  assert.match(pvp.attackBlocker(soldier({ level: 9 }), soldier({ id: 2, level: 5 }), opts), /too far below/);
  assert.equal(pvp.attackBlocker(soldier({ level: 5 }), soldier({ id: 2, level: 12 }), opts), null); // punching up is allowed
  assert.match(pvp.attackBlocker(soldier({ energy: 5 }), d, opts), /energy/);
  assert.match(pvp.attackBlocker(soldier({ health: 10 }), d, opts), /injured/);
  assert.match(pvp.attackBlocker(a, d, { now: T0, lastAttackAt: T0 - 60_000 }), /14 min/);
  assert.equal(pvp.attackBlocker(a, d, { now: T0, lastAttackAt: T0 - pvp.PAIR_COOLDOWN_MS }), null);
});

test('fight: knockout ends it and the loser is hospitalised', () => {
  const strong = game.statsFor(5, ['assault-rifle']);
  const weak = game.statsFor(5);
  const out = pvp.resolveAttack(soldier({ id: 1 }), soldier({ id: 2, username: 'Bravo', health: 20 }), {
    aStats: strong, dStats: weak, now: T0, rng: seq(0.5, 0.99),
  });
  assert.equal(out.report.attackerWon, true);
  assert.equal(out.report.knockout, 'defender');
  assert.equal(out.report.rounds.length, 1);
  assert.equal(out.defender.health, 0);
  assert.equal(game.isHospitalized(out.defender, T0 + 1), true);
  assert.match(out.defender.hospital_reason, /Knocked out by Alpha/);
  assert.equal(out.attacker.energy, 40);
  assert.equal(out.attacker.pvp_wins, 1);
  assert.equal(out.defender.pvp_losses, 1);
});

test('fight: defender fights back and can win', () => {
  const weak = game.statsFor(5);
  const strong = game.statsFor(5, ['light-machine-gun']);
  const out = pvp.resolveAttack(soldier({ id: 1, health: 30 }), soldier({ id: 2, username: 'Bravo' }), {
    aStats: weak, dStats: strong, now: T0, rng: seq(0.5, 0.99),
  });
  assert.equal(out.report.attackerWon, false);
  assert.equal(out.report.knockout, 'attacker');
  assert.equal(game.isHospitalized(out.attacker, T0 + 1), true);
  assert.equal(out.report.cashTaken, 0); // a failed attacker loses health, not cash
  assert.ok(out.report.xp.defender > 0);
  assert.equal(out.defender.pvp_wins, 1);
});

test('fight without a knockout is decided on share of health lost; ties go to the defender', () => {
  const s = game.statsFor(5);
  const fight = pvp.simulateFight(s, s, 1000, 1000, seq(0.5, 0.99));
  assert.equal(fight.knockout, null);
  assert.equal(fight.rounds.length, pvp.MAX_ROUNDS);
  assert.equal(fight.attackerWon, false);
});

test('rewards are modest and capped', () => {
  assert.equal(pvp.cashPrize({ cash: 1000, level: 5 }), 50); // 5%
  assert.equal(pvp.cashPrize({ cash: 1_000_000, level: 5 }), 125); // capped at $25 × level
  assert.equal(pvp.cashPrize({ cash: 0, level: 5 }), 0);
  assert.equal(pvp.winXp(5, 5), 18);
  assert.equal(pvp.winXp(5, 20), Math.round(48 * 1.5)); // punching up caps at ×1.5
  assert.equal(pvp.winXp(10, 7), Math.round(22 * 0.7)); // punching down earns less
});
