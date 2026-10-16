#!/usr/bin/env bash
# Runs the admin tool against the live database, with the server's settings.
#   sudo bash /var/www/html/deploy/admin.sh grant YourCallsign
#   sudo bash /var/www/html/deploy/admin.sh revoke SomeCallsign
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
set -a; . /etc/eliteforces/eliteforces.env; set +a
cd "$APP_DIR"
exec sudo -u eliteforces --preserve-env=DB_FILE node --disable-warning=ExperimentalWarning scripts/admin.js "$@"
