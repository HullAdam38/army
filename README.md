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
| **Cash** | Earned from successful missions. Spend it in the Armory or at the field hospital ($2 per HP). |
| **Gear** | Four slots (weapon, body armour, helmet, tactical kit). Gear raises your combat rating, which adds up to +15% mission success, and armour reduces failure damage. |

There are six missions, unlocking at levels 1, 1, 3, 5, 8 and 12. Success chance rises 1% for each level above the mission's minimum and drops 10% while you're below half health. A failed mission still grants 25% XP.

Regeneration is calculated lazily from timestamps, so no background jobs are needed. All game rules live in `src/game.js` as pure functions.

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
views/               EJS pages + partials
public/              CSS, JS, favicon
test/                node:test suites
```

## Pages

- `/`: landing page
- `/register`, `/login`: account forms (registration requires confirming you are 18+)
- `/hq`: dashboard with service record, next orders, readiness (live regen timers), field hospital and radio log
- `/missions`: operations board. Deploying uses `fetch` and updates stats in place, and falls back to a normal form post without JavaScript.
- `/online`: every player active in the last 5 minutes, sorted by level. Signing out removes you from the list straight away.
- `/profile/:username`: a player's public service record, showing rank, level, online status or last seen, enlistment date, mission stats and recent operations. Email, cash, energy, health and hospital visits stay private.
- `/armory`: your combat profile and loadout, plus the gear catalogue. Buying an item equips it; you can stow items or swap between owned ones. Other players can see your loadout on your profile.
