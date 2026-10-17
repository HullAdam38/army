/* GeneralForces service worker: offline page and push notifications.
   Served by the app at /sw.js with the asset version filled in, so it updates
   whenever the stylesheet or script changes. Game pages are never cached:
   they always come from the server. */
'use strict';

const VERSION = '__ASSET_VERSION__';
const CACHE = `gf-${VERSION}`;
const OFFLINE = ['/offline.html', '/css/main.css', '/js/app.js', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gf-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Page loads go to the network; when there's no connection, show the offline page.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // The offline page's own stylesheet, script and icons.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && OFFLINE.includes(url.pathname) && !url.search) {
    event.respondWith(fetch(req).catch(() => caches.match(url.pathname)));
  }
});

// A push from the server: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'GeneralForces';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/hq' },
  }));
});

// Tapping a notification opens the game at the right page, reusing an open window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/hq', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) return w.navigate(target.href);
        return undefined;
      }
    }
    return self.clients.openWindow(target.href);
  })());
});

// The browser replaced the push subscription: hand the new one to the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  const sub = event.newSubscription;
  if (!sub) return;
  event.waitUntil(fetch('/push/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old: event.oldSubscription ? event.oldSubscription.endpoint : null, subscription: sub.toJSON() }),
  }).catch(() => {}));
});
