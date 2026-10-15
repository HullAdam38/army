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
  'bot-like': 'Bot-like activity',
  'unusual-gains': 'Unusual gains',
};

const LINK_WINDOW_MS = 30 * DAY; // sign-ins this recent count when linking accounts
const SIGN_IN_RETENTION_MS = 90 * DAY; // older sign-in records are deleted
const FARMING_WINDOW_MS = 48 * HOUR;
const DIMINISHING_WINDOW_MS = 24 * HOUR;
const ACTION_RETENTION_MS = 14 * DAY; // per-action timing records are kept two weeks
const ACTIVITY_WINDOW_MS = 24 * HOUR; // bot and gains checks look at the last day

// Bot detection thresholds.
const SESSION_GAP_MS = 30 * 60 * 1000; // a gap longer than this is a break, not "between clicks"
const MIN_GAPS_FOR_TIMING = 30; // need this many in-session gaps before judging rhythm
const ROBOTIC_VARIATION = 0.1; // humans vary their pace a lot; scripts with fixed sleeps don't
const FAST_GAP_MS = 400; // quicker than a person can click, read and click again
const MIN_FAST_GAPS = 25;
const NO_BREAK_HOURS = 20; // active in this many of the last 24 hours

// Unusual gains thresholds.
const MIN_PEERS = 5; // need this many similar-level players to compare against
const PEER_LEVEL_RANGE = 2;
const OUTLIER_MULTIPLE = 4; // flag when gains exceed 4× the peer median
const OUTLIER_FLOOR = { xp: 500, cash: 2000 }; // …and are big enough to matter
const CAP_MARGIN = 1.1; // allowance on top of the theoretical maximum

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

/** Mean, standard deviation and coefficient of variation of a list of numbers. */
function spread(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0, cv: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return { mean, sd, cv: mean ? sd / mean : 0 };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Looks at one player's action timestamps (ms, any order) over the last day.
 * Returns { severity, reasons, metrics } if it looks automated, else null.
 */
function botVerdict(timestamps) {
  const t = [...timestamps].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < t.length; i += 1) {
    const gap = t[i] - t[i - 1];
    if (gap <= SESSION_GAP_MS) gaps.push(gap);
  }
  const { mean, cv } = spread(gaps);
  const fastGaps = gaps.filter((g) => g < FAST_GAP_MS).length;
  const activeHours = new Set(t.map((ms) => Math.floor(ms / HOUR))).size;
  const metrics = {
    actions: t.length,
    activeHours,
    averageGapSeconds: Math.round(mean / 100) / 10,
    variationPct: Math.round(cv * 100),
    fastGaps,
  };

  const findings = [];
  if (gaps.length >= MIN_GAPS_FOR_TIMING && cv < ROBOTIC_VARIATION) {
    findings.push({
      severity: cv < 0.03 ? 3 : 2,
      reason: `actions at near-identical intervals (every ~${metrics.averageGapSeconds}s, only ${metrics.variationPct}% variation)`,
    });
  }
  if (activeHours >= NO_BREAK_HOURS) {
    findings.push({ severity: activeHours >= 23 ? 3 : 2, reason: `active in ${activeHours} of the last 24 hours` });
  }
  if (fastGaps >= MIN_FAST_GAPS) {
    findings.push({ severity: 2, reason: `${fastGaps} actions less than ${FAST_GAP_MS}ms apart` });
  }
  if (!findings.length) return null;
  // Several independent signs together are much stronger evidence than one.
  const severity = Math.min(3, Math.max(...findings.map((f) => f.severity)) + (findings.length > 1 ? 1 : 0));
  return { severity, reasons: findings.map((f) => f.reason), metrics };
}

/**
 * Most mission cash a player could earn in a day: all the energy they could
 * have had, spent on the best-paying mission they can access, all succeeding.
 * `refills` counts full energy refills (promotions, admin restores).
 */
function missionCashCap({ missions, level, maxEnergy, refills, windowMs = ACTIVITY_WINDOW_MS, energyRegenMs, cashMult = 1 }) {
  const best = Math.max(...missions.filter((m) => m.minLevel <= level).map((m) => m.cash[1] / m.energy));
  const energy = Math.floor(windowMs / energyRegenMs) + maxEnergy * (1 + refills);
  return Math.ceil(energy * best * cashMult * CAP_MARGIN); // cashMult: rank perks and Payday events
}

/**
 * Compares one player's gains with similar-level players'. `peers` is a list
 * of the same metric for other players. Returns { median, multiple } if it's an
 * outlier, else null.
 */
function gainsOutlier(value, peers, metric) {
  if (peers.length < MIN_PEERS || value < OUTLIER_FLOOR[metric]) return null;
  const m = median(peers);
  if (m <= 0) return null;
  const multiple = value / m;
  return multiple >= OUTLIER_MULTIPLE ? { median: Math.round(m), multiple: Math.round(multiple * 10) / 10 } : null;
}

module.exports = {
  ACTION_RETENTION_MS,
  ACTIVITY_WINDOW_MS,
  PEER_LEVEL_RANGE,
  botVerdict,
  gainsOutlier,
  median,
  missionCashCap,
  spread,
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
