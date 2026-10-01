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
| Privacy | Emails, cash on hand, bank balances, purchases and hospital payments are never shown to other players. |
| Dependencies | `npm audit`: 0 known vulnerabilities at review time. |

## Fixed during the review

1. **Sign-in didn't work in production behind a reverse proxy.** Express didn't trust the proxy, so it thought requests were plain HTTP and refused to send the `Secure` session cookie. It now trusts a proxy on the same machine by default in production (`TRUST_PROXY`).
2. **No HSTS header.** Added for production over HTTPS.
3. **No per-account lockout.** Only per-IP limits existed, so one account could be guessed from many IPs.
4. **Simultaneous sign-ups with the same name** caused a server error. Now shows "already taken".
5. **Sign-in forgot where you were going** (always went to HQ). Fixed, with stricter redirect checks.
6. **No cap on actions per player.** Added 120/minute.

## Known limits (fine for launch, worth revisiting)

- **Rate limits live in memory** and reset when the server restarts. Run a single game process (the default). If you ever run several, move them to the database or Redis.
- **No password reset or email verification** yet: there's no email sending. An admin can't see passwords but can suspend accounts.
- **Battle reports are visible to any signed-in player** by design (they show the cash taken in that fight).
- **SQLite** suits one server comfortably. Back up `data/` regularly (see below).

## Production checklist

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
