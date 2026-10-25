/*
 * OpenKuasa's service worker. Browsers need one before they offer "Install".
 *
 * It caches nothing: every request goes to the live site, as in a browser tab.
 * The only thing it adds is a plain "You're offline" page when a page can't load
 * because there's no connection. Other requests (data, server actions, files) are
 * left alone entirely.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · OpenKuasa</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #fff; color: #1b1d1c; text-align: center; padding: 24px; box-sizing: border-box; }
  @media (prefers-color-scheme: dark) { body { background: #0f141a; color: #e8ecef; } p { color: #9aa4ad; } }
  .mark { width: 56px; height: 56px; border-radius: 14px; background: #007a55; margin: 0 auto 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; color: #5b605d; }
  a { display: inline-block; background: #007a55; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; }
</style></head>
<body><main><div class="mark"></div><h1>You're offline</h1><p>OpenKuasa needs an internet connection. Check yours and try again.</p><a href="">Try again</a></main></body></html>`;

/*
 * Push notifications. The server sends { title, body, url, tag }; each notification has its
 * own tag, so three requests show as three. A link is only ever a path on this site: anything
 * else becomes /command.
 */
const PUSH_FALLBACK_PATH = '/command';
const PUSH_ICON = '/icons/icon-192.png';
const UNSAFE_PATH_CHARS = /[\s\u0000-\u001f\u007f-\u009f\\]/;

/** The full URL for a same-site path, or null. */
function sameSiteUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  if (UNSAFE_PATH_CHARS.test(path)) return null;
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'OpenKuasa';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    data: { url: sameSiteUrl(data.url) ? data.url : PUSH_FALLBACK_PATH },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = sameSiteUrl(data.url) || sameSiteUrl(PUSH_FALLBACK_PATH);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => {
        try {
          return new URL(w.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      if (open) {
        try {
          await open.focus();
          await open.navigate(target);
          return;
        } catch {
          // A window this worker doesn't control can't be moved; open a new one instead.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        return new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    })(),
  );
});
