'use strict';

const daily = require('./daily');
const base = require('./base');
const { NEUTRAL } = require('./events');
const game = require('./game');
const { announceLevels } = require('./notify');
const tuning = require('./tuning');

/**
 * Daily orders and supply drops backed by the database. Claims must be called
 * inside players.transaction(); progress() can be called from any game action.
 */
function createDailyService(db, players, { effects = () => NEUTRAL } = {}) {
  const stmts = {
    orders: db.prepare('SELECT * FROM daily_orders WHERE user_id = ? AND day = ? ORDER BY slot'),
    insert: db.prepare(`INSERT OR IGNORE INTO daily_orders (user_id, day, slot, type, param, target, reward_xp, reward_cash)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    bump: db.prepare(`UPDATE daily_orders SET progress = MIN(target, progress + ?)
                      WHERE user_id = ? AND day = ? AND slot = ? AND claimed_at IS NULL`),
    claim: db.prepare('UPDATE daily_orders SET claimed_at = ? WHERE user_id = ? AND day = ? AND slot = ? AND claimed_at IS NULL AND progress >= target'),
    bonus: db.prepare('SELECT claimed_at FROM daily_bonus WHERE user_id = ? AND day = ?'),
    claimBonus: db.prepare('INSERT OR IGNORE INTO daily_bonus (user_id, day, claimed_at) VALUES (?, ?, ?)'),
    prune: db.prepare('DELETE FROM daily_orders WHERE user_id = ? AND day < ?'),
    pruneBonus: db.prepare('DELETE FROM daily_bonus WHERE user_id = ? AND day < ?'),
    countOrder: db.prepare('UPDATE users SET orders_completed = orders_completed + 1 WHERE id = ?'),
  };

  /** Today's orders, creating them on first look (orders are fixed for the day once made). */
  function ordersFor(user, now = Date.now()) {
    const day = daily.dayKey(now);
    let rows = stmts.orders.all(user.id, day);
    if (!rows.length) {
      for (const o of daily.generateOrders(user.id, user.level, day)) {
        stmts.insert.run(user.id, day, o.slot, o.type, o.param, o.target, o.rewardXp, o.rewardCash);
      }
      const weekAgo = daily.dayKey(now - 7 * 86_400_000);
      stmts.prune.run(user.id, weekAgo);
      stmts.pruneBonus.run(user.id, weekAgo);
      rows = stmts.orders.all(user.id, day);
    }
    return rows;
  }

  /** Grants XP/cash to a player row and saves it, announcing any promotions. */
  function pay(user, { xp, cash }, reason, ref) {
    const p = game.applyRegen(players.findById(user.id), Date.now());
    p.cash += cash;
    const levels = game.grantXp(p, xp);
    players.save(p, { reason, ref });
    for (const lvl of levels) {
      const rank = game.rankFor(lvl);
      players.log(p.id, 'promotion', `Promoted to level ${lvl} — ${rank.name} (${rank.grade}).`);
    }
    announceLevels(players, p.id, levels);
    return p;
  }

  return {
    ordersFor,

    /** Everything HQ needs: today's orders with text, plus bonus and reset info. */
    view(user, now = Date.now()) {
      const orders = ordersFor(user, now).map((o) => ({
        ...o,
        text: daily.orderText(o),
        done: o.progress >= o.target,
        claimed: Boolean(o.claimed_at),
        pct: Math.min(100, Math.round((o.progress / o.target) * 100)),
      }));
      const day = daily.dayKey(now);
      const reward = daily.orderReward(user.level);
      return {
        orders,
        allClaimed: orders.length > 0 && orders.every((o) => o.claimed),
        bonusClaimed: Boolean(stmts.bonus.get(user.id, day)),
        bonus: reward,
        resetInMs: daily.msUntilReset(now),
        streak: daily.streakView(user, day),
      };
    },

    /**
     * Records progress on today's orders of `type` (and matching `param`).
     * Notifies the player the moment an order is completed.
     */
    progress(userId, type, amount = 1, { param = null, now = Date.now() } = {}) {
      if (amount <= 0) return;
      const user = players.findById(userId);
      if (!user) return;
      const day = daily.dayKey(now);
      for (const o of ordersFor(user, now)) {
        if (o.type !== type || o.claimed_at || o.progress >= o.target) continue;
        if (o.param && o.param !== param) continue;
        stmts.bump.run(amount, userId, day, o.slot);
        if (o.progress + amount >= o.target) {
          players.notify(userId, 'order', `Daily order complete: ${daily.orderText(o)}. Claim your reward at HQ.`, '/hq#daily-title');
        }
      }
    },

    /** Claims a completed order. Returns { error } or { order, player }. */
    claimOrder(user, slot, now = Date.now()) {
      const day = daily.dayKey(now);
      const order = ordersFor(user, now).find((o) => o.slot === slot);
      if (!order) return { error: 'No such order today.' };
      if (order.claimed_at) return { error: 'Already claimed.' };
      if (order.progress < order.target) return { error: 'That order isn’t complete yet.' };
      if (!stmts.claim.run(now, user.id, day, slot).changes) return { error: 'Already claimed.' };
      stmts.countOrder.run(user.id); // career total, for the Order of Merit medal
      const mult = effects(now).ordersMult * (1 + base.effectsOf(players.findById(user.id)).ordersBonus) * tuning.get('dailyRewardsMult'); // Supply Surge × Comms Tower × admin setting
      const reward = { xp: Math.round(order.reward_xp * mult), cash: Math.round(order.reward_cash * mult) };
      const player = pay(user, reward, 'daily-order', `${day}:${slot}`);
      return { order: { ...order, reward_xp: reward.xp, reward_cash: reward.cash, text: daily.orderText(order) }, player };
    },

    /** The Commendation for claiming all of today's orders. */
    claimBonus(user, now = Date.now()) {
      const day = daily.dayKey(now);
      const orders = ordersFor(user, now);
      if (!orders.every((o) => o.claimed_at)) return { error: 'Claim all three orders first.' };
      if (!stmts.claimBonus.run(user.id, day, now).changes) return { error: 'Today’s commendation is already claimed.' };
      const standard = daily.orderReward(user.level);
      const mult = effects(now).ordersMult * (1 + base.effectsOf(players.findById(user.id)).ordersBonus) * tuning.get('dailyRewardsMult');
      const reward = { xp: Math.round(standard.xp * mult), cash: Math.round(standard.cash * mult) };
      return { reward, player: pay(user, reward, 'daily-bonus', day) };
    },

    /** Claims today's supply drop and advances the streak. */
    claimSupplyDrop(user, now = Date.now()) {
      const day = daily.dayKey(now);
      const p = game.applyRegen(players.findById(user.id), now);
      const drop = daily.supplyDrop(p, day);
      if (drop.error) return drop;
      drop.cash = Math.round(drop.cash * effects(now).supplyMult * tuning.get('dailyRewardsMult')); // Supply Surge event × admin setting
      p.cash += drop.cash;
      p.streak_count = drop.streak;
      p.streak_day = day;
      p.streak_best = drop.best;
      if (drop.refillEnergy) {
        p.energy = p.max_energy;
        p.energy_updated_at = now;
      }
      players.save(p, { reason: 'supply-drop', ref: day });
      return { ...drop, player: p };
    },
  };
}

module.exports = { createDailyService };
