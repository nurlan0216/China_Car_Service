/**
 * js/gps-sync.js — ЭТАП 2 (заглушка/контракт) + ЭТАП 4 (реальная отправка)
 * -------------------------------------------------------------
 * Этап 2 дал контракт getPendingPayload/hasPending/trySync — он оставлен
 * без изменений (пробег ТЕКУЩЕЙ активной сессии; сервер этот action пока
 * не принимает, поэтому trySync() без явного смысла применять — не
 * удалён, чтобы не ломать теоретических внешних вызывающих).
 *
 * Этап 4 (см. ARCHITECTURE_PLAN.md/STAGE_3_REPORT.md, "следующий шаг")
 * добавляет trySyncQueue() — реальную отправку durable-очереди
 * ЗАВЕРШЁННЫХ сессий (Этап 3, window.CCSGpsStorage.getPendingQueue()) на
 * Apps Script (action: 'gpsSync', см. apps-script/10_Gps.gs) через тот
 * же setSyncHandler(), который подключает driver.html.
 *
 * Требует window.CCSGpsStorage (подключать js/gps-storage.js раньше).
 *
 * Публичный интерфейс: window.CCSGpsSync
 *   .getPendingPayload(plate)   // Этап 2 — что отправили бы по горячему пути
 *   .hasPending(plate)          // Этап 2
 *   .setSyncHandler(fn)         // driver.html подставляет сюда apiPost()
 *   .trySync(plate)             // Этап 2 — не используется Этапом 4
 *   .trySyncQueue()             // ЭТАП 4 — реальная отправка очереди на сервер
 */
(function (global) {
  'use strict';

  // Этап 4 присвоит сюда функцию вида:
  //   function (payload) { return fetch(...).then(...); }
  // На Этапе 2 хендлера нет — trySync() ничего не отправляет намеренно
  // (п.13 ТЗ: "если нет активного запроса — не отправлять немедленно
  // только ради GPS").
  var syncHandler = null;

  function getPendingPayload(plate) {
    if (!global.CCSGpsStorage) return null;
    var state = global.CCSGpsStorage.getState(plate);
    if (!state) return null;
    var pendingKm = global.CCSGpsStorage.getPendingDistanceKm(plate);
    if (pendingKm <= 0) return null;
    return {
      action: 'gpsSync', // будущий action в doPost (Этап 4), не используется на Этапе 2
      plate: state.plate,
      sessionId: state.sessionId,
      deviceToken: state.deviceToken || '',
      distanceKm: pendingKm,
      startedAt: state.startedAt,
      lastPointTimestamp: state.lastPointAt,
      status: state.status
    };
  }

  function hasPending(plate) {
    return !!getPendingPayload(plate);
  }

  function setSyncHandler(fn) {
    syncHandler = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Этап 2: если хендлер ещё не подключен (обычная ситуация до Этапа 4),
   * ничего не делает и просто резолвится — GPS-данные остаются локально
   * накопленными в gps-storage.js, ждать нечего, ошибки тоже нет.
   * Этап 4 подставит реальный HTTP-вызов через setSyncHandler(), и тогда
   * этот же trySync() начнёт действительно отправлять данные, объединяя
   * их с уже существующими запросами кабинета (см. план).
   */
  function trySync(plate) {
    var payload = getPendingPayload(plate);
    if (!payload) return Promise.resolve({ ok: true, skipped: 'nothing_pending' });
    if (!syncHandler) return Promise.resolve({ ok: true, skipped: 'no_handler_yet' });

    return Promise.resolve()
      .then(function () { return syncHandler(payload); })
      .then(function (res) {
        // Хендлер (Этап 4) сам решает, сколько км подтвердил сервер, и
        // вызывает CCSGpsStorage.markSynced — здесь мы это не предполагаем,
        // чтобы не задваивать логику подтверждения.
        return res;
      })
      .catch(function (err) {
        // Сетевая ошибка/недоступность Apps Script — данные остаются
        // локально, ничего не теряем (п.33 ТЗ).
        return { ok: false, error: (err && err.message) || 'sync_failed' };
      });
  }

  /**
   * ЭТАП 4 — реальная синхронизация. В отличие от trySync()/
   * getPendingPayload() выше (Этап 2 — пробег ТЕКУЩЕЙ ещё активной
   * сессии, этот контракт сервер пока не принимает), здесь отправляется
   * durable-очередь ЗАВЕРШЁННЫХ сессий из Этапа 3
   * (window.CCSGpsStorage.getPendingQueue()) — это то, что уже честно
   * протестировано на офлайн-надёжность (см. STAGE_3_REPORT.md) и то,
   * что явно указано как источник для Этапа 4 в его же "Следующий шаг".
   *
   * Один запрос — весь батч разу (может включать сессии по НЕСКОЛЬКИМ
   * гос. номерам, если водитель на этом устройстве успел сменить
   * машину до того, как связь появилась) — а не по одному запросу на
   * сессию, чтобы не плодить лишний трафик (п.17/41 ТЗ).
   *
   * Из очереди удаляются ТОЛЬКО записи, чей id сервер подтвердил в
   * acceptedSessionIds — то, что не подтверждено (сетевой сбой,
   * серверная ошибка на конкретной записи), остаётся в очереди и
   * попробует уйти при следующем вызове (см. driver.html, вызывается
   * из уже существующего 20-секундного цикла pollDataVersion_, без
   * создания нового отдельного постоянного опроса).
   */
  function trySyncQueue() {
    if (!global.CCSGpsStorage || typeof global.CCSGpsStorage.getPendingQueue !== 'function') {
      return Promise.resolve({ ok: true, skipped: 'no_storage' });
    }
    if (!syncHandler) {
      return Promise.resolve({ ok: true, skipped: 'no_handler_yet' });
    }

    return global.CCSGpsStorage.getPendingQueue().then(function (queue) {
      if (!queue || !queue.length) {
        return { ok: true, skipped: 'queue_empty' };
      }

      var sessions = queue.map(function (r) {
        return {
          id: r.id,
          plate: r.plate,
          sessionId: r.sessionId,
          deviceToken: r.deviceToken || '',
          distanceKm: r.distanceKm,
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt,
          stopReason: r.stopReason
        };
      });

      return Promise.resolve()
        .then(function () { return syncHandler({ action: 'gpsSync', sessions: sessions }); })
        .then(function (res) {
          if (!res || !res.ok) {
            return { ok: false, error: (res && res.error) || 'sync_failed' };
          }
          var acceptedIds = res.acceptedSessionIds || [];
          var acceptedSet = {};
          acceptedIds.forEach(function (id) { acceptedSet[id] = true; });

          return Promise.all(queue.map(function (rec) {
            if (acceptedSet[rec.id]) {
              return global.CCSGpsStorage.removeFromQueue(rec);
            }
            return Promise.resolve(false); // не подтверждена — остаётся в очереди на следующий раз
          })).then(function () {
            return { ok: true, sent: queue.length, accepted: acceptedIds.length };
          });
        })
        .catch(function (err) {
          // Сети нет/Apps Script недоступен — очередь остаётся нетронутой
          // (п.33 ТЗ), попробуем на следующем цикле pollDataVersion_.
          return { ok: false, error: (err && err.message) || 'sync_failed', offline: true };
        });
    });
  }

  global.CCSGpsSync = {
    getPendingPayload: getPendingPayload,
    hasPending: hasPending,
    setSyncHandler: setSyncHandler,
    trySync: trySync,
    // ЭТАП 4:
    trySyncQueue: trySyncQueue
  };
})(window);
