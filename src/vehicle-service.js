'use strict';

const vehicles = require('./vehicles');
const gear = require('./gear');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * The motor pool backed by the database (rules in src/vehicles.js). Changes
 * that move cash run inside players.transaction(); wear() runs inside the
 * caller's (a mission, a raid strike, a deployment coming home).
 */
function createVehicleService(db, players) {
  const stmts = {
    owned: db.prepare('SELECT vehicle_id, condition FROM vehicles WHERE user_id = ? ORDER BY acquired_at'),
    one: db.prepare('SELECT condition FROM vehicles WHERE user_id = ? AND vehicle_id = ?'),
    assigned: db.prepare(`SELECT u.vehicle_id, u.is_bot, v.condition FROM users u
                          LEFT JOIN vehicles v ON v.user_id = u.id AND v.vehicle_id = u.vehicle_id WHERE u.id = ?`),
    add: db.prepare('INSERT OR IGNORE INTO vehicles (user_id, vehicle_id, condition, acquired_at) VALUES (?, ?, 100, ?)'),
    remove: db.prepare('DELETE FROM vehicles WHERE user_id = ? AND vehicle_id = ?'),
    setCondition: db.prepare('UPDATE vehicles SET condition = ? WHERE user_id = ? AND vehicle_id = ?'),
    assign: db.prepare('UPDATE users SET vehicle_id = ? WHERE id = ?'),
    unassignIf: db.prepare('UPDATE users SET vehicle_id = NULL WHERE id = ? AND vehicle_id = ?'),
  };

  /** Map of vehicle id → condition. */
  const owned = (userId) => new Map(stmts.owned.all(userId).filter((r) => vehicles.VEHICLES_BY_ID.has(r.vehicle_id)).map((r) => [r.vehicle_id, r.condition]));

  /** The vehicle the player takes out, or null: { vehicle, condition, bot }. */
  function assigned(userId) {
    const r = stmts.assigned.get(userId);
    const vehicle = r && r.vehicle_id && r.condition !== null ? vehicles.VEHICLES_BY_ID.get(r.vehicle_id) : null;
    return vehicle ? { vehicle, condition: r.condition, bot: Boolean(r.is_bot) } : null;
  }

  /** The bonuses the player's assigned vehicle gives right now. */
  function bonuses(userId) {
    const a = assigned(userId);
    return a ? vehicles.bonusesOf(a.vehicle, a.condition) : vehicles.NO_BONUS;
  }

  return {
    owned,
    assigned,
    bonuses,

    /** Every vehicle in the catalogue by class, with this player's state for each. */
    garage(player) {
      const mine = owned(player.id);
      const out = assigned(player.id);
      return vehicles.CLASSES.map((cls) => ({
        ...cls,
        vehicles: vehicles.VEHICLES.filter((v) => v.cls === cls.id).map((v) => {
          const has = mine.has(v.id);
          const condition = has ? mine.get(v.id) : 100;
          let state = 'buy';
          if (out && out.vehicle.id === v.id) state = 'assigned';
          else if (has) state = 'owned';
          else if (player.level < v.minLevel) state = 'locked';
          else if (player.cash < v.price) state = 'expensive';
          return {
            ...v,
            state,
            owned: has,
            condition,
            conditionLabel: gear.conditionLabel(condition),
            power: Math.round(gear.effectiveness(condition) * 100),
            repairCost: has ? gear.repairCost(v, condition) : 0,
            saleValue: has ? gear.saleValue(v, condition) : 0,
            bonusText: vehicles.describe(vehicles.bonusesOf(v, condition)),
            fullText: vehicles.describe(vehicles.bonusesOf(v, 100)),
          };
        }),
      }));
    },

    /** Buys a vehicle and takes it out if nothing else is. Returns { error } or { vehicle, assigned }. */
    buy(userId, vehicleId) {
      return players.transaction(() => {
        const fresh = players.findById(userId);
        const check = vehicles.checkPurchase(vehicleId, fresh, owned(userId));
        if (check.error) return check;
        fresh.cash -= check.vehicle.price;
        players.save(fresh, { reason: 'vehicle', ref: check.vehicle.id });
        stmts.add.run(userId, check.vehicle.id, Date.now());
        const take = !assigned(userId);
        if (take) stmts.assign.run(check.vehicle.id, userId);
        players.log(userId, 'system', `Bought the ${check.vehicle.name} for ${money(check.vehicle.price)}.`);
        return { vehicle: check.vehicle, assigned: take };
      });
    },

    /** Takes an owned vehicle out (only one at a time). */
    assign(userId, vehicleId) {
      const vehicle = vehicles.VEHICLES_BY_ID.get(vehicleId);
      if (!vehicle || !stmts.one.get(userId, vehicleId)) return { error: 'You don’t own that vehicle.' };
      stmts.assign.run(vehicle.id, userId);
      return { vehicle };
    },

    /** Leaves the vehicle in the motor pool. */
    park(userId) {
      const a = assigned(userId);
      if (!a) return { error: 'You haven’t taken a vehicle out.' };
      stmts.assign.run(null, userId);
      return { vehicle: a.vehicle };
    },

    /** Repairs one vehicle (or 'all') to 100%. Returns { error } or { cost, jobs }. */
    repair(userId, which) {
      return players.transaction(() => {
        const fresh = players.findById(userId);
        const mine = owned(userId);
        if (which !== 'all' && !mine.has(which)) return { error: 'You don’t own that vehicle.' };
        const jobs = [...mine].filter(([id, c]) => (which === 'all' || id === which) && c < 100)
          .map(([id, c]) => { const vehicle = vehicles.VEHICLES_BY_ID.get(id); return { vehicle, cost: gear.repairCost(vehicle, c) }; });
        if (!jobs.length) return { error: which === 'all' ? 'Every vehicle you own is in perfect condition.' : 'That vehicle is already in perfect condition.' };
        const cost = jobs.reduce((n, j) => n + j.cost, 0);
        if (fresh.cash < cost) return { error: `That repair costs ${money(cost)}. You have ${money(fresh.cash)} in cash.` };
        fresh.cash -= cost;
        players.save(fresh, { reason: 'vehicle-repair', ref: which === 'all' ? 'all' : which });
        for (const j of jobs) stmts.setCondition.run(100, userId, j.vehicle.id);
        return { cost, jobs };
      });
    },

    /** Sells a vehicle back for a share of its price (less when worn). */
    sell(userId, vehicleId) {
      return players.transaction(() => {
        const fresh = players.findById(userId);
        const vehicle = vehicles.VEHICLES_BY_ID.get(vehicleId);
        const row = vehicle && stmts.one.get(userId, vehicle.id);
        if (!row) return { error: 'You don’t own that vehicle.' };
        const value = gear.saleValue(vehicle, row.condition);
        stmts.remove.run(userId, vehicle.id);
        stmts.unassignIf.run(userId, vehicle.id);
        fresh.cash += value;
        players.save(fresh, { reason: 'vehicle-sale', ref: vehicle.id });
        players.log(userId, 'system', `Sold the ${vehicle.name} for ${money(value)}.`);
        return { vehicle, value };
      });
    },

    /**
     * Wears the assigned vehicle for `times` uses of `event` (a key of
     * vehicles.WEAR), telling the player when it drops below 50% or 15%.
     * Reserve soldiers' vehicles don't wear. Returns { before, after } or null.
     */
    wear(userId, event, times = 1) {
      const points = (vehicles.WEAR[event] || 0) * times;
      const a = points ? assigned(userId) : null;
      if (!a || a.bot) return null;
      const before = a.condition;
      const after = vehicles.worn(before, points);
      if (after === before) return null;
      stmts.setCondition.run(after, userId, a.vehicle.id);
      const crossed = [gear.BROKEN_AT, gear.WORN_AT].find((t) => before >= t && after < t);
      if (crossed) {
        players.notify(userId, 'system', crossed === gear.BROKEN_AT
          ? `Your ${a.vehicle.name} is badly worn (${Math.floor(after)}%) and only gives ${Math.round(gear.effectiveness(after) * 100)}% of its bonus. Repair it in the motor pool.`
          : `Your ${a.vehicle.name} is getting worn (${Math.floor(after)}%) and starting to lose its bonus. Repair it in the motor pool.`, '/armory/motor-pool');
      }
      return { vehicle: a.vehicle, before, after };
    },

    /** Admin: gives a vehicle (at 100%). Returns false if they had it. */
    grant: (userId, vehicleId) => stmts.add.run(userId, vehicleId, Date.now()).changes > 0,
    /** Admin: takes a vehicle away. Returns false if they didn't have it. */
    remove(userId, vehicleId) {
      stmts.unassignIf.run(userId, vehicleId);
      return stmts.remove.run(userId, vehicleId).changes > 0;
    },
  };
}

module.exports = { createVehicleService };
