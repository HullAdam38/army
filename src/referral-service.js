'use strict';

const game = require('./game');
const tuning = require('./tuning');
const { announceLevels } = require('./notify');

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * Recruit a friend. Every player has an invite link (/join/<callsign>). A new
 * player who signs up through it is recorded as that player's recruit, and
 * when the recruit reaches the reward level (default 10) both are paid once
 * (ledger reason `referral`).
 *
 * Anti-farming: nothing is paid when the two accounts share a device or a
 * network (anti-cheat's linked check), when either is suspended, or past the
 * monthly cap per recruiter. A recruit needs real play to reach the level, so
 * a pile of throwaway sign-ups is worth nothing.
 */
function createReferralService(db, players, anti) {
  const stmts = {
    set: db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL'),
    due: db.prepare('SELECT id, username, level, referred_by, banned_at FROM users WHERE id = ? AND referred_by IS NOT NULL AND referral_paid_at IS NULL'),
    settle: db.prepare('UPDATE users SET referral_paid_at = ? WHERE id = ? AND referral_paid_at IS NULL'),
    paidThisMonth: db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND reason = 'referral' AND ref LIKE 'recruited:%' AND created_at >= ?"),
    recruits: db.prepare(`SELECT id, username, level, created_at, last_seen_at, referral_paid_at, banned_at,
                                 (SELECT delta_cash FROM ledger l WHERE l.user_id = ?1 AND l.reason = 'referral' AND l.ref = 'recruited:' || u.id) AS paid
                          FROM users u WHERE referred_by = ?1 ORDER BY id DESC LIMIT 100`),
  };

  /** Who a link names, if they can recruit: a real, unsuspended player. */
  function recruiter(username) {
    const r = username ? players.findByUsername(String(username)) : null;
    return r && !r.banned_at && !r.is_bot ? r : null;
  }

  return {
    recruiter,

    /** Records that `recruitId` signed up through `recruiterId`'s link, and tells the recruiter. */
    signedUp(recruitId, recruiterId, now = Date.now()) {
      const r = players.findById(recruiterId);
      const me = players.findById(recruitId);
      if (!r || !me || r.id === me.id || r.banned_at || r.is_bot) return false;
      if (!stmts.set.run(r.id, me.id).changes) return false;
      players.notify(r.id, 'system', `${me.username} joined GeneralForces from your invite link. You’ll both be rewarded when they reach level ${tuning.get('referralLevel')}.`, '/account/recruit');
      players.log(me.id, 'system', `Joined on ${r.username}’s invitation.`, `/profile/${encodeURIComponent(r.username)}`);
      return true;
    },

    /**
     * Pays the reward if `userId` is a recruit who has reached the level.
     * Returns { paid } or { void: reason } once settled, or null if not due yet.
     */
    check(userId, now = Date.now()) {
      return players.transaction(() => {
        const me = stmts.due.get(userId);
        if (!me || me.level < tuning.get('referralLevel')) return null;
        const r = players.findById(me.referred_by);
        stmts.settle.run(now, me.id); // settled once, paid or not
        const why = !r ? 'the recruiter’s account is gone'
          : r.banned_at || me.banned_at ? 'an account is suspended'
            : anti.linked(r.id, me.id, now) ? 'the accounts share a device or network'
              : stmts.paidThisMonth.get(r.id, now - MONTH_MS).n >= tuning.get('referralMaxPerMonth') ? 'the monthly limit was reached'
                : null;
        if (why) {
          if (r) players.notify(r.id, 'system', `${me.username} reached level ${tuning.get('referralLevel')}, but no recruit reward was paid: ${why}.`, '/account/recruit');
          return { void: why };
        }
        const pay = { cash: tuning.get('referralCash'), xp: tuning.get('referralXp'), recruit: tuning.get('referralRecruitCash') };
        const rp = game.applyRegen(r, now);
        rp.cash += pay.cash;
        const levels = game.grantXp(rp, pay.xp);
        players.save(rp, { reason: 'referral', ref: `recruited:${me.id}` });
        players.notify(r.id, 'system', `Your recruit ${me.username} reached level ${tuning.get('referralLevel')}. Reward: +${money(pay.cash)}${pay.xp ? `, +${pay.xp} XP` : ''}.`, '/account/recruit');
        announceLevels(players, r.id, levels);
        if (pay.recruit) {
          const mp = game.applyRegen(players.findById(me.id), now);
          mp.cash += pay.recruit;
          players.save(mp, { reason: 'referral', ref: `recruit-of:${r.id}` });
          players.notify(me.id, 'system', `Level ${tuning.get('referralLevel')}! As ${r.username}’s recruit you get a bonus: +${money(pay.recruit)}.`, null);
        }
        return { paid: pay };
      });
    },

    recruits: (userId) => stmts.recruits.all(userId),

    /** Middleware: after a successful POST, see if it earned a recruit reward. Runs after the response. */
    tracker() {
      return (req, res, next) => {
        if (req.method !== 'POST') return next();
        res.on('finish', () => {
          const userId = req.session && req.session.userId;
          if (!userId || res.statusCode >= 400) return;
          try { this.check(userId); } catch (err) { console.error('[referral] check failed', err); }
        });
        next();
      };
    },
  };
}

module.exports = { createReferralService };
