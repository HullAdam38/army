#!/usr/bin/env bash
# Pulls the latest code and restarts the game. Run as root, or as a user who
# can use sudo, from anywhere:
#   bash /var/www/html/deploy/update.sh
# git and npm always run as the user who owns the code, never as root.
# It backs up the database first, and if the new version doesn't start it
# says so (the previous code is one `git checkout` away; see DEPLOY.md).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

OWNER="$(stat -c %U "$APP_DIR")"
if [ "$(id -u)" -eq 0 ]; then
  as_owner() { sudo -u "$OWNER" -H env GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' "$@"; }
  priv() { "$@"; }
else
  as_owner() { "$@"; }
  priv() { sudo "$@"; }
fi

BRANCH="$(as_owner git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
BEFORE="$(as_owner git -C "$APP_DIR" rev-parse --short HEAD)"

say "Backing up the database"
priv /usr/local/sbin/eliteforces-backup

say "Pulling $BRANCH"
as_owner git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
AFTER="$(as_owner git -C "$APP_DIR" rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already up to date ($AFTER)."
else
  as_owner git -C "$APP_DIR" --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'
fi

say "Installing packages"
as_owner bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

say "Restarting the game"
# Avatar uploads need a body limit above nginx's old 1 MB (older installs).
SITE=/etc/nginx/sites-available/eliteforces
if [ -f "$SITE" ] && priv grep -q 'client_max_body_size 1m;' "$SITE"; then
  priv sed -i 's/client_max_body_size 1m;/client_max_body_size 2m;/' "$SITE"
  if priv nginx -t 2>/dev/null; then priv systemctl reload nginx && echo "nginx: upload limit raised to 2 MB."; fi
fi

priv systemctl restart eliteforces
for i in 1 2 3 4 5 6 7 8 9 10; do
  # The game takes a moment to start, so early "connection refused" tries stay quiet.
  if curl -fs -o /dev/null http://127.0.0.1:3000/; then
    echo "Running $AFTER. (Was $BEFORE.)"
    exit 0
  fi
  sleep 1
done
priv journalctl -u eliteforces -n 40 --no-pager
printf '\n\033[1;31mThe game did not come back up.\033[0m To go back to the previous version:\n'
echo "  cd $APP_DIR && git checkout $BEFORE && npm ci --omit=dev && sudo systemctl restart eliteforces"
exit 1
