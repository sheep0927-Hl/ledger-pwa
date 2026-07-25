/* 总账 Ledger PWA — Service Worker（离线应用壳） */
const CACHE = 'ledger-pwa-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './localdb.js',
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

// 激活：清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 取数策略：
// - Supabase API / 跨域请求 → 直接走网络（不缓存，保证数据实时）
// - 本地静态资源 → 缓存优先，回退网络
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin.includes('supabase.co')) return; // 数据请求直连网络

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
