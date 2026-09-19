/* ЭТАП 8 (промт «UI: анимации, фон, тема»), Блок A.1/A.2 — логика темы.

   Подключается как <script src="js/theme.js" defer></script>; весь CSS (палитра,
   кнопка, фон, reduced-motion) лежит в css/theme.css.

   Порядок определения темы (приоритет по промту):
     1) сохранённый выбор пользователя — localStorage['ccs-theme'] ('light'|'dark')
     2) системная настройка prefers-color-scheme
     3) light по умолчанию
   Само ПЕРВОЕ применение темы делает крошечный инлайн-скрипт в <head> каждой
   страницы (синхронно, до первой отрисовки — чтобы не было «вспышки»); этот
   файл достраивает поверх: кнопку, сохранение, синхронизацию вкладок,
   реакцию на смену системной темы, параллакс и «лёгкий режим».

   Ничего не меняет в данных/API — только визуал. */
(function () {
  'use strict';

  var STORAGE_KEY = 'ccs-theme';
  var root = document.documentElement;

  function readSaved_() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) { return null; }
  }

  function systemTheme_() {
    try {
      if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) { /* старые браузеры */ }
    return 'light'; // пункт 3 приоритета
  }

  function getTheme() {
    var t = root.getAttribute('data-theme');
    return (t === 'light' || t === 'dark') ? t : (readSaved_() || systemTheme_());
  }

  // <meta name="theme-color"> красит адресную строку/статус-бар мобильного браузера и установленного PWA
  function updateThemeColorMeta_() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    // ждём кадр, чтобы браузер успел пересчитать CSS-переменные после смены data-theme
    requestAnimationFrame(function () {
      var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    });
  }

  var toggleBtn = null;
  function updateToggleLabel_() {
    if (!toggleBtn) return;
    var label = getTheme() === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('title', label);
  }

  // persist=false — когда тему сменили В ДРУГОЙ вкладке (значение уже лежит в localStorage) или система
  function applyTheme_(theme, persist, animate) {
    if (animate) {
      root.classList.add('ccs-theme-transition');
      setTimeout(function () { root.classList.remove('ccs-theme-transition'); }, 320);
    }
    root.setAttribute('data-theme', theme);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* приватный режим/квота — не критично */ }
    }
    updateThemeColorMeta_();
    updateToggleLabel_();
    try { window.dispatchEvent(new CustomEvent('ccs-theme-change', { detail: { theme: theme } })); } catch (e) { /* IE */ }
  }

  function toggle_() { applyTheme_(getTheme() === 'dark' ? 'light' : 'dark', true, true); }

  var SVG_NS_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ';
  var ICON_MOON = SVG_NS_OPEN + 'class="ccs-ic-moon"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_SUN = SVG_NS_OPEN + 'class="ccs-ic-sun"><circle cx="12" cy="12" r="4.2"/>'
    + '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>';

  function createToggle_() {
    if (document.querySelector('.ccs-theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ccs-theme-toggle';
    btn.innerHTML = ICON_MOON + ICON_SUN; // какая иконка видна — решает CSS по html[data-theme]
    btn.addEventListener('click', toggle_);
    document.body.appendChild(btn);
    toggleBtn = btn;
    updateToggleLabel_();
  }

  // ---- синхронизация между вкладками: тема поменялась в соседней вкладке → применяем без перезагрузки ----
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    var next = (e.newValue === 'light' || e.newValue === 'dark') ? e.newValue : systemTheme_();
    if (next !== getTheme()) applyTheme_(next, false, true);
  });

  // ---- пока пользователь сам ничего не выбирал — следуем за системной темой (день/ночь на телефоне) ----
  try {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onSysChange = function () {
      if (readSaved_()) return; // явный выбор пользователя приоритетнее системы
      var next = systemTheme_();
      if (next !== getTheme()) applyTheme_(next, false, true);
    };
    if (mq.addEventListener) mq.addEventListener('change', onSysChange);
    else if (mq.addListener) mq.addListener(onSysChange);
  } catch (e) { /* нет matchMedia */ }

  // ---- «лёгкий режим»: на слабых устройствах живой фон не анимируем вообще ----
  function detectLowFx_() {
    try {
      var nav = navigator;
      var conn = nav.connection || nav.mozConnection || nav.webkitConnection;
      if (conn && conn.saveData) return true;
      if (nav.deviceMemory && nav.deviceMemory <= 2) return true;
      if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) return true;
    } catch (e) { /* не критично */ }
    return false;
  }

  // ---- лёгкий параллакс живого фона (только клиентские страницы, не при reduced-motion/lowfx) ----
  function initParallax_() {
    if (!document.body.classList.contains('ccs-bg-client')) return;
    var reduce = false;
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    if (reduce || root.classList.contains('ccs-lowfx')) return;
    var ticking = false;
    function update() {
      ticking = false;
      // фон сдвигается всего на ~6% от прокрутки и не более ±60px — «подложка», а не эффект
      var y = Math.max(-60, Math.min(60, -(window.pageYOffset || 0) * 0.06));
      root.style.setProperty('--ccs-par', y.toFixed(1) + 'px');
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
  }

  function init() {
    if (detectLowFx_()) root.classList.add('ccs-lowfx');
    createToggle_();
    updateThemeColorMeta_();
    initParallax_();
  }

  // публичный API — на случай, если странице понадобится реагировать на тему (например, перерисовать canvas)
  window.CCSTheme = {
    get: getTheme,
    set: function (t) { if (t === 'light' || t === 'dark') applyTheme_(t, true, true); },
    toggle: toggle_
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
