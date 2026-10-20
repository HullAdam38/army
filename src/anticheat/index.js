'use strict';

const crypto = require('node:crypto');
const rules = require('./rules');
const { MISSIONS } = require('../game');
const tuning = require('../tuning');
const pvp = require('../pvp');
const admin = require('../admin');

const DEVICE_COOKIE = 'ef.dev';
const perks = require('../perks');
const events = require('../events');
const vehicles = require('../vehicles');
// The most a single mission can pay: the best mission's top roll with every rank perk, a unit rally,
// the best transport (at `vehicleMult`, the admin's vehicle bonus setting) and a Payday event.
const maxMissionCash = (vehicleMult = 1) => Math.ceil(Math.max(...MISSIONS.map((m) => m.cash[1]))
  * (1 + perks.MAX_CASH_BONUS + require('../units').RALLY.bonus + vehicles.MAX_MISSION_CASH_BONUS * vehicleMult) * events.MAX_CASH_MULT);
const MAX_PVP_CASH = pvp.CASH_CAP_PER_LEVEL * admin.MAX_LEVEL;

/** Which game action a POST path is, or null for ones we don't time (sign-in, admin…). */
function actionKind(path) {
  const first = path.split('/')[1] || '';
  const kinds = { missions: 'mission', attack: 'attack', bank: 'bank', armory: 'armory', hospital: 'hospital', training: 'training', scout: 'scout', daily: 'daily', units: 'unit', operations: 'operation', base: 'base', deployments: 'deployment' };
  return kinds[first] || null;
}

const isLoopback = (ip) => !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');

/** Reads a cookie without pulling in a cookie-parser dependency. */
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Anti-cheat: sign-in tracking, linked accounts, PvP reward limits, flags for
 * admins to review, and a periodic scan (money ledger audit, farming, links).
 */
function createAntiCheat(db, players, { secret, settings = null }) {
  // The most generous value an admin setting had since `since` (see settings-service.extreme).
  const generous = (key, since, pick) => (settings ? settings.extreme(key, since, pick) : tuning.get(key));
  // IPs are only ever stored as a keyed hash: enough to tell "same network",
  // useless for finding where someone lives.
  const ipKey = crypto.createHash('sha256').update(`ef-ip:${secret}`).digest();
  const hashIp = (ip) => (isLoopback(ip) ? null : crypto.createHmac('sha256', ipKey).update(ip).digest('hex').slice(0, 32));

  const stmts = {
    signIn: db.prepare('INSERT INTO sign_ins (user_id, ip_hash, device_id, user_agent, created_at) VALUES (?, ?, ?, ?, ?)'),
    signInsFor: db.prepare('SELECT ip_hash, device_id, user_agent, created_at FROM sign_ins WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    links: db.prepare(`
      SELECT s2.user_id AS other_id, u.username AS other_name,
             MAX(s1.device_id IS NOT NULL AND s1.device_id = s2.device_id) AS device,
             MAX(s1.ip_hash IS NOT NULL AND s1.ip_hash = s2.ip_hash) AS network,
             MAX(s2.created_at) AS last_at
      FROM sign_ins s1
      JOIN sign_ins s2 ON s2.user_id != s1.user_id AND (s2.device_id = s1.device_id OR s2.ip_hash = s1.ip_hash)
      JOIN users u ON u.id = s2.user_id
      WHERE s1.user_id = ? AND s1.created_at >= ?2 AND s2.created_at >= ?2
      GROUP BY s2.user_id`),
    deviceLinked: db.prepare(`
      SELECT 1 FROM sign_ins a JOIN sign_ins b ON a.device_id = b.device_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.device_id IS NOT NULL AND a.created_at >= ?3 AND b.created_at >= ?3 LIMIT 1`),
    networkLinked: db.prepare(`
      SELECT 1 FROM sign_ins a JOIN sign_ins b ON a.ip_hash = b.ip_hash
      WHERE a.user_id = ? AND b.user_id = ? AND a.ip_hash IS NOT NULL AND a.created_at >= ?3 AND b.created_at >= ?3 LIMIT 1`),
    linkedPairs: db.prepare(`
      SELECT a.user_id AS a_id, b.user_id AS b_id, ua.username AS a_name, ub.username AS b_name,
             MAX(a.device_id IS NOT NULL AND a.device_id = b.device_id) AS device,
             COUNT(DISTINCT CASE WHEN a.ip_hash = b.ip_hash THEN a.ip_hash END) AS networks
      FROM sign_ins a
      JOIN sign_ins b ON b.user_id > a.user_id AND (b.device_id = a.device_id OR b.ip_hash = a.ip_hash)
      JOIN users ua ON ua.id = a.user_id JOIN users ub ON ub.id = b.user_id
      WHERE a.created_at >= ?1 AND b.created_at >= ?1
      GROUP BY a.user_id, b.user_id`),
    winsSince: db.prepare('SELECT COUNT(*) AS n FROM battles WHERE attacker_id = ? AND defender_id = ? AND attacker_won = 1 AND created_at >= ?'),
    pairStats: db.prepare(`
      SELECT b.attacker_id, b.defender_id, ua.username AS attacker_name, ud.username AS defender_name,
             COUNT(*) AS attacks, SUM(b.attacker_won) AS attacker_wins, SUM(b.cash_taken) AS cash_taken,
             GROUP_CONCAT(b.id) AS battle_ids,
             (SELECT COUNT(*) FROM battles r WHERE r.attacker_id = b.defender_id AND r.defender_id = b.attacker_id AND r.created_at >= ?1) AS reverse_attacks
      FROM battles b JOIN users ua ON ua.id = b.attacker_id JOIN users ud ON ud.id = b.defender_id
      WHERE b.created_at >= ?1 AND (?2 IS NULL OR (b.attacker_id = ?2 AND b.defender_id = ?3))
        AND NOT (ua.is_bot = 1 AND ud.is_bot = 1) -- reserve soldiers' skirmishes among themselves
      GROUP BY b.attacker_id, b.defender_id`),
    ledgerMismatches: db.prepare(`
      SELECT u.id, u.username, u.cash, u.bank_balance,
             COALESCE(SUM(l.delta_cash), 0) AS ledger_cash, COALESCE(SUM(l.delta_bank), 0) AS ledger_bank
      FROM users u LEFT JOIN ledger l ON l.user_id = u.id
      GROUP BY u.id HAVING ledger_cash != u.cash OR ledger_bank != u.bank_balance`),
    suspectLedger: db.prepare(`
      SELECT l.id, l.user_id, u.username, l.delta_cash, l.delta_bank, l.reason, l.ref, l.created_at
      FROM ledger l JOIN users u ON u.id = l.user_id
      WHERE l.created_at >= ?1 AND (l.reason = 'unknown'
        OR (l.reason = 'mission' AND l.delta_cash > ?2)
        OR (l.reason = 'pvp' AND l.delta_cash > ?3))
      ORDER BY l.id`),
    ledgerFor: db.prepare('SELECT delta_cash, delta_bank, reason, ref, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    purgeSignIns: db.prepare('DELETE FROM sign_ins WHERE created_at < ?'),
    recordAction: db.prepare('INSERT INTO actions (user_id, kind, xp, cash, created_at) VALUES (?, ?, ?, ?, ?)'),
    purgeActions: db.prepare('DELETE FROM actions WHERE created_at < ?'),
    busyPlayers: db.prepare(`
      SELECT a.user_id, u.username FROM actions a JOIN users u ON u.id = a.user_id
      WHERE a.created_at >= ? GROUP BY a.user_id HAVING COUNT(*) >= ?`),
    actionTimes: db.prepare('SELECT created_at FROM actions WHERE user_id = ? AND created_at >= ? ORDER BY created_at'),
    gains: db.prepare(`
      SELECT a.user_id, u.username, u.level, u.max_energy,
             SUM(a.xp) AS xp,
             SUM(CASE WHEN a.kind IN ('mission', 'attack') THEN a.cash ELSE 0 END) AS cash,
             SUM(CASE WHEN a.kind = 'mission' THEN a.cash ELSE 0 END) AS mission_cash
      FROM actions a JOIN users u ON u.id = a.user_id
      WHERE a.created_at >= ? AND u.banned_at IS NULL
      GROUP BY a.user_id`),
    refills: db.prepare(`
      SELECT (SELECT COUNT(*) FROM activity WHERE user_id = ?1 AND kind = 'promotion' AND created_at >= ?2)
           + (SELECT COUNT(*) FROM admin_actions WHERE target_id = ?1 AND action IN ('admin-restore', 'restore', 'level') AND created_at >= ?2) AS n`),
    activityByHour: db.prepare(`
      SELECT CAST((created_at - ?1) / 3600000 AS INTEGER) AS bucket, COUNT(*) AS n, SUM(xp) AS xp, SUM(cash) AS cash
      FROM actions WHERE user_id = ?2 AND created_at >= ?1 GROUP BY bucket`),

    latestFlag: db.prepare('SELECT * FROM flags WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1'),
    insertFlag: db.prepare(`
      INSERT INTO flags (rule, severity, dedupe_key, user_ids, summary, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    refreshFlag: db.prepare('UPDATE flags SET severity = MAX(severity, ?), summary = ?, evidence = ?, hits = hits + 1, updated_at = ? WHERE id = ?'),
    flag: db.prepare('SELECT * FROM flags WHERE id = ?'),
    flagsByStatus: db.prepare(`
      SELECT * FROM flags WHERE (?1 = 'open' AND status = 'open') OR (?1 = 'resolved' AND status != 'open')
      ORDER BY CASE WHEN status = 'open' THEN severity ELSE 0 END DESC, updated_at DESC LIMIT ?2`),
    flagsForUser: db.prepare("SELECT * FROM flags WHERE user_ids LIKE ? ORDER BY id DESC LIMIT 20"),
    openCount: db.prepare("SELECT COUNT(*) AS n FROM flags WHERE status = 'open'"),
    resolveFlag: db.prepare('UPDATE flags SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?'),
    battle: db.prepare('SELECT * FROM battles WHERE id = ?'),
    markReversed: db.prepare('UPDATE battles SET reversed_at = ? WHERE id = ?'),
    eventTypes: db.prepare('SELECT type FROM events WHERE cancelled_at IS NULL AND starts_at < ? AND ends_at > ?'),
  };

  const parseFlag = (row) => (row ? { ...row, evidence: JSON.parse(row.evidence), userIdList: row.user_ids.split(',').filter(Boolean).map(Number) } : null);

  /**
   * Opens a flag, or refreshes the open one with the same key. A flag an admin
   * resolved in the last 7 days isn't re-raised, so dismissals stick.
   */
  function raise({ rule, severity, userIds, summary, evidence, key, now = Date.now() }) {
    const existing = stmts.latestFlag.get(key);
    if (existing && existing.status === 'open') {
      stmts.refreshFlag.run(severity, summary, JSON.stringify(evidence), now, existing.id);
      return existing.id;
    }
    if (existing && existing.resolved_at > now - 7 * rules.DAY) return null;
    const ids = `,${[...new Set(userIds)].sort((a, b) => a - b).join(',')},`;
    return Number(stmts.insertFlag.run(rule, severity, key, ids, summary, JSON.stringify(evidence), now, now).lastInsertRowid);
  }

  function linkFlag(pair, now) {
    const [a, b] = pair.a_id < pair.b_id ? [pair.a_id, pair.b_id] : [pair.b_id, pair.a_id];
    const names = `${pair.a_name} and ${pair.b_name}`;
    if (pair.device) {
      raise({
        rule: 'linked-device', severity: 2, userIds: [a, b], key: `linked-device:${a}:${b}`, now,
        summary: `${names} have signed in from the same device.`,
        evidence: { players: [pair.a_name, pair.b_name], device: true, sharedNetworks: pair.networks },
      });
    } else if (pair.networks >= 1) {
      raise({
        rule: 'linked-network', severity: 1, userIds: [a, b], key: `linked-network:${a}:${b}`, now,
        summary: `${names} have signed in from the same network${pair.networks > 1 ? ` (${pair.networks} different networks)` : ''}.`,
        evidence: { players: [pair.a_name, pair.b_name], device: false, sharedNetworks: pair.networks },
      });
    }
  }

  function checkFarming(row, now) {
    const linkedDevice = Boolean(stmts.deviceLinked.get(row.attacker_id, row.defender_id, now - rules.LINK_WINDOW_MS));
    const linkedNetwork = Boolean(stmts.networkLinked.get(row.attacker_id, row.defender_id, now - rules.LINK_WINDOW_MS));
    const verdict = rules.farmingVerdict({
      attacks: row.attacks, attackerWins: row.attacker_wins, reverseAttacks: row.reverse_attacks, linkedDevice, linkedNetwork,
    });
    if (!verdict) return null;
    return raise({
      rule: 'pvp-farming', severity: verdict.severity, now,
      userIds: [row.attacker_id, row.defender_id],
      key: `pvp-farming:${row.attacker_id}:${row.defender_id}`,
      summary: `${row.attacker_name} attacked ${row.defender_name} ${row.attacks} times in 48 hours (${row.attacker_wins} wins, $${row.cash_taken} taken): ${verdict.why}.`,
      evidence: {
        attacker: { id: row.attacker_id, name: row.attacker_name },
        defender: { id: row.defender_id, name: row.defender_name },
        attacks: row.attacks, attackerWins: row.attacker_wins, cashTaken: row.cash_taken,
        reverseAttacks: row.reverse_attacks, linkedDevice, linkedNetwork,
        battleIds: String(row.battle_ids).split(',').map(Number),
      },
    });
  }

  return {
    DEVICE_COOKIE,

    /** Gives every browser a long-lived random device id (used to spot shared devices). */
    deviceCookie({ production = false } = {}) {
      return (req, res, next) => {
        let id = readCookie(req, DEVICE_COOKIE);
        if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
          id = crypto.randomBytes(16).toString('base64url');
          res.cookie(DEVICE_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 2 * 365 * rules.DAY });
        }
        req.deviceId = id;
        next();
      };
    },

    /**
     * Records every game action a signed-in player takes (when the response is
     * sent), with any XP/cash the route reported in `res.locals.gains`.
     */
    actionTracker() {
      return (req, res, next) => {
        const kind = req.method === 'POST' ? actionKind(req.path) : null;
        if (kind) {
          res.on('finish', () => {
            const userId = req.session && req.session.userId;
            if (!userId || res.statusCode >= 400) return;
            const g = res.locals.gains || {};
            try {
              stmts.recordAction.run(userId, kind, g.xp || 0, g.cash || 0, Date.now());
            } catch (err) {
              console.error('[anticheat] failed to record action', err);
            }
          });
        }
        next();
      };
    },

    /** Records an action directly (used by tests and scripts). */
    recordAction: (userId, kind, { xp = 0, cash = 0 } = {}, at = Date.now()) => stmts.recordAction.run(userId, kind, xp, cash, at),

    /** Hour-by-hour actions/XP/cash for the last 24 hours (oldest first), for admin pages. */
    activityProfile(userId, now = Date.now()) {
      const start = now - rules.ACTIVITY_WINDOW_MS;
      const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, n: 0, xp: 0, cash: 0, at: start + i * rules.HOUR }));
      for (const r of stmts.activityByHour.all(start, userId)) if (hours[r.bucket]) Object.assign(hours[r.bucket], { n: r.n, xp: r.xp, cash: r.cash });
      const totals = hours.reduce((t, h) => ({ n: t.n + h.n, xp: t.xp + h.xp, cash: t.cash + h.cash, active: t.active + (h.n ? 1 : 0) }), { n: 0, xp: 0, cash: 0, active: 0 });
      return { hours, totals, peak: Math.max(1, ...hours.map((h) => h.n)) };
    },

    /** Records a sign-in or registration, then checks for newly linked accounts. */
    recordSignIn(userId, { ip, deviceId, userAgent }, now = Date.now()) {
      stmts.signIn.run(userId, hashIp(ip), deviceId || null, String(userAgent || '').slice(0, 200), now);
      for (const l of stmts.links.all(userId, now - rules.LINK_WINDOW_MS)) {
        const me = players.findById(userId);
        linkFlag({ a_id: userId, b_id: l.other_id, a_name: me.username, b_name: l.other_name, device: l.device, networks: l.network ? 1 : 0 }, now);
      }
    },

    /** Other accounts seen on the same device or network as `userId`. */
    linkedAccounts: (userId, now = Date.now()) => stmts.links.all(userId, now - rules.LINK_WINDOW_MS),
    signInsFor: (userId, limit = 10) => stmts.signInsFor.all(userId, limit),
    ledgerFor: (userId, limit = 15) => stmts.ledgerFor.all(userId, limit),

    /**
     * True when two accounts have shared a device or network recently. Used
     * where money could pass between them (bounties), so it's stricter than PvP.
     */
    linked(a, b, now = Date.now()) {
      if (a === b) return true;
      const since = now - rules.LINK_WINDOW_MS;
      return Boolean(stmts.deviceLinked.get(a, b, since) || stmts.networkLinked.get(a, b, since));
    },

    /** How much of the usual PvP rewards this attack should pay out. */
    pvpRewards(attackerId, defenderId, now = Date.now()) {
      return rules.pvpRewardPlan({
        linkedDevice: Boolean(stmts.deviceLinked.get(attackerId, defenderId, now - rules.LINK_WINDOW_MS)),
        priorWinsToday: stmts.winsSince.get(attackerId, defenderId, now - rules.DIMINISHING_WINDOW_MS).n,
      });
    },

    /** Re-checks one attacker→defender pair right after a fight. */
    afterBattle(attackerId, defenderId, now = Date.now()) {
      for (const row of stmts.pairStats.all(now - rules.FARMING_WINDOW_MS, attackerId, defenderId)) checkFarming(row, now);
    },

    /**
     * Full scan: ledger audit, suspicious payouts, linked accounts and PvP
     * farming across everyone, plus deleting old sign-in records.
     */
    runScan(now = Date.now()) {
      // One transaction: hundreds of flag writes then cost one disk sync instead of one each.
      return players.transaction(() => this.scan(now));
    },

    scan(now) {
      const before = stmts.openCount.get().n;
      for (const m of stmts.ledgerMismatches.all()) {
        raise({
          rule: 'ledger-mismatch', severity: 3, userIds: [m.id], key: `ledger-mismatch:${m.id}`, now,
          summary: `${m.username}'s balances don't match their money history: cash $${m.cash} vs $${m.ledger_cash} expected, bank $${m.bank_balance} vs $${m.ledger_bank} expected.`,
          evidence: { player: m.username, cash: m.cash, expectedCash: m.ledger_cash, bank: m.bank_balance, expectedBank: m.ledger_bank },
        });
      }
      const suspects = new Map();
      const farmSince = now - rules.FARMING_WINDOW_MS;
      const payCeiling = Math.ceil(maxMissionCash(generous('vehicleBonusMult', farmSince, Math.max)) * generous('missionCashMult', farmSince, Math.max)); // admin settings
      for (const e of stmts.suspectLedger.all(now - rules.FARMING_WINDOW_MS, payCeiling, MAX_PVP_CASH)) {
        const rule = e.reason === 'unknown' ? 'unknown-money' : 'impossible-payout';
        const key = `${rule}:${e.user_id}`;
        if (!suspects.has(key)) suspects.set(key, { rule, userId: e.user_id, username: e.username, entries: [] });
        suspects.get(key).entries.push({ id: e.id, cash: e.delta_cash, bank: e.delta_bank, reason: e.reason, ref: e.ref, at: e.created_at });
      }
      for (const [key, s] of suspects) {
        const total = s.entries.reduce((sum, e) => sum + e.cash + e.bank, 0);
        raise({
          rule: s.rule, severity: 3, userIds: [s.userId], key, now,
          summary: s.rule === 'unknown-money'
            ? `${s.username}'s money changed ${s.entries.length} time(s) outside normal game actions (net $${total}).`
            : `${s.username} received ${s.entries.length} payout(s) larger than the game allows.`,
          evidence: { player: s.username, entries: s.entries },
        });
      }
      for (const pair of stmts.linkedPairs.all(now - rules.LINK_WINDOW_MS)) linkFlag(pair, now);
      for (const row of stmts.pairStats.all(now - rules.FARMING_WINDOW_MS, null, null)) checkFarming(row, now);
      this.checkBots(now);
      this.checkGains(now);
      stmts.purgeActions.run(now - rules.ACTION_RETENTION_MS);
      const purged = Number(stmts.purgeSignIns.run(now - rules.SIGN_IN_RETENTION_MS).changes);
      return { newFlags: stmts.openCount.get().n - before, openFlags: stmts.openCount.get().n, purgedSignIns: purged };
    },

    /** Flags players whose last 24 hours of actions look automated. */
    checkBots(now = Date.now()) {
      const since = now - rules.ACTIVITY_WINDOW_MS;
      for (const p of stmts.busyPlayers.all(since, 25)) {
        const verdict = rules.botVerdict(stmts.actionTimes.all(p.user_id, since).map((r) => r.created_at));
        if (!verdict) continue;
        raise({
          rule: 'bot-like', severity: verdict.severity, userIds: [p.user_id], key: `bot-like:${p.user_id}`, now,
          summary: `${p.username}: ${verdict.reasons.join('; ')}.`,
          evidence: {
            player: p.username,
            reasons: verdict.reasons,
            metrics: {
              'Actions (24h)': verdict.metrics.actions,
              'Active hours (of 24)': verdict.metrics.activeHours,
              'Average gap': `${verdict.metrics.averageGapSeconds}s`,
              'Gap variation': `${verdict.metrics.variationPct}%`,
              'Gaps under 0.4s': verdict.metrics.fastGaps,
            },
          },
        });
      }
    },

    /**
     * Flags mission income above what a player's energy could possibly pay for
     * (an exploit), and XP/cash far above similar-level players (worth a look).
     */
    checkGains(now = Date.now()) {
      const since = now - rules.ACTIVITY_WINDOW_MS;
      // A Payday event in the window raises what honest play can earn.
      const eventCashMult = stmts.eventTypes.all(now, since).reduce((m, e) => Math.max(m, events.effectsOf([e.type]).cashMult), 1);
      // So do admin settings: faster energy or higher mission pay at any point in the window.
      const regenMs = Math.round(generous('energyRegenMinutes', since, Math.min) * 60 * 1000);
      const adminCashMult = generous('missionCashMult', since, Math.max);
      const vehicleMult = generous('vehicleBonusMult', since, Math.max);
      const rows = stmts.gains.all(since);
      const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
      for (const r of rows) {
        const refills = stmts.refills.get(r.user_id, since).n;
        const cap = rules.missionCashCap({
          missions: MISSIONS, level: r.level, maxEnergy: r.max_energy, refills, energyRegenMs: regenMs,
          cashMult: (1 + perks.perksFor(r.level).missionCash + vehicles.bestMissionCash(r.level) * vehicleMult) * eventCashMult * adminCashMult,
        });
        const reasons = [];
        let severity = 0;
        if (r.mission_cash > cap) {
          severity = 3;
          reasons.push(`earned ${money(r.mission_cash)} from missions in 24 hours; the most their energy allows is about ${money(cap)}`);
        }
        const peers = rows.filter((o) => o.user_id !== r.user_id && Math.abs(o.level - r.level) <= rules.PEER_LEVEL_RANGE);
        const xpOut = rules.gainsOutlier(r.xp, peers.map((o) => o.xp), 'xp');
        const cashOut = rules.gainsOutlier(r.cash, peers.map((o) => o.cash), 'cash');
        if (xpOut) reasons.push(`${r.xp} XP in 24 hours, ${xpOut.multiple}× the typical ${xpOut.median} for levels ${r.level - rules.PEER_LEVEL_RANGE}–${r.level + rules.PEER_LEVEL_RANGE}`);
        if (cashOut) reasons.push(`${money(r.cash)} earned in 24 hours, ${cashOut.multiple}× the typical ${money(cashOut.median)} for similar levels`);
        if (xpOut || cashOut) severity = Math.max(severity, 2);
        if (!severity) continue;
        raise({
          rule: 'unusual-gains', severity, userIds: [r.user_id], key: `unusual-gains:${r.user_id}`, now,
          summary: `${r.username} ${reasons.join('; ')}.`,
          evidence: {
            player: r.username,
            reasons,
            metrics: {
              Level: r.level,
              'XP (24h)': r.xp,
              'Cash earned (24h)': money(r.cash),
              'Mission cash (24h)': money(r.mission_cash),
              'Mission cash ceiling': money(cap),
              'Similar-level players': peers.length,
            },
          },
        });
      }
    },

    /** Runs the scan every `hours` hours (first run a couple of minutes after start). */
    schedule(hours = 6) {
      const run = () => {
        try {
          const r = this.runScan();
          if (r.newFlags) console.log(`[anticheat] scan raised ${r.newFlags} new flag(s); ${r.openFlags} open.`);
        } catch (err) {
          console.error('[anticheat] scan failed', err);
        }
      };
      setTimeout(run, 2 * 60 * 1000).unref();
      setInterval(run, hours * rules.HOUR).unref();
    },

    // ---- Review queue ----
    listFlags: (status = 'open', limit = 100) => stmts.flagsByStatus.all(status, limit).map(parseFlag),
    getFlag: (id) => parseFlag(stmts.flag.get(id)),
    flagsForUser: (userId) => stmts.flagsForUser.all(`%,${userId},%`).map(parseFlag),
    openFlagCount: () => stmts.openCount.get().n,
    resolveFlag: (id, adminId, status, resolution) => stmts.resolveFlag.run(status, resolution, adminId, Date.now(), id),

    /**
     * Gives back the cash taken in the given battles (as far as the winner can
     * still pay). Returns { reversed, total }. XP isn't clawed back.
     */
    reverseBattles(battleIds, now = Date.now()) {
      let reversed = 0;
      let total = 0;
      for (const id of battleIds) {
        const b = stmts.battle.get(id);
        if (!b || b.reversed_at || !b.attacker_won || !b.cash_taken) continue;
        const winner = players.findById(b.attacker_id);
        const loser = players.findById(b.defender_id);
        const amount = Math.min(b.cash_taken, winner.cash);
        if (amount > 0) {
          players.save({ ...winner, cash: winner.cash - amount }, { reason: 'reversal', ref: `battle:${id}` });
          players.save({ ...loser, cash: loser.cash + amount }, { reason: 'reversal', ref: `battle:${id}` });
        }
        stmts.markReversed.run(now, id);
        reversed += 1;
        total += amount;
      }
      return { reversed, total };
    },
  };
}

module.exports = { createAntiCheat };
