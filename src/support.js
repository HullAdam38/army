'use strict';

/**
 * Support tickets (pure rules). A player opens a ticket with a category,
 * subject and message; admins (HQ Support) reply, add internal notes, assign
 * and close. Statuses:
 *   open      waiting for HQ Support
 *   answered  HQ Support replied; waiting for the player
 *   closed    done (the player can reopen it by replying)
 */

const MAX_SUBJECT = 80;
const MIN_BODY = 10;
const MAX_BODY = 4000;
const MAX_OPEN = 3; // open or answered tickets at once
const PER_DAY = 5; // new tickets per player per day
const REPLY_COOLDOWN_MS = 10 * 1000;
const AUTO_CLOSE_MS = 7 * 24 * 60 * 60 * 1000; // answered tickets close after a week without a reply

const CATEGORIES = [
  { id: 'account', name: 'Account and sign-in', help: 'Callsign, email, password, avatar or settings.' },
  { id: 'bug', name: 'Bug report', help: 'Something in the game isn’t working as it should.' },
  { id: 'gameplay', name: 'Gameplay question', help: 'How something works, or where to find it.' },
  { id: 'player', name: 'Report a player', help: 'Cheating, harassment or abuse. Say who and what happened.' },
  { id: 'unit', name: 'Units, raids and the map', help: 'Problems with your unit, a raid or the theatre of war.' },
  { id: 'other', name: 'Something else', help: 'Anything that doesn’t fit above.' },
];
const CATEGORY = new Map(CATEGORIES.map((c) => [c.id, c]));

const STATUSES = {
  open: { label: 'Waiting for HQ', staffLabel: 'Needs a reply' },
  answered: { label: 'HQ replied', staffLabel: 'Waiting for player' },
  closed: { label: 'Closed', staffLabel: 'Closed' },
};

function validateSubject(raw) {
  const subject = String(raw || '').replace(/\s+/g, ' ').trim();
  if (subject.length < 4) return { error: 'Give your ticket a short subject (at least 4 characters).' };
  if (subject.length > MAX_SUBJECT) return { error: `Subjects are limited to ${MAX_SUBJECT} characters.` };
  return { subject };
}

/** Cleans and checks a message (BBCode). Returns { error } or { body }. */
function validateBody(raw, { min = MIN_BODY } = {}) {
  const body = String(raw || '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (body.length < min) return { error: min > 1 ? `Tell us a bit more (at least ${min} characters).` : 'Write a message first.' };
  if (body.length > MAX_BODY) return { error: `Messages are limited to ${MAX_BODY.toLocaleString('en-US')} characters (yours is ${body.length.toLocaleString('en-US')}).` };
  return { body };
}

/** Why a player can't open a new ticket now, or null. `ctx`: { openCount, todayCount }. */
function openBlocker(ctx) {
  if (ctx.openCount >= MAX_OPEN) return `You already have ${MAX_OPEN} tickets open. Reply on one of those, or close one you no longer need.`;
  if (ctx.todayCount >= PER_DAY) return `You’ve opened ${PER_DAY} tickets today. Reply on an existing one, or try again tomorrow.`;
  return null;
}

module.exports = {
  AUTO_CLOSE_MS,
  CATEGORIES,
  CATEGORY,
  MAX_BODY,
  MAX_OPEN,
  MAX_SUBJECT,
  MIN_BODY,
  PER_DAY,
  REPLY_COOLDOWN_MS,
  STATUSES,
  openBlocker,
  validateBody,
  validateSubject,
};
