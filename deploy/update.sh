#!/usr/bin/env bash
# Pulls the latest code and restarts the game. Run as the user who owns the
# code (the one who ran install.sh), from anywhere:
#   bash /var/www/html/deploy/update.sh
# It backs up the database first, and if the new version doesn't start it
# says so (the previous code is one `git checkout` away; see DEPLOY.md).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse --short HEAD)"

say "Backing up the database"
sudo /usr/local/sbin/eliteforces-backup

say "Pulling $BRANCH"
git pull --ff-only origin "$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already up to date ($AFTER)."
else
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'
fi

say "Installing packages"
npm ci --omit=dev --no-audit --no-fund

say "Restarting the game"
sudo systemctl restart eliteforces
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/; then
    echo "Running $AFTER. (Was $BEFORE.)"
    exit 0
  fi
  sleep 1
done
sudo journalctl -u eliteforces -n 40 --no-pager
printf '\n\033[1;31mThe game did not come back up.\033[0m To go back to the previous version:\n'
echo "  cd $APP_DIR && git checkout $BEFORE && npm ci --omit=dev && sudo systemctl restart eliteforces"
exit 1
