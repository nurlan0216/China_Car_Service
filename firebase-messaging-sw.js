/* СЛУЖЕБНЫЙ ФАЙЛ Firebase Cloud Messaging (push-уведомления). */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAwD02lTtIflvSGjELsI6HbrIxdA_OdgG4',
  authDomain: 'chinacarservice-6f004.firebaseapp.com',
  projectId: 'chinacarservice-6f004',
  storageBucket: 'chinacarservice-6f004.firebasestorage.app',
  messagingSenderId: '265907667641',
  appId: '1:265907667641:web:8d6cc2d6c7412546dd5168'
});

var messaging = firebase.messaging();

// Показываем уведомление, когда сайт/вкладка закрыты (сообщение пришло "в фоне").
messaging.onBackgroundMessage(function (payload) {
  var notification = payload.notification || {};
  var title = notification.title || 'Honghi EV Service';
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
