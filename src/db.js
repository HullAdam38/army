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

  -- The motor pool (src/vehicles.js): vehicles a player owns and their condition, 0–100%.
  -- The one they take out is users.vehicle_id.
  CREATE TABLE IF NOT EXISTS vehicles (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id   TEXT    NOT NULL,
    condition    REAL    NOT NULL DEFAULT 100,
    acquired_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, vehicle_id)
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

  -- Scouting: snapshots of a target's hidden stats, visible only to the scout.
  CREATE TABLE IF NOT EXISTS scout_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scout_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cost        INTEGER NOT NULL,
    report      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scout_pair ON scout_reports(scout_id, target_id, id DESC);

  -- Daily orders: three per player per UTC day, created on first look.
  CREATE TABLE IF NOT EXISTS daily_orders (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day          TEXT    NOT NULL,
    slot         INTEGER NOT NULL,
    type         TEXT    NOT NULL,
    param        TEXT,
    target       INTEGER NOT NULL,
    progress     INTEGER NOT NULL DEFAULT 0,
    reward_xp    INTEGER NOT NULL,
    reward_cash  INTEGER NOT NULL,
    claimed_at   INTEGER,
    PRIMARY KEY (user_id, day, slot)
  );
  CREATE TABLE IF NOT EXISTS daily_bonus (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT    NOT NULL,
    claimed_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );

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

  CREATE TABLE IF NOT EXISTS units (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    tag          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    description  TEXT    NOT NULL DEFAULT '',
    recruiting   INTEGER NOT NULL DEFAULT 1,
    treasury     INTEGER NOT NULL DEFAULT 0,
    barracks     INTEGER NOT NULL DEFAULT 0,
    drill        INTEGER NOT NULL DEFAULT 0,
    founded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS unit_applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    UNIQUE (unit_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_unit_apps_user ON unit_applications(user_id);
  -- Server errors (500s) for Admin › Launch checklist, kept 14 days (src/health-service.js).
  CREATE TABLE IF NOT EXISTS server_errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    method      TEXT,
    path        TEXT,
    message     TEXT    NOT NULL,
    stack       TEXT,
    user_id     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_server_errors_time ON server_errors(created_at);
  -- Cosmetics a player or unit owns beyond what they've earned (src/cosmetics.js):
  -- granted by an admin today, bought in the store later. Never tradeable.
  CREATE TABLE IF NOT EXISTS user_cosmetics (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cosmetic_id  TEXT    NOT NULL,
    source       TEXT    NOT NULL, -- 'admin' or 'purchase'
    granted_by   INTEGER,
    granted_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, cosmetic_id)
  );
  CREATE TABLE IF NOT EXISTS unit_cosmetics (
    unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    cosmetic_id  TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    granted_by   INTEGER,
    granted_at   INTEGER NOT NULL,
    PRIMARY KEY (unit_id, cosmetic_id)
  );
  -- Supporter membership payments, as the payment provider reported them (src/supporter-service.js).
  -- id is a hash of the webhook body, so a repeated delivery is only counted once.
  CREATE TABLE IF NOT EXISTS payment_events (
    id               TEXT    PRIMARY KEY,
    provider         TEXT    NOT NULL,
    event            TEXT    NOT NULL,
    user_id          INTEGER,
    subscription_id  TEXT,
    status           TEXT,
    amount           INTEGER, -- smallest currency unit (pence, cents)
    currency         TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_payment_events_time ON payment_events(created_at);
  -- Invitations an officer sent to a player who is looking for a unit.
  CREATE TABLE IF NOT EXISTS unit_invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (unit_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_unit_invites_user ON unit_invites(user_id);

  CREATE TABLE IF NOT EXISTS unit_posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_unit_posts ON unit_posts(unit_id, id DESC);

  CREATE TABLE IF NOT EXISTS unit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_unit_log ON unit_log(unit_id, id DESC);

  CREATE TABLE IF NOT EXISTS unit_wars (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    attacker_unit_id  INTEGER REFERENCES units(id) ON DELETE SET NULL,
    defender_unit_id  INTEGER REFERENCES units(id) ON DELETE SET NULL,
    attacker_name     TEXT    NOT NULL,
    attacker_tag      TEXT    NOT NULL,
    defender_name     TEXT    NOT NULL,
    defender_tag      TEXT    NOT NULL,
    stake             INTEGER NOT NULL,
    attacker_score    INTEGER NOT NULL DEFAULT 0,
    defender_score    INTEGER NOT NULL DEFAULT 0,
    status            TEXT    NOT NULL DEFAULT 'active',
    winner            TEXT,
    result_note       TEXT,
    started_at        INTEGER NOT NULL,
    ends_at           INTEGER NOT NULL,
    ended_at          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_wars_status ON unit_wars(status, ends_at);
  CREATE INDEX IF NOT EXISTS idx_wars_attacker ON unit_wars(attacker_unit_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_wars_defender ON unit_wars(defender_unit_id, id DESC);

  CREATE TABLE IF NOT EXISTS unit_war_battles (
    war_id     INTEGER NOT NULL REFERENCES unit_wars(id) ON DELETE CASCADE,
    battle_id  INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
    side       TEXT    NOT NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    points     INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (war_id, battle_id)
  );

  CREATE TABLE IF NOT EXISTS user_medals (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    medal_id    TEXT    NOT NULL,
    tier        INTEGER NOT NULL,
    awarded_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, medal_id, tier)
  );

  CREATE TABLE IF NOT EXISTS bounties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    placer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    amount      INTEGER NOT NULL,
    fee         INTEGER NOT NULL,
    anonymous   INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'open',
    claimer_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    battle_id   INTEGER REFERENCES battles(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    settled_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bounties_target ON bounties(target_id, status);
  CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_bounties_placer ON bounties(placer_id, status);
  CREATE INDEX IF NOT EXISTS idx_bounties_claimer ON bounties(claimer_id);

  CREATE TABLE IF NOT EXISTS tutorial_progress (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step     TEXT    NOT NULL,
    done_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, step)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject          TEXT    NOT NULL,
    created_at       INTEGER NOT NULL,
    last_message_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at     INTEGER NOT NULL DEFAULT 0,
    hidden_at        INTEGER,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body             TEXT    NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at);

  CREATE TABLE IF NOT EXISTS blocks (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS message_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body         TEXT    NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'open',
    resolved_by  INTEGER REFERENCES users(id),
    resolution   TEXT,
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER,
    UNIQUE (message_id, reporter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON message_reports(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS operation_progress (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_id         TEXT    NOT NULL,
    stage         INTEGER NOT NULL DEFAULT 1,
    completed_at  INTEGER,
    completions   INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, op_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    message       TEXT    NOT NULL DEFAULT '',
    starts_at     INTEGER NOT NULL,
    ends_at       INTEGER NOT NULL,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    cancelled_at  INTEGER,
    announced_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_time ON events(starts_at, ends_at);

  CREATE TABLE IF NOT EXISTS deployments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL,
    started_at   INTEGER NOT NULL,
    ends_at      INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'active',
    cash         INTEGER NOT NULL DEFAULT 0,
    xp           INTEGER NOT NULL DEFAULT 0,
    report       TEXT,
    returned_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deployments_due ON deployments(status, ends_at);

  -- PvP seasons (src/seasons.js, src/season-service.js).
  CREATE TABLE IF NOT EXISTS seasons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    number     INTEGER NOT NULL UNIQUE,
    starts_at  INTEGER NOT NULL,
    ends_at    INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'ended'
    ended_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status, ends_at);
  CREATE TABLE IF NOT EXISTS season_players (
    season_id      INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating         INTEGER NOT NULL,
    peak           INTEGER NOT NULL,
    wins           INTEGER NOT NULL DEFAULT 0,
    losses         INTEGER NOT NULL DEFAULT 0,
    fights         INTEGER NOT NULL DEFAULT 0,
    last_fight_at  INTEGER,
    PRIMARY KEY (season_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_season_players_rank ON season_players(season_id, rating DESC);
  CREATE TABLE IF NOT EXISTS season_battles (
    battle_id       INTEGER PRIMARY KEY REFERENCES battles(id) ON DELETE CASCADE,
    season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    attacker_id     INTEGER NOT NULL,
    defender_id     INTEGER NOT NULL,
    attacker_delta  INTEGER NOT NULL,
    defender_delta  INTEGER NOT NULL,
    attacker_after  INTEGER NOT NULL,
    defender_after  INTEGER NOT NULL,
    reversed_at     INTEGER
  );
  CREATE TABLE IF NOT EXISTS season_results (
    season_id    INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rank         INTEGER NOT NULL,
    rating       INTEGER NOT NULL,
    peak         INTEGER NOT NULL,
    division     TEXT    NOT NULL,
    wins         INTEGER NOT NULL,
    losses       INTEGER NOT NULL,
    reward_cash  INTEGER NOT NULL,
    reward_xp    INTEGER NOT NULL,
    PRIMARY KEY (season_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_season_results_user ON season_results(user_id, season_id DESC);

  -- Admin game settings (src/tuning.js, src/settings-service.js). Values are JSON.
  CREATE TABLE IF NOT EXISTS game_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS game_settings_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL,
    old_value   TEXT,
    new_value   TEXT    NOT NULL,
    changed_at  INTEGER NOT NULL,
    changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_settings_history ON game_settings_history(key, changed_at DESC);

  -- Game chat (src/chat.js, src/chat-service.js). channel: 'global' or 'unit:<id>'.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT    NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    deleted_by  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, id);
  CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS chat_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL,
    channel      TEXT    NOT NULL,
    reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body         TEXT    NOT NULL, -- a copy, kept even if the message is deleted
    reason       TEXT,
    status       TEXT    NOT NULL DEFAULT 'open',
    resolution   TEXT,
    resolved_by  INTEGER,
    resolved_at  INTEGER,
    created_at   INTEGER NOT NULL,
    UNIQUE (message_id, reporter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status, id DESC);
  -- The last chat message each player has seen per channel (for unread counts).
  CREATE TABLE IF NOT EXISTS chat_reads (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel  TEXT    NOT NULL,
    last_id  INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel)
  );

  -- Every @mention of a player in chat, so the chat icon can flag unread mentions
  -- (the bell notification is rate-limited; this isn't). Cleared by reading the channel.
  CREATE TABLE IF NOT EXISTS chat_mentions (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    channel     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(user_id, channel, message_id);

  -- Push notifications (src/push-service.js): one row per browser/device a player
  -- turned alerts on for. The endpoint is the browser push service's address.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      TEXT    NOT NULL UNIQUE,
    p256dh        TEXT    NOT NULL,
    auth          TEXT    NOT NULL,
    device        TEXT,
    created_at    INTEGER NOT NULL,
    last_sent_at  INTEGER,
    last_error    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

  -- Server-generated keys that must survive restarts (e.g. the push VAPID key pair).
  CREATE TABLE IF NOT EXISTS app_keys (
    name   TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  -- Weekly unit objectives (src/objectives.js). The week is the Monday it started.
  CREATE TABLE IF NOT EXISTS unit_objectives (
    week          TEXT    NOT NULL,
    unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    slot          INTEGER NOT NULL,
    type          TEXT    NOT NULL,
    target        INTEGER NOT NULL,
    progress      INTEGER NOT NULL DEFAULT 0,
    reward_cash   INTEGER NOT NULL,
    nudged_at     INTEGER,
    completed_at  INTEGER,
    PRIMARY KEY (week, unit_id, slot)
  );
  CREATE TABLE IF NOT EXISTS unit_objective_contrib (
    week     TEXT    NOT NULL,
    unit_id  INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type     TEXT    NOT NULL,
    amount   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, unit_id, user_id, type)
  );

  -- Unit raids (src/raids.js): one stronghold at a time per unit, and each member's damage.
  CREATE TABLE IF NOT EXISTS raids (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    stronghold   TEXT    NOT NULL,
    hp           INTEGER NOT NULL,
    max_hp       INTEGER NOT NULL,
    cash_pool    INTEGER NOT NULL,
    xp_pool      INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'active', -- active, won, failed, cancelled (by HQ)
    launched_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    started_at   INTEGER NOT NULL,
    ends_at      INTEGER NOT NULL,
    finished_at  INTEGER,
    nudged_at    INTEGER,
    reminded_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_raids_unit ON raids(unit_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_raids_active ON raids(status, ends_at);
  CREATE TABLE IF NOT EXISTS raid_hits (
    raid_id  INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    damage   INTEGER NOT NULL DEFAULT 0,
    strikes  INTEGER NOT NULL DEFAULT 0,
    cash     INTEGER,
    xp       INTEGER,
    last_at  INTEGER NOT NULL,
    PRIMARY KEY (raid_id, user_id)
  );

  -- Casino (src/slots.js): every bet and what it paid. Kept for 30 days.
  CREATE TABLE IF NOT EXISTS casino_plays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game       TEXT    NOT NULL,
    bet        INTEGER NOT NULL,
    payout     INTEGER NOT NULL,
    mult       REAL    NOT NULL DEFAULT 0,
    result     TEXT    NOT NULL, -- JSON: the game's outcome (e.g. the slot line)
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_casino_user ON casino_plays(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_casino_time ON casino_plays(created_at);

  -- Blackjack tables (src/blackjack-service.js): each table's whole state as JSON, saved after every change.
  CREATE TABLE IF NOT EXISTS blackjack_tables (
    id         INTEGER PRIMARY KEY,
    state      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Support tickets (src/support.js): a player's ticket and its messages (player, HQ replies and internal notes).
  CREATE TABLE IF NOT EXISTS support_tickets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category       TEXT    NOT NULL,
    subject        TEXT    NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'open', -- open, answered, closed
    assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_player_at INTEGER,
    last_staff_at  INTEGER,
    player_seen_at INTEGER,
    closed_at      INTEGER,
    closed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_support_user ON support_tickets(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status, updated_at);
  CREATE TABLE IF NOT EXISTS support_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    staff      INTEGER NOT NULL DEFAULT 0,
    internal   INTEGER NOT NULL DEFAULT 0, -- staff-only notes the player never sees
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_support_messages ON support_messages(ticket_id, id);

  -- Theatre of war (src/theatre.js): who holds each region, each unit's weekly front and points.
  CREATE TABLE IF NOT EXISTS theatre_regions (
    region     TEXT PRIMARY KEY,
    unit_id    INTEGER REFERENCES units(id) ON DELETE SET NULL,
    held_since INTEGER
  );
  CREATE TABLE IF NOT EXISTS theatre_fronts (
    week    TEXT    NOT NULL,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    region  TEXT    NOT NULL,
    set_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    set_at  INTEGER NOT NULL,
    PRIMARY KEY (week, unit_id)
  );
  CREATE TABLE IF NOT EXISTS theatre_scores (
    week    TEXT    NOT NULL,
    region  TEXT    NOT NULL,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    points  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, region, unit_id)
  );
  CREATE TABLE IF NOT EXISTS theatre_contrib (
    week    TEXT    NOT NULL,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, unit_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS theatre_weeks (
    week       TEXT PRIMARY KEY,
    settled_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS theatre_results (
    week      TEXT    NOT NULL,
    region    TEXT    NOT NULL,
    from_unit INTEGER,
    to_unit   INTEGER,
    from_name TEXT,
    to_name   TEXT,
    points    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, region)
  );
  CREATE TABLE IF NOT EXISTS theatre_income (
    day     TEXT    NOT NULL,
    region  TEXT    NOT NULL,
    unit_id INTEGER NOT NULL,
    amount  INTEGER NOT NULL,
    PRIMARY KEY (day, region)
  );

  -- The daily high-value target (src/target-service.js), and who has collected on them.
  CREATE TABLE IF NOT EXISTS daily_targets (
    day         TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    defenses    INTEGER NOT NULL DEFAULT 0,
    beaten      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_target_claims (
    day          TEXT    NOT NULL,
    attacker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    battle_id    INTEGER NOT NULL,
    cash         INTEGER NOT NULL,
    xp           INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (day, attacker_id)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_target_claims_battle ON daily_target_claims(battle_id);
  -- Attackers the target has been paid for holding off (once each per day).
  CREATE TABLE IF NOT EXISTS daily_target_defenses (
    day          TEXT    NOT NULL,
    attacker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    battle_id    INTEGER NOT NULL,
    PRIMARY KEY (day, attacker_id)
  );

  -- Days each player was active (UTC dates), for Admin › Player stats.
  CREATE TABLE IF NOT EXISTS player_days (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      TEXT    NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_player_days_day ON player_days(day);

  -- Titles (src/titles.js): which ones a player has earned.
  CREATE TABLE IF NOT EXISTS user_titles (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id   TEXT    NOT NULL,
    earned_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, title_id)
  );

  -- Avatars (src/avatars.js): an uploaded picture, at most one per player, with
  -- metadata already stripped (src/images.js). Badges live in users.avatar_badge.
  CREATE TABLE IF NOT EXISTS avatar_uploads (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime        TEXT    NOT NULL,
    data        BLOB    NOT NULL,
    bytes       INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_avatar_uploads_recent ON avatar_uploads(created_at DESC);

  CREATE TABLE IF NOT EXISTS avatar_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    upload_at    INTEGER NOT NULL,
    reason       TEXT,
    status       TEXT    NOT NULL DEFAULT 'open',
    resolution   TEXT,
    resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at  INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_avatar_reports_status ON avatar_reports(status, created_at DESC);

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
  ['users', 'stat_str', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'stat_agi', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'stat_end', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'password_reset_at', 'INTEGER'],
  ['users', 'streak_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'streak_day', 'TEXT'],
  ['users', 'streak_best', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'unit_id', 'INTEGER REFERENCES units(id) ON DELETE SET NULL'],
  ['users', 'unit_role', 'TEXT'],
  ['users', 'unit_joined_at', 'INTEGER'],
  ['users', 'unit_donated', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'unit_left_at', 'INTEGER'],
  ['units', 'min_level', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'min_pvp_wins', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'min_missions', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'war_wins', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'war_losses', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'war_draws', 'INTEGER NOT NULL DEFAULT 0'],
  ['units', 'war_protected_until', 'INTEGER'],
  ['users', 'orders_completed', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'wars_won', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'pinned_medals', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'tutorial_dismissed', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'terms_version', 'TEXT'],
  ['users', 'terms_accepted_at', 'INTEGER'],
  ['users', 'bio', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'bio_updated_at', 'INTEGER'],
  ['users', 'adrenaline_at', 'INTEGER'],
  ['users', 'stim_loaded', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_barracks', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_medbay', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_vault', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_intel', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_range', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_comms', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'base_build', 'TEXT'],
  ['users', 'base_build_until', 'INTEGER'],
  ['users', 'base_build_cost', 'INTEGER'],
  ['users', 'deploy_until', 'INTEGER'],
  ['users', 'chat_muted_until', 'INTEGER'],
  ['users', 'chat_mute_reason', 'TEXT'],
  ['users', 'title', 'TEXT'],
  ['users', 'avatar_kind', 'TEXT'], // null (starting badge), 'badge' or 'upload'
  ['users', 'avatar_badge', 'TEXT'], // JSON of badge part ids
  ['users', 'avatar_v', 'INTEGER NOT NULL DEFAULT 0'], // bumps on every change, for image caching
  ['users', 'avatar_upload_blocked', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'push_prefs', 'TEXT'], // JSON: alert categories and quiet hours (src/push.js)
  ['users', 'energy_push_for', 'INTEGER'], // energy_updated_at already alerted as "energy full"
  ['users', 'app_seen_at', 'INTEGER'], // last time they played in the installed app
  ['units', 'rally_until', 'INTEGER'], // an "Advance!" rally order is active until then
  ['units', 'rally_at', 'INTEGER'], // when the last rally was called (for the cooldown)
  ['raids', 'supply_cost', 'INTEGER'], // what the unit paid, so HQ can refund a cancelled raid
  ['users', 'support_alerts', 'INTEGER NOT NULL DEFAULT 1'], // admins: push alerts for new support tickets
  ['casino_plays', 'variance', 'REAL'], // the play's statistical variance, for spotting unusual luck (Admin › Casino)
  ['users', 'casino_loss_limit', 'INTEGER'], // the player's own daily loss limit (src/casino-player.js); null for none
  ['users', 'casino_limit_next', 'INTEGER'], // a looser limit waiting to apply (0 = remove it)…
  ['users', 'casino_limit_next_at', 'INTEGER'], // …from this time
  ['users', 'casino_break_until', 'INTEGER'], // a break the player took from the casino
  ['users', 'casino_wagered', 'INTEGER NOT NULL DEFAULT 0'], // career totals for the casino medals
  ['users', 'casino_big_wins', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'casino_blackjacks', 'INTEGER NOT NULL DEFAULT 0'],
  ['chat_messages', 'kind', 'TEXT'], // null for players' messages; 'casino' for big-win shouts
  ['users', 'lfu_at', 'INTEGER'], // looking for a unit since (shown to unit officers)
  ['inventory', 'condition', 'REAL NOT NULL DEFAULT 100'], // gear condition, 0–100% (src/gear.js)
  ['users', 'supporter_until', 'INTEGER'], // Supporter perks last until then (src/supporter.js)
  ['users', 'supporter_since', 'INTEGER'],
  ['users', 'supporter_status', 'TEXT'], // the provider's status: active, cancelled, past_due…; 'gift' for one from HQ
  ['users', 'supporter_source', 'TEXT'], // 'lemonsqueezy' or 'admin'
  ['users', 'supporter_sub_id', 'TEXT'], // the provider's subscription id
  ['users', 'supporter_portal', 'TEXT'], // link to manage or cancel the subscription
  ['users', 'supporter_lapsed_at', 'INTEGER'], // when Supporter-only looks were taken off after it ended
  ['users', 'name_color', 'TEXT'], // cosmetic id of the callsign colour worn (src/cosmetics.js)
  ['users', 'profile_banner', 'TEXT'], // cosmetic id of the profile banner
  ['units', 'crest', 'TEXT'], // cosmetic id of the unit's crest style
  ['users', 'vehicle_id', 'TEXT'], // the vehicle the player takes out (src/vehicles.js)
  ['users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0'], // a reserve soldier run by the game (src/reserve-service.js)
  ['users', 'bot_pace', 'REAL'], // how fast a reserve soldier progresses (about 0.4–1.4)
  ['units', 'hq', 'INTEGER NOT NULL DEFAULT 0'], // 1: an HQ-run starter unit; 2: one that has passed to its players
  ['users', 'referred_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], // recruit-a-friend: who sent them
  ['users', 'referral_paid_at', 'INTEGER'], // when the recruiter was rewarded for them
];

function migrate(db) {
  for (const [table, name, type] of ADDED_COLUMNS) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_hospital ON users(hospital_until)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_unit ON users(unit_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_bot ON users(is_bot) WHERE is_bot = 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_referred ON users(referred_by) WHERE referred_by IS NOT NULL');
  // Chat polls ask for recently deleted messages; only deleted rows go in this index, so it stays tiny.
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_deleted ON chat_messages(channel, deleted_at) WHERE deleted_at IS NOT NULL');
  // Lets the anti-cheat ledger audit add up each player's history from the index alone.
  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_sums ON ledger(user_id, delta_cash, delta_bank)');
  // A player's casino losses over the last 24 hours, for their loss limit, from the index alone.
  db.exec('CREATE INDEX IF NOT EXISTS idx_casino_user_time ON casino_plays(user_id, created_at, bet, payout)');
  // First run with player_days: rebuild active days from the history the game already keeps.
  if (!db.prepare('SELECT 1 FROM player_days LIMIT 1').get() && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const day = (col) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;
    db.exec(`
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT id, ${day('created_at')} FROM users;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT id, ${day('last_seen_at')} FROM users WHERE last_seen_at IS NOT NULL;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT DISTINCT user_id, ${day('created_at')} FROM ledger;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT DISTINCT attacker_id, ${day('created_at')} FROM battles;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT DISTINCT user_id, ${day('created_at')} FROM sign_ins;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT DISTINCT user_id, ${day('created_at')} FROM actions;
      INSERT OR IGNORE INTO player_days (user_id, day) SELECT DISTINCT user_id, ${day('created_at')} FROM chat_messages;
    `);
  }
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
  // Speed: with WAL, NORMAL only syncs to disk at checkpoints. A power cut can lose
  // the last moments of play but never corrupts the database. A bigger page cache,
  // memory-mapped reads and in-memory temp tables keep hot data out of the disk.
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456; PRAGMA temp_store = MEMORY;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDatabase };
