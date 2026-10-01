'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');

const T0 = 1_700_000_000_000;
const fixed = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};
const newPlayer = (overrides = {}) => ({
  id: 1, username: 'tester', missions_completed: 0, missions_failed: 0,
  ...game.newPlayerDefaults(T0), ...overrides,
});

test('xpToNext grows with level', () => {
  assert.equal(game.xpToNext(1), 100);
  assert.ok(game.xpToNext(5) > game.xpToNext(4));
});

test('rankFor maps levels to ranks and caps at General', () => {
  assert.equal(game.rankFor(1).name, 'Recruit');
  assert.equal(game.rankFor(3).name, 'Private');
  assert.equal(game.rankFor(999).name, 'General');
  assert.deepEqual(game.nextRankFor(1), { name: 'Private', grade: 'E-2', level: 3 });
  assert.equal(game.nextRankFor(40), null);
});

test('energy regenerates over time and keeps partial progress', () => {
  const p = newPlayer({ energy: 10 });
  const later = game.applyRegen(p, T0 + game.ENERGY_REGEN_MS * 3 + 1000);
  assert.equal(later.energy, 13);
  assert.equal(later.energy_updated_at, T0 + game.ENERGY_REGEN_MS * 3);
});

test('regen never exceeds the maximum', () => {
  const p = newPlayer({ energy: 49, health: 90 });
  const later = game.applyRegen(p, T0 + 24 * 60 * 60 * 1000);
  assert.equal(later.energy, p.max_energy);
  assert.equal(later.health, p.max_health);
});

test('successful mission spends energy and pays out', () => {
  const p = newPlayer();
  const { player, result, error } = game.runMission('perimeter-patrol', p, { now: T0, rng: fixed(0, 0) });
  assert.equal(error, undefined);
  assert.equal(result.success, true);
  assert.equal(player.energy, 45);
  assert.equal(player.xp, 8);
  assert.equal(player.cash, 120);
  assert.equal(player.missions_completed, 1);
});

test('failed mission costs health and grants partial xp', () => {
  const p = newPlayer();
  const { player, result } = game.runMission('perimeter-patrol', p, { now: T0, rng: fixed(0.99, 0, 0) });
  assert.equal(result.success, false);
  assert.equal(result.xp, 2);
  assert.equal(player.health, 97);
  assert.equal(player.missions_failed, 1);
});

test('missions are blocked by level, energy and injuries', () => {
  assert.match(game.runMission('high-value-target', newPlayer(), { now: T0 }).error, /level 12/);
  assert.match(game.runMission('perimeter-patrol', newPlayer({ energy: 2 }), { now: T0 }).error, /energy/);
  assert.match(game.runMission('perimeter-patrol', newPlayer({ health: 5 }), { now: T0 }).error, /injured/);
  assert.match(game.runMission('nope', newPlayer(), { now: T0 }).error, /Unknown/);
});

test('levelling up raises caps and refills resources', () => {
  const p = newPlayer({ xp: 95, energy: 10 });
  const { player, result } = game.runMission('perimeter-patrol', p, { now: T0, rng: fixed(0, 0) });
  assert.deepEqual(result.levelsGained, [2]);
  assert.equal(player.level, 2);
  assert.equal(player.xp, 3);
  assert.equal(player.max_energy, 55);
  assert.equal(player.energy, 55);
});

test('hospital heals for cash', () => {
  const out = game.visitHospital(newPlayer({ health: 80, cash: 100 }), { now: T0 });
  assert.equal(out.cost, 40);
  assert.equal(out.player.health, 100);
  assert.equal(out.player.cash, 60);
  assert.match(game.visitHospital(newPlayer(), { now: T0 }).error, /full health/);
  assert.match(game.visitHospital(newPlayer({ health: 10, cash: 5 }), { now: T0 }).error, /costs/);
});

test('presence: online window, sign-out and relative times', () => {
  const presence = require('../src/presence');
  const now = T0;
  assert.equal(presence.isOnline({ last_seen_at: now - 60_000 }, now), true);
  assert.equal(presence.isOnline({ last_seen_at: now - presence.ONLINE_WINDOW_MS - 1 }, now), false);
  assert.equal(presence.isOnline({ last_seen_at: now - 1000, signed_out_at: now }, now), false);
  assert.equal(presence.isOnline({ last_seen_at: now, signed_out_at: now - 1000 }, now), true);
  assert.equal(presence.isOnline({ last_seen_at: null }, now), false);
  assert.equal(presence.timeAgo(now - 10_000, now), 'just now');
  assert.equal(presence.timeAgo(now - 5 * 60_000, now), '5m ago');
  assert.equal(presence.timeAgo(now - 3 * 3600_000, now), '3h ago');
});

test('unlocksAt lists missions, gear and PvP for a level', () => {
  const { unlocksAt } = require('../src/notify');
  const at3 = unlocksAt(3).map((u) => u.message).join(' | ');
  assert.match(at3, /Forward Recon/);
  assert.match(at3, /M4 Carbine/);
  assert.match(at3, /PvP unlocked/);
  assert.deepEqual(unlocksAt(13), []);
});
