'use strict';

const workshop = require('./workshop');
const gear = require('./gear');
const vehicles = require('./vehicles');
const { ITEMS, ITEMS_BY_ID, SLOTS } = require('./items');

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * The workshop backed by the database (rules in src/workshop.js): materials,
 * drops, upgrades and salvage. find() runs inside the caller's transaction
 * (a mission, an operation, a deployment coming home); upgrade() and
 * salvage() open their own.
 */
function createWorkshopService(db, players, vehicleService) {
  const stmts = {
    materials: db.prepare('SELECT material_id, qty FROM materials WHERE user_id = ? AND qty > 0'),
    add: db.prepare(`INSERT INTO materials (user_id, material_id, qty) VALUES (?, ?, ?)
                     ON CONFLICT(user_id, material_id) DO UPDATE SET qty = MAX(0, qty + excluded.qty)`),
    take: db.prepare('UPDATE materials SET qty = qty - ? WHERE user_id = ? AND material_id = ? AND qty >= ?'),
    isBot: db.prepare('SELECT is_bot FROM users WHERE id = ?'),
    countUpgrade: db.prepare('UPDATE users SET upgrades_made = upgrades_made + 1 WHERE id = ?'),
  };

  /** Map of material id → count. */
  const materials = (userId) => new Map(stmts.materials.all(userId).filter((r) => workshop.MATERIALS_BY_ID.has(r.material_id)).map((r) => [r.material_id, r.qty]));

  /** Adds a bag of materials ({ id: n }; negative takes away, never below 0). */
  function add(userId, bag) {
    for (const [id, n] of Object.entries(bag)) if (n && workshop.MATERIALS_BY_ID.has(id)) stmts.add.run(userId, id, n);
  }

  /** Takes a bag of materials, all or nothing (inside a transaction). Returns false if they're short. */
  function take(userId, bag) {
    for (const [id, n] of Object.entries(bag)) {
      if (!stmts.take.run(n, userId, id, n).changes) throw new Error('short'); // rolls back the caller's transaction
    }
    return true;
  }

  /** The thing to upgrade or salvage: a gear item or a vehicle the player owns. */
  function target(userId, kind, id) {
    if (kind === 'gear') {
      const item = ITEMS_BY_ID.get(id);
      const conditions = players.conditions(userId);
      if (!item || !conditions.has(id)) return null;
      return { kind, thing: item, condition: conditions.get(id), upgrade: players.upgrades(userId).get(id) || 0 };
    }
    if (kind === 'vehicle' && vehicleService) {
      const vehicle = vehicles.VEHICLES_BY_ID.get(id);
      const owned = vehicleService.owned(userId);
      if (!vehicle || !owned.has(id)) return null;
      return { kind, thing: vehicle, condition: owned.get(id), upgrade: vehicleService.upgrades(userId).get(id) || 0 };
    }
    return null;
  }

  /** One row of the workshop page. */
  function row(t, have, cash) {
    const next = t.upgrade < workshop.MAX_UPGRADE ? workshop.recipe(t.thing, t.upgrade + 1) : null;
    return {
      kind: t.kind,
      id: t.thing.id,
      name: t.thing.name,
      upgrade: t.upgrade,
      upgradeLabel: workshop.label(t.upgrade),
      nextLabel: next ? workshop.label(t.upgrade + 1) : null,
      next: next ? {
        ...next,
        text: workshop.describe(next.materials),
        parts: workshop.MATERIALS.filter((m) => next.materials[m.id]).map((m) => ({ ...m, need: next.materials[m.id], have: have.get(m.id) || 0 })),
        ready: workshop.covers(have, next.materials) && cash >= next.cash,
      } : null,
      salvage: workshop.describe(workshop.salvageYield(t.thing, t.condition, t.upgrade)) || 'nothing',
    };
  }

  return {
    materials,
    add,

    /**
     * Materials turned up by an action that paid `cash` (`kind`: 'mission',
     * 'operation' or 'deployment'). Adds them and returns the bag (empty for
     * reserve soldiers).
     */
    find(userId, cash, kind = 'mission', rng = Math.random) {
      const u = stmts.isBot.get(userId);
      if (!u || u.is_bot) return {};
      const bag = workshop.drop(cash, rng, kind);
      add(userId, bag);
      return bag;
    },

    /** Everything the workshop page shows. */
    view(player) {
      const have = materials(player.id);
      const owned = players.conditions(player.id);
      const equipment = players.equipment(player.id);
      const equipped = new Set(Object.values(equipment));
      const gearRows = SLOTS.map((slot) => ({
        ...slot,
        items: ITEMS.filter((i) => i.slot === slot.id && owned.has(i.id)).sort((a, b) => b.minLevel - a.minLevel)
          .map((i) => ({ ...row(target(player.id, 'gear', i.id), have, player.cash), equipped: equipped.has(i.id) })),
      })).filter((s) => s.items.length);
      const out = vehicleService ? vehicleService.assigned(player.id) : null;
      const vehicleRows = vehicleService ? vehicles.VEHICLES.filter((v) => vehicleService.owned(player.id).has(v.id))
        .map((v) => ({ ...row(target(player.id, 'vehicle', v.id), have, player.cash), equipped: Boolean(out && out.vehicle.id === v.id) })) : [];
      return {
        materials: workshop.MATERIALS.map((m) => ({ ...m, qty: have.get(m.id) || 0 })),
        gear: gearRows,
        vehicles: vehicleRows,
      };
    },

    /** Upgrades a gear item or vehicle one level. Returns { error } or { name, label, cost }. */
    upgrade(userId, kind, id) {
      try {
        return players.transaction(() => {
          const t = target(userId, kind, id);
          if (!t) return { error: 'You don’t own that.' };
          if (t.upgrade >= workshop.MAX_UPGRADE) return { error: `The ${workshop.nameOf(t.thing, t.upgrade)} is already fully upgraded.` };
          const level = t.upgrade + 1;
          const cost = workshop.recipe(t.thing, level);
          const fresh = players.findById(userId);
          if (!workshop.covers(materials(userId), cost.materials)) return { error: `Not enough materials. ${workshop.label(level)} needs ${workshop.describe(cost.materials)}.` };
          if (fresh.cash < cost.cash) return { error: `The workshop fee is ${money(cost.cash)}. You have ${money(fresh.cash)} in cash.` };
          take(userId, cost.materials);
          fresh.cash -= cost.cash;
          players.save(fresh, { reason: 'workshop', ref: `${kind}:${id}:${level}` });
          if (kind === 'gear') players.setUpgrade(userId, id, level);
          else vehicleService.setUpgrade(userId, id, level);
          stmts.countUpgrade.run(userId);
          players.log(userId, 'system', `Upgraded the ${t.thing.name} to ${workshop.label(level)} for ${workshop.describe(cost.materials)} and ${money(cost.cash)}.`, '/armory/workshop');
          return { name: workshop.nameOf(t.thing, level), cost };
        });
      } catch (err) {
        if (err.message === 'short') return { error: 'Not enough materials.' };
        throw err;
      }
    },

    /** Breaks down a gear item or vehicle for materials. Returns { error } or { name, bag }. */
    salvage(userId, kind, id) {
      return players.transaction(() => {
        const t = target(userId, kind, id);
        if (!t) return { error: 'You don’t own that.' };
        const bag = workshop.salvageYield(t.thing, t.condition, t.upgrade);
        const gone = kind === 'gear' ? players.removeItem(userId, id) : vehicleService.remove(userId, id);
        if (!gone) return { error: 'You don’t own that.' };
        add(userId, bag);
        const name = workshop.nameOf(t.thing, t.upgrade);
        players.log(userId, 'system', `Salvaged the ${name} for ${workshop.describe(bag) || 'nothing usable'}.`, '/armory/workshop');
        return { name, bag };
      });
    },
  };
}

module.exports = { createWorkshopService };
