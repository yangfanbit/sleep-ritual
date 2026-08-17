/* Sleep Ritual — Service Worker
   策略：App Shell 预缓存（cache-first），其余请求网络优先并回退缓存。
   保证离线可打开、首页秒开。 */

const CACHE = "sleep-ritual-v7";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/content.js",
  "./js/db.js",
  "./js/app.js",
  "./data/seed-content.json",
  "./data/seed-actions.json",
  "./manifest.webmanifest",
  "./assets/icons/icon-180.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // 不调用 skipWaiting：让新 SW 进入 waiting，
  // 等用户在应用内点击“更新”后由 app 通过 postMessage 触发 skipWaiting。
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok && resp.type === "basic") {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
