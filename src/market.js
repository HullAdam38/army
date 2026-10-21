'use strict';

/**
 * The market: players sell gear, vehicles and workshop materials to each other. Pure rules.
 *
 * A listed thing leaves the seller's inventory (held by the market) until it
 * sells, the seller withdraws it, or it expires after a few days. Listing
 * costs a small fee and each sale a tax, both destroyed, so the market is a
 * money sink. Prices are kept within a range of what the thing is worth, and
 * linked accounts can't trade with each other, so it's a poor way to pass
 * money between accounts.
 */

const tuning = require('./tuning');
const gear = require('./gear');
const workshop = require('./workshop');
const vehicles = require('./vehicles');
const { ITEMS_BY_ID } = require('./items');

const MIN_LEVEL = 5;
const MAX_LISTINGS = 10;
const DAYS = 3;
const MAX_QTY = 100000;

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** The catalogue entry a listing is for. */
function thingOf(kind, refId) {
  if (kind === 'gear') return ITEMS_BY_ID.get(refId) || null;
  if (kind === 'vehicle') return vehicles.VEHICLES_BY_ID.get(refId) || null;
  if (kind === 'material') return workshop.MATERIALS_BY_ID.get(refId) || null;
  return null;
}

/** The lowest and highest price allowed: { min, max } (for materials, the whole lot). */
function priceRange(kind, thing, { condition = 100, upgrade = 0, qty = 1 } = {}) {
  if (kind === 'material') return { min: Math.ceil(thing.worth * 0.5 * qty), max: Math.floor(thing.worth * 3 * qty) };
  // From what the Armory pays for it, to half again the shop price (more for upgrades).
  return { min: Math.max(1, gear.saleValue(thing, condition)), max: Math.floor(thing.price * 1.5 * (1 + 0.25 * upgrade)) };
}

/** The fee to list at `price` (destroyed, never refunded), and what the seller gets if it sells. */
const listingFee = (price) => Math.max(10, Math.ceil(price * tuning.get('marketListingFee')));
const proceeds = (price) => price - Math.ceil(price * tuning.get('marketTaxRate'));

/** "Assault Rifle Mk II (62%)", "Patrol Jeep", "120 Scrap metal". */
function nameOf(listing) {
  const thing = thingOf(listing.kind, listing.ref_id);
  if (!thing) return 'Unknown item';
  if (listing.kind === 'material') return `${listing.qty.toLocaleString('en-US')} ${thing.name}`;
  return `${workshop.nameOf(thing, listing.upgrade)}${listing.condition < 100 ? ` (${Math.floor(listing.condition)}%)` : ''}`;
}

/** Parses a price like "2,500" or "$2500". Returns a whole number or NaN. */
const parsePrice = (input) => Math.floor(Number(String(input || '').replace(/[,$\s]/g, '')));

/** Why `seller` can't list this, or null. `ctx`: { price, active (their open listings), range }. */
function listBlocker(seller, { price, active, range }) {
  if (seller.level < MIN_LEVEL) return `The market opens at level ${MIN_LEVEL}.`;
  if (active >= MAX_LISTINGS) return `You can have ${MAX_LISTINGS} things for sale at once.`;
  if (!Number.isFinite(price) || price < 1) return 'Give a price in whole dollars.';
  if (price < range.min) return `The lowest price for that is ${money(range.min)}.`;
  if (price > range.max) return `The highest price for that is ${money(range.max)}.`;
  const fee = listingFee(price);
  if (seller.cash < fee) return `Listing it costs a ${money(fee)} fee. You have ${money(seller.cash)} in cash.`;
  return null;
}

/** Why `buyer` can't buy `listing`, or null. `ctx`: { linked, owns (they already have one) }. */
function buyBlocker(buyer, listing, { linked, owns }) {
  if (listing.seller_id === buyer.id) return 'That’s your own listing.';
  if (buyer.level < MIN_LEVEL) return `The market opens at level ${MIN_LEVEL}.`;
  const thing = thingOf(listing.kind, listing.ref_id);
  if (thing && thing.minLevel && buyer.level < thing.minLevel) return `Needs level ${thing.minLevel}.`;
  if (owns) return listing.kind === 'vehicle' ? 'You already have one in your motor pool.' : 'You already own one.';
  if (linked) return 'You can’t trade with this seller: your accounts have been used on the same device or network.';
  if (buyer.cash < listing.price) return `Costs ${money(listing.price)}; you have ${money(buyer.cash)} in cash.`;
  return null;
}

module.exports = { DAYS, MAX_LISTINGS, MAX_QTY, MIN_LEVEL, buyBlocker, listBlocker, listingFee, nameOf, parsePrice, priceRange, proceeds, thingOf };
