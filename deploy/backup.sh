#!/usr/bin/env bash
# Backs up the GeneralForces database while the game is running (SQLite's online
# backup, so it's always consistent), test-restores the copy, compresses it, keeps
# 14 days, and (if set up) copies it off the server with rclone.
# install.sh copies this to /usr/local/sbin/eliteforces-backup and runs it nightly.
#   sudo eliteforces-backup
#
# Off-site copies: set BACKUP_REMOTE (an rclone remote and folder, e.g.
# b2:my-bucket/generalforces) on Admin › Server settings, or in
# /etc/eliteforces/backup.env. See DEPLOY.md.
#
# It leaves a report next to the database (backup-status.json) that the game
# shows on Admin › Launch checklist.
set -uo pipefail
[ -f /etc/eliteforces/backup.env ] && . /etc/eliteforces/backup.env
DB="${DB_FILE:-/var/lib/eliteforces/eliteforces.db}"
DEST="${BACKUP_DIR:-/var/backups/eliteforces}"
KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="${BACKUP_REMOTE:-}"
REMOTE_KEEP_DAYS="${BACKUP_REMOTE_KEEP_DAYS:-30}"
STATUS="${BACKUP_STATUS_FILE:-$(dirname "$DB")/backup-status.json}"

# Backup settings saved on Admin › Server settings win over backup.env. The game
# can write that file and this script runs as root, so it's read with a strict
# parser and never `source`d: only these two keys, only safe characters.
ADMIN_SETTINGS="${ADMIN_SETTINGS_FILE:-$(dirname "$DB")/admin-settings.env}"
if [ -f "$ADMIN_SETTINGS" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      BACKUP_REMOTE) [[ "$value" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]{0,40}:[A-Za-z0-9._/-]{0,200}$ ]] && REMOTE="$value" ;;
      BACKUP_REMOTE_KEEP_DAYS) [[ "$value" =~ ^[0-9]{1,4}$ ]] && REMOTE_KEEP_DAYS="$value" ;;
    esac
  done < "$ADMIN_SETTINGS"
fi

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }
status() { # ok size users restore_ok restore_error offsite_ok offsite_error
  cat > "$STATUS.tmp" <<JSON
{"at":"$(now)","ok":$1,"file":"$(json "${OUT:-}.gz")","size":$2,
 "restore":{"ok":$4,"users":$3,"error":"$(json "$5")"},
 "offsite":{"remote":"$(json "$REMOTE")","ok":$6,"at":"$(now)","error":"$(json "$7")"}}
JSON
  mv "$STATUS.tmp" "$STATUS"
  chmod 644 "$STATUS"
}
fail() { echo "$(now) $1" >&2; status false 0 0 false "$1" false ""; exit 1; }

[ -f "$DB" ] || fail "no database at $DB"
mkdir -p "$DEST"
OUT="$DEST/eliteforces-$(date +%Y-%m-%d-%H%M).db"
sqlite3 "$DB" ".backup '$OUT'" || fail "the backup command failed"

# Test restore: open the copy as if restoring it, check it, and count the players.
CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>&1)"
if [ "$CHECK" != "ok" ]; then fail "backup failed its integrity check: $CHECK"; fi
USERS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM users;' 2>&1)"
[[ "$USERS" =~ ^[0-9]+$ ]] || fail "couldn't read players from the backup: $USERS"
LIVE="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo "$USERS")"
if [[ "$LIVE" =~ ^[0-9]+$ ]] && [ "$USERS" -lt "$LIVE" ] && [ $((LIVE - USERS)) -gt 5 ]; then
  fail "the backup has $USERS players but the game has $LIVE"
fi

gzip -f "$OUT"
SIZE="$(stat -c %s "$OUT.gz")"
find "$DEST" -name 'eliteforces-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(now) backed up to $OUT.gz ($USERS players, test restore ok)"

# Off-site copy.
OFF_OK=false
OFF_ERR=""
if [ -n "$REMOTE" ]; then
  if ! command -v rclone >/dev/null; then
    OFF_ERR="rclone isn't installed (sudo apt install rclone)"
  elif ERR="$(rclone copy "$OUT.gz" "$REMOTE" 2>&1)"; then
    OFF_OK=true
    rclone delete "$REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" --include 'eliteforces-*.db.gz' >/dev/null 2>&1 || true
    echo "$(now) copied to $REMOTE"
  else
    OFF_ERR="$(printf '%s' "$ERR" | tail -n 3)"
    echo "$(now) off-site copy to $REMOTE failed: $OFF_ERR" >&2
  fi
fi

status true "$SIZE" "$USERS" true "" "$OFF_OK" "$OFF_ERR"
