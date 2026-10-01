# EliteForces

A text-based military strategy game for players aged 18+. You enlist, spend energy on missions, earn XP and cash, get promoted through 18 ranks, and patch up your wounds at the field hospital.

## Stack

- **Server:** Node.js (22.13+) and Express 5, with EJS server-rendered views
- **Data:** SQLite through Node's built-in `node:sqlite` module, so nothing needs compiling on install. Players, the activity log and sessions are all stored in one file.
- **Auth:** bcrypt password hashes (cost 12), session cookies (`httpOnly`, `sameSite=lax`, `secure` in production), a new session ID on login, CSRF tokens on every POST, and IP rate limiting on login and register
- **Frontend:** hand-written CSS with design tokens (no build step) and a small vanilla JS file for progressive enhancement. Every page works without JavaScript.
- **Fonts:** Saira Stencil One (display), Chakra Petch (UI and headings), Barlow (body)

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000, restarts on file changes
npm test           # unit tests for the game rules plus HTTP integration tests
```

For production:

```bash
SESSION_SECRET="$(openssl rand -hex 32)" NODE_ENV=production npm start
```

See `.env.example` for all settings.

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
  routes/bank.js     bank page and actions
  routes/notifications.js  inbox page + polling endpoint
views/               EJS pages + partials
public/              CSS, JS, favicon
test/                node:test suites
```

## Pages

- `/`: landing page
- `/register`, `/login`: account forms (registration requires confirming you are 18+)
- `/hq`: dashboard with service record, next orders, readiness (live regen timers), field hospital and radio log
- `/missions`: operations board. Deploying uses `fetch` and updates stats in place, and falls back to a normal form post without JavaScript.
- `/players`: directory of all players. Search by callsign, filter to **Targets** (players you can attack right now) or **Online now**, and sort by level, PvP wins, newest or name, 25 per page. Each row shows rank, level, combat rating, PvP record and status, with an Attack button or the reason you can't attack.
- `/online`: every player active in the last 5 minutes, sorted by level. Signing out removes you from the list straight away.
- `/profile/:username`: a player's public service record, showing rank, level, online status or last seen, enlistment date, mission stats and recent operations. Email, cash, energy, health and hospital visits stay private.
- `/armory`: your combat profile and loadout, plus the gear catalogue. Buying an item equips it; you can stow items or swap between owned ones. Other players can see your loadout on your profile.
- `/hospital`: your status, with treatment or early discharge, and everyone currently on the ward
- `/battles/:id`: round-by-round battle report
- `/notifications`: your notification history; unread items are highlighted
- `/bank`: cash on hand vs banked, deposit and withdraw (with "All" and a live fee preview), and recent transactions
