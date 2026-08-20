/* Sleep Ritual — Service Worker
   策略：App Shell 预缓存（cache-first），其余请求网络优先并回退缓存。
   保证离线可打开、首页秒开。

   版本协同：每次修改 JS 资源必须同步 bump CACHE（v11→v12…），
   否则真机会继续使用旧缓存导致「GitHub 已更新但手机没变化」。 */

const CACHE = "sleep-ritual-v13";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  // 所有 JS 模块都必须进 App Shell 预缓存：
  // date-utils 是统一日期工具（cutoff/本地日期/安全格式化），其余模块依赖它；
  // anchor/content-selector/analytics 是 Phase 4–6 新增；
  // 若遗漏任一，离线打开对应页面会因 window.* 未定义而崩溃。
  "./js/date-utils.js",
  "./js/content.js",
  "./js/db.js",
  "./js/anchor.js",
  "./js/content-selector.js",
  "./js/analytics.js",
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

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() =>
        // 向所有受控页面广播当前 SW cache 版本，供设置页「版本诊断」显示
        self.clients.matchAll({ includeUncontrolled: true }).then((cls) =>
          cls.forEach((c) =>
            c.postMessage({ type: "SW_CACHE_VERSION", version: CACHE })
          )
        )
      )
  );
});

// 新 SW 安装后也主动报告一次版本（页面可据此提示「新版本已就绪」）
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
  if (e.data === "GET_CACHE_VERSION" && e.source) {
    e.source.postMessage({ type: "SW_CACHE_VERSION", version: CACHE });
  }
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
