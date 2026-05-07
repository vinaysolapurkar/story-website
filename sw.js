// Service worker for "Stories of the Masters"
// Bump VERSION on every release so old caches are evicted.
const VERSION = "v7";
const CORE = `core-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./stories.json",
  "./audio_manifest.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CORE).then(c => c.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CORE && k !== RUNTIME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin (Google Fonts): cache-first, fall back to network
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.open(RUNTIME).then(cache =>
        cache.match(req).then(hit => hit || fetch(req).then(resp => {
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        }).catch(() => hit))
      )
    );
    return;
  }

  // Navigation requests: network-first with cache fallback (so updates land fast online)
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req).then(resp => {
        const clone = resp.clone();
        caches.open(CORE).then(c => c.put("./index.html", clone));
        return resp;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Don't cache /api/* — bookmarks/auth must always be live
  if (url.pathname.startsWith("/api/")) {
    return; // let it fall through to network
  }

  // Same-origin static assets (JSON, icons, manifest): cache-first, network fallback
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(RUNTIME).then(c => c.put(req, clone));
      }
      return resp;
    }))
  );
});
