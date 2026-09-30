'use strict';

/** A player counts as online if they loaded a page this recently and haven't signed out since. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
/** Don't write last_seen_at on every request; once a minute is plenty. */
const SEEN_THROTTLE_MS = 60 * 1000;

function isOnline(user, now = Date.now()) {
  if (!user.last_seen_at || user.last_seen_at < now - ONLINE_WINDOW_MS) return false;
  return !user.signed_out_at || user.signed_out_at < user.last_seen_at;
}

function timeAgo(ms, now = Date.now()) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

module.exports = { ONLINE_WINDOW_MS, SEEN_THROTTLE_MS, isOnline, timeAgo };
