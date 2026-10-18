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
| Push alerts | Subscriptions are only accepted for the browsers' own push services (Google, Mozilla, Apple, Microsoft, over HTTPS on port 443), so the server can't be steered into calling internal or other addresses. Subscribing needs the CSRF token. A replaced subscription is accepted without one only from a JSON request that names the old endpoint, a secret only that browser and the server know. Push payloads link only to paths on this site. |
| Uploads | Avatar pictures: the type is read from the bytes (PNG, JPEG, WebP only), metadata stripped, 1 MB cap; served with `nosniff` and a sandboxing CSP. |
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

### Second review (avatars, uploads, push alerts, admin tools, objectives, high-value target)

Checked: the upload reader and image checks, how avatars are served, push subscriptions and the CSRF-free renew route, the service worker, every new admin action, and the new payouts. Each fix has a test in `test/security-review.test.js` or `test/objectives.test.js` that fails without it.

7. **High-value target bonuses could be farmed with a second account** (medium). A target's defence bonus only excluded accounts that share a device, and a device is a cookie. So an alt on the same network (cookies cleared), or a friend, could lose on purpose 10 times a day, paying the target about 20 deployment-hours of cash daily. Both target payouts now refuse accounts linked by device *or* network, and a defence pays at most once per attacker per day.
8. **Upload bodies were read before checking the player was signed in** (low). Anyone could make the server buffer about 1 MB per request before the CSRF check refused it. Now only signed-in sessions have uploads read.
9. **JPEGs kept anything after their end-of-image marker** (low, hardening). A file could carry a hidden second file. They're served with `nosniff` and a sandboxing CSP, so browsers wouldn't run it, but the extra bytes are now dropped.
10. **Weekly-objective XP for token contributions** (low). A $1 donation made a member a "helper" of a War chest objective and earned them the completion XP. Helpers now need at least 2% of the target.
11. **Avatar images were served to suspended or deleted accounts' sessions** (low). They now need a valid, unsuspended account. That also covers a suspended admin's session viewing unused uploads.

Looked at and fine as it is:
- **The push renew route skips CSRF** because a service worker can't send the token. It needs a JSON body (so another site can't send it without a blocked preflight) and the old push address, which is a secret only that browser and the server know.
- **Push only goes to Google, Mozilla, Apple and Microsoft**, so subscriptions can't be used to make the server call other addresses. Links in alerts stay on the site, and the service worker checks that again before opening one.
- **Admin pages** all return 404 to non-admins, need the CSRF token, escape what they show, and record a reason in the audit log. Admin rights, and other admins' callsigns and emails, can only be changed on the server.
- **Uploaded pictures** have their type read from the bytes and their metadata stripped. They're served with the exact image type, `nosniff`, `Content-Disposition: inline` and a CSP sandbox.
- **Badge SVGs** are built only from fixed parts plus escaped game data (grade, level, callsign, unit tag).
- **New payouts** use their own ledger reasons (`target-bonus`, `unit-objective`), so the existing payout checks still apply. Claims are single database writes guarded by keys or conditions, so double clicks or parallel requests can't pay twice.
- **Spam:** mentions notify at most once per sender every 10 minutes, and push alerts are capped at 30 per player per hour.

### Third review (player stats, chain of command, raids, theatre of war, admin raid and map tools, support tickets, notifications, casino)

Checked: every new route's sign-in, admin and CSRF protection; who may act on what (unit ranks, tickets, blackjack turns); every new money path (rally and raid supplies, raid loot, theatre income, the three casino games); what the casino sends to browsers; the support alerts; and template escaping. Each fix has a test in `test/review3.test.js` that fails without it.

12. **A blackjack table could be marked paid when the payment failed** (medium). Each table's state lives in memory and is saved to the database with the money. If anything failed partway through a change (a payout, say), the database rolled back but the in-memory table kept the change, so the round could show as settled with nobody paid. A failed change now puts the table back to its last saved state, and a retry pays exactly once.
13. **Card counting at the War Room** (medium, economy). The shoe was dealt down to a quarter before reshuffling. Across six decks, that's deep enough for a player tracking cards to get an edge over the house at $25,000 a hand. The shoe is now reshuffled at the halfway point, which leaves almost no edge.
14. **Raid loot could be taken by removing strikers** (low). Only strikers still in the unit shared the loot, and the rest split what the others would have had. A Commander could remove the top strikers just before the final blow. Everyone who struck now shares, unless they're suspended.
15. **Support replies could spam admins** (low). A player could reply every 10 seconds, and every reply alerted every admin (in-game and by push). More replies on a ticket already waiting for HQ now alert again only after 15 minutes. A ticket HQ has answered still alerts on the player's next reply.

Looked at and fine as it is:
- **Casino results are decided on the server** with a cryptographic RNG. The blackjack shoe and the dealer's face-down card are never sent to browsers until the dealer plays. Browsers only animate the result they're given. The return to player is fixed and tested: slots 94.9%, roulette 97.3%, blackjack about 99.5% with perfect play.
- **No value can pass between players at the casino.** Everyone plays the house, never each other, so linked accounts gain nothing by sitting together. Every bet and win goes through the ledger (`casino-slots`, `casino-roulette`, `casino-blackjack`), so the balance audit still adds up. Spins and hands run in a transaction with a cooldown, so parallel requests can't double-spend.
- **Bet input** is whole dollars within table limits and the player's cash. Roulette place names come from the form, so they're read into prototype-less objects and checked against the list of real places (`__proto__` is refused).
- **Unit permissions** (promote, demote, remove, rally, raid, front) read the player's rank fresh from the database inside the transaction. Rally and raid supplies only spend what the treasury has. The treasury still never pays out to players. Raid loot and theatre income are new money sized by the game, not by what was spent.
- **Support tickets** are visible only to their player and admins. Internal notes are filtered out in the query for players. Assigning only accepts admins. Subjects and messages are escaped (messages go through the BBCode renderer).
- **Admin raid and map tools and the support queue** are under `/admin`, so non-admins get a 404. Each change needs a reason (support replies are their own record) and goes in the audit log.
- **Template output:** every unescaped `<%- %>` added since the last review is either fixed markup, server-generated card markup or BBCode-rendered text.

## Known limits (fine for launch, worth revisiting)

- **Rate limits live in memory** and reset when the server restarts. Run a single game process (the default). If you ever run several, move them to the database or Redis.
- **Privacy notice:** mention in your terms that sign-ins (device ID, hashed IP) and gameplay are monitored for cheating and kept for up to 90 days.
- **No self-service password reset or email verification** yet, because the game doesn't send email. Admins can issue a 24-hour temporary password (shown once, never logged), which forces the player to choose a new password at their next sign-in and signs them out everywhere. Players can change their own password, which signs out their other devices; wrong current-password attempts are throttled (5 per 15 min).
- **Colluding real players can still trade small favours,** for example a friend on a different network losing to the high-value target once a day, or feeding a weekly objective. The caps keep it small, and anti-cheat's farming checks still watch PvP pairs.
- **Upload, report and push limits live in memory** like the other rate limits, so a restart resets them.
- **Battle reports are visible to any signed-in player** by design (they show the cash taken in that fight).
- **SQLite** suits one server comfortably. Back up `data/` regularly (see below).
- **Page loads and polls aren't rate limited per player** (actions are: 120 a minute). An open blackjack table polls once a second; Cloudflare's rate limiting is the place to cap abusive clients.
- **Blackjack tables live in one game process.** Running several processes would need the tables moved to a single owner first (see README › Performance).

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
