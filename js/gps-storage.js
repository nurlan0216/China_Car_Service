/* js/gps-storage.js — + (IndexedDB и offline) ------------------------------------------------------------- НОВЫЙ файл, ничего существующего не меняет и не удаляет. */
(function (global) {
  'use strict';

  var PREFIX = 'ccs_gps_';

  function keyFor(plate) {
    return PREFIX + 'session_' + String(plate || '').toUpperCase();
  }

  function safeGet(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      // Приватный режим браузера / localStorage недоступен / битый JSON —
      // не роняем вызывающий код, просто как будто данных нет.
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Переполнение/недоступность хранилища — не критично для Этапа 2
      // (данные маленькие), но и не должно ронять трекер.
      return false;
    }
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* не критично */ }
  }

  /* Структура состояния сессии по номеру машины: { plate, sessionId, deviceToken, startedAt, lastPointAt, distanceKm, // накопленное, ещё не подтверждённое сервером syncedDistanceKm, // сколько из… */

  function getState(plate) {
    return safeGet(keyFor(plate));
  }

  function setState(plate, state) {
    return safeSet(keyFor(plate), state);
  }

  function clearState(plate) {
    safeRemove(keyFor(plate));
  }

  /** Создаёт новую сессию, закрывая (не удаляя, а помечая stopped) любую
   *  предыдущую сессию для ДРУГОГО номера — GPS не должен продолжать
   *  прибавлять километры машине, от которой водитель уже отписался
   *  (п.31 ТЗ, "смена автомобиля"). */
  function startSession(plate, sessionId, deviceToken) {
    // Закрыть чужие сессии этого устройства (на случай, если ранее не
    // закрыли явно) — ищем по всем ключам с нашим префиксом.
    stopAllExcept(plate);
    var state = {
      plate: String(plate || '').toUpperCase(),
      sessionId: sessionId,
      deviceToken: deviceToken || '',
      startedAt: Date.now(),
      lastPointAt: null,
      distanceKm: 0,
      syncedDistanceKm: 0,
      lastLat: null,
      lastLon: null,
      lastAccuracy: null,
      status: 'active'
    };
    setState(plate, state);
    return state;
  }

  function stopSession(plate, reason) {
    var state = getState(plate);
    if (!state) return null;
    state.status = 'stopped';
    state.stoppedAt = Date.now();
    state.stopReason = reason || 'manual';
    setState(plate, state);
    enqueuePendingIfAny_(state); // ЭТАП 3: не потерять неотправленный пробег надолго offline
    return state;
  }

  /** Останавливает (в хранилище) любую активную сессию для номера,
   *  отличного от keepPlate. Не трогает саму активность watchPosition —
   *  это ответственность gps-tracker.js, который должен проверять
   *  getState(plate).status перед накоплением расстояния. */
  function stopAllExcept(keepPlate) {
    var keepKey = keepPlate ? keyFor(keepPlate) : null;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(PREFIX + 'session_') !== 0) continue;
        if (keepKey && k === keepKey) continue;
        var st = safeGet(k);
        if (st && st.status === 'active') {
          st.status = 'stopped';
          st.stoppedAt = Date.now();
          st.stopReason = 'vehicle_changed';
          safeSet(k, st);
          enqueuePendingIfAny_(st); // ЭТАП 3: смена авто тоже не должна терять накопленный пробег
        }
      }
    } catch (e) { /* не критично */ }
  }

  /** Прибавляет расстояние к активной сессии и обновляет последнюю
   *  известную точку. Возвращает обновлённое состояние или null, если
   *  активной сессии для этого номера нет (тогда вызывающий код не должен
   *  был вообще звать addDistance — защита от несогласованных вызовов). */
  function addDistance(plate, deltaKm, point) {
    var state = getState(plate);
    if (!state || state.status !== 'active') return null;
    state.distanceKm = Math.round((state.distanceKm + deltaKm) * 1000) / 1000;
    state.lastPointAt = Date.now();
    if (point) {
      state.lastLat = point.lat;
      state.lastLon = point.lon;
      state.lastAccuracy = point.accuracy;
    }
    setState(plate, state);
    return state;
  }

  /** Сколько накоплено, но ещё не подтверждено сервером как отправленное
   *  (для Этапа 4 — что именно отправлять при следующей синхронизации). */
  function getPendingDistanceKm(plate) {
    var state = getState(plate);
    if (!state) return 0;
    return Math.max(0, Math.round((state.distanceKm - state.syncedDistanceKm) * 1000) / 1000);
  }

  /** Помечает часть накопленного расстояния как успешно отправленную —
   *  вызывается ТОЛЬКО из gps-sync.js после подтверждённого ответа сервера
   *  (Этап 4). Не удаляет сессию — сессия продолжает жить, пока не будет
   *  явно остановлена. */
  function markSynced(plate, syncedKm) {
    var state = getState(plate);
    if (!state) return null;
    state.syncedDistanceKm = Math.min(state.distanceKm, state.syncedDistanceKm + syncedKm);
    setState(plate, state);
    return state;
  }

  // ================= ЭТАП 3: durable pending-queue =================

  var IDB_NAME = 'ccs_gps_db';
  var IDB_VERSION = 1;
  var IDB_STORE = 'pending_sessions';
  var LS_QUEUE_KEY = PREFIX + 'queue_fallback'; // используется, только если IndexedDB недоступна
  var LS_QUEUE_MAX = 500; // защита от неограниченного роста в fallback-режиме (п.10 ТЗ)

  var idbAvailable = (typeof global.indexedDB !== 'undefined' && global.indexedDB !== null);
  var idbOpenPromise = null; // кэшируем открытие, чтобы не открывать БД на каждый вызов

  function openDb_() {
    if (!idbAvailable) return Promise.resolve(null);
    if (idbOpenPromise) return idbOpenPromise;

    idbOpenPromise = new Promise(function (resolve) {
      var req;
      try {
        req = global.indexedDB.open(IDB_NAME, IDB_VERSION);
      } catch (e) {
        // Некоторые браузеры (старый Safari в приватном режиме) бросают
        // синхронно при попытке открыть indexedDB — не роняем модуль.
        resolve(null);
        return;
      }
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        // Диск полон / приватный режим / политика браузера — честно
        // считаем IndexedDB недоступной для этой сессии и используем
        // localStorage-fallback (см. ниже), ничего не падает.
        resolve(null);
      };
    }).catch(function () { return null; });

    return idbOpenPromise;
  }

  function idbPut_(record) {
    return openDb_().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(record);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
          tx.onabort = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function idbGetAll_() {
    return openDb_().then(function (db) {
      if (!db) return null; // null = "IndexedDB недоступна", отличаем от [] = "пусто"
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function idbDelete_(id) {
    return openDb_().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(id);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  // ---- localStorage fallback для очереди (только если IndexedDB нет) ----

  function lsQueueGetAll_() {
    var arr = safeGet(LS_QUEUE_KEY);
    return Array.isArray(arr) ? arr : [];
  }

  function lsQueuePut_(record) {
    var arr = lsQueueGetAll_().filter(function (r) { return r.id !== record.id; });
    arr.push(record);
    if (arr.length > LS_QUEUE_MAX) {
      // Не должно происходить в норме (значит, синхронизация давно не
      // проходила) — обрезаем самые старые записи, не роняя новые
      // (лучше потерять древнее, чем перестать писать вовсе).
      arr = arr.slice(arr.length - LS_QUEUE_MAX);
    }
    safeSet(LS_QUEUE_KEY, arr);
  }

  function lsQueueDelete_(id) {
    var arr = lsQueueGetAll_().filter(function (r) { return r.id !== id; });
    safeSet(LS_QUEUE_KEY, arr);
  }

  /* Кладёт в durable-очередь агрегат по завершённой (stopped) сессии, если в ней осталось неотправленное расстояние. */
  function enqueuePendingIfAny_(state) {
    if (!state) return;
    var pendingKm = Math.max(0, Math.round((state.distanceKm - state.syncedDistanceKm) * 1000) / 1000);
    if (pendingKm <= 0) return;

    var record = {
      id: state.plate + '_' + state.sessionId,       // используется и как idempotency-ключ на Этапе 4/5
      plate: state.plate,
      sessionId: state.sessionId,
      deviceToken: state.deviceToken || '',
      distanceKm: pendingKm,
      totalDistanceKm: state.distanceKm,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt || Date.now(),
      stopReason: state.stopReason || 'unknown',
      createdAt: Date.now()
    };

    idbPut_(record).then(function (ok) {
      if (!ok) lsQueuePut_(record); // IndexedDB недоступна/не удалось — честный fallback
    }).catch(function () {
      lsQueuePut_(record);
    });
  }

  /* Возвращает Promise<Array<record>> — все завершённые сессии, которые ещё не подтверждены сервером как отправленные. */
  function getPendingQueue() {
    return idbGetAll_().then(function (idbRecords) {
      if (idbRecords !== null) {
        return idbRecords.map(function (r) {
          r._backend = 'idb';
          return r;
        });
      }
      // IndexedDB недоступна в этом браузере/режиме — используем fallback.
      return lsQueueGetAll_().map(function (r) {
        r._backend = 'ls';
        return r;
      });
    }).catch(function () {
      return lsQueueGetAll_().map(function (r) {
        r._backend = 'ls';
        return r;
      });
    });
  }

  /* Убирает запись из очереди ПОСЛЕ подтверждённого ответа сервера (Этап 4). */
  function removeFromQueue(record) {
    if (!record || !record.id) return Promise.resolve(false);
    if (record._backend === 'ls') {
      lsQueueDelete_(record.id);
      return Promise.resolve(true);
    }
    return idbDelete_(record.id).catch(function () { return false; });
  }

  global.CCSGpsStorage = {
    getState: getState,
    setState: setState,
    clearState: clearState,
    startSession: startSession,
    stopSession: stopSession,
    stopAllExcept: stopAllExcept,
    addDistance: addDistance,
    getPendingDistanceKm: getPendingDistanceKm,
    markSynced: markSynced,
    // ЭТАП 3:
    getPendingQueue: getPendingQueue,
    removeFromQueue: removeFromQueue
  };
})(window);
