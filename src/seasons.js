'use strict';

/**
 * PvP seasons. Pure rules: ratings, divisions, rewards and the soft reset.
 *
 * Every player starts a season at a rating (1,000 the first time). Ranked
 * fights move it with an Elo formula: beating someone rated above you earns
 * more than beating someone below. A fight is ranked only when it paid full
 * rewards to both sides, so linked accounts and repeat wins on the same
 * target never move ratings. Defenders didn't pick the fight, so their
 * rating moves a little less than the attacker's.
 *
 * Seasons last four weeks. At the end, everyone with enough ranked fights is
 * placed, ranked and paid by division; the next season starts them halfway
 * between their final rating and 1,000.
 */

const tuning = require('./tuning');

const DAY = 24 * 60 * 60 * 1000;
const SEASON_DAYS = 28;
const START_RATING = 1000;
const RATING_FLOOR = 100;
const PLACEMENT_FIGHTS = 5; // default ranked fights needed to appear in the standings and earn rewards
const K_ATTACKER = 32;
const K_DEFENDER = 20;
// Live values from Admin › Game settings.
const placementFights = () => tuning.get('seasonPlacementFights');
const seasonDays = () => tuning.get('seasonDays');
const CARRY_OVER = 0.5; // share of last season's distance from 1,000 that carries over

const DIVISIONS = [
  { id: 'bronze', name: 'Bronze', min: 0, cash: 1000, xp: 100 },
  { id: 'silver', name: 'Silver', min: 1050, cash: 3000, xp: 250 },
  { id: 'gold', name: 'Gold', min: 1200, cash: 8000, xp: 600 },
  { id: 'elite', name: 'Elite', min: 1350, cash: 20000, xp: 1500 },
];
const DIVISIONS_BY_ID = new Map(DIVISIONS.map((d) => [d.id, d]));

// Extra cash for the top of the final standings.
const PODIUM = [25000, 15000, 10000];
const TOP_BADGE = 10; // the top 10 get a "Top 10" mark on their profile

/** The division a rating falls in. */
function divisionFor(rating) {
  let out = DIVISIONS[0];
  for (const d of DIVISIONS) if (rating >= d.min) out = d;
  return out;
}

/** Progress to the next division: { next, needed, pct }, or null at the top. */
function progressFor(rating) {
  const i = DIVISIONS.indexOf(divisionFor(rating));
  const next = DIVISIONS[i + 1];
  if (!next) return null;
  const from = DIVISIONS[i].min;
  return { next, needed: next.min - rating, pct: Math.max(0, Math.min(100, Math.round(((rating - from) / (next.min - from)) * 100))) };
}

/** Chance that a player rated `a` beats one rated `b`. */
const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

/**
 * Rating changes for a ranked fight. Returns { attacker, defender } deltas
 * (whole numbers; the winner always gains at least 1).
 */
function ratingChange(attackerRating, defenderRating, attackerWon) {
  const ea = expected(attackerRating, defenderRating);
  const sa = attackerWon ? 1 : 0;
  const atk = Math.round(K_ATTACKER * (sa - ea));
  const def = Math.round(K_DEFENDER * ((1 - sa) - (1 - ea)));
  return {
    attacker: attackerWon ? Math.max(1, atk) : Math.min(-1, atk),
    defender: attackerWon ? Math.min(-1, def) : Math.max(1, def),
  };
}

/** Applies a delta, keeping the rating above the floor. */
const applyDelta = (rating, delta) => Math.max(RATING_FLOOR, rating + delta);

/** Where a player starts a new season, given last season's final rating (or none). */
function startingRating(previous) {
  if (previous == null) return START_RATING;
  return Math.round(START_RATING + (previous - START_RATING) * CARRY_OVER);
}

/** Whether a fight counts for the season, from anti-cheat's reward plan. */
const isRanked = (rewards) => rewards.attacker === 1 && rewards.defender === 1;

/** End-of-season reward for a placed player at `rank` (1-based) with `rating`. */
function rewardFor(rating, rank) {
  const d = divisionFor(rating);
  const mult = tuning.get('seasonRewardsMult'); // Admin › Game settings
  return { division: d, cash: Math.round((d.cash + (PODIUM[rank - 1] || 0)) * mult), xp: Math.round(d.xp * mult) };
}

/** Badge text for a past result, e.g. "S2 Champion", "S3 · Top 10 · Gold". */
function badgeFor(result) {
  const d = DIVISIONS_BY_ID.get(result.division) || DIVISIONS[0];
  if (result.rank === 1) return { label: `S${result.number} Champion`, division: d.id, tier: 'champion' };
  if (result.rank <= TOP_BADGE) return { label: `S${result.number} · Top ${TOP_BADGE} · ${d.name}`, division: d.id, tier: 'top' };
  return { label: `S${result.number} · ${d.name}`, division: d.id, tier: null };
}

module.exports = {
  CARRY_OVER, DAY, DIVISIONS, DIVISIONS_BY_ID, K_ATTACKER, K_DEFENDER, PLACEMENT_FIGHTS, PODIUM, RATING_FLOOR,
  SEASON_DAYS, START_RATING, TOP_BADGE,
  applyDelta, badgeFor, placementFights, seasonDays, divisionFor, expected, isRanked, progressFor, ratingChange, rewardFor, startingRating,
};
