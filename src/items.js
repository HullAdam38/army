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
  // Campaigns 4–6: health grows steadily with level, so offence grows gently to keep
  // PvP fights at about 3–4 hits all the way to level 100 (see test/endgame.test.js).
  { id: 'gauss-rifle', slot: 'weapon', name: 'Gauss Rifle', minLevel: 53, price: 580000,
    blurb: 'Coil-driven slugs at three times the speed of sound.',
    mods: [flat('attack', 143), flat('critChance', 0.14), more('damage', 0.2)] },
  { id: 'plasma-lance', slot: 'weapon', name: 'Plasma Lance', minLevel: 61, price: 820000,
    blurb: 'A rifle that fires a bolt of the sun.',
    mods: [flat('attack', 151), flat('critChance', 0.14), more('damage', 0.2)] },
  { id: 'arc-cannon', slot: 'weapon', name: 'Arc Cannon', minLevel: 68, price: 1050000,
    blurb: 'Chains lightning from one target to the next.',
    mods: [flat('attack', 159), flat('critChance', 0.14), more('damage', 0.2)] },
  { id: 'singularity-rifle', slot: 'weapon', name: 'Singularity Rifle', minLevel: 77, price: 1450000,
    blurb: 'Nobody is quite sure how it works. It works.',
    mods: [flat('attack', 167), flat('critChance', 0.14), more('damage', 0.2)] },
  { id: 'ion-annihilator', slot: 'weapon', name: 'Ion Annihilator', minLevel: 84, price: 1800000,
    blurb: 'Strips armour and shields in a single pulse.',
    mods: [flat('attack', 175), flat('critChance', 0.14), more('damage', 0.2)] },
  { id: 'the-last-word', slot: 'weapon', name: 'The Last Word', minLevel: 96, price: 2550000,
    blurb: 'The final weapon of the war, and the reason it ends.',
    mods: [flat('attack', 183), flat('critChance', 0.14), more('damage', 0.2)] },

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
  { id: 'aegis-plate', slot: 'body', name: 'Aegis Plate', minLevel: 52, price: 550000,
    blurb: 'Layered alloy that spreads every impact across the whole suit.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 29)] },
  { id: 'phase-shell', slot: 'body', name: 'Phase-Shift Shell', minLevel: 60, price: 790000,
    blurb: 'Flickers half out of phase when something hits it.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 33)] },
  { id: 'titan-frame', slot: 'body', name: 'Titan Frame', minLevel: 66, price: 1000000,
    blurb: 'A walking tank with you at the controls.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 37)] },
  { id: 'ghostweave', slot: 'body', name: 'Ghostweave Armour', minLevel: 75, price: 1350000,
    blurb: 'Light, silent, and nearly impossible to see.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 41)] },
  { id: 'bastion-suit', slot: 'body', name: 'Bastion Suit', minLevel: 82, price: 1700000,
    blurb: 'Built to hold a breach alone.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 45)] },
  { id: 'eternal-plate', slot: 'body', name: 'Eternal Plate', minLevel: 94, price: 2400000,
    blurb: 'Self-repairing armour that outlasts the soldier inside.',
    mods: [flat('armor', 150), increased('armor', 0.2), flat('attack', 49)] },

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
  { id: 'oracle-visor', slot: 'helmet', name: 'Oracle Visor', minLevel: 54, price: 600000,
    blurb: 'Predicts where the enemy will be a heartbeat early.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.33)] },
  { id: 'warlord-helm', slot: 'helmet', name: 'Warlord Helm', minLevel: 62, price: 850000,
    blurb: 'Command uplink for an entire battalion.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.36)] },
  { id: 'seer-helm', slot: 'helmet', name: 'Seer Helm', minLevel: 70, price: 1150000,
    blurb: 'Sees through walls, smoke and lies.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.39)] },
  { id: 'overmind-crown', slot: 'helmet', name: 'Overmind Crown', minLevel: 78, price: 1500000,
    blurb: 'Links your mind to every drone on the field.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.42)] },
  { id: 'prophet-visor', slot: 'helmet', name: 'Prophet Visor', minLevel: 86, price: 1950000,
    blurb: 'Shows three futures and lets you pick one.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.45)] },
  { id: 'sovereign-helm', slot: 'helmet', name: 'Sovereign Helm', minLevel: 98, price: 2700000,
    blurb: 'Worn by whoever ends the war.',
    mods: [flat('armor', 36), flat('critChance', 0.12), flat('critDamage', 0.48)] },

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
  { id: 'orbital-beacon', slot: 'kit', name: 'Orbital Strike Beacon', minLevel: 56, price: 660000,
    blurb: 'One button. Very large result.',
    mods: [more('damage', 0.31), flat('critChance', 0.08)] },
  { id: 'cloak-module', slot: 'kit', name: 'Optical Cloak Module', minLevel: 63, price: 890000,
    blurb: 'Bends light around you. Strike first, every time.',
    mods: [more('damage', 0.32), flat('critChance', 0.08)] },
  { id: 'storm-array', slot: 'kit', name: 'Storm Array', minLevel: 72, price: 1250000,
    blurb: 'Calls down an electrical storm on a grid square.',
    mods: [more('damage', 0.33), flat('critChance', 0.08)] },
  { id: 'hunter-killer', slot: 'kit', name: 'Hunter-Killer Swarm', minLevel: 79, price: 1550000,
    blurb: 'A thousand smart rounds that never miss twice.',
    mods: [more('damage', 0.34), flat('critChance', 0.08)] },
  { id: 'kinetic-rods', slot: 'kit', name: 'Kinetic Rod Uplink', minLevel: 88, price: 2050000,
    blurb: 'Tungsten rods dropped from orbit.',
    mods: [more('damage', 0.35), flat('critChance', 0.08)] },
  { id: 'genesis-core', slot: 'kit', name: 'Genesis Core', minLevel: 97, price: 2600000,
    blurb: 'The war machine’s heart, rewired for your side.',
    mods: [more('damage', 0.36), flat('critChance', 0.08)] },
];

const ITEMS_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** Modifiers from a set of equipped item ids, tagged with their source. */
/** Modifiers from the given items. `conditions` (item id → 0–100) weakens worn gear (see src/gear.js). */
function modifiersFor(itemIds, conditions = null) {
  const { scaledMods } = require('./gear'); // required here: gear.js reads this module's catalogue
  const mods = [];
  for (const id of itemIds) {
    const item = ITEMS_BY_ID.get(id);
    if (!item) continue;
    const condition = conditions && conditions.has(id) ? conditions.get(id) : 100;
    for (const m of scaledMods(item, condition)) mods.push({ ...m, source: item.name });
  }
  return mods;
}

module.exports = { ITEMS, ITEMS_BY_ID, SLOTS, modifiersFor };
