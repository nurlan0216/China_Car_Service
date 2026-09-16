/**
 * СЛУЖЕБНЫЙ ФАЙЛ Firebase Cloud Messaging (push-уведомления).
 * -------------------------------------------------
 * ФИКС (промт «Push-уведомления»). Этот файл ОБЯЗАН лежать в корне
 * сайта, рядом с to.html, и называться ИМЕННО firebase-messaging-sw.js
 * (Firebase ищет его по этому фиксированному имени/пути) — иначе push
 * будет приходить только пока вкладка to.html открыта, а не когда
 * сайт/браузер закрыты.
 *
 * Он ОТДЕЛЬНЫЙ от service-worker.js (offline-кэш сайта) — два service
 * worker'а на одном сайте — это нормально и поддерживается браузером,
 * трогать/объединять их не нужно.
 *
 * НАСТРОЙКА: вставьте сюда тот же объект firebaseConfig, что вы уже
 * вставили в to.html (переменная FIREBASE_CONFIG, см. инструкцию в
 * шапке apps-script/12_Push.gs, шаг 2). VAPID-ключ сюда вставлять НЕ
 * нужно — он нужен только в to.html.
 *
 * ВСТАВЬТЕ_FIREBASE_CONFIG:
 */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'ВСТАВЬТЕ_FIREBASE_CONFIG',
  authDomain: 'ВСТАВЬТЕ_FIREBASE_CONFIG',
  projectId: 'ВСТАВЬТЕ_FIREBASE_CONFIG',
  storageBucket: 'ВСТАВЬТЕ_FIREBASE_CONFIG',
  messagingSenderId: 'ВСТАВЬТЕ_FIREBASE_CONFIG',
  appId: 'ВСТАВЬТЕ_FIREBASE_CONFIG'
});

var messaging = firebase.messaging();

// Показываем уведомление, когда сайт/вкладка закрыты (сообщение пришло
// "в фоне"). Пока вкладка to.html открыта — Firebase доставляет
// сообщение прямо в неё (onMessage), а не сюда; отдельный обработчик
// для этого случая не нужен, chrome/большинство браузеров и так молча
// показывают системное уведомление по умолчанию для фоновых push с
// заполненным полем "notification" (как у нас, см. sendFcmPush_ в
// 12_Push.gs) — но on BackgroundMessage ниже даёт больше контроля
// (иконка, клик по уведомлению) и работает во всех браузерах одинаково.
messaging.onBackgroundMessage(function (payload) {
  var notification = payload.notification || {};
  var title = notification.title || 'China Car Service';
  var link = (payload.fcmOptions && payload.fcmOptions.link)
    || (payload.data && payload.data.link)
    || '/to.html';

  self.registration.showNotification(title, {
    body: notification.body || '',
    icon: notification.icon || '/icons/icon-192-staff.png',
    badge: '/icons/icon-192-staff.png',
    data: { link: link }
  });
});

// Клик по уведомлению — открывает (или фокусирует уже открытую) вкладку
// to.html, а не просто закрывает уведомление молча.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var link = (event.notification.data && event.notification.data.link) || '/to.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf(link) !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(link);
      }
    })
  );
});
