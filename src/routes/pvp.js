'use strict';

const express = require('express');
const game = require('../game');
const pvp = require('../pvp');
const presence = require('../presence');
const { statsOf } = require('../armory');
const scouting = require('../scouting');
const { createRequireAuth } = require('../require-auth');
const { announceLevels } = require('../notify');

function pvpRoutes(players, anti, daily, warService, bountyService) {
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
      const rewards = anti.pvpRewards(attacker.id, defender.id, now);
      const out = pvp.resolveAttack(attacker, defender, {
        aStats: statsOf(players, attacker),
        dStats: statsOf(players, defender),
        lastAttackAt: players.lastAttackAt(attacker.id, defender.id),
        rewards,
        now,
      });
      if (out.error) return out;

      const r = out.report;
      const id = players.recordBattle(attacker.id, defender.id, r, now);
      players.save(out.attacker, { reason: 'pvp', ref: `battle:${id}` });
      players.save(out.defender, { reason: 'pvp', ref: `battle:${id}` });
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
      // The attacker sees the report straight away; the defender finds out via a notification.
      players.notify(
        defender.id,
        r.attackerWon ? 'attacked-lost' : 'attacked-won',
        r.attackerWon
          ? `${a} attacked you and won. You lost $${r.cashTaken}.${r.knockout ? ' You were knocked out and sent to hospital.' : ''}`
          : `${a} attacked you and you held them off. +${r.xp.defender} XP.${r.knockout ? ' You knocked them out.' : ''}`,
        link,
      );
      anti.afterBattle(attacker.id, defender.id, now);
      const war = warService.recordFight({
        battleId: id, a: attacker, d: defender, attackerWon: r.attackerWon, knockout: r.knockout,
        fullRewards: r.attackerWon ? rewards.attacker === 1 : rewards.defender === 1, now,
      });
      if (war) {
        const scorer = r.attackerWon ? attacker : defender;
        players.log(scorer.id, 'war', `War fight won: +${war.points} point${war.points === 1 ? '' : 's'} for [${war.unitTag}].`, `/wars/${war.warId}`);
      }
      // Bounties pay out on a full-reward win only (no linked accounts, no repeat farming).
      const bounty = r.attackerWon && rewards.attacker === 1
        ? bountyService.claim({ claimerId: attacker.id, targetId: defender.id, battleId: id, now })
        : null;
      // Only a full-reward win counts: no linked accounts, no repeat wins on one target.
      if (r.attackerWon && rewards.attacker === 1) daily.progress(attacker.id, 'pvp_wins', 1, { now });
      announceLevels(players, attacker.id, r.levelsGained.attacker);
      announceLevels(players, defender.id, r.levelsGained.defender);
      for (const [p, side] of [[attacker, 'attacker'], [defender, 'defender']]) {
        for (const lvl of r.levelsGained[side]) {
          const rank = game.rankFor(lvl);
          players.log(p.id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
        }
      }
      return { id, xp: r.xp.attacker, cash: r.cashTaken, bounty };
    });

    if (outcome.error) {
      req.flash('error', outcome.error);
      // Attacks launched from the players list go back to the same list view.
      const back = String(req.body.back || '');
      return res.redirect(back.startsWith('/players') && !back.startsWith('//') ? back : profileUrl);
    }
    res.locals.gains = { xp: outcome.xp, cash: outcome.cash }; // for anti-cheat
    if (outcome.bounty) req.flash('success', `Bounty collected: +$${outcome.bounty.total.toLocaleString('en-US')}.`);
    res.redirect(`/battles/${outcome.id}`);
  });

  router.post('/scout/:username', requireAuth, (req, res, next) => {
    const target = players.findByUsername(String(req.params.username));
    if (!target) return next();
    const outcome = players.transaction(() => {
      const fresh = players.findById(req.player.id);
      const out = scouting.chargeScout(fresh, target);
      if (out.error) return out;
      const now = Date.now();
      players.save(out.player, { reason: 'scout', ref: `user:${target.id}` });
      players.recordScoutReport(fresh.id, target.id, out.cost, scouting.buildReport(target, statsOf(players, target), now), now);
      // The target learns they were watched, not by whom.
      daily.progress(fresh.id, 'scout', 1, { now });
      players.notify(target.id, 'system', 'Enemy reconnaissance detected: someone has gathered intel on your training and combat readiness.', '/training');
      return out;
    });
    req.flash(outcome.error ? 'error' : 'success', outcome.error || `Intel on ${target.username} acquired for $${outcome.cost.toLocaleString('en-US')}.`);
    res.redirect(`/profile/${encodeURIComponent(target.username)}#intel`);
  });

  router.get('/battles/:id', requireAuth, (req, res, next) => {
    const id = Number(req.params.id);
    const battle = Number.isInteger(id) ? players.findBattle(id) : null;
    if (!battle) return next();
    const youAre = battle.attacker_id === req.player.id ? 'attacker' : battle.defender_id === req.player.id ? 'defender' : null;
    const warFight = warService.forBattle(battle.id);
    const bounty = bountyService.forBattle(battle.id);
    res.render('battle', {
      title: `${battle.attacker_name} vs ${battle.defender_name}`,
      nav: null,
      battle,
      r: battle.report,
      youAre,
      bounty,
      warFight: warFight ? { id: warFight.id, side: warFight.side, points: warFight.points, tag: warFight.side === 'attacker' ? warFight.attacker_tag : warFight.defender_tag, title: `${warFight.attacker_tag} vs ${warFight.defender_tag}` } : null,
      ago: presence.timeAgo(battle.created_at),
    });
  });

  return router;
}

module.exports = { pvpRoutes };
