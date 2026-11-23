/* 总账 Ledger PWA — Service Worker（U4 生产版）
 * 版本 ledger-pwa-prod-v2：activate 时清理所有旧 CACHE
 * （含 ledger-pwa-prod-v1 / ledger-pwa-u4-readonly-v1 / ledger-pwa-v19 及任何旧名）。
 * 不缓存任何写请求，无 sync / periodicSync 监听。
 * 版本升级记录：
 *   u4-readonly-v1 → prod-v1：清理空占位 config.js 旧缓存 + config 改 network-first。
 *   prod-v1 → prod-v2（2026-11-23）：
 *     ① config.js 升级为 network-only（离线绝不回退旧缓存，fail-closed）；
 *     ② precache 列表移除 config.js（不再缓存配置文件）。
 *     配套 app.js 修复：OFFLINE_READONLY 判定不再包含 LEDGER_READ_ONLY
 *     （旧判定使 READ_ONLY:true 恒锁死离线只读，即使凭据注入成功）。 */
const CACHE = 'ledger-pwa-prod-v2';
const ASSETS = [
  './',
  './index.html',
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

// 取数策略（U4 生产版 v2）：
// - 任何非 GET 写请求：绝不缓存、绝不拦截（不缓存任何写请求）
// - 数据请求（Supabase API / 跨域）：network-first，直连网络、不缓存
// - ./config.js：network-only（绝不读缓存、绝不写缓存）。
//   理由（强制）：v1 时期线上曾部署过空占位 config.js 并被旧 SW 持久缓存；
//   network-first 的「离线回退缓存」路径仍可能返回陈旧/空配置。
//   network-only 下离线时 config.js 加载失败 → app.js 判定 !LEDGER_CFG →
//   降级离线只读（fail-closed），绝不会被旧空配置覆盖生产注入。
// - 其余本地静态资源：cache-first，回退网络
// 不注册 sync / periodicSync 监听：只读端不做任何后台补推。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;                  // 写请求不拦截、不缓存
  if (url.origin.includes('supabase.co')) return;   // 数据请求 network-first（直连网络）

  if (url.origin === location.origin) {
    // config.js：network-only（配置单一真相源，禁止任何缓存回退）
    if (url.pathname.endsWith('/config.js')) {
      e.respondWith(fetch(req));
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
