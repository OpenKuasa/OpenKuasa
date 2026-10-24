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
