'use strict';

/**
 * Push notification rules (pure): which alert categories exist, which
 * notification kinds belong to each, players' preferences, quiet hours, and
 * which push services the server is allowed to contact.
 */

const CATEGORIES = [
  { id: 'mentions', name: 'Chat mentions', help: 'Someone @mentions you in chat.', title: 'You were mentioned', default: true },
  { id: 'messages', name: 'Private messages', help: 'A new private message arrives.', title: 'New message', default: true },
  { id: 'attacks', name: 'Attacks on you', help: 'Another player attacks you, win or lose.', title: 'You were attacked', default: true },
  { id: 'bounties', name: 'Bounties', help: 'A bounty is placed on you, or one you posted is collected.', title: 'Bounty', default: true },
  { id: 'deployments', name: 'Deployments', help: 'Your troops come back from a deployment.', title: 'Deployment complete', default: true },
  { id: 'unit', name: 'Unit and wars', help: 'Unit applications, promotions and war results.', title: 'Unit', default: true },
  { id: 'news', name: 'Events and announcements', help: 'Live events starting, and messages from the admins.', title: 'GeneralForces', default: true },
  { id: 'energy', name: 'Energy full', help: 'Your energy bar is full again, so you’re not wasting regeneration.', title: 'Energy full', default: false },
  { id: 'progress', name: 'Progress', help: 'Promotions, unlocks, medals, titles, daily orders and season results.', title: 'Progress', default: false },
];
const CATEGORY = new Map(CATEGORIES.map((c) => [c.id, c]));

// Notification kinds (players.notify) → category. Kinds not listed never push.
const KIND_CATEGORY = {
  chat: 'mentions',
  'attacked-lost': 'attacks',
  'attacked-won': 'attacks',
  bounty: 'bounties',
  deployment: 'deployments',
  unit: 'unit',
  war: 'unit',
  event: 'news',
  system: 'news',
  promotion: 'progress',
  unlock: 'progress',
  medal: 'progress',
  title: 'progress',
  order: 'progress',
  season: 'progress',
  base: 'progress',
};

const categoryForKind = (kind) => KIND_CATEGORY[kind] || null;

/** Preferences from storage or a form: { categories: [ids], quietFrom, quietTo, tz }. */
function normalizePrefs(input, { useDefaults = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(src.categories) ? src.categories : useDefaults ? CATEGORIES.filter((c) => c.default).map((c) => c.id) : [];
  const hour = (v) => (v === '' || v === null || v === undefined || !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 23 ? null : Number(v));
  let quietFrom = hour(src.quietFrom);
  let quietTo = hour(src.quietTo);
  if (quietFrom === null || quietTo === null || quietFrom === quietTo) { quietFrom = null; quietTo = null; }
  return {
    categories: CATEGORIES.map((c) => c.id).filter((id) => list.includes(id)),
    quietFrom,
    quietTo,
    tz: validTimeZone(src.tz) ? src.tz : 'UTC',
  };
}

function parsePrefs(json) {
  if (!json) return null;
  try { return normalizePrefs(JSON.parse(json)); } catch { return null; }
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The hour (0–23) it is now in a time zone. */
function localHour(tz, now = Date.now()) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(h) % 24;
}

/** Whether `now` falls in the player's quiet hours (which may wrap past midnight). */
function inQuietHours(prefs, now = Date.now()) {
  if (!prefs || prefs.quietFrom === null || prefs.quietTo === null) return false;
  const h = localHour(prefs.tz, now);
  return prefs.quietFrom < prefs.quietTo ? h >= prefs.quietFrom && h < prefs.quietTo : h >= prefs.quietFrom || h < prefs.quietTo;
}

// The server only ever sends to the browsers' real push services, so a
// subscription can't be used to make it call other addresses.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

const b64url = /^[A-Za-z0-9_-]+={0,2}$/;

/** Checks a PushSubscription (as JSON). Returns { endpoint, p256dh, auth } or { error }. */
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return { error: 'Missing subscription.' };
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
  let url;
  try { url = new URL(endpoint); } catch { return { error: 'Bad push address.' }; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return { error: 'Bad push address.' };
  if (endpoint.length > 1000 || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return { error: 'That browser’s push service isn’t supported.' };
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!b64url.test(p256dh) || p256dh.length < 80 || p256dh.length > 100 || !b64url.test(auth) || auth.length < 16 || auth.length > 32) return { error: 'Bad push keys.' };
  return { endpoint, p256dh, auth };
}

/** What a push says: { title, body, url, tag }. Only same-site links. */
function payloadFor(category, message, link) {
  const c = CATEGORY.get(category);
  const url = typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : '/notifications';
  return {
    title: c ? c.title : 'GeneralForces',
    body: String(message || '').slice(0, 240),
    url,
    tag: category || 'general',
  };
}

/** A short label for a device from its browser's user agent. */
function deviceLabel(ua = '') {
  const s = String(ua);
  const os = /iPhone|iPad|iPod/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}

module.exports = {
  CATEGORIES,
  KIND_CATEGORY,
  categoryForKind,
  deviceLabel,
  inQuietHours,
  localHour,
  normalizePrefs,
  parsePrefs,
  payloadFor,
  validTimeZone,
  validateSubscription,
};
