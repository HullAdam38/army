// Runs before `npm start`, `npm run dev` and `npm test`: checks the Node version and
// that packages are installed. Old-style JavaScript on purpose so it runs on any Node
// version and can explain the problem.

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

// Packages missing (npm install never ran, or a new one was added since).
var path = require('path');
var root = path.join(__dirname, '..');
var deps = Object.keys(require(path.join(root, 'package.json')).dependencies || {});
var missing = deps.filter(function (name) {
  try {
    require.resolve(name, { paths: [root] });
    return false;
  } catch (e) {
    return true;
  }
});
if (missing.length) {
  console.error('');
  console.error('  The game\'s packages aren\'t installed (missing: ' + missing.join(', ') + ').');
  console.error('  From the project folder (' + root + '), run:');
  console.error('');
  console.error('      npm install');
  console.error('');
  process.exit(1);
}
