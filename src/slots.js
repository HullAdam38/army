'use strict';

/**
 * The slot machine (pure). Three reels, one line, military symbols. Each reel
 * picks a symbol by weight; the paytable below returns about 95% of what's bet
 * over time (see returnToPlayer()), so the casino takes cash out of the game.
 *
 * A spin pays the best of:
 *   three of a kind                        (paytable `three`)
 *   two of a kind from the left (reels 1–2) (paytable `pair`; Stars don't pair)
 *   Stars anywhere: one 1.5×, two 5×
 * Wins are bet × multiplier, rounded down to whole dollars.
 */

const crypto = require('node:crypto');

const SYMBOLS = [
  { id: 'star', name: 'Star', plural: 'Stars', icon: 'i-star', weight: 1, three: 100 },
  { id: 'crest', name: 'Crest', plural: 'Crests', icon: 'i-crest', weight: 2, three: 40, pair: 5 },
  { id: 'cash', name: 'Cash', plural: 'Cash', icon: 'i-cash', weight: 3, three: 20, pair: 3 },
  { id: 'weapon', name: 'Rifle', plural: 'Rifles', icon: 'i-weapon', weight: 4, three: 12, pair: 2 },
  { id: 'helmet', name: 'Helmet', plural: 'Helmets', icon: 'i-helmet', weight: 5, three: 8, pair: 2 },
  { id: 'target', name: 'Target', plural: 'Targets', icon: 'i-target', weight: 6, three: 5, pair: 1.5 },
];
const BY_ID = new Map(SYMBOLS.map((s) => [s.id, s]));
const STARS = { 1: 1.5, 2: 5 }; // Stars anywhere on the line (three Stars is the jackpot above)
const TOTAL_WEIGHT = SYMBOLS.reduce((n, s) => n + s.weight, 0);
const REELS = 3;
const MIN_BET = 10;
const SPIN_COOLDOWN_MS = 800;
const BIG_WIN = 20; // multipliers this high show in "Big wins"

/** One reel's symbol, picked by weight with a cryptographic RNG (`randomInt(max)` → 0…max-1). */
function pickSymbol(randomInt = crypto.randomInt) {
  let roll = randomInt(TOTAL_WEIGHT);
  for (const s of SYMBOLS) {
    if (roll < s.weight) return s.id;
    roll -= s.weight;
  }
  return SYMBOLS.at(-1).id;
}

/** The multiplier for a line of symbol ids, and what made it (for the result text). */
function evaluate(line) {
  const [a, b, c] = line;
  if (a === b && b === c) return { mult: BY_ID.get(a).three, kind: 'three', symbol: a };
  let best = { mult: 0, kind: 'none', symbol: null };
  const stars = line.filter((s) => s === 'star').length;
  if (STARS[stars]) best = { mult: STARS[stars], kind: 'stars', symbol: 'star', count: stars };
  if (a === b && a !== 'star' && BY_ID.get(a).pair > best.mult) best = { mult: BY_ID.get(a).pair, kind: 'pair', symbol: a };
  return best;
}

/** What a bet pays at a multiplier (whole dollars, rounded down). */
const payout = (bet, mult) => Math.floor(bet * mult);

/** Spins the reels. Returns { line, mult, kind, symbol, payout }. */
function spin(bet, randomInt = crypto.randomInt) {
  const line = Array.from({ length: REELS }, () => pickSymbol(randomInt));
  const result = evaluate(line);
  return { line, ...result, payout: payout(bet, result.mult) };
}

/** A short description of a result, e.g. "Three Crests: 40×" or "No win". */
function describe(result) {
  const s = result.symbol && BY_ID.get(result.symbol);
  if (result.kind === 'three') return result.symbol === 'star' ? `JACKPOT! Three Stars: ${result.mult}×` : `Three ${s.plural}: ${result.mult}×`;
  if (result.kind === 'pair') return `Pair of ${s.plural}: ${result.mult}×`;
  if (result.kind === 'stars') return `${result.count === 1 ? 'One Star' : 'Two Stars'}: ${result.mult}×`;
  return 'No win';
}

/**
 * Validates a bet against the player's cash and the table limits.
 * Returns { bet } or { error }.
 */
function checkBet(raw, { cash, maxBet }) {
  const bet = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isInteger(bet) || bet <= 0) return { error: 'Enter a whole-dollar bet.' };
  if (bet < MIN_BET) return { error: `The minimum bet is $${MIN_BET}.` };
  if (bet > maxBet) return { error: `The maximum bet is $${maxBet.toLocaleString('en-US')}.` };
  if (bet > cash) return { error: `You only have $${cash.toLocaleString('en-US')} in cash. Bets come from cash, not the bank.` };
  return { bet };
}

/** Exact return to player and win rates over every possible line (ignoring rounding). */
function returnToPlayer() {
  let rtp = 0;
  let wins = 0;
  let big = 0;
  for (const a of SYMBOLS) for (const b of SYMBOLS) for (const c of SYMBOLS) {
    const p = (a.weight * b.weight * c.weight) / TOTAL_WEIGHT ** 3;
    const { mult } = evaluate([a.id, b.id, c.id]);
    rtp += p * mult;
    if (mult > 1) wins += p;
    if (mult >= BIG_WIN) big += p;
  }
  return { rtp, winRate: wins, bigWinOdds: Math.round(1 / big) };
}

/** The paytable for the page, best first. */
function paytable() {
  return [
    ...SYMBOLS.map((s) => ({ symbols: [s.id, s.id, s.id], label: s.id === 'star' ? 'Three Stars (jackpot)' : `Three ${s.plural}`, mult: s.three })),
    { symbols: ['star', 'star'], label: 'Two Stars, anywhere', mult: STARS[2] },
    ...SYMBOLS.filter((s) => s.pair).map((s) => ({ symbols: [s.id, s.id], label: `Two ${s.plural} from the left`, mult: s.pair })),
    { symbols: ['star'], label: 'One Star, anywhere', mult: STARS[1] },
  ].sort((x, y) => y.mult - x.mult);
}

module.exports = { BIG_WIN, BY_ID, MIN_BET, REELS, SPIN_COOLDOWN_MS, SYMBOLS, checkBet, describe, evaluate, payout, paytable, pickSymbol, returnToPlayer, spin };
