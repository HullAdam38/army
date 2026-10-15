'use strict';

/**
 * Bounties. Pure rules: who can post one on whom, what it costs, and how long
 * it lasts. A bounty is paid out to the first player who beats the target in
 * a full-reward PvP fight. The posting fee is destroyed (a money sink), and
 * bounties can't be cancelled, so they're a poor way to pass money to a friend.
 */

const MIN_BOUNTY = 500;
const MAX_BOUNTY = 1_000_000;
const FEE_RATE = 0.1;
const DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_PER_PLACER = 5;

const feeFor = (amount) => Math.ceil(amount * FEE_RATE);

/** Parses an amount like "2,500" or "$2500". Returns { error } or { amount, fee, total }. */
function parseAmount(input) {
  const amount = Math.floor(Number(String(input || '').replace(/[,$\s]/g, '')));
  if (!Number.isFinite(amount) || amount < MIN_BOUNTY) return { error: `Bounties start at $${MIN_BOUNTY.toLocaleString('en-US')}.` };
  if (amount > MAX_BOUNTY) return { error: `The largest bounty is $${MAX_BOUNTY.toLocaleString('en-US')}.` };
  const fee = feeFor(amount);
  return { amount, fee, total: amount + fee };
}

/**
 * Why `placer` can't post a bounty on `target`, or null.
 * `ctx`: { minPvpLevel, openByPlacer, linked } from the database and anti-cheat.
 */
function placeBlocker(placer, target, { minPvpLevel, openByPlacer, linked }) {
  if (placer.id === target.id) return 'You can’t put a bounty on yourself.';
  if (target.banned_at) return `${target.username} is suspended.`;
  if (target.level < minPvpLevel) return `${target.username} is a Recruit and can’t be attacked until level ${minPvpLevel}, so they can’t have a bounty yet.`;
  if (linked) return `You can’t put a bounty on ${target.username}: your accounts have been used on the same device or network.`;
  if (openByPlacer >= MAX_OPEN_PER_PLACER) return `You can have ${MAX_OPEN_PER_PLACER} open bounties at once. Wait for one to be claimed or expire.`;
  return null;
}

/** Whether `claimerId` may collect `bounty` (not their own, not from a linked account). */
const claimable = (bounty, claimerId, isLinked) => bounty.placer_id !== claimerId && !isLinked(bounty.placer_id, claimerId);

module.exports = { DURATION_MS, FEE_RATE, MAX_BOUNTY, MAX_OPEN_PER_PLACER, MIN_BOUNTY, claimable, feeFor, parseAmount, placeBlocker };
