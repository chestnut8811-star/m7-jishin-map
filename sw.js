/* M7+ 地震マップ — Service Worker（オフラインで開けるようにアプリ一式をキャッシュする） */
const VERSION = 'm7map-c9cd21c004';
const CORE = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './vendor/d3.min.js', './vendor/topojson-client.min.js',
  './data/prefs.js', './data/quakes.js', './data/japan.js', './data/plates.js', './data/forecast.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('m7map-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Fonts は取得できたものを保存して、次回からオフラインでも使う
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(caches.open(VERSION + '-fonts').then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // 画面（HTML）もキャッシュから出して、HTML と JS の版を必ずそろえる。
  // 新しい版は sw.js の更新で裏で入り、入れ替わった時点で app.js が1回だけ読み込み直す
  if (req.mode === 'navigate') {
    event.respondWith(caches.open(VERSION).then((c) => c.match('./index.html')).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});
