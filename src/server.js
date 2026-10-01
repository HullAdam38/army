'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const compression = require('compression');

const { openDatabase } = require('./db');
const { SQLiteStore } = require('./session-store');
const { createPlayerRepo } = require('./players');
const { csrf, flash, securityHeaders, wantsJson } = require('./middleware');
const { authRoutes } = require('./routes/auth');
const { gameRoutes } = require('./routes/game');
const { armoryRoutes } = require('./routes/armory');
const { hospitalRoutes } = require('./routes/hospital');
const { pvpRoutes } = require('./routes/pvp');
const { notificationRoutes } = require('./routes/notifications');
const { bankRoutes } = require('./routes/bank');
const pkg = require('../package.json');

function createApp({ db = openDatabase(), secret = process.env.SESSION_SECRET, production = process.env.NODE_ENV === 'production' } = {}) {
  if (!secret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('[eliteforces] SESSION_SECRET not set; using a random one. Sessions reset on restart.');
  }

  const app = express();
  const players = createPlayerRepo(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');

  app.locals.assetVersion = pkg.version;
  app.locals.siteName = 'EliteForces';
  app.locals.year = new Date().getFullYear();
  // Defaults so any template (including error pages) renders even if a middleware never ran.
  Object.assign(app.locals, { player: null, nav: null, flash: [], signedIn: false, csrfToken: '', unreadCount: 0, latestNotificationId: 0 });

  app.use(compression());
  app.use(securityHeaders);
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: production ? '7d' : 0,
      index: false,
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(express.json({ limit: '10kb' }));
  app.use(
    session({
      name: 'ef.sid',
      secret,
      store: new SQLiteStore(db),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );
  app.use((req, res, next) => {
    res.locals.signedIn = Boolean(req.session.userId);
    next();
  });
  app.use(flash);
  app.use(csrf);

  app.get('/', (req, res) => res.render('index', { title: null }));
  app.use(authRoutes(players));
  app.use(gameRoutes(players));
  app.use(armoryRoutes(players));
  app.use(hospitalRoutes(players));
  app.use(pvpRoutes(players));
  app.use(notificationRoutes(players));
  app.use(bankRoutes(players));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', status: 404, message: 'That grid reference doesn’t exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong at HQ. Try again shortly.' : err.message;
    if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
    res.status(status).render('error', { title: 'Error', status, message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`[eliteforces] Listening on http://localhost:${port}`);
  });
}

module.exports = { createApp };
