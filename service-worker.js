// China Car Service — service worker для базовой офлайн-загрузки оболочки.
// Кэширует только статичные файлы сайта (html/manifest/иконки).
// Запросы к Apps Script (.../exec — данные, PDF, акты) НЕ кэшируются и НЕ
// перехватываются: они всегда идут напрямую в сеть, чтобы данные были свежими.

var CACHE_NAME = 'ccs-shell-v1';

var PRECACHE_URLS = [
  'index.html',
  'driver.html',
  'to.html',
  'act.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .then(function () { return self.skipWaiting(); })
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

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Чужой домен (в первую очередь script.google.com/.../exec — данные, PDF,
  // акты) не трогаем вообще: пусть браузер обрабатывает как обычно.
  if (url.origin !== self.location.origin) return;

  // Только GET-запросы имеет смысл кэшировать.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () {
        // офлайн: если файла нет в кэше и сети нет — отдаём хотя бы оболочку index.html
        return cached || caches.match('index.html');
      });

      // кэш — сразу, если есть (быстрая офлайн-загрузка), сеть — в фоне обновляет кэш
      return cached || networkFetch;
    })
  );
});
