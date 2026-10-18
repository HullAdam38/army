'use strict';

/**
 * Reserve soldiers: players run by the game so a young world doesn't feel
 * empty. Pure rules: names, starting levels, gear, how fast they progress and
 * how many there should be. Every reserve soldier is marked "Reserve" wherever
 * players see them, can't sign in or chat, and stands down as real players
 * arrive (one for every real player active in the last week).
 */

const game = require('./game');
const { ITEMS, SLOTS } = require('./items');

const FIRST = ['Iron', 'Ghost', 'Steel', 'Red', 'Night', 'Storm', 'Desert', 'Black', 'Silver', 'Arctic', 'Thunder', 'Shadow', 'Rapid', 'Grey', 'Copper', 'Stone', 'Granite', 'Delta', 'Echo', 'Sierra'];
const SECOND = ['Fox', 'Wolf', 'Hawk', 'Raven', 'Cobra', 'Bear', 'Falcon', 'Lynx', 'Badger', 'Jackal', 'Eagle', 'Mamba', 'Bison', 'Otter', 'Puma', 'Heron', 'Viper', 'Hound', 'Kite', 'Ram'];
/** Every callsign a reserve soldier can have (400), in a fixed shuffled order. */
const NAMES = (() => {
  const all = FIRST.flatMap((a) => SECOND.map((b) => `${a}${b}`));
  // A fixed shuffle (not Math.random) so the order is the same on every server.
  let seed = 7;
  for (let i = all.length - 1; i > 0; i -= 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
})();

// The HQ-run starter units: always recruiting, applications accepted at once.
const HQ_UNITS = [
  { name: 'Iron Vanguard', tag: 'IVG', description: 'An HQ starter unit. Applications are accepted straight away. Once three real soldiers serve here, command passes to the most senior of them.' },
  { name: 'Desert Rangers', tag: 'DRG', description: 'An HQ starter unit. Applications are accepted straight away. Once three real soldiers serve here, command passes to the most senior of them.' },
  { name: 'Northern Watch', tag: 'NWT', description: 'An HQ starter unit. Applications are accepted straight away. Once three real soldiers serve here, command passes to the most senior of them.' },
];
const HQ_MEMBERS = 3; // reserve soldiers in each starter unit, the Commander included
const HQ_HANDOVER_AT = 3; // real members needed before command passes to them

const TICK_MS = 10 * 60 * 1000;
const ACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // a real player counts as active for this long
const PLAY_CHANCE = 0.25; // × pace: the chance a reserve soldier is "on" in a tick

/** How many reserve soldiers there should be with `realActive` real players about. */
const wanted = (target, realActive) => Math.max(0, target - realActive);

/** Starting level for the i-th of n new soldiers: mostly low, a few seasoned ones (3 to about 25). */
const startLevel = (i, n) => 3 + Math.floor(22 * Math.pow(i / Math.max(1, n - 1), 1.7));

/** A pace between 0.4 and 1.4: how often they play and how fast they climb. */
const pace = (rng) => Math.round((0.4 + rng()) * 100) / 100;

/** The best item in each slot a soldier a level below `level` could use. */
function gearFor(level) {
  const out = {};
  for (const slot of SLOTS) {
    const usable = ITEMS.filter((i) => i.slot === slot.id && i.minLevel <= Math.max(1, level - 1));
    if (usable.length) out[slot.id] = usable.reduce((a, b) => (b.minLevel > a.minLevel ? b : a)).id;
  }
  return out;
}

/** Trained stats for a soldier at `level`: about 1.5 points a level, spread at random. */
function trainedStats(level, rng) {
  const total = Math.round(level * 1.5);
  const w = [rng() + 0.5, rng() + 0.5, rng() + 0.5];
  const sum = w[0] + w[1] + w[2];
  const str = Math.floor((total * w[0]) / sum);
  const agi = Math.floor((total * w[1]) / sum);
  return { stat_str: str, stat_agi: agi, stat_end: total - str - agi };
}

/** XP earned in one tick of play: a share of the level, slower as they climb. */
const xpPerPlay = (level, p, rng) => Math.round(game.xpToNext(level) * ((0.015 * p) / (1 + level / 10)) * (0.5 + rng()));

/** Cash a soldier keeps on hand (so there's something to take in a fight). */
const cashTarget = (level) => 200 + level * 150;

module.exports = { ACTIVE_MS, HQ_HANDOVER_AT, HQ_MEMBERS, HQ_UNITS, NAMES, PLAY_CHANCE, TICK_MS, cashTarget, gearFor, pace, startLevel, trainedStats, wanted, xpPerPlay };
