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

  CREATE TABLE IF NOT EXISTS sessions (
    sid      TEXT PRIMARY KEY,
    sess     TEXT    NOT NULL,
    expires  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`;

/** Adds columns introduced after a database was first created. */
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const [name, type] of [['last_seen_at', 'INTEGER'], ['signed_out_at', 'INTEGER']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)');
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
