# GeneralForces: notes for working on this codebase

Text-based military browser game. Node 22.13+, Express 5, EJS, SQLite through `node:sqlite`, hand-written CSS. See README.md for features and SECURITY.md for the security model.

## Commands

- `npm run dev`: run locally on http://localhost:3000 (restarts on change)
- `npm test`: the full suite (node:test). Keep it green before every commit.
- `npm run admin -- grant <callsign>`: make an admin
- Deploying: see DEPLOY.md (`deploy/install.sh` once, then `deploy/update.sh`).
- `npm run balance`: simulate three player types for 30 days (levels, income and XP by source), what raids pay against missions, unit treasury income and the casino's house edge. Run it after changing payouts.
- `npm run bench`: load test against a 20,000-player database (requests per second, response times per page). Run it after changing hot pages, polls or queries.

## House rules

### Player-written text is BBCode, edited with the shared editor
Any field where a player writes free text (messages, unit board posts, unit descriptions, applications, profile bios, and any **new** field like these) must:
1. use the editor partial: `<%- include('partials/bb-editor', { id, name, value, max, rows, required, compact, placeholder, label }) %>`. It gives the toolbar, shortcuts, live preview (`POST /format/preview`) and a no-JS fallback. Use `required: false` for optional fields and `compact: true` for short ones. Give each editor on a page a unique `id`.
2. be stored as raw BBCode and rendered with `bbcode.render(text)` from `src/bbcode.js` when shown. Only ever output that function's result with `<%- %>`; everything else uses `<%= %>`.
3. use `bbcode.toPlain()` for snippets, notifications and anywhere formatting can't show.
4. set length limits that allow for tags (e.g. 1,000+ for descriptions).

Keep as plain text: callsigns, unit names and tags, search boxes, numbers, and short moderation reasons and admin notes.

### Money and state
- Every cash or bank change goes through `players.save(player, { reason, ref })`, which writes the ledger. A missing reason gets flagged by anti-cheat.
- Multi-step changes run inside `players.transaction(fn)`. It doesn't nest. Follow-up checks (medals, tutorial) run after the response via `res.on('finish')`.
- Anything that pays out must not let linked accounts pass value to each other (see `anti.linked`, `anti.pvpRewards`).
- Reward multipliers stack as: base × (1 + unit and rank-perk bonuses) × live event multiplier × admin setting. Services get event effects through an `effects(now)` option (`src/events.js` lists them). If a new event type changes how much cash players can earn, update the anti-cheat limits in `src/anticheat`.
- Numbers admins may want to tune (payouts, limits, cooldowns) belong in the registry in `src/tuning.js` and are read with `tuning.get(key)`; they then appear on Admin › Game settings automatically. Keep the old constant as the documented default. Tests that change settings call `tuning.set()` and reset with `tuning.reset()`.

### Front end
- Strict CSP: no inline `<script>` or `on*=` handlers. JavaScript lives in `public/js/app.js` (progressive enhancement; every page works without it). Inline `style=` attributes are allowed.
- Design tokens are in `:root` in `public/css/main.css`. Check new pages at 320, 360, 390 and 1366 px with no horizontal scroll, for both regular and admin headers. Use `minmax(0, 1fr)` rather than `1fr` for grid columns that hold text, so they can shrink on small phones.

### Terms of Service
Text is in `views/partials/terms-body.ejs`. When it changes in a way players should agree to, bump `TERMS_VERSION` in `src/legal.js`; everyone re-accepts on their next visit.

### Tests
Integration tests start the app with `createApp({ db: openDatabase(':memory:'), secret })`. Pass `tutorial: false` when a test checks exact cash amounts.
