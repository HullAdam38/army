'use strict';

/**
 * Player statistics for Admin › Player stats, built only from data the game
 * already keeps: accounts, active days (player_days), tutorial progress,
 * battles, chat, units, push subscriptions and avatars. All dates are UTC.
 */

const { STEPS, GRADUATION } = require('./tutorial');

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Date.parse(`${dayKey(ms)}T00:00:00Z`);

// Return windows for the retention table: day 1 exactly, then a week-long window
// (small games are noisy day to day, so "came back in their second week" reads better).
const RETENTION = [
  { key: 'd1', label: 'Day 1', from: 1, to: 1, help: 'played the day after joining' },
  { key: 'd7', label: 'Week 2', from: 7, to: 13, help: 'played on days 7–13' },
  { key: 'd30', label: 'Month 2', from: 30, to: 36, help: 'played on days 30–36' },
];

function createStatsService(db) {
  const stmts = {
    signups: db.prepare('SELECT strftime(\'%Y-%m-%d\', created_at / 1000, \'unixepoch\') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day'),
    active: db.prepare('SELECT day, COUNT(*) AS n FROM player_days WHERE day >= ? GROUP BY day'),
    activeSince: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM player_days WHERE day >= ?'),
    players: db.prepare('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NULL'),
    joinedSince: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?'),
    cohort: db.prepare('SELECT id, created_at FROM users WHERE created_at >= ? AND created_at < ?'),
    returned: db.prepare('SELECT COUNT(DISTINCT p.user_id) AS n FROM player_days p JOIN users u ON u.id = p.user_id WHERE u.created_at >= ?1 AND u.created_at < ?2 AND julianday(p.day) - julianday(strftime(\'%Y-%m-%d\', u.created_at / 1000, \'unixepoch\')) BETWEEN ?3 AND ?4'),
    funnel: db.prepare(`
      SELECT COUNT(*) AS joined,
             SUM(missions_completed > 0) AS mission,
             SUM(level >= 3) AS level3,
             SUM(level >= 5) AS level5,
             SUM(level >= 10) AS level10,
             SUM(level >= 20) AS level20,
             SUM(unit_id IS NOT NULL) AS unit,
             SUM(pvp_wins > 0) AS pvp,
             SUM(EXISTS (SELECT 1 FROM tutorial_progress t WHERE t.user_id = users.id AND t.step = ?2)) AS graduated
      FROM users WHERE created_at >= ?1 AND banned_at IS NULL`),
    churnLevels: db.prepare(`
      SELECT CASE WHEN level = 1 THEN '1' WHEN level = 2 THEN '2' WHEN level <= 4 THEN '3–4' WHEN level <= 9 THEN '5–9'
                  WHEN level <= 19 THEN '10–19' ELSE '20+' END AS bucket, COUNT(*) AS n
      FROM users WHERE banned_at IS NULL AND created_at < ?1 AND COALESCE(last_seen_at, created_at) < ?1 AND created_at >= ?2
      GROUP BY bucket`),
    churnSteps: db.prepare(`
      SELECT (SELECT COUNT(*) FROM tutorial_progress t WHERE t.user_id = u.id AND t.step != ?3) AS steps, COUNT(*) AS n
      FROM users u WHERE u.banned_at IS NULL AND u.created_at < ?1 AND COALESCE(u.last_seen_at, u.created_at) < ?1 AND u.created_at >= ?2
      GROUP BY steps`),
    pushUsers: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions'),
    appUsers: db.prepare('SELECT COUNT(*) AS n FROM users WHERE app_seen_at >= ?'),
    inUnit: db.prepare('SELECT COUNT(*) AS n FROM users WHERE unit_id IS NOT NULL AND banned_at IS NULL'),
    activeInUnit: db.prepare('SELECT COUNT(DISTINCT p.user_id) AS n FROM player_days p JOIN users u ON u.id = p.user_id WHERE p.day >= ? AND u.unit_id IS NOT NULL'),
    activeUnits: db.prepare('SELECT COUNT(DISTINCT u.unit_id) AS n FROM player_days p JOIN users u ON u.id = p.user_id WHERE p.day >= ? AND u.unit_id IS NOT NULL'),
    objectives: db.prepare('SELECT COUNT(*) AS total, SUM(completed_at IS NOT NULL) AS done FROM unit_objectives WHERE week = ?'),
    battles: db.prepare('SELECT strftime(\'%Y-%m-%d\', created_at / 1000, \'unixepoch\') AS day, COUNT(*) AS n FROM battles WHERE created_at >= ? GROUP BY day'),
    targets: db.prepare('SELECT COUNT(*) AS days, COALESCE(SUM(beaten), 0) AS beaten, COALESCE(SUM(defenses), 0) AS defenses FROM daily_targets WHERE day >= ?'),
    chat: db.prepare('SELECT COUNT(*) AS messages, COUNT(DISTINCT user_id) AS chatters FROM chat_messages WHERE created_at >= ? AND kind IS NULL'),
    avatars: db.prepare("SELECT SUM(avatar_kind = 'badge') AS badge, SUM(avatar_kind = 'upload') AS upload FROM users WHERE banned_at IS NULL"),
    tutorialSteps: db.prepare('SELECT step, COUNT(*) AS n FROM tutorial_progress t JOIN users u ON u.id = t.user_id WHERE u.created_at >= ? GROUP BY step'),
  };

  /** The last `n` UTC days, oldest first, as { day, ms }. */
  const lastDays = (n, now) => Array.from({ length: n }, (_, i) => {
    const ms = dayStart(now) - (n - 1 - i) * DAY;
    return { day: dayKey(ms), ms };
  });

  function daily(now, n = 30) {
    const days = lastDays(n, now);
    const since = days[0].ms;
    const signups = new Map(stmts.signups.all(since).map((r) => [r.day, r.n]));
    const active = new Map(stmts.active.all(days[0].day).map((r) => [r.day, r.n]));
    const battles = new Map(stmts.battles.all(since).map((r) => [r.day, r.n]));
    return days.map((d) => ({ ...d, signups: signups.get(d.day) || 0, active: active.get(d.day) || 0, battles: battles.get(d.day) || 0 }));
  }

  /** Weekly sign-up cohorts (Monday to Monday), newest first, with return rates. */
  function cohorts(now, weeks = 8) {
    const today = dayStart(now);
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
    const out = [];
    for (let w = 0; w < weeks; w += 1) {
      const from = monday - w * 7 * DAY;
      const to = from + 7 * DAY;
      const size = stmts.cohort.all(from, to).length;
      const row = { week: dayKey(from), size, rates: {} };
      for (const r of RETENTION) {
        // Only report a window once every member of the cohort has had the chance to reach it.
        const matured = to - DAY + r.to * DAY < today; // the last joiner's window has fully passed
        if (!size || !matured) { row.rates[r.key] = null; continue; }
        const n = stmts.returned.get(from, to, r.from, r.to).n;
        row.rates[r.key] = { n, pct: Math.round((n / size) * 100) };
      }
      out.push(row);
    }
    return out;
  }

  /** How far players who joined since `since` got. */
  function funnel(since) {
    const f = stmts.funnel.get(since, GRADUATION.id);
    const steps = [
      ['joined', 'Signed up'],
      ['mission', 'Won a mission'],
      ['level3', 'Reached level 3 (PvP)'],
      ['graduated', 'Finished basic training'],
      ['level5', 'Reached level 5'],
      ['unit', 'In a unit now'],
      ['pvp', 'Won a PvP fight'],
      ['level10', 'Reached level 10'],
      ['level20', 'Reached level 20'],
    ];
    const total = f.joined || 0;
    return steps.map(([key, label]) => ({ key, label, n: f[key] || 0, pct: total ? Math.round(((f[key] || 0) / total) * 100) : 0 }));
  }

  /** Players who stopped (no visit for 7 days), by level and basic-training steps done. */
  function dropOff(now, since) {
    const cutoff = now - 7 * DAY;
    const order = ['1', '2', '3–4', '5–9', '10–19', '20+'];
    const levels = new Map(stmts.churnLevels.all(cutoff, since).map((r) => [r.bucket, r.n]));
    const steps = new Map(stmts.churnSteps.all(cutoff, since, GRADUATION.id).map((r) => [r.steps, r.n]));
    const total = [...levels.values()].reduce((a, b) => a + b, 0);
    return {
      total,
      levels: order.map((b) => ({ label: `Level ${b}`, n: levels.get(b) || 0 })),
      steps: Array.from({ length: STEPS.length + 1 }, (_, i) => ({ label: `${i} of ${STEPS.length}`, n: steps.get(i) || 0 })),
    };
  }

  return {
    RETENTION,

    /** Everything the page shows. `range` is 'month' (players who joined in the last 30 days) or 'all'. */
    overview(now = Date.now(), { range = 'month' } = {}) {
      const today = dayKey(now);
      const since = range === 'all' ? 0 : now - 30 * DAY;
      const dau = stmts.activeSince.get(today).n;
      const wau = stmts.activeSince.get(dayKey(now - 6 * DAY)).n;
      const mau = stmts.activeSince.get(dayKey(now - 29 * DAY)).n;
      const objectives = require('./objectives');
      const obj = stmts.objectives.get(objectives.weekKey(now));
      const tutorial = new Map(stmts.tutorialSteps.all(since).map((r) => [r.step, r.n]));
      const joined = stmts.joinedSince.get(since).n;
      return {
        kpis: {
          players: stmts.players.get().n,
          newWeek: stmts.joinedSince.get(now - 7 * DAY).n,
          dau, wau, mau,
          stickiness: mau ? Math.round((dau / mau) * 100) : 0,
        },
        daily: daily(now),
        cohorts: cohorts(now),
        funnel: funnel(since),
        tutorial: STEPS.map((s) => ({ label: s.title, n: tutorial.get(s.id) || 0, pct: joined ? Math.round(((tutorial.get(s.id) || 0) / joined) * 100) : 0 })),
        dropOff: dropOff(now, since),
        features: {
          push: stmts.pushUsers.get().n,
          app: stmts.appUsers.get(now - 30 * DAY).n,
          inUnit: stmts.inUnit.get().n,
          activeInUnit: stmts.activeInUnit.get(dayKey(now - 6 * DAY)).n,
          activeUnits: stmts.activeUnits.get(dayKey(now - 6 * DAY)).n,
          objectives: { total: obj.total || 0, done: obj.done || 0 },
          targets: stmts.targets.get(dayKey(now - 6 * DAY)),
          chat: stmts.chat.get(now - 7 * DAY),
          avatars: stmts.avatars.get(),
        },
        range,
      };
    },
  };
}

module.exports = { RETENTION, createStatsService };
