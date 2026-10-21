'use strict';

const path = require('node:path');
const fs = require('node:fs');
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
const { createContractService } = require('./contract-service');
const { contractRoutes } = require('./routes/contracts');
const { createTutorialService } = require('./tutorial-service');
const { termsRoutes } = require('./routes/terms');
const { legalSettings } = require('./legal');
const game = require('./game');
const cosmeticsCatalogue = require('./cosmetics');
const { createMessageService } = require('./message-service');
const { messageRoutes } = require('./routes/messages');
const { formatRoutes } = require('./routes/format');
const { createOperationService } = require('./operation-service');
const { createEventService } = require('./event-service');
const { eventRoutes } = require('./routes/events');
const { createBaseService } = require('./base-service');
const { baseRoutes } = require('./routes/base');
const { createDeploymentService } = require('./deployment-service');
const { deploymentRoutes } = require('./routes/deployments');
const { createSeasonService } = require('./season-service');
const { seasonRoutes } = require('./routes/seasons');
const { createChatService } = require('./chat-service');
const { chatRoutes } = require('./routes/chat');
const { createSettingsService } = require('./settings-service');
const { settingsRoutes } = require('./routes/settings');
const { createObjectiveService } = require('./objective-service');
const { createRaidService } = require('./raid-service');
const { createVehicleService } = require('./vehicle-service');
const { createWorkshopService } = require('./workshop-service');
const { createServiceRecord } = require('./service-record');
const { createSpecialOpService } = require('./special-op-service');
const { createMarketService } = require('./market-service');
const { createPatchNotes } = require('./patch-notes');
const { updateRoutes } = require('./routes/updates');
const { createTheatreService } = require('./theatre-service');
const { createSupportService } = require('./support-service');
const { createCasinoService } = require('./casino-service');
const { createBlackjackService } = require('./blackjack-service');
const { createCasinoPlayer } = require('./casino-player');
const { createReserveService } = require('./reserve-service');
const { createHealthService } = require('./health-service');
const { createReferralService } = require('./referral-service');
const { createCosmeticService } = require('./cosmetic-service');
const { createSupporterService } = require('./supporter-service');
const { supporterRoutes, supporterWebhook } = require('./routes/supporter');
const { createServerSettings, defaultFile: defaultSettingsFile } = require('./server-settings');
const { createTargetService } = require('./target-service');
const { createAvatarService, MAX_UPLOAD_BYTES } = require('./avatar-service');
const { avatarRoutes } = require('./routes/avatars');
const { multipart } = require('./multipart');
const { createPushService } = require('./push-service');
const { alertRoutes, pushRenewRoute } = require('./routes/alerts');
const { adminRoutes } = require('./routes/admin');
const { theatreRoutes } = require('./routes/theatre');
const { supportRoutes } = require('./routes/support');
const { casinoRoutes } = require('./routes/casino');
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

/** Short hash of the stylesheet and script, used to bust browser caches. */
function assetHash() {
  const hash = crypto.createHash('sha256').update(pkg.version);
  for (const file of ['css/main.css', 'js/app.js']) {
    try {
      hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', file)));
    } catch {
      // A missing file just leaves the version out of the hash.
    }
  }
  return hash.digest('hex').slice(0, 12);
}

function createApp({
  db = openDatabase(),
  secret = process.env.SESSION_SECRET,
  production = process.env.NODE_ENV === 'production',
  scanHours = Number(process.env.ANTICHEAT_SCAN_HOURS) || 6,
  tutorial = true, // tests of other systems turn tutorial rewards off so cash stays predictable
  pushSender = null, // tests pass a fake push sender; null uses web-push
  backupStatusFile = null, // tests point this at their own file; null reads it from next to the database
  serverSettingsFile = null, // tests point this at their own file; null uses admin-settings.env next to the database
} = {}) {
  if (!secret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('[generalforces] SESSION_SECRET not set; using a random one. Sessions reset on restart.');
  }

  const app = express();
  const players = createPlayerRepo(db);
  app.players = players; // exposed for tests
  // Admin game settings load first: every rule below reads them (src/tuning.js).
  const settingsService = createSettingsService(db);
  settingsService.load();
  const anti = createAntiCheat(db, players, { secret, settings: settingsService });
  app.anti = anti; // exposed for tests and maintenance scripts
  // Cosmetics: what players and units own and wear (src/cosmetics.js).
  const cosmeticService = createCosmeticService(db);
  app.cosmetics = cosmeticService; // exposed for tests
  // The motor pool: vehicles and their bonuses (src/vehicles.js).
  const vehicleService = createVehicleService(db, players);
  app.vehicles = vehicleService; // exposed for tests
  // The workshop: materials, upgrades and salvage (src/workshop.js).
  const workshopService = createWorkshopService(db, players, vehicleService);
  app.workshop = workshopService; // exposed for tests
  // Special operations: every 6 hours, open for 3 (src/special-ops.js).
  const specialOpService = createSpecialOpService(db, players, { vehicleService, workshopService });
  app.specialOps = specialOpService; // exposed for tests
  const patchNotes = createPatchNotes(db); // Admin › Patch notes and /updates
  // Recruit a friend: invite links, and rewards once a recruit has really played.
  const referralService = createReferralService(db, players, anti);
  app.referrals = referralService; // exposed for tests
  anti.schedule(scanHours);
  // Push alerts listen to every in-game notification, so they're set up early.
  const pushService = createPushService(db, players, { sender: pushSender });
  pushService.schedule();
  app.push = pushService; // exposed for tests
  // Support tickets: admins hear about new tickets and replies in-game and by push.
  const supportService = createSupportService(db, players, { alertStaff: (adminId, message, link) => pushService.staff(adminId, message, link) });
  // Server errors and the nightly backup's report, for Admin › Launch checklist.
  const healthService = createHealthService(db, players, { push: pushService, ...(backupStatusFile ? { backupStatusFile } : {}) });
  healthService.schedule();
  app.health = healthService; // exposed for tests
  supportService.schedule();
  app.support = supportService; // exposed for tests
  const casinoPlayer = createCasinoPlayer(db);
  const casinoService = createCasinoService(db, players, casinoPlayer);
  casinoService.schedule();
  app.casino = casinoService; // exposed for tests
  const blackjackService = createBlackjackService(db, players, { casinoPlayer });
  blackjackService.schedule();
  app.blackjack = blackjackService; // exposed for tests
  const eventService = createEventService(db, {
    onAnnounce: (message, link) => pushService.broadcast('news', message, link).catch((err) => console.error('[push] broadcast failed', err)),
  });
  eventService.schedule();
  const effects = (now) => eventService.effects(now);
  const daily = createDailyService(db, players, { effects, hasVehicle: (userId) => vehicleService.owned(userId).size > 0 });
  app.daily = daily; // exposed for tests
  const unitRepo = createUnitRepo(db, { rankCacheMs: 60 * 1000 });
  // Weekly unit objectives count the same actions as daily orders, plus deployments and donations.
  const objectiveService = createObjectiveService(db, players, unitRepo);
  app.objectives = objectiveService; // exposed for tests
  // The theatre of war scores the same play on each unit's weekly front, plus raid strikes.
  const theatreService = createTheatreService(db, players, unitRepo);
  theatreService.schedule();
  app.theatre = theatreService; // exposed for tests
  const OBJECTIVE_METRICS = { missions_won: 'missions', pvp_wins: 'pvp_wins', training: 'training' };
  daily.onProgress((userId, type, amount, now) => {
    if (!OBJECTIVE_METRICS[type]) return;
    objectiveService.track(userId, OBJECTIVE_METRICS[type], amount, now);
    theatreService.track(userId, OBJECTIVE_METRICS[type], amount, now);
  });
  const raidService = createRaidService(db, players, unitRepo, { vehicles: vehicleService, onStrike: (userId, now) => theatreService.track(userId, 'raid_strikes', 1, now) });
  raidService.schedule();
  app.raids = raidService; // exposed for tests
  // Reserve soldiers keep a young world busy (src/reserve.js). The first tick runs at start-up (see below).
  const reserveService = createReserveService(db, players, unitRepo);
  reserveService.schedule();
  app.reserve = reserveService; // exposed for tests
  const targetService = createTargetService(db, players);
  targetService.schedule();
  app.target = targetService; // exposed for tests
  const warService = createWarService(db, players, unitRepo, { effects });
  warService.schedule();
  const bountyService = createBountyService(db, players, (a, b, now) => anti.linked(a, b, now), { effects });
  // The market: players selling gear, vehicles and materials to each other (src/market.js).
  const marketService = createMarketService(db, players, { vehicleService, workshopService, isLinked: (a, b, now) => anti.linked(a, b, now) });
  marketService.schedule();
  app.market = marketService; // exposed for tests
  const contractService = createContractService(db, players, (a, b, now) => anti.linked(a, b, now));
  contractService.schedule();
  app.contracts = contractService; // exposed for tests
  bountyService.schedule();
  const medalService = createMedalService(db, players);
  app.medals = medalService; // exposed for tests
  const tutorialService = createTutorialService(db, players, { enabled: tutorial });
  const messageService = createMessageService(db, players);
  const operationService = createOperationService(db, players);
  const baseService = createBaseService(db, players);
  baseService.schedule();
  const deploymentService = createDeploymentService(db, players, { effects, vehicles: vehicleService, workshop: workshopService, onReturn: (userId, now) => {
    objectiveService.track(userId, 'deployments', 1, now);
    theatreService.track(userId, 'deployments', 1, now);
    if (vehicleService.assigned(userId)) daily.progress(userId, 'vehicle_deploy', 1, { now }); // a motor pool daily order
  } });
  deploymentService.schedule();
  app.deployments = deploymentService; // exposed for tests
  const seasonService = createSeasonService(db, players);
  seasonService.schedule();
  app.seasons = seasonService; // exposed for tests
  const chatService = createChatService(db, players);
  chatService.schedule();
  const avatarService = createAvatarService(db, players);
  // Supporter membership: paid through Lemon Squeezy, or gifted by HQ. When one ends, Supporter-only looks come off.
  const supporterService = createSupporterService(db, players, {
    onLapse: (userId, now) => { cosmeticService.tidy(userId, now); avatarService.tidyBadge(userId, now); },
  });
  supporterService.schedule();
  app.supporters = supporterService; // exposed for tests
  app.avatars = avatarService; // exposed for tests
  const adminRepo = createAdminRepo(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // Behind a reverse proxy (nginx, Caddy…) Express must trust it to see HTTPS and
  // real client IPs; without this, secure session cookies are never sent. In
  // production we trust a proxy on the same machine by default.
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY, production));
  app.disable('x-powered-by');

  // Browsers cache CSS and JS for a week, so the URL carries a hash of their
  // contents: any change gets a new URL and every player picks it up at once.
  app.locals.assetVersion = assetHash();
  app.locals.siteName = 'GeneralForces';
  // Where a player's avatar image lives; `v` changes whenever they change it (see avatar-service).
  app.locals.avatarUrl = (id, v) => `/avatars/${id}?v=${v || 0}`;
  app.locals.year = new Date().getFullYear();
  // Cosmetics in templates: a callsign colour (inline style), profile banner and unit crest classes.
  app.locals.nameStyle = cosmeticsCatalogue.nameStyle;
  app.locals.bannerClass = (id) => cosmeticsCatalogue.cssClass('profile-hero', id, 'banner');
  app.locals.crestClass = (id) => cosmeticsCatalogue.cssClass('unit-crest', id, 'crest');
  // Settings admins can change on Admin › Server settings override the settings file.
  const serverSettings = createServerSettings(serverSettingsFile || defaultSettingsFile());
  app.locals.legal = legalSettings();
  if (production && app.locals.legal.missing.length) {
    console.warn(`[generalforces] The Terms of Service show placeholders until you set: ${app.locals.legal.missing.join(', ')}.`);
  }
  // Defaults so any template (including error pages) renders even if a middleware never ran.
  Object.assign(app.locals, { siteUrl: '', canonicalPath: '/', player: null, nav: null, flash: [], signedIn: false, csrfToken: '', unreadCount: 0, unreadMessages: 0, chatUnread: { unit: 0, global: false }, liveEvents: [], latestNotificationId: 0, isAdmin: false });

  app.use(compression());
  app.use(createSecurityHeaders({ production }));
  // The site's address for links search engines and link previews keep: SITE_URL
  // if set (e.g. https://generalforces.com), otherwise the address it was reached on.
  app.use((req, res, next) => {
    // The Host header is the visitor's to set, so only a plain host name is used (it ends up in the sitemap and share links).
    const host = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(req.get('host') || '') ? req.get('host') : 'localhost';
    res.locals.siteUrl = (process.env.SITE_URL || `${req.protocol}://${host}`).replace(/\/$/, '');
    res.locals.canonicalPath = req.path;
    next();
  });
  // For search engines: what to crawl (the public pages), and where they are.
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(['User-agent: *', 'Allow: /$', 'Allow: /register', 'Allow: /login', 'Allow: /terms', 'Allow: /updates', 'Allow: /img/', 'Allow: /css/', 'Allow: /js/',
      'Disallow: /', '', `Sitemap: ${res.locals.siteUrl}/sitemap.xml`, ''].join('\n'));
  });
  app.get('/sitemap.xml', (req, res) => {
    const urls = ['/', '/register', '/login', '/terms', '/updates'].map((p) => `  <url><loc>${res.locals.siteUrl}${p}</loc></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });
  // The payment provider's webhook: raw body for its signature, no session or CSRF (see routes/supporter.js).
  app.use(supporterWebhook(supporterService));
  // Uptime check for outside monitors: "ok" while the game and its database answer.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (healthService.ok()) return res.type('text/plain').send('ok');
    res.status(503).type('text/plain').send('database unavailable');
  });
  // The service worker (installable app, offline page, push). Browsers must
  // always check it for updates, so it skips the week-long static cache.
  const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8').replace('__ASSET_VERSION__', app.locals.assetVersion);
  app.get('/sw.js', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.send(swSource);
  });
  // Static files all have an extension; page URLs don't, so they skip the disk check.
  const serveStatic = express.static(path.join(__dirname, '..', 'public'), { maxAge: production ? '7d' : 0, index: false });
  app.use((req, res, next) => (/\.[a-z0-9]+$/i.test(req.path) ? serveStatic(req, res, next) : next()));
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
  // File uploads are read before the CSRF check, which needs their _csrf field.
  app.use(multipart({ paths: ['/account/avatar/upload'], maxBytes: MAX_UPLOAD_BYTES }));
  app.use(pushRenewRoute(pushService));
  app.use(eventService.locals());
  app.use(csrf);
  app.use(actionRateLimit());
  app.use(anti.actionTracker());
  app.use(tutorialService.tracker());
  app.use(medalService.tracker());
  app.use(referralService.tracker());

  app.get('/', (req, res) => res.render('index', {
    title: null,
    facts: { missions: game.MISSIONS.length, ranks: game.RANKS.length },
    shots: [
      { file: 'missions', caption: 'Run missions.', text: 'Six campaigns, from perimeter patrols to the enemy capital.', alt: 'The missions page, with mission cards showing energy cost and chance of success' },
      { file: 'special', caption: 'Special operations.', text: 'Every 6 hours: three stages, stealth or assault, big rewards.', alt: 'A special operation with a choice of stealth or assault for its next stage' },
      { file: 'battle', caption: 'Fight other players.', text: 'Every attack is fought blow by blow, with a full battle report.', alt: 'A battle report between two soldiers, round by round' },
      { file: 'unit', caption: 'Join a unit.', text: 'A chain of command, a treasury, raids and a unit board.', alt: 'A unit page with its roster, treasury and an active raid' },
      { file: 'theatre', caption: 'Take the map.', text: 'Units fight weekly for regions that pay out every day.', alt: 'The theatre of war map, with regions held by different units' },
      { file: 'motorpool', caption: 'Build a motor pool.', text: 'Jeeps, trucks and tanks, upgraded in the workshop.', alt: 'The motor pool, with vehicles, their bonuses and condition' },
      { file: 'market', caption: 'Trade.', text: 'Buy and sell gear, vehicles and materials with other soldiers.', alt: 'The market, with gear, a vehicle and materials for sale' },
      { file: 'casino', caption: 'Try your luck.', text: 'Slots, roulette and multiplayer blackjack, for in-game cash only.', alt: 'The roulette table at the casino' },
    ],
  }));
  app.use(authRoutes(players, anti, referralService));
  app.use(termsRoutes(players));
  app.use(gameRoutes(players, daily, unitRepo, warService, medalService, bountyService, tutorialService, operationService, eventService, seasonService, targetService, theatreService, vehicleService, workshopService, createServiceRecord(db), specialOpService, patchNotes));
  app.use(armoryRoutes(players, vehicleService, workshopService, marketService));
  app.use(hospitalRoutes(players));
  app.use(pvpRoutes(players, anti, daily, warService, bountyService, seasonService, targetService, contractService));
  app.use(notificationRoutes(players, pushService));
  app.use(bankRoutes(players));
  app.use(trainingRoutes(players, daily));
  app.use(leaderboardRoutes(players, db));
  app.use(dailyRoutes(players, daily));
  app.use(medalRoutes(players, medalService));
  app.use(bountyRoutes(players, bountyService, effects));
  app.use(contractRoutes(players, contractService));
  app.use(formatRoutes(players));
  app.use(baseRoutes(players, baseService));
  app.use(deploymentRoutes(players, deploymentService));
  app.use(seasonRoutes(players, seasonService, adminRepo));
  app.use(chatRoutes(players, chatService, unitRepo, adminRepo));
  app.use(settingsRoutes(players, settingsService, adminRepo));
  app.use(avatarRoutes(players, avatarService, adminRepo));
  app.use(alertRoutes(players, pushService));
  app.use(messageRoutes(players, messageService, pushService));
  app.use(unitRoutes(players, unitRepo, adminRepo, warService, objectiveService, raidService, theatreService, cosmeticService));
  app.use(theatreRoutes(players, unitRepo, theatreService));
  app.use(supportRoutes(players, supportService));
  app.use(casinoRoutes(players, casinoService, blackjackService));
  app.use(accountRoutes(players, medalService, referralService, cosmeticService));
  app.use(supporterRoutes(players, supporterService));
  app.use(eventRoutes(players, eventService, adminRepo));
  app.use(updateRoutes(players, patchNotes, adminRepo));
  app.use(adminRoutes(players, adminRepo, anti, messageService, seasonService, chatService, avatarService, pushService, unitRepo, raidService, theatreService, supportService, {
    health: healthService,
    reserve: reserveService,
    cosmetics: cosmeticService,
    supporters: supporterService,
    vehicles: vehicleService,
    workshop: workshopService,
    production,
    serverSettings,
    onServerSettings: () => { app.locals.legal = legalSettings(); }, // the terms pick up new details at once
  }));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', status: 404, message: 'That grid reference doesn’t exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(err);
      healthService.record(err, req);
    }
    const message = status >= 500 ? 'Something went wrong at HQ. Try again shortly.' : err.message;
    if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
    res.status(status).render('error', { title: 'Error', status, message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`[generalforces] Listening on http://localhost:${port}`);
    try {
      const r = app.reserve.tick();
      if (r.enlisted || r.stoodDown) console.log(`[reserve] ${r.enlisted} reserve soldiers enlisted, ${r.stoodDown} stood down (${r.want} wanted).`);
    } catch (err) { console.error('[reserve] first tick failed', err); }
  });
}

module.exports = { createApp };
