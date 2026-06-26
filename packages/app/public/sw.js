// Minimal service worker. It exists ONLY to satisfy the browser's
// installability criteria (Chrome/Edge won't offer "Install" without a
// registered SW). It deliberately has NO fetch handler, so it never caches
// or intercepts a single request: the app is useless offline anyway, and the
// binary serves a fresh UI on every load (no stale-cache failure mode).
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
