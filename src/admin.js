'use strict';

/**
 * Admin changes to a player. Pure functions over a player row: each returns
 * { error } or { player, summary } where `summary` goes in the audit log.
 */

const game = require('./game');

const MAX_LEVEL = 60;
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
  const maxEnergy = 50 + 5 * (level - 1);
  const maxHealth = 100 + 10 * (level - 1);
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

module.exports = { MAX_LEVEL, adjustCash, cleanReason, restore, setLevel };
