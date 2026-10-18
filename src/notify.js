'use strict';

const game = require('./game');
const { ITEMS } = require('./items');
const pvp = require('./pvp');
const units = require('./units');
const perks = require('./perks');
const { OPERATIONS } = require('./operations');
const { SUPPLIES } = require('./supplies');

/** What becomes available on reaching `level`: missions, gear and PvP. */
function unlocksAt(level) {
  const unlocks = [];
  for (const m of game.MISSIONS) if (m.minLevel === level) unlocks.push({ kind: 'unlock', message: `New mission unlocked: ${m.name}.`, link: '/missions' });
  const gear = ITEMS.filter((i) => i.minLevel === level).map((i) => i.name);
  if (gear.length) unlocks.push({ kind: 'unlock', message: `New gear in the Armory: ${gear.join(', ')}.`, link: '/armory' });
  if (level === pvp.MIN_PVP_LEVEL) {
    unlocks.push({ kind: 'unlock', message: 'PvP unlocked. You can now attack other soldiers, and they can attack you.', link: '/players?filter=targets' });
  }
  for (const op of OPERATIONS) if (op.minLevel === level) unlocks.push({ kind: 'unlock', message: `New operation unlocked: ${op.name}. Clear all three stages for a big bonus.`, link: `/missions#op-${op.id}` });
  const supplyNames = SUPPLIES.filter((s) => s.minLevel === level).map((s) => s.name);
  if (supplyNames.length) unlocks.push({ kind: 'unlock', message: `New supplies in the Armory: ${supplyNames.join(', ')}.`, link: '/armory#supplies' });
  for (const p of perks.perksAt(level)) unlocks.push({ kind: 'unlock', message: `Rank perk unlocked (${p.rank}): ${p.text}.`, link: '/missions' });
  if (level === 15) unlocks.push({ kind: 'unlock', message: 'Campaign 2 is open: Forward operations. Bigger missions, bigger pay.', link: '/missions#campaign-2' });
  const campaignOpens = { 51: [4, 'The shadow war'], 66: [5, 'Iron horizon'], 81: [6, 'Endgame'] };
  if (campaignOpens[level]) {
    const [n, name] = campaignOpens[level];
    unlocks.push({ kind: 'unlock', message: `Campaign ${n} is open: ${name}.`, link: `/missions#campaign-${n}` });
  }
  if (level === 35) unlocks.push({ kind: 'unlock', message: 'Campaign 3 is open: Global war. The toughest missions in the game, for the high command.', link: '/missions#campaign-3' });
  if (level === units.CREATE_LEVEL) {
    unlocks.push({ kind: 'unlock', message: `You can now found your own unit for $${units.CREATE_COST.toLocaleString('en-US')}.`, link: '/units' });
  }
  return unlocks;
}

/** Sends promotion and unlock notifications for each level gained. */
function announceLevels(players, userId, levels) {
  for (const level of levels) {
    const rank = game.rankFor(level);
    players.notify(userId, 'promotion', `Promoted to level ${level}: ${rank.name} (${rank.grade}).`, null);
    for (const u of unlocksAt(level)) players.notify(userId, u.kind, u.message, u.link);
    // A nudge for soldiers still on their own: units are where raids, rallies and the theatre of war happen.
    if (level === units.CREATE_LEVEL) {
      const p = players.findById(userId);
      if (p && !p.unit_id) players.notify(userId, 'unit', 'Still on your own? Units share rally orders, raids and the theatre of war. See who’s recruiting, or put yourself on the list so officers can invite you.', '/units#recommended');
    }
  }
}

module.exports = { announceLevels, unlocksAt };
