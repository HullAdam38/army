'use strict';

const path = require('node:path');
const fs = require('node:fs');
// Node's built-in SQLite driver: no native compilation needed on install.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT    NOT NULL,
    level               INTEGER NOT NULL DEFAULT 1,
    xp                  INTEGER NOT NULL DEFAULT 0,
    cash                INTEGER NOT NULL DEFAULT 100,
    energy              INTEGER NOT NULL DEFAULT 50,
    max_energy          INTEGER NOT NULL DEFAULT 50,
    health              INTEGER NOT NULL DEFAULT 100,
    max_health          INTEGER NOT NULL DEFAULT 100,
    energy_updated_at   INTEGER NOT NULL,
    health_updated_at   INTEGER NOT NULL,
    missions_completed  INTEGER NOT NULL DEFAULT 0,
    missions_failed     INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    last_login_at       INTEGER,
    last_seen_at        INTEGER,
    signed_out_at       INTEGER
  );

  CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS inventory (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id      TEXT    NOT NULL,
    acquired_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS equipment (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot     TEXT    NOT NULL,
    item_id  TEXT    NOT NULL,
    PRIMARY KEY (user_id, slot)
  );

  CREATE TABLE IF NOT EXISTS battles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    attacker_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    defender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attacker_won    INTEGER NOT NULL,
    knockout        INTEGER NOT NULL,
    cash_taken      INTEGER NOT NULL DEFAULT 0,
    attacker_xp     INTEGER NOT NULL DEFAULT 0,
    defender_xp     INTEGER NOT NULL DEFAULT 0,
    report          TEXT    NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_battles_pair ON battles(attacker_id, defender_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_battles_defender ON battles(defender_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    link        TEXT,
    created_at  INTEGER NOT NULL,
    read_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type           TEXT    NOT NULL,
    amount         INTEGER NOT NULL,
    fee            INTEGER NOT NULL DEFAULT 0,
    balance_after  INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bank_user ON bank_transactions(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS admin_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id    INTEGER NOT NULL REFERENCES users(id),
    target_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT    NOT NULL,
    details     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_id, id DESC);

  -- Anti-cheat: who signed in from where. IPs are stored as keyed hashes, never raw.
  CREATE TABLE IF NOT EXISTS sign_ins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_hash     TEXT,
    device_id   TEXT,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sign_ins_user ON sign_ins(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sign_ins_device ON sign_ins(device_id);
  CREATE INDEX IF NOT EXISTS idx_sign_ins_ip ON sign_ins(ip_hash);

  -- Anti-cheat: every change to cash or bank balance, with why it happened.
  CREATE TABLE IF NOT EXISTS ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_cash  INTEGER NOT NULL DEFAULT 0,
    delta_bank  INTEGER NOT NULL DEFAULT 0,
    reason      TEXT    NOT NULL,
    ref         TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_reason ON ledger(reason, created_at);

  -- Anti-cheat: one row per player action (timing for bot checks, XP/cash for gains checks).
  CREATE TABLE IF NOT EXISTS actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    xp          INTEGER NOT NULL DEFAULT 0,
    cash        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_actions_user ON actions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at);

  -- Anti-cheat: suspicious activity for an admin to review.
  CREATE TABLE IF NOT EXISTS flags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rule         TEXT    NOT NULL,
    severity     INTEGER NOT NULL,
    dedupe_key   TEXT    NOT NULL,
    user_ids     TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    evidence     TEXT    NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 1,
    status       TEXT    NOT NULL DEFAULT 'open',
    resolution   TEXT,
    resolved_by  INTEGER REFERENCES users(id),
    resolved_at  INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_flags_status ON flags(status, severity DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_flags_key ON flags(dedupe_key, id DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    sid      TEXT PRIMARY KEY,
    sess     TEXT    NOT NULL,
    expires  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`;

/** Columns added after the first release, so older databases get upgraded on start. */
const ADDED_COLUMNS = [
  ['users', 'last_seen_at', 'INTEGER'],
  ['users', 'signed_out_at', 'INTEGER'],
  ['users', 'hospital_until', 'INTEGER'],
  ['users', 'hospital_reason', 'TEXT'],
  ['users', 'pvp_wins', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'pvp_losses', 'INTEGER NOT NULL DEFAULT 0'],
  ['activity', 'link', 'TEXT'],
  ['users', 'bank_balance', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'banned_at', 'INTEGER'],
  ['users', 'ban_reason', 'TEXT'],
  ['battles', 'reversed_at', 'INTEGER'],
];

function migrate(db) {
  for (const [table, name, type] of ADDED_COLUMNS) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_hospital ON users(hospital_until)');
  // Players who existed before the ledger get one opening entry for their current
  // balances, so "balance == sum of ledger" holds from here on.
  db.prepare(`
    INSERT INTO ledger (user_id, delta_cash, delta_bank, reason, created_at)
    SELECT u.id, u.cash, u.bank_balance, 'opening-balance', ? FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM ledger l WHERE l.user_id = u.id)`).run(Date.now());
}

function openDatabase(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'eliteforces.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDatabase };
