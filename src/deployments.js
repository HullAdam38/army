'use strict';

/**
 * Deployments: timed patrols that earn while the player is away. Pure rules.
 *
 * Balance: they cost no energy, but while deployed you can't run missions,
 * operations, training, scouting or attacks, and per-hour pay is well below
 * active play (longer patrols pay a little less per hour). A rolling cap of
 * 16 deployed hours per 24 keeps active play the main way to progress. While
 * deployed you're out of reach: nobody can attack you.
 */

const HOUR = 60 * 60 * 1000;
const DAILY_CAP_HOURS = 16;
const INJURY_CHANCE = 0.1;
const FIND_CHANCE = 0.25;

const KINDS = [
  { id: 'patrol', name: 'Perimeter patrol', hours: 1, efficiency: 1, minLevel: 1, blurb: 'A quick loop of the wire. Back within the hour.' },
  { id: 'recon', name: 'Recon sweep', hours: 4, efficiency: 0.9, minLevel: 1, blurb: 'Scout the hills beyond the line and report back.' },
  { id: 'long-range', name: 'Long-range patrol', hours: 8, efficiency: 0.8, minLevel: 5, blurb: 'Days’ worth of ground in a single shift. Ideal overnight.' },
  { id: 'extended', name: 'Extended deployment', hours: 12, efficiency: 0.7, minLevel: 15, blurb: 'Hold a remote outpost for half a day.' },
];

const KINDS_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

// What can happen out there, by campaign. Picked at random for the report.
const STORIES = [
  'The route was quiet. Nothing moved but the wind.',
  'Spotted an enemy scout team and shadowed them until they withdrew.',
  'Helped a stranded supply truck back onto the road.',
  'Mapped a new path through the minefield for the engineers.',
  'Traded intel with a friendly patrol at the river crossing.',
  'Waited out a storm in a ruined farmhouse, then pushed on.',
];

/** Base pay per hour for a level, before perks and events. */
const hourlyRate = (level) => ({ cash: 60 + 30 * level, xp: 8 + 3 * level });

/** Expected reward for a deployment kind (no random finds). */
function rewardFor(kind, level, { cashMult = 1, xpMult = 1 } = {}) {
  const rate = hourlyRate(level);
  return {
    cash: Math.round(rate.cash * kind.hours * kind.efficiency * cashMult),
    xp: Math.round(rate.xp * kind.hours * kind.efficiency * xpMult),
  };
}

/** Hours already used in the rolling 24-hour window, given recent deployments. */
function hoursUsed(recent, now = Date.now()) {
  const since = now - 24 * HOUR;
  return recent.reduce((sum, d) => {
    const end = d.status === 'recalled' ? d.returned_at : d.ends_at;
    const start = Math.max(d.started_at, since);
    return end > start ? sum + (end - start) / HOUR : sum;
  }, 0);
}

/** Why `player` can't start `kind` now, or null. `used` = hours used in the last 24. */
function deployBlocker(player, kind, used, now = Date.now()) {
  if (!kind) return 'Pick a deployment';
  if (player.deploy_until && player.deploy_until > now) return 'You’re already deployed';
  if (player.hospital_until && player.hospital_until > now) return 'You’re in hospital';
  if (player.level < kind.minLevel) return `Unlocks at level ${kind.minLevel}`;
  if (player.health < Math.ceil(player.max_health * 0.25)) return 'Too injured to deploy. Heal up first';
  if (used + kind.hours > DAILY_CAP_HOURS + 1e-9) {
    const left = Math.max(0, DAILY_CAP_HOURS - used);
    return left >= 1 ? `Only ${Math.floor(left)}h of deployment left today` : 'You’ve used today’s 16 hours of deployments';
  }
  return null;
}

/**
 * Rolls what happened on a finished deployment: the reward, an optional
 * bonus find and an optional injury. `rng` returns [0, 1).
 */
function resolve(kind, player, { cashMult = 1, xpMult = 1, rng = Math.random } = {}) {
  const reward = rewardFor(kind, player.level, { cashMult, xpMult });
  const out = { cash: reward.cash, xp: reward.xp, find: null, injury: 0, story: STORIES[Math.floor(rng() * STORIES.length)] };
  if (rng() < FIND_CHANCE) {
    const bonus = Math.round(reward.cash * 0.5);
    out.cash += bonus;
    out.find = `Found an abandoned supply cache worth $${bonus.toLocaleString('en-US')}.`;
  }
  if (rng() < INJURY_CHANCE) {
    out.injury = Math.round(player.max_health * 0.2);
  }
  return out;
}

module.exports = { DAILY_CAP_HOURS, HOUR, KINDS, KINDS_BY_ID, deployBlocker, hourlyRate, hoursUsed, resolve, rewardFor };
