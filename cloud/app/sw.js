/* Revo service worker: keeps the app shell on the device so it opens and works offline, and brings new versions in
   without ever swapping files under a running cashier (the page asks for the switch). Data never passes through here:
   the restaurant's records live in Firestore and in the device's own store. */
const BUILD = '202610260126';
const CACHE = 'revo-shell-' + BUILD;
const PAGE = './'; // the app page is cached under one key, whatever address it was opened from
const BASE = new URL('./', self.location.href).pathname; // the folder this worker serves, normally /app/
const SHELL = ['./config.js', './firebase-bundle.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
const NEVER = /googleapis\.com|firebaseio\.com|firebase\.com|gstatic\.com\/firebasejs|identitytoolkit|securetoken/;

// A response that came through a redirect (the host turns /app/index.html into /app/) may not be served to a navigation
// later, so what goes into the cache is always a plain copy of the final document.
async function store(c, key, r) {
  if (!r || !r.ok) return;
  if (r.redirected || r.type === 'opaqueredirect') { const body = await r.clone().arrayBuffer(); await c.put(key, new Response(body, { status: 200, statusText: 'OK', headers: r.headers })); }
  else await c.put(key, r.clone());
}
const timeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const page = await fetch(new Request(PAGE, { cache: 'reload' })).catch(() => null); await store(c, PAGE, page);
    await Promise.all(SHELL.map(async u => { const r = await fetch(new Request(u, { cache: 'reload' })).catch(() => null); await store(c, u, r); }));
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.startsWith('revo-shell-') && k !== CACHE).map(k => caches.delete(k))); await self.clients.claim(); })());
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER.test(url.href)) return; // live data and sign-in always go to the network
  if (req.mode === 'navigate') {
    // The page itself: fresh when online (so fixes arrive), the saved copy when not.
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try { const r = await timeout(fetch(req), 4000); if (r && r.ok) await store(c, PAGE, r); return r; }
      catch (err) { return (await c.match(PAGE)) || Response.error(); }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    // Our own files: from the cache first, refreshed in the background.
    e.respondWith((async () => {
      const c = await caches.open(CACHE); const key = url.pathname.startsWith(BASE) ? './' + url.pathname.slice(BASE.length) : req;
      const hit = await c.match(key);
      const net = fetch(req).then(async r => { await store(c, key, r); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    // Fonts: whatever was fetched once keeps working offline.
    e.respondWith((async () => { const c = await caches.open('revo-fonts'); const hit = await c.match(req); if (hit) return hit; try { const r = await fetch(req); if (r && r.ok) c.put(req, r.clone()); return r; } catch (err) { return Response.error(); } })());
  }
});
