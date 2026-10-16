#!/usr/bin/env bash
# Backs up the EliteForces database while the game is running (SQLite's online
# backup, so it's always consistent), compresses it, and keeps 14 days.
# install.sh copies this to /usr/local/sbin/eliteforces-backup and runs it nightly.
#   sudo eliteforces-backup
set -euo pipefail
DB="${DB_FILE:-/var/lib/eliteforces/eliteforces.db}"
DEST="${BACKUP_DIR:-/var/backups/eliteforces}"
KEEP_DAYS="${KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "$(date -Is) no database at $DB" >&2; exit 1; }
mkdir -p "$DEST"
OUT="$DEST/eliteforces-$(date +%Y-%m-%d-%H%M).db"
sqlite3 "$DB" ".backup '$OUT'"
sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -qx ok || { echo "$(date -Is) backup failed its integrity check: $OUT" >&2; exit 1; }
gzip -f "$OUT"
find "$DEST" -name 'eliteforces-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backed up to $OUT.gz"
