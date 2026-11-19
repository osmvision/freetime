const CACHE = 'freetime-web-__VERSION__';
self.addEventListener('message', (event) => { if (event.data === 'activate') self.skipWaiting(); });
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const assets = await fetch('/precache.json', { cache: 'no-store' }).then((r) => r.json());
    const cache = await caches.open(CACHE);
    await cache.addAll(assets);
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('freetime-web-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Account responses, bearer tokens and browser state never enter CacheStorage.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && (url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/'))) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      if (event.request.mode === 'navigate') return caches.match('/offline.html');
      return await caches.match(event.request) || Response.error();
    }
  })());
});
