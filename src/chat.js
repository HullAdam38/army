'use strict';

/**
 * Game chat (pure rules). One Global channel for everyone, plus a private
 * channel for each unit. Messages are BBCode, rendered with bbcode.render().
 */

const tuning = require('./tuning');

const MAX_LENGTH = 500;
const MAX_LINES = 8;
const MIN_LEVEL = 2; // default: brand-new accounts read but don't post (keeps spam bots out)
const COOLDOWN_MS = 3 * 1000; // default
// Live values from Admin › Game settings.
const minLevel = () => tuning.get('chatMinLevel');
const cooldownMs = () => tuning.get('chatCooldownSeconds') * 1000;
const DUPLICATE_MS = 60 * 1000; // the same message twice in a minute is spam
const MAX_MENTIONS = 3; // @mentions that notify, per message
const PAGE_SIZE = 50;
const RETENTION_DAYS = 30;
const MAX_REPORT_REASON = 200;
const MENTION_NOTIFY_MS = 10 * 60 * 1000; // one mention notification per author → player per 10 minutes
const REPORTS_PER_HOUR = 10; // keeps one player from flooding the admin queue

const MINUTE = 60 * 1000;
const MUTES = {
  '10m': { label: '10 minutes', ms: 10 * MINUTE },
  '1h': { label: '1 hour', ms: 60 * MINUTE },
  '24h': { label: '24 hours', ms: 24 * 60 * MINUTE },
  '7d': { label: '7 days', ms: 7 * 24 * 60 * MINUTE },
};

const MENTION_RE = /(^|[^A-Za-z0-9_\-/=@])@([A-Za-z0-9_-]{3,20})(?![A-Za-z0-9_-])/g;

/** Which channel a URL names for this player: { key, slug, name } or null. */
function channelFor(slug, player, unit) {
  if (slug === 'global') return { key: 'global', slug: 'global', name: 'Global' };
  if (slug === 'unit' && player.unit_id && unit) return { key: `unit:${unit.id}`, slug: 'unit', name: `[${unit.tag}] ${unit.name}`, tag: unit.tag };
  return null;
}

/** Cleans and checks a message. Returns { error } or { body }. */
function validateBody(raw) {
  let body = String(raw || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return { error: 'Write a message first.' };
  if (body.length > MAX_LENGTH) return { error: `Chat messages are limited to ${MAX_LENGTH} characters (yours is ${body.length}).` };
  const lines = body.split('\n');
  if (lines.length > MAX_LINES) body = `${lines.slice(0, MAX_LINES - 1).join('\n')}\n${lines.slice(MAX_LINES - 1).join(' ')}`;
  return { body };
}

/** Why `player` can't post now, or null. `last` is their latest message ({ body, created_at }) or null. */
function postBlocker(player, body, last, now = Date.now()) {
  if (player.level < minLevel()) return `Reach level ${minLevel()} to chat. Run a mission or two first.`;
  if (player.chat_muted_until && player.chat_muted_until > now) {
    const mins = Math.ceil((player.chat_muted_until - now) / MINUTE);
    const left = mins >= 120 ? `${Math.ceil(mins / 60)} hours` : `${mins} minute${mins === 1 ? '' : 's'}`;
    return `You’re muted for another ${left}${player.chat_mute_reason ? ` (${player.chat_mute_reason})` : ''}.`;
  }
  if (last && now - last.created_at < cooldownMs()) {
    const s = Math.ceil((cooldownMs() - (now - last.created_at)) / 1000);
    return cooldownMs() > 5000 ? `Slow mode is on: you can send another message in ${s}s.` : 'Slow down: wait a few seconds between messages.';
  }
  if (last && last.body === body && now - last.created_at < DUPLICATE_MS) return 'You just sent that.';
  return null;
}

/** Callsigns @mentioned in a message, unique (case-insensitive), at most MAX_MENTIONS. */
function mentionsIn(body) {
  const seen = new Map();
  for (const m of String(body).matchAll(MENTION_RE)) {
    const key = m[2].toLowerCase();
    if (!seen.has(key)) seen.set(key, m[2]);
    if (seen.size >= MAX_MENTIONS) break;
  }
  return [...seen.values()];
}

/**
 * Turns @Callsign in rendered HTML into profile links. `names` maps lower-case
 * callsigns to their real spelling (only real players are linked). Callsigns
 * are letters, digits, _ and -, so they need no escaping. Matches can't start
 * inside a URL or attribute (they must follow a space, tag or punctuation).
 */
function linkMentions(html, names, me = null) {
  // Only touch text between tags, never tags or their attributes (a URL can
  // contain "@name"), and never text already inside a link or code block.
  let skip = 0;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(a|code)[\s>]/i.test(part)) skip += 1;
      else if (/^<\/(a|code)>/i.test(part)) skip = Math.max(0, skip - 1);
      return part;
    }
    if (skip) return part;
    return part.replace(MENTION_RE, (all, pre, name) => {
      const real = names.get(name.toLowerCase());
      if (!real) return all;
      const you = me && real.toLowerCase() === me.toLowerCase();
      return `${pre}<a class="chat-mention${you ? ' chat-mention--you' : ''}" href="/profile/${real}">@${real}</a>`;
    });
  }).join('');
}

/** Mute length for an admin's choice, or null. */
const muteFor = (key) => MUTES[key] || null;

module.exports = {
  COOLDOWN_MS, DUPLICATE_MS, MENTION_NOTIFY_MS, REPORTS_PER_HOUR, MAX_LENGTH, MAX_LINES, MAX_MENTIONS, MAX_REPORT_REASON, MIN_LEVEL, MUTES, PAGE_SIZE, RETENTION_DAYS,
  channelFor, cooldownMs, linkMentions, minLevel, mentionsIn, muteFor, postBlocker, validateBody,
};
