#!/usr/bin/env bash
# One-time setup for running GeneralForces locally on Linux Mint, Ubuntu or Debian.
#
#   bash scripts/setup-linux.sh
#
# Installs git, curl and Node.js 22 (from NodeSource; Mint's own Node is too old),
# plus DB Browser for SQLite to look inside the database, then installs the
# project's packages and runs the tests. Safe to run again.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user (it uses sudo when it needs to)." >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "This script is for Mint, Ubuntu or Debian (apt). Install Node.js 22.13+ yourself, then run: npm ci" >&2
  exit 1
fi

say "Installing system packages (git, curl, DB Browser for SQLite)"
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg sqlitebrowser

# The game needs Node 22.13 or newer (it uses the built-in node:sqlite module).
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

if node_ok; then
  say "Node.js $(node -v) is already installed"
else
  say "Installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  hash -r
  if ! node_ok; then
    echo "Node.js 22 was installed to /usr/bin/node, but 'node' here is still $(node -v 2>/dev/null || echo missing) at $(command -v node || echo nowhere)." >&2
    echo "An older Node (often from nvm) comes first in your PATH. Fix it with:  nvm install 22 && nvm alias default 22" >&2
    echo "or remove the old one, then open a new terminal and run this script again." >&2
    exit 1
  fi
  say "Node.js $(node -v) installed"
fi

say "Installing the game's packages"
npm ci

say "Running the tests"
npm test >/tmp/generalforces-tests.log 2>&1 && echo "All tests passed." || {
  echo "Some tests failed; see /tmp/generalforces-tests.log" >&2
  exit 1
}

cat <<'EOF'

All set. To play:

  npm run dev        then open http://localhost:3000

Register an account, then make yourself an admin with:

  npm run admin -- grant YourCallsign

The database lives in data/eliteforces.db. Open it with "DB Browser for SQLite"
from the Mint menu (close the game first if you plan to edit anything).
EOF
