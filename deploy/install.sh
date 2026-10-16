#!/usr/bin/env bash
# One-time server setup for EliteForces on Ubuntu 22.04 (also works on 24.04).
#
#   sudo bash deploy/install.sh
#
# Settings (override with environment variables, e.g. DOMAIN=... sudo -E bash ...):
#   DOMAIN     the site's domain                      (default: generalforces.com)
#   APP_DIR    where the code lives                   (default: /var/www/html)
#   REPO       the GitHub repository to pull          (default: git@github.com:HullAdam38/army.git)
#   BRANCH     the branch to run                      (default: claude/determined-keller-i7bgjo)
#   EMAIL      for Let's Encrypt expiry notices       (asked for if not set)
#   DEPLOY_USER the Linux user who owns the code      (default: whoever ran sudo; run as root and
#               it creates 'eliteadmin' and gives it root's GitHub deploy key)
#
# What it does: installs Node.js 22, nginx, certbot and sqlite3; pulls the code
# into APP_DIR; keeps the database in /var/lib/eliteforces and secrets in
# /etc/eliteforces (both outside the web folder); runs the game as a systemd
# service; sets up nginx + HTTPS for DOMAIN and www.DOMAIN; turns on the
# firewall; and schedules nightly database backups. Safe to run again.
set -euo pipefail

DOMAIN="${DOMAIN:-generalforces.com}"
APP_DIR="${APP_DIR:-/var/www/html}"
REPO="${REPO:-git@github.com:HullAdam38/army.git}"
BRANCH="${BRANCH:-claude/determined-keller-i7bgjo}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-}}"
SERVICE_USER=eliteforces
DATA_DIR=/var/lib/eliteforces
ENV_DIR=/etc/eliteforces
ENV_FILE="$ENV_DIR/eliteforces.env"
BACKUP_DIR=/var/backups/eliteforces
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash deploy/install.sh"
command -v apt-get >/dev/null || die "This script is for Ubuntu/Debian."

# The code shouldn't belong to root. Logged in as root? Use (or create) a normal
# user for it, and give that user the GitHub deploy key root made, if it has none.
if [ -z "$DEPLOY_USER" ] || [ "$DEPLOY_USER" = root ]; then
  DEPLOY_USER=eliteadmin
  say "Running as root: the code will belong to a normal user, '$DEPLOY_USER'"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
    echo "Created user '$DEPLOY_USER'."
  fi
fi
id "$DEPLOY_USER" >/dev/null 2>&1 || die "User '$DEPLOY_USER' doesn't exist."
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "$DEPLOY_HOME/.ssh"
if ! ls "$DEPLOY_HOME"/.ssh/id_* >/dev/null 2>&1 && [ -f /root/.ssh/id_ed25519 ]; then
  cp /root/.ssh/id_ed25519 /root/.ssh/id_ed25519.pub "$DEPLOY_HOME/.ssh/"
  [ -f /root/.ssh/known_hosts ] && cp /root/.ssh/known_hosts "$DEPLOY_HOME/.ssh/"
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
  chmod 600 "$DEPLOY_HOME/.ssh/id_ed25519"
  echo "Gave '$DEPLOY_USER' the GitHub deploy key from /root/.ssh."
fi

# nginx needs ports 80 and 443. Don't silently break an existing Apache site.
if systemctl is-active --quiet apache2 2>/dev/null; then
  die "Apache is running and using port 80. EliteForces uses nginx in front of the game.
If Apache only serves the default page, stop it with:
  sudo systemctl disable --now apache2
then run this script again. (If Apache hosts other sites, set those up in nginx first.)"
fi

say "Installing system packages (git, nginx, certbot, sqlite3, firewall)"
apt-get update
apt-get install -y git curl ca-certificates gnupg nginx certbot python3-certbot-nginx sqlite3 ufw

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}
if node_ok; then
  say "Node.js $(node -v) is already installed"
else
  say "Installing Node.js 22 (Ubuntu's own version is too old)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  hash -r
  node_ok || die "Node.js 22.13+ didn't install correctly."
fi

say "Creating the '$SERVICE_USER' system user and folders"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR"
install -d -o root -g "$SERVICE_USER" -m 750 "$ENV_DIR"
install -d -o root -g root -m 700 "$BACKUP_DIR"

say "Getting the code into $APP_DIR (branch $BRANCH)"
# Accept GitHub's host key the first time instead of stopping to ask.
as_deployer() { sudo -u "$DEPLOY_USER" -H env GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' "$@"; }
if [ -d "$APP_DIR/.git" ]; then
  as_deployer git -C "$APP_DIR" fetch origin "$BRANCH"
  as_deployer git -C "$APP_DIR" checkout "$BRANCH"
  as_deployer git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  # git clone needs an empty folder. Ubuntu puts a placeholder page in /var/www/html: keep a copy.
  if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR")" ]; then
    SAVED="$APP_DIR.before-eliteforces.$(date +%Y%m%d%H%M%S)"
    say "$APP_DIR isn't empty; moving what's there to $SAVED"
    mv "$APP_DIR" "$SAVED"
  fi
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR"
  if ! as_deployer git clone --branch "$BRANCH" "$REPO" "$APP_DIR"; then
    die "Couldn't clone $REPO. For a private repository, add this server's deploy key on GitHub first
(see DEPLOY.md, step 2), then run this script again."
  fi
fi
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"
chmod 755 "$APP_DIR"

say "Installing the game's packages"
as_deployer bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

say "Writing settings to $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# EliteForces settings. Read by the systemd service; restart after editing:
#   sudo systemctl restart eliteforces
NODE_ENV=production
PORT=3000
# Signs session cookies. Keep it secret; changing it signs everyone out.
SESSION_SECRET=$(openssl rand -hex 32)
# The database lives outside the web folder.
DB_FILE=$DATA_DIR/eliteforces.db
# Shown in the Terms of Service. Fill these in before launch.
LEGAL_OPERATOR="Your name or company"
LEGAL_CONTACT_EMAIL=support@$DOMAIN
LEGAL_JURISDICTION="England and Wales"
ENV
  echo "Created. Edit LEGAL_OPERATOR / LEGAL_CONTACT_EMAIL / LEGAL_JURISDICTION before launch."
else
  echo "Already exists; leaving your settings as they are."
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

say "Installing the systemd service"
sed "s#__APP_DIR__#$APP_DIR#g" "$HERE/eliteforces.service" > /etc/systemd/system/eliteforces.service
systemctl daemon-reload
systemctl enable eliteforces >/dev/null
systemctl restart eliteforces
sleep 2
systemctl is-active --quiet eliteforces || { journalctl -u eliteforces -n 30 --no-pager; die "The game didn't start; the log is above."; }
curl -fsS -o /dev/null http://127.0.0.1:3000/ || die "The game is running but not answering on port 3000. Check: journalctl -u eliteforces -n 50"
echo "Game is running on 127.0.0.1:3000."

say "Setting up nginx for $DOMAIN"
sed "s#__DOMAIN__#$DOMAIN#g" "$HERE/nginx-eliteforces.conf" > /etc/nginx/sites-available/eliteforces
# Servers with IPv6 switched off can't listen on [::]: drop those lines or nginx won't start.
if [ ! -f /proc/net/if_inet6 ] || [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)" = 1 ]; then
  sed -i '/listen \[::\]/d' /etc/nginx/sites-available/eliteforces
  echo "IPv6 is off on this server, so nginx listens on IPv4 only."
fi
ln -sf /etc/nginx/sites-available/eliteforces /etc/nginx/sites-enabled/eliteforces
# The default site serves /var/www/html as plain files, which would expose the code. Turn it off.
rm -f /etc/nginx/sites-enabled/default
nginx -t
# Something other than nginx on port 80 or 443 (another web server, a control panel)?
for port in 80 443; do
  holder="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -v nginx | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//;s/"//')"
  if [ -n "$holder" ]; then
    die "Port $port is already in use by '$holder', so nginx can't start.
Stop it (for example: sudo systemctl disable --now $holder) if you don't need it, then run this script again."
  fi
done
systemctl enable nginx >/dev/null 2>&1
if ! systemctl restart nginx; then
  journalctl -u nginx -n 20 --no-pager
  die "nginx wouldn't start; its log is above. Running 'sudo nginx -t' shows config problems."
fi
echo "nginx is running."

say "Turning on the firewall (SSH, HTTP and HTTPS only; port 3000 stays private)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

say "Getting an HTTPS certificate from Let's Encrypt"
if [ -z "${EMAIL:-}" ]; then
  read -r -p "Email for certificate expiry notices: " EMAIL
fi
if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --non-interactive --agree-tos -m "$EMAIL"; then
  echo "HTTPS is on. Certificates renew automatically."
else
  printf '\n\033[1;31mHTTPS setup failed.\033[0m Usually DNS for %s and www.%s doesn'"'"'t point at this server yet.\n' "$DOMAIN" "$DOMAIN"
  echo "Once it does, run:  sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect -m $EMAIL --agree-tos"
fi

say "Scheduling nightly database backups (kept for 14 days in $BACKUP_DIR)"
install -m 755 "$HERE/backup.sh" /usr/local/sbin/eliteforces-backup
cat > /etc/cron.d/eliteforces-backup <<CRON
# Nightly EliteForces database backup.
17 3 * * * root /usr/local/sbin/eliteforces-backup >> /var/log/eliteforces-backup.log 2>&1
CRON

say "Done"
cat <<DONE

  EliteForces is live at https://$DOMAIN

  Next:
    1. Register your account on the site, then make yourself an admin:
         sudo bash $APP_DIR/deploy/admin.sh grant YourCallsign
    2. Fill in your details for the Terms of Service:
         sudo nano $ENV_FILE        then: sudo systemctl restart eliteforces
    3. To update later (as root, or as a user who can use sudo):
         bash $APP_DIR/deploy/update.sh

  Useful:
    sudo systemctl status eliteforces      is it running?
    sudo journalctl -u eliteforces -f      live log
    ls $BACKUP_DIR                          backups
DONE
