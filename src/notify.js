'use strict';

const game = require('./game');
const { ITEMS } = require('./items');
const pvp = require('./pvp');

/** What becomes available on reaching `level`: missions, gear and PvP. */
function unlocksAt(level) {
  const unlocks = [];
  for (const m of game.MISSIONS) if (m.minLevel === level) unlocks.push({ kind: 'unlock', message: `New mission unlocked: ${m.name}.`, link: '/missions' });
  const gear = ITEMS.filter((i) => i.minLevel === level).map((i) => i.name);
  if (gear.length) unlocks.push({ kind: 'unlock', message: `New gear in the Armory: ${gear.join(', ')}.`, link: '/armory' });
  if (level === pvp.MIN_PVP_LEVEL) {
    unlocks.push({ kind: 'unlock', message: 'PvP unlocked. You can now attack other soldiers, and they can attack you.', link: '/players?filter=targets' });
  }
  return unlocks;
}

/** Sends promotion and unlock notifications for each level gained. */
function announceLevels(players, userId, levels) {
  for (const level of levels) {
    const rank = game.rankFor(level);
    players.notify(userId, 'promotion', `Promoted to level ${level}: ${rank.name} (${rank.grade}).`, null);
    for (const u of unlocksAt(level)) players.notify(userId, u.kind, u.message, u.link);
  }
}

module.exports = { announceLevels, unlocksAt };
