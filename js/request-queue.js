/* js/request-queue.js — общая локальная очередь изменяющих POST-запросов
   (ошибка 5 плана исправлений). Подключается в to.html, driver.html,
   taxipark.html и act.html.

   Идея: запрос, который не удалось доставить (нет сети, таймаут, сервер занят
   блокировкой), НЕ теряется — он сохраняется на устройстве и отправляется
   автоматически позже. Каждый запрос несёт свой clientRequestId, и при
   повторной отправке id остаётся ТЕМ ЖЕ — сервер (withIdempotency_ в
   WebApp.gs) по нему отсекает дубли, поэтому «отправили дважды» не создаёт
   вторую запись.

   Использование:
     var q = CCSRequestQueue.create({
       storageKey: 'to_retry_queue',        // ключ localStorage (или имя БД IndexedDB)
       storage: 'local' | 'idb',            // по умолчанию 'local'; 'idb' — для больших данных (PDF акта)
       scriptUrl: SCRIPT_URL,               // по умолчанию глобальная SCRIPT_URL из js/config.js
       badgeId: 'retryQueueBadge',          // необязательно: элемент для счётчика (иначе плашка создаётся сама)
       timeoutMs: 15000,                    // таймаут одной попытки
       keepRejected: false,                 // true — отклонённые сервером записи не удаляются, а остаются как «failed»
       prepare: function (payload) {...},   // необязательно: обновить логин/пароль/токен перед отправкой; вернуть null — пропустить пока
       onSent: function (item, res) {...},  // запись, ждавшая в очереди, наконец принята сервером
       onRejected: function (item, res, info) {...}, // сервер окончательно отказал (info.permanent) или сдались после N попыток (info.gaveUp)
       onChange: function (counts) {...}    // {pending, failed}
     });
     q.send(payload, { label: '...' }).then(function (o) {
       // o.queued === true  — сохранено в очередь (показать CCSRequestQueue.QUEUED_MESSAGE)
       // иначе o.res — ответ сервера (ok:true либо обычная бизнес-ошибка)
     });
     q.enqueue(payload, label) — положить в очередь напрямую (для запросов со своим транспортом, например XHR с прогрессом) → Promise<boolean>
*/
(function (global) {
  'use strict';

  var BACKOFF_MS = [1500, 4000];        // паузы между попытками внутри одного send()
  var FLUSH_EVERY_MS = 20000;           // как часто очередь пробует отправиться сама
  var MAX_SERVER_FAILS = 8;             // столько раз сервер может ответить ошибкой, прежде чем запись помечается «failed»
  var QUEUED_MESSAGE = 'Сохранено, отправим автоматически, когда сервер освободится';
  var STORAGE_FULL_MESSAGE = 'Нет связи с сервером, а сохранить запрос для автоотправки не удалось (слишком большой объём или нет места на устройстве). Введённые данные не потеряны — повторите позже.';

  // временные отказы сервера — повторять имеет смысл. Слова «пароль»/«найден» сюда попадать не должны.
  var TRANSIENT_RE = /блокировк|перегруз|попробуйте ещё раз|timeout|timed out|too many times|используется как API|обрабатывается/i;
  // окончательные отказы: повтор бессмысленен (неверный пароль, «не найден», ошибка ввода)
  var PERMANENT_RE = /пароль|найден|нет прав|недостаточно прав|некоррект|не указан|заполните/i;

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'cr_' + Date.now() + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function errText(res) { return '' + ((res && (res.error || res.message)) || ''); }
  function isTransient(res) {
    return !!res && res.ok === false && (res.inProgress === true || TRANSIENT_RE.test(errText(res)));
  }
  function isPermanent(res) {
    return !!res && res.ok === false && !isTransient(res) && PERMANENT_RE.test(errText(res));
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fetchOnce(url, options, timeoutMs) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var opts = Object.assign({}, options);
    if (controller) opts.signal = controller.signal;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    return fetch(url, opts).finally(function () { if (timer) clearTimeout(timer); });
  }

  // POST text/plain (без preflight). Сетевая ошибка/таймаут/не-JSON → повтор с паузами backoff, затем reject.
  // Ответ-заглушка «используется как API» (302 при редеплое превратил POST в GET) — один тихий повтор.
  function postJson(url, payload, timeoutMs, backoff) {
    var body = JSON.stringify(payload);
    var stubRetried = false;
    function attempt(n) {
      return fetchOnce(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
      }, timeoutMs)
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!stubRetried && res && /используется как API/.test(errText(res))) {
            stubRetried = true;
            return delay(1500).then(function () { return attempt(n); });
          }
          return res;
        })
        .catch(function (err) {
          if (n >= backoff.length) throw err;
          return delay(backoff[n]).then(function () { return attempt(n + 1); });
        });
    }
    return attempt(0);
  }

  /* ---------- хранилища: read() и атомарный mutate(fn) ----------
     fn(list) → { list: новыйСписок, result: любое }. Если запись не удалась
     (переполнено/недоступно), mutate вернёт {list:null, result:false}. */
  function localStorageAdapter(key) {
    function read() {
      try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; }
    }
    return {
      read: function () { return Promise.resolve(read()); },
      mutate: function (fn) {
        var out = fn(read());
        try { localStorage.setItem(key, JSON.stringify(out.list)); }
        catch (e) { return Promise.resolve({ list: null, result: false }); }
        return Promise.resolve(out);
      }
    };
  }

  function idbAdapter(name) {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open('ccs_queue_' + name, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('items', { keyPath: 'id' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function byTs(a, b) { return (a.ts || 0) - (b.ts || 0); }
    return {
      read: function () {
        return open().then(function (db) {
          return new Promise(function (resolve) {
            var tx = db.transaction('items', 'readonly');
            var req = tx.objectStore('items').getAll();
            req.onsuccess = function () { resolve((req.result || []).sort(byTs)); };
            req.onerror = function () { resolve([]); };
          });
        }).catch(function () { return []; });
      },
      mutate: function (fn) {
        return open().then(function (db) {
          return new Promise(function (resolve) {
            var tx = db.transaction('items', 'readwrite');
            var store = tx.objectStore('items');
            var out = null;
            var req = store.getAll();
            req.onsuccess = function () {
              out = fn((req.result || []).sort(byTs));
              store.clear();
              out.list.forEach(function (it) { store.put(it); });
            };
            tx.oncomplete = function () { resolve(out || { list: null, result: false }); };
            tx.onabort = tx.onerror = function () { resolve({ list: null, result: false }); };
          });
        }).catch(function () { return { list: null, result: false }; });
      }
    };
  }

  function create(opts) {
    opts = opts || {};
    var url = opts.scriptUrl || global.SCRIPT_URL;
    var timeoutMs = opts.timeoutMs || 15000;
    var storage = (opts.storage === 'idb' && global.indexedDB)
      ? idbAdapter(opts.storageKey || 'default')
      : localStorageAdapter(opts.storageKey || 'ccs_retry_queue');
    var counts = { pending: 0, failed: 0 };
    var flushing = false;

    /* ---- плашка со счётчиком ---- */
    function badgeEl() {
      var el = opts.badgeId ? document.getElementById(opts.badgeId) : null;
      if (el) return el;
      if (opts.badgeId === false) return null;
      var auto = document.getElementById('ccsQueueBadge_' + (opts.storageKey || ''));
      if (auto) return auto;
      if (!document.body) return null;
      auto = document.createElement('div');
      auto.id = 'ccsQueueBadge_' + (opts.storageKey || '');
      auto.style.cssText = 'display:none;position:fixed;left:8px;bottom:8px;z-index:9998;max-width:calc(100% - 16px);' +
        'padding:8px 10px;border-radius:8px;background:#3b2f10;color:#f5c451;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.35)';
      document.body.appendChild(auto);
      return auto;
    }
    function renderBadge() {
      var el = badgeEl();
      if (!el) return;
      var parts = [];
      if (counts.pending) parts.push('⏳ Не отправлено (ждёт связи с сервером): ' + counts.pending);
      if (counts.failed) parts.push('⚠️ Сервер не принял: ' + counts.failed);
      el.style.display = parts.length ? 'block' : 'none';
      el.innerText = parts.join(' · ');
    }
    function publish(list) {
      if (!list) return; // запись не удалась — счётчики остаются прежними
      var p = 0, f = 0;
      list.forEach(function (x) { if (x.status === 'failed') f++; else p++; });
      counts = { pending: p, failed: f };
      renderBadge();
      if (opts.onChange) { try { opts.onChange({ pending: p, failed: f }); } catch (e) { /* не критично */ } }
    }
    function mutate(fn) {
      return storage.mutate(fn).then(function (out) {
        publish(out.list);
        return out.result;
      });
    }

    /* ---- операции над очередью ---- */
    function enqueue(payload, label) {
      if (!payload.clientRequestId) payload.clientRequestId = newId();
      var cid = payload.clientRequestId;
      return mutate(function (list) {
        // тот же запрос (тот же clientRequestId) второй раз не добавляем
        if (list.some(function (x) { return x.payload && x.payload.clientRequestId === cid; })) {
          return { list: list, result: true };
        }
        list.push({
          id: Date.now() + '_' + Math.random().toString(36).slice(2),
          payload: payload, label: label || '', ts: Date.now(),
          attempts: 0, nextTry: 0, status: 'pending'
        });
        return { list: list, result: true };
      }).then(function (ok) { return ok === true; });
    }
    function removeByRequestId(cid) {
      return mutate(function (list) {
        return { list: list.filter(function (x) { return !(x.payload && x.payload.clientRequestId === cid); }), result: true };
      });
    }
    function patchItem(id, patch, remove) {
      return mutate(function (list) {
        var out = [];
        list.forEach(function (x) {
          if (x.id !== id) { out.push(x); return; }
          if (!remove) out.push(Object.assign({}, x, patch));
        });
        return { list: out, result: true };
      });
    }

    /* ---- отправка накопленного ---- */
    function flush() {
      if (flushing || !counts.pending) return Promise.resolve();
      flushing = true;
      var again = false;
      return storage.read().then(function (list) {
        var now = Date.now();
        var cand = null, prepared = null;
        for (var i = 0; i < list.length; i++) {
          var x = list[i];
          if (x.status === 'failed' || (x.nextTry || 0) > now) continue;
          var p = opts.prepare ? opts.prepare(Object.assign({}, x.payload)) : x.payload;
          if (p) { cand = x; prepared = p; break; }
        }
        if (!cand) return;
        // одна попытка без внутренних пауз — очередь и так повторяет по таймеру
        return postJson(url, prepared, timeoutMs, []).then(function (res) {
          again = true;
          if (res && res.ok === true) {
            return patchItem(cand.id, null, true).then(function () {
              if (opts.onSent) { try { opts.onSent(cand, res); } catch (e) { /* не критично */ } }
            });
          }
          if (isPermanent(res)) {
            var keep = !!opts.keepRejected;
            return patchItem(cand.id, { status: 'failed', lastError: errText(res) }, !keep).then(function () {
              if (opts.onRejected) { try { opts.onRejected(cand, res, { permanent: true }); } catch (e) { /* не критично */ } }
            });
          }
          // временная/неизвестная ошибка сервера: отодвигаем ЭТУ запись, остальные не блокируем
          var attempts = (cand.attempts || 0) + 1;
          if (attempts >= MAX_SERVER_FAILS) {
            return patchItem(cand.id, { status: 'failed', attempts: attempts, lastError: errText(res) }).then(function () {
              if (opts.onRejected) { try { opts.onRejected(cand, res, { gaveUp: true }); } catch (e) { /* не критично */ } }
            });
          }
          var wait = Math.min(60000, 5000 * Math.pow(2, attempts - 1));
          return patchItem(cand.id, { attempts: attempts, nextTry: Date.now() + wait, lastError: errText(res) });
        }, function () {
          /* сети всё ещё нет — ничего не меняем, попробуем по таймеру/событию online */
        });
      }).then(function () {
        flushing = false;
        if (again && counts.pending) setTimeout(flush, 800);
      }, function () { flushing = false; });
    }

    function queueIt(payload, label, res) {
      return enqueue(payload, label).then(function (ok) {
        if (ok) { setTimeout(flush, FLUSH_EVERY_MS / 2); return { queued: true, res: res || null }; }
        return { queued: false, res: { ok: false, error: STORAGE_FULL_MESSAGE, notQueued: true } };
      });
    }

    // Отправка с автоматической постановкой в очередь при сбое связи/занятом сервере.
    function send(payload, sopts) {
      sopts = sopts || {};
      if (!payload.clientRequestId) payload.clientRequestId = newId();
      var cid = payload.clientRequestId;
      return postJson(url, payload, timeoutMs, BACKOFF_MS).then(function (res) {
        if (res && res.ok === true) {
          if (counts.pending) removeByRequestId(cid); // тот же запрос мог уже лежать в очереди
          return { queued: false, res: res };
        }
        if (isTransient(res)) return queueIt(payload, sopts.label, res);
        return { queued: false, res: res };
      }, function () {
        return queueIt(payload, sopts.label, null);
      });
    }

    /* ---- автозапуск ---- */
    function tick() { if (!document.hidden) flush(); }
    global.addEventListener('online', flush);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
    setInterval(tick, FLUSH_EVERY_MS);

    // при открытии страницы: подсчёт, «failed» получают ещё один шанс, затем отправка
    var ready = storage.mutate(function (list) {
      list.forEach(function (x) {
        if (x.status === 'failed') { x.status = 'pending'; x.attempts = 0; x.nextTry = 0; }
      });
      return { list: list, result: true };
    }).then(function (out) { publish(out.list); return flush(); });

    return {
      send: send,
      enqueue: enqueue,
      flush: flush,
      removeByRequestId: removeByRequestId,
      counts: function () { return { pending: counts.pending, failed: counts.failed }; },
      ready: ready
    };
  }

  // Для действий, которые НЕЛЬЗЯ класть в очередь (секреты вроде нового пароля, «выдай ссылку прямо сейчас»):
  // пока ответа сервера не было, повтор ТОГО ЖЕ действия с теми же данными уходит с тем же clientRequestId.
  var stableIds = {};
  function stablePost(payload, opts) {
    opts = opts || {};
    var url = opts.scriptUrl || global.SCRIPT_URL;
    var sig = JSON.stringify(payload);
    if (!stableIds[sig]) stableIds[sig] = newId();
    var body = Object.assign({}, payload, { clientRequestId: stableIds[sig] });
    return postJson(url, body, opts.timeoutMs || 15000, BACKOFF_MS).then(function (res) {
      if (!(res && res.inProgress)) delete stableIds[sig];
      return res;
    });
  }

  global.CCSRequestQueue = {
    create: create,
    stablePost: stablePost,
    newId: newId,
    isTransient: isTransient,
    isPermanent: isPermanent,
    QUEUED_MESSAGE: QUEUED_MESSAGE
  };
})(window);
