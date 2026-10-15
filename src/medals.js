'use strict';

/**
 * Medals. Pure rules: each medal tracks one career metric and has bronze,
 * silver and gold thresholds. Every tier pays a one-off reward. Metrics come
 * from records that anti-cheat already protects (e.g. only PvP wins that paid
 * XP count, so fights against linked accounts earn nothing).
 */

const TIERS = [
  { tier: 1, key: 'bronze', label: 'Bronze', xp: 50, cash: 250 },
  { tier: 2, key: 'silver', label: 'Silver', xp: 150, cash: 1000 },
  { tier: 3, key: 'gold', label: 'Gold', xp: 400, cash: 5000 },
];

const MAX_PINNED = 3;

const MEDALS = [
  { id: 'operator', name: 'Field Operator', icon: 'i-target', metric: 'missions', unit: 'missions won', thresholds: [25, 100, 500], blurb: 'Win missions.' },
  { id: 'combat', name: 'Combat Medal', icon: 'i-weapon', metric: 'pvpWins', unit: 'PvP wins', thresholds: [10, 50, 200], blurb: 'Win PvP fights as the attacker. Wins that paid no XP don’t count.' },
  { id: 'knockout', name: 'Knockout Artist', icon: 'i-health', metric: 'knockouts', unit: 'knockouts', thresholds: [5, 25, 100], blurb: 'Knock opponents out, attacking or defending.' },
  { id: 'ironwall', name: 'Iron Wall', icon: 'i-body', metric: 'defenses', unit: 'attacks held off', thresholds: [5, 25, 100], blurb: 'Hold off attackers.' },
  { id: 'drill', name: 'Drill Instructor', icon: 'i-chevrons', metric: 'training', unit: 'training points', thresholds: [30, 150, 500], blurb: 'Train Strength, Agility and Endurance.' },
  { id: 'service', name: 'Long Service', icon: 'i-kit', metric: 'streak', unit: 'day best streak', thresholds: [7, 30, 90], blurb: 'Collect supply drops on consecutive days.' },
  { id: 'merit', name: 'Order of Merit', icon: 'i-star', metric: 'orders', unit: 'daily orders', thresholds: [15, 60, 250], blurb: 'Complete and claim daily orders.' },
  { id: 'commission', name: 'Commission', icon: 'i-crest', metric: 'level', unit: 'level', thresholds: [10, 20, 35], blurb: 'Rise through the ranks.' },
  { id: 'warhero', name: 'War Hero', icon: 'i-flag', metric: 'warPoints', unit: 'war points', thresholds: [10, 50, 200], blurb: 'Score points for your unit in wars.' },
  { id: 'hunter', name: 'Bounty Hunter', icon: 'i-cash', metric: 'bounties', unit: 'bounties collected', thresholds: [1, 10, 50], blurb: 'Beat wanted soldiers and collect the bounties on them.' },
  { id: 'architect', name: 'Architect', icon: 'i-crest', metric: 'base', unit: 'base rating', thresholds: [5, 15, 28], blurb: 'Upgrade the facilities of your forward base.' },
  { id: 'victory', name: 'Victory Medal', icon: 'i-helmet', metric: 'warsWon', unit: 'wars won', thresholds: [1, 5, 20], blurb: 'Win unit wars. You must be in the unit when the war begins.' },
];

const MEDALS_BY_ID = new Map(MEDALS.map((m) => [m.id, m]));

/** Highest tier (0–3) that `value` reaches on `medal`. */
function tierFor(medal, value) {
  let t = 0;
  for (let i = 0; i < medal.thresholds.length; i += 1) if (value >= medal.thresholds[i]) t = i + 1;
  return t;
}

/** Tiers earned by `metrics` that aren't in `owned` (a Map of medal id → highest tier held). */
function newTiers(metrics, owned) {
  const out = [];
  for (const medal of MEDALS) {
    const have = owned.get(medal.id) || 0;
    const reach = tierFor(medal, metrics[medal.metric] || 0);
    for (let t = have + 1; t <= reach; t += 1) out.push({ medal, tier: TIERS[t - 1] });
  }
  return out;
}

/** Display data for one medal: current tier, progress to the next. */
function medalView(medal, value, tier) {
  const next = tier < 3 ? medal.thresholds[tier] : null;
  const prev = tier > 0 ? medal.thresholds[tier - 1] : 0;
  return {
    ...medal,
    value,
    tier,
    tierKey: tier ? TIERS[tier - 1].key : null,
    tierLabel: tier ? TIERS[tier - 1].label : null,
    next,
    nextLabel: next ? TIERS[tier].label : null,
    pct: next ? Math.max(0, Math.min(100, Math.round(((value - prev) / (next - prev)) * 100))) : 100,
  };
}

/** Cleans a list of medal ids to pin: known, held, unique, at most MAX_PINNED. */
function parsePins(ids, owned) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => MEDALS_BY_ID.has(id) && (owned.get(id) || 0) > 0);
  return [...new Set(list)].slice(0, MAX_PINNED);
}

module.exports = { MAX_PINNED, MEDALS, MEDALS_BY_ID, TIERS, medalView, newTiers, parsePins, tierFor };
