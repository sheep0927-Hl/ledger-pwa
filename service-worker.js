/* 总账 Ledger PWA — Service Worker（U4 生产版）
 * 版本 ledger-pwa-prod-v1：activate 时清理所有旧 CACHE
 * （含 ledger-pwa-u4-readonly-v1 / ledger-pwa-v19 及任何旧名）。
 * 不缓存任何写请求，无 sync / periodicSync 监听。
 * 版本升级记录：u4-readonly-v1 → prod-v1。
 *   原因（强制）：u4-readonly-v1 时期线上曾部署过空占位 config.js，
 *   已被该版本 SW 持久缓存；config.js 必须换名重装，否则 cache-first
 *   会继续命中旧空配置，用户恒见「只读·未配置环境」。
 *   同时 config.js 取数策略改为 network-first（见 fetch），
 *   以后凭据轮换不再依赖 SW 版本升级。 */
const CACHE = 'ledger-pwa-prod-v1';
const ASSETS = [
  './',
  './index.html',
  './config.js',
  './readonly_guard.js',
  './app.js',
  './localdb.js',
  './piecework_sync.js',
  './final_wage.js',
  './final_wage_ui.js',
  './vendor/supabase.js',
  './style.css',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装：预缓存应用壳
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}).then(() => self.skipWaiting())
  );
});

// 激活：清理所有旧 CACHE（含 ledger-pwa-u4-readonly-v1 / ledger-pwa-v19 及任何旧名），只保留当前版本。
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 取数策略（U4 生产版）：
// - 任何非 GET 写请求：绝不缓存、绝不拦截（不缓存任何写请求）
// - 数据请求（Supabase API / 跨域）：network-first，直连网络、不缓存
// - ./config.js：network-first（网络成功→更新缓存并返回新配置；离线→回退缓存）。
//   配置必须保持最新，防止「空占位配置」或轮换前凭据被缓存长期覆盖生产注入。
// - 其余本地静态资源：cache-first，回退网络
// 不注册 sync / periodicSync 监听：只读端不做任何后台补推。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;                  // 写请求不拦截、不缓存
  if (url.origin.includes('supabase.co')) return;   // 数据请求 network-first（直连网络）

  if (url.origin === location.origin) {
    // config.js：network-first（配置单一真相源，缓存仅作离线回退）
    if (url.pathname.endsWith('/config.js')) {
      e.respondWith(
        fetch(req).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        }).catch(() => caches.match(req).then((cached) => cached || fetch(req)))
      );
      return;
    }
    e.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        }).catch(() => cached)
      )
    );
  }
});
