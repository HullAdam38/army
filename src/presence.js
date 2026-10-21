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

/*
 * Time played, for admins: the time between a player's page views and
 * actions (not background polls, so an idle open tab doesn't count). A gap
 * longer than PLAY_IDLE_MS means they'd stopped: the next request starts a new
 * session and the gap isn't counted. Writes happen at most every PLAY_STEP_MS.
 */
const PLAY_IDLE_MS = 10 * 60 * 1000;
const PLAY_STEP_MS = 30 * 1000;

/** What a request at `now` adds: { addMs, newSession } to save, or null when there's nothing to write yet. */
function playTick(lastActiveAt, now = Date.now()) {
  if (!lastActiveAt || now - lastActiveAt > PLAY_IDLE_MS) return { addMs: 0, newSession: true };
  const gap = now - lastActiveAt;
  return gap >= PLAY_STEP_MS ? { addMs: gap, newSession: false } : null;
}

/** "3h 12m", "2d 4h", "45m", "under a minute". */
function duration(ms) {
  const m = Math.floor((ms || 0) / 60000);
  if (m < 1) return ms > 0 ? 'under a minute' : '—';
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

module.exports = { ONLINE_WINDOW_MS, PLAY_IDLE_MS, PLAY_STEP_MS, SEEN_THROTTLE_MS, duration, isOnline, playTick, timeAgo };
