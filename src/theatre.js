'use strict';

/**
 * Theatre of war (pure): a map of regions held by units. Each week a unit's
 * Lieutenants pick one region as its front, and members' play scores points
 * there. When the week ends, the unit with the most points in a region takes
 * it. Holders get a daily treasury income and, for some regions, a mission XP
 * bonus for every member.
 */

const { weekKey, WEEK_MS } = require('./objectives');

const MIN_MEMBERS = 3; // to open a front
const HOLDER_BONUS = 0.25; // a holder's points defending its own region count this much extra
const FRONT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_XP_BONUS = 0.06; // region XP bonuses stack up to this

// What each kind of play scores on the unit's front.
const POINTS = { missions: 1, training: 1, pvp_wins: 3, deployments: 3, raid_strikes: 2 };
const POINT_LABELS = [
  ['missions', 'mission won'],
  ['training', 'training session'],
  ['pvp_wins', 'PvP win as the attacker'],
  ['deployments', 'deployment brought back'],
  ['raid_strikes', 'raid strike'],
];

// The map is drawn on a 400 × 260 grid. Neighbouring regions share edges exactly.
const REGIONS = [
  { id: 'coast', short: 'Coast', name: 'Iron Coast', income: 3000, xp: 0, points: '0,0 110,0 120,60 95,120 0,110', label: [52, 55] },
  { id: 'ridge', short: 'Ridge', name: 'Northern Ridge', income: 2500, xp: 0.02, points: '110,0 250,0 240,55 170,75 120,60', label: [178, 32] },
  { id: 'steppe', short: 'Steppe', name: 'Frost Steppe', income: 3500, xp: 0, points: '250,0 400,0 400,100 300,95 240,55', label: [330, 48] },
  { id: 'port', short: 'Port', name: 'Port Valen', income: 4000, xp: 0, points: '0,110 95,120 110,190 60,260 0,260', label: [48, 182] },
  { id: 'capital', short: 'Capital', name: 'Capital District', income: 6000, xp: 0.03, points: '95,120 120,60 170,75 240,55 300,95 275,150 195,170 110,190', label: [195, 118] },
  { id: 'desert', short: 'Desert', name: 'Red Desert', income: 3000, xp: 0.01, points: '110,190 195,170 230,260 60,260', label: [152, 228] },
  { id: 'delta', short: 'Delta', name: 'Delta Marshes', income: 2500, xp: 0.02, points: '195,170 275,150 330,200 320,260 230,260', label: [268, 215] },
  { id: 'pass', short: 'Pass', name: 'Highland Pass', income: 3500, xp: 0, points: '300,95 400,100 400,260 320,260 330,200 275,150', label: [343, 176] },
];
const REGIONS_BY_ID = new Map(REGIONS.map((r) => [r.id, r]));

// Map colours for units that aren't yours (yours is always the accent colour).
const PALETTE = ['#5f8f3e', '#3f7fbf', '#b8433a', '#c9a227', '#7b5ea7', '#2e9e8f', '#a0527a', '#6d7f8c'];
const colorFor = (unitId) => PALETTE[(unitId - 1) % PALETTE.length];

/** Mission XP bonus for a unit holding `regionIds`. */
function xpBonus(regionIds) {
  const total = regionIds.reduce((n, id) => n + ((REGIONS_BY_ID.get(id) || {}).xp || 0), 0);
  return Math.min(MAX_XP_BONUS, total);
}

/** Points a unit's score counts for in a region, with the holder's home advantage. */
const effectivePoints = (points, isHolder) => (isHolder ? Math.floor(points * (1 + HOLDER_BONUS)) : points);

/**
 * Who holds a region after a week. `scores` is [{ unit_id, points }] for units
 * that still exist; `holder` is the current holder's unit id or null. Returns
 * the new holder's unit id (unchanged when nobody beats the holder outright).
 */
function decide(scores, holder) {
  const ranked = scores
    .map((s) => ({ unitId: s.unit_id, points: effectivePoints(s.points, s.unit_id === holder) }))
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points);
  if (!ranked.length) return holder;
  const top = ranked.filter((s) => s.points === ranked[0].points);
  if (top.length > 1) return holder; // a tie never changes hands
  return top[0].unitId;
}

/** Why a unit can't open a front in `regionId` right now, or null. */
function frontBlocker({ members, current, setAt }, regionId, now = Date.now()) {
  if (!REGIONS_BY_ID.has(regionId)) return 'Pick a region';
  if (members < MIN_MEMBERS) return `A unit needs at least ${MIN_MEMBERS} members to open a front`;
  if (current === regionId) return 'That’s already your front';
  if (current && setAt + FRONT_COOLDOWN_MS > now) {
    const hours = Math.ceil((setAt + FRONT_COOLDOWN_MS - now) / 3_600_000);
    return `You can move the front again in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return null;
}

module.exports = {
  FRONT_COOLDOWN_MS,
  HOLDER_BONUS,
  MAX_XP_BONUS,
  MIN_MEMBERS,
  POINTS,
  POINT_LABELS,
  REGIONS,
  REGIONS_BY_ID,
  WEEK_MS,
  colorFor,
  decide,
  effectivePoints,
  frontBlocker,
  weekKey,
  xpBonus,
};
