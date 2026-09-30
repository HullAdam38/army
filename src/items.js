'use strict';

/**
 * Armory catalogue. Items are static game data; ownership and what's equipped
 * live in the database. Each item's `mods` feed straight into combat.buildStats.
 */

const SLOTS = [
  { id: 'weapon', label: 'Primary weapon' },
  { id: 'body', label: 'Body armour' },
  { id: 'helmet', label: 'Helmet' },
  { id: 'kit', label: 'Tactical kit' },
];

const flat = (stat, value) => ({ stat, kind: 'flat', value });
const increased = (stat, value) => ({ stat, kind: 'increased', value });
const more = (stat, value) => ({ stat, kind: 'more', value });

const ITEMS = [
  // Weapons: the main source of attack.
  { id: 'service-pistol', slot: 'weapon', name: 'Service Pistol', minLevel: 1, price: 150,
    blurb: 'Standard sidearm. Better than harsh language.',
    mods: [flat('attack', 4)] },
  { id: 'carbine', slot: 'weapon', name: 'M4 Carbine', minLevel: 3, price: 600,
    blurb: 'Light, reliable and quick to bring on target.',
    mods: [flat('attack', 10), flat('critChance', 0.02)] },
  { id: 'assault-rifle', slot: 'weapon', name: 'Assault Rifle', minLevel: 6, price: 1800,
    blurb: 'Full-power rifle for sustained engagements.',
    mods: [flat('attack', 18), increased('damage', 0.1)] },
  { id: 'marksman-rifle', slot: 'weapon', name: 'Marksman Rifle', minLevel: 10, price: 5000,
    blurb: 'Precision at range. Every shot counts double when it lands right.',
    mods: [flat('attack', 26), flat('critChance', 0.08), flat('critDamage', 0.25)] },
  { id: 'light-machine-gun', slot: 'weapon', name: 'Light Machine Gun', minLevel: 14, price: 12000,
    blurb: 'Suppressive fire that turns firefights decisively.',
    mods: [flat('attack', 40), more('damage', 0.15)] },

  // Body armour: the main source of armour.
  { id: 'flak-vest', slot: 'body', name: 'Flak Vest', minLevel: 1, price: 120,
    blurb: 'Stops fragments. Mostly.',
    mods: [flat('armor', 10)] },
  { id: 'plate-carrier', slot: 'body', name: 'Plate Carrier', minLevel: 4, price: 800,
    blurb: 'Steel plates front and back.',
    mods: [flat('armor', 25)] },
  { id: 'composite-armour', slot: 'body', name: 'Composite Armour', minLevel: 8, price: 3000,
    blurb: 'Ceramic composite that spreads the impact.',
    mods: [flat('armor', 45)] },
  { id: 'heavy-assault-plate', slot: 'body', name: 'Heavy Assault Plate', minLevel: 12, price: 9000,
    blurb: 'Breacher-grade protection with a weight to match.',
    mods: [flat('armor', 70), increased('armor', 0.1)] },

  // Helmets: a little armour plus utility.
  { id: 'combat-helmet', slot: 'helmet', name: 'Combat Helmet', minLevel: 2, price: 250,
    blurb: 'Kevlar shell with a chin strap that actually works.',
    mods: [flat('armor', 6)] },
  { id: 'ballistic-helmet', slot: 'helmet', name: 'Ballistic Helmet', minLevel: 7, price: 1500,
    blurb: 'High-cut helmet rated against rifle rounds.',
    mods: [flat('armor', 14), flat('critChance', 0.02)] },
  { id: 'night-vision-helmet', slot: 'helmet', name: 'Night Vision Helmet', minLevel: 11, price: 6000,
    blurb: 'Own the dark. See them before they see you.',
    mods: [flat('armor', 18), flat('critChance', 0.05)] },

  // Tactical kit: damage multipliers and crits.
  { id: 'red-dot-sight', slot: 'kit', name: 'Red Dot Sight', minLevel: 2, price: 400,
    blurb: 'Faster target acquisition, tighter groups.',
    mods: [increased('damage', 0.08)] },
  { id: 'suppressor', slot: 'kit', name: 'Suppressor', minLevel: 5, price: 1200,
    blurb: 'They won’t know where it came from.',
    mods: [flat('critChance', 0.05), increased('damage', 0.05)] },
  { id: 'rangefinder', slot: 'kit', name: 'Tactical Rangefinder', minLevel: 9, price: 4000,
    blurb: 'Laser ranging and ballistic correction on demand.',
    mods: [more('damage', 0.1), flat('critDamage', 0.2)] },
];

const ITEMS_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** Modifiers from a set of equipped item ids, tagged with their source. */
function modifiersFor(itemIds) {
  const mods = [];
  for (const id of itemIds) {
    const item = ITEMS_BY_ID.get(id);
    if (!item) continue;
    for (const m of item.mods) mods.push({ ...m, source: item.name });
  }
  return mods;
}

module.exports = { ITEMS, ITEMS_BY_ID, SLOTS, modifiersFor };
