'use strict';

/**
 * Weekly unit objectives (pure): three shared goals per unit each week
 * (Monday to Monday, UTC). Every member's normal play counts towards them.
 * Completing one pays the unit treasury, and XP to each member who helped.
 */

const tuning = require('./tuning');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_UNIT = 3;
const NUDGE_AT = 0.8; // members hear when an objective is this close
const MIN_SHARE = 0.02; // XP goes to members who did at least this share (so $1 donations don't count)
const MIN_MEMBERS = 3; // targets assume at least this many, so tiny units still have to work for it
const MAX_MEMBERS = 30;

/** A deployment-hour of pay at a level: the yardstick for objective rewards. */
const hourPay = (level) => 25 + 14 * level;
const hourXp = (level) => 5 + 2 * level;

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const round = (n, step) => Math.max(step, Math.round(n / step) * step);

// `metric` is what game actions report (see objective-service.track). `per` is the target per member.
const TYPES = [
  { id: 'missions', metric: 'missions', name: 'Mission sweep', icon: 'i-target', target: (m) => round(25 * m, 5), text: (n) => `Complete ${n.toLocaleString('en-US')} missions or operation stages` },
  { id: 'pvp', metric: 'pvp_wins', name: 'Show of force', icon: 'i-crest', target: (m) => round(6 * m, 1), text: (n) => `Win ${n.toLocaleString('en-US')} PvP fights as the attacker` },
  { id: 'deployments', metric: 'deployments', name: 'Boots on the ground', icon: 'i-kit', target: (m) => round(4 * m, 1), text: (n) => `Bring back ${n.toLocaleString('en-US')} deployments` },
  { id: 'training', metric: 'training', name: 'Drill week', icon: 'i-chevrons', target: (m) => round(8 * m, 1), text: (n) => `Complete ${n.toLocaleString('en-US')} training sessions` },
  { id: 'donations', metric: 'donations', name: 'War chest', icon: 'i-cash', target: (m, level) => round(10 * m * hourPay(level), 1000), text: (n) => `Donate ${money(n)} to the treasury` },
];
const TYPES_BY_ID = new Map(TYPES.map((t) => [t.id, t]));

/** The Monday (UTC) that starts the week containing `ms`, as YYYY-MM-DD. */
function weekKey(ms = Date.now()) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
const weekEnds = (key) => Date.parse(`${key}T00:00:00Z`) + WEEK_MS;

// Small deterministic hash, so a unit's objectives don't change on restart.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * This week's objectives for a unit: PER_UNIT different types, with targets
 * and treasury rewards scaled by its size and average level.
 */
function generate(unitId, week, { members, avgLevel }) {
  const m = Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, members));
  const level = Math.max(1, Math.round(avgLevel));
  const pool = [...TYPES];
  const out = [];
  let seed = hash(`${week}:${unitId}`);
  for (let slot = 0; slot < PER_UNIT; slot += 1) {
    const pick = pool.splice(seed % pool.length, 1)[0];
    seed = hash(`${seed}:${slot}`);
    out.push({ slot, type: pick.id, target: pick.target(m, level), rewardCash: treasuryReward(m, level) });
  }
  return out;
}

function treasuryReward(members, level) {
  const mult = tuning.get('unitObjectiveRewardMult');
  return mult > 0 ? round(12 * members * hourPay(level) * mult, 100) : 0; // 0 switches rewards off
}
/** XP each helping member gets when an objective is completed. */
const memberXp = (level) => Math.round(4 * hourXp(level) * tuning.get('unitObjectiveRewardMult'));

const describe = (o) => {
  const t = TYPES_BY_ID.get(o.type);
  return t ? t.text(o.target) : o.type;
};

module.exports = {
  MIN_SHARE,
  NUDGE_AT,
  PER_UNIT,
  TYPES,
  TYPES_BY_ID,
  WEEK_MS,
  describe,
  generate,
  hourPay,
  hourXp,
  memberXp,
  money,
  weekEnds,
  weekKey,
};
