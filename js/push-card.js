// Общая логика push-карточки для всех страниц (to/act/driver/taxipark/index).
// initPushCard_(cfg) — параметризация под страницу вместо копий кода:
//   cardId, tokenKey — обязательные.
//   registerAction/unregisterAction, post(payload), buildRegisterParams(token)/
//     buildUnregisterParams(token) — для страниц с серверной регистрацией токена.
//   permissionOnly:true — только запрос разрешения браузера, без FCM/сервера
//     (index.html, до входа в конкретный кабинет).
//   enabledText/disabledText/notConfiguredText — тексты статуса (опционально).
(function (global) {
  var instances = {};

  function browserSupported_(cfg) {
    if (cfg.permissionOnly) return ('serviceWorker' in navigator) && ('Notification' in window);
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  function pushConfigured_() {
    return !!global.FIREBASE_CONFIG && typeof global.FIREBASE_CONFIG === 'object' && !!global.FIREBASE_VAPID_KEY;
  }

  function ensureMessaging_(state) {
    if (state.messaging) return Promise.resolve(state.messaging);
    if (typeof firebase === 'undefined') {
      return Promise.reject(new Error('Firebase SDK не загрузился (нет сети или заблокирован CDN)'));
    }
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
    state.messaging = firebase.messaging();
    return Promise.resolve(state.messaging);
  }

  function injectStyle_(cardId) {
    var styleId = 'push-card-style-' + cardId;
    if (document.getElementById(styleId)) return;
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      '#' + cardId + '.push-card-anim{transition:opacity .22s ease,transform .22s ease;}' +
      '#' + cardId + '.push-card-collapsed{position:fixed;left:16px;right:16px;bottom:16px;' +
      'z-index:9999;max-width:460px;margin:0 auto;padding:10px 14px;cursor:pointer;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.45);}' +
      '#' + cardId + '.push-card-collapsed #pushToggleBtn,' +
      '#' + cardId + '.push-card-collapsed .push-card-btn{display:none;}';
    document.head.appendChild(style);
  }

  // Плавное сворачивание/разворачивание (opacity+translateY, ~220-250ms) —
  // вместо мгновенного добавления/снятия класса.
  function setCollapsed_(cfg, state, collapsed, animate) {
    var card = document.getElementById(cfg.cardId);
    if (!card || !!state.collapsed === !!collapsed) return;
    state.collapsed = collapsed;

    if (!animate) {
      card.classList.toggle('push-card-collapsed', collapsed);
      return;
    }
    card.classList.add('push-card-anim');
    card.style.opacity = '0';
    card.style.transform = collapsed ? 'translateY(8px)' : 'translateY(-8px)';
    setTimeout(function () {
      card.classList.toggle('push-card-collapsed', collapsed);
      card.style.transform = collapsed ? 'translateY(16px)' : 'translateY(-8px)';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          card.style.opacity = '1';
          card.style.transform = 'translateY(0)';
        });
      });
    }, 220);
  }

  function refresh_(cfg, state) {
    var card = document.getElementById(cfg.cardId);
    var statusEl = document.getElementById(cfg.statusId);
    var btn = document.getElementById(cfg.btnId);
    if (!card || !statusEl || !btn) return;

    if (cfg.permissionOnly) {
      var perm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
      if (perm === 'granted') {
        statusEl.textContent = cfg.enabledText || 'Разрешено — в кабинете включение пройдёт без лишнего запроса';
        btn.textContent = 'Разрешено';
        btn.disabled = true;
        setCollapsed_(cfg, state, true, state.initialized);
      } else if (perm === 'denied') {
        statusEl.textContent = 'Заблокировано в браузере — разрешите уведомления в настройках сайта вручную';
        btn.textContent = 'Заблокировано';
        btn.disabled = true;
      } else {
        statusEl.textContent = cfg.disabledText || 'Разрешите заранее — включение в кабинете пройдёт без лишнего запроса';
        btn.textContent = 'Разрешить';
        btn.disabled = false;
      }
      state.initialized = true;
      return;
    }

    if (!pushConfigured_()) {
      statusEl.textContent = cfg.notConfiguredText || 'Пока не настроено';
      btn.textContent = '—';
      btn.disabled = true;
      state.initialized = true;
      return;
    }

    btn.disabled = false;
    var saved = localStorage.getItem(cfg.tokenKey);
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      statusEl.textContent = 'Заблокировано в браузере — разрешите уведомления в настройках сайта вручную';
      btn.textContent = 'Включить';
    } else if (saved) {
      statusEl.textContent = cfg.enabledText || 'Включены на этом устройстве';
      btn.textContent = 'Отключить';
      setCollapsed_(cfg, state, true, state.initialized);
    } else {
      statusEl.textContent = cfg.disabledText || 'Выключены';
      btn.textContent = 'Включить';
    }
    state.initialized = true;
  }

  function enablePermission_(cfg, state) {
    var statusEl = document.getElementById(cfg.statusId);
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    Notification.requestPermission().then(function () {
      refresh_(cfg, state);
    }).catch(function () {
      refresh_(cfg, state);
    });
  }

  function enable_(cfg, state) {
    if (cfg.permissionOnly) return enablePermission_(cfg, state);

    var statusEl = document.getElementById(cfg.statusId);
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Запрашиваем разрешение браузера...';

    navigator.serviceWorker.register('firebase-messaging-sw.js')
      .then(function (registration) {
        return Notification.requestPermission().then(function (permission) {
          if (permission !== 'granted') throw new Error('Разрешение не выдано');
          return ensureMessaging_(state);
        }).then(function (messaging) {
          return messaging.getToken({ vapidKey: global.FIREBASE_VAPID_KEY, serviceWorkerRegistration: registration });
        });
      })
      .then(function (token) {
        if (!token) throw new Error('Не удалось получить токен устройства');
        var params = (cfg.buildRegisterParams || cfg.buildParams).call(cfg, token) || {};
        params.action = cfg.registerAction;
        params.token = token;
        return cfg.post(params).then(function (res) {
          if (!res.ok) throw new Error(res.error || 'Сервер отклонил регистрацию');
          localStorage.setItem(cfg.tokenKey, token);
          refresh_(cfg, state);
        });
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = 'Ошибка: ' + (err && err.message ? err.message : err);
        if (btn) btn.disabled = false;
      });
  }

  function disable_(cfg, state, token) {
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    var params = (cfg.buildUnregisterParams || cfg.buildRegisterParams || cfg.buildParams).call(cfg, token) || {};
    params.action = cfg.unregisterAction;
    params.token = token;
    cfg.post(params)
      .catch(function () { /* сети нет — всё равно отключаем локально ниже, чтобы не блокировать пользователя */ })
      .then(function () {
        localStorage.removeItem(cfg.tokenKey);
        refresh_(cfg, state);
      });
  }

  global.initPushCard_ = function (cfg) {
    cfg.statusId = cfg.statusId || 'pushStatus';
    cfg.btnId = cfg.btnId || 'pushToggleBtn';
    cfg.post = cfg.post || global.apiPost;

    var existing = instances[cfg.cardId];
    if (existing) { refresh_(cfg, existing.state); return; }

    var card = document.getElementById(cfg.cardId);
    if (!card) return;
    var state = { messaging: null, collapsed: false, initialized: false };
    instances[cfg.cardId] = { cfg: cfg, state: state };

    if (!browserSupported_(cfg)) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    injectStyle_(cfg.cardId);

    var btn = document.getElementById(cfg.btnId);
    if (btn) {
      btn.onclick = function () {
        if (cfg.permissionOnly) { enable_(cfg, state); return; }
        var saved = localStorage.getItem(cfg.tokenKey);
        if (saved) disable_(cfg, state, saved);
        else enable_(cfg, state);
      };
    }

    // Тап по свёрнутой полоске — разворачивает карточку обратно.
    card.addEventListener('click', function () {
      if (state.collapsed) setCollapsed_(cfg, state, false, true);
    });

    // После установки приложения — сворачиваем карточку, даже если push
    // ещё не включён (меньше отвлекает после appinstalled).
    window.addEventListener('appinstalled', function () {
      setCollapsed_(cfg, state, true, true);
    });

    refresh_(cfg, state);
  };
})(window);
