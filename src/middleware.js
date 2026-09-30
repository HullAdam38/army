'use strict';

const crypto = require('node:crypto');

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
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
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
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

module.exports = { csrf, flash, rateLimit, securityHeaders, wantsJson };
