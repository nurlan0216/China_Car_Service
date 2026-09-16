/**
 * js/gps-tracker.js — ЭТАП 2 (только новая GPS-инфраструктура)
 * -------------------------------------------------------------
 * НОВЫЙ файл. Не подключается автоматически ни к какому экрану
 * интерфейса на этом этапе (п. "Пока НЕ подключать все функции
 * интерфейса") — только к безопасным точкам выхода (logout/смена
 * автомобиля), см. changelog Этапа 2 в отчёте.
 *
 * Требует window.CCSGpsStorage (js/gps-storage.js) — подключать ПЕРЕД
 * этим файлом.
 *
 * Публичный интерфейс: window.CCSGpsTracker
 *   .init({ testMode })
 *   .start(plate, deviceToken)
 *   .stop(reason)
 *   .getStatus()
 *   .onChange(callback)          // подписка на обновления статуса
 *   .simulate(lat, lon, accuracy, atMs) // только в GPS_TEST_MODE (п.48 ТЗ)
 */
(function (global) {
  'use strict';

  // ---- Настройки фильтрации (энергоэффективность + защита от мусора) ----
  var DEFAULTS = {
    enableHighAccuracy: false,   // экономия батареи (п.30 ТЗ) — точность важнее скорости отклика
    maximumAgeMs: 15000,         // можно переиспользовать недавнюю точку ОС
    timeoutMs: 20000,
    minAccuracyM: 50,            // хуже этого — точка отбрасывается (п.6 ТЗ)
    minMoveM: 25,                // микро-шум GPS в покое не считаем перемещением
    maxPlausibleSpeedKmh: 180,   // "скачки"/телепортации отбрасываются
    minIntervalMs: 8000          // не чаще одного засчитанного замера в этот период
  };

  var state = {
    testMode: false,
    watchId: null,
    plate: null,
    deviceToken: null,
    sessionId: null,
    listeners: [],
    lastAcceptedPoint: null, // { lat, lon, atMs }
    available: ('geolocation' in navigator),
    permission: 'unknown',   // 'unknown' | 'granted' | 'denied' | 'unavailable'
    running: false
  };

  function notify() {
    var status = getStatus();
    state.listeners.forEach(function (cb) {
      try { cb(status); } catch (e) { /* ошибка в подписчике не должна ломать трекер */ }
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // км
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function genSessionId() {
    return 'gps_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Основной фильтр. Возвращает true, если точку нужно засчитать
   * (и накопить расстояние), false — если это шум/скачок/дубль/старая точка.
   * Никогда не считает GPS-ошибку реальным пробегом (п.6 ТЗ) — при любом
   * сомнении (недостаточно данных, неправдоподобная скорость) точка
   * отбрасывается молча, без падения.
   */
  function processPoint_(lat, lon, accuracy, atMs) {
    atMs = atMs || Date.now();

    if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
      return; // некорректные координаты — игнор
    }
    if (typeof accuracy === 'number' && accuracy > DEFAULTS.minAccuracyM) {
      return; // плохая точность — игнор (п.6 ТЗ)
    }

    var prev = state.lastAcceptedPoint;
    if (!prev) {
      state.lastAcceptedPoint = { lat: lat, lon: lon, atMs: atMs };
      return; // первая точка сессии — только фиксируем базу, расстояние ещё не с чем сравнить
    }

    var dtMs = atMs - prev.atMs;
    if (dtMs < DEFAULTS.minIntervalMs) return; // слишком часто — не расходуем ресурсы на каждую секунду

    var distanceKm = haversineKm(prev.lat, prev.lon, lat, lon);
    var distanceM = distanceKm * 1000;

    if (distanceM < DEFAULTS.minMoveM) {
      // Стоим на месте / шум GPS — не двигаем "последнюю точку", чтобы
      // не накапливать дрейф от многократных мелких колебаний.
      return;
    }

    var hours = dtMs / 3600000;
    var speedKmh = hours > 0 ? distanceKm / hours : Infinity;
    if (speedKmh > DEFAULTS.maxPlausibleSpeedKmh) {
      // Явный "скачок"/телепортация — не считаем реальным пробегом
      // (п.6, 7 ТЗ), но обновляем базовую точку, чтобы один плохой замер
      // не блокировал накопление следующих корректных.
      state.lastAcceptedPoint = { lat: lat, lon: lon, atMs: atMs };
      return;
    }

    if (!state.plate) return; // защита: сессия не запущена
    var updated = global.CCSGpsStorage.addDistance(state.plate, distanceKm, { lat: lat, lon: lon, accuracy: accuracy });
    if (!updated) {
      // Сессия в хранилище не активна (например, была закрыта из другого
      // таба/при logout) — останавливаем watch, чтобы не работать вхолостую.
      stop('storage_inactive');
      return;
    }
    state.lastAcceptedPoint = { lat: lat, lon: lon, atMs: atMs };
    notify();
  }

  function onPositionSuccess_(pos) {
    state.permission = 'granted';
    processPoint_(
      pos.coords.latitude,
      pos.coords.longitude,
      pos.coords.accuracy,
      pos.timestamp || Date.now()
    );
  }

  function onPositionError_(err) {
    // Ошибка GPS не должна ломать сайт (п.33 ТЗ) — только фиксируем статус.
    if (err && err.code === 1) state.permission = 'denied';
    else if (err && err.code === 2) state.permission = 'unavailable';
    notify();
  }

  function init(opts) {
    opts = opts || {};
    state.testMode = !!opts.testMode; // GPS_TEST_MODE, п.48 ТЗ
    state.available = ('geolocation' in navigator);
    if (!state.available) state.permission = 'unavailable';
    return getStatus();
  }

  function start(plate, deviceToken) {
    if (!plate) return getStatus();
    if (!state.available && !state.testMode) {
      // GPS недоступен вообще — честно фиксируем и не запускаемся
      // (fallback на ручной одометр остаётся в интерфейсе, п.35 ТЗ).
      state.permission = 'unavailable';
      notify();
      return getStatus();
    }

    var normalizedPlate = String(plate).toUpperCase();
    var existing = global.CCSGpsStorage.getState(normalizedPlate);
    var resuming = !!(existing && existing.status === 'active');
    var sessionId = resuming ? existing.sessionId : genSessionId();

    global.CCSGpsStorage.startSession(normalizedPlate, sessionId, deviceToken || '');

    state.plate = normalizedPlate;
    state.deviceToken = deviceToken || '';
    state.sessionId = sessionId;
    // ФИКС («точка блокировки / точка включения»): если экран был
    // заблокирован (или страница просто перезапустилась — ОС часто
    // выгружает фоновую вкладку целиком, стирая ВЕСЬ JS в памяти, включая
    // lastAcceptedPoint ниже), раньше здесь ВСЕГДА стояло null — первая
    // точка после разблокировки просто "тихо" становилась новой базой, а
    // расстояние, пройденное ПОКА экран был заблокирован, терялось
    // целиком (GPS ведь эти километры физически не видел — заблокированный
    // экран останавливает не только эту вкладку, но и саму выдачу
    // координат браузером/ОС, это отдельное ограничение платформы, см.
    // предыдущий ответ). Что можно и нужно сохранить — это ПОСЛЕДНЮЮ
    // ИЗВЕСТНУЮ точку ДО блокировки (она уже лежит в CCSGpsStorage,
    // обновляется на каждой принятой точке, см. addDistance ниже). Если
    // сейчас продолжается та же активная сессия этой же машины — берём
    // именно её как базу, и первая же точка ПОСЛЕ включения экрана
    // сравнивается с ней: между "точкой блокировки" и "точкой включения"
    // считается прямое расстояние (haversine) и прибавляется к пробегу —
    // ровно так, как и предлагалось. Это не полный путь (что происходило
    // между двумя точками, GPS не видел), но хотя бы прямое смещение
    // учитывается, а не теряется совсем. Для новой сессии (другая машина
    // или сессии ещё не было) сравнивать не с чем — начинаем с чистого
    // листа, как и раньше.
    state.lastAcceptedPoint = (resuming && existing.lastLat != null && existing.lastLon != null && existing.lastPointAt)
      ? { lat: existing.lastLat, lon: existing.lastLon, atMs: existing.lastPointAt }
      : null;
    state.running = true;

    if (!state.testMode && state.available) {
      if (state.watchId !== null) {
        try { navigator.geolocation.clearWatch(state.watchId); } catch (e) { /* не критично */ }
      }
      state.watchId = navigator.geolocation.watchPosition(
        onPositionSuccess_,
        onPositionError_,
        {
          enableHighAccuracy: DEFAULTS.enableHighAccuracy,
          maximumAge: DEFAULTS.maximumAgeMs,
          timeout: DEFAULTS.timeoutMs
        }
      );
    }
    notify();
    return getStatus();
  }

  function stop(reason) {
    if (state.watchId !== null) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) { /* не критично */ }
      state.watchId = null;
    }
    if (state.plate) {
      global.CCSGpsStorage.stopSession(state.plate, reason || 'manual');
    }
    state.running = false;
    notify();
    return getStatus();
  }

  /** Только для GPS_TEST_MODE (п.48 ТЗ) — имитация точки без реального GPS,
   *  чтобы проверить фильтрацию/накопление/офлайн без выезда на улицу. */
  function simulate(lat, lon, accuracy, atMs) {
    if (!state.testMode) return getStatus();
    processPoint_(lat, lon, accuracy, atMs || Date.now());
    return getStatus();
  }

  function onChange(callback) {
    if (typeof callback === 'function') state.listeners.push(callback);
  }

  function getStatus() {
    var stored = state.plate ? global.CCSGpsStorage.getState(state.plate) : null;
    return {
      available: state.available,
      permission: state.permission,
      testMode: state.testMode,
      running: state.running,
      plate: state.plate,
      sessionId: state.sessionId,
      distanceKm: stored ? stored.distanceKm : 0,
      pendingKm: state.plate ? global.CCSGpsStorage.getPendingDistanceKm(state.plate) : 0,
      lastLat: stored ? stored.lastLat : null,
      lastLon: stored ? stored.lastLon : null,
      lastAccuracy: stored ? stored.lastAccuracy : null,
      lastPointAt: stored ? stored.lastPointAt : null,
      startedAt: stored ? stored.startedAt : null
    };
  }

  global.CCSGpsTracker = {
    init: init,
    start: start,
    stop: stop,
    simulate: simulate,
    onChange: onChange,
    getStatus: getStatus
  };
})(window);
