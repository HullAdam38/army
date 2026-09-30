# EliteForces

A text-based military strategy game for players aged 18+. You enlist, spend energy on missions, earn XP and cash, get promoted through 18 ranks, and patch up your wounds at the field hospital.

## Stack

- **Server:** Node.js (20+) and Express 5, with EJS server-rendered views
- **Data:** SQLite through `better-sqlite3`. Players, the activity log and sessions are all stored in one file.
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
| **Cash** | Earned from successful missions. Spend it at the field hospital ($2 per HP). |

There are six missions, unlocking at levels 1, 1, 3, 5, 8 and 12. Success chance rises 1% for each level above the mission's minimum and drops 10% while you're below half health. A failed mission still grants 25% XP.

Regeneration is calculated lazily from timestamps, so no background jobs are needed. All game rules live in `src/game.js` as pure functions.

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
  routes/game.js     HQ, missions, hospital
views/               EJS pages + partials
public/              CSS, JS, favicon
test/                node:test suites
```

## Pages

- `/`: landing page
- `/register`, `/login`: account forms (registration requires confirming you are 18+)
- `/hq`: dashboard with service record, next orders, readiness (live regen timers), field hospital and radio log
- `/missions`: operations board. Deploying uses `fetch` and updates stats in place, and falls back to a normal form post without JavaScript.
