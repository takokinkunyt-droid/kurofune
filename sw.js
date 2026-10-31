// =====================================================================
// 黒船クリッカーの Service Worker（ホーム画面に追加したとき用）
//
// 方針：いつも最新を優先する。
//  ・ゲームのページ（/）は、まずネットから取る。取れたら控えを更新する。
//    電波が無い・遅すぎる（6秒）ときだけ、控えを出す。→ 古い版に閉じこめられない
//  ・アイコンと manifest だけは控えから出す（小さく、めったに変わらない）
//  ・それ以外（/api、音楽・動画、広告、フォント、ほかのサイト）にはさわらない
// =====================================================================
const CACHE = 'kurofune-shell-v2';   // アイコンを変えたら数字を上げる（古い控えを消すため）
const PAGE = '/';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([PAGE].concat(STATIC).map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function isGamePage(url) { return url.pathname === '/' || url.pathname === '/index.html'; }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate' && isGamePage(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then(res => {
        if (res && res.ok && (res.headers.get('content-type') || '').includes('text/html')) cache.put(PAGE, res.clone()).catch(() => {});
        return res;
      });
      net.catch(() => {});   // 控えを出したあとに失敗しても、エラーにしない
      const timeout = new Promise(resolve => setTimeout(resolve, 6000, null));
      try {
        const res = await Promise.race([net, timeout]);
        if (res) return res;
        const cached = await cache.match(PAGE);
        return cached || await net;
      } catch (err) {
        const cached = await cache.match(PAGE);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(url.pathname).then(hit => hit || fetch(req).then(res => { if (res.ok) c.put(url.pathname, res.clone()).catch(() => {}); return res; }))));
  }
});
