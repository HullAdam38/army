'use strict';

/**
 * Takes the screenshots on the front page (public/img/screens/) and the link
 * preview image (public/img/og.png) from a throwaway demo game, so they always
 * show the game as it really is. Run it after changing how a page looks:
 *
 *   npm run screenshots
 *
 * Needs Playwright with Chromium (npx playwright install chromium), or set
 * PLAYWRIGHT_PATH to where it's installed. The real database is never touched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const tuning = require('../src/tuning');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch {
    console.error('Playwright isn’t installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const OUT = path.join(__dirname, '..', 'public', 'img');
// `at`: an element to scroll to the top of the shot.
const SHOTS = [
  { file: 'missions', url: '/missions' },
  { file: 'battle', url: null }, // the demo fight's report
  { file: 'unit', url: null, at: '#raid' }, // the demo unit
  { file: 'theatre', url: '/theatre' },
  { file: 'leaderboards', url: '/leaderboards' },
  { file: 'casino', url: '/casino/roulette' },
];
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-shots-'));
  const db = openDatabase(path.join(dir, 'demo.db'));
  const app = createApp({ db, secret: 'screenshots', tutorial: false });
  tuning.set({ reserveSoldiers: 30 });

  // Three days of reserve soldiers playing, so the world has history.
  const now = Date.now();
  for (let t = now - 3 * DAY; t <= now; t += 10 * 60 * 1000) app.reserve.tick(t);

  // The demo soldier.
  const id = app.players.create({ username: 'Nightjar', email: 'nightjar@demo.invalid', passwordHash: bcrypt.hashSync('password123', 4) });
  db.prepare(`UPDATE users SET level = 24, xp = 9000, cash = 18450, bank_balance = 52000, max_energy = 165, energy = 140, max_health = 330, health = 300,
              stat_str = 22, stat_agi = 18, stat_end = 16, missions_completed = 412, missions_failed = 37, pvp_wins = 58, pvp_losses = 21,
              created_at = ? WHERE id = ?`).run(now - 20 * DAY, id);
  const { TERMS_VERSION } = require('../src/legal');
  app.players.acceptTerms(id, TERMS_VERSION);
  for (const [slot, item] of Object.entries(require('../src/reserve').gearFor(24))) {
    db.prepare('INSERT OR REPLACE INTO equipment (user_id, slot, item_id) VALUES (?, ?, ?)').run(id, slot, item);
    db.prepare('INSERT OR IGNORE INTO inventory (user_id, item_id, acquired_at) VALUES (?, ?, ?)').run(id, item, now);
  }

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  // Web fonts come through Node, which can reach Google Fonts wherever this runs
  // (a sandboxed browser sometimes can't), so the shots use the real typefaces.
  const fonts = (ctx) => ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    try {
      const res = await fetch(route.request().url(), { headers: { 'user-agent': route.request().headers()['user-agent'] || 'Mozilla/5.0' } });
      route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/css', 'access-control-allow-origin': '*' }, body: Buffer.from(await res.arrayBuffer()) });
    } catch { route.abort(); }
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce', bypassCSP: true });
    await fonts(ctx);
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name=login]', 'Nightjar');
    await page.fill('input[name=password]', 'password123');
    await page.click('form[action="/login"] button[type=submit]');
    await page.waitForLoadState();
    const post = async (url, form) => page.evaluate(async ([u, f]) => {
      const csrf = document.querySelector('input[name="_csrf"]').value;
      const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...f }) });
      return res.url;
    }, [url, form]);

    // A unit of their own, with some reserve soldiers in it, a front and some ground held.
    await page.goto(`${base}/units`);
    await post('/units', { name: 'Night Owls', tag: 'NOW', description: 'We hunt after dark. Active every evening (UTC). Raids every day, wars at the weekend.' });
    const unit = db.prepare("SELECT * FROM units WHERE tag = 'NOW'").get();
    const recruits = db.prepare('SELECT id FROM users WHERE is_bot = 1 AND unit_id IS NULL AND banned_at IS NULL ORDER BY level DESC LIMIT 6').all();
    recruits.forEach((r, i) => db.prepare('UPDATE users SET unit_id = ?, unit_role = ?, unit_joined_at = ? WHERE id = ?').run(unit.id, i === 0 ? 'officer' : i < 3 ? 'sergeant' : 'member', now - 5 * DAY, r.id));
    db.prepare('UPDATE units SET treasury = 42500, drill = 2, barracks = 1, war_wins = 3, war_losses = 1 WHERE id = ?').run(unit.id);
    db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, 0, 0, 'test', ?)").run(id, now);
    await page.goto(`${base}/units/${unit.id}`);
    await post(`/units/${unit.id}/raid`, { stronghold: 'compound' });
    for (let i = 0; i < 3; i += 1) await post(`/units/${unit.id}/raid/strike`, {});
    await page.goto(`${base}/theatre`);
    await post('/theatre/front', { region: 'capital' });
    const hq = db.prepare('SELECT * FROM units WHERE hq = 1 ORDER BY id').all();
    app.theatre.setHolder('ridge', db.prepare('SELECT * FROM units WHERE id = ?').get(unit.id));
    if (hq[0]) app.theatre.setHolder('coast', hq[0]);
    if (hq[1]) app.theatre.setHolder('desert', hq[1]);
    if (hq[2]) app.theatre.setHolder('pass', hq[2]);

    // A fight, and a few spins of the roulette wheel.
    const foe = db.prepare('SELECT username FROM users WHERE is_bot = 1 AND banned_at IS NULL AND level BETWEEN 21 AND 27 AND (unit_id IS NULL OR unit_id != ?) ORDER BY level DESC LIMIT 1').get(unit.id)
      || db.prepare('SELECT username FROM users WHERE is_bot = 1 AND banned_at IS NULL AND level >= 21 LIMIT 1').get();
    db.prepare('UPDATE users SET hospital_until = NULL WHERE username = ?').run(foe.username);
    await page.goto(`${base}/profile/${encodeURIComponent(foe.username)}`);
    const battleUrl = await post(`/attack/${encodeURIComponent(foe.username)}`, {});
    await page.goto(`${base}/casino/roulette`);
    for (let i = 0; i < 4; i += 1) {
      await post('/casino/roulette/spin', { 'b-red': '500', 'b-17': '100' });
      await page.waitForTimeout(900);
    }

    fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });
    await page.addStyleTag({ content: '.tabbar { display: none !important; }' });
    for (const s of SHOTS) {
      const url = s.file === 'battle' ? battleUrl.replace(/^https?:\/\/[^/]+/, '') : s.file === 'unit' ? `/units/${unit.id}` : s.url;
      await page.goto(base + url);
      await page.addStyleTag({ content: '.tabbar, .flash, .statbar { display: none !important; } .site-header { position: static !important; }' });
      await page.evaluate(() => document.fonts.ready);
      if (s.at) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 12);
        }, s.at);
      }
      await page.waitForTimeout(300);
      const file = path.join(OUT, 'screens', `${s.file}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 78 });
      console.log(`${path.relative(process.cwd(), file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    }

    // The link preview: the front page's hero at 1200 × 630, signed out.
    const guest = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: 'reduce', bypassCSP: true });
    await fonts(guest);
    const gp = await guest.newPage();
    await gp.goto(`${base}/`);
    await gp.addStyleTag({ content: '.hero__shots, .site-header__nav { visibility: hidden; }' });
    await gp.evaluate(() => document.fonts.ready);
    await gp.waitForTimeout(300);
    await gp.screenshot({ path: path.join(OUT, 'og.png') });
    console.log(`${path.relative(process.cwd(), path.join(OUT, 'og.png'))} (${Math.round(fs.statSync(path.join(OUT, 'og.png')).size / 1024)} KB)`);
  } finally {
    await browser.close();
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
