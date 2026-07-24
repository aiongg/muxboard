// Muxboard service worker: offline-first app shell, network-only API.
// The shell must load with Tailscale off so the app can say "turn on Tailscale".
const VERSION = 'muxboard-v1';
const SHELL = [
  '/', '/style.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/fonts/jbmono-400.woff2', '/fonts/jbmono-500.woff2', '/fonts/jbmono-700.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // network only, app handles failures

  e.respondWith(
    caches.match(e.request.mode === 'navigate' ? '/' : e.request).then(hit => {
      const refresh = fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(VERSION).then(c => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
          }
          return resp;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
