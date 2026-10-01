'use strict';

/**
 * The bank keeps cash safe from PvP. There is deliberately no interest: it
 * never creates money. A small deposit fee keeps "bank everything, always"
 * from being free, so carrying cash stays a real choice.
 */

const DEPOSIT_FEE = 0.02;

/**
 * Parses an amount typed by a player: "1500", "1,500", "$1,500" or "all".
 * Returns a positive integer, or null if it isn't one.
 */
function parseAmount(input, all) {
  const text = String(input ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
  if (text === 'all') return all > 0 ? all : null;
  if (!/^\d{1,12}$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

/** Fee for depositing `amount`: 2%, rounded up, at least $1. */
function depositFee(amount) {
  return Math.max(1, Math.ceil(amount * DEPOSIT_FEE));
}

/** Moves cash into the bank. Returns { error } or { player, amount, fee, credited }. */
function deposit(current, input) {
  const amount = parseAmount(input, current.cash);
  if (!amount) return { error: 'Enter an amount to deposit.' };
  if (amount > current.cash) return { error: `You only have $${current.cash.toLocaleString('en-US')} on hand.` };
  const fee = depositFee(amount);
  if (amount <= fee) return { error: `Deposits must be more than the $${fee} fee.` };
  const credited = amount - fee;
  const player = { ...current, cash: current.cash - amount, bank_balance: current.bank_balance + credited };
  return { player, amount, fee, credited };
}

/** Moves money out of the bank, free of charge. Returns { error } or { player, amount }. */
function withdraw(current, input) {
  const amount = parseAmount(input, current.bank_balance);
  if (!amount) return { error: 'Enter an amount to withdraw.' };
  if (amount > current.bank_balance) return { error: `Your balance is $${current.bank_balance.toLocaleString('en-US')}.` };
  const player = { ...current, cash: current.cash + amount, bank_balance: current.bank_balance - amount };
  return { player, amount };
}

module.exports = { DEPOSIT_FEE, deposit, depositFee, parseAmount, withdraw };
