#!/usr/bin/env node
'use strict';

/**
 * Grant or revoke admin rights. Run this on the server, not through the website:
 *
 *   npm run admin -- grant <callsign>
 *   npm run admin -- revoke <callsign>
 *   npm run admin -- list
 *
 * Uses the same database as the game (DB_FILE, or data/eliteforces.db).
 */

const { openDatabase } = require('../src/db');
const { createAdminRepo } = require('../src/admin-repo');

const [command, username] = process.argv.slice(2);
const repo = createAdminRepo(openDatabase());

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (command === 'list') {
  const admins = repo.admins();
  console.log(admins.length ? admins.map((a) => `${a.username} <${a.email}>`).join('\n') : 'No admins yet.');
} else if (command === 'grant' || command === 'revoke') {
  if (!username) fail(`Usage: npm run admin -- ${command} <callsign>`);
  const changed = repo.setAdmin(username, command === 'grant');
  if (!changed) fail(`No player called "${username}". They need to register first.`);
  console.log(command === 'grant'
    ? `${username} is now an admin. They'll see the Admin link next time they load a page.`
    : `${username} is no longer an admin.`);
} else {
  fail('Usage: npm run admin -- grant <callsign> | revoke <callsign> | list');
}
