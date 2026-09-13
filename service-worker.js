// China Car Service — service worker для базовой офлайн-загрузки оболочки.
// Кэширует только статичные файлы сайта (html/manifest/иконки).
// Запросы к Apps Script (.../exec — данные, PDF, акты) НЕ кэшируются и НЕ
// перехватываются: они всегда идут напрямую в сеть, чтобы данные были свежими.

// v4 — ЭТАП 8.1 (PROMPT_stage7_fixes.md): раньше страница-оболочка
// отдавалась стратегией "кэш сразу, сеть в фоне" — уже открытые/
// установленные копии сайта могли сколь угодно долго не увидеть новый
// код, пока пользователь вручную не почистит кэш/не удалит Service
// Worker (это и произошло на реальном тесте Этапа 7). Теперь — два
// изменения:
// 1) стратегия фетча заменена на network-first (см. fetch ниже): пока
//    есть сеть, всегда отдаём свежий файл с сервера, а кэш — только
//    запасной вариант на случай офлайна;
// 2) self.skipWaiting() в install больше НЕ вызывается автоматически —
//    новый воркер осознанно остаётся в состоянии "waiting", пока
//    страница сама не попросит его активироваться (см. message ниже и
//    код в to.html/driver.html/act.html/index.html, который показывает
//    баннер "Доступно обновление" и вызывает postMessage('SKIP_WAITING')
//    только по явному нажатию кнопки пользователем).
var CACHE_NAME = 'ccs-shell-v4';

var PRECACHE_URLS = [
  'index.html',
  'driver.html',
  'to.html',
  'act.html',
  'manifest.json',
  'manifest-driver.json',
  'manifest-staff.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-driver.png',
  'icons/icon-512-driver.png',
  'icons/icon-192-staff.png',
  'icons/icon-512-staff.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
    // Намеренно НЕ self.skipWaiting() здесь — см. комментарий сверху.
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

// ЭТАП 8.1: страница присылает это сообщение только после того, как
// пользователь сам нажал "Обновить" в баннере — тогда новый (пока ещё
// просто "waiting") воркер активируется, что вызовет у всех открытых
// вкладок событие controllerchange, по которому страница сама
// перезагрузится (см. код регистрации в to.html/driver.html/act.html/
// index.html).
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

  // ЭТАП 8.1: network-first — пока есть сеть, ВСЕГДА идём за свежим
  // файлом на сервер (и заодно обновляем кэш свежей копией); кэш
  // используется только как запасной вариант, если сети нет вообще
  // (офлайн) или сервер ответил ошибкой/не ответил. Раньше было
  // наоборот ("кэш сразу, сеть в фоне") — из-за этого пользователи
  // могли сколь угодно долго не видеть новую версию сайта.
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
