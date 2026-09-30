'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const combat = require('../src/combat');
const game = require('../src/game');
const { ITEMS } = require('../src/items');
const { checkPurchase, checkEquip } = require('../src/armory');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('increased modifiers add together, more modifiers compound', () => {
  const inc = combat.buildStats(1, [
    { stat: 'damage', kind: 'increased', value: 0.1 },
    { stat: 'damage', kind: 'increased', value: 0.15 },
  ]);
  close(inc.damage, 1.25);
  const mult = combat.buildStats(1, [
    { stat: 'damage', kind: 'more', value: 0.1 },
    { stat: 'damage', kind: 'more', value: 0.2 },
  ]);
  close(mult.damage, 1.32);
});

test('flat modifiers apply before percentage ones', () => {
  const s = combat.buildStats(1, [
    { stat: 'attack', kind: 'flat', value: 10 },
    { stat: 'attack', kind: 'increased', value: 0.5 },
  ]);
  close(s.attack, 30); // (10 base + 10) × 1.5
  assert.equal(combat.buildStats(5).attack, 18); // base grows 2 per level
});

test('crit chance is capped', () => {
  const s = combat.buildStats(1, [{ stat: 'critChance', kind: 'flat', value: 5 }]);
  assert.equal(s.critChance, 0.5);
});

test('armour has diminishing returns and a cap', () => {
  assert.equal(combat.mitigation(0), 0);
  assert.equal(combat.mitigation(100), 0.5);
  assert.equal(combat.mitigation(1e9), combat.MAX_MITIGATION);
});

test('rollHit applies variance, crits and armour', () => {
  const attacker = combat.buildStats(1, [{ stat: 'attack', kind: 'flat', value: 90 }]); // 100 attack
  const defender = combat.buildStats(1, [{ stat: 'armor', kind: 'flat', value: 100 }]); // halves damage
  // rng: 0.5 → no variance; 0.99 → no crit
  let seq = [0.5, 0.99];
  let hit = combat.rollHit(attacker, defender, { rng: () => seq.shift() });
  assert.deepEqual(hit, { damage: 50, crit: false, mitigated: 50 });
  // rng: 0.5 → no variance; 0 → crit (×1.5)
  seq = [0.5, 0];
  hit = combat.rollHit(attacker, defender, { rng: () => seq.shift() });
  assert.equal(hit.crit, true);
  assert.equal(hit.damage, 75);
});

test('modifiers are described for players', () => {
  assert.equal(combat.describeModifier({ stat: 'attack', kind: 'flat', value: 12 }), '+12 attack');
  assert.equal(combat.describeModifier({ stat: 'damage', kind: 'increased', value: 0.1 }), '+10% damage');
  assert.equal(combat.describeModifier({ stat: 'damage', kind: 'more', value: 0.15 }), '×1.15 damage');
  assert.equal(combat.describeModifier({ stat: 'critChance', kind: 'flat', value: 0.05 }), '+5% crit chance');
});

test('every catalogue item uses known stats and modifier kinds', () => {
  for (const item of ITEMS) {
    for (const m of item.mods) {
      assert.ok(combat.STATS[m.stat], `${item.id}: unknown stat ${m.stat}`);
      assert.ok(combat.MODIFIER_KINDS.includes(m.kind), `${item.id}: unknown kind ${m.kind}`);
    }
  }
});

test('gear improves mission success and armour absorbs failure damage', () => {
  const player = { id: 1, level: 1, xp: 0, cash: 0, energy: 50, max_energy: 50, health: 100, max_health: 100,
    energy_updated_at: 0, health_updated_at: 0, missions_completed: 0, missions_failed: 0 };
  const mission = game.MISSIONS[0];
  const unarmed = game.statsFor(1);
  const geared = game.statsFor(1, ['service-pistol', 'flak-vest', 'red-dot-sight']);
  assert.equal(game.gearBonus(1, unarmed), 0);
  assert.ok(game.successChance(mission, player, geared) > game.successChance(mission, player, unarmed));
  assert.ok(game.gearBonus(20, game.statsFor(20, ['light-machine-gun', 'heavy-assault-plate', 'rangefinder'])) <= 0.15);

  const tank = game.statsFor(1, ['heavy-assault-plate']);
  // rng: 0.99 fails the roll, then 0 for xp, then 0.99 for max damage (8)
  const seq = [0.99, 0, 0.99];
  const { result } = game.runMission(mission.id, player, { now: 0, rng: () => seq.shift(), stats: tank });
  assert.equal(result.success, false);
  assert.ok(result.damage < 8);
  assert.equal(result.damage + result.absorbed, 8);
});

test('purchase and equip rules', () => {
  const p = { level: 1, cash: 200 };
  assert.match(checkPurchase('nope', p, new Set()).error, /catalogue/);
  assert.match(checkPurchase('carbine', p, new Set()).error, /level 3/);
  assert.match(checkPurchase('flak-vest', { level: 1, cash: 50 }, new Set()).error, /costs \$120/);
  assert.match(checkPurchase('flak-vest', p, new Set(['flak-vest'])).error, /already own/);
  assert.equal(checkPurchase('flak-vest', p, new Set()).cost, 120);
  assert.match(checkEquip('flak-vest', p, new Set()).error, /don’t own/);
  assert.equal(checkEquip('flak-vest', p, new Set(['flak-vest'])).item.id, 'flak-vest');
});

test('percentage and multiplier modifiers are described for every stat', () => {
  assert.equal(combat.describeModifier({ stat: 'armor', kind: 'increased', value: 0.1 }), '+10% armour');
  assert.equal(combat.describeModifier({ stat: 'attack', kind: 'more', value: 0.2 }), '×1.20 attack');
  assert.equal(combat.describeModifier({ stat: 'critDamage', kind: 'flat', value: 0.25 }), '+25% crit damage');
  assert.equal(combat.describeModifier({ stat: 'armor', kind: 'flat', value: -5 }), '−5 armour');
});
