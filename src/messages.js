'use strict';

/** Private message rules (pure). */

const MAX_SUBJECT = 80;
const MAX_BODY = 5000;
const MIN_LEVEL_TO_START = 2; // brand-new accounts can reply but not cold-message people
const SEND_COOLDOWN_MS = 5 * 1000;
const NEW_CONVERSATIONS_PER_DAY = 20;
const MAX_REPORT_REASON = 300;

/** Cleans and checks a message body. Returns { error } or { body }. */
function validateBody(raw) {
  const body = String(raw || '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!body) return { error: 'Write a message first.' };
  if (body.length > MAX_BODY) return { error: `Messages are limited to ${MAX_BODY.toLocaleString('en-US')} characters (yours is ${body.length.toLocaleString('en-US')}).` };
  return { body };
}

function validateSubject(raw) {
  const subject = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!subject) return { error: 'Give your message a subject.' };
  if (subject.length > MAX_SUBJECT) return { error: `Subjects are limited to ${MAX_SUBJECT} characters.` };
  return { subject };
}

/**
 * Why `sender` can't message `recipient`, or null. `ctx` comes from the
 * database: { blockedBySender, blockedByRecipient, lastSentAt, startedToday, starting }.
 */
function sendBlocker(sender, recipient, ctx, now = Date.now()) {
  if (!recipient) return 'No soldier by that callsign.';
  if (sender.id === recipient.id) return 'You can’t message yourself.';
  if (recipient.banned_at) return `${recipient.username} is suspended.`;
  if (ctx.blockedBySender) return `You’ve blocked ${recipient.username}. Unblock them to send a message.`;
  if (ctx.blockedByRecipient) return `${recipient.username} isn’t accepting messages from you.`;
  if (ctx.starting && sender.level < MIN_LEVEL_TO_START) return `Reach level ${MIN_LEVEL_TO_START} to start new conversations. You can still reply to messages.`;
  if (ctx.starting && ctx.startedToday >= NEW_CONVERSATIONS_PER_DAY) return `You’ve started ${NEW_CONVERSATIONS_PER_DAY} conversations today. Try again tomorrow.`;
  if (ctx.lastSentAt && now - ctx.lastSentAt < SEND_COOLDOWN_MS) return 'Slow down: wait a few seconds between messages.';
  return null;
}

module.exports = { MAX_BODY, MAX_REPORT_REASON, MAX_SUBJECT, MIN_LEVEL_TO_START, NEW_CONVERSATIONS_PER_DAY, SEND_COOLDOWN_MS, sendBlocker, validateBody, validateSubject };
