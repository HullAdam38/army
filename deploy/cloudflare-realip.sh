#!/usr/bin/env bash
# Behind Cloudflare, every request reaches nginx from a Cloudflare address, so
# the game would see all players as the same few IPs (breaking anti-cheat's
# linked-account checks and login rate limits). This tells nginx to take the
# visitor's real address from Cloudflare's CF-Connecting-IP header, but only
# for requests that genuinely come from Cloudflare's published ranges.
#
#   sudo bash deploy/cloudflare-realip.sh
#
# install.sh runs it automatically when the domain is behind Cloudflare, and a
# monthly cron job refreshes the ranges. Safe to run again.
set -euo pipefail
OUT=/etc/nginx/conf.d/cloudflare-realip.conf
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

V4="$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4)" || V4=""
V6="$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)" || V6=""
if [ -z "$V4" ] || [ -z "$V6" ]; then
  echo "Couldn't download Cloudflare's IP ranges; leaving $OUT as it is." >&2
  exit 1
fi

TMP="$(mktemp)"
{
  echo "# Real visitor IPs behind Cloudflare. Written by deploy/cloudflare-realip.sh on $(date -I)."
  echo "# Only requests from these Cloudflare ranges may set the visitor's address."
  for range in $V4 $V6; do
    # Only accept things that look like CIDR ranges.
    [[ "$range" =~ ^[0-9a-fA-F:.]+/[0-9]+$ ]] && echo "set_real_ip_from $range;"
  done
  echo "real_ip_header CF-Connecting-IP;"
} > "$TMP"

cp "$TMP" "$OUT.new" && rm -f "$TMP"
mv "$OUT.new" "$OUT"
chmod 644 "$OUT"
if nginx -t 2>/dev/null; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  echo "Cloudflare real-IP settings updated ($(grep -c set_real_ip_from "$OUT") ranges)."
else
  nginx -t
  rm -f "$OUT"
  echo "nginx rejected the settings, so they were removed." >&2
  exit 1
fi
