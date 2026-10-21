'use strict';

/**
 * Contracts: mercenary work between players. Pure rules.
 *
 * A client puts money in escrow (plus a fee that's destroyed) for one of two jobs:
 *   - a hit: beat a named target in PvP 1–3 times (optionally by knockout);
 *   - bodyguard duty: for the contract's time, beat the soldiers who attack
 *     the client, paid a share for each one (up to 1–5 of them).
 * A contract is posted on the board for anyone, or offered to one mercenary.
 * Once accepted it's that mercenary's alone, against a deadline. Only
 * full-reward PvP wins count, the three players can't be linked accounts, and
 * whatever isn't earned goes back to the client (the fee doesn't). Bounties are
 * the open, first-come version; contracts are a deal with one soldier.
 */

const tuning = require('./tuning');
const { MIN_PVP_LEVEL } = require('./pvp');

const KINDS = {
  hit: { id: 'hit', name: 'Hit', blurb: 'Beat a named soldier in PvP.', minJobs: 1, maxJobs: 3 },
  guard: { id: 'guard', name: 'Bodyguard', blurb: 'Beat the soldiers who attack the client while the contract runs.', minJobs: 1, maxJobs: 5 },
};
const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 1_000_000;
const HOURS = [24, 48, 72]; // time the mercenary gets once they accept
const OPEN_DAYS = 7; // unaccepted contracts are refunded after this
const MAX_POSTED = 3; // open or active contracts per client
const MAX_JOBS = 2; // active contracts per mercenary

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const feeFor = (amount) => Math.ceil(amount * tuning.get('contractFeeRate'));

/**
 * Checks the posting form. Returns { error } or { kind, jobs, knockout, amount, fee, hours }.
 * `input`: { kind, jobs, knockout, amount, hours }.
 */
function parseTerms(input) {
  const kind = KINDS[String(input.kind || '')];
  if (!kind) return { error: 'Pick a kind of contract.' };
  const jobs = Math.floor(Number(input.jobs) || 1);
  if (jobs < kind.minJobs || jobs > kind.maxJobs) return { error: `A ${kind.name.toLowerCase()} contract asks for ${kind.minJobs}–${kind.maxJobs} ${kind.id === 'hit' ? 'wins' : 'soldiers beaten'}.` };
  const amount = Math.floor(Number(String(input.amount || '').replace(/[,$\s]/g, '')));
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT) return { error: `Contracts start at ${money(MIN_AMOUNT)}.` };
  if (amount > MAX_AMOUNT) return { error: `The largest contract is ${money(MAX_AMOUNT)}.` };
  const hours = Number(input.hours);
  if (!HOURS.includes(hours)) return { error: `Give the mercenary ${HOURS.join(', ')} hours.` };
  // Only the first win on a soldier each day pays in full, so each win on the target needs a day.
  if (kind.id === 'hit' && jobs > hours / 24) return { error: `Only one win a day on the same soldier counts, so ${jobs} wins need at least ${jobs * 24} hours.` };
  return { kind: kind.id, jobs, knockout: kind.id === 'hit' && Boolean(input.knockout), amount, fee: feeFor(amount), hours };
}

/**
 * Why `client` can't post this contract, or null. `ctx`: { target, offeredTo,
 * posted (their open or active count), linked(a, b) }.
 */
function postBlocker(client, terms, { target, offeredTo, posted, linked }) {
  if (client.level < MIN_PVP_LEVEL) return `Contracts open at level ${MIN_PVP_LEVEL}.`;
  if (posted >= MAX_POSTED) return `You can have ${MAX_POSTED} contracts open or under way at once.`;
  if (client.cash < terms.amount + terms.fee) return `That needs ${money(terms.amount + terms.fee)} in cash (${money(terms.amount)} plus the ${money(terms.fee)} fee). You have ${money(client.cash)}.`;
  if (terms.kind === 'hit') {
    if (!target) return 'Name the soldier to take down.';
    if (target.id === client.id) return 'You can’t take out a contract on yourself.';
    if (target.banned_at) return `${target.username} is suspended.`;
    if (target.level < MIN_PVP_LEVEL) return `${target.username} can’t be attacked until level ${MIN_PVP_LEVEL}.`;
    if (linked(client.id, target.id)) return `You can’t take out a contract on ${target.username}: your accounts have been used on the same device or network.`;
  }
  if (offeredTo) {
    const name = offeredTo.username;
    if (offeredTo.id === client.id) return 'Offer it to someone else: you can’t take your own contract.';
    if (target && offeredTo.id === target.id) return `${name} is the target.`;
    if (offeredTo.is_bot) return `${name} is a reserve soldier and doesn’t take contracts.`;
    if (offeredTo.banned_at) return `${name} is suspended.`;
    if (offeredTo.level < MIN_PVP_LEVEL) return `${name} can take contracts from level ${MIN_PVP_LEVEL}.`;
    if (linked(offeredTo.id, client.id)) return `You can’t hire ${name}: your accounts have been used on the same device or network.`;
    if (target && linked(offeredTo.id, target.id)) return `${name} can’t take a contract on ${target.username}: their accounts have been used on the same device or network.`;
  }
  return null;
}

/**
 * Why `merc` can't take `contract`, or null. `ctx`: { jobs (their active
 * count), linked(a, b), client, target }.
 */
function mercBlocker(merc, contract, { jobs, linked, client, target }) {
  if (merc.is_bot) return 'Reserve soldiers don’t take contracts.';
  if (merc.banned_at) return 'Suspended soldiers can’t take contracts.';
  if (merc.level < MIN_PVP_LEVEL) return `You can take contracts from level ${MIN_PVP_LEVEL}.`;
  if (merc.id === contract.client_id) return 'You can’t take your own contract.';
  if (contract.target_id && merc.id === contract.target_id) return 'You can’t take a contract on yourself.';
  if (jobs >= MAX_JOBS) return `You can work ${MAX_JOBS} contracts at once.`;
  if (client && linked(merc.id, client.id)) return 'You can’t work for this client: your accounts have been used on the same device or network.';
  if (target && linked(merc.id, target.id)) return 'You can’t take this contract: your account and the target’s have been used on the same device or network.';
  return null;
}

/** The pay for job number `n` (1-based) of a contract: an even share, the last one taking any remainder. */
const shareOf = (contract, n) => (n >= contract.jobs ? contract.amount - Math.floor(contract.amount / contract.jobs) * (contract.jobs - 1) : Math.floor(contract.amount / contract.jobs));

/** "Win 2 fights against Bea by knockout" / "Beat 3 soldiers who attack Ace". */
function describe(contract, { target, client } = {}) {
  if (contract.kind === 'hit') {
    const who = target ? target.username : 'the target';
    return `${contract.jobs === 1 ? `Beat ${who}` : `Beat ${who} ${contract.jobs} times`}${contract.knockout ? ' by knockout' : ''}`;
  }
  const who = client ? client.username : 'the client';
  return `Beat ${contract.jobs === 1 ? 'a soldier who attacks' : `${contract.jobs} soldiers who attack`} ${who}`;
}

module.exports = {
  HOURS, KINDS, MAX_AMOUNT, MAX_JOBS, MAX_POSTED, MIN_AMOUNT, OPEN_DAYS,
  describe, feeFor, mercBlocker, parseTerms, postBlocker, shareOf,
};
