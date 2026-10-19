'use strict';

/**
 * Supporter membership: a monthly subscription that only ever gives looks and
 * convenience, never power, cash or anything that could reach the casino.
 * Pure rules: who counts as a Supporter, the perks, and turning a payment
 * provider's webhook into a change of membership.
 *
 * Payments go through Lemon Squeezy, a "merchant of record": they sell the
 * membership on the game's behalf and handle VAT, refunds and chargebacks.
 * Checkout is a link to their page, so no payment script runs on the site.
 */

const crypto = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const GRACE_MS = 3 * DAY; // a renewal can be a little late before the perks stop
const SUPPORTER_PINS = 6; // medals a Supporter can pin (everyone else: medals.MAX_PINNED)

const PERKS = [
  { icon: 'i-star', title: 'Supporter tag', text: 'A Supporter tag next to your callsign in chat, on your profile and in the players list.' },
  { icon: 'i-crest', title: 'Every Supporter look', text: 'All Supporter callsign colours, profile banners and avatar badge packs, for as long as you’re a Supporter.' },
  { icon: 'i-podium', title: 'Six pinned medals', text: 'Show off six medals at the top of your profile instead of three.' },
  { icon: 'i-flag', title: 'Keep the game running', text: 'Your membership pays for the servers and new features. Thank you.' },
];

/** Whether the player's membership is in force at `now`. */
const isActive = (user, now = Date.now()) => Boolean(user && user.supporter_until && user.supporter_until > now);

/** The checkout link for a player: the store's link with their id and email filled in. */
function checkoutUrl(base, user) {
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('checkout[custom][user_id]', String(user.id));
  if (user.email) url.searchParams.set('checkout[email]', user.email);
  return url.toString();
}

/**
 * Checks a Lemon Squeezy webhook: the X-Signature header is an HMAC-SHA256 of
 * the raw body with the webhook's signing secret.
 */
function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const actual = Buffer.from(String(signature));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * What a webhook means for a membership. Returns null for events that don't
 * change one, else { userId, subscriptionId, status, until, portal, email,
 * event, amount, currency }. `until` is when the perks stop (0 for at once).
 */
function readWebhook(body, now = Date.now()) {
  const event = body && body.meta && body.meta.event_name;
  const data = body && body.data;
  if (!event || !data || !data.attributes) return null;
  const a = data.attributes;
  const custom = (body.meta && body.meta.custom_data) || {};
  const userId = Number(custom.user_id) || null;
  if (data.type === 'subscriptions') {
    const status = String(a.status || '');
    let until;
    if (['active', 'on_trial', 'past_due'].includes(status)) until = (time(a.renews_at) || now + 30 * DAY) + GRACE_MS;
    else if (status === 'cancelled') until = time(a.ends_at) || now; // paid up to the end of the period
    else until = 0; // expired, unpaid, paused
    return {
      event, userId, subscriptionId: String(data.id), status, until,
      portal: a.urls && typeof a.urls.customer_portal === 'string' ? a.urls.customer_portal : null,
      email: a.user_email || null,
    };
  }
  if (data.type === 'subscription-invoices') {
    return { event, userId, subscriptionId: a.subscription_id ? String(a.subscription_id) : null, status: String(a.status || ''), amount: Number(a.total) || 0, currency: a.currency || null, invoiceOnly: true };
  }
  return null;
}

module.exports = { GRACE_MS, PERKS, SUPPORTER_PINS, checkoutUrl, isActive, readWebhook, verifySignature };
