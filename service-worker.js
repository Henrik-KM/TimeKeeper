/// <reference lib="webworker" />

const sw = /** @type {ServiceWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);
const CACHE_NAME = 'timekeeper-app-v17';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './src/main.mjs?v=15',
  './src/shared/runtime-helpers.mjs',
  './src/shared/id.mjs',
  './src/shared/ui.mjs',
  './src/features/codex/context.mjs?v=13',
  './src/features/codex/encryption.mjs?v=13',
  './src/features/time-usage/core.mjs',
  './src/features/strava/core.mjs',
  './src/features/strava/import.mjs',
  './src/features/wealth/core.mjs',
  './src/features/workouts/runtime.mjs',
  './src/features/company-operator/core.mjs',
  './src/features/company-operator/runtime.mjs',
  './src/styles/base.css',
  './src/styles/components.css',
  './src/styles/features.css',
  './src/styles/layout.css',
  './assets/strava.json',
  './assets/strava_overrides.json',
  './assets/timekeeper-icon.svg',
  './manifest.webmanifest'
];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event) => {
  let refreshExistingClients = false;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        refreshExistingClients = keys.some(
          (key) => key.startsWith('timekeeper-app-') && key !== CACHE_NAME
        );
        return Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        );
      })
      .then(() => sw.clients.claim())
      .then(() =>
        sw.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        })
      )
      .then((clients) => {
        if (!refreshExistingClients) return;
        clients.forEach((client) => {
          const url = new URL(client.url);
          if (url.searchParams.get('timekeeper-update') === '15') return;
          url.searchParams.set('timekeeper-update', '15');
          client.navigate(url.href).catch(() => undefined);
        });
      })
  );
});

sw.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
});

sw.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== sw.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, copy).catch(() => {});
        });
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return Response.error();
        })
      )
  );
});
