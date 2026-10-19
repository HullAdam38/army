'use strict';

/**
 * Cosmetics: looks that never change how the game plays. Pure catalogue and
 * rules. Some are earned (level, a title, unit war wins); the rest are
 * Supporter items that admins grant today and the store will sell later.
 * They can't be traded or turned into cash, so they never touch the economy
 * or the casino.
 *
 * Kinds: `name` (callsign colour), `banner` (profile header), `badgePack`
 * (extra avatar badge parts, see src/avatars.js) and `crest` (a unit's crest,
 * owned by the unit and chosen by its Commander).
 */

const COSMETICS = [
  // Callsign colours, shown in chat, on profiles, leaderboards, the players list and rosters.
  { id: 'name-olive', kind: 'name', name: 'Field olive', hex: '#b5c47a', unlock: { level: 10 } },
  { id: 'name-gold', kind: 'name', name: 'Command gold', hex: '#f0c94f', unlock: { level: 35 } },
  { id: 'name-crimson', kind: 'name', name: 'Crimson', hex: '#ff7b74', unlock: { premium: true } },
  { id: 'name-sky', kind: 'name', name: 'Sky blue', hex: '#7cc0ff', unlock: { premium: true } },
  { id: 'name-violet', kind: 'name', name: 'Elite violet', hex: '#c7a6ff', unlock: { premium: true } },
  { id: 'name-ember', kind: 'name', name: 'Ember', hex: '#ffa149', unlock: { premium: true } },
  { id: 'name-jade', kind: 'name', name: 'Jade', hex: '#63d9a0', unlock: { premium: true } },
  { id: 'name-arctic', kind: 'name', name: 'Arctic white', hex: '#f4f8fb', unlock: { premium: true } },

  // Profile banners: a patterned background for the profile header (styles in main.css, .profile-hero--<id>).
  { id: 'banner-woodland', kind: 'banner', name: 'Woodland', unlock: { level: 20 } },
  { id: 'banner-ribbons', kind: 'banner', name: 'Campaign ribbons', unlock: { title: 'veteran' } },
  { id: 'banner-desert', kind: 'banner', name: 'Desert storm', unlock: { premium: true } },
  { id: 'banner-arctic', kind: 'banner', name: 'Arctic', unlock: { premium: true } },
  { id: 'banner-night', kind: 'banner', name: 'Night ops', unlock: { premium: true } },
  { id: 'banner-urban', kind: 'banner', name: 'Urban', unlock: { premium: true } },
  { id: 'banner-digital', kind: 'banner', name: 'Digital camo', unlock: { premium: true } },

  // Avatar badge packs: unlock extra parts in the badge builder.
  { id: 'pack-special-forces', kind: 'badgePack', name: 'Special Forces pack', blurb: 'Tiger-stripe pattern, gold braid trim, gunmetal and oxblood colours.', unlock: { premium: true } },
  { id: 'pack-arctic', kind: 'badgePack', name: 'Arctic Warfare pack', blurb: 'Digital and snow camo patterns, glacier and frost colours.', unlock: { premium: true } },

  // Unit crests: how the unit's tag crest looks everywhere. Owned by the unit; the Commander picks.
  { id: 'crest-veteran', kind: 'crest', name: 'Veteran', unlock: { unitWars: 5 } },
  { id: 'crest-steel', kind: 'crest', name: 'Gunmetal', unlock: { premium: true } },
  { id: 'crest-gold', kind: 'crest', name: 'Gold', unlock: { premium: true } },
  { id: 'crest-camo', kind: 'crest', name: 'Camo', unlock: { premium: true } },
  { id: 'crest-crimson', kind: 'crest', name: 'Crimson', unlock: { premium: true } },
  { id: 'crest-navy', kind: 'crest', name: 'Navy', unlock: { premium: true } },
];
const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
const KINDS = [
  { id: 'name', name: 'Callsign colour', blurb: 'How your callsign looks in chat, on your profile, leaderboards and rosters.' },
  { id: 'banner', name: 'Profile banner', blurb: 'The background of the header on your profile.' },
  { id: 'badgePack', name: 'Badge packs', blurb: 'Extra parts for your avatar badge.' },
  { id: 'crest', name: 'Unit crests', blurb: 'How your unit’s crest looks to everyone. The Commander picks from what the unit owns.' },
];

/**
 * Whether `cosmetic` is available. `ctx`: { level, titles (Set), owned (Set of
 * cosmetic ids granted to this player or, for crests, the unit), unitWarWins }.
 */
function isUnlocked(cosmetic, { level = 1, titles = new Set(), owned = new Set(), unitWarWins = 0 } = {}) {
  if (owned.has(cosmetic.id)) return true;
  const u = cosmetic.unlock || {};
  if (u.level) return level >= u.level;
  if (u.title) return titles.has(u.title);
  if (u.unitWars) return unitWarWins >= u.unitWars;
  return false; // premium: only when granted
}

/** How to get it, in words. */
function howText(cosmetic) {
  const u = cosmetic.unlock || {};
  if (u.level) return `Reach level ${u.level}`;
  if (u.title) {
    const t = require('./titles').TITLES_BY_ID.get(u.title);
    return t ? `Earn the “${t.name}” title` : 'Earn a title';
  }
  if (u.unitWars) return `Your unit wins ${u.unitWars} wars`;
  return 'Supporter item';
}

/** Inline style for a callsign in this colour ('' for the default). The value only ever comes from this catalogue. */
function nameStyle(id) {
  const c = id && BY_ID.get(id);
  return c && c.kind === 'name' ? `color:${c.hex}` : '';
}

/** CSS class for a profile banner or unit crest ('' for the default). */
function cssClass(prefix, id, kind) {
  const c = id && BY_ID.get(id);
  return c && c.kind === kind ? `${prefix}--${c.id}` : '';
}

module.exports = { BY_ID, COSMETICS, KINDS, cssClass, howText, isUnlocked, nameStyle };
