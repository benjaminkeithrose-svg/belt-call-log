/* Field CRM - service worker.
   Cache prefix is 'fieldcrm-'. GitHub Pages puts every repo on one origin,
   so this must never collide with the Belt Call Log's 'beltcall-' caches.
   Bump the version on EVERY change to any file listed below, or the old
   build is what gets tested. */
const CACHE = 'fieldcrm-v19';

/* The share target posts here. A separate cache, deliberately not versioned:
   activate() deletes every other fieldcrm- cache when the version changes, and
   a file shared seconds before an update must not be thrown away with them. */
const SHARE_CACHE = 'fieldcrm-share';
const SHARE_KEY = './shared-file';

// Local files first. If one of these fails the app still installs, but note the warning.
const ASSETS = [
  './', './index.html', './app.js', './zones.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // cached one at a time: a blocked CDN must not take the whole install down with it
      Promise.all(ASSETS.map(a => c.add(a).catch(err => console.warn('sw: not cached', a, err))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    // this app's own versioned caches only, never the share hand-off
    Promise.all(keys
      .filter(k => k.startsWith('fieldcrm-') && k !== CACHE && k !== SHARE_CACHE)
      .map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

/* ---------- share target ----------
   Android posts the shared file here as multipart form data. A File cannot
   survive the redirect that has to follow, so it is parked in a cache under a
   known key and the page collects it on boot.

   The redirect is a 303 on purpose: it turns the POST into a GET, so a reload
   or a back gesture afterwards does not re-post the form. */
async function stashShared(request) {
  try {
    const form = await request.formData();
    let file = form.get('file');
    if (!file || typeof file.name !== 'string') {
      // some senders use a field name other than the one the manifest asks for
      for (const v of form.values()) {
        if (v && typeof v.name === 'string' && typeof v.arrayBuffer === 'function') { file = v; break; }
      }
    }
    if (file && typeof file.arrayBuffer === 'function') {
      const c = await caches.open(SHARE_CACHE);
      await c.put(SHARE_KEY, new Response(await file.arrayBuffer(), {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          // header values must be latin-1, and a filename can be anything
          'x-filename': encodeURIComponent(file.name || 'shared')
        }
      }));
    }
  } catch (err) {
    console.warn('sw: share failed', err);
  }
  return Response.redirect('./index.html?shared=1', 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(stashShared(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  // ?shared=1 must still match the cached index.html when offline
  const opts = e.request.mode === 'navigate' ? { ignoreSearch: true } : undefined;
  e.respondWith(
    caches.match(e.request, opts).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
