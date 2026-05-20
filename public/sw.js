// Minimal service worker for PWA installability on Chrome Android.
// No caching — just enough to make the app installable.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
