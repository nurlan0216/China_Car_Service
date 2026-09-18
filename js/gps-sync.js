/* js/gps-sync.js — (заглушка/контракт) + (реальная отправка) ------------------------------------------------------------- Этап 2 дал контракт getPendingPayload/hasPending/trySync — он оставлен без… */
(function (global) {
  'use strict';

  // Этап 4 присвоит сюда функцию вида: function (payload) { return fetch(...).then(...); } На Этапе 2 хендлера нет — trySync() ничего не отправляет намеренно (п.13 ТЗ: "если нет активного запроса — не…
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

  /* Этап 2: если хендлер ещё не подключен (обычная ситуация до Этапа 4), ничего не делает и просто резолвится — GPS-данные остаются локально накопленными в gps-storage.js, ждать нечего, ошибки тоже нет. */
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

  /* реальная синхронизация. */
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
