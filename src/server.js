'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const compression = require('compression');

const { openDatabase } = require('./db');
const { SQLiteStore } = require('./session-store');
const { createPlayerRepo } = require('./players');
const { actionRateLimit, createSecurityHeaders, csrf, flash, wantsJson } = require('./middleware');
const { authRoutes } = require('./routes/auth');
const { gameRoutes } = require('./routes/game');
const { armoryRoutes } = require('./routes/armory');
const { hospitalRoutes } = require('./routes/hospital');
const { pvpRoutes } = require('./routes/pvp');
const { notificationRoutes } = require('./routes/notifications');
const { bankRoutes } = require('./routes/bank');
const { trainingRoutes } = require('./routes/training');
const { leaderboardRoutes } = require('./routes/leaderboards');
const { accountRoutes } = require('./routes/account');
const { dailyRoutes } = require('./routes/daily');
const { unitRoutes } = require('./routes/units');
const { createUnitRepo } = require('./units-repo');
const { createWarService } = require('./war-service');
const { createMedalService } = require('./medal-service');
const { medalRoutes } = require('./routes/medals');
const { createBountyService } = require('./bounty-service');
const { bountyRoutes } = require('./routes/bounties');
const { createTutorialService } = require('./tutorial-service');
const { termsRoutes } = require('./routes/terms');
const { legalSettings } = require('./legal');
const { createMessageService } = require('./message-service');
const { messageRoutes } = require('./routes/messages');
const { formatRoutes } = require('./routes/format');
const { createOperationService } = require('./operation-service');
const { createEventService } = require('./event-service');
const { eventRoutes } = require('./routes/events');
const { createBaseService } = require('./base-service');
const { baseRoutes } = require('./routes/base');
const { adminRoutes } = require('./routes/admin');
const { createAdminRepo } = require('./admin-repo');
const { createAntiCheat } = require('./anticheat');
const { createDailyService } = require('./daily-service');
const pkg = require('../package.json');

/**
 * TRUST_PROXY: unset → 'loopback' in production (proxy on the same server), off in dev.
 * A number (e.g. 1) trusts that many proxy hops; 'false' disables; anything else
 * (e.g. 'loopback' or an IP/subnet list) is passed straight to Express.
 */
function trustProxySetting(value, production) {
  if (value === undefined || value === '') return production ? 'loopback' : false;
  if (value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function createApp({
  db = openDatabase(),
  secret = process.env.SESSION_SECRET,
  production = process.env.NODE_ENV === 'production',
  scanHours = Number(process.env.ANTICHEAT_SCAN_HOURS) || 6,
  tutorial = true, // tests of other systems turn tutorial rewards off so cash stays predictable
} = {}) {
  if (!secret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('[eliteforces] SESSION_SECRET not set; using a random one. Sessions reset on restart.');
  }

  const app = express();
  const players = createPlayerRepo(db);
  const anti = createAntiCheat(db, players, { secret });
  app.anti = anti; // exposed for tests and maintenance scripts
  anti.schedule(scanHours);
  const eventService = createEventService(db);
  eventService.schedule();
  const effects = (now) => eventService.effects(now);
  const daily = createDailyService(db, players, { effects });
  const unitRepo = createUnitRepo(db);
  const warService = createWarService(db, players, unitRepo, { effects });
  warService.schedule();
  const bountyService = createBountyService(db, players, (a, b, now) => anti.linked(a, b, now), { effects });
  bountyService.schedule();
  const medalService = createMedalService(db, players);
  app.medals = medalService; // exposed for tests
  const tutorialService = createTutorialService(db, players, { enabled: tutorial });
  const messageService = createMessageService(db, players);
  const operationService = createOperationService(db, players);
  const baseService = createBaseService(db, players);
  baseService.schedule();
  const adminRepo = createAdminRepo(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // Behind a reverse proxy (nginx, Caddy…) Express must trust it to see HTTPS and
  // real client IPs; without this, secure session cookies are never sent. In
  // production we trust a proxy on the same machine by default.
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY, production));
  app.disable('x-powered-by');

  app.locals.assetVersion = pkg.version;
  app.locals.siteName = 'EliteForces';
  app.locals.year = new Date().getFullYear();
  app.locals.legal = legalSettings();
  if (production && app.locals.legal.missing.length) {
    console.warn(`[eliteforces] The Terms of Service show placeholders until you set: ${app.locals.legal.missing.join(', ')}.`);
  }
  // Defaults so any template (including error pages) renders even if a middleware never ran.
  Object.assign(app.locals, { player: null, nav: null, flash: [], signedIn: false, csrfToken: '', unreadCount: 0, unreadMessages: 0, liveEvents: [], latestNotificationId: 0, isAdmin: false });

  app.use(compression());
  app.use(createSecurityHeaders({ production }));
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
  app.use(anti.deviceCookie({ production }));
  app.use(flash);
  app.use(eventService.locals());
  app.use(csrf);
  app.use(actionRateLimit());
  app.use(anti.actionTracker());
  app.use(tutorialService.tracker());
  app.use(medalService.tracker());

  app.get('/', (req, res) => res.render('index', { title: null }));
  app.use(authRoutes(players, anti));
  app.use(termsRoutes(players));
  app.use(gameRoutes(players, daily, unitRepo, warService, medalService, bountyService, tutorialService, operationService, eventService));
  app.use(armoryRoutes(players));
  app.use(hospitalRoutes(players));
  app.use(pvpRoutes(players, anti, daily, warService, bountyService));
  app.use(notificationRoutes(players));
  app.use(bankRoutes(players));
  app.use(trainingRoutes(players, daily));
  app.use(leaderboardRoutes(players, db));
  app.use(dailyRoutes(players, daily));
  app.use(medalRoutes(players, medalService));
  app.use(bountyRoutes(players, bountyService, effects));
  app.use(formatRoutes(players));
  app.use(baseRoutes(players, baseService));
  app.use(messageRoutes(players, messageService));
  app.use(unitRoutes(players, unitRepo, adminRepo, warService));
  app.use(accountRoutes(players));
  app.use(eventRoutes(players, eventService, adminRepo));
  app.use(adminRoutes(players, adminRepo, anti, messageService));

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
