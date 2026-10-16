'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');
const combat = require('../src/combat');
const { ITEMS } = require('../src/items');
const perks = require('../src/perks');
const ops = require('../src/operations');
const titles = require('../src/titles');
const { unlocksAt } = require('../src/notify');

test('campaigns 4–6 take the game to level 100', () => {
  for (const [id, from, to] of [[4, 51, 65], [5, 66, 80], [6, 81, 100]]) {
    const list = game.MISSIONS.filter((m) => m.campaign === id);
    assert.equal(list.length, 6, `campaign ${id}`);
    assert.ok(list.every((m) => m.minLevel >= from && m.minLevel <= to), `campaign ${id} levels`);
    assert.ok(unlocksAt(from).some((u) => new RegExp(`Campaign ${id} is open`).test(u.message)), `campaign ${id} unlock message`);
  }
  assert.equal(Math.max(...game.MISSIONS.map((m) => m.minLevel)), 100);
  // Every mission fits comfortably in that level's energy bar.
  for (const m of game.MISSIONS) assert.ok(m.energy <= (50 + 5 * (m.minLevel - 1)) / 2, `${m.id} energy`);
  // Pay per energy rises with every mission, all the way up (XP per energy is checked in campaign2.test.js).
  const sorted = [...game.MISSIONS].sort((a, b) => a.minLevel - b.minLevel);
  const ev = (m) => (m.chance * (m.cash[0] + m.cash[1])) / 2 / m.energy;
  for (let i = 1; i < sorted.length; i += 1) assert.ok(ev(sorted[i]) > ev(sorted[i - 1]), sorted[i].id);
});

test('honour ranks, perks and titles past level 50', () => {
  assert.equal(game.rankFor(55).grade, 'GM-1');
  assert.equal(game.rankFor(100).name, 'Grand Marshal X');
  assert.equal(game.rankFor(100).grade, 'GM-10');
  for (const p of perks.PERKS) assert.equal(game.rankFor(p.level).name, p.rank);
  const p100 = perks.perksFor(100);
  assert.ok(Math.abs(p100.missionCash - 0.3) < 1e-9 && Math.abs(p100.missionXp - 0.3) < 1e-9);
  assert.equal(perks.nextPerk(54).rank, 'Grand Marshal I');
  assert.equal(perks.nextPerk(100), null);
  assert.ok(titles.TITLES_BY_ID.get('immortal').test({ level: 75 }));
  assert.ok(titles.TITLES_BY_ID.get('centurion').test({ level: 100 }));
});

test('endgame gear keeps improving without breaking the armour cap', () => {
  const bestAt = (level) => {
    const by = {};
    for (const i of ITEMS) if (i.minLevel <= level && (!by[i.slot] || by[i.slot].price < i.price)) by[i.slot] = i;
    return Object.values(by).map((i) => i.id);
  };
  let last = 0;
  for (let level = 50; level <= 100; level += 2) {
    const stats = game.statsFor(level, bestAt(level));
    const rating = combat.combatRating(stats);
    assert.ok(rating > last, `best gear at level ${level} beats the level before`);
    last = rating;
    assert.ok(combat.mitigation(stats.armor) < 0.7, `armour reduction under 70% at level ${level}`);
    assert.ok(stats.critChance <= 0.5, `crit chance within its cap at level ${level}`);
    // Fights between equals stay at 3+ average hits: no one-shot PvP at the top.
    const hits = (100 + 10 * (level - 1)) / (combat.expectedDamage(stats) * (1 - combat.mitigation(stats.armor)));
    assert.ok(hits >= 3, `PvP fights last ${hits.toFixed(1)} hits at level ${level}`);
  }
  assert.equal(ITEMS.filter((i) => i.minLevel > 50).length, 24);
  for (const slot of ['weapon', 'body', 'helmet', 'kit']) {
    const list = ITEMS.filter((i) => i.slot === slot).sort((a, b) => a.minLevel - b.minLevel);
    for (let i = 1; i < list.length; i += 1) assert.ok(list[i].price > list[i - 1].price, `${list[i].id} costs more`);
  }
});

test('endgame operations escalate within and between operations', () => {
  const late = ops.OPERATIONS.filter((o) => o.minLevel > 50);
  assert.deepEqual(late.map((o) => o.minLevel), [55, 62, 70, 77, 85, 95]);
  let lastBonus = ops.OPERATIONS_BY_ID.get('iron-crown').bonus.cash;
  for (const op of late) {
    assert.equal(op.stages.length, 3);
    assert.ok(op.stages[0].energy < op.stages[2].energy && op.stages[0].chance > op.stages[2].chance, op.id);
    assert.ok(op.bonus.cash > lastBonus, `${op.id} pays a bigger bonus`);
    lastBonus = op.bonus.cash;
  }
});
