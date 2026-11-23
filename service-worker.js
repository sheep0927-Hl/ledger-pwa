/* 总账 Ledger PWA — Service Worker（U4 第一批整改：手机端只读查看端）
 * 版本统一为 ledger-pwa-u4-readonly-v1；activate 时清理所有旧 CACHE
 * （含 ledger-pwa-v19 及任何旧名）。不缓存任何写请求，无 sync / periodicSync 监听。 */
const CACHE = 'ledger-pwa-u4-readonly-v1';
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

// 激活：清理所有旧 CACHE（含 ledger-pwa-v19 及任何旧名），只保留当前只读版本。
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 取数策略（U4 只读）：
// - 任何非 GET 写请求：绝不缓存、绝不拦截（不缓存任何写请求）
// - 数据请求（Supabase API / 跨域）：network-first，直连网络、不缓存
// - 本地静态资源：cache-first，回退网络
// 不注册 sync / periodicSync 监听：只读端不做任何后台补推。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;                  // 写请求不拦截、不缓存
  if (url.origin.includes('supabase.co')) return;   // 数据请求 network-first（直连网络）

  if (url.origin === location.origin) {
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
