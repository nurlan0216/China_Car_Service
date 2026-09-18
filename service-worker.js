// Honghi EV Service — service worker для базовой офлайн-загрузки оболочки.
// Кэширует только статичные файлы сайта (html/manifest/иконки).
// Запросы к Apps Script (.../exec — данные, PDF, акты) НЕ кэшируются и НЕ
// перехватываются: они всегда идут напрямую в сеть, чтобы данные были свежими.

// v4 — (PROMPT_stage7_fixes.md): раньше страница-оболочка отдавалась стратегией "кэш сразу, сеть в фоне" — уже открытые/ установленные копии сайта могли сколь угодно долго не увидеть новый код, пока…
v12 — ЭТАП 4 (маскировка GPS): js/gps-*.js и js/routing-service.js убраны
// из PRECACHE_URLS (см. комментарий у списка ниже) — сами файлы не удалены.
var CACHE_NAME = 'ccs-shell-v13-honghi-brand';

var PRECACHE_URLS = [
  'index.html',
  'driver.html',
  'to.html',
  'act.html',
  'taxipark.html',
  'manifest.json',
  'manifest-driver.json',
  'manifest-staff.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-driver.png',
  'icons/icon-512-driver.png',
  'icons/icon-192-staff.png',
  'icons/icon-512-staff.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  'icons/site-logo.png'
  // (маскировка GPS): подключение js/gps-*.js и js/routing-service.js в driver.html закомментировано , поэтому эти файлы больше не используются на странице — предзагружать их в кэш незачем.
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .then(function () {
        // Принудительно активируем новую версию сразу после установки.
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// страница присылает это сообщение только после того, как пользователь сам нажал "Обновить" в баннере — тогда новый (пока ещё просто "waiting") воркер активируется, что вызовет у всех открытых вкладок…
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Чужой домен (в первую очередь script.google.com/.../exec — данные, PDF,
  // акты) не трогаем вообще: пусть браузер обрабатывает как обычно.
  if (url.origin !== self.location.origin) return;

  // Только GET-запросы имеет смысл кэшировать.
  if (event.request.method !== 'GET') return;

  // network-first — пока есть сеть, ВСЕГДА идём за свежим файлом на сервер (и заодно обновляем кэш свежей копией); кэш используется только как запасной вариант, если сети нет вообще (офлайн) или сервер…
  event.respondWith(
    fetch(event.request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
      }
      return response;
    }).catch(function () {
      // офлайн (или сеть вернула ошибку) — отдаём то, что есть в кэше,
      // а если и там нет ничего — хотя бы оболочку index.html.
      return caches.match(event.request).then(function (cached) {
        return cached || caches.match('index.html');
      });
    })
  );
});
