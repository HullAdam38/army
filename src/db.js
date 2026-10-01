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
];

function migrate(db) {
  for (const [table, name, type] of ADDED_COLUMNS) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_hospital ON users(hospital_until)');
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
