// Runs before `npm start` and `npm run dev`. Written in old-style JavaScript on
// purpose so it works on any Node version and can explain the problem.
'use strict';

var parts = process.versions.node.split('.').map(Number);
var ok = parts[0] > 22 || (parts[0] === 22 && parts[1] >= 13);

if (!ok) {
  console.error('');
  console.error('  EliteForces needs Node.js 22.13 or newer, but this is Node ' + process.version + '.');
  console.error('  (' + process.execPath + ')');
  console.error('');
  console.error('  On Linux Mint / Ubuntu, run the setup script from the project folder:');
  console.error('      bash scripts/setup-linux.sh');
  console.error('');
  console.error('  If you use nvm:   nvm install 22 && nvm alias default 22');
  console.error('  Then open a new terminal and check with:   node -v');
  console.error('');
  process.exit(1);
}
