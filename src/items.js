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
  // Forward-operations tier (levels 15+).
  { id: 'battle-rifle', slot: 'weapon', name: 'Battle Rifle', minLevel: 17, price: 22000,
    blurb: 'Full-calibre rifle that punches through cover.',
    mods: [flat('attack', 52), flat('critChance', 0.04), increased('damage', 0.1)] },
  { id: 'anti-materiel-rifle', slot: 'weapon', name: 'Anti-Materiel Rifle', minLevel: 22, price: 45000,
    blurb: 'Built for engines and walls. Overkill for everything else.',
    mods: [flat('attack', 64), flat('critChance', 0.1), flat('critDamage', 0.4)] },
  { id: 'gpmg', slot: 'weapon', name: 'General-Purpose MG', minLevel: 28, price: 80000,
    blurb: 'Belt-fed and relentless. Holds a line on its own.',
    mods: [flat('attack', 80), more('damage', 0.2)] },
  { id: 'smart-rifle', slot: 'weapon', name: 'XM Smart Rifle', minLevel: 33, price: 140000,
    blurb: 'Computer-assisted fire control. It doesn’t miss much.',
    mods: [flat('attack', 95), flat('critChance', 0.12), more('damage', 0.15)] },
  { id: 'railgun', slot: 'weapon', name: 'EM Railgun Prototype', minLevel: 38, price: 240000,
    blurb: 'Magnetic rails, no powder. Punches through walls and the people behind them.',
    mods: [flat('attack', 115), flat('critChance', 0.05), more('damage', 0.2)] },
  { id: 'pulse-carbine', slot: 'weapon', name: 'Pulse Carbine', minLevel: 46, price: 420000,
    blurb: 'Directed energy in a carbine frame. Silent, recoilless, terrifying.',
    mods: [flat('attack', 135), flat('critChance', 0.14), more('damage', 0.2)] },

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
  { id: 'ceramic-plate-rig', slot: 'body', name: 'Ceramic Plate Rig', minLevel: 16, price: 18000,
    blurb: 'Multi-hit ceramic plates in a quick-release rig.',
    mods: [flat('armor', 90), increased('armor', 0.1)] },
  { id: 'exo-frame', slot: 'body', name: 'Exo-Frame Armour', minLevel: 23, price: 50000,
    blurb: 'A powered frame carries the weight so you don’t have to.',
    mods: [flat('armor', 110), increased('armor', 0.15)] },
  { id: 'juggernaut-suit', slot: 'body', name: 'Juggernaut Suit', minLevel: 31, price: 110000,
    blurb: 'Bomb-disposal protection rebuilt for the assault.',
    mods: [flat('armor', 135), increased('armor', 0.2)] },
  { id: 'reactive-armour', slot: 'body', name: 'Reactive Armour', minLevel: 37, price: 200000,
    blurb: 'Powered plates that harden on impact and help you carry heavier weapons.',
    // Armour already has steep diminishing returns this high, so the upgrade is mostly offence.
    mods: [flat('armor', 142), increased('armor', 0.2), flat('attack', 12)] },
  { id: 'nano-weave', slot: 'body', name: 'Nano-Weave Suit', minLevel: 45, price: 380000,
    blurb: 'Light as cloth until something hits it; then it’s steel. Servo-assisted.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 25)] },

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
  { id: 'comms-helmet', slot: 'helmet', name: 'Integrated Comms Helmet', minLevel: 19, price: 25000,
    blurb: 'Hearing protection, team radio and a heads-up threat marker.',
    mods: [flat('armor', 24), flat('critChance', 0.06)] },
  { id: 'panoramic-helmet', slot: 'helmet', name: 'Panoramic NVG Helmet', minLevel: 27, price: 60000,
    blurb: 'Four-tube night vision. The night belongs to you.',
    mods: [flat('armor', 30), flat('critChance', 0.08), flat('critDamage', 0.15)] },
  { id: 'hud-helmet', slot: 'helmet', name: 'Tactical HUD Helmet', minLevel: 36, price: 120000,
    blurb: 'Threats, distances and weak points painted onto the world.',
    mods: [flat('armor', 33), flat('critChance', 0.1), flat('critDamage', 0.2)] },
  { id: 'neural-link', slot: 'helmet', name: 'Neural Link Helmet', minLevel: 43, price: 300000,
    blurb: 'Thinks with you. Sees the shot before you do.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.3)] },

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
  { id: 'thermal-scope', slot: 'kit', name: 'Thermal Scope', minLevel: 18, price: 20000,
    blurb: 'Heat signatures through smoke, foliage and darkness.',
    mods: [more('damage', 0.12), flat('critChance', 0.04)] },
  { id: 'drone-uplink', slot: 'kit', name: 'Recon Drone Uplink', minLevel: 25, price: 55000,
    blurb: 'Eyes overhead and targets marked before you move.',
    mods: [more('damage', 0.15), flat('critDamage', 0.3)] },
  { id: 'smart-munitions', slot: 'kit', name: 'Smart Munitions', minLevel: 30, price: 100000,
    blurb: 'Guided rounds that find the gaps in cover.',
    mods: [more('damage', 0.2), flat('critChance', 0.06)] },
  { id: 'sat-designator', slot: 'kit', name: 'Satellite Designator', minLevel: 40, price: 260000,
    blurb: 'Paint a target and something very large arrives from orbit.',
    mods: [more('damage', 0.25), flat('critDamage', 0.35)] },
  { id: 'swarm-drones', slot: 'kit', name: 'Drone Swarm Controller', minLevel: 48, price: 450000,
    blurb: 'A hundred small drones that go where you point.',
    mods: [more('damage', 0.3), flat('critChance', 0.08)] },
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
