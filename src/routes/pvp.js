'use strict';

const express = require('express');
const game = require('../game');
const pvp = require('../pvp');
const presence = require('../presence');
const { statsOf } = require('../armory');
const { createRequireAuth } = require('../require-auth');

function pvpRoutes(players) {
  const router = express.Router();
  const requireAuth = createRequireAuth(players);

  router.post('/attack/:username', requireAuth, (req, res, next) => {
    const target = players.findByUsername(String(req.params.username));
    if (!target) return next();
    const profileUrl = `/profile/${encodeURIComponent(target.username)}`;

    const outcome = players.transaction(() => {
      const attacker = players.findById(req.player.id);
      const defender = players.findById(target.id);
      const now = Date.now();
      const out = pvp.resolveAttack(attacker, defender, {
        aStats: statsOf(players, attacker),
        dStats: statsOf(players, defender),
        lastAttackAt: players.lastAttackAt(attacker.id, defender.id),
        now,
      });
      if (out.error) return out;

      players.save(out.attacker);
      players.save(out.defender);
      const r = out.report;
      const id = players.recordBattle(attacker.id, defender.id, r, now);
      const link = `/battles/${id}`;
      const a = attacker.username;
      const d = defender.username;
      if (r.attackerWon) {
        players.log(attacker.id, 'pvp-win', `Attacked ${d} and won${r.knockout ? ' by knockout' : ''}. +${r.xp.attacker} XP, +$${r.cashTaken}.`, link);
        players.log(defender.id, 'pvp-loss', `${a} attacked you and won${r.knockout ? ', putting you in hospital' : ''}. Lost $${r.cashTaken}.`, link);
      } else {
        players.log(attacker.id, 'pvp-loss', `Attacked ${d} and lost${r.knockout ? '. You were knocked out' : ''}.`, link);
        players.log(defender.id, 'pvp-win', `${a} attacked you and you held them off${r.knockout ? ' with a knockout' : ''}. +${r.xp.defender} XP.`, link);
      }
      for (const [p, side] of [[attacker, 'attacker'], [defender, 'defender']]) {
        for (const lvl of r.levelsGained[side]) {
          const rank = game.rankFor(lvl);
          players.log(p.id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
        }
      }
      return { id };
    });

    if (outcome.error) {
      req.flash('error', outcome.error);
      return res.redirect(profileUrl);
    }
    res.redirect(`/battles/${outcome.id}`);
  });

  router.get('/battles/:id', requireAuth, (req, res, next) => {
    const id = Number(req.params.id);
    const battle = Number.isInteger(id) ? players.findBattle(id) : null;
    if (!battle) return next();
    const youAre = battle.attacker_id === req.player.id ? 'attacker' : battle.defender_id === req.player.id ? 'defender' : null;
    res.render('battle', {
      title: `${battle.attacker_name} vs ${battle.defender_name}`,
      nav: null,
      battle,
      r: battle.report,
      youAre,
      ago: presence.timeAgo(battle.created_at),
    });
  });

  return router;
}

module.exports = { pvpRoutes };
