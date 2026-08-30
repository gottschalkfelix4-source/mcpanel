/**
 * Service Worker für MCPanel.
 *
 * Strategie:
 *   - /api und /socket.io werden NIE angefasst – Serversteuerung braucht
 *     immer den echten Zustand, ein Cache wäre hier gefährlich.
 *   - Gehashte Assets (/assets/…) sind unveränderlich → cache-first.
 *   - Navigationen (index.html) → network-first mit Cache-Fallback, damit
 *     die App-Hülle auch bei kurzem Verbindungsverlust noch öffnet.
 */
const CACHE = 'mcpanel-v1';
const APP_SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live-Daten niemals cachen
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Unveränderliche, gehashte Bundles: cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // App-Hülle (Navigationen, Icons, Manifest): network-first
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        // Offline-Navigation: zuletzt bekannte Hülle liefern
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
