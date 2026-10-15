'use strict';

const tutorial = require('./tutorial');
const game = require('./game');
const { announceLevels } = require('./notify');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/** Basic training backed by the database: detects steps, pays rewards, remembers dismissal. */
function createTutorialService(db, players, { enabled = true } = {}) {
  const stmts = {
    state: db.prepare(`
      SELECT u.level, u.missions_completed + u.missions_failed AS missions, u.stat_str + u.stat_agi + u.stat_end AS training,
             u.unit_id IS NOT NULL AS inUnit, u.streak_best AS supplyDrops, u.tutorial_dismissed AS dismissed,
             (SELECT COUNT(*) FROM equipment e WHERE e.user_id = u.id) AS equipped,
             (SELECT COUNT(*) FROM bank_transactions t WHERE t.user_id = u.id AND t.type = 'deposit') AS deposits,
             (SELECT COUNT(*) FROM unit_applications a WHERE a.user_id = u.id) AS applications,
             (SELECT COUNT(*) FROM battles b WHERE b.attacker_id = u.id AND b.attacker_won = 1 AND b.attacker_xp > 0 AND b.reversed_at IS NULL) AS pvpWins
      FROM users u WHERE u.id = ?`),
    done: db.prepare('SELECT step FROM tutorial_progress WHERE user_id = ?'),
    mark: db.prepare('INSERT OR IGNORE INTO tutorial_progress (user_id, step, done_at) VALUES (?, ?, ?)'),
    dismiss: db.prepare('UPDATE users SET tutorial_dismissed = ? WHERE id = ?'),
  };

  const doneSet = (userId) => new Set(stmts.done.all(userId).map((r) => r.step));

  return {
    /** Marks and pays any newly completed steps (and graduation). Returns the steps completed. */
    check(userId, now = Date.now()) {
      if (!enabled) return [];
      return players.transaction(() => {
        const state = stmts.state.get(userId);
        if (!state) return [];
        const done = doneSet(userId);
        if (done.has(tutorial.GRADUATION.id)) return [];
        const fresh = tutorial.newlyDone(state, done).filter((s) => stmts.mark.run(userId, s.id, now).changes);
        for (const s of fresh) done.add(s.id);
        const graduating = tutorial.STEPS.every((s) => done.has(s.id)) && stmts.mark.run(userId, tutorial.GRADUATION.id, now).changes > 0;
        if (!fresh.length && !graduating) return [];

        const pay = [...fresh, ...(graduating ? [tutorial.GRADUATION] : [])];
        const p = game.applyRegen(players.findById(userId), now);
        p.cash += pay.reduce((n, s) => n + s.cash, 0);
        const levels = game.grantXp(p, pay.reduce((n, s) => n + s.xp, 0));
        players.save(p, { reason: 'tutorial', ref: pay.map((s) => s.id).join(',') });
        for (const s of fresh) {
          players.notify(userId, 'tutorial', `Basic training: “${s.title}” complete. +${money(s.cash)}${s.xp ? `, +${s.xp} XP` : ''}.`, '/hq#training-title');
        }
        if (graduating) {
          players.notify(userId, 'tutorial', `Basic training complete! Graduation bonus: +${money(tutorial.GRADUATION.cash)}, +${tutorial.GRADUATION.xp} XP. Welcome to the front line.`, '/hq');
          players.log(userId, 'promotion', 'Graduated from basic training.');
        }
        for (const lvl of levels) {
          const rank = game.rankFor(lvl);
          players.log(userId, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
        }
        announceLevels(players, userId, levels);
        return fresh;
      });
    },

    view(userId) {
      const state = stmts.state.get(userId);
      return tutorial.view(doneSet(userId), { dismissed: Boolean(state && state.dismissed) });
    },

    setDismissed: (userId, dismissed) => stmts.dismiss.run(dismissed ? 1 : 0, userId),

    /** Middleware: after a successful POST, tick off whatever it completed. */
    tracker() {
      return (req, res, next) => {
        if (req.method !== 'POST') return next();
        res.on('finish', () => {
          const userId = req.session && req.session.userId;
          if (!userId || res.statusCode >= 400) return;
          try { this.check(userId); } catch (err) { console.error('[tutorial] check failed', err); }
        });
        next();
      };
    },
  };
}

module.exports = { createTutorialService };
