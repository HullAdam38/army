'use strict';

/**
 * Roulette (pure). A European wheel: one zero, 37 pockets. Every bet pays at
 * standard odds, so each one returns 36/37 (97.3%) of what's bet over time.
 * Zero loses every outside bet.
 *
 * Bets are a map of spot → amount. Spots:
 *   '0'…'36'                 straight up, pays 35 to 1
 *   dozen1…dozen3, col1…col3 pays 2 to 1
 *   red, black, odd, even, low (1–18), high (19–36)   pays 1 to 1
 */

const crypto = require('node:crypto');

// The order of the pockets round a European wheel, clockwise from zero.
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const MIN_CHIP = 10; // the least on any one spot
const MAX_SPOTS = 20;

const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

// Outside bets: what they cover, how they pay, and how the board labels them.
const OUTSIDE = {
  red: { label: 'Red', odds: 1, wins: (n) => colorOf(n) === 'red' },
  black: { label: 'Black', odds: 1, wins: (n) => colorOf(n) === 'black' },
  odd: { label: 'Odd', odds: 1, wins: (n) => n > 0 && n % 2 === 1 },
  even: { label: 'Even', odds: 1, wins: (n) => n > 0 && n % 2 === 0 },
  low: { label: '1–18', odds: 1, wins: (n) => n >= 1 && n <= 18 },
  high: { label: '19–36', odds: 1, wins: (n) => n >= 19 },
  dozen1: { label: '1st 12', odds: 2, wins: (n) => n >= 1 && n <= 12 },
  dozen2: { label: '2nd 12', odds: 2, wins: (n) => n >= 13 && n <= 24 },
  dozen3: { label: '3rd 12', odds: 2, wins: (n) => n >= 25 },
  col1: { label: '2 to 1', odds: 2, wins: (n) => n > 0 && n % 3 === 1 },
  col2: { label: '2 to 1', odds: 2, wins: (n) => n > 0 && n % 3 === 2 },
  col3: { label: '2 to 1', odds: 2, wins: (n) => n > 0 && n % 3 === 0 },
};

/** Odds and a readable name for a spot, or null if it isn't one. */
function spotInfo(spot) {
  const s = String(spot);
  if (/^(0|[1-9]|[12]\d|3[0-6])$/.test(s)) return { spot: s, odds: 35, name: s, wins: (n) => n === Number(s) };
  const o = Object.hasOwn(OUTSIDE, s) ? OUTSIDE[s] : null;
  if (!o) return null;
  const name = s.startsWith('col') ? `Column ${s.slice(3)}` : o.label;
  return { spot: s, odds: o.odds, name, wins: o.wins };
}

/**
 * Cleans a player's bets against their cash and the table limit.
 * Returns { bets: { spot: amount }, total } or { error }.
 */
function checkBets(raw, { cash, maxBet }) {
  const bets = Object.create(null);
  let total = 0;
  for (const [spot, value] of Object.entries(raw || {})) {
    if (value === '' || value === null || value === undefined || Number(value) === 0) continue;
    const info = spotInfo(spot);
    if (!info) return { error: 'That isn’t a place on the table.' };
    const amount = Number(String(value).replace(/[$,\s]/g, ''));
    if (!Number.isInteger(amount) || amount < 0) return { error: 'Bets are whole dollars.' };
    if (amount < MIN_CHIP) return { error: `The least you can put on one place is $${MIN_CHIP}.` };
    bets[info.spot] = (bets[info.spot] || 0) + amount;
    total += amount;
  }
  const spots = Object.keys(bets).length;
  if (!spots) return { error: 'Place a bet on the table first.' };
  if (spots > MAX_SPOTS) return { error: `You can bet on up to ${MAX_SPOTS} places at once.` };
  if (total > maxBet) return { error: `The table limit is $${maxBet.toLocaleString('en-US')} a spin (your bets add up to $${total.toLocaleString('en-US')}).` };
  if (total > cash) return { error: `Your bets add up to $${total.toLocaleString('en-US')}, but you only have $${cash.toLocaleString('en-US')} in cash. Bets come from cash, not the bank.` };
  return { bets, total };
}

/** Settles bets on a number. Returns { payout, winners: [{ spot, name, amount, won }] }. */
function settle(bets, number) {
  const winners = [];
  let payout = 0;
  for (const [spot, amount] of Object.entries(bets)) {
    const info = spotInfo(spot);
    if (!info.wins(number)) continue;
    const won = amount * (info.odds + 1); // the stake comes back with the winnings
    payout += won;
    winners.push({ spot, name: info.name, amount, won });
  }
  return { payout, winners };
}

/** Spins the wheel: a pocket index picked with a cryptographic RNG. */
function spin(randomInt = crypto.randomInt) {
  const pocket = randomInt(WHEEL.length);
  const number = WHEEL[pocket];
  return { pocket, number, color: colorOf(number) };
}

/** Exact return to player of a bet on `spot` (every bet is 36/37). */
function returnToPlayer(spot) {
  const info = spotInfo(spot);
  const winning = WHEEL.filter((n) => info.wins(n)).length;
  return (winning * (info.odds + 1)) / WHEEL.length;
}

/** The exact variance of what a set of bets pays back, over the 37 pockets. */
function varianceOf(bets) {
  const payouts = WHEEL.map((n) => settle(bets, n).payout);
  const mean = payouts.reduce((a, b) => a + b, 0) / payouts.length;
  return payouts.reduce((a, p) => a + (p - mean) ** 2, 0) / payouts.length;
}

/** The number grid as the board draws it: 12 rows of three, low numbers first. */
const ROWS = Array.from({ length: 12 }, (_, r) => [3 * r + 1, 3 * r + 2, 3 * r + 3]);

module.exports = { MAX_SPOTS, MIN_CHIP, OUTSIDE, RED, ROWS, WHEEL, checkBets, colorOf, returnToPlayer, settle, spin, spotInfo, varianceOf };
