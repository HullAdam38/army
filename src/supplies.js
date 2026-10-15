'use strict';

/**
 * Supplies: consumables sold in the Armory from level 15. They turn spare cash
 * into a little progress or an edge, with hard limits so money can't buy
 * unlimited advantage. Pure rules.
 */

const SUPPLIES = [
  {
    id: 'adrenaline',
    name: 'Adrenaline Shot',
    blurb: 'Instantly restores 30 energy, up to your maximum. One every 20 hours.',
    minLevel: 15,
    price: 2500,
    energy: 30,
    cooldownMs: 20 * 60 * 60 * 1000,
  },
  {
    id: 'stim',
    name: 'Combat Stim',
    blurb: '+15% damage in your next attack. One at a time; it’s used up when you attack.',
    minLevel: 15,
    price: 3000,
    damage: 0.15,
  },
];

const SUPPLIES_BY_ID = new Map(SUPPLIES.map((s) => [s.id, s]));

/** Why `player` can't buy `supply` now, or null. */
function buyBlocker(supply, player, now = Date.now()) {
  if (player.level < supply.minLevel) return `Unlocks at level ${supply.minLevel}`;
  if (player.cash < supply.price) return `Costs $${supply.price.toLocaleString('en-US')}`;
  if (supply.id === 'adrenaline') {
    if (player.adrenaline_at && now - player.adrenaline_at < supply.cooldownMs) {
      const hours = Math.ceil((supply.cooldownMs - (now - player.adrenaline_at)) / 3_600_000);
      return `Available again in ${hours}h`;
    }
    if (player.energy >= player.max_energy) return 'Your energy is already full';
  }
  if (supply.id === 'stim' && player.stim_loaded) return 'You already have a stim ready';
  return null;
}

/** Applies a purchase to a (regenerated) player copy. Returns { player, note }. */
function use(supply, player, now = Date.now()) {
  const p = { ...player, cash: player.cash - supply.price };
  if (supply.id === 'adrenaline') {
    const gained = Math.min(supply.energy, p.max_energy - p.energy);
    if (p.energy >= p.max_energy - gained) p.energy_updated_at = now; // full: regen clock restarts
    p.energy += gained;
    p.adrenaline_at = now;
    return { player: p, note: `+${gained} energy` };
  }
  p.stim_loaded = 1;
  return { player: p, note: 'stim ready for your next attack' };
}

/** Combat stats with a loaded stim applied (more damage). */
const withStim = (stats) => ({ ...stats, damage: stats.damage * (1 + SUPPLIES_BY_ID.get('stim').damage) });

module.exports = { SUPPLIES, SUPPLIES_BY_ID, buyBlocker, use, withStim };
