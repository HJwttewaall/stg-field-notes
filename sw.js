// Offline cache so the app opens at a listing with no signal. Bump VERSION on every deploy.
const VERSION = "stg-field-notes-v6";
const ASSETS = ["./", "app.css","app.js","details-layout.json","details-page-1.png","details-page-2.png","details-page-3.png","details-page-4.png","details-page-5.png","details-page-6.png","icon-180.png","icon-192.png","icon-512.png","index.html","jspdf.umd.min.js","lead-layout.json","lead-page-1.png","lead-page-2.png","lead-room-card.png","lead-rooms-page.png","manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (updates arrive when online), cache fallback (works offline).
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
