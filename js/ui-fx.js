/* ЭТАП 8 (промт «UI: анимации, фон, тема»), Блок A.3 — общие микро-анимации.

   Один файл на все страницы (как js/push-card.js) — вместо копий одного и
   того же кода в каждом html. Весь CSS (спиннер, skeleton, галочка) лежит в
   css/theme.css; здесь только логика. Подключается обычным
   <script src="js/ui-fx.js"></script> (без defer — функции нужны обработчикам
   кнопок, но вызываются они уже после загрузки страницы).

   window.CCSUI:
     busyButton(btn, busyText, fn)  — кнопка блокируется на время промиса fn(),
         внутри неё крутится спиннер + busyText, потом всё возвращается как было.
         Именно эту функцию вызывают локальные withButtonBusy_ на страницах.
     success(text[, ms])            — заметная галочка «сохранено» по центру экрана.
     checkInline()                  — HTML маленькой анимированной галочки для статус-строк.
     skeleton(container, opts)      — пульсирующие серые блоки вместо пустого экрана.
     skeletonClear(container, restore) — убрать заглушку (restore=true — вернуть прежний контент).
     bounce(el)                     — короткий «пружинистый» акцент на элементе.

   Всё уважает prefers-reduced-motion (см. css/theme.css, раздел 5). Ничего не
   меняет в данных/API. */
(function (global) {
  'use strict';

  var CHECK_PATH = 'M14 27l8 8 16-17';

  // ---------- кнопка «занято» ----------
  // Отличия от старых локальных копий withButtonBusy_:
  //  • спиннер внутри кнопки, а не просто «заблокирована + другой текст»;
  //  • возвращает прежнюю РАЗМЕТКУ кнопки (innerHTML), а не только текст — иконки/<b> внутри не теряются;
  //  • если fn() бросит исключение синхронно — кнопка всё равно разблокируется
  //    (раньше оставалась disabled навсегда).
  function busyButton(btn, busyText, fn) {
    if (!btn) return fn();
    var origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('ccs-busy');
    btn.setAttribute('aria-busy', 'true');

    var spin = document.createElement('span');
    spin.className = 'ccs-btn-spin';
    spin.setAttribute('aria-hidden', 'true');
    var label = document.createElement('span');
    label.textContent = busyText;
    btn.textContent = '';
    btn.appendChild(spin);
    btn.appendChild(label);

    var restored = false;
    var restore = function () {
      if (restored) return;
      restored = true;
      btn.disabled = false;
      btn.classList.remove('ccs-busy');
      btn.removeAttribute('aria-busy');
      btn.innerHTML = origHtml;
    };

    var result;
    try { result = fn(); } catch (e) { restore(); throw e; }
    if (result && typeof result.finally === 'function') return result.finally(restore);
    restore();
    return result;
  }

  // ---------- галочка «успешно» ----------
  var successTimer = null;
  function checkSvg_(cls) {
    return '<svg class="' + cls + '" viewBox="0 0 52 52" aria-hidden="true" focusable="false">'
      + (cls === 'ccs-tick-svg' ? '<circle class="ccs-tick-circle" cx="26" cy="26" r="23"/>' : '')
      + '<path class="ccs-tick-mark" d="' + CHECK_PATH + '"/></svg>';
  }

  function success(text, ms) {
    var old = document.querySelector('.ccs-success');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }

    var box = document.createElement('div');
    box.className = 'ccs-success';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.innerHTML = checkSvg_('ccs-tick-svg');
    var t = document.createElement('div');
    t.textContent = text || 'Готово';
    box.appendChild(t);
    document.body.appendChild(box);

    successTimer = setTimeout(function () {
      box.classList.add('ccs-out');
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 300);
      successTimer = null;
    }, ms || 1700);
  }

  // маленькая галочка для вставки в innerHTML статус-строки: el.innerHTML = CCSUI.checkInline() + 'Сохранено'
  function checkInline() {
    return '<svg class="ccs-check-inline" viewBox="0 0 52 52" aria-hidden="true" focusable="false"><path d="' + CHECK_PATH + '"/></svg>';
  }

  // ---------- skeleton ----------
  // variant: 'table' (строки «дата | описание | сумма»), 'cards' (карточки-блоки), 'lines' (текстовые строки)
  function skeleton(container, opts) {
    if (!container) return;
    opts = opts || {};
    var rows = Math.max(1, Math.min(10, opts.rows || 4));
    var variant = opts.variant || 'table';
    // запоминаем, что было (для restore при ошибке) — но только если заглушка ещё не показана
    if (!container.querySelector('.ccs-skel')) container.__ccsPrev = container.innerHTML;
    var html = '<div class="ccs-skel" role="status" aria-label="Загрузка">';
    var i;
    if (variant === 'cards') {
      for (i = 0; i < rows; i++) html += '<div class="ccs-skel-card"></div>';
    } else if (variant === 'lines') {
      var widths = ['w85', 'w60', 'w40'];
      for (i = 0; i < rows; i++) html += '<span class="ccs-skel-bar ccs-skel-line ' + widths[i % 3] + '"></span>';
    } else {
      for (i = 0; i < rows; i++) html += '<div class="ccs-skel-row"><span class="ccs-skel-bar"></span><span class="ccs-skel-bar"></span><span class="ccs-skel-bar"></span></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // Убирает заглушку, ТОЛЬКО если она ещё на месте (если реальные данные уже
  // отрисовались поверх — ничего не трогает). restore=true — вернуть прежний
  // контент (нужно при ошибке запроса, чтобы не оставить пользователя с пустотой).
  function skeletonClear(container, restore) {
    if (!container || !container.querySelector) return;
    if (container.querySelector('.ccs-skel')) {
      container.innerHTML = restore ? (container.__ccsPrev || '') : '';
    }
    container.__ccsPrev = null;
  }

  function bounce(el) {
    if (!el) return;
    el.classList.remove('ccs-bounce');
    void el.offsetWidth; // reflow — чтобы анимация перезапускалась при повторных вызовах
    el.classList.add('ccs-bounce');
    setTimeout(function () { el.classList.remove('ccs-bounce'); }, 600);
  }

  global.CCSUI = {
    busyButton: busyButton,
    success: success,
    checkInline: checkInline,
    skeleton: skeleton,
    skeletonClear: skeletonClear,
    bounce: bounce
  };
})(window);
