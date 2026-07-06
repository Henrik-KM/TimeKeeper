/// <reference lib="webworker" />

const sw = /** @type {ServiceWorkerGlobalScope} */ (
  /** @type {unknown} */ (self)
);
const CACHE_NAME = 'timekeeper-app-v8';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './src/main.mjs',
  './src/shared/runtime-helpers.mjs',
  './src/shared/id.mjs',
  './src/shared/ui.mjs',
  './src/features/strava/core.mjs',
  './src/features/strava/import.mjs',
  './src/features/wealth/core.mjs',
  './src/features/workouts/runtime.mjs',
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
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
});

sw.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
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
