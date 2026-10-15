'use strict';

/**
 * Rank perks: small permanent bonuses that arrive with officer ranks, so each
 * promotion past level 17 means something. Pure rules. All are economic
 * (pay, XP, costs), never combat, so PvP balance doesn't depend on rank.
 */

const PERKS = [
  { level: 17, rank: 'Second Lieutenant', key: 'missionCash', value: 0.05, text: '+5% mission pay' },
  { level: 21, rank: 'Captain', key: 'missionXp', value: 0.05, text: '+5% mission XP' },
  { level: 23, rank: 'Major', key: 'hospitalDiscount', value: 0.25, text: '25% off hospital treatment' },
  { level: 27, rank: 'Colonel', key: 'missionCash', value: 0.05, text: 'another +5% mission pay' },
  { level: 29, rank: 'Brigadier General', key: 'missionXp', value: 0.05, text: 'another +5% mission XP' },
  { level: 35, rank: 'General', key: 'supplyDrop', value: 0.5, text: 'supply drops pay 50% more' },
];

const MAX_CASH_BONUS = PERKS.filter((p) => p.key === 'missionCash').reduce((n, p) => n + p.value, 0);

/** Totals of every perk unlocked at `level`. */
function perksFor(level) {
  const out = { missionCash: 0, missionXp: 0, hospitalDiscount: 0, supplyDrop: 0 };
  for (const p of PERKS) if (level >= p.level) out[p.key] += p.value;
  return out;
}

/** Perks unlocked at `level`, for display. */
const unlocked = (level) => PERKS.filter((p) => level >= p.level);
/** The next perk still to come, or null. */
const nextPerk = (level) => PERKS.find((p) => p.level > level) || null;
/** Perks that arrive exactly at `level` (for promotion notifications). */
const perksAt = (level) => PERKS.filter((p) => p.level === level);

module.exports = { MAX_CASH_BONUS, PERKS, nextPerk, perksAt, perksFor, unlocked };
