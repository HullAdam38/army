'use strict';

/**
 * Combat engine shared by missions today and PvP later.
 *
 * Every bonus in the game — gear, level, and later training, buffs, perks — is
 * expressed as a *modifier* on a stat:
 *
 *   { stat: 'damage', kind: 'increased', value: 0.10, source: 'Assault Rifle' }
 *
 * Modifier kinds combine like this (the familiar "increased vs more" model):
 *
 *   final = (base + Σ flat) × (1 + Σ increased) × Π (1 + more)
 *
 * - flat:      added to the base value            (+12 attack)
 * - increased: summed together, then applied once (+10% and +15% → ×1.25)
 * - more:      each one multiplies separately     (×1.10 and ×1.20 → ×1.32)
 *
 * So "increased" bonuses stack gently while "more" bonuses compound; keep
 * "more" for rare, high-value sources so damage stays controllable in PvP.
 */

const MODIFIER_KINDS = ['flat', 'increased', 'more'];

const STATS = {
  attack: {
    label: 'Attack',
    base: (level) => 10 + 2 * (level - 1),
  },
  damage: {
    // Pure multiplier on outgoing damage; base 1 means ×1.00.
    label: 'Damage multiplier',
    base: () => 1,
  },
  critChance: {
    label: 'Critical chance',
    base: () => 0.05,
    max: 0.5,
  },
  critDamage: {
    label: 'Critical damage',
    base: () => 1.5,
  },
  armor: {
    label: 'Armour',
    base: () => 0,
  },
};

/** Armour gives diminishing returns: 100 armour halves damage, capped at 75%. */
const ARMOR_CONSTANT = 100;
const MAX_MITIGATION = 0.75;
const DAMAGE_VARIANCE = 0.1; // each hit rolls ±10%

/**
 * Global multipliers per combat context. Tune PvP separately from missions
 * without touching any item: e.g. pvp: 0.6 makes player fights last longer.
 */
const CONTEXT_MULTIPLIERS = {
  mission: 1,
  pvp: 1,
};

/** Builds final stats from a level and a list of modifiers. */
function buildStats(level, modifiers = []) {
  const stats = {};
  for (const [name, def] of Object.entries(STATS)) {
    let flat = 0;
    let increased = 0;
    let more = 1;
    for (const m of modifiers) {
      if (m.stat !== name) continue;
      if (m.kind === 'flat') flat += m.value;
      else if (m.kind === 'increased') increased += m.value;
      else if (m.kind === 'more') more *= 1 + m.value;
    }
    let value = (def.base(level) + flat) * Math.max(0, 1 + increased) * more;
    if (def.max !== undefined) value = Math.min(def.max, value);
    stats[name] = Math.max(0, value);
  }
  return stats;
}

function mitigation(armor) {
  return Math.min(MAX_MITIGATION, armor / (armor + ARMOR_CONSTANT));
}

/** Average damage per hit before the target's armour, counting crits. */
function expectedDamage(stats) {
  return stats.attack * stats.damage * (1 + stats.critChance * (stats.critDamage - 1));
}

/**
 * A single number for comparing loadouts: offence scaled by how much
 * incoming damage you shrug off. Shown to players and used for matchmaking.
 */
function combatRating(stats) {
  return Math.round(expectedDamage(stats) / (1 - mitigation(stats.armor)));
}

/**
 * Resolves one hit. `attacker` and `defender` are stats from buildStats.
 * Returns { damage, crit, mitigated }.
 */
function rollHit(attacker, defender, { rng = Math.random, context = 'pvp' } = {}) {
  const variance = 1 + (rng() * 2 - 1) * DAMAGE_VARIANCE;
  const crit = rng() < attacker.critChance;
  const raw = attacker.attack * attacker.damage * variance * (crit ? attacker.critDamage : 1);
  const reduced = raw * (1 - mitigation(defender.armor)) * (CONTEXT_MULTIPLIERS[context] ?? 1);
  const damage = Math.max(1, Math.round(reduced));
  return { damage, crit, mitigated: Math.round(raw - reduced) };
}

const MODIFIER_NOUNS = {
  attack: 'attack',
  damage: 'damage',
  critChance: 'crit chance',
  critDamage: 'crit damage',
  armor: 'armour',
};
// Flat values for these stats are fractions (0.05 = 5%), so show them as percentages.
const PERCENT_STATS = new Set(['critChance', 'critDamage']);

/** Human-readable text for a modifier, e.g. "+12 attack", "+15% damage", "×1.10 damage". */
function describeModifier(m) {
  const noun = MODIFIER_NOUNS[m.stat] || m.stat;
  const sign = m.value < 0 ? '−' : '+';
  const abs = Math.abs(m.value);
  if (m.kind === 'more') return `×${(1 + m.value).toFixed(2)} ${noun}`;
  if (m.kind === 'increased' || PERCENT_STATS.has(m.stat)) return `${sign}${Math.round(abs * 100)}% ${noun}`;
  return `${sign}${abs} ${noun}`;
}

module.exports = {
  ARMOR_CONSTANT,
  CONTEXT_MULTIPLIERS,
  MAX_MITIGATION,
  MODIFIER_KINDS,
  STATS,
  buildStats,
  combatRating,
  describeModifier,
  expectedDamage,
  mitigation,
  rollHit,
};
