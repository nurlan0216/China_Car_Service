// Honghi EV Service — service worker для базовой офлайн-загрузки оболочки.
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
// 2) для текущей версии брендинга новый воркер активируется автоматически,
//    чтобы установленные PWA не зависели от ручной кнопки обновления.
// v5 — ЭТАП 9.2 (PROMPT_stage9.md, п.5 "принудительно обновить у всех
// сайт и ПВА"): версия кэша просто бампается при каждом деплое с
// изменениями во фронтенд-файлах (act.html/to.html и т.д.) — сам этот
// механизм (network-first + баннер "Доступно обновление") уже был
// сделан в Этапе 8.1 и не менялся, действие нужно только при каждом
// новом деплое фронтенда.
// v10 — ЭТАП 2-7 (GPS + routing): добавлены три новых статических файла GPS-модуля
// в precache. Ничего в логике кэширования не менялось — те же правила
// (network-first для шелла, /exec никогда не перехватывается) действуют
// и на js/gps-*.js. Версия кэша бампнута, потому что появились новые
// файлы в PRECACHE_URLS (тот же паттерн, что при прошлых бампах v5–v8).
// v11 — ЭТАП 4 ГПС-плана (реальная синхронизация с Apps Script):
// изменились driver.html и js/gps-sync.js (уже входят в PRECACHE_URLS,
// новых путей не появилось) — бамп версии кэша нужен только чтобы уже
// установленные PWA увидели свежий код (тот же паттерн, что в v5/v9:
// "версия кэша бампается при каждом деплое с изменениями во
// фронтенд-файлах"), логика network-first не менялась.
// v13 — ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ PWA + смена бренда Honghi EV Service
// При установке нового SW он сразу активируется, чтобы уже установленные PWA
// получили новые HTML/manifest без ручной кнопки «Обновить».
//
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
  // ЭТАП 4 (маскировка GPS): подключение js/gps-*.js и js/routing-service.js
  // в driver.html закомментировано (см. driver.html), поэтому эти файлы
  // больше не используются на странице — предзагружать их в кэш незачем.
  // Сами файлы никуда не удалены, лежат на месте (js/gps-storage.js,
  // js/gps-tracker.js, js/gps-sync.js, js/routing-service.js). Чтобы
  // вернуть GPS обратно — раскомментируйте 4 строки ниже (и соответствующие
  // строки в driver.html).
  // , 'js/gps-storage.js'
  // , 'js/gps-tracker.js'
  // , 'js/gps-sync.js'
  // , 'js/routing-service.js'
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
