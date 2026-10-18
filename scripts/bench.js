'use strict';

/**
 * Load test: builds a big game database (once), starts the game against it in
 * production mode, signs in a few hundred players and hammers the busiest
 * pages and polls. Prints requests per second and response times per page.
 *
 *   npm run bench                      20,000 players, 50 at once, 15 seconds
 *   npm run bench -- --players 50000 --concurrency 100 --seconds 30
 *
 * The database lives in data/bench/ (delete it to rebuild). Nothing touches
 * the real game database.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const PLAYERS = arg('players', 20000);
const CONCURRENCY = arg('concurrency', 50);
const SECONDS = arg('seconds', 15);
const SIGNED_IN = Math.min(200, PLAYERS);
const PORT = arg('port', 3999);
const SECRET = 'bench-secret';
const DIR = path.join(__dirname, '..', 'data', 'bench');
const FILE = path.join(DIR, `game-${PLAYERS}.db`);

// What players actually do, weighted: mostly the background polls, then pages.
const MIX = [
  ['/notifications/poll?after=0&visible=1', 6, 'json'],
  ['/chat/global/poll?after=LATEST', 6, 'json'],
  ['/hq', 3], ['/missions', 2], ['/players', 1], ['/leaderboards', 1], ['/units/1', 1], ['/theatre', 1],
];

function seed() {
  if (fs.existsSync(FILE)) return;
  console.log(`Building a ${PLAYERS.toLocaleString('en-US')}-player database (once)…`);
  fs.mkdirSync(DIR, { recursive: true });
  const { openDatabase } = require('../src/db');
  const bcrypt = require('bcryptjs');
  const db = openDatabase(FILE);
  const now = Date.now();
  const DAY = 864e5;
  const hash = bcrypt.hashSync('password123', 4);
  const terms = require('../src/legal').TERMS_VERSION;
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const pick = (n) => 1 + Math.floor(rnd() * n);
  db.exec('BEGIN');
  const user = db.prepare(`INSERT INTO users (username, email, password_hash, level, pvp_wins, missions_completed, energy_updated_at, health_updated_at, created_at, last_seen_at, terms_version, terms_accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 1; i <= PLAYERS; i++) {
    user.run(`Soldier${i}`, `s${i}@bench.test`, hash, 1 + Math.floor(rnd() ** 2 * 80), Math.floor(rnd() * 200), Math.floor(rnd() * 500), now, now, now - rnd() * 90 * DAY, now - rnd() * 30 * DAY, terms, now);
  }
  const unitCount = Math.max(1, Math.round(PLAYERS / 25));
  const unit = db.prepare('INSERT INTO units (name, tag, treasury, created_at) VALUES (?, ?, 50000, ?)');
  for (let i = 1; i <= unitCount; i++) unit.run(`Unit ${i}`, `U${i}`, now);
  db.prepare(`UPDATE users SET unit_id = 1 + (id % ?), unit_role = CASE WHEN id <= ? THEN 'leader' ELSE 'member' END, unit_joined_at = ? WHERE id % 3 != 0`).run(unitCount, unitCount, now);
  // History in proportion to the player count: chat, notifications, money and fights.
  const chat = db.prepare('INSERT INTO chat_messages (channel, user_id, body, created_at) VALUES (?, ?, ?, ?)');
  const nChat = PLAYERS * 15;
  for (let i = 0; i < nChat; i++) chat.run(rnd() < 0.4 ? 'global' : `unit:${pick(unitCount)}`, pick(PLAYERS), 'Moving out, cover me', now - (nChat - i) * 20000);
  const note = db.prepare('INSERT INTO notifications (user_id, kind, message, link, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < PLAYERS * 50; i++) note.run(pick(PLAYERS), 'attack', 'You were attacked', '/battles', now - i * 2000, rnd() < 0.8 ? now : null);
  const ledger = db.prepare("INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at) VALUES (?, ?, 0, 'mission', ?)");
  for (let i = 0; i < PLAYERS * 100; i++) ledger.run(pick(PLAYERS), Math.floor(rnd() * 1000), now - i * 1000);
  db.exec(`UPDATE users SET cash = (SELECT COALESCE(SUM(delta_cash), 0) FROM ledger WHERE user_id = users.id),
                            bank_balance = (SELECT COALESCE(SUM(delta_bank), 0) FROM ledger WHERE user_id = users.id)`);
  const battle = db.prepare("INSERT INTO battles (attacker_id, defender_id, attacker_won, knockout, cash_taken, attacker_xp, defender_xp, report, created_at) VALUES (?, ?, 1, 0, 100, 10, 0, '{}', ?)");
  for (let i = 0; i < PLAYERS * 15; i++) battle.run(pick(PLAYERS), pick(PLAYERS), now - i * 8000);
  db.exec('COMMIT');
  db.close();
}

/** Writes signed-in sessions straight into the database; returns their cookies. */
function sessions() {
  const sign = require('cookie-signature').sign;
  const db = new DatabaseSync(FILE);
  // A database built before the terms last changed would send every page to the "accept the new terms" screen.
  db.prepare('UPDATE users SET terms_version = ?').run(require('../src/legal').TERMS_VERSION);
  const expires = Date.now() + 7 * 864e5;
  const insert = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)');
  const cookies = [];
  for (let i = 0; i < SIGNED_IN; i++) {
    const sid = crypto.randomBytes(18).toString('base64url');
    const userId = 1 + Math.floor((i * PLAYERS) / SIGNED_IN);
    insert.run(sid, JSON.stringify({ cookie: { originalMaxAge: 6048e5, expires: new Date(expires).toISOString(), secure: true, httpOnly: true, path: '/', sameSite: 'lax' }, userId }), expires);
    cookies.push(`ef.sid=${encodeURIComponent(`s:${sign(sid, SECRET)}`)}`);
  }
  const latest = db.prepare("SELECT MAX(id) AS id FROM chat_messages WHERE channel = 'global'").get().id || 0;
  db.close();
  return { cookies, latest };
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('The game did not start.');
}

async function main() {
  seed();
  const { cookies, latest } = sessions();
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: SECRET, DB_FILE: FILE, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitFor(`${base}/login`);
    const bag = MIX.flatMap(([p, w, kind]) => Array(w).fill([p.replace('LATEST', latest), kind]));
    const times = new Map();
    let total = 0;
    let failed = 0;
    const end = Date.now() + SECONDS * 1000;
    // Behind nginx every request arrives as HTTPS; the header lets secure cookies through locally.
    await Promise.all(Array.from({ length: CONCURRENCY }, async (_, worker) => {
      while (Date.now() < end) {
        const [p, kind] = bag[Math.floor(Math.random() * bag.length)];
        const started = performance.now();
        try {
          const res = await fetch(base + p, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https', cookie: cookies[(worker + total) % cookies.length], accept: kind === 'json' ? 'application/json' : 'text/html' } });
          await res.arrayBuffer();
          if (res.status !== 200) failed += 1;
        } catch { failed += 1; }
        total += 1;
        const label = p.replace(/\?.*/, '');
        (times.get(label) || times.set(label, []).get(label)).push(performance.now() - started);
      }
    }));
    const pct = (list, f) => list.sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * f))].toFixed(0);
    console.log(`\n${PLAYERS.toLocaleString('en-US')} players in the database, ${CONCURRENCY} requests at a time for ${SECONDS}s`);
    console.log(`${Math.round(total / SECONDS)} requests/second, ${failed} failed\n`);
    console.log('page'.padEnd(26), 'requests', '  median', '   p95');
    for (const [p, list] of [...times].sort()) console.log(p.padEnd(26), String(list.length).padStart(8), `${pct(list, 0.5)}ms`.padStart(8), `${pct(list, 0.95)}ms`.padStart(6));
  } finally {
    server.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
