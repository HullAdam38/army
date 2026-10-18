'use strict';

/**
 * Game settings that admins can change at runtime (Admin › Game settings).
 *
 * SETTINGS is the registry: every tunable value with its default, limits and
 * help text. The live values sit in this module; settings-service.js loads
 * them from the database at startup and replaces them whenever an admin
 * saves. Game rules read them through get(), so a change applies at once,
 * with no restart.
 *
 * Multipliers stack with everything else: base × (1 + unit and rank-perk
 * bonuses) × live event × the admin multiplier here.
 */

const SETTINGS = [
  // Economy
  { key: 'missionCashMult', group: 'economy', label: 'Mission & operation pay', type: 'mult', min: 0.25, max: 3, step: 0.05, default: 1, help: 'Multiplies the cash every mission and operation stage pays out.' },
  { key: 'missionXpMult', group: 'economy', label: 'Mission & operation XP', type: 'mult', min: 0.25, max: 3, step: 0.05, default: 1, help: 'Multiplies the XP from missions and operation stages, so how fast players level up.' },
  { key: 'deploymentPayMult', group: 'economy', label: 'Deployment pay & XP', type: 'mult', min: 0, max: 3, step: 0.05, default: 1, help: 'Multiplies what offline deployments pay. 0 pays nothing.' },
  { key: 'dailyRewardsMult', group: 'economy', label: 'Daily orders & supply drops', type: 'mult', min: 0, max: 3, step: 0.05, default: 1, help: 'Multiplies daily order rewards and the daily supply drop.' },
  { key: 'seasonRewardsMult', group: 'economy', label: 'PvP season rewards', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies the end-of-season cash and XP (division rewards and podium bonuses).' },
  { key: 'warPrizeMult', group: 'economy', label: 'Unit war prizes', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies what a unit wins at the end of a war.' },
  { key: 'unitObjectiveRewardMult', group: 'economy', label: 'Unit objective rewards', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies what a completed weekly unit objective pays into the treasury and the XP each helping member gets. Applies to objectives set after you change it.' },
  { key: 'raidRewardMult', group: 'economy', label: 'Unit raid loot', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies the cash and XP a defeated raid stronghold pays out. Applies to raids launched after you change it.' },
  { key: 'theatreIncomeMult', group: 'economy', label: 'Theatre of war income', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies the daily treasury income units get for each region they hold on the theatre of war map. 0 turns it off.' },
  { key: 'targetBonusMult', group: 'economy', label: 'High-value target bonus', type: 'mult', min: 0, max: 5, step: 0.05, default: 1, help: 'Multiplies the bonus for beating the daily high-value target, and what the target earns for each attack they fight off.' },
  { key: 'depositFeePct', group: 'economy', label: 'Bank deposit fee', type: 'number', unit: '%', min: 0, max: 10, step: 0.1, default: 2, help: 'The base fee for banking cash. Each Vault level still takes 0.5 points off.' },

  // Pace
  { key: 'energyRegenMinutes', group: 'pace', label: 'Energy regeneration', type: 'number', unit: 'min per point', min: 0.5, max: 10, step: 0.5, default: 2, help: 'Minutes for one energy point to come back. Lower is faster and lets players do more each day.' },
  { key: 'hospitalStayMinutes', group: 'pace', label: 'Hospital stay after a knockout', type: 'int', unit: 'min', min: 1, max: 120, step: 1, default: 10, help: 'How long a knocked-out soldier stays in hospital.' },
  { key: 'deploymentCapHours', group: 'pace', label: 'Deployment hours per day', type: 'int', unit: 'h per 24h', min: 1, max: 24, step: 1, default: 16, help: 'The most deployed hours a player can use in any rolling 24 hours.' },
  { key: 'raidCooldownHours', group: 'pace', label: 'Wait between raids', type: 'int', unit: 'h', min: 0, max: 168, step: 1, default: 24, help: 'How long a unit waits after a raid ends (won or failed) before it can launch the next. Raids HQ calls off don’t count. 0 means no wait.' },

  // PvP seasons
  { key: 'seasonPlacementFights', group: 'seasons', label: 'Placement fights', type: 'int', unit: 'fights', min: 1, max: 50, step: 1, default: 5, help: 'Ranked fights a player needs to appear in the standings and earn season rewards.' },
  { key: 'seasonDays', group: 'seasons', label: 'Season length', type: 'int', unit: 'days', min: 7, max: 90, step: 1, default: 28, help: 'Applies to seasons that start after you change it; the running season keeps its end date.' },

  // Chat
  { key: 'chatCooldownSeconds', group: 'chat', label: 'Chat cooldown', type: 'int', unit: 's', min: 0, max: 120, step: 1, default: 3, help: 'Minimum time between one player’s chat messages. Raise it to calm a busy channel (slow mode).' },
  { key: 'chatMinLevel', group: 'chat', label: 'Level needed to chat', type: 'int', unit: 'level', min: 1, max: 20, step: 1, default: 2, help: 'New accounts below this level can read chat but not post.' },

  // Avatars
  { key: 'avatarUploadsOpen', group: 'avatars', label: 'Picture uploads', type: 'bool', default: true, help: 'Let players upload their own picture as an avatar. Turn off to allow badges only; pictures already uploaded stay until you remove them.' },
  { key: 'avatarUploadMinLevel', group: 'avatars', label: 'Level needed to upload', type: 'int', unit: 'level', min: 1, max: 50, step: 1, default: 3, help: 'Players below this level can build a badge but not upload a picture. Keeps throwaway accounts from posting pictures.' },

  // Access
  { key: 'registrationOpen', group: 'access', label: 'New sign-ups', type: 'bool', default: true, help: 'Turn off to stop new accounts being created (for example during maintenance or a spam wave). Existing players can still sign in.' },
  { key: 'signupsPerIpPerDay', group: 'access', label: 'Sign-ups per network a day', type: 'int', unit: 'accounts', min: 1, max: 100, step: 1, default: 3, help: 'How many new accounts can be made from one internet connection in 24 hours. Stops one person (or a script) filling the game with accounts; households and schools sharing a connection may need more.' },

  // Casino
  { key: 'casinoOpen', group: 'casino', label: 'Casino open', type: 'bool', default: true, help: 'Turn off to close the casino for everyone (for example while you look into a problem). Bets already settled are kept.' },
  { key: 'casinoMinLevel', group: 'casino', label: 'Casino minimum level', type: 'int', unit: 'level', min: 1, max: 50, step: 1, default: 3, help: 'Players below this level can’t play casino games, so new players learn the game first.' },
  { key: 'slotsMaxBet', group: 'casino', label: 'Slot machine maximum bet', type: 'int', unit: '$', min: 100, max: 1000000, step: 100, default: 10000, help: 'The most a player can bet on one spin. The slot machine pays back about 95% of bets over time, so it takes cash out of the game.' },
  { key: 'rouletteMaxBet', group: 'casino', label: 'Roulette table limit', type: 'int', unit: '$', min: 100, max: 1000000, step: 100, default: 10000, help: 'The most a player can have on the table in one spin (all their bets added up). Roulette pays back 97.3% of bets over time.' },
  { key: 'blackjackMaxBet', group: 'casino', label: 'Blackjack maximum bet', type: 'int', unit: '$', min: 100, max: 1000000, step: 100, default: 25000, help: 'The most a player can bet on one blackjack hand at the War Room table (the other tables have lower limits of their own). Doubling and splitting can add the same again.' },
  // Armory
  { key: 'gearWearMult', group: 'armory', label: 'Gear wear', type: 'mult', min: 0, max: 5, step: 0.1, default: 1, help: 'How fast gear wears with use. At 1 a weapon drops about half a point a mission and a point a fight; below 50% condition gear starts losing power. 0 turns wear off.' },
  { key: 'gearRepairShare', group: 'armory', label: 'Repair cost', type: 'number', unit: '× price', min: 0, max: 2, step: 0.05, default: 0.3, help: 'A full repair from 0% costs this share of the item’s price (pro rata: from 50% it costs half that). Repairs take cash out of the game.' },
  { key: 'gearSellShare', group: 'armory', label: 'Sale price', type: 'number', unit: '× price', min: 0, max: 0.9, step: 0.05, default: 0.4, help: 'What the Armory pays for gear in perfect condition, as a share of its price. Worn gear fetches less: half as much at 0%. Keep it well under 1 so buying and selling never makes money.' },

  // Living world
  { key: 'reserveSoldiers', group: 'world', label: 'Reserve soldiers', type: 'int', unit: 'soldiers', min: 0, max: 200, step: 1, default: 30, help: 'Soldiers run by the game, marked “Reserve”, so new players have targets, rivals on the leaderboards and starter units to join. One stands down for every real player active in the last week; 0 stands them all down.' },
  { key: 'reserveMaxLevel', group: 'world', label: 'Reserve soldiers’ top level', type: 'int', unit: 'level', min: 5, max: 100, step: 1, default: 30, help: 'Reserve soldiers stop levelling up here, so real players overtake them.' },
  { key: 'chatNews', group: 'world', label: 'News in global chat', type: 'bool', default: true, help: 'Short announcements in Global chat: promotions to officer ranks and above, units founded, wars and raids won.' },
  // Recruit a friend
  { key: 'referralLevel', group: 'recruit', label: 'Level a recruit must reach', type: 'int', unit: 'level', min: 2, max: 50, step: 1, default: 10, help: 'The reward is paid when the friend gets here, so it takes real play, not just a sign-up.' },
  { key: 'referralCash', group: 'recruit', label: 'Reward for the recruiter', type: 'int', unit: '$', min: 0, max: 1000000, step: 100, default: 2500, help: 'Cash paid to whoever sent the invite link. Never paid when the two accounts share a device or network.' },
  { key: 'referralXp', group: 'recruit', label: 'XP for the recruiter', type: 'int', unit: 'XP', min: 0, max: 100000, step: 10, default: 250, help: 'XP paid alongside the cash.' },
  { key: 'referralRecruitCash', group: 'recruit', label: 'Bonus for the recruit', type: 'int', unit: '$', min: 0, max: 1000000, step: 100, default: 1000, help: 'Cash for the new player when they reach the level.' },
  { key: 'referralMaxPerMonth', group: 'recruit', label: 'Rewards per recruiter a month', type: 'int', unit: 'recruits', min: 0, max: 100, step: 1, default: 10, help: 'Most recruits one player can be rewarded for in 30 days. Recruits past the cap still join; they just don’t pay.' },
  { key: 'casinoShoutMin', group: 'casino', label: 'Big-win shout in chat', type: 'int', unit: '$', min: 0, max: 10000000, step: 100, default: 10000, help: 'A casino win of at least this much (after the bet) is announced in global chat. 0 turns the announcements off.' },
];

const GROUPS = [
  { id: 'economy', name: 'Economy', blurb: 'How much things pay. These stack with rank perks, unit bonuses and live events.' },
  { id: 'pace', name: 'Pace', blurb: 'How fast players can act.' },
  { id: 'seasons', name: 'PvP seasons', blurb: 'Ranked season rules.' },
  { id: 'chat', name: 'Chat', blurb: 'Limits for game chat.' },
  { id: 'avatars', name: 'Avatars', blurb: 'Who can upload their own picture.' },
  { id: 'access', name: 'Access', blurb: 'Who can join.' },
  { id: 'casino', name: 'Casino', blurb: 'Games played with in-game cash.' },
  { id: 'armory', name: 'Armory', blurb: 'Gear wear, repairs and selling.' },
  { id: 'world', name: 'Living world', blurb: 'Keeps a young game from feeling empty.' },
  { id: 'recruit', name: 'Recruit a friend', blurb: 'Rewards for bringing new players in.' },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const DEFAULTS = Object.freeze(Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])));

let current = { ...DEFAULTS };

/** Live value of a setting. */
function get(key) {
  if (!BY_KEY.has(key)) throw new Error(`Unknown game setting: ${key}`);
  return current[key];
}

/** Replaces the live values (unknown keys are ignored, missing keys use defaults). */
function set(values = {}) {
  const next = { ...DEFAULTS };
  for (const [k, v] of Object.entries(values)) if (BY_KEY.has(k)) next[k] = v;
  current = next;
}

const all = () => ({ ...current });
const reset = () => { current = { ...DEFAULTS }; };

/** Turns a submitted value into a setting value. Returns { value } or { error }. */
function parse(setting, raw) {
  if (setting.type === 'bool') return { value: raw === true || raw === '1' || raw === 'on' || raw === 'true' };
  const text = String(raw ?? '').trim().replace(/[,%×x\s]/g, '');
  if (!text) return { error: `${setting.label}: enter a value.` };
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `${setting.label}: “${raw}” isn’t a number.` };
  if (setting.type === 'int' && !Number.isInteger(n)) return { error: `${setting.label}: use a whole number.` };
  if (n < setting.min || n > setting.max) return { error: `${setting.label}: must be between ${setting.min} and ${setting.max}.` };
  // Snap to the step so 1.0500000001 and friends don't creep in.
  const snapped = Math.round(n / setting.step) * setting.step;
  return { value: Number(snapped.toFixed(4)) };
}

/** How a value reads in the admin page and audit log, e.g. "×1.5", "2 min per point", "on". */
function format(setting, value) {
  if (setting.type === 'bool') return value ? 'on' : 'off';
  if (setting.type === 'mult') return `×${Number(value)}`;
  return `${Number(value)}${setting.unit ? (setting.unit === '%' ? '%' : ` ${setting.unit}`) : ''}`;
}

module.exports = { BY_KEY, DEFAULTS, GROUPS, SETTINGS, all, format, get, parse, reset, set };
