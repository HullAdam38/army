# EliteForces

A text-based military strategy game for players aged 18+. You enlist, spend energy on missions, earn XP and cash, get promoted through 18 ranks, and patch up your wounds at the field hospital.

## Stack

- **Server:** Node.js (22.13+) and Express 5, with EJS server-rendered views
- **Data:** SQLite through Node's built-in `node:sqlite` module, so nothing needs compiling on install. Players, the activity log and sessions are all stored in one file.
- **Auth:** bcrypt password hashes (cost 12), session cookies (`httpOnly`, `sameSite=lax`, `secure` in production), a new session ID on login, CSRF tokens on every POST, and IP rate limiting on login and register
- **Frontend:** hand-written CSS with design tokens (no build step) and a small vanilla JS file for progressive enhancement. Every page works without JavaScript.
- **Fonts:** Saira Stencil One (display), Chakra Petch (UI and headings), Barlow (body)

## Getting started

### Linux Mint / Ubuntu / Debian (one command)

```bash
git clone -b claude/determined-keller-i7bgjo https://github.com/HullAdam38/army.git eliteforces
cd eliteforces
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
- search players by callsign or email
- adjust cash, set level, restore energy and health, or release from hospital
- message a single player
- suspend or unsuspend a player (signs them out immediately)
- **reset a password:** issues a temporary password like `K7QF-M2XP-9TRA`, shown once and valid for 24 hours. The player is signed out everywhere and must choose a new password at their next sign-in. Admin accounts can't be reset from the website.

Every change is recorded in the audit log with a reason.

### Anti-cheat

- **Accounts used on the same device get no PvP rewards from each other.**
- **Repeat wins on the same player pay less:** half from the 3rd win in 24 hours, nothing from the 5th.
- **Every cash and bank change goes into a ledger with a reason**, and a scan every 6 hours checks that balances match it.
- **Bot-like timing** (clockwork gaps, no breaks, superhuman speed) and **unusual gains** (more than energy allows, or far above similar-level players) are checked from a 14-day action log.
- **Linked accounts, PvP farming, unexplained money and impossible payouts raise flags** under **Admin → Suspicious activity**, where you can warn, dismiss, reverse farmed cash or suspend.

Nothing is banned automatically. See [SECURITY.md](SECURITY.md#anti-cheat) for the rules and thresholds.

## Game loop

| Resource | How it works |
| --- | --- |
| **Energy** | Starts at 50. +1 every 2 minutes. Each mission costs energy. |
| **Health** | Starts at 100. +1 every minute. Failed missions deal damage, and you can't deploy below 15 HP. |
| **XP / Level** | Level *n* needs `100 × n^1.6` XP. Each level-up adds +5 max energy and +10 max health and refills both. |
| **Rank** | Changes every 2 levels, from Recruit (E-1) to General (O-10). |
| **Cash** | Earned from successful missions. Spend it in the Armory or at the field hospital ($2 per HP). Only cash on hand can be taken in PvP. |
| **Bank** | Money in the bank is safe from attacks. Deposits cost 2% (minimum $1); withdrawals are free. There's deliberately **no interest**, so the bank never creates money. Balances are private. |
| **Gear** | Four slots (weapon, body armour, helmet, tactical kit). Gear raises your combat rating, which adds up to +15% mission success, and armour reduces failure damage. |

There are six missions, unlocking at levels 1, 1, 3, 5, 8 and 12. Success chance rises 1% for each level above the mission's minimum and drops 10% while you're below half health. A failed mission still grants 25% XP.

Regeneration is calculated lazily from timestamps, so no background jobs are needed. All game rules live in `src/game.js` as pure functions.

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
| Apply to or join a unit | $250 · 30 XP |
| Win a PvP fight (one that paid XP) | $300 · 40 XP |

- **Graduation:** finishing every step pays a **$500 + 100 XP** graduation bonus, and the checklist then disappears for good.
- **Hiding:** players can hide the checklist. HQ then shows a "Show basic training (n/8)" link to bring it back.
- **Notifications and the ledger:** each step sends a notification, and all rewards go through the ledger as `tutorial`.
- **Players who started before this update:** they get the steps they've already done ticked off and paid at once the next time they open HQ.

Rules live in `src/tutorial.js`; detection and payouts are in `src/tutorial-service.js`. `createApp({ tutorial: false })` turns tutorial rewards off, which tests of other systems use so their cash checks stay exact.

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

## Daily orders and supply drops

- **Daily orders:** three orders each UTC day, picked to fit your level. They might be "Complete 4 missions", "Complete Convoy Escort twice", "Earn $580 from missions", "Win a PvP fight", "Train 3 sessions" or "Scout another player". PvP and scouting orders only appear from level 3.
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
- **Application settings (Commander):** turn applications on or off, and set minimum **level**, **PvP wins** and **missions won** to apply. Requirements show on the unit profile and in the unit list, and players who fall short are told exactly what's missing.
- **Unit profile** (`/units/:id`) is public:
  - founding date and Commander
  - strength, members, war record (W–L–D), combined PvP wins and missions, mission XP bonus
  - application status and requirements
  - roster, upgrades and war history
- **Roles:** the **Commander** promotes and demotes officers, removes anyone, edits settings, spends the treasury, hands over command (type the callsign to confirm) and can disband the unit (type the tag). **Officers** review applications and remove members. Everyone can post on the **unit board**, which only members can read and which allows one post per 10 seconds.
- **No friendly fire:** members can't attack each other, and the Targets filter hides them.
- **Treasury:** members donate cash, which goes through the ledger as `unit-donation`. Only upgrades can spend it; it **never pays out to players**, so it can't be used to move money between accounts.
  - **Barracks:** 10 members, +5 per level, up to 3 levels ($5k, $15k, $40k).
  - **Drill ground:** +2% mission XP for every member per level, up to 5 levels ($3k to $90k).
- **Leaving** starts a 12-hour wait before you can join or found another unit. A Commander has to hand over command first; if they're the last member, leaving disbands the unit.
- **Rankings:** units are ranked by strength, the total level of their non-suspended members. `/units` lists them with search.
- **Moderation:** admins see an Admin box on every unit page to rename or disband it. Both actions are written to the admin audit log and members are notified.

Rules live in `src/units.js`; data access is in `src/units-repo.js`.

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

## Medals

Eleven medals, each with **Bronze, Silver and Gold** tiers. Each tier pays once: Bronze +50 XP and $250, Silver +150 XP and $1,000, Gold +400 XP and $5,000. Every payout goes through the ledger as `medal`.

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
| Victory Medal | unit wars won (as a member from the start of the war) | 1 / 5 / 20 |

- **Awarding:** medals are checked after every action, and when you open HQ or the medal case, so things that happened while you were away (defences, war wins) are caught too. Each new medal arrives as a notification.
- **Farming protection:** PvP medals only count fights that paid XP and weren't reversed by an admin, so wins against linked alt accounts earn nothing.
- **Where they show:** `/medals` is your medal case, with progress to the next tier and the share of players holding each tier. Pin up to 3 medals to feature them at the top of your profile. Profiles show every medal a soldier holds.

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

`src/notify.js` builds promotion and unlock messages. To add a new type, call `players.notify(userId, kind, message, link)` and give the kind an icon and colour in `views/notifications.ejs` and `main.css`.

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
  bbcode.js          safe BBCode → HTML renderer
  messages.js        private message rules (pure)
  message-service.js conversations, blocks, reports
  routes/messages.js inbox, compose, threads, preview, block, report
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

## Pages

- `/`: landing page
- `/terms`: Terms of Service (public); `/terms/accept` when a player must accept a new version
- `/register`, `/login`: account forms (registration requires confirming you are 18+)
- `/hq`: dashboard with basic training (for new players), service record, next mission, daily orders, supply drop streak, readiness (live regen timers), field hospital and radio log
- `/missions`: operations board. Deploying uses `fetch` and updates stats in place, and falls back to a normal form post without JavaScript.
- `/players`: directory of all players. Search by callsign, filter to **Targets** (players you can attack right now) or **Online now**, and sort by level, PvP wins, newest or name, 25 per page. Each row shows rank, level, combat rating, PvP record and status, with an Attack button or the reason you can't attack.
- `/online`: every player active in the last 5 minutes, sorted by level. Signing out removes you from the list straight away.
- `/profile/:username`: a player's public service record, showing rank, level, online status or last seen, enlistment date, mission stats and recent operations. Email, cash, energy, health and hospital visits stay private.
- `/armory`: your combat profile and loadout, plus the gear catalogue. Buying an item equips it; you can stow items or swap between owned ones. Other players can see your loadout on your profile.
- `/hospital`: your status, with treatment or early discharge, and everyone currently on the ward
- `/battles/:id`: round-by-round battle report
- `/notifications`: your notification history; unread items are highlighted
- `/bank`: cash on hand vs banked, deposit and withdraw (with "All" and a live fee preview), and recent transactions
- `/units`: every unit ranked by strength, with search, your applications and the form to found a unit
- `/units/:id`: a unit's page showing its roster and upgrades, plus (for members) the treasury, board and unit log, and (for the Commander) settings and command
- `/bounties`: the most wanted list, recent collections, your bounties and the posting form
- `/messages`: inbox; `/messages/new`, `/messages/:id` (conversation), `/messages/blocked`
- `/medals`: your medal case, with progress, rarity and pins
- `/wars`, `/wars/:id`: unit wars list and war room
- `/training`: train Strength, Agility and Endurance; see your true combat profile and which missions favour each stat
- `/scout/:username` (POST): buy intel on a player; the report appears on their profile for you only
- `/leaderboards`: Top soldiers (level, XP), PvP wins, Missions won and This week (XP in the last 7 days). Shows the top 50 with your position pinned if you're further down. No cash, bank or training boards; suspended players are left out.
- `/account/password`: change your password (needs your current one; signs out your other devices). Players with an admin-issued temporary password are sent here until they set a new one.
