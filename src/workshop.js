'use strict';

/**
 * The workshop: materials, upgrades and salvage. Pure rules.
 *
 * Won missions, completed operations and deployments turn up materials. They
 * upgrade gear (and vehicles) from Mk I to Mk III, and outgrown gear can be
 * salvaged for materials instead of sold for cash. Materials can't be traded
 * or sold, so they never pass value between accounts.
 *
 * Everything is priced in "worth", a cash-like measure: a drop is worth a
 * share of what the action paid, an upgrade costs a share of the item's price.
 * That keeps upgrades the same effort at every level.
 */

const tuning = require('./tuning');

const MATERIALS = [
  { id: 'scrap', name: 'Scrap metal', worth: 25, blurb: 'The basis of every job in the workshop.' },
  { id: 'circuits', name: 'Circuit boards', worth: 100, blurb: 'For weapons, tactical kit and light vehicles.' },
  { id: 'composite', name: 'Composite plating', worth: 100, blurb: 'For armour, helmets, transports and tanks.' },
  { id: 'core', name: 'Prototype core', worth: 1000, blurb: 'Rare. Needed for Mk II and Mk III upgrades.' },
];
const MATERIALS_BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));

const MAX_UPGRADE = 3;
const GEAR_STEP = 0.05; // each upgrade level: +5% to all of an item's stats
const VEHICLE_STEP = 0.1; // …and +10% to a vehicle's bonuses
const LABELS = ['', 'Mk I', 'Mk II', 'Mk III'];

const DROP_SHARE = 0.12; // a won mission turns up materials worth 12% of its pay
const DROP_WEIGHTS = { scrap: 0.6, circuits: 0.17, composite: 0.17, core: 0.06 }; // shares of that worth
const OP_DROP_SHARE = 0.3; // an operation's completion bonus: 30%, richer in cores
const OP_WEIGHTS = { scrap: 0.4, circuits: 0.15, composite: 0.15, core: 0.3 };
const DEPLOY_DROP_SHARE = 0.08;
const UPGRADE_SHARE = 0.08; // Mk n costs materials worth 8% × n of the item's price…
const UPGRADE_FEE = 0.04; // …and a workshop fee of 4% × n of it in cash
const SALVAGE_SHARE = 0.2; // salvaging gives materials worth 20% of the price (less when worn)

const label = (upgrade) => LABELS[upgrade] || '';
/** "Assault Rifle Mk II". */
const nameOf = (thing, upgrade) => (upgrade ? `${thing.name} ${label(upgrade)}` : thing.name);

/** What a gear item or vehicle mostly needs besides scrap. */
function specialty(target) {
  const slotOrClass = target.slot || target.cls;
  return ['weapon', 'kit', 'light'].includes(slotOrClass) ? 'circuits' : 'composite';
}

/** Splits `worth` into whole materials by `weights`, rounding at random so small amounts still turn up sometimes. */
function split(worth, weights, rng = Math.random) {
  const bag = {};
  for (const [id, w] of Object.entries(weights)) {
    const exact = (worth * w) / MATERIALS_BY_ID.get(id).worth;
    const n = Math.floor(exact) + (rng() < exact - Math.floor(exact) ? 1 : 0);
    if (n > 0) bag[id] = n;
  }
  return bag;
}

/** Materials found on a won mission that paid `cash` (or `kind` 'operation' / 'deployment'). */
function drop(cash, rng = Math.random, kind = 'mission') {
  const share = kind === 'operation' ? OP_DROP_SHARE : kind === 'deployment' ? DEPLOY_DROP_SHARE : DROP_SHARE;
  const worth = Math.max(0, cash) * share * tuning.get('workshopDropMult');
  return split(worth, kind === 'operation' ? OP_WEIGHTS : DROP_WEIGHTS, rng);
}

/** What the next upgrade (to `level`, 1–3) costs: { materials, cash }. */
function recipe(target, level) {
  const worth = target.price * UPGRADE_SHARE * level * tuning.get('workshopCostMult');
  const materials = { scrap: Math.max(1, Math.ceil((worth * 0.55) / 25)), [specialty(target)]: Math.max(1, Math.ceil((worth * 0.35) / 100)) };
  if (level >= 2) materials.core = Math.max(1, Math.round((worth * 0.1) / 1000));
  return { materials, cash: Math.round(target.price * UPGRADE_FEE * level) };
}

/** Materials back from salvaging: a share of the price (less when worn) plus half the upgrade materials spent on it. */
function salvageYield(target, condition = 100, upgrade = 0) {
  const worth = target.price * SALVAGE_SHARE * (0.5 + Math.max(0, Math.min(100, condition)) / 200);
  const bag = { scrap: Math.floor((worth * 0.6) / 25), [specialty(target)]: Math.floor((worth * 0.4) / 100) };
  for (let l = 1; l <= upgrade; l += 1) {
    for (const [id, n] of Object.entries(recipe(target, l).materials)) bag[id] = (bag[id] || 0) + Math.floor(n / 2);
  }
  for (const id of Object.keys(bag)) if (!bag[id]) delete bag[id];
  return bag;
}

/** Whether `have` (Map of material → count) covers `bag`. */
const covers = (have, bag) => Object.entries(bag).every(([id, n]) => (have.get(id) || 0) >= n);

/** "3 Scrap metal, 1 Prototype core". */
function describe(bag) {
  return MATERIALS.filter((m) => bag[m.id]).map((m) => `${bag[m.id].toLocaleString('en-US')} ${m.name}`).join(', ');
}

const gearFactor = (upgrade = 0) => 1 + GEAR_STEP * Math.max(0, Math.min(MAX_UPGRADE, upgrade));
const vehicleFactor = (upgrade = 0) => 1 + VEHICLE_STEP * Math.max(0, Math.min(MAX_UPGRADE, upgrade));

module.exports = {
  GEAR_STEP, MATERIALS, MATERIALS_BY_ID, MAX_UPGRADE, VEHICLE_STEP,
  covers, describe, drop, gearFactor, label, nameOf, recipe, salvageYield, specialty, split, vehicleFactor,
};
