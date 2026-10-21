# GeneralForces

A text-based military strategy game for players aged 18+. You enlist, spend energy on missions, earn XP and cash, get promoted through 18 ranks, and patch up your wounds at the field hospital.

## Stack

- **Server:** Node.js (22.13+) and Express 5, with EJS server-rendered views
- **Push:** the `web-push` package sends alerts through the browsers' push services (see Installable app and push alerts).
- **Data:** SQLite through Node's built-in `node:sqlite` module, so nothing needs compiling on install. Players, the activity log and sessions are all stored in one file.
- **Auth:** bcrypt password hashes (cost 12), session cookies (`httpOnly`, `sameSite=lax`, `secure` in production), a new session ID on login, CSRF tokens on every POST, and IP rate limiting on login and register
- **Frontend:** hand-written CSS with design tokens (no build step) and a small vanilla JS file for progressive enhancement. Every page works without JavaScript.
- **Fonts:** Saira Stencil One (display), Chakra Petch (UI and headings), Barlow (body)

## Getting started

### Linux Mint / Ubuntu / Debian (one command)

```bash
git clone -b claude/determined-keller-i7bgjo https://github.com/HullAdam38/army.git generalforces
cd generalforces
bash scripts/setup-linux.sh
npm run dev        # then open http://localhost:3000
```

`scripts/setup-linux.sh` installs git, curl, Node.js 22 (from NodeSource, because the distro's own Node is too old) and DB Browser for SQLite. It then installs the packages and runs the tests. It's safe to run again.

### Any system with Node.js 22.13+

```bash
npm install
npm run dev        # http://localhost:3000, restarts on file changes
npm test           # unit tests for the game rules plus HTTP integration tests
```

For production:

```bash
SESSION_SECRET="$(openssl rand -hex 32)" NODE_ENV=production npm start
```

See `.env.example` for all settings, and **[SECURITY.md](SECURITY.md)** for the security review and the production checklist (HTTPS proxy, secrets, backups).

**Putting it on a server:** **[DEPLOY.md](DEPLOY.md)** is a step-by-step guide for Ubuntu 22.04. It covers the code in `/var/www/html`, nginx with HTTPS, a systemd service, nightly backups and one-command updates, using the scripts in `deploy/`.

## Terms of Service

- **The page:** `/terms` is public and linked from every page footer and the sign-up form. It covers eligibility (18+), one account per player, fair play (no alts, bots, exploits or real-money trading), conduct, virtual items, enforcement, data, liability, changes and governing law. Retention periods are read from the anti-cheat settings, so the page always matches what the game does.
- **Your details:** set these in the environment (see `.env.example`). Until you do, the page shows visible `[placeholders]` and production start-up logs a warning.
  - `LEGAL_OPERATOR`: who runs the game
  - `LEGAL_CONTACT_EMAIL`: where players send appeals, data requests and account deletions
  - `LEGAL_JURISDICTION`: whose law applies
- **Recording acceptance:** each account stores the version it accepted (`terms_version`, `terms_accepted_at`).
- **Changing the terms:** edit `views/partials/terms-body.ejs`, then bump `TERMS_VERSION` and `EFFECTIVE_DATE` in `src/legal.js`. Every player is sent to `/terms/accept` on their next visit and must accept before playing again; they can also choose to sign out. Accounts created before the terms existed are asked once.
- **Not legal advice:** the text is a sensible starting point written around how this game actually works. Have it reviewed by someone qualified in your jurisdiction before you launch.

## Admin

Admins are created from the server's command line, never through the website:

```bash
npm run admin -- grant <callsign>    # make an existing player an admin
npm run admin -- revoke <callsign>
npm run admin -- list
```

Admins see an **Admin** link in the menu. `/admin` is a 404 for everyone else. From there you can:

- see game stats: players, new today, online, battles, hospital, suspended, money in circulation
- broadcast an announcement to every player
- search players by callsign or email, and sort them by newest or oldest sign-up, most time played or most recently active. Each player shows when they **signed up** (date and time, UTC) and **how long they've played**
- **time played:** the time between a player's page views and actions. Background polls from an open tab don't count, and a break of over 10 minutes ends a session. A player's admin page shows the total, how many sessions it took and the average session; Player stats shows the average per active player and per session. Tracking started on 21 October 2026, so earlier play isn't counted (`src/presence.js` › `playTick`)
- adjust cash, set level, restore energy and health, or release from hospital
- **edit a player:** change their callsign (they're told why) or email, adjust their bank balance, grant XP (levels up as if earned), set trained stats (Endurance also changes max health), give or take gear (taken gear is unequipped first), remove them from their unit (not its Commander), clear their title, clear their notifications (the page shows how many they have), or sign them out on every device. Another admin's callsign and email can only be changed on the server. Every change needs a reason and goes in the audit log; money changes go through the ledger as `admin-cash` / `admin-bank`.
- **Units** (`/admin/units`): search every unit, see members, treasury, upgrades and war record, and add to or take from a treasury (noted in the unit's log). Rename or disband from the unit's own page.
- **Casino** (`/admin/casino`): for the last 24 hours, 7 days or 30 days:
  - totals bet, paid back and the house's take, and that take as a share of all the cash players earned in the same period;
  - per game: plays, players, take, and the actual return against the expected one (slots 94.9%, roulette 97.3%, blackjack ~99.5% with perfect play), plus the biggest single wins;
  - the house's take per day (bars below the line are days players came out ahead);
  - top winners and biggest losers;
  - **Unusually lucky:** players winning at least 3 standard deviations more than a game pays on average, over 20+ plays (about 1 in 740 by chance). Each play stores its exact variance, so bet sizes and roulette bet types are judged fairly. It's a prompt to look at the ledger and linked accounts, not proof.
- **Raids & map** (`/admin/teamwork`): fix problems with raids and the theatre of war. Every change needs a reason, goes in the audit log and is shown to the unit.
  - **Raids under way:** health left, strikers, time left, loot and supplies paid. **Give more time** (1–48 hours, e.g. after an outage) or **call off** a raid with no loot, optionally refunding the supplies to the treasury. Recent raids show how each ended.
  - **Regions:** holder, income, this week's fronts and standings. **Change who holds it** by unit tag, or leave the tag empty to free the region.
  - **Points this week:** wipe a unit's points (e.g. farmed with alt accounts); its front stays.
  - **Who held what:** the last 8 weeks of results.
- **Economy** (`/admin/economy`): money on hand, banked and in unit treasuries; sources and sinks by ledger reason over 24 hours and 7 days; top earners today; the richest players; and how much admins have added or removed this week.
- **Audit log** (`/admin/audit`): every admin action, filterable by action, by admin, or by player and text.
- **Player stats** (`/admin/stats`): whether the game keeps players.
  - Headline numbers: players, new this week, active today / 7 days / 30 days, and daily-to-monthly stickiness.
  - Active players and sign-ups per day for 30 days.
  - A retention grid by week joined: back on day 1, during their second week, and in their second month.
  - How far players get (first mission, level 3, basic training, level 5/10/20, unit, PvP win) and which training steps they finish.
  - Where players who stopped coming were: their level, and how much of basic training they'd done.
  - Feature use: push alerts, the installed app, units, weekly objectives, the high-value target, chat, avatars and PvP fights per day.

  It's built from existing data plus `player_days` (one row per player per day they're active, backfilled from history on first start) and `users.app_seen_at` (set when the page reports it's running as the installed app). Charts are plain HTML and CSS: hover a column for its value, or open "Show as table".
- A menu across the top of every admin page links all of these.
- message a single player
- suspend or unsuspend a player (signs them out immediately)
- **reset a password:** issues a temporary password like `K7QF-M2XP-9TRA`, shown once and valid for 24 hours. The player is signed out everywhere and must choose a new password at their next sign-in. Admin accounts can't be reset from the website.

Every change is recorded in the audit log with a reason.

### Game settings

At **Admin › Game settings** (`/admin/settings`) you can tune the game without a restart. Changes apply to every player as soon as you save.

| Group | Settings (default) |
|---|---|
| Economy | Mission & operation pay (×1), mission & operation XP (×1), deployment pay & XP (×1), daily orders & supply drops (×1), PvP season rewards (×1), unit war prizes (×1), bank deposit fee (2%; each Vault level still takes 0.5 points off) |
| Pace | Energy regeneration (2 min per point), hospital stay after a knockout (10 min), deployment hours per day (16) |
| PvP seasons | Placement fights (5), season length (28 days; new seasons only) |
| Chat | Cooldown between messages (3 s; raise it for slow mode), level needed to chat (2) |
| Access | New sign-ups (on). Turn it off to close registration during maintenance or a spam wave; existing players can still sign in. |

- **Stacking:** multipliers stack with everything else: base × (1 + unit and rank-perk bonuses) × live event × the admin setting.
- **Validation:** each setting has limits. A bad value saves nothing, and the page shows what to fix.
- **Change notes:** you can add a note explaining a change ("Launch weekend boost").
- **History:** every change goes in the audit log and the page's change history. **Reset all to defaults** puts everything back.
- **Anti-cheat:** its earnings limits use the *most generous* mission pay and energy speed from the last 24 hours, so lowering them mid-day never flags honest players for earlier income.
- **Where it's stored:** values are kept in the database (`game_settings`, with `game_settings_history`) and loaded at startup.
- **Balance check:** `npm run balance` plays three kinds of player (grinder, regular, casual) for 30 days with the real rules. It shows how fast they level and where their money and XP come from, which helps you choose values here.
- **Where it's defined:** the registry, with defaults, limits and help text, is in `src/tuning.js`. The page and the service are in `src/routes/settings.js` and `src/settings-service.js`.

### Anti-cheat

- **Accounts used on the same device get no PvP rewards from each other.**
- **Repeat wins on the same player pay less:** half from the 3rd win in 24 hours, nothing from the 5th.
- **Every cash and bank change goes into a ledger with a reason**, and a scan every 6 hours checks that balances match it.
- **Bot-like timing** (clockwork gaps, no breaks, superhuman speed) and **unusual gains** (more than energy allows, or far above similar-level players) are checked from a 14-day action log.
- **Linked accounts, PvP farming, unexplained money and impossible payouts raise flags** under **Admin → Suspicious activity**, where you can warn, dismiss, reverse farmed cash or suspend.

Nothing is banned automatically. See [SECURITY.md](SECURITY.md#anti-cheat) for the rules and thresholds.

## Living world

A brand-new game has nobody in it, so the game keeps the world busy until real players fill it.

- **Reserve soldiers:** players run by the game, marked **Reserve** on the players list, profiles, leaderboards, rosters and the online list. They level up at a casual player's pace (up to level 30 by default), carry gear and cash, and skirmish among themselves, which fills the combat feed. Real players can attack them as normal; those fights pay as usual but never count towards PvP seasons. They can't sign in, chat or be messaged, and they're never the daily high-value target.
- **They stand down as players arrive:** with the default of 30, one leaves for every real player active in the last week (admins don't count). Game settings › Living world sets the number (0 stands them all down) and their top level. The first batch enlists when the server starts; after that it checks every 10 minutes.
- **HQ starter units:** Iron Vanguard, Desert Rangers and Northern Watch, each run by reserve soldiers. They're always recruiting with no requirements, and anyone who applies joins at once ("Join now"). They can't fight wars. Once three real soldiers serve in one, command passes to the most senior (the next becomes a Lieutenant), the reserve soldiers leave, and it becomes an ordinary unit.
- **News in Global chat:** short announcements for promotions to Second Lieutenant and above, new units, wars declared and won, raids won and HQ units handed over. They look different from messages and don't count as unread. Game settings › Living world can turn them off.
- Admin › Player stats leaves reserve soldiers out of every count. Rules: `src/reserve.js`; running them: `src/reserve-service.js`.

## Cosmetics

Looks that never change how the game plays (`src/cosmetics.js`). They can't be traded or turned into cash, so they never touch the economy or the casino. Supporter members wear the Supporter ones (see below).

| Kind | Earned | Supporter items |
|---|---|---|
| **Callsign colour**: in chat, on profiles, leaderboards, the players list and rosters | Field olive (level 10), Command gold (level 35) | Crimson, Sky blue, Elite violet, Ember, Jade, Arctic white |
| **Profile banner**: the background of your profile header | Woodland (level 20), Campaign ribbons (“Veteran” title) | Desert storm, Arctic, Night ops, Urban, Digital camo |
| **Badge packs**: extra parts in the avatar badge builder | – | Special Forces (tiger stripe, gold braid trim, gunmetal, oxblood), Arctic Warfare (snow and splinter camo, glacier, frost) |
| **Unit crest**: how a unit's tag crest looks everywhere; owned by the unit, picked by its Commander | Veteran (5 wars won) | Gunmetal, Gold, Camo, Crimson, Navy |

- **Wardrobe** (`/account/wardrobe`, under More on phones and linked from your profile): wear what you've earned or been given; Supporter items you don't have link to the Supporter page (Game settings › Cosmetics can hide them).
- **Unit crests:** the Commander picks on the unit page (Unit crest card).
- **Admins** give or take back any cosmetic: on a player's admin page (Cosmetics) and, for crests, in the Admin box on a unit's page. Each needs a reason, goes in the audit log, and the player (or the unit's officers) is told. Taking an item back takes it off too.
- Ownership is stored in `user_cosmetics` / `unit_cosmetics` with a `source`. Supporters wear every Supporter callsign colour, banner and badge pack without owning them, for as long as the membership lasts; unit crests are never part of it.

## Supporter membership

An optional monthly membership (`/supporter`, linked from the wardrobe, the footer and under More on phones). It only ever gives looks and convenience, never cash, gear, XP or anything the casino can see:

- a **Supporter tag** next to the callsign in chat, on profiles and in the players list;
- **every Supporter look**: callsign colours, profile banners and badge packs (not unit crests);
- **six pinned medals** instead of three.

It's sold by **Lemon Squeezy** as merchant of record (they handle VAT, receipts, refunds and chargebacks); the game only links to their checkout with the player's id and email filled in, and learns about payments from a signed webhook (`POST /webhooks/lemonsqueezy`). Membership is `users.supporter_until`: renewals set it to the next renewal date plus 3 days' grace, a cancellation to the end of the paid period, an expiry to now. When it ends, Supporter-only looks are taken off (at once on the webhook, and by an hourly sweep for memberships that simply run out). Players are told when it starts, is cancelled, a payment fails and when it ends.

- **Admin › Supporters** (`/admin/supporters`): how many are active, gifts, cancelled-and-ending, everyone who ever supported, payments in the last 30 days, the member list and the latest provider events. While it isn't set up, it shows the setup steps.
- **Gifts:** on a player's admin page › Supporter membership, give 1–3,660 days (added to any time they have) or end a gift. Both need a reason and are audit-logged. A gift that runs longer than a paid period isn't cut short by the next renewal.
- **Setup:** DEPLOY.md › Supporter membership. The checkout link and price are on Admin › Server settings; the webhook secret (`LEMONSQUEEZY_WEBHOOK_SECRET`) only on the server. The launch checklist shows whether both are set.
- Terms of Service section 7 covers it (merchant of record, a licence not property, renewal and cancelling, refunds, what happens on suspension).

Code: `src/supporter.js` (rules, webhook parsing), `src/supporter-service.js`, `src/routes/supporter.js`.

## Recruit a friend

`/account/recruit` (under More on phones, and linked from HQ and your profile) shows your invite link (`/join/<callsign>`) with Copy and Share buttons, and how your recruits are doing.

- When a recruit reaches **level 10**, the recruiter gets **$2,500 and 250 XP** and the recruit gets **$1,000** (ledger reason `referral`). The sign-up page tells the friend who invited them.
- Nothing is paid when the accounts share a device or network, when either is suspended, or past **10 rewards per recruiter in 30 days**. The recruiter is told why. Reserve soldiers can't be recruiters.
- Everything is tunable in Game settings › Recruit a friend. Code: `src/referral-service.js`.

## Front page, search engines and link previews

- The front page shows six real screenshots (`public/img/screens/`). `npm run screenshots` retakes them, and the link preview image `public/img/og.png`, from a throwaway demo game.
- Every page has a description, Open Graph and Twitter tags (the preview on Discord, Reddit, WhatsApp…) and, for guests, a canonical link. The front page describes the game for search engines (schema.org `VideoGame`).
- `/robots.txt` lets search engines crawl only the public pages (front page, sign up, sign in, terms) and points to `/sitemap.xml`. Pages for signed-in players carry `noindex`.
- Set `SITE_URL` (e.g. `https://generalforces.com`) so shared links always use the main address; otherwise the address the site was reached on is used.

## Server settings

Admin › **Server settings** (`/admin/server`) edits the settings from the server's settings file that are safe to change from the website. They take effect at once, without a restart:

- **Terms of Service:** who runs the game, contact email and governing law (`LEGAL_OPERATOR`, `LEGAL_CONTACT_EMAIL`, `LEGAL_JURISDICTION`);
- **Site:** the main address for shared links (`SITE_URL`) and the push alert contact (`PUSH_CONTACT`);
- **Supporter membership:** the Lemon Squeezy checkout link and the price as shown (`SUPPORTER_CHECKOUT_URL`, `SUPPORTER_PRICE`);
- **Backups:** the off-site destination and how long copies are kept (`BACKUP_REMOTE`, `BACKUP_REMOTE_KEEP_DAYS`), used from the next nightly backup.

Saved values go in `admin-settings.env` next to the database and override the same names in `/etc/eliteforces/eliteforces.env`. Clear a field to use the file's value again. Saving needs your password, every value is checked against a strict pattern, and each change goes in the audit log. `SESSION_SECRET`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `NODE_ENV`, `DB_FILE`, `PORT`, `TRUST_PROXY` and `ANTICHEAT_SCAN_HOURS` are shown (the secret hidden) but can only be changed on the server, because a hijacked admin session could use them to lock everyone out or take over the server. Code: `src/server-settings.js`.

## Launch checklist

Admin › **Launch checklist** (`/admin/launch`) checks, every time it's opened:

- your details in the Terms of Service (the installer's example values count as missing), and that the contact email is on the game's domain;
- production mode;
- the nightly backup: when it ran, its size, and the **test restore** (the copy is opened, integrity-checked and its players counted);
- the **off-site copy** of each backup (rclone to Backblaze B2, Google Drive, S3… see DEPLOY.md);
- **server errors** in the last 24 hours, with the latest 20 (message, page, stack trace). Admins get an in-game notification and a push alert (category *Server errors*), at most one per half hour;
- outside uptime monitoring: point UptimeRobot or similar at **`/healthz`**, which answers `ok` while the game and database work;
- sign-ups: at most **3 new accounts per network a day** (Game settings › Access), and a hidden form field that turns away simple bots;
- how many reserve soldiers are on duty;
- whether Supporter payments are set up (optional).

## Game loop

| Resource | How it works |
| --- | --- |
| **Energy** | Starts at 50. +1 every 2 minutes. Each mission costs energy. |
| **Health** | Starts at 100. +1 every minute. Failed missions deal damage, and you can't deploy below 15 HP. |
| **XP / Level** | Level *n* needs `100 × n^1.6` XP. Each level-up adds +5 max energy and +10 max health and refills both. |
| **Rank** | Changes every 2 levels from Recruit (E-1) through General (O-10, level 35) to Commander-in-Chief (O-17, level 49), then every 5 levels through the honour ranks Grand Marshal I–X (GM-1 at 55 to GM-10 at 100). |
| **Cash** | Earned from successful missions. Spend it in the Armory or at the field hospital ($2 per HP). Only cash on hand can be taken in PvP. |
| **Bank** | Money in the bank is safe from attacks. Deposits cost 2% (minimum $1); withdrawals are free. There's deliberately **no interest**, so the bank never creates money. Balances are private. |
| **Gear** | Four slots (weapon, body armour, helmet, tactical kit). Gear raises your combat rating, which adds up to +15% mission success, and armour reduces failure damage. |

There are six missions, unlocking at levels 1, 1, 3, 5, 8 and 12. Success chance rises 1% for each level above the mission's minimum and drops 10% while you're below half health. A failed mission still grants 25% XP.

Regeneration is calculated lazily from timestamps, so no background jobs are needed. All game rules live in `src/game.js` as pure functions.

## Forward base

From level 8, each player builds up their own base at `/base` (linked from the HQ service record). Facilities cost cash and take real time to build. Engineers work on one build at a time, builds finish while you're away (checked every minute, with a notification), and cancelling refunds half the cost. Payouts go through the ledger as `base` and `base-refund`.

| Facility | Per level | Max |
|---|---|---|
| Barracks | +5 max energy | 5 (+25) |
| Med Bay | health regenerates 10% faster | 5 (twice as fast) |
| Vault | deposit fee −0.5 points | 3 (2% → 0.5%) |
| Intel Room | scouting −10% | 5 (−50%) |
| Firing Range | training sessions −5% | 5 (−25%) |
| Comms Tower | daily order rewards +10% | 5 (+50%) |

- **Costs:** a facility's base cost × 1 / 2.5 / 6 / 14 / 30 for levels 1–5. For example, the Barracks costs $4k up to $120k.
- **Build times:** 1, 3, 6, 12 and 24 hours.
- **Player level needed:** 8, 12, 16, 22 and 28.
- **Rating and medal:** the base rating is the total of all facility levels (max 28), and the new **Architect** medal rewards it (5 / 15 / 28).
- **Admin level changes:** setting a player's level keeps their Barracks energy.

Rules live in `src/base.js`; building and completion are in `src/base-service.js`.

## PvP seasons

Ranked PvP in four-week seasons, at `/seasons` (the **Season** tab under Players).

- **Rating:** everyone starts at 1,000. Each ranked fight moves both players' rating with an Elo formula, so beating a stronger soldier earns more than beating a weaker one. The winner always gains at least 1 point. Attackers move up to ±32 a fight and defenders up to ±20, because defenders didn't pick the fight. Ratings never drop below 100.
- **What's ranked:** only fights that paid full rewards to both sides. Fights between accounts that share a device or network, and repeat wins on the same soldier within 24 hours, never change ratings. When an admin reverses farmed fights from an anti-cheat flag, their rating changes are undone too (while the season is running).
- **Placement:** 5 ranked fights, won or lost, put you in the standings. Only placed soldiers are ranked and rewarded.
- **Divisions and rewards:** paid at the end through the ledger as `season-reward` (ref `season:<n>`).

| Division | Rating | Reward |
|---|---|---|
| Elite | 1,350+ | $20,000 + 1,500 XP |
| Gold | 1,200–1,349 | $8,000 + 600 XP |
| Silver | 1,050–1,199 | $3,000 + 250 XP |
| Bronze | under 1,050 | $1,000 + 100 XP |

- **Top of the standings:** the top 3 also get $25,000, $15,000 and $10,000. The champion and the top 10 get badges on their profile ("S1 Champion", "S1 · Top 10 · Gold").
- **Soft reset:** a new season starts you halfway between last season's final rating and 1,000.
- **Rollover:** checked every minute. When a season ends, everyone is ranked and paid, gets a notification with their result, and the next season starts straight away. Admins can end a season early from the season page; it's recorded in the audit log.
- **Where it shows:**
  - The season page has your division, rating and progress, the standings, rewards and past seasons. `/seasons/:n` has the final results of a past season.
  - Battle reports show both players' rating changes, and the defender's notification includes theirs.
  - Profiles show the current season's division and rating, plus badges from past seasons. HQ's service record shows your standing.
- **Medal:** the new **Contender** medal counts seasons finished in Gold or Elite (1 / 3 / 10).

Rules live in `src/seasons.js`; storage, ranked fights, reversals and payouts are in `src/season-service.js`.

## Deployments

At `/deployments` (linked from HQ) a player sends their soldier out on a timed patrol that pays out even when they're offline. Deployments cost no energy, but they come with limits:
- While deployed, you can't run missions, operations, training, scouting or attacks.
- While deployed, nobody can attack you: you drop off the Targets list and profiles show "On deployment".

| Deployment | Length | Pay rate | Unlocks |
|---|---|---|---|
| Perimeter patrol | 1h | 100% | level 1 |
| Recon sweep | 4h | 90% | level 1 |
| Long-range patrol | 8h | 80% | level 5 |
| Extended deployment | 12h | 70% | level 15 |

- **Pay:** per hour, $25 + $14 × level and 5 + 2 × level XP, times the pay rate: about a third of what an hour of missions pays, and a quarter of the XP. Officer rank perks (mission pay and XP), live Double XP and Payday events, and the admin deployment-pay setting all apply.
- **Random events:**
  - 25% chance of a supply cache worth an extra 50% of the pay.
  - 10% chance of an ambush on the way back, costing 20% of max health.
  - Every return writes an after-action report.
- **Limits:** at most 16 deployed hours in any rolling 24 hours. You need 25% health to leave, and you can't leave from hospital.
- **Recalling:** you can recall early at any time. A recalled deployment pays nothing, and the hours already spent still count.
- **Returns:** checked every minute, or as soon as you open the page. Each return sends a notification and pays through the ledger as `deployment` (ref `deployment:<id>`).
- **Medal:** the new **Ranger Tab** medal counts completed deployments (10 / 50 / 200).

Rules live in `src/deployments.js`; storage and returns are in `src/deployment-service.js`.

## Campaign 2: levels 15–34

### Missions

Missions are grouped into two campaigns. Campaign 2, **Forward operations**, opens at level 15. Each new mission pays more XP and cash per energy than the one before (a test enforces this), so higher levels stay worth playing.

| Mission | Level | Energy | XP | Pay |
|---|---|---|---|---|
| Night Raid | 15 | 30 | 170–210 | $900–1.3k |
| Ambush the Supply Line | 18 | 35 | 230–280 | $1.3k–1.8k |
| Rescue the Downed Pilot | 22 | 40 | 310–370 | $1.8k–2.5k |
| Sabotage the Radar Site | 26 | 45 | 410–480 | $2.5k–3.4k |
| Siege of the Citadel | 30 | 50 | 520–600 | $3.3k–4.5k |
| Decapitation Strike | 34 | 55 | 650–750 | $4.4k–6k |

### Operations

Operations are three-stage missions. Each stage is rolled like a mission, and a failed stage stays put. Clearing all three pays a completion bonus, and each operation can then be run again after 20 hours. Payouts go through the ledger as `operation`.

| Operation | Level | Stage energy | Completion bonus |
|---|---|---|---|
| Iron Gate | 16 | 25 / 30 / 35 | $4,000 + 600 XP |
| Nightfall | 24 | 35 / 40 / 45 | $9,000 + 1,400 XP |
| Last Light | 32 | 45 / 50 / 55 | $16,000 + 2,600 XP |

### New gear tier

Levels 16–33, four items per slot type:
- **Weapons:** Battle Rifle, Anti-Materiel Rifle, GPMG, XM Smart Rifle
- **Armour:** Ceramic Plate Rig, Exo-Frame, Juggernaut Suit
- **Helmets:** Comms Helmet, Panoramic NVG Helmet
- **Kit:** Thermal Scope, Drone Uplink, Smart Munitions

Prices run from $18k to $140k, and the best combat rating climbs from about 200 to about 850. Armour reduction tops out at about 66%, under the 75% cap.

### Supplies

Consumables in the Armory's Supplies shop (`/armory/shop/supplies`) from level 15, bought and used in one step (ledger reason `supplies`):
- **Adrenaline Shot ($2,500):** +30 energy, up to your maximum, once every 20 hours.
- **Combat Stim ($3,000):** +15% damage in your next attack. One at a time, and battle reports show when one was used.

### Rank perks

Officer ranks bring permanent economic perks, never combat ones, so PvP balance doesn't depend on rank:

| Rank | Level | Perk |
|---|---|---|
| Second Lieutenant | 17 | +5% mission pay |
| Captain | 21 | +5% mission XP |
| Major | 23 | 25% off hospital treatment |
| Colonel | 27 | another +5% pay |
| Brigadier General | 29 | another +5% XP |
| General | 35 | supply drops +50% |
| Field Marshal | 41 | another +5% pay |
| Theatre Commander | 45 | another +5% XP |
| Commander-in-Chief | 49 | supply drops pay double |
| Grand Marshal I, III, V, VII, IX | 55, 65, 75, 85, 95 | +3% pay each |
| Grand Marshal II, IV, VI, VIII, X | 60, 70, 80, 90, 100 | +3% XP each |

Pay and XP perks also apply to operations. The Missions page lists your perks, and HQ shows the next one. Anti-cheat's "impossible payout" limit includes the perk bonus.

## Campaign 3: levels 35–50

**Global war** opens at level 35 with a notification. It continues every curve past where Campaign 2 stops, and campaigns 4–6 carry on to level 100 (below).

### Ranks

There's a new rank every 2 levels above General: General of the Army (37, O-11), Chief of Staff (39), Field Marshal (41), Marshal of the Forces (43), Theatre Commander (45), Supreme Commander (47) and Commander-in-Chief (49, O-17).

### Missions

| Mission | Level | Energy | XP | Pay |
|---|---|---|---|---|
| Seize the Satellite Uplink | 36 | 60 | 760–870 | $5.6k–7.4k |
| Board the Carrier | 39 | 65 | 900–1,020 | $7k–9.2k |
| Reactor Lockdown | 42 | 70 | 1,050–1,200 | $8.6k–11.2k |
| Storm the Mountain Fortress | 45 | 75 | 1,230–1,400 | $10.5k–13.5k |
| Take Down the Shadow Council | 48 | 80 | 1,420–1,620 | $12.5k–16k |
| Zero Hour | 50 | 85 | 1,650–1,880 | $15k–19k |

As in Campaign 2, every new mission pays more XP and cash per energy than the one before, and tests enforce it.

### Operations

| Operation | Level | Stage energy | Completion bonus |
|---|---|---|---|
| Black Tide | 40 | 60 / 65 / 70 | $28,000 + 4,500 XP |
| Iron Crown | 47 | 70 / 75 / 80 | $45,000 + 7,000 XP |

### Gear

Two new items per slot, for levels 36–48 and $120k–$450k:
- **Weapons:** EM Railgun Prototype, Pulse Carbine
- **Armour:** Reactive Armour, Nano-Weave Suit
- **Helmets:** Tactical HUD Helmet, Neural Link Helmet
- **Kit:** Satellite Designator, Drone Swarm Controller

The best combat rating climbs from about 850 to about 1,770. Armour has steep diminishing returns this high, so the new armour adds mostly attack and the new helmets mostly crits. Armour reduction stays under 70%, and a test checks it at every level up to 50.

### Also new

- **Rank perks:** more pay, XP and supply drops at levels 41, 45 and 49 (see the rank perks table).
- **Title:** **Living Legend**, for reaching level 50.

Rules live in `src/game.js` (missions), `src/operations.js`, `src/items.js`, `src/supplies.js` and `src/perks.js`.

## Campaigns 4–6: levels 51–100

Three more campaigns take the game to level 100. Each opens with a notification:
- **Campaign 4, The shadow war (51–65):** Deep Cover, Hold the Great Dam, Hunt the Silent Sub, Skyhook, Crack the Black Vault, Cut the Strings.
- **Campaign 5, Iron horizon (66–80):** Take the Space Elevator, Ride the Storm Front, Clear the Ghost City, Break the Iron Sea, Shut Down the Mind Forge, Hold the Horizon Gate.
- **Campaign 6, Endgame (81–100):** Red Moon, Stop the World Engine, The Last Parliament, Eclipse, The Final Front, and Peace Through Strength at level 100.

**Operations:**

| Operation | Level | Completion bonus |
|---|---|---|
| Glass Dagger | 55 | $68,000 + 9,600 XP |
| Deep Winter | 62 | $91,000 + 11,800 XP |
| Iron Tempest | 70 | $123,000 + 14,400 XP |
| Longest Night | 77 | $155,000 + 16,900 XP |
| Starfall | 85 | $198,000 + 20,000 XP |
| Endgame | 95 | $261,000 + 24,100 XP |

**Gear:** 24 new items, four per slot type, for levels 52–98. Prices run from $550k to $2.7M. Health only grows steadily with level, so the new gear's attack grows gently. That keeps PvP fights between equals at about 3.5 hits all the way to level 100, and a test enforces at least 3 hits.

**Ranks, perks and titles:**
- Ten honour ranks, Grand Marshal I–X, one every 5 levels from 55. Each brings +3% pay or XP.
- New titles: **Immortal** (level 75) and **Centurion** (level 100).

**How the numbers were made:** they come from formulas that continue the existing curves from Zero Hour (level 50):
- Pay grows with level^2.5, XP with level^1.7 (to keep pace with the levelling curve) and energy with level^0.8.
- Tests check that every mission pays more cash and XP per energy than the one before, all the way to 100.
- At level 100 a mission pays about $85k–108k, and a level takes about 158k XP.

**Missions page:** campaigns you've reached and the next one show in full. Later ones collapse to a one-line teaser, and only operations you can run (plus the next to unlock) are listed, so new players aren't faced with 36 locked missions.

Levels have no hard cap. XP keeps counting past 100, and Grand Marshal X stays the top rank. Admins can set any level up to 120 for testing.

## Special operations

Rare, time-limited missions (`src/special-ops.js`, shown at the top of the Missions page and on HQ while one is open). Every 6 hours (00:00, 06:00, 12:00 and 18:00 UTC) one of eight special operations opens for **3 hours**, the same one for everyone. From level 10, each player gets **one run** per opening:

- **Three stages in a row**, and at each one a choice: **stealth** (+12% chance, normal pay; Agility training helps) or **assault** (−8% chance, 1.6× pay, more damage if it fails; Strength helps). A failed stage ends the run.
- Stages are built from the newest mission open to the player's level (same energy, 1.3× its pay), so a run is worth the same effort at every level. Rank perks, unit bonuses, vehicles, events and admin pay settings apply as for missions.
- **Clearing all three** pays a bonus of about four missions' pay (+15% for each assault taken), two hauls of workshop materials rich in prototype cores, and a 15% chance of a vehicle they don't own yet that's open to their level.
- The **Special Forces Tab** medal counts completed runs (1 / 10 / 50); the service record shows them too. Ledger reason `special-op`.
- Game settings › Economy: *Special operations* (on/off) and *Special operation pay & XP*. Runs are stored in `special_runs`.

## Training and scouting

- **Training** (`/training`): three stats raised one point per session, at 5 energy plus cash that rises with the stat ($25, $30, $35…). Each stat can reach 10 × your level.

  | Stat | Each point gives |
  |---|---|
  | Strength | +0.5 attack |
  | Agility | +0.2% crit chance, +0.2% **dodge** (a chance to avoid a hit entirely, capped at 25%) |
  | Endurance | +0.5 armour, +2 max health |

  Every mission favours one stat: +0.2% success per point, up to +10%.
- **Training is secret.** Profiles, the players list and battle reports only show the **gear rating**. Your own pages show your true rating.
- **Scouting** (from a profile): $50 + $25 × the target's level (+50% if they outrank you) and 3 energy. You get a report of their training, true combat rating, dodge, armour and health. It's saved on their profile for you alone and shows its age. The target is told someone scouted them, but not who. The price uses only public facts, so it can't reveal anything about their training.

Rules live in `src/training.js` and `src/scouting.js`.

## Basic training (new-player tutorial)

A checklist at the top of HQ walks new players through the game. Each step ticks off **by itself** once it has really been done, and pays a small one-off reward.

| Step | Reward |
|---|---|
| Run your first mission | $100 · 20 XP |
| Equip gear from the Armory | $150 · 20 XP |
| Train a stat | $100 · 20 XP |
| Collect a supply drop | $50 · 15 XP |
| Bank some cash | $50 · 15 XP |
| Reach level 3 (PvP unlocks) | $200 |
| Get a vehicle from the motor pool | $300 · 20 XP |
| Apply to or join a unit | $250 · 30 XP |
| Win a PvP fight (one that paid XP) | $300 · 40 XP |

- **Graduation:** finishing every step pays a **$500 + 100 XP** graduation bonus, and the checklist then disappears for good.
- **Hiding:** players can hide the checklist. HQ then shows a "Show basic training (n/9)" link to bring it back.
- **Notifications and the ledger:** each step sends a notification, and all rewards go through the ledger as `tutorial`.
- **Players who started before this update:** they get the steps they've already done ticked off and paid at once the next time they open HQ.

- **Field guide:** once basic training is done or hidden, HQ shows one tip at a time for the next feature a player has unlocked but not tried: deployments, the motor pool (level 3), the market and contracts (level 5), the workshop (level 6) and special operations (level 10). A tip goes when they try the feature or press *Got it* (`src/field-guide.js`).

Rules live in `src/tutorial.js`; detection and payouts are in `src/tutorial-service.js`. `createApp({ tutorial: false })` turns tutorial rewards off, which tests of other systems use so their cash checks stay exact.

## Chat

Live game chat at `/chat`, from the chat icon in the header on every page.

- **Channels:** **Global** for every player, plus a private channel for your unit (`/chat/unit`), which only members can read.
- **Live:**
  - New messages appear every few seconds without reloading (it slows to every 20 seconds while the tab is hidden).
  - Enter sends and Shift+Enter adds a new line.
  - Times show in the player's own time zone.
  - Without JavaScript, the page still works with normal form posts, and a failed post keeps your draft.
- **Formatting:** BBCode through the shared editor, as everywhere else players write. On phones the chat toolbar keeps the essentials. Text sizes are toned down inside chat so one message can't take over the channel.
- **@mentions:** `@callsign` links the player's profile, highlights the message for them and sends a notification. Notifications go out for up to 3 mentions per message, never to someone who has blocked you, and never to someone who can't read that channel.
- **Limits:**
  - Messages are up to 500 characters and 8 lines.
  - You need level 2 to post (new accounts can still read).
  - There's a 3-second cooldown, and the same message twice within a minute is refused.
  - Messages are deleted after 30 days.
- **Blocking:** messages from players you've blocked are hidden from you.
- **Unread:** the chat icon shows a green count of new messages in your unit channel, linking straight to it, and a blue dot when Global has new messages. Channel tabs show the same counts. Both update live with the rest of the header, and opening a channel marks it read. Your own messages, deleted messages and those from blocked or suspended players never count.
- **Moderation:**
  - Anyone can delete their own messages or report someone else's (with an optional reason) from the **⋯** menu.
  - Admins can delete any message and mute the author (10 minutes to 7 days, with a reason shown to them) straight from that menu.
  - **Admin › Chat** (`/admin/chat`) lists reported messages, each with a copy taken at the time, and offers Dismiss, Delete message, or Delete + mute. It also lists who is muted, with Unmute.
  - Every action goes in the audit log.
- **Terms:** sections 5 and 8 of the Terms of Service cover chat. The terms version was bumped, so players accept them again on their next visit.

Rules live in `src/chat.js`; storage, history, polling, reports and mutes are in `src/chat-service.js`; routes are in `src/routes/chat.js`.

## Private messages

- **Conversations:** two-player threads with a subject. Start one from a player's profile (**Message**) or from `/messages/new`.
- **Unread counts:** the envelope in the header shows unread conversations and updates live, with a pop-up when a new message arrives while you're elsewhere in the game.
- **Formatting editor:** BBCode, with a toolbar that wraps the selected text.
  - Bold, italic, underline and strike; a colour palette; text size; links; `@` player links; quote; lists; code; spoiler; centre; divider.
  - **Shortcuts:** Ctrl+B, Ctrl+I and Ctrl+U for bold, italic and underline; Ctrl+Enter sends.
  - The **Preview** tab is rendered by the server, so it's exactly what the recipient sees.
  - **Quote** on any message drops it into your reply.
  - Without JavaScript you get a plain text box with a formatting cheat-sheet.
- **Supported tags:** `[b] [i] [u] [s] [color=red|#hex] [size=small|large|huge] [url] [url=…] [player] [quote] [quote=Name] [list] [list=1] [*] [code] [spoiler] [center] [hr]`.
- **Safe by design (`src/bbcode.js`):**
  - Player text is never treated as HTML. It's split into tags and text, all text is escaped, and only allowlisted tags produce markup.
  - Colours, sizes and links are validated. Links must be http(s), open in a new tab, and are marked `nofollow`.
  - Nesting is capped, and broken BBCode is shown as plain text.
  - There's no `[img]`, so senders can't track recipients with images loaded from other sites.
- **Anti-spam:**
  - you need level 2 to start conversations (anyone can reply)
  - 5 seconds between sends
  - at most 20 new conversations a day
  - 5,000 characters per message
- **Blocking:** from a profile, a conversation or `/messages/blocked`. Blocked players can't message you, and they aren't told you blocked them.
- **Reports:** go to **Admin → Reported messages** (`/admin/reports`) as a copy of the message, together with the reason given. Staff can't read private messages unless one is reported. Resolving a report is written to the admin audit log.
- **Deleting:** deleting a conversation hides it from your inbox, and it reappears if a new message arrives. Once both players delete it, it's erased from the database.

Rules live in `src/messages.js`; storage is in `src/message-service.js`; the parser is in `src/bbcode.js`.

### Formatting everywhere players write

The same editor and renderer are used for **every** free-text field a player writes. New fields follow the same rule; see `CLAUDE.md`.

| Where | Limit |
|---|---|
| Private messages | 5,000 |
| Profile bio (`/account/profile`, shown as **About** on the profile; admins can clear it) | 2,000 |
| Unit board posts (with **Quote**) | 2,000 |
| Unit descriptions (founding form and Command settings) | 1,000 |
| Unit applications | 500 |

Every editor previews through `POST /format/preview`. Callsigns, unit names and tags, and short moderation notes stay plain text.

## Events

Admins schedule timed world events at **Admin → Events** (`/admin/events`): pick a type, a duration of 1–168 hours, a start time (now, or a UTC date and time up to 60 days ahead), and an optional announcement written with the BBCode editor. Events can be ended early or cancelled, and every action is written to the audit log.

| Type | Effect |
|---|---|
| Double XP | missions and operations pay ×2 XP |
| Payday | missions and operations pay ×1.5 cash |
| Supply Surge | supply drops ×2, daily order and Commendation rewards ×2 |
| War Season | unit war points ×2, war prizes ×1.5 |
| Most Wanted | no fee for posting bounties |

- **Combining:** different types can overlap and their effects combine, but the same type can't overlap itself. Event multipliers apply on top of rank perks and the unit Drill ground.
- **What players see:** everyone gets a notification when an event starts, and a banner with a live countdown shows on every page while it runs. HQ shows events starting within 7 days, and `/events` lists live, upcoming and recent events (also linked from the footer).
- **Anti-cheat:** the limits allow for events. The energy-based income cap includes rank perks and any Payday live in the last 24 hours, and the "impossible payout" limit includes the largest event multiplier.

Rules live in `src/events.js`; scheduling, live effects and announcements are in `src/event-service.js`. Game systems read the live multipliers through an `effects(now)` function passed to their services.

## Daily orders and supply drops

- **Daily orders:** three orders each UTC day, picked to fit your level. They might be "Complete 4 missions", "Complete Convoy Escort twice", "Earn $580 from missions", "Win a PvP fight", "Train 3 sessions" or "Scout another player". PvP and scouting orders only appear from level 3. Players who own a vehicle can also get motor pool orders: "Complete 2–6 missions with a vehicle taken out" (operation stages count) or "Come back from a deployment with a vehicle taken out".
  - Progress tracks automatically. You get a notification when an order is complete, then claim it at HQ.
  - Each order pays `15 + 8 × level` XP and `$40 + $35 × level`. Claiming all three earns a **Commendation** worth one more order.
  - Unclaimed rewards expire at 00:00 UTC.
  - A PvP win only counts at full rewards, so wins against linked accounts and repeat wins on one player don't count.
- **Supply drop:** claim once a day from HQ for `($25 + $15 × level) ×` the multiplier for that day of the streak: 1, 1, 1.5, 1.5, 2, 2, 3. Day 7 also refills your energy, then the cycle repeats. Miss a UTC day and the streak goes back to 1; your best streak is kept.
- Every payout goes through the ledger (`daily-order`, `daily-bonus`, `supply-drop`).

Rules live in `src/daily.js` and `src/daily-service.js`.

## Units

- **Founding** costs $2,500 and needs level 5. Names are 3–24 characters and tags 2–4 (shown as `[TAG]`); both are unique.
- **Joining:** players apply from a unit's page with an optional message (up to 3 open applications). The Commander and officers accept or reject them.
- **Finding a unit:** players without one get help to join:
  - **Recruiting now** on `/units`: up to three units they could join straight away (taking applications, room to spare, requirements met) with members seen in the last 3 days, busiest first.
  - From level 3, a **Join a unit** card at HQ with two of those units, or their invitations if they have any. At level 5 a notification points them to the Units page.
  - **Looking for a unit:** a switch on `/units` puts them on a list officers can see (it drops anyone not seen for a week, and joining a unit takes them off).
- **Invitations:** Sergeants and above open **Find recruits** (`/units/:id/recruits`) from the Applications card. It lists players who are looking, with level, record and when they were last seen. An invitation lets the player join straight away, even below the unit's requirements, and lasts a week. A unit can send 20 a day and only to players who are looking. The player accepts or declines it on `/units`; the 12-hour wait after leaving a unit still applies. Whoever sent it and the unit's officers are told when it's accepted.
- **Application settings (Commander):** turn applications on or off, and set minimum **level**, **PvP wins** and **missions won** to apply. Requirements show on the unit profile and in the unit list, and players who fall short are told exactly what's missing.
- **Unit profile** (`/units/:id`) is public:
  - founding date and Commander
  - strength, members, war record (W–L–D), combined PvP wins and missions, mission XP bonus
  - application status and requirements
  - roster, upgrades and war history
- **Chain of command:** **Commander** › **Lieutenant** › **Sergeant** › **Private**. Promotions and demotions move one step at a time, and only on people below your own rank.
  - **Commander:** everything below, plus making Lieutenants, editing settings, spending the treasury on upgrades, handing over command (type the callsign to confirm) and disbanding the unit (type the tag).
  - **Lieutenants:** remove Sergeants and Privates, promote Privates to Sergeant, call **rally orders** and launch **raids**.
  - **Sergeants:** review applications and moderate the unit board.
  - Everyone can post on the **unit board**, which only members can read and which allows one post per 10 seconds.
- **No friendly fire:** members can't attack each other, and the Targets filter hides them.
- **Treasury:** members donate cash, which goes through the ledger as `unit-donation`. It's spent on upgrades, rally orders and raid supplies, and it **never pays out to players**, so it can't be used to move money between accounts. (Raid loot is new money from the game, sized by the unit, not by what was spent.)
  - **Barracks:** 10 members, +5 per level, up to 3 levels ($5k, $15k, $40k).
  - **Drill ground:** +2% mission XP for every member per level, up to 5 levels ($3k to $90k).
- **Leaving** starts a 12-hour wait before you can join or found another unit. A Commander has to hand over command first; if they're the last member, leaving disbands the unit.
- **Rankings:** units are ranked by strength, the total level of their non-suspended members. `/units` lists them with search.
- **Moderation:** admins see an Admin box on every unit page to rename or disband it. Both actions are written to the admin audit log and members are notified.

Rules live in `src/units.js`; data access is in `src/units-repo.js`.

### Rally orders

A Lieutenant or the Commander spends treasury on **"Advance!"**: +15% mission and operation cash and XP for every member for one hour. It stacks with the drill ground and rank perks (before event and admin multipliers). Every member gets a unit alert. The cost scales with members and average level, and a unit can rally once every 12 hours.

### Raids

A co-op boss fight against an enemy stronghold (`#raid` on the unit page).

- **Launching:** a Lieutenant or the Commander picks a stronghold and pays for supplies from the treasury. Six tiers open with the unit's average level: Insurgent Outpost (1), Fortified Compound (10), Mountain Bunker (20), Coastal Battery (35), Command Citadel (50) and Black Site (75). One raid at a time, and the unit regroups for 24 hours after a raid ends before launching the next (**Game settings › Pace › Wait between raids**; raids HQ calls off don't count).
- **Pay:** loot is tuned so a member earns about **1.75× the cash and 1.5× the XP** the same energy would earn on missions, at every tier (`npm run balance` prints the figures). The treasury gets back more than the supplies cost.
- **Sizing:** health, supply cost and loot scale with the number of members (counted as at least 3) and their average level, so a big unit faces a bigger stronghold.
- **Striking:** each strike costs **10 energy** and deals damage from your combat rating, and you take 3–8% of your health in return fire. You can't strike from hospital, on deployment or below 20% health.
- **Winning:** the unit has **48 hours**. If the stronghold falls, 25% of the cash goes to the treasury and the rest, plus all the XP, is shared by damage dealt. Everyone who struck shares, even if they've left the unit since (so removing strikers gains nothing); suspended players don't. Payouts go through the ledger as `raid-loot`.
- **Losing:** if time runs out there's no loot and the supplies are gone.
- **Alerts:** members hear when a raid launches, when the stronghold is 75% down, when 6 hours are left and when it ends.
- Admins scale the loot with **Game settings › Economy › Unit raid loot** (`raidRewardMult`).

Rules: `src/raids.js`. Storage, strikes and payouts: `src/raid-service.js`.

### Unit wars

- **Declaring:** a Commander declares war from another unit's profile, staking **$2,500 from the treasury**. Both units need at least 3 members, and neither can already be at war. Every member of both units is notified.
- **Duration and scoring:** a war lasts **24 hours**. Every PvP win between the two sides scores 1 point, or 2 for a knockout, and defending wins count too.
- **Anti-cheat:** only full-reward wins count, so fights between linked accounts and repeat wins on the same player don't score. Only soldiers who were already in their unit when the war began can score, so mercenaries recruited mid-war earn nothing.
- **Settling:** happens automatically within a minute of the end. The winner's treasury gets **double the stake**, a draw refunds the declarer, and records update.
  - Both units are protected for 6 hours afterwards, and the same pair can't fight again for 72 hours.
  - A unit that disbands mid-war forfeits. If the other side was the declarer, it only gets its stake back.
- **Where to see it:**
  - `/wars`: active wars and recent results
  - `/wars/:id`: war room with the scoreboard, top fighters and every scoring fight
  - the unit profile shows a war banner with a live countdown
  - **Players → War** lists enemy soldiers
  - battle reports note the points a fight scored

Rules live in `src/wars.js`; storage, scoring and settling are in `src/war-service.js`.

## Theatre of war

A map of 8 regions that units fight over week by week (`/theatre`, linked from Units and each unit page).

- **Fronts:** each week (Monday 00:00 UTC to the next Monday) a Lieutenant or the Commander picks one region as the unit's **front**. Members are told. The front can move every 6 hours, and points already scored stay where they were earned. Units need at least 3 members.
- **Scoring:** members' play scores on the front: 1 point per mission won or training session, 3 per PvP win as the attacker or deployment brought back, and 2 per raid strike. PvP points use the same full-reward rules as daily orders, so linked accounts and repeat wins don't score.
- **Handover:** when the week ends, the unit with the most points in each region takes it. A holder defending its own region gets +25% on its points there, and a tie never changes hands. Both sides are notified, and the result shows under **Last week**.
- **Holding a region** pays its daily income into the treasury ($2,500 to $6,000, once per region per UTC day) and some regions give every member a mission XP bonus (up to +6% in total, added alongside the drill ground and rally). Income goes to the treasury, which never pays out to players.
- Admins scale the income with **Game settings › Economy › Theatre of war income** (`theatreIncomeMult`, 0 turns it off).
- Rules: `src/theatre.js`. Storage, scoring, settling and income: `src/theatre-service.js`.

## Weekly unit objectives

Every unit gets three shared objectives each week (Monday 00:00 UTC to the next Monday), picked from five types and shown at the top of the unit page:

| Objective | Counts | Target per member |
|---|---|---|
| Mission sweep | missions and operation stages won | 25 |
| Show of force | PvP wins as the attacker (full-reward wins only: no linked accounts or repeat wins) | 6 |
| Boots on the ground | deployments brought back | 4 |
| Drill week | training sessions | 8 |
| War chest | cash donated to the treasury | 10 deployment-hours of pay at the unit's average level |

- Targets assume at least 3 members (and at most 30), so tiny units still have to work for them. They're fixed when the week's objectives are set.
- Completing one pays **12 deployment-hours per member into the treasury** (about $37,000 for 10 level-20 members), and every member who helped gets **4 deployment-hours of XP**.
- Members are told at 80% and on completion. The card shows progress, rewards and the week's top contributors.
- Admins scale the rewards with **Game settings › Economy › Unit objective rewards** (0 turns them off).
- Rules: `src/objectives.js`. Tracking and payouts: `src/objective-service.js`, fed by the daily-order progress hook plus deployments and donations.

## Daily high-value target

Each UTC day one active player is marked as the **high-value target**. They're picked from the 25 highest-level non-admin players seen in the last 3 days, and never twice in a row.

- Beating them in a full-reward fight pays a bonus of **6 deployment-hours of cash and 4 of XP** at the target's level, once per attacker per day (about $2,700 and 260 XP at level 30). Linked accounts and repeat wins don't collect.
- Each full-reward attack the target fights off pays them **2 deployment-hours**, up to 10 a day.
- The target is told in the morning. A card on Players and HQ shows who it is, the bonus, and an Attack button; their profile is tagged, and battle reports show the bonus.
- Payouts use the `target-bonus` ledger reason. Admins scale them with **Game settings › Economy › High-value target bonus**.
- Code: `src/target.js` and `src/target-service.js`.

## Titles

Players earn **titles** and can show one under their callsign, on their profile and next to their name in chat. Pick one (or none) under **Edit profile › Title**. Locked titles show how to earn them. Titles use the same career numbers as medals, so they're checked after every action, and each new one arrives as a notification.

| Title | Earned by |
|---|---|
| Field Operator | 100 missions won |
| Ghost | 50 deployments completed |
| Brawler | 50 PvP wins as attacker |
| Enforcer | 25 knockouts |
| The Wall | 50 attacks held off |
| Headhunter | 10 bounties collected |
| Drill Sergeant | 150 training points |
| Ever-Present | a 30-day supply drop streak |
| Architect | forward base rating 15 |
| War Hero | 100 war points |
| Warlord | 5 unit wars won |
| Veteran / The General / Living Legend / Immortal / Centurion | level 20 / 35 / 50 / 75 / 100 |
| Contender | a PvP season finished in Gold or Elite |
| Top Ten / Season Champion | a PvP season finished in the top 10 / first |

The rules are in `src/titles.js`. Earning and choosing titles is handled in `src/medal-service.js`.

## Avatars

Every player has an avatar, shown on their profile, in chat, in the player directory, on leaderboards and on unit rosters. Set it on **Profile › Avatar** (`/account/avatar`). There are two kinds:

- **Badge:** build one from ten sections: shape, field colour, pattern and its colour, emblem and its colour, trim and its colour, banner (rank grade, level, callsign or unit tag) and honours (stars or a laurel wreath). Some parts unlock with level, others with titles (Skull: Enforcer; Crown: Living Legend; Laurel: Veteran; Elite violet: Contender). The preview updates as you pick, and **Shuffle** picks a random badge. Badges are stored as part ids only and drawn as SVG on the server. Until a player builds one, they get a starting badge picked from their account id.
- **Uploaded picture:** PNG, JPEG or WebP, up to 1 MB and 32–4096 pixels a side. The real type is read from the file's bytes, and EXIF/GPS and other metadata are stripped before it's stored (in the database, so backups include it). Pictures need level 3 and are limited to 10 uploads a day. Players can switch between their badge and their picture, or delete the picture.

Pictures can be reported from the player's profile. **Admin › Avatars** lists reported pictures and the latest uploads. Admins can remove a picture (the player is told why and goes back to their badge) and block a player from uploading again. **Admin › Game settings › Avatars** turns uploads off for everyone or changes the level needed. Avatar images are only served to signed-in players, with a sandboxing Content-Security-Policy.

The parts are in `src/avatars.js`, the picture checks in `src/images.js`, and storage in `src/avatar-service.js`.

## Medals

Twenty-two medals, each with **Bronze, Silver and Gold** tiers. Each tier pays once: Bronze +50 XP and $250, Silver +150 XP and $1,000, Gold +400 XP and $5,000. Every payout goes through the ledger as `medal`.

| Medal | Earned by | Bronze / Silver / Gold |
|---|---|---|
| Field Operator | missions won | 25 / 100 / 500 |
| Combat Medal | PvP wins as attacker | 10 / 50 / 200 |
| Knockout Artist | knockouts (attacking or defending) | 5 / 25 / 100 |
| Iron Wall | attacks held off | 5 / 25 / 100 |
| Drill Instructor | training points | 30 / 150 / 500 |
| Long Service | best supply-drop streak (days) | 7 / 30 / 90 |
| Order of Merit | daily orders claimed | 15 / 60 / 250 |
| Commission | level | 10 / 20 / 35 |
| War Hero | war points scored | 10 / 50 / 200 |
| Bounty Hunter | bounties collected | 1 / 10 / 50 |
| Architect | forward base rating | 5 / 15 / 28 |
| Ranger Tab | deployments completed (not recalled) | 10 / 50 / 200 |
| Contender | PvP seasons finished in Gold or Elite | 1 / 3 / 10 |
| Victory Medal | unit wars won (as a member from the start of the war) | 1 / 5 / 20 |
| High Roller | dollars bet at the casino (any game, win or lose) | $100,000 / $2.5M / $50M |
| Big Winner | casino wins of 20× the bet or more | 1 / 10 / 50 |
| Card Sharp | blackjacks dealt at the casino | 5 / 50 / 250 |
| Driver’s Badge | missions and operation stages won with a vehicle taken out | 25 / 150 / 600 |
| Fleet Commander | vehicles in your motor pool at the same time | 1 / 5 / 12 |
| Master Mechanic | upgrades made in the workshop | 1 / 10 / 40 |
| Soldier of Fortune | contracts completed as a mercenary | 1 / 10 / 50 |
| Special Forces Tab | special operations completed | 1 / 10 / 50 |

- **Awarding:** medals are checked after every action, and when you open HQ or the medal case, so things that happened while you were away (defences, war wins) are caught too. Each new medal arrives as a notification.
- **Casino medals** use career totals kept on the player (`casino_wagered`, `casino_big_wins`, `casino_blackjacks`), since plays are only kept 30 days. Every game has a house edge, so betting to earn High Roller always costs more than it pays.
- **Farming protection:** PvP medals only count fights that paid XP and weren't reversed by an admin, so wins against linked alt accounts earn nothing.
- **Where they show:** `/medals` is your medal case, with progress to the next tier and the share of players holding each tier. Pin up to 3 medals (6 for Supporters) to feature them at the top of your profile. Profiles show every medal a soldier holds.

Rules live in `src/medals.js`; awarding and storage are in `src/medal-service.js`.

## Bounties

- **Posting:** put cash (from cash on hand) on any soldier who can be attacked (level 3+), from their profile or the **Bounty board** (`/bounties`, under Players).
  - The minimum is $500, plus a **10% fee that's destroyed**, which makes bounties a money sink.
  - Bounties can be anonymous, and each player can have up to 5 open at once.
  - The target is notified, and their profile shows **Wanted · $X**.
- **Collecting:** the first soldier to beat the target in a **full-reward PvP win** collects every bounty on them. The battle report and notifications say who collected what.
- **Expiry:** bounties nobody collects within **7 days** are refunded to whoever posted them; the fee isn't.
- **Anti-laundering:**
  - you can't post on yourself
  - accounts that have shared a device or network can't post on, or collect from, each other
  - you can't collect your own bounty
  - bounties can't be cancelled
  - posting, collecting and refunds all go through the ledger (`bounty-placed`, `bounty-claim`, `bounty-refund`)
- **Medal:** the **Bounty Hunter** medal (1 / 10 / 50 bounties collected).

Rules live in `src/bounties.js`; storage and payouts are in `src/bounty-service.js`.

## Contracts

Mercenary work between players (`/contracts`, under Players; profiles have **Hire** and **Contract** buttons). Bounties are open to anyone and paid to the first soldier who wins; a contract is a deal with one mercenary, against a deadline.

- **Two jobs:**
  - **Hit:** beat a named soldier 1–3 times, optionally by knockout. Only the first win on a soldier each day pays full rewards, so each win needs a day (2 wins need 48 hours). Paid on the last win.
  - **Bodyguard:** while the contract runs, beat the soldiers who attack the client, each one once, up to 1–5 of them. Paid an even share for each.
- **Posting:** $1,000 to $1,000,000 from cash, plus a **10% fee that's destroyed** (Game settings › Economy › *Contract fee*). Post it on the open board, or offer it to one soldier. Each player can have 3 open or under way.
- **Taking it:** a mercenary takes a contract and gets 24, 48 or 72 hours, chosen by the client. They can work 2 at once. The client is told; a hit's target is told that someone is after them (not who). Targets never see hits on themselves on the board, and offers only show to the soldier they're for.
- **Money:** the pay is held in escrow. Whatever isn't earned goes back to the client: when a hit runs out of time, a bodyguard job ends with shares unpaid, a mercenary abandons it or turns down an offer, a contract nobody takes within 7 days, or one the client withdraws before it's taken. The fee is never refunded. Ledger reasons: `contract-posted`, `contract-pay`, `contract-refund`.
- **Fair play:** only full-reward PvP wins count (no linked accounts, no repeat wins on one soldier in a day). The client, mercenary and target can't be the same player or accounts that share a device or network. Reserve soldiers can be targets but don't take contracts.
- **Reputation:** completed and failed contracts show on a mercenary's profile and service record (a hit that runs out or is abandoned is a failure; bodyguard duty that earned anything is done, since nobody may have attacked the client). The **Soldier of Fortune** medal counts completed contracts (1 / 10 / 50).

Rules: `src/contracts.js`; escrow and progress: `src/contract-service.js`.

## PvP and the hospital

- **Attacking** costs 10 energy and is started from another player's profile. Both sides trade hits for up to 10 rounds using real health and gear. The attacker strikes first and the defender fights back automatically.
- **Knockouts:** a player who reaches 0 health is admitted to hospital for 10 minutes. With no knockout, whoever lost the smaller share of their health wins, and ties go to the defender.
- **Hospital:** patients can't run missions, attack or be attacked. They leave with at least 50% health, or can pay `minutes left × (10 + 2 × level)` to leave early. `/hospital` lists everyone on the ward.
- **Rewards:**
  - A winning attacker takes 5% of the loser's cash, capped at $25 × the loser's level, plus XP of `(8 + 2 × loser level)` scaled ×0.5–×1.5 by the level gap.
  - A defender who wins earns half that XP.
  - A losing attacker loses only energy and health.
- **Protection:**
  - Recruits (levels 1–2) can't attack or be attacked.
  - You can't attack anyone more than 3 levels below you.
  - You can attack the same player at most once every 15 minutes.
  - You need at least 15 health to attack.
- **Battle reports** (`/battles/:id`) show each round. Results appear on both players' profiles and in their radio logs.

Tuning constants live at the top of `src/pvp.js` and `src/game.js`.

## Notifications

- **Triggers:**
  - being attacked (won or lost, including knockouts and cash lost)
  - promotions
  - unlocks on level-up (new missions, new Armory gear, PvP at level 3)
  - a welcome message for new players
  - a daily order being completed
  - unit events (applications, acceptance, promotions, removal, upgrades, disbanding)
  - unit wars (declared, won, lost, drawn)
  - medals awarded
  - bounties (posted on you, collected on you, your bounty collected or refunded)
  - basic training steps and graduation
- **The bell** in the header shows the unread count. `/notifications` lists the latest 50 (each inbox keeps up to 200) and marks them read when you view it.
- **Live updates:** while a game page is open and visible, the browser polls `/notifications/poll?after=<id>` every 20 seconds. New items appear as pop-ups, and the stat bar refreshes so health and cash changes show immediately.
- **The combat feed** on HQ shows the latest fights across the whole game.

`src/notify.js` builds promotion and unlock messages. To add a new type, call `players.notify(userId, kind, message, link)` and give the kind an icon and colour in `views/notifications.ejs` and `main.css`. If it should reach players' phones, map the kind to a push category in `KIND_CATEGORY` in `src/push.js`.

- **Clear all** on the notifications page deletes every notification you have (after a confirm). Other players' notifications aren't touched.

## Installable app and push alerts

**Profile › Alerts** (`/account/alerts`, also linked from the Notifications page) is where players set this up.

- **Installable app:** `public/manifest.webmanifest`, icons in `public/icons/`, and a service worker (`public/sw.js`). Chrome, Edge and Android show an **Install app** button. On iPhone and iPad the page explains Share › Add to Home Screen. Installed, the game opens full screen with its own icon.
- **Service worker:** served by the app at `/sw.js` with `Cache-Control: no-cache` and the asset version filled in, so it updates with every release. It never caches game pages. When there's no connection it shows `public/offline.html`, which reloads itself once you're back online.
- **Push alerts** reach a phone or computer even with the game closed. Players turn them on per device and choose categories:
  - chat mentions, private messages, attacks, bounties, deployments, unit and wars, events and announcements (on by default once a player enables alerts);
  - energy full and progress (off by default).
  - Optional quiet hours in the player's own time zone.
  - Nothing is pushed while the player has the game open in front of them (a visible tab told the server within the last 50 seconds). Pushes are capped at 30 per player per hour, and a newer alert of the same kind replaces an older undelivered one.
  - Every `players.notify()` call goes through `src/push-service.js`; private messages and "energy full" (checked every 2 minutes, once per refill) are sent from there directly. Event launches and admin announcements go to everyone who wants "Events and announcements".
- **Keys:** the server's VAPID key pair is generated on first use and kept in the `app_keys` table, so nothing needs configuring. Push services are given a contact address: `PUSH_CONTACT` if set (a `mailto:` or `https://` URL), otherwise `mailto:` plus `LEGAL_CONTACT_EMAIL`.
- **Safety:** the server only sends to the browsers' real push services (Google, Mozilla, Apple, Microsoft), so a forged subscription can't make it call other addresses. Subscriptions the push service reports as gone (404/410) are deleted. Each player keeps at most 10 devices.

iPhone and iPad support push only from the installed app (iOS 16.4 and later), so players there add the game to their Home Screen first.

## Combat system (built for PvP)

All combat maths lives in `src/combat.js` and is shared by missions now and PvP later. Every bonus is a **modifier** on a stat (`attack`, `damage`, `critChance`, `critDamage`, `armor`):

```js
{ stat: 'damage', kind: 'increased', value: 0.10 }   // +10% damage
```

Modifiers of the same stat combine as:

```
final = (base + Σ flat) × (1 + Σ increased) × Π (1 + more)
```

- **flat** adds to the base (+12 attack).
- **increased** bonuses are summed, then applied once. Two +10% bonuses give ×1.20.
- **more** bonuses each multiply. Two ×1.10 bonuses give ×1.21. Keep these rare.

A hit is `attack × damage × variance(±10%) × critDamage (on a crit) × (1 − mitigation)`, where `mitigation = armour / (armour + 100)`, capped at 75%. `CONTEXT_MULTIPLIERS.pvp` scales all PvP damage in one place for balancing. `rollHit(attacker, defender)` is ready for a PvP attack route.

To add a new source of bonuses (training, buffs, perks), produce modifiers and pass them to `buildStats` alongside the gear modifiers. Items live in `src/items.js`.

## Casino

The **Casino** (`/casino`, in the main menu and under More on phones) is a lobby of games played only with in-game cash. Bets come from the cash a player carries, never the bank, and nothing can be bought or won with real money.

### Slot machine

`/casino/slots`: three reels, one line, six military symbols. A spin pays the best of:

| Line | Pays |
|---|---|
| Three Stars (jackpot) | 100× |
| Three Crests / Cash / Rifles / Helmets / Targets | 40× / 20× / 12× / 8× / 5× |
| Two Stars anywhere | 5× |
| Two of a kind from the left: Crests / Cash / Rifles / Helmets / Targets | 5× / 3× / 2× / 2× / 1.5× |
| One Star anywhere | 1.5× |

- Reels pick symbols by weight with a cryptographic random number generator on the server. Over every possible line the machine pays back **94.9%** of bets, about one spin in 3 pays more than the bet, and 20× or more hits about once every 257 spins. So it slowly takes cash out of the game.
- Bets go from $10 to the maximum (default $10,000), and only one spin every 0.8 seconds.
- With JavaScript the reels spin in place; without it, the form posts and the page shows the result.
- Each spin is one ledger entry with the net result (reason `casino-slots`) and a row in `casino_plays`, kept for 30 days. The page shows the player's last 24 hours, their recent spins and the week's big wins (20× and up).
- Admins: **Game settings › Casino** has *Casino open*, *Casino minimum level* (default 3) and *Slot machine maximum bet*. Admin › Economy shows the casino's take under `casino-slots`.
- Rules and maths: `src/slots.js`. Bets and history: `src/casino-service.js`. Adding a game: add it to `GAMES` in `src/routes/casino.js`.


### Roulette

`/casino/roulette`: a European wheel (one zero, 37 pockets) and a full table.

- **Bets:** single numbers 0–36 pay 35 to 1; dozens and columns pay 2 to 1; Red/Black, Odd/Even, 1–18/19–36 pay 1 to 1. Winning bets get their stake back too, and zero loses every outside bet. Every bet pays back exactly 36/37 = **97.3%** over time.
- **Playing:** pick a chip ($10 to $5,000), tap places on the table to stack chips (up to 20 places, at least $10 on each), then Spin. Undo, Clear and Rebet (the last spin's bets) help. The wheel turns and stops with the winning pocket under the pointer; winning places light up and your last 12 numbers show under the wheel.
- **Without JavaScript:** type an amount and tap a place on the table: it bets that much there and spins.
- The wheel is spun on the server with a cryptographic RNG; the animation only shows the result. Each spin is one ledger entry (`casino-roulette`) with the net result.
- Admins: **Game settings › Casino › Roulette table limit** (default $10,000 in total per spin). The casino's open switch and minimum level apply too.
- Rules: `src/roulette.js`. Spins: `spinRoulette` in `src/casino-service.js`.

### Blackjack (multiplayer)

`/casino/blackjack`: three tables, each with five seats, where players sit together and each play their own hand against a shared dealer.

| Table | Bets per hand |
|---|---|
| Mess Hall | $10 to $500 |
| Officers’ Lounge | $100 to $5,000 |
| War Room | $1,000 to the casino's blackjack limit (default $25,000) |

- **A round:** sit in a free seat and bet. The first bet opens a 15-second betting window (it closes early once everyone seated has bet). Cards are dealt, and players act in seat order with 20 seconds each: Hit, Stand, Double (any first two cards), or Split a pair once. Run out of time and the hand stands. The dealer then plays and everyone is paid. Results stay up for 6 seconds before the next round.
- **House rules:** six decks reshuffled at half the shoe (so card counting gives no real edge); the dealer checks for blackjack under an ace or ten, draws to 16 and stands on all 17s; blackjack pays 3 to 2; split aces get one card each, and 21 after a split isn't blackjack.
- **Live table:** everyone sees each other's cards, bets, turns and results. With JavaScript the page checks for changes every second and actions happen in place; without it, every button is a normal form and you refresh to see others' moves.
- **Seats:** one table at a time. Leaving before the deal refunds your bet; leaving mid-round stands your hands and still pays what they win. Players who stop looking at the table for 2 minutes, or sit out 5 rounds in a row, are stood up between rounds.
- **Money and fairness:** the shoe lives only on the server (cryptographic shuffle) and the dealer's hole card isn't sent until the dealer plays. Bets, doubles and splits take cash at once and wins are paid at the end, all through the ledger as `casino-blackjack`. Each player's round is a row in `casino_plays`. Everyone plays the house, never each other, so tables can't be used to pass money between accounts.
- **Restarts:** each table's state is saved after every change (`blackjack_tables`), so a restart picks up mid-round and deadlines that passed while it was down are applied.
- Admins: **Game settings › Casino › Blackjack maximum bet** sets the War Room limit; the casino's open switch and minimum level apply too.
- Rules: `src/blackjack.js`. Tables: `src/blackjack-service.js`. The table markup is one partial, `views/partials/bj-table.ejs`, used for the page, each poll and each action.

### Limits and breaks

`/casino/limits` (linked from the lobby): limits players set for themselves. HQ can't lift them early.

- **Daily loss limit:** the most a player can lose in any 24 hours, across every game. Wins in that time count against losses, and blackjack bets count until the hand is paid. A bet, double or split that would go past the limit is refused, and blackjack doesn't offer a double or split it would block. Lowering a limit works at once; raising or removing it takes 24 hours (and can be called off meanwhile).
- **Take a break:** 24 hours, 7 days or 30 days with every game closed to them. It can be made longer but not shorter. Taking one stands them up from a blackjack table (a hand already dealt plays out and is paid).
- Admin › Casino shows how many players have a limit and how many are on a break.
- Code: `src/casino-player.js`, shared by every game.

### Big wins in chat

A casino win of at least $10,000 after the bet is announced in **Global** chat ("Viper won $99,000 at the slot machine with a 100× jackpot!"). Announcements look different from messages, don't count as unread, and don't use up the winner's chat cooldown. The winner and admins can delete them. **Game settings › Casino › Big-win shout in chat** sets the amount; 0 turns them off.

## Help & support

Players open tickets with HQ Support at `/support` (in the phone menu under More, and in every page footer).

- **Opening a ticket:** pick a category (account, bug, gameplay question, report a player, units/raids/map, something else), a subject and a message written with the formatting editor. Up to 3 open tickets at once and 5 new ones a day; a failed send keeps what they wrote.
- **The conversation:** HQ replies show as **HQ Support · admin name**. The player gets a notification (and a push alert under *Messages and support*), and the ticket shows **New reply** until they read it. Replying reopens a closed ticket. Players can close their own tickets.
- **Statuses:** *Waiting for HQ* (open), *HQ replied* (answered) and *Closed*. A ticket HQ answered closes itself after a week without a reply, and the player is told.
- **Admin › Support** (`/admin/support`): the queue by status (oldest waiting first), with a count in the admin menu, and an "only mine" filter. On a ticket:
  - reply (optionally closing it), or add an **internal note** only admins see;
  - assign it to an admin, close without replying, or reopen;
  - see the player's level, a link to their admin page, and their other tickets.
- **Push alerts for admins:** every admin is told in-game about new tickets and player replies; once a ticket is assigned, only its assignee is. Admins also get a push alert on devices where they've turned alerts on (outside quiet hours, and not while they're in the game). It has its own switch at the top of Admin › Support, separate from the player alert categories.
- Rules: `src/support.js`. Storage, alerts and auto-close: `src/support-service.js`.

## Performance

`npm run bench` builds a 20,000-player test database (in `data/bench/`, separate from the real game), starts the game in production mode and fires the busiest pages and polls at it, 50 requests at a time. It prints requests per second and response times per page. Options: `--players`, `--concurrency`, `--seconds`.

On one CPU core with 20,000 players and millions of rows of history it handles about **340–370 requests a second** (it was 73 before the work below). An online player makes roughly one request every 5 seconds (polls plus page views), so one game process serves well over a thousand players online at once.

What keeps it fast:

- **SQLite settings:** WAL with `synchronous = NORMAL` (a power cut can lose the last moment of play, never corrupt the database), a 64 MB page cache, memory-mapped reads and in-memory temp tables.
- **Indexes for the hot queries:** chat polls look up deleted messages through a tiny partial index instead of reading the whole channel, and the anti-cheat ledger audit adds up money from a covering index. The 6-hourly scan, which pauses the game while it runs, went from about 4 seconds to 0.35 at this size.
- **Short caches:** leaderboard rankings and unit rankings are worked out at most once a minute. Names, avatars and online status are always fresh.
- **Fewer writes:** a session's rolling expiry is saved at most every 10 minutes instead of on every request, and the anti-cheat scan writes its flags in one transaction.
- Page URLs skip the static-file check; CSS, JS and icons are cached by browsers and Cloudflare for a week.

Next steps if it ever needs more: compress responses in nginx instead of Node, and run several game processes over the same database (the background jobs would need to run in just one of them).

## Project layout

```
src/
  server.js          app factory + entry point
  game.js            pure game rules (missions, regen, levelling, ranks)
  players.js         SQLite data access
  db.js              schema + connection
  session-store.js   express-session store on SQLite
  middleware.js      security headers, CSRF, flash messages, rate limiting
  routes/auth.js     register / login / logout
  routes/game.js     HQ, missions, hospital, online list, profiles
  presence.js        online/last-seen rules
  combat.js          stats, modifiers, damage & armour maths (shared with PvP)
  items.js           armory catalogue
  armory.js          purchase/equip rules and loadout views
  vehicles.js        motor pool: vehicle catalogue, bonuses and wear
  vehicle-service.js owned vehicles, buying, repairs, selling, wear
  workshop.js        materials, drops, upgrade recipes and salvage
  workshop-service.js materials held, upgrades and salvage
  service-record.js  the career page and its milestones
  contracts.js       contract rules: terms, who can post and take them
  contract-service.js escrow, progress from PvP wins, expiry
  special-ops.js     special operations: openings, stages, approaches
  special-op-service.js runs, rewards and captured vehicles
  market.js          market rules: price ranges, fees, who can trade
  market-service.js  listings held in escrow, buying, returns
  routes/armory.js   armory pages and actions
  pvp.js             attack rules, fight simulation, rewards
  routes/pvp.js      attack + battle reports
  routes/hospital.js hospital ward, treatment, early discharge
  notify.js          promotion & unlock notifications
  bank.js            deposit/withdraw rules (fee, parsing amounts)
  training.js        stats, session costs, caps, combat modifiers
  scouting.js        scouting cost and intel reports
  daily.js           daily order + supply drop rules (pure)
  daily-service.js   daily orders storage, progress and claims
  routes/daily.js    claim orders, commendation and supply drop
  units.js           unit rules: names, roles, upgrades, requirements (pure)
  wars.js            unit war rules: declaring, scoring, settling (pure)
  medals.js          medal list, tiers, progress (pure)
  bounties.js        bounty rules: amounts, fees, who can post/collect (pure)
  tutorial.js        basic training steps and rewards (pure)
  operations.js      three-stage operations (pure)
  operation-service.js operation progress, payouts, cooldowns
  supplies.js        consumables: adrenaline, stims (pure)
  perks.js           officer rank perks (pure)
  events.js          world event types and effects (pure)
  base.js            forward base facilities, costs, perks (pure)
  base-service.js    builds: start, cancel, finish on time
  routes/base.js     forward base page and actions
  deployments.js     offline patrols: pay, cap, outcomes (pure)
  deployment-service.js start, recall, return on time
  routes/deployments.js deployments page and actions
  tuning.js          admin game settings: registry, defaults, live values
  settings-service.js game settings storage, history, anti-cheat window
  routes/settings.js Admin › Game settings page
  titles.js          earnable titles shown under callsigns (pure)
  avatars.js         avatar badge parts, unlocks and SVG drawing (pure)
  images.js          checks uploaded pictures and strips their metadata (pure)
  multipart.js       reads file-upload forms
  avatar-service.js  avatar storage, uploads, reports
  objectives.js      weekly unit objectives: types, targets, rewards (pure)
  objective-service.js unit objective progress, completion payouts
  target.js          daily high-value target rules and bonuses (pure)
  target-service.js  picks the daily target, pays bonuses after fights
  push.js            push alert categories, preferences, quiet hours, allowed push services (pure)
  push-service.js    push subscriptions, VAPID keys, sending alerts, energy-full check
  routes/alerts.js   App & alerts page, subscribe/unsubscribe, test alert
  routes/avatars.js  avatar images, the builder, uploads, admin moderation
  chat.js            chat rules: channels, limits, mentions, mutes (pure)
  chat-service.js    chat storage, history, live polling, reports, mutes
  routes/chat.js     chat pages, posting, polling, admin moderation
  seasons.js         PvP season rules: rating, divisions, rewards (pure)
  season-service.js  seasons storage, ranked fights, payouts, rollover
  routes/seasons.js  season page, past results, admin end
  event-service.js   event scheduling, live effects, announcements
  routes/events.js   events page and admin scheduling
  bbcode.js          safe BBCode → HTML renderer
  messages.js        private message rules (pure)
  message-service.js conversations, blocks, reports
  routes/messages.js inbox, compose, threads, block, report
  routes/format.js   shared BBCode preview for every editor
  tutorial-service.js detects steps, pays rewards, hide/show
  bounty-service.js  bounty storage, claiming in fights, expiry refunds
  routes/bounties.js bounty board and posting
  medal-service.js   career metrics, awarding, pins
  routes/medals.js   medal case and pinning
  war-service.js     unit wars storage, fight scoring and settling
  units-repo.js      units, applications, board and unit log storage
  routes/units.js    unit list, unit page and all unit actions
  routes/training.js training page and sessions
  leaderboards.js    ranked boards (window-function queries)
  routes/leaderboards.js, routes/account.js
  routes/bank.js     bank page and actions
  admin.js           admin changes (cash, level, restore) with validation
  admin-repo.js      admin queries, bans, audit log
  routes/admin.js    admin pages and actions
  anticheat/rules.js thresholds and verdicts (pure, easy to tune)
  anticheat/index.js sign-in tracking, linking, flags, scans, reversals
scripts/admin.js     grant/revoke admin from the command line
  routes/notifications.js  inbox page + polling endpoint
views/               EJS pages + partials
public/              CSS, JS, favicon
test/                node:test suites
```

## Phone menu

On screens up to 640px wide, the header menu gives way to an app-style **bottom tab bar**:
- **Tabs:** HQ, Missions, Armory, Players and More. The active tab glows orange.
- **More sheet:** More slides up a sheet of tiles for everything else (Training, Deployments, Unit, Bank, Hospital, Base, Rankings, Events, Profile, and Admin for admins). Sign out lives there too.
- **Badges:** tiles show Away, In or Live while you're deployed, in hospital or an event is running, and a dot on More tells you something's up.
- **Header:** on phones it keeps just the logo, messages and notifications.
- **Without JavaScript:** the sheet is a plain `<details>` element, so it still opens and closes. JavaScript adds closing on Escape or a tap outside.

The markup is in `views/partials/tabbar.ejs`.

## Pages

- `/`: landing page
- `/terms`: Terms of Service (public); `/terms/accept` when a player must accept a new version
- `/register`, `/login`: account forms (registration requires confirming you are 18+)
- `/hq`: dashboard with basic training (for new players), service record, next mission, daily orders, supply drop streak, readiness (live regen timers), field hospital and radio log
- `/missions`: operations board. Launching a mission uses `fetch` and updates stats in place, and falls back to a normal form post without JavaScript.
- `/players`: directory of all players. Search by callsign, filter to **Targets** (players you can attack right now) or **Online now**, and sort by level, PvP wins, newest or name, 25 per page. Each row shows rank, level, combat rating, PvP record and status, with an Attack button or the reason you can't attack.
- `/online`: every player active in the last 5 minutes, sorted by level. Signing out removes you from the list straight away.
- `/profile/:username`: a player's public service record, showing rank, level, online status or last seen, enlistment date, mission stats and recent operations. Email, cash, energy, health and hospital visits stay private.
- `/armory`: your combat profile, loadout and inventory: everything you own, grouped by slot, with Equip and Stow. Other players can see your loadout on your profile.
- **Gear condition:** every owned item has a condition from 0 to 100%. Equipped gear wears as you fight (inventory gear never does):

  | Action | Weapon | Kit | Body armour | Helmet |
  |---|---|---|---|---|
  | Mission (won) | 0.5 | 0.25 | – | – |
  | Mission (failed) | 0.5 | 0.25 | 1 | 1 |
  | PvP attack | 1 | 0.5 | 1 | 1 |
  | Defending in PvP | 0.5 | – | 1 | 1 |
  | Raid strike | 1 | 0.5 | 0.5 | 0.5 |

  Above 50% gear works at full power; below that its bonuses shrink, to half at 0%, so worn gear is weaker but never useless. Players are told when an item drops below 50% and 15%, and the loadout flags worn gear. Reserve soldiers' gear doesn't wear.
- **Repairs** bring an item back to 100% for 30% of its price × the condition lost (a rifle at 50% costs 15% of its price), one at a time or everything at once (ledger reason `armory-repair`). They're a cash sink: `npm run balance` puts them at about 3–15% of a player's income, depending on how much they play.
- **Selling:** the Armory buys gear back for 40% of its price in perfect condition, less when worn (half that at 0%); equipped gear can be sold too (ledger reason `armory-sale`). Sold gear can be bought again, good as new.
- Game settings › Armory has *Gear wear* (0 turns it off), *Repair cost* and *Sale price*. Rules: `src/gear.js`.
- `/armory/shop/weapons`, `/armory/shop/armour`, `/armory/shop/helmets`, `/armory/shop/kit` and `/armory/shop/supplies`: the shops, one per gear slot plus supplies. A menu across the top of every Armory page switches between the inventory and the shops. Buying an item equips it and brings you back to the same shop; new-gear notifications link straight to the right shop.
- `/armory/motor-pool`: the **motor pool** (last tab of the Armory menu). Players own as many vehicles as they like and take one out at a time; buying one takes it out if nothing else is. Three classes of five, from level 3 to 95, each helping in a different part of the game. **None change PvP**, so fights stay about the soldier:

  | Class | Vehicles (level) | Bonus |
  |---|---|---|
  | **Light vehicles** | Trail Bike (3), Patrol Jeep (10), Recon Buggy (25), Armoured Scout Car (45), Stealth Rover (75) | +3% to +8% mission and operation success chance |
  | **Transports** | Utility Pickup (5), Supply Truck (15), APC (32), Heavy MRAP (55), Hover Transport (85) | +4% to +12% mission and operation pay, +10% to +30% deployment pay |
  | **Armour** | Light Tank (12), IFV (28), Main Battle Tank (45), Heavy Assault Tank (70), Siege Walker (95) | +6% to +22% damage on unit raid strikes |

  Pay bonuses join the rank-perk and unit bonuses before events and admin settings multiply them, and anti-cheat's mission pay limits allow for the best transport a player could have. The vehicle taken out wears like gear (0.15 points a mission, 0.3 on a failed one, 0.5 a raid strike, 0.2 per deployed hour) and loses bonus below 50%, to half at 0%; players are told at 50% and 15%. Repairs and sales use the gear prices (ledger reasons `vehicle`, `vehicle-repair`, `vehicle-sale`). `npm run balance` shows each vehicle paying for itself in about 1–3 months of full play at its unlock level, faster later. The bike or truck shows on the Missions page, the transport on Deployments, the armour on the raid card, and the vehicle on the player's profile. Admins give or take vehicles in the Gear and vehicles card of a player's admin page (audit-logged), and Game settings › Armory has *Vehicle bonuses* and *Vehicle wear*. Rules: `src/vehicles.js`; service: `src/vehicle-service.js`.
- `/armory/workshop`: the **workshop** (last tab of the Armory menu). Materials turn up on won missions (worth about 12% of the pay), completed operations (30% of the bonus, rich in cores) and deployments (8%), rounded at random so small amounts still appear sometimes. Four kinds: *Scrap metal*, *Circuit boards* (weapons, kit, light vehicles), *Composite plating* (armour, helmets, transports, tanks) and rare *Prototype cores* (Mk II and up).
  - **Upgrades:** gear goes from Mk I to Mk III, +5% to all its stats per level (so it counts in PvP too); vehicles +10% to their bonus per level. Mk n costs materials worth 8% × n of the item's price plus a 4% × n cash fee (ledger reason `workshop`), so the effort is the same at every level. `npm run balance` puts a full loadout at Mk III at about a month of materials.
  - **Salvage:** break down gear or a vehicle for materials worth 20% of its price (less when worn) plus half the materials its upgrades took, instead of selling it for cash. Upgrades are lost when an item is sold.
  - Materials can't be traded, sold or given, so they never pass value between accounts. Reserve soldiers find none. The *Master Mechanic* medal counts upgrades (1 / 10 / 40).
  - Upgrades show as a Mk tag in the Armory, the loadout, profiles and the motor pool. Admins see a player's materials and give or take them on the player's admin page (audit-logged). Game settings › Armory has *Workshop material drops* and *Upgrade cost*. Rules: `src/workshop.js`; service: `src/workshop-service.js`.
- `/profile/:name/record`: the **service record**, linked from every profile. A soldier's career on one page: service (enlisted, days on duty, rank, medals, titles, orders, best streak), missions and operations (won, failed, success rate, operations completed, deployments and hours deployed), combat (PvP wins and losses, longest winning streak attacking or defending, biggest haul linking to its battle report, bounties, seasons and best finish), unit service (wars, war points, raids joined and won, strikes, damage) and the motor pool and workshop. A **milestones** timeline lists new ranks, medals, titles, the first PvP win and first vehicle, newest first. Like the medals, PvP records only count fights that paid XP and weren't reversed, so farming linked accounts builds nothing. Soldiers see an extra private card on their own record: earnings by source, PvP takings, raid loot, casino betting and their training. Code: `src/service-record.js`.
- `/armory/market`: the **market** (last tab of the Armory menu). From level 5, players sell gear, vehicles and workshop materials to each other; wear and workshop upgrades go with the item.
  - A listed thing leaves the seller (equipped gear comes off, the vehicle taken out is parked) and is held until it sells, the seller withdraws it, or **3 days** pass. If they've bought another of the same since, the Armory buys the returned one at its usual price instead.
  - **Prices** must be between what the Armory pays for the item and 1.5× its shop price (+25% per upgrade level); materials between 0.5× and 3× their worth. That keeps a cheap sale from handing a friend much value.
  - **Fees:** listing costs 2% (at least $10) and sales are taxed 5%, both destroyed (Game settings › Economy: *Market listing fee*, *Market sales tax*). Ledger reasons `market-fee`, `market-buy`, `market-sale`, `market-return`.
  - Buyers need the item's level, can't already own one, and can't trade with accounts that share their device or network. Up to 10 listings per seller. Sellers are told when something sells; the page shows recent sales for pricing. Rules: `src/market.js`; service: `src/market-service.js`.
- `/updates`: **patch notes**, public (linked in the footer and allowed in `robots.txt`). Admins write them on **Admin › Patch notes** (`/admin/updates`) with the formatting editor, and can edit or delete them (audit-logged). HQ shows "New update: …" until a player opens the page; players who signed up after a note never see a notice for it. Code: `src/patch-notes.js`, `src/routes/updates.js`.
- `/hospital`: your status, with treatment or early discharge, and everyone currently on the ward
- `/battles/:id`: round-by-round battle report
- `/notifications`: your notification history; unread items are highlighted
- `/bank`: cash on hand vs banked, deposit and withdraw (with "All" and a live fee preview), and recent transactions
- `/units`: every unit ranked by strength, with search, your applications and the form to found a unit
- `/units/:id`: a unit's page showing its roster and upgrades, plus (for members) the treasury, board and unit log, and (for the Commander) settings and command
- `/bounties`: the most wanted list, recent collections, your bounties and the posting form
- `/account/profile`: edit your profile bio
- `/account/avatar`: build a badge or upload a picture as your avatar
- `/messages`: inbox; `/messages/new`, `/messages/:id` (conversation), `/messages/blocked`
- `/base`: your forward base
- `/chat`: live game chat (Global, plus your unit's channel); `/admin/chat` for reports and mutes
- `/seasons`: the current PvP season (your division, standings, rewards, past seasons); `/seasons/:n` for a past season's final results
- `/deployments`: send your soldier on patrol, recall early, read after-action reports
- `/events`: live, upcoming and recent events; `/admin/events` to schedule them
- `/medals`: your medal case, with progress, rarity and pins
- `/wars`, `/wars/:id`: unit wars list and war room
- `/training`: train Strength, Agility and Endurance; see your true combat profile and which missions favour each stat
- `/scout/:username` (POST): buy intel on a player; the report appears on their profile for you only
- `/leaderboards`: Top soldiers (level, XP), PvP wins, Missions won and This week (XP in the last 7 days). Shows the top 50 with your position pinned if you're further down. No cash, bank or training boards; suspended players are left out.
- `/account/password`: change your password (needs your current one; signs out your other devices). Players with an admin-issued temporary password are sent here until they set a new one.
