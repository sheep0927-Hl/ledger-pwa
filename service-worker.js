/* 总账 Ledger PWA — Service Worker（U4 生产版）
 * 版本 ledger-pwa-prod-v3：activate 时清理所有旧 CACHE
 * （含 ledger-pwa-prod-v2 / ledger-pwa-prod-v1 / ledger-pwa-u4-readonly-v1 / ledger-pwa-v19 及任何旧名）。
 * 不缓存任何写请求，无 sync / periodicSync 监听。
 * 版本升级记录：
 *   u4-readonly-v1 → prod-v1：清理空占位 config.js 旧缓存 + config 改 network-first。
 *   prod-v1 → prod-v2（2026-11-23）：
 *     ① config.js 升级为 network-only（离线绝不回退旧缓存，fail-closed）；
 *     ② precache 列表移除 config.js（不再缓存配置文件）。
 *     配套 app.js 修复：OFFLINE_READONLY 判定不再包含 LEDGER_READ_ONLY
 *     （旧判定使 READ_ONLY:true 恒锁死离线只读，即使凭据注入成功）。
 *   prod-v2 → prod-v3（2026-11-25）：
 *     根因：v2 对所有同源 .js（含 final_wage_ui.js / app.js）走 cache-first，
 *     2026-11-24 的价格簿合并修复只改了 final_wage_ui.js 而未改 SW 字节，
 *     旧 SW 不会被安装、activate 不触发、缓存不清理 → iPhone 一直命中旧
 *     final_wage_ui.js（无价格合并），工资仍显示修复前的 ¥387。用户手动刷新
 *     对 cache-first 无效。
 *     修复：① CACHE 版本升级 v3（字节变化 → 浏览器必然安装新 SW → activate
 *     清旧缓存 → clients.claim → controllerchange → app.js 自动 reload）；
 *     ② 所有同源 .js 从 cache-first 改为 network-first（网络优先，成功即回写
 *     缓存；断网回退缓存仍可离线启动）。此后任何单次 JS 修复都无需再升 SW 版本
 *     即可从网络取到最新文件，从机制上消除「改了 JS 但旧缓存不更新」的整类问题。 */
const CACHE = 'ledger-pwa-prod-v3';
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

// 安装：预缓存应用壳（config.js 永不 precache）
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}).then(() => self.skipWaiting())
  );
});

// 激活：清理所有旧 CACHE（含 v2/v1/u4-readonly-v1/v19 及任何旧名），只保留当前版本。
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 取数策略（U4 生产版 v3）：
// - 任何非 GET 写请求：绝不缓存、绝不拦截（不缓存任何写请求）
// - 数据请求（Supabase API / 跨域）：不拦截（直连网络）
// - ./config.js：network-only（绝不读缓存、绝不写缓存，fail-closed）。
// - 同源 .js（app.js / final_wage*.js / 等）：network-first。
//   网络成功即回写缓存并返回最新；网络失败才回退缓存（保证离线可启动）。
//   这是本次 v3 的核心：确保任一 JS 修复后，页面网络可用时必取最新文件。
// - 其余本地静态资源（html/css/icons）：cache-first，回退网络。
// 不注册 sync / periodicSync 监听：只读端不做任何后台补推。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;                  // 写请求不拦截、不缓存
  if (url.origin.includes('supabase.co')) return;   // 数据请求直连网络

  if (url.origin === location.origin) {
    // config.js：network-only（配置单一真相源，禁止任何缓存回退）
    if (url.pathname.endsWith('/config.js')) {
      e.respondWith(fetch(req));
      return;
    }
    // JS 文件：network-first（v3 核心改动，杜绝旧版 JS 缓存钉死）
    if (url.pathname.endsWith('.js')) {
      e.respondWith(
        fetch(req).then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        }).catch(() => caches.match(req))
      );
      return;
    }
    // 其余同源静态资源：cache-first，回退网络
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
