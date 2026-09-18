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

  function injectStyle_(cfg) {
    var cardId = cfg.cardId;
    var styleId = 'push-card-style-' + cardId;
    if (document.getElementById(styleId)) return;
    var style = document.createElement('style');
    style.id = styleId;
    // ФИКС (ошибка 6 из плана исправлений): раньше .push-card-collapsed
    // делал position:fixed;...;z-index:9999 — карточка вылетала из потока
    // страницы и повисала поверх всего (нижнее меню, кнопка WhatsApp-мастера
    // и т.д.) на всех страницах, включая driver.html. Теперь используем тот
    // же приём, что уже есть в driver.html для tgLinkCard: карточка остаётся
    // обычным блоком в потоке страницы, просто сжимается и физически
    // переносится (moveCard_/insertBefore) к якорю #notifBottomAnchor внизу
    // кабинета, ничего не перекрывая.
    style.textContent =
      '#' + cardId + '.push-card-anim{transition:opacity .22s ease,transform .22s ease;}' +
      '#' + cardId + '.push-card-compact{padding:8px 12px !important;margin-bottom:8px !important;}' +
      '#' + cardId + '.push-card-compact #' + cfg.statusId + '{font-size:12px;color:var(--muted);}' +
      '#' + cardId + '.push-card-hide-cta #' + cfg.btnId + ',' +
      '#' + cardId + '.push-card-hide-cta .push-card-btn{display:none;}';
    document.head.appendChild(style);
  }

  // Переносит сам DOM-узел карточки (не копию) к нужному якорю — тот же
  // приём, что и moveNotifCard_ в driver.html: insertBefore(card, anchor)
  // кладёт карточку сразу перед якорем и оставляет её в обычном потоке.
  function moveCard_(card, anchorEl) {
    if (!card || !anchorEl || !anchorEl.parentNode) return;
    if (card.nextSibling === anchorEl) return; // уже на месте — не дёргаем DOM зря
    anchorEl.parentNode.insertBefore(card, anchorEl);
  }

  // Запоминает исходное место карточки в разметке (комментарий-маркер сразу
  // после неё), чтобы при разворачивании вернуть карточку туда же, откуда
  // она была перенесена вниз, а не полагаться на отдельный "верхний" якорь,
  // который есть не на всех страницах.
  function ensureHomeAnchor_(card, state) {
    if (state.homeAnchor && state.homeAnchor.parentNode) return state.homeAnchor;
    var anchor = document.createComment('push-card-home-' + card.id);
    card.parentNode.insertBefore(anchor, card.nextSibling);
    state.homeAnchor = anchor;
    return anchor;
  }

  // Плавное сворачивание/разворачивание (opacity+translateY, ~220-250ms) —
  // вместо мгновенного добавления/снятия класса.
  function applyCollapsedPlacement_(cfg, state, collapsed, card) {
    if (collapsed) {
      card.classList.add('push-card-compact', 'push-card-hide-cta');
      var bottom = document.getElementById(cfg.bottomAnchorId || 'notifBottomAnchor');
      if (bottom) moveCard_(card, bottom);
      // Если якоря нет на странице (ещё не добавлен в разметку) — карточка
      // просто сжимается на месте, но НЕ уходит в position:fixed поверх
      // остального контента, так что кнопки под ней по-прежнему кликабельны.
    } else {
      card.classList.remove('push-card-compact', 'push-card-hide-cta');
      moveCard_(card, ensureHomeAnchor_(card, state));
    }
  }

  function setCollapsed_(cfg, state, collapsed, animate) {
    var card = document.getElementById(cfg.cardId);
    if (!card || !!state.collapsed === !!collapsed) return;
    state.collapsed = collapsed;

    if (!animate) {
      applyCollapsedPlacement_(cfg, state, collapsed, card);
      return;
    }
    card.classList.add('push-card-anim');
    // ФИКС (ошибка 2 из плана исправлений): без принудительного reflow
    // между добавлением класса с transition и сменой opacity/transform в
    // этом же тике браузер схлопывает оба изменения в один кадр и просто
    // не проигрывает переход — карточка "исчезает" рывком, без анимации.
    // Чтение layout-свойства (offsetHeight) заставляет браузер применить
    // класс ДО того, как применится следующее изменение стиля, поэтому
    // переход по opacity/transform реально запускается.
    void card.offsetHeight;
    card.style.opacity = '0';
    card.style.transform = collapsed ? 'translateY(8px)' : 'translateY(-8px)';
    setTimeout(function () {
      applyCollapsedPlacement_(cfg, state, collapsed, card);
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
    injectStyle_(cfg);
    ensureHomeAnchor_(card, state); // запоминаем исходное место в разметке ДО первого сворачивания

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
