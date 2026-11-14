/* CAIRN service worker: the planner keeps working with no network (astronauts on Mars won't have one).
   Built by vite.config.ts, which fills in the version and the list of app files. */
const VERSION = "__VERSION__";
const SHELL = `cairn-shell-${VERSION}`;
const DATA = `cairn-data-__DATA_VERSION__`;
const APP_FILES = __APP_FILES__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("cairn-") && k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // the page itself: network first, so a new version shows up; the cached copy when offline
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("index.html", copy));
          return res;
        })
        .catch(() => caches.match("index.html", { ignoreSearch: true, ignoreVary: true })),
    );
    return;
  }

  // app files and mission data: from the cache when we have them, otherwise fetch and keep a copy.
  // ignoreVary: module scripts are requested with an Origin header that the precache request lacked,
  // and servers that answer "Vary: Origin" would otherwise never match the stored copy.
  event.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(url.pathname.includes("/data/") ? DATA : SHELL).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
