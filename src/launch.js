'use strict';

/**
 * Admin › Launch checklist: what to sort out before (and keep an eye on after)
 * opening the game to the public. Pure: the route gathers the facts, this
 * turns them into items with a state ('ok', 'todo' or 'info') and what to do.
 */

const HOUR = 60 * 60 * 1000;

const money = (n) => Number(n).toLocaleString('en-US');
const ago = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60000))} min ago` : `${Math.round(ms / HOUR)} h ago`);

/**
 * `facts`: { legal, production, host, backup, errors24h, signupsOpen, signupsPerIp, reserve, store, now },
 * where `store` is { checkout, webhook } (whether each is set up).
 * Returns a list of { id, label, state, detail, fix }.
 */
function checklist(facts) {
  const { legal, backup, now } = facts;
  const items = [];
  const add = (id, label, state, detail, fix = null) => items.push({ id, label, state, detail, fix });

  add('legal', 'Your details in the Terms of Service', legal.missing.length ? 'todo' : 'ok',
    legal.missing.length ? `Still showing placeholders for: ${legal.missing.join(', ')}.` : `${legal.operator} · ${legal.contactEmail} · ${legal.jurisdiction}`,
    legal.missing.length ? 'Fill them in on Admin › Server settings.' : null);

  const domain = String(facts.host || '').replace(/^www\./, '').replace(/:\d+$/, '');
  const email = legal.missing.includes('LEGAL_CONTACT_EMAIL') ? '' : legal.contactEmail;
  const onDomain = Boolean(email && domain && email.toLowerCase().endsWith(`@${domain.toLowerCase()}`));
  add('email', 'A contact email on your own domain', !email ? 'todo' : onDomain ? 'ok' : 'todo',
    !email ? 'No contact email set yet.' : onDomain ? `${email}. Send it a test message to check it really arrives.` : `${email} isn’t on ${domain || 'your domain'}. Players trust an address on the game’s own domain more.`,
    onDomain ? null : `Set up mail for ${domain || 'your domain'} (Cloudflare Email Routing can forward it to your inbox for free), then put the address in Admin › Server settings.`);

  add('production', 'Running in production mode', facts.production ? 'ok' : 'todo',
    facts.production ? 'NODE_ENV=production: secure cookies, cached files, no debug output.' : 'NODE_ENV isn’t production.',
    facts.production ? null : 'Add NODE_ENV=production to the settings file and restart.');

  if (!backup) {
    add('backup', 'Nightly backups', 'todo', 'No backup has reported in yet.', 'On the server: sudo eliteforces-backup (it runs nightly by itself once installed). If it says the command is missing, run deploy/install.sh again.');
  } else {
    const fresh = !backup.stale;
    const restored = backup.restore && backup.restore.ok;
    add('backup', 'Nightly backups', fresh && restored ? 'ok' : 'todo',
      `Last backup ${Number.isFinite(backup.atMs) ? ago(now - backup.atMs) : 'at an unknown time'}${backup.size ? ` (${(backup.size / 1048576).toFixed(1)} MB)` : ''}. ${restored ? `Test restore passed: ${money(backup.restore.users)} players, integrity ok.` : `Test restore ${backup.restore ? `failed: ${backup.restore.error || 'unknown error'}` : 'didn’t run'}.`}`,
      fresh ? (restored ? null : 'Check /var/log/eliteforces-backup.log on the server.') : 'The last backup is over a day old. Check /var/log/eliteforces-backup.log and that /etc/cron.d/eliteforces-backup exists.');
    const off = backup.offsite || {};
    add('offsite', 'A copy of each backup off the server', off.ok ? 'ok' : 'todo',
      off.ok ? `Copied to ${off.remote} ${Number.isFinite(Date.parse(off.at)) ? ago(now - Date.parse(off.at)) : ''}.` : off.remote ? `Copy to ${off.remote} failed: ${off.error || 'unknown error'}.` : 'Backups only live on the game server, so losing the server loses them too.',
      off.ok ? null : 'Follow “Off-site backups” in DEPLOY.md: connect a storage account on the server with “sudo rclone config” (Backblaze B2, Google Drive, Dropbox…), then enter it on Admin › Server settings.');
  }

  add('errors', 'Server errors in the last 24 hours', facts.errors24h ? 'todo' : 'ok',
    facts.errors24h ? `${facts.errors24h} error${facts.errors24h === 1 ? '' : 's'}. The latest are listed below; admins get an alert at most every half hour.` : 'None. Admins get an in-game and push alert when one happens.',
    facts.errors24h ? 'Look at the list below and the live log: sudo journalctl -u eliteforces -n 100.' : null);

  add('uptime', 'Outside uptime monitoring', 'info',
    `Point a free monitor such as UptimeRobot or Better Stack at https://${domain || 'your-domain'}/healthz. It answers “ok” while the game and its database are working, so you get an email if the site goes down.`);

  add('signups', 'Sign-ups', facts.signupsOpen ? 'ok' : 'info',
    `${facts.signupsOpen ? 'Open' : 'Closed (Game settings › Access)'}. At most ${facts.signupsPerIp} new account${facts.signupsPerIp === 1 ? '' : 's'} per network a day, and a hidden form field turns away simple sign-up bots.`);

  add('reserve', 'Reserve soldiers', 'info',
    facts.reserve ? `${facts.reserve} on duty. They stand down one for one as real players become active (Game settings › Living world).` : 'None on duty.');

  const store = facts.store || {};
  add('supporter', 'Supporter membership payments', store.checkout && store.webhook ? 'ok' : 'info',
    store.checkout && store.webhook ? 'Checkout link and webhook secret are set. Make a test purchase in Lemon Squeezy’s test mode to check it reaches Admin › Supporters.'
      : store.checkout ? 'The checkout link is set but LEMONSQUEEZY_WEBHOOK_SECRET isn’t, so payments wouldn’t reach the game.'
        : 'Not set up yet (optional). The Supporter page says “opens soon” until it is.',
    store.checkout && store.webhook ? null : 'Follow “Supporter membership” in DEPLOY.md, or the steps on Admin › Supporters.');

  return items;
}

module.exports = { checklist };
