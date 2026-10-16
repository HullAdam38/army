# Security

This document records the security review done before launch, and the settings a production server needs.

## What's in place

| Area | Protection |
|---|---|
| Passwords | bcrypt (cost 12), 8–72 characters. Never logged or shown. |
| Sign-in | Same error for a wrong name or a wrong password; a fake hash check for unknown accounts so timing doesn't reveal them. A suspension is only revealed after the correct password. |
| Brute force | 20 sign-in/sign-up attempts per IP per 15 min; **8 wrong passwords for one account per 15 min locks that account** (however many IPs try). |
| Sessions | Stored server-side in SQLite. Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production. New session ID on every sign-in (blocks session fixation). Banning a player deletes their sessions. |
| CSRF | Per-session token required on every POST, compared in constant time. |
| XSS | All player-supplied text is HTML-escaped by the templates or inserted with `textContent`. Strict Content-Security-Policy: scripts only from this site, no inline scripts. |
| SQL injection | Every query uses bound parameters. Sort orders come from a fixed allowlist; `LIKE` wildcards in searches are escaped. |
| Redirects | Only same-site paths are followed (`//evil.com` and `/\evil.com` are rejected). |
| Race conditions | Money/energy/health changes run inside `BEGIN IMMEDIATE` transactions that re-read the player first, so double-clicks and parallel requests can't double-spend. Unique-name races are caught. |
| Abuse | 120 actions per minute per player. Request bodies capped at 10 KB. |
| Headers | CSP, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`; HSTS and `upgrade-insecure-requests` in production over HTTPS. |
| Admin | Granted only from the server's command line (`npm run admin`), never via the website. `/admin` returns 404 to everyone else. Every admin action is written to an audit log with a reason. Admins can't ban themselves or other admins from the web. |
| Privacy | Emails, cash on hand, bank balances, purchases, hospital payments and training stats are never shown to other players. Public combat ratings are gear-only; true stats are revealed only through paid scouting, to the scout alone. |
| Dependencies | `npm audit`: 0 known vulnerabilities at review time. |

## Anti-cheat

Anti-cheat works in layers: make cheating unprofitable, record evidence, detect patterns, and let an admin decide. **Nothing is banned automatically.**

**Prevention**
- **Linked accounts get no PvP rewards from each other.** If two accounts have been used on the same device in the last 30 days, fights between them still happen but pay no cash or XP.
- **Repeat wins pay less:** the 3rd and 4th wins against the same player within 24 hours pay half, and the 5th onwards pays nothing.

**Evidence**
- **Sign-ins** record a device ID (a random cookie), a *keyed hash* of the IP address (raw IPs are never stored) and the browser. Records older than 90 days are deleted.
- **Action log:** every game action (mission, attack, bank, armory, hospital) is recorded with its time and the XP/cash it earned. Kept for 14 days.
- **Money ledger:** every change to cash or bank balance is written to `ledger` with a reason (`mission`, `pvp`, `armory`, `bank-deposit`, `admin-cash`, `reversal`…). Saving a player with a money change but no reason is recorded as `unknown`.

**Detection** (after each sign-in and fight, plus a full scan every 6 hours; `ANTICHEAT_SCAN_HOURS` changes the interval):

| Flag | Severity | Raised when |
|---|---|---|
| Accounts share a device | medium | Two accounts signed in from the same device |
| Accounts share a network | low | Two accounts signed in from the same IP (common for families and schools, so low) |
| PvP farming | medium or high | 8+ one-sided wins over one player in 48 hours with no counter-attacks; high if they share a network (6+) or device (3+) |
| Balance doesn't match money history | high | `cash`/`bank_balance` differ from the sum of the ledger (a direct database edit or a bug) |
| Money changed without a known reason | high | `unknown` ledger entries |
| Payout larger than the game allows | high | A mission or PvP payout above the game's maximum |
| Bot-like activity | medium or high | Over the last 24 hours (25+ actions): near-identical gaps between actions (under 10% variation over 30+ gaps), active in 20+ of 24 hours, or 25+ actions under 0.4 s apart. Two or more signs together raise the severity. |
| Unusual gains | high | Mission cash in 24 hours above the most the player's energy could pay for (full regeneration plus refills from promotions and admin restores, on the best mission they can access, all succeeding, +10%): only possible through an exploit |
| Unusual gains | medium | XP or cash in 24 hours at least 4× the median of 5+ players within 2 levels (and at least 500 XP / $2,000) |

**Review:** **Admin → Suspicious activity** lists open flags, most serious first. Each flag shows the players, their linked accounts and the evidence (battles, ledger entries, balances). The actions are: **warn** (sends a notification), **dismiss** (with a note; the same pattern isn't re-flagged for 7 days), **reverse gains** (farming only: returns the cash taken, as far as the winner can still pay, via the ledger) and **suspend**. Every decision goes into the audit log. **Run checks now** triggers a scan on demand. Each player's admin page shows their linked accounts, flags, recent sign-ins and money history.

Admin player pages show a **24-hour activity chart** (actions per hour). Real players have gaps for sleep and work; a solid wall of bars is a strong warning sign. Thresholds live in `src/anticheat/rules.js`.

**Limits:** a careful bot author can add random delays and take breaks; the energy ceiling still caps what any bot can earn, and the gains checks catch exploits regardless of how they're played. A device ID is a cookie, so a determined cheater can clear it or use another browser; network links and farming patterns still catch most of those. VPNs hide networks. Treat flags as leads, not proof.

## Fixed during the review

1. **Sign-in didn't work in production behind a reverse proxy.** Express didn't trust the proxy, so it thought requests were plain HTTP and refused to send the `Secure` session cookie. It now trusts a proxy on the same machine by default in production (`TRUST_PROXY`).
2. **No HSTS header.** Added for production over HTTPS.
3. **No per-account lockout.** Only per-IP limits existed, so one account could be guessed from many IPs.
4. **Simultaneous sign-ups with the same name** caused a server error. Now shows "already taken".
5. **Sign-in forgot where you were going** (always went to HQ). Fixed, with stricter redirect checks.
6. **No cap on actions per player.** Added 120/minute.

## Known limits (fine for launch, worth revisiting)

- **Rate limits live in memory** and reset when the server restarts. Run a single game process (the default). If you ever run several, move them to the database or Redis.
- **Privacy notice:** mention in your terms that sign-ins (device ID, hashed IP) and gameplay are monitored for cheating and kept for up to 90 days.
- **No self-service password reset or email verification** yet, because the game doesn't send email. Admins can issue a 24-hour temporary password (shown once, never logged), which forces the player to choose a new password at their next sign-in and signs them out everywhere. Players can change their own password, which signs out their other devices; wrong current-password attempts are throttled (5 per 15 min).
- **Battle reports are visible to any signed-in player** by design (they show the cash taken in that fight).
- **SQLite** suits one server comfortably. Back up `data/` regularly (see below).

## Production checklist

[DEPLOY.md](DEPLOY.md) and `deploy/install.sh` do all of this for an Ubuntu server. The list below is for setting it up by hand.

1. Run behind HTTPS (nginx or Caddy with a Let's Encrypt certificate).
2. Set environment variables:
   ```
   NODE_ENV=production
   SESSION_SECRET=<64+ random characters: openssl rand -hex 32>
   PORT=3000
   # Only if the proxy is on a different machine: TRUST_PROXY=1 (or its IP)
   ```
3. Keep port 3000 private (firewall it); only the proxy should be reachable from outside.
4. Proxy must pass `X-Forwarded-Proto` and `X-Forwarded-For` (nginx example below).
5. Make yourself an admin after registering: `npm run admin -- grant <callsign>`.
6. Back up `data/eliteforces.db` daily. With the game running, use SQLite's online backup: `sqlite3 data/eliteforces.db ".backup backups/ef-$(date +%F).db"`.

nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name game.example.com;
    # ssl_certificate / ssl_certificate_key from certbot

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    server_name game.example.com;
    return 301 https://$host$request_uri;
}
```
