// 離線快取：先回快取、背景更新（stale-while-revalidate）
// 同一個網域（laiyimin.github.io）下可能還有舊版 app，快取名稱加上自己的前綴，只清自己的舊快取
const PREFIX = "pickle-party-";
const CACHE = `${PREFIX}v20`;
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/parser.js",
  "js/scheduler.js",
  "js/cloud.js",
  "js/doodles.js",
  "js/flow.js",
  "js/ops.js",
  "js/worker.js",
  "js/firebase-config.js",
  "manifest.webmanifest",
  "icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
