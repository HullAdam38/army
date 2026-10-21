'use strict';

const market = require('./market');
const gear = require('./gear');
const workshop = require('./workshop');
const vehicles = require('./vehicles');
const { ITEMS, SLOTS } = require('./items');

const DAY = 24 * 60 * 60 * 1000;
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The market backed by the database (rules in src/market.js). list(), buy()
 * and cancel() open their own transactions. Money moves through the ledger:
 * `market-fee` (listing), `market-buy` (the buyer pays), `market-sale` (the
 * seller gets the price less tax), `market-return` (an expired listing the
 * seller can't take back, bought by the Armory instead).
 * `isLinked(a, b, now)` comes from anti-cheat.
 */
function createMarketService(db, players, { vehicleService, workshopService, isLinked = () => false }) {
  const stmts = {
    insert: db.prepare(`INSERT INTO market_listings (seller_id, kind, ref_id, qty, condition, upgrade, price, fee, created_at, expires_at)
                        VALUES (@seller, @kind, @ref, @qty, @condition, @upgrade, @price, @fee, @now, @expires)`),
    byId: db.prepare('SELECT * FROM market_listings WHERE id = ?'),
    active: db.prepare("SELECT COUNT(*) AS n FROM market_listings WHERE seller_id = ? AND status = 'open'"),
    settle: db.prepare("UPDATE market_listings SET status = ?, buyer_id = ?, settled_at = ? WHERE id = ? AND status = 'open'"),
    open: db.prepare(`SELECT l.*, u.username AS seller FROM market_listings l JOIN users u ON u.id = l.seller_id
                      WHERE l.status = 'open' AND l.expires_at > ? AND u.banned_at IS NULL ORDER BY l.created_at DESC LIMIT 300`),
    mine: db.prepare(`SELECT l.*, b.username AS buyer FROM market_listings l LEFT JOIN users b ON b.id = l.buyer_id
                      WHERE l.seller_id = ? ORDER BY l.status = 'open' DESC, l.id DESC LIMIT 30`),
    sold: db.prepare(`SELECT l.kind, l.ref_id, l.qty, l.condition, l.upgrade, l.price, l.settled_at FROM market_listings l
                      WHERE l.status = 'sold' ORDER BY l.settled_at DESC LIMIT ?`),
    due: db.prepare("SELECT id FROM market_listings WHERE status = 'open' AND expires_at <= ?"),
    addMaterial: db.prepare(`INSERT INTO materials (user_id, material_id, qty) VALUES (?, ?, ?)
                             ON CONFLICT(user_id, material_id) DO UPDATE SET qty = qty + excluded.qty`),
    takeMaterial: db.prepare('UPDATE materials SET qty = qty - ? WHERE user_id = ? AND material_id = ? AND qty >= ?'),
  };

  /** Whether `userId` already has the gear item or vehicle (they can only own one of each). */
  function owns(userId, kind, refId) {
    if (kind === 'gear') return players.ownedItemIds(userId).has(refId);
    if (kind === 'vehicle') return vehicleService.owned(userId).has(refId);
    return false;
  }

  /** Puts a listed thing into `userId`'s hands, with the condition and upgrade it was listed with. */
  function deliver(userId, l) {
    if (l.kind === 'gear') {
      players.addItem(userId, l.ref_id);
      players.setCondition(userId, l.ref_id, l.condition);
      if (l.upgrade) players.setUpgrade(userId, l.ref_id, l.upgrade);
    } else if (l.kind === 'vehicle') {
      vehicleService.grant(userId, l.ref_id);
      vehicleService.setCondition(userId, l.ref_id, l.condition);
      if (l.upgrade) vehicleService.setUpgrade(userId, l.ref_id, l.upgrade);
    } else {
      stmts.addMaterial.run(userId, l.ref_id, l.qty);
    }
  }

  /** Gives a listing back to its seller (withdrawn or expired). If they've bought another since, the Armory buys this one. */
  function giveBack(l, status, now) {
    if (!stmts.settle.run(status, null, now, l.id).changes) return null;
    if (owns(l.seller_id, l.kind, l.ref_id)) {
      const value = gear.saleValue(market.thingOf(l.kind, l.ref_id), l.condition);
      const p = players.findById(l.seller_id);
      p.cash += value;
      players.save(p, { reason: 'market-return', ref: `listing:${l.id}` });
      return { sold: value };
    }
    deliver(l.seller_id, l);
    return { returned: true };
  }

  /** What `player` could put up for sale, grouped for the sell form. */
  function sellable(player) {
    const owned = players.ownedItemIds(player.id);
    const conditions = players.conditions(player.id);
    const upgrades = players.upgrades(player.id);
    const equipped = new Set(Object.values(players.equipment(player.id)));
    const out = vehicleService.assigned(player.id);
    const vConditions = vehicleService.owned(player.id);
    const vUpgrades = vehicleService.upgrades(player.id);
    const row = (kind, thing, condition, upgrade, inUse) => {
      const range = market.priceRange(kind, thing, { condition, upgrade });
      return { kind, id: thing.id, name: `${workshop.nameOf(thing, upgrade)}${condition < 100 ? ` (${Math.floor(condition)}%)` : ''}`, inUse, range };
    };
    return [
      ...SLOTS.map((slot) => ({
        label: slot.label,
        items: ITEMS.filter((i) => i.slot === slot.id && owned.has(i.id)).map((i) => row('gear', i, conditions.get(i.id) ?? 100, upgrades.get(i.id) || 0, equipped.has(i.id))),
      })),
      { label: 'Vehicles', items: vehicles.VEHICLES.filter((v) => vConditions.has(v.id)).map((v) => row('vehicle', v, vConditions.get(v.id), vUpgrades.get(v.id) || 0, Boolean(out && out.vehicle.id === v.id))) },
      { label: 'Workshop materials (price for the lot)', items: [...workshopService.materials(player.id)].map(([id, qty]) => {
        const m = workshop.MATERIALS_BY_ID.get(id);
        return { kind: 'material', id, name: `${m.name} (you have ${qty.toLocaleString('en-US')})`, have: qty, range: market.priceRange('material', m, { qty: 1 }) };
      }) },
    ].filter((g) => g.items.length);
  }

  return {
    sellable,

    /** Puts something up for sale. `input`: { thing: 'gear:id' | 'vehicle:id' | 'material:id', price, qty }. */
    list(sellerId, input, now = Date.now()) {
      const [kind, refId] = String(input.thing || '').split(':');
      const thing = market.thingOf(kind, refId);
      if (!thing) return { error: 'Pick something to sell.' };
      const price = market.parsePrice(input.price);
      return players.transaction(() => {
        const seller = players.findById(sellerId);
        let condition = 100;
        let upgrade = 0;
        let qty = 1;
        if (kind === 'gear') {
          const conditions = players.conditions(sellerId);
          if (!conditions.has(refId)) return { error: 'You don’t own that.' };
          condition = conditions.get(refId);
          upgrade = players.upgrades(sellerId).get(refId) || 0;
        } else if (kind === 'vehicle') {
          const owned = vehicleService.owned(sellerId);
          if (!owned.has(refId)) return { error: 'You don’t own that.' };
          condition = owned.get(refId);
          upgrade = vehicleService.upgrades(sellerId).get(refId) || 0;
        } else {
          qty = Math.floor(Number(input.qty));
          if (!Number.isInteger(qty) || qty < 1 || qty > market.MAX_QTY) return { error: 'Give how many to sell.' };
          if ((workshopService.materials(sellerId).get(refId) || 0) < qty) return { error: `You don’t have ${qty.toLocaleString('en-US')} ${thing.name}.` };
        }
        const range = market.priceRange(kind, thing, { condition, upgrade, qty });
        const why = market.listBlocker(seller, { price, active: stmts.active.get(sellerId).n, range });
        if (why) return { error: why };
        // The market holds it from now on.
        if (kind === 'gear' && !players.removeItem(sellerId, refId)) return { error: 'You don’t own that.' };
        if (kind === 'vehicle' && !vehicleService.remove(sellerId, refId)) return { error: 'You don’t own that.' };
        if (kind === 'material' && !stmts.takeMaterial.run(qty, sellerId, refId, qty).changes) return { error: 'You don’t have that many.' };
        const fee = market.listingFee(price);
        const id = Number(stmts.insert.run({ seller: sellerId, kind, ref: refId, qty, condition, upgrade, price, fee, now, expires: now + market.DAYS * DAY }).lastInsertRowid);
        seller.cash -= fee;
        players.save(seller, { reason: 'market-fee', ref: `listing:${id}` });
        const listing = stmts.byId.get(id);
        return { listing, name: market.nameOf(listing), fee };
      });
    },

    /** Buys a listing. Returns { error } or { listing, name }. */
    buy(buyerId, id, now = Date.now()) {
      return players.transaction(() => {
        const l = stmts.byId.get(id);
        if (!l || l.status !== 'open' || l.expires_at <= now) return { error: 'That’s no longer for sale.' };
        const buyer = players.findById(buyerId);
        const why = market.buyBlocker(buyer, l, { linked: isLinked(buyerId, l.seller_id, now), owns: owns(buyerId, l.kind, l.ref_id) });
        if (why) return { error: why };
        if (!stmts.settle.run('sold', buyerId, now, id).changes) return { error: 'That’s no longer for sale.' };
        buyer.cash -= l.price;
        players.save(buyer, { reason: 'market-buy', ref: `listing:${id}` });
        const seller = players.findById(l.seller_id);
        const gets = market.proceeds(l.price);
        seller.cash += gets;
        players.save(seller, { reason: 'market-sale', ref: `listing:${id}` });
        deliver(buyerId, l);
        const name = market.nameOf(l);
        players.notify(l.seller_id, 'system', `Sold on the market: ${name} to ${buyer.username} for ${money(l.price)}. You get ${money(gets)} after tax.`, '/armory/market#mine');
        players.log(buyerId, 'system', `Bought ${name} on the market from ${seller.username} for ${money(l.price)}.`, '/armory/market');
        return { listing: l, name, gets };
      });
    },

    /** The seller withdraws a listing and gets it back (the fee isn't refunded). */
    cancel(sellerId, id, now = Date.now()) {
      return players.transaction(() => {
        const l = stmts.byId.get(id);
        if (!l || l.seller_id !== sellerId || l.status !== 'open') return { error: 'That isn’t one of your listings.' };
        const back = giveBack(l, 'cancelled', now);
        return { name: market.nameOf(l), ...back };
      });
    },

    /** Returns listings nobody bought in time. */
    expireDue(now = Date.now()) {
      let n = 0;
      for (const { id } of stmts.due.all(now)) {
        players.transaction(() => {
          const l = stmts.byId.get(id);
          if (!l || l.status !== 'open') return;
          const back = giveBack(l, 'expired', now);
          if (!back) return;
          n += 1;
          players.notify(l.seller_id, 'system', back.sold
            ? `Your ${market.nameOf(l)} didn’t sell. You’d bought another, so the Armory bought it for ${money(back.sold)}.`
            : `Your ${market.nameOf(l)} didn’t sell in ${market.DAYS} days and is back with you.`, '/armory/market#mine');
        });
      }
      return n;
    },
    schedule() {
      setInterval(() => { try { this.expireDue(); } catch (err) { console.error('[market] expiry failed', err); } }, 60 * 1000).unref();
    },

    /** Everything the market page shows. `filter`: { kind, sort }. */
    view(viewer, { kind = 'all', sort = 'newest' } = {}, now = Date.now()) {
      const rows = stmts.open.all(now)
        .filter((l) => kind === 'all' || l.kind === kind)
        .map((l) => {
          const thing = market.thingOf(l.kind, l.ref_id);
          return {
            ...l,
            name: market.nameOf(l),
            level: thing && thing.minLevel ? thing.minLevel : null,
            unit: l.kind === 'material' ? l.price / l.qty : null,
            shopPrice: thing && thing.price ? thing.price : null,
            mine: l.seller_id === viewer.id,
            blocker: l.seller_id === viewer.id ? null : market.buyBlocker(viewer, l, { linked: isLinked(viewer.id, l.seller_id, now), owns: owns(viewer.id, l.kind, l.ref_id) }),
          };
        });
      const by = { newest: (a, b) => b.created_at - a.created_at, cheapest: (a, b) => (a.unit ?? a.price) - (b.unit ?? b.price), dearest: (a, b) => (b.unit ?? b.price) - (a.unit ?? a.price) }[sort] || (() => 0);
      return {
        listings: rows.sort(by),
        mine: stmts.mine.all(viewer.id).map((l) => ({ ...l, name: market.nameOf(l) })),
        sold: stmts.sold.all(8).map((l) => ({ ...l, name: market.nameOf(l) })),
        sellable: sellable(viewer),
        listingCount: stmts.active.get(viewer.id).n,
      };
    },
  };
}

module.exports = { createMarketService };
