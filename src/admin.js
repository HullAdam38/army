'use strict';

/**
 * Admin changes to a player. Pure functions over a player row: each returns
 * { error } or { player, summary } where `summary` goes in the audit log.
 */

const crypto = require('node:crypto');
const game = require('./game');
const { MAX_HEALTH_PER_ENDURANCE, statCap } = require('./training');

const MAX_LEVEL = 120;
const MAX_CASH_CHANGE = 10_000_000;

function cleanReason(input) {
  return String(input || '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

function parseWhole(input) {
  const text = String(input ?? '').trim().replace(/[$,\s]/g, '');
  return /^-?\d{1,9}$/.test(text) ? Number(text) : null;
}

const money = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US')}`;

/** Adds or removes cash on hand (never below zero). A reason is required. */
function adjustCash(player, amountInput, reasonInput) {
  const amount = parseWhole(amountInput);
  const reason = cleanReason(reasonInput);
  if (amount === null || amount === 0) return { error: 'Enter a non-zero whole amount, e.g. 500 or -500.' };
  if (Math.abs(amount) > MAX_CASH_CHANGE) return { error: `Changes are capped at ${money(MAX_CASH_CHANGE)} at a time.` };
  if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
  if (player.cash + amount < 0) return { error: `${player.username} only has ${money(player.cash)} on hand.` };
  return {
    player: { ...player, cash: player.cash + amount },
    summary: `${amount > 0 ? 'Added' : 'Removed'} ${money(Math.abs(amount))} cash (now ${money(player.cash + amount)}). Reason: ${reason}`,
  };
}

/** Sets level directly, with the energy/health caps that level would have, refilled. */
function setLevel(player, levelInput, reasonInput) {
  const level = parseWhole(levelInput);
  const reason = cleanReason(reasonInput);
  if (level === null || level < 1 || level > MAX_LEVEL) return { error: `Level must be between 1 and ${MAX_LEVEL}.` };
  if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
  // Keep the energy earned through the base's Barracks too.
  const maxEnergy = 50 + 5 * (level - 1) + require('./base').effectsOf(player).maxEnergyBonus;
  // Keep the max health earned through Endurance training.
  const maxHealth = 100 + 10 * (level - 1) + MAX_HEALTH_PER_ENDURANCE * (player.stat_end || 0);
  const now = Date.now();
  return {
    player: {
      ...player, level, xp: 0,
      max_energy: maxEnergy, energy: maxEnergy, energy_updated_at: now,
      max_health: maxHealth, health: maxHealth, health_updated_at: now,
      hospital_until: null, hospital_reason: null,
    },
    summary: `Set level ${player.level} → ${level} (${game.rankFor(level).name}). Reason: ${reason}`,
  };
}

/** Adds or removes money in the bank (never below zero). */
function adjustBank(player, amountInput, reasonInput) {
  const amount = parseWhole(amountInput);
  const reason = cleanReason(reasonInput);
  if (amount === null || amount === 0) return { error: 'Enter a non-zero whole amount, e.g. 500 or -500.' };
  if (Math.abs(amount) > MAX_CASH_CHANGE) return { error: `Changes are capped at ${money(MAX_CASH_CHANGE)} at a time.` };
  if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
  if (player.bank_balance + amount < 0) return { error: `${player.username} only has ${money(player.bank_balance)} in the bank.` };
  return {
    player: { ...player, bank_balance: player.bank_balance + amount },
    summary: `${amount > 0 ? 'Added' : 'Removed'} ${money(Math.abs(amount))} in the bank (now ${money(player.bank_balance + amount)}). Reason: ${reason}`,
  };
}

const MAX_XP_GRANT = 1_000_000;

/** Grants XP, with level-ups as if earned in play. */
function grantXp(player, amountInput, reasonInput) {
  const amount = parseWhole(amountInput);
  const reason = cleanReason(reasonInput);
  if (amount === null || amount < 1 || amount > MAX_XP_GRANT) return { error: `XP must be a whole number from 1 to ${MAX_XP_GRANT.toLocaleString('en-US')}.` };
  if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
  const p = { ...player };
  const levels = game.grantXp(p, amount);
  if (p.level > MAX_LEVEL) return { error: `That would take them past level ${MAX_LEVEL}.` };
  return {
    player: p,
    levelsGained: levels,
    summary: `Granted ${amount.toLocaleString('en-US')} XP${levels.length ? ` (level ${player.level} → ${p.level})` : ''}. Reason: ${reason}`,
  };
}

/** Sets trained Strength, Agility and Endurance (each 0 to the level's cap). Endurance changes max health. */
function setStats(player, input, reasonInput) {
  const reason = cleanReason(reasonInput);
  const cap = statCap(player.level);
  const next = {};
  for (const [field, label] of [['stat_str', 'Strength'], ['stat_agi', 'Agility'], ['stat_end', 'Endurance']]) {
    const n = parseWhole(input[field]);
    if (n === null || n < 0 || n > cap) return { error: `${label} must be a whole number from 0 to ${cap} at level ${player.level}.` };
    next[field] = n;
  }
  if (!reason) return { error: 'Give a reason; it goes in the audit log.' };
  const healthChange = (next.stat_end - (player.stat_end || 0)) * MAX_HEALTH_PER_ENDURANCE;
  const maxHealth = player.max_health + healthChange;
  return {
    player: { ...player, ...next, max_health: maxHealth, health: Math.min(maxHealth, Math.max(1, player.health + Math.max(0, healthChange))) },
    summary: `Set trained stats ${player.stat_str || 0}/${player.stat_agi || 0}/${player.stat_end || 0} → ${next.stat_str}/${next.stat_agi}/${next.stat_end} (Str/Agi/End). Reason: ${reason}`,
  };
}

/** Checks a new callsign or email. Returns { username } / { email } or { error }. */
function validateIdentity({ username, email }, { USERNAME_RE, EMAIL_RE }) {
  if (username !== undefined) {
    const u = String(username).trim();
    if (!USERNAME_RE.test(u)) return { error: 'Callsigns are 3–20 characters: letters, numbers, _ or -.' };
    return { username: u };
  }
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) return { error: 'Enter a valid email address.' };
  return { email: e };
}

/** Full energy and health, out of hospital. */
function restore(player) {
  const now = Date.now();
  return {
    player: {
      ...player,
      energy: player.max_energy, energy_updated_at: now,
      health: player.max_health, health_updated_at: now,
      hospital_until: null, hospital_reason: null,
    },
    summary: 'Restored full energy and health and released from hospital.',
  };
}

// No 0/O, 1/I/L: easy to read out or type from a message.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

/** A random temporary password like "K7QF-M2XP-9TRA" (about 59 bits of randomness). */
function generateTempPassword() {
  const chars = Array.from({ length: 12 }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

module.exports = { TEMP_PASSWORD_TTL_MS, generateTempPassword, MAX_LEVEL, adjustBank, adjustCash, cleanReason, grantXp, restore, setLevel, setStats, validateIdentity };
