'use strict';

const crypto = require('node:crypto');

function createSecurityHeaders({ production = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  return function securityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Tell browsers to only ever use HTTPS for this site (only meaningful over HTTPS).
    if (production && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/**
 * Returns `path` if it's a same-site path ("/armory?x=1"), else `fallback`.
 * Rejects "//evil.com" and "/\evil.com", which browsers treat as other sites.
 */
function safeRedirectPath(path, fallback = '/hq') {
  const p = String(path || '');
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000-\u001f]/.test(p)) return fallback;
  return p;
}

/**
 * Counts failures per key (e.g. an account name) in a sliding window, so
 * guessing one account's password from many IPs still gets throttled.
 */
function createFailureTracker({ windowMs, max }) {
  const entries = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, e] of entries) if (e.reset <= now) entries.delete(key);
  }, windowMs);
  sweep.unref();
  return {
    /** Minutes until `key` may try again, or 0 if it isn't locked. */
    lockedFor(key) {
      const e = entries.get(key);
      if (!e || e.reset <= Date.now() || e.count < max) return 0;
      return Math.ceil((e.reset - Date.now()) / 60000);
    },
    fail(key) {
      const now = Date.now();
      let e = entries.get(key);
      if (!e || e.reset <= now) {
        e = { count: 0, reset: now + windowMs };
        entries.set(key, e);
      }
      e.count += 1;
    },
    clear: (key) => entries.delete(key),
  };
}

/** Caps state-changing requests per signed-in player, to blunt bots and scripted spam. */
function actionRateLimit({ windowMs = 60 * 1000, max = 120 } = {}) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, e] of hits) if (e.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const userId = req.session && req.session.userId;
    if (req.method !== 'POST' || !userId) return next();
    const now = Date.now();
    let e = hits.get(userId);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(userId, e);
    }
    e.count += 1;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      const err = new Error('Slow down, soldier. Too many actions in a short time. Wait a moment and try again.');
      err.status = 429;
      return next(err);
    }
    next();
  };
}

/** Per-session CSRF token, required on every state-changing request. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrf;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const expected = Buffer.from(req.session.csrf);
  const actual = Buffer.from(sent);
  if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return next();

  const err = new Error('Your session expired or the form was tampered with. Please try again.');
  err.status = 403;
  next(err);
}

/** One-shot messages that survive a redirect. */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) delete req.session.flash;
  next();
}

/** Small fixed-window limiter keyed by IP; enough to blunt password guessing. */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      const err = new Error(message);
      err.status = 429;
      return next(err);
    }
    next();
  };
}

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

module.exports = {
  actionRateLimit,
  createFailureTracker,
  createSecurityHeaders,
  csrf,
  flash,
  rateLimit,
  safeRedirectPath,
  wantsJson,
};
