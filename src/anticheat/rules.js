'use strict';

/**
 * Pure anti-cheat rules: thresholds and verdicts with no database access, so
 * they're easy to test and tune. Severity: 1 = low, 2 = medium, 3 = high.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SEVERITY = { 1: 'low', 2: 'medium', 3: 'high' };

const RULES = {
  'linked-device': 'Accounts share a device',
  'linked-network': 'Accounts share a network',
  'pvp-farming': 'PvP farming',
  'ledger-mismatch': 'Balance doesn’t match money history',
  'unknown-money': 'Money changed without a known reason',
  'impossible-payout': 'Payout larger than the game allows',
};

const LINK_WINDOW_MS = 30 * DAY; // sign-ins this recent count when linking accounts
const SIGN_IN_RETENTION_MS = 90 * DAY; // older sign-in records are deleted
const FARMING_WINDOW_MS = 48 * HOUR;
const DIMINISHING_WINDOW_MS = 24 * HOUR;

/**
 * Share of PvP rewards an attacker gets for beating the same defender again
 * within 24 hours: wins 1–2 full, wins 3–4 half, 5th onwards nothing.
 */
function repeatWinFactor(priorWinsToday) {
  if (priorWinsToday >= 4) return 0;
  if (priorWinsToday >= 2) return 0.5;
  return 1;
}

/**
 * Reward multipliers for one attack. Linked accounts (same device) get no
 * rewards either way, so alts can't feed a main or trade defence wins.
 */
function pvpRewardPlan({ linkedDevice, priorWinsToday }) {
  if (linkedDevice) {
    return { attacker: 0, defender: 0, note: 'No rewards: these accounts have been used on the same device.' };
  }
  const factor = repeatWinFactor(priorWinsToday);
  if (factor === 1) return { attacker: 1, defender: 1, note: null };
  const nth = priorWinsToday + 1;
  return {
    attacker: factor,
    defender: 1,
    note: factor === 0
      ? `No rewards: win #${nth} against this player in 24 hours.`
      : `Half rewards: win #${nth} against this player in 24 hours.`,
  };
}

/**
 * Verdict for one attacker→defender pair over the farming window, or null.
 * `stats`: { attacks, attackerWins, cashTaken, reverseAttacks, linkedDevice, linkedNetwork }.
 */
function farmingVerdict(stats) {
  const { attacks, attackerWins, reverseAttacks, linkedDevice, linkedNetwork } = stats;
  const oneSided = attacks > 0 && attackerWins / attacks >= 0.8 && reverseAttacks === 0;
  if (linkedDevice && attacks >= 3) return { severity: 3, why: 'repeated attacks between accounts on the same device' };
  if (oneSided && attacks >= 6 && linkedNetwork) return { severity: 3, why: 'one-sided repeated attacks between accounts on the same network' };
  if (oneSided && attacks >= 8) return { severity: 2, why: 'one-sided repeated attacks; the defender never fights back' };
  return null;
}

module.exports = {
  DAY,
  DIMINISHING_WINDOW_MS,
  FARMING_WINDOW_MS,
  HOUR,
  LINK_WINDOW_MS,
  RULES,
  SEVERITY,
  SIGN_IN_RETENTION_MS,
  farmingVerdict,
  pvpRewardPlan,
  repeatWinFactor,
};
