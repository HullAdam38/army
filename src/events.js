'use strict';

/**
 * Timed world events that admins schedule. Pure rules: each event type is a
 * set of multipliers that the rest of the game reads while it's live.
 * Different types can overlap (their effects combine); the same type can't.
 */

const HOUR = 60 * 60 * 1000;
const MIN_HOURS = 1;
const MAX_HOURS = 168; // one week
const MAX_LEAD_DAYS = 60; // how far ahead an event can be scheduled
const MAX_TITLE = 60;
const MAX_MESSAGE = 2000;

const NEUTRAL = Object.freeze({ xpMult: 1, cashMult: 1, supplyMult: 1, ordersMult: 1, warPointsMult: 1, warPrizeMult: 1, bountyFeeFree: false });

const TYPES = {
  double_xp: {
    name: 'Double XP',
    icon: 'i-star',
    summary: 'Missions and operations pay double XP.',
    effects: { xpMult: 2 },
  },
  payday: {
    name: 'Payday',
    icon: 'i-cash',
    summary: 'Missions and operations pay 50% more cash.',
    effects: { cashMult: 1.5 },
  },
  supply_surge: {
    name: 'Supply Surge',
    icon: 'i-kit',
    summary: 'Supply drops and daily order rewards are doubled.',
    effects: { supplyMult: 2, ordersMult: 2 },
  },
  war_season: {
    name: 'War Season',
    icon: 'i-flag',
    summary: 'Unit war fights score double points, and war prizes are 50% bigger.',
    effects: { warPointsMult: 2, warPrizeMult: 1.5 },
  },
  most_wanted: {
    name: 'Most Wanted',
    icon: 'i-target',
    summary: 'Posting a bounty costs no fee.',
    effects: { bountyFeeFree: true },
  },
};

/** The biggest cash multiplier any event can apply (anti-cheat limits allow for it). */
const MAX_CASH_MULT = Math.max(...Object.values(TYPES).map((t) => t.effects.cashMult || 1));

/** Combined effects of a list of event types. */
function effectsOf(types) {
  const out = { ...NEUTRAL };
  for (const type of types) {
    const def = TYPES[type];
    if (!def) continue;
    for (const [k, v] of Object.entries(def.effects)) {
      out[k] = typeof v === 'boolean' ? out[k] || v : out[k] * v;
    }
  }
  return out;
}

/**
 * Validates the admin form. Times are UTC. Returns { error } or
 * { type, title, message, startsAt, endsAt }.
 */
function validateEvent({ type, title, message, start, startAt, hours }, now = Date.now()) {
  if (!Object.hasOwn(TYPES, type)) return { error: 'Pick an event type.' };
  const h = Number(hours);
  if (!Number.isFinite(h) || h < MIN_HOURS || h > MAX_HOURS) return { error: `Events last ${MIN_HOURS}–${MAX_HOURS} hours.` };
  let startsAt = now;
  if (start === 'later') {
    // <input type="datetime-local"> sends "YYYY-MM-DDTHH:MM"; the form labels it as UTC.
    const raw = String(startAt || '').trim();
    startsAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? Date.parse(`${raw}:00Z`) : NaN;
    if (!Number.isFinite(startsAt)) return { error: 'Give a start date and time (UTC).' };
    if (startsAt < now - 60 * 1000) return { error: 'That start time has already passed.' };
    if (startsAt > now + MAX_LEAD_DAYS * 24 * HOUR) return { error: `Events can be scheduled up to ${MAX_LEAD_DAYS} days ahead.` };
  }
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim() || TYPES[type].name;
  if (cleanTitle.length > MAX_TITLE) return { error: `Keep the title under ${MAX_TITLE} characters.` };
  const cleanMessage = String(message || '').replace(/\r\n?/g, '\n').trim();
  if (cleanMessage.length > MAX_MESSAGE) return { error: `Keep the announcement under ${MAX_MESSAGE.toLocaleString('en-US')} characters.` };
  return { type, title: cleanTitle, message: cleanMessage, startsAt, endsAt: Math.round(startsAt + h * HOUR) };
}

/** Whether two time ranges overlap. */
const overlaps = (a, b) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

module.exports = { HOUR, MAX_CASH_MULT, MAX_HOURS, MAX_MESSAGE, MAX_TITLE, MIN_HOURS, NEUTRAL, TYPES, effectsOf, overlaps, validateEvent };
