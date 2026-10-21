'use strict';

/**
 * The field guide: once basic training is done (or hidden), HQ points each
 * player at one feature they've unlocked but haven't tried yet, in this order.
 * Each tip goes away when they try the feature, or when they hide it.
 */

const TIPS = [
  { id: 'deploy', minLevel: 1, title: 'Earn while you’re away', text: 'Send your soldier on a deployment before you log off; the pay arrives when they’re back.', link: '/deployments', cta: 'Deployments', tried: (s) => s.deployments > 0 },
  { id: 'vehicle', minLevel: 3, title: 'Get a vehicle', text: 'Vehicles raise your mission success, your pay or your raid damage.', link: '/armory/motor-pool', cta: 'Motor pool', tried: (s) => s.vehicles > 0 },
  { id: 'workshop', minLevel: 6, title: 'Upgrade your gear', text: 'Won missions turn up materials. Use them in the workshop to take your gear to Mk III.', link: '/armory/workshop', cta: 'Workshop', tried: (s) => s.upgrades > 0 },
  { id: 'market', minLevel: 5, title: 'Trade with other soldiers', text: 'Sell gear you’ve outgrown, or pick up a bargain, on the market.', link: '/armory/market', cta: 'Market', tried: (s) => s.trades > 0 },
  { id: 'contracts', minLevel: 5, title: 'Hire a mercenary, or be one', text: 'Post a contract on a rival, or take one on for pay.', link: '/contracts', cta: 'Contracts', tried: (s) => s.contracts > 0 },
  { id: 'special', minLevel: 10, title: 'Special operations', text: 'Every 6 hours a special operation opens for 3: three stages, your choice of stealth or assault, and big rewards.', link: '/missions#special', cta: 'Missions', tried: (s) => s.specials > 0 },
];
const IDS = new Set(TIPS.map((t) => t.id));

/** The tip to show: the first one unlocked at `level`, not tried (by `state`) and not hidden. */
function nextTip(level, state, hidden = new Set()) {
  return TIPS.find((t) => level >= t.minLevel && !hidden.has(t.id) && !t.tried(state)) || null;
}

/** Parses the hidden-tips column ("deploy,market"), keeping known ids only. */
const parseHidden = (text) => new Set(String(text || '').split(',').filter((id) => IDS.has(id)));

module.exports = { IDS, TIPS, nextTip, parseHidden };
