'use strict';

/**
 * Units (clans). Pure rules: names, roles and permissions, upgrade costs and
 * effects. The treasury only buys upgrades; it never pays out to players, so
 * it can't be used to move money between accounts.
 */

const CREATE_LEVEL = 5;
const CREATE_COST = 2500;
const BASE_CAPACITY = 10;
const MIN_DONATION = 10;
const LEAVE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // after leaving, before joining or founding another
const MAX_PENDING_APPLICATIONS = 3;
const POST_COOLDOWN_MS = 10 * 1000;
const MAX_POST = 500;
const MAX_APPLY_MESSAGE = 200;
const MAX_DESCRIPTION = 300;

const ROLES = {
  leader: { label: 'Commander', rank: 3 },
  officer: { label: 'Officer', rank: 2 },
  member: { label: 'Member', rank: 1 },
};

const UPGRADES = {
  barracks: {
    label: 'Barracks',
    blurb: 'Room for 5 more members per level.',
    costs: [5000, 15000, 40000],
    effect: (lvl) => `${BASE_CAPACITY + 5 * lvl} members`,
  },
  drill: {
    label: 'Drill ground',
    blurb: '+2% mission XP for every member per level.',
    costs: [3000, 8000, 20000, 45000, 90000],
    effect: (lvl) => `+${2 * lvl}% mission XP`,
  },
};

const capacity = (unit) => BASE_CAPACITY + 5 * (unit.barracks || 0);
const xpBonus = (unit) => (unit ? 0.02 * (unit.drill || 0) : 0);
const rankOf = (role) => (ROLES[role] ? ROLES[role].rank : 0);
const roleLabel = (role) => (ROLES[role] ? ROLES[role].label : role);

/** What a member with `role` may do. */
const can = {
  review: (role) => rankOf(role) >= 2, // accept / reject applications
  moderate: (role) => rankOf(role) >= 2, // delete other members' posts
  manage: (role) => role === 'leader', // settings, upgrades, promotions, disband
  kick: (actorRole, targetRole) => rankOf(actorRole) >= 2 && rankOf(actorRole) > rankOf(targetRole),
};

const squash = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/** Validates the founding form. Returns { error } or { name, tag, description }. */
function validateUnit({ name, tag, description }) {
  name = squash(name);
  tag = String(tag || '').trim().toUpperCase();
  description = String(description || '').trim().replace(/\r\n/g, '\n');
  if (name.length < 3 || name.length > 24) return { error: 'Unit names are 3–24 characters.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 '\-]*$/.test(name)) return { error: 'Unit names can use letters, numbers, spaces, hyphens and apostrophes.' };
  if (!/^[A-Z0-9]{2,4}$/.test(tag)) return { error: 'Tags are 2–4 letters or numbers.' };
  if (description.length > MAX_DESCRIPTION) return { error: `Keep the description under ${MAX_DESCRIPTION} characters.` };
  return { name, tag, description };
}

/** Why `player` can't found a unit right now, or null. */
function foundBlocker(player, now = Date.now()) {
  if (player.unit_id) return 'You’re already in a unit. Leave it first.';
  if (player.level < CREATE_LEVEL) return `Founding a unit unlocks at level ${CREATE_LEVEL}.`;
  if (player.cash < CREATE_COST) return `Founding a unit costs $${CREATE_COST.toLocaleString('en-US')} cash.`;
  return cooldownBlocker(player, now);
}

function cooldownBlocker(player, now = Date.now()) {
  if (player.unit_left_at && now - player.unit_left_at < LEAVE_COOLDOWN_MS) {
    const hours = Math.ceil((LEAVE_COOLDOWN_MS - (now - player.unit_left_at)) / 3_600_000);
    return `You left a unit recently. You can join another in ${hours} hour${hours === 1 ? '' : 's'}.`;
  }
  return null;
}

/** Requirement fields a Commander can set, with their upper limits. */
const REQUIREMENTS = {
  min_level: { label: 'Level', max: 100, short: (n) => `Lv ${n}+` },
  min_pvp_wins: { label: 'PvP wins', max: 10000, short: (n) => `${n}+ PvP wins` },
  min_missions: { label: 'Missions won', max: 100000, short: (n) => `${n}+ missions` },
};
const PLAYER_FIELD = { min_level: 'level', min_pvp_wins: 'pvp_wins', min_missions: 'missions_completed' };

/** Parses the requirements form. Blank means no requirement. Returns { error } or { min_level, … }. */
function parseRequirements(body) {
  const out = {};
  for (const [key, def] of Object.entries(REQUIREMENTS)) {
    const raw = String(body[key] ?? '').trim();
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > def.max) return { error: `${def.label} requirement must be a whole number from 0 to ${def.max.toLocaleString('en-US')}.` };
    out[key] = n;
  }
  return out;
}

/** The requirements `unit` has set, as short labels ("Lv 10+"). */
function requirementList(unit) {
  return Object.entries(REQUIREMENTS).filter(([key]) => unit[key] > 0).map(([key, def]) => ({ key, text: def.short(unit[key]) }));
}

/** The first requirement `player` doesn't meet, as a sentence, or null. */
function unmetRequirement(player, unit) {
  for (const [key, def] of Object.entries(REQUIREMENTS)) {
    const have = player[PLAYER_FIELD[key]] || 0;
    if (unit[key] > 0 && have < unit[key]) return `${unit.name} requires ${def.short(unit[key])}. You have ${have.toLocaleString('en-US')}.`;
  }
  return null;
}

/** Why `player` can't apply to `unit`, or null. */
function applyBlocker(player, unit, { members, pending, alreadyApplied }, now = Date.now()) {
  if (player.unit_id === unit.id) return 'You’re already in this unit.';
  if (player.unit_id) return 'You’re already in a unit. Leave it first.';
  if (!unit.recruiting) return `${unit.name} isn’t taking applications right now.`;
  if (members >= capacity(unit)) return `${unit.name} is full.`;
  const unmet = unmetRequirement(player, unit);
  if (unmet) return unmet;
  if (alreadyApplied) return 'Your application is already with their officers.';
  if (pending >= MAX_PENDING_APPLICATIONS) return `You can have ${MAX_PENDING_APPLICATIONS} applications open at once. Withdraw one first.`;
  return cooldownBlocker(player, now);
}

/** The next upgrade level and its cost, or null when maxed. */
function nextUpgrade(unit, key) {
  const def = UPGRADES[key];
  if (!def) return null;
  const level = unit[key] || 0;
  if (level >= def.costs.length) return null;
  return { key, level: level + 1, cost: def.costs[level] };
}

/** Parses a donation amount ("1,500", "all"). Returns { error } or { amount }. */
function parseDonation(input, cash) {
  const raw = String(input || '').trim().toLowerCase();
  const amount = raw === 'all' ? cash : Math.floor(Number(raw.replace(/[,$\s]/g, '')));
  if (!Number.isFinite(amount) || amount < MIN_DONATION) return { error: `Donate at least $${MIN_DONATION}.` };
  if (amount > cash) return { error: 'You don’t have that much cash on hand.' };
  return { amount };
}

module.exports = {
  BASE_CAPACITY,
  CREATE_COST,
  CREATE_LEVEL,
  LEAVE_COOLDOWN_MS,
  MAX_APPLY_MESSAGE,
  MAX_DESCRIPTION,
  MAX_PENDING_APPLICATIONS,
  MAX_POST,
  MIN_DONATION,
  POST_COOLDOWN_MS,
  REQUIREMENTS,
  ROLES,
  UPGRADES,
  applyBlocker,
  can,
  capacity,
  cooldownBlocker,
  foundBlocker,
  nextUpgrade,
  parseDonation,
  parseRequirements,
  rankOf,
  requirementList,
  roleLabel,
  unmetRequirement,
  validateUnit,
  xpBonus,
};
