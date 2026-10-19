'use strict';

/**
 * Admin › Server settings: the server settings that are safe to change from the
 * website, stored in admin-settings.env next to the database. Values saved
 * there override the same names in /etc/eliteforces/eliteforces.env.
 *
 * Deliberately limited. Secrets and settings that could break or take over the
 * server (SESSION_SECRET, NODE_ENV, DB_FILE, PORT, TRUST_PROXY) can only be
 * changed on the server itself, so a stolen admin session can't touch them.
 * Every value is checked against a strict pattern, and the backup script
 * (which runs as root) reads its two keys with a parser, never `source`.
 */

const fs = require('node:fs');
const path = require('node:path');

const EMAIL_RE = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const plain = (max) => (v) => (v.length <= max && /^[^\r\n<>"\\$`]*$/.test(v) ? null : `Up to ${max} characters, without line breaks, quotes, <, >, $ or backslashes.`);

const FIELDS = [
  { key: 'LEGAL_OPERATOR', group: 'legal', label: 'Who runs the game', help: 'Your name or company, as shown in the Terms of Service.', example: 'Hull Games Ltd', check: plain(100) },
  { key: 'LEGAL_CONTACT_EMAIL', group: 'legal', label: 'Contact email', help: 'Shown in the Terms of Service and used for push alert registration. Best on your own domain.', example: 'support@generalforces.com', check: (v) => (EMAIL_RE.test(v) ? null : 'Enter an email address, like support@generalforces.com.') },
  { key: 'LEGAL_JURISDICTION', group: 'legal', label: 'Governing law', help: 'The country or state whose law the terms follow.', example: 'England and Wales', check: plain(100) },
  { key: 'SITE_URL', group: 'site', label: 'Site address', help: 'The main address, so links shared on Discord or Reddit always use it. No path or trailing slash.', example: 'https://generalforces.com', check: (v) => (/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v) ? null : 'Enter just the address, like https://generalforces.com.') },
  { key: 'PUSH_CONTACT', group: 'site', label: 'Push alert contact', help: 'Given to browsers’ push services in case they need to reach you. Leave empty to use the contact email.', example: 'mailto:support@generalforces.com', check: (v) => (/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(v) && v.length <= 200 ? null : 'Start with mailto: or https://.') },
  { key: 'SUPPORTER_CHECKOUT_URL', group: 'store', label: 'Supporter checkout link', help: 'The “Buy” link of your Supporter subscription product in Lemon Squeezy (Products › your product › Share). Players are sent here, with their account filled in. Leave empty to keep the Supporter page in “coming soon” mode.', example: 'https://generalforces.lemonsqueezy.com/checkout/buy/0a1b2c3d-…', check: (v) => (/^https:\/\/[a-z0-9-]{1,63}\.lemonsqueezy\.com\/checkout\/buy\/[A-Za-z0-9-]{8,80}$/.test(v) ? null : 'Paste the Lemon Squeezy checkout link, like https://yourstore.lemonsqueezy.com/checkout/buy/….') },
  { key: 'SUPPORTER_PRICE', group: 'store', label: 'Supporter price (as shown)', help: 'How the price reads on the Supporter page. It must match what you set in Lemon Squeezy, which decides what’s charged.', example: '£4 a month', check: plain(40) },
  { key: 'BACKUP_REMOTE', group: 'backup', label: 'Off-site backup destination', help: 'An rclone remote and folder (set the remote up once on the server with “sudo rclone config”). Used from the next nightly backup.', example: 'b2:my-bucket/generalforces', check: (v) => (/^[A-Za-z0-9_][A-Za-z0-9_-]{0,40}:[A-Za-z0-9._\/-]{0,200}$/.test(v) ? null : 'Use remote:folder, like b2:my-bucket/generalforces (letters, numbers, - _ . / only).') },
  { key: 'BACKUP_REMOTE_KEEP_DAYS', group: 'backup', label: 'Keep off-site copies for', help: 'Days. Older copies are deleted from the off-site storage.', example: '30', unit: 'days', check: (v) => (/^\d{1,4}$/.test(v) && Number(v) >= 1 ? null : 'A whole number of days, 1 or more.') },
];
const GROUPS = [
  { id: 'legal', name: 'Terms of Service' },
  { id: 'site', name: 'Site' },
  { id: 'store', name: 'Supporter membership' },
  { id: 'backup', name: 'Backups' },
];
// Shown, never editable here.
const SERVER_ONLY = [
  { key: 'NODE_ENV', secret: false },
  { key: 'PORT', secret: false },
  { key: 'DB_FILE', secret: false },
  { key: 'TRUST_PROXY', secret: false },
  { key: 'ANTICHEAT_SCAN_HOURS', secret: false },
  { key: 'SESSION_SECRET', secret: true },
  { key: 'LEMONSQUEEZY_WEBHOOK_SECRET', secret: true },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** Where the file lives: next to the database. */
function defaultFile(env = process.env) {
  const dbFile = env.DB_FILE || path.join(__dirname, '..', 'data', 'eliteforces.db');
  return path.join(path.dirname(dbFile), 'admin-settings.env');
}

/** Reads KEY=value lines, keeping only known keys with valid values. */
function parse(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m || !BY_KEY.has(m[1])) continue;
    const v = m[2].trim();
    if (v && !BY_KEY.get(m[1]).check(v)) out[m[1]] = v;
  }
  return out;
}

function createServerSettings(file = defaultFile(), env = process.env) {
  // What the settings file on the server says, before anything from here overrides it.
  const fromServer = Object.fromEntries(FIELDS.map((f) => [f.key, env[f.key] || '']));
  let saved = {};
  try { saved = parse(fs.readFileSync(file, 'utf8')); } catch { /* not created yet */ }

  /** Puts the saved values into the environment, where the rest of the game reads them. */
  function apply() {
    for (const f of FIELDS) {
      if (saved[f.key]) env[f.key] = saved[f.key];
      else if (fromServer[f.key]) env[f.key] = fromServer[f.key];
      else delete env[f.key];
    }
  }
  apply();

  return {
    FIELDS,
    GROUPS,
    file,

    /** Every editable setting: the value in force and where it comes from. */
    view() {
      return GROUPS.map((g) => ({
        ...g,
        fields: FIELDS.filter((f) => f.group === g.id).map((f) => ({
          key: f.key, label: f.label, help: f.help, example: f.example, unit: f.unit || null,
          value: saved[f.key] || '',
          serverValue: fromServer[f.key],
          source: saved[f.key] ? 'here' : fromServer[f.key] ? 'server' : 'unset',
        })),
      }));
    },

    /** The server-only settings, with secrets hidden. */
    serverOnly: () => SERVER_ONLY.map((s) => ({ key: s.key, value: env[s.key] ? (s.secret ? 'set (hidden)' : env[s.key]) : 'not set' })),

    /**
     * Checks and saves the submitted values (empty removes the override, so the
     * server file's value applies again). Returns { errors } or { changed: [keys] }.
     */
    save(input) {
      const next = {};
      const errors = {};
      for (const f of FIELDS) {
        const v = String(input[f.key] ?? '').trim();
        if (!v) continue;
        const problem = f.check(v);
        if (problem) errors[f.key] = problem;
        else next[f.key] = v;
      }
      if (Object.keys(errors).length) return { errors };
      const changed = FIELDS.filter((f) => (next[f.key] || '') !== (saved[f.key] || '')).map((f) => f.key);
      if (!changed.length) return { changed };
      const body = [
        '# Server settings saved from Admin › Server settings. They override the same',
        '# names in /etc/eliteforces/eliteforces.env. Edit them on that page.',
        ...FIELDS.filter((f) => next[f.key]).map((f) => `${f.key}=${next[f.key]}`),
        '',
      ].join('\n');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o640 });
      fs.renameSync(tmp, file);
      saved = next;
      apply();
      return { changed };
    },
  };
}

module.exports = { FIELDS, SERVER_ONLY, createServerSettings, defaultFile, parse };
