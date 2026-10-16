'use strict';

/**
 * Titles: earnable names a player can show under their callsign (on their
 * profile and in chat). Pure rules: each title tests the same career metrics
 * the medals use (src/medal-service.js), so nothing new has to be tracked.
 * Once earned, a title stays earned.
 */

const TITLES = [
  { id: 'operator', name: 'Field Operator', how: 'Win 100 missions.', test: (m) => m.missions >= 100 },
  { id: 'ghost', name: 'Ghost', how: 'Come back from 50 deployments.', test: (m) => m.deployments >= 50 },
  { id: 'brawler', name: 'Brawler', how: 'Win 50 PvP fights as the attacker.', test: (m) => m.pvpWins >= 50 },
  { id: 'enforcer', name: 'Enforcer', how: 'Knock out 25 opponents.', test: (m) => m.knockouts >= 25 },
  { id: 'ironwall', name: 'The Wall', how: 'Hold off 50 attacks.', test: (m) => m.defenses >= 50 },
  { id: 'headhunter', name: 'Headhunter', how: 'Collect 10 bounties.', test: (m) => m.bounties >= 10 },
  { id: 'drill', name: 'Drill Sergeant', how: 'Train 150 stat points.', test: (m) => m.training >= 150 },
  { id: 'everpresent', name: 'Ever-Present', how: 'Reach a 30-day supply drop streak.', test: (m) => m.streak >= 30 },
  { id: 'architect', name: 'Architect', how: 'Reach a forward base rating of 15.', test: (m) => m.base >= 15 },
  { id: 'warhero', name: 'War Hero', how: 'Score 100 war points for your unit.', test: (m) => m.warPoints >= 100 },
  { id: 'warlord', name: 'Warlord', how: 'Win 5 unit wars.', test: (m) => m.warsWon >= 5 },
  { id: 'veteran', name: 'Veteran', how: 'Reach level 20.', test: (m) => m.level >= 20 },
  { id: 'contender', name: 'Contender', how: 'Finish a PvP season in Gold or Elite.', test: (m) => m.seasonsGold >= 1 },
  { id: 'topten', name: 'Top Ten', how: 'Finish a PvP season in the top 10.', test: (m) => m.seasonBestRank > 0 && m.seasonBestRank <= 10 },
  { id: 'champion', name: 'Season Champion', how: 'Finish first in a PvP season.', test: (m) => m.seasonBestRank === 1 },
  { id: 'general', name: 'The General', how: 'Reach level 35.', test: (m) => m.level >= 35 },
  { id: 'legend', name: 'Living Legend', how: 'Reach level 50.', test: (m) => m.level >= 50 },
];

const TITLES_BY_ID = new Map(TITLES.map((t) => [t.id, t]));

/** Titles `metrics` qualify for that aren't in `owned` (a Set of ids). */
const newlyEarned = (metrics, owned) => TITLES.filter((t) => !owned.has(t.id) && t.test({ ...metrics }));

/** Display name for a stored title id, or null (unknown or none). */
const nameOf = (id) => (id && TITLES_BY_ID.has(id) ? TITLES_BY_ID.get(id).name : null);

module.exports = { TITLES, TITLES_BY_ID, nameOf, newlyEarned };
