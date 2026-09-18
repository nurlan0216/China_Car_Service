// Единая логика push-уведомлений.
// Карточка НЕ плавает поверх интерфейса: после инициализации она переносится
// в самый низ кабинета и при включённом push превращается в спокойную строку-статус.
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
    if (typeof firebase === 'undefined') return Promise.reject(new Error('Firebase SDK не загрузился'));
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
    state.messaging = firebase.messaging();
    return Promise.resolve(state.messaging);
  }

  function moveToBottom_(cfg) {
    var card = document.getElementById(cfg.cardId);
    if (!card) return;
    var anchor = document.getElementById(cfg.bottomAnchorId || 'notifBottomAnchor');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(card, anchor);
      return;
    }
    // Если отдельного якоря нет, ставим в самый низ именно рабочего кабинета,
    // а не поверх кнопок и не в fixed-позицию.
    var root = document.getElementById('cabinet') || document.getElementById('mainApp') || document.getElementById('app');
    if (root) {
      root.appendChild(card);
      return;
    }
    var footer = document.querySelector('.social-footer');
    if (footer && footer.parentNode) {
      footer.parentNode.insertBefore(card, footer);
      return;
    }
    var parent = card.parentNode;
    if (parent) parent.appendChild(card);
  }

  function applyStaticStyle_(cfg) {
    var card = document.getElementById(cfg.cardId);
    if (!card) return;
    var styleId = 'push-card-style-' + cfg.cardId;
    if (!document.getElementById(styleId)) {
      var style = document.createElement('style');
      style.id = styleId;
      style.textContent =
        '#' + cfg.cardId + '{position:static!important;left:auto!important;right:auto!important;bottom:auto!important;' +
        'z-index:auto!important;max-width:none;margin:14px 0 8px!important;box-shadow:none!important;}' +
        '#' + cfg.cardId + '.push-card-compact{padding:7px 10px!important;opacity:.9;}' +
        '#' + cfg.cardId + '.push-card-compact #pushToggleBtn{display:none!important;}' +
        '#' + cfg.cardId + ' .push-card-title{font-size:12px;font-weight:600;}' +
        '#' + cfg.cardId + ' .push-card-status{font-size:11px;margin-top:1px;opacity:.8;}';
      document.head.appendChild(style);
    }
    moveToBottom_(cfg);
  }

  function compact_(cfg, state, enabled) {
    var card = document.getElementById(cfg.cardId);
    if (!card) return;
    card.classList.toggle('push-card-compact', !!enabled);
    state.collapsed = !!enabled;
  }

  function refresh_(cfg, state) {
    var card = document.getElementById(cfg.cardId);
    var statusEl = document.getElementById(cfg.statusId);
    var btn = document.getElementById(cfg.btnId);
    if (!card || !statusEl || !btn) return;
    applyStaticStyle_(cfg);

    if (cfg.permissionOnly) {
      var perm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
      if (perm === 'granted') {
        statusEl.textContent = cfg.enabledText || 'Уведомления разрешены';
        btn.textContent = 'Разрешено'; btn.disabled = true;
        compact_(cfg, state, true);
      } else if (perm === 'denied') {
        statusEl.textContent = 'Уведомления заблокированы в настройках браузера';
        btn.textContent = 'Заблокировано'; btn.disabled = true;
        compact_(cfg, state, false);
      } else {
        statusEl.textContent = cfg.disabledText || 'Уведомления выключены';
        btn.textContent = 'Разрешить'; btn.disabled = false;
        compact_(cfg, state, false);
      }
      state.initialized = true;
      return;
    }

    if (!pushConfigured_()) {
      statusEl.textContent = cfg.notConfiguredText || 'Push пока не настроен';
      btn.textContent = '—'; btn.disabled = true;
      compact_(cfg, state, false);
      state.initialized = true;
      return;
    }

    var saved = localStorage.getItem(cfg.tokenKey);
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      statusEl.textContent = 'Уведомления заблокированы в настройках браузера';
      btn.textContent = 'Включить'; btn.disabled = false;
      compact_(cfg, state, false);
    } else if (saved) {
      statusEl.textContent = cfg.enabledText || 'Push-уведомления включены на этом устройстве';
      btn.textContent = 'Отключить'; btn.disabled = false;
      compact_(cfg, state, true);
    } else {
      statusEl.textContent = cfg.disabledText || 'Push-уведомления выключены';
      btn.textContent = 'Включить'; btn.disabled = false;
      compact_(cfg, state, false);
    }
    state.initialized = true;
  }

  function enablePermission_(cfg, state) {
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    Notification.requestPermission().then(function () { refresh_(cfg, state); })
      .catch(function () { refresh_(cfg, state); });
  }

  function enable_(cfg, state) {
    if (cfg.permissionOnly) return enablePermission_(cfg, state);
    var statusEl = document.getElementById(cfg.statusId);
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Включаем уведомления...';
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
        params.action = cfg.registerAction; params.token = token;
        return cfg.post(params).then(function (res) {
          if (!res.ok) throw new Error(res.error || 'Сервер отклонил регистрацию');
          localStorage.setItem(cfg.tokenKey, token);
          refresh_(cfg, state);
        });
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = 'Не удалось включить уведомления: ' + (err && err.message ? err.message : err);
        if (btn) btn.disabled = false;
      });
  }

  function disable_(cfg, state, token) {
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.disabled = true;
    var params = (cfg.buildUnregisterParams || cfg.buildRegisterParams || cfg.buildParams).call(cfg, token) || {};
    params.action = cfg.unregisterAction; params.token = token;
    cfg.post(params).catch(function () {}).then(function () {
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
    var state = { messaging:null, collapsed:false, initialized:false };
    instances[cfg.cardId] = { cfg:cfg, state:state };
    if (!browserSupported_(cfg)) { card.style.display='none'; return; }
    card.style.display='block';
    applyStaticStyle_(cfg);
    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.onclick = function () {
      if (cfg.permissionOnly) { enable_(cfg,state); return; }
      var saved = localStorage.getItem(cfg.tokenKey);
      if (saved) disable_(cfg,state,saved); else enable_(cfg,state);
    };
    refresh_(cfg,state);
  };
})(window);
