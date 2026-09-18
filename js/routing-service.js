/* Honghi EV Service — FREE routing service No paid API keys, no paid routing requests and no dependency on 2GIS/Yandex APIs. */
(function (global) {
  'use strict';

  var SERVICE = {
    lat: 43.2920,
    lon: 77.0079,
    name: 'Honghi EV Service',
    gisId: '9430047402871248'
  };
  var CACHE_KEY = 'ccs_route_cache_free_v1';
  var CACHE_TTL_MS = 10 * 60 * 1000;

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : Number(v); }
  function validPoint(lat, lon) { return isFinite(num(lat)) && isFinite(num(lon)); }

  function haversineKm(aLat, aLon, bLat, bLon) {
    var R = 6371;
    var dLat = (bLat - aLat) * Math.PI / 180;
    var dLon = (bLon - aLon) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function cacheGet_(key) {
    try {
      var raw = localStorage.getItem(CACHE_KEY + '_' + key);
      if (!raw) return null;
      var x = JSON.parse(raw);
      return x && (Date.now() - x.ts < CACHE_TTL_MS) ? x.data : null;
    } catch (e) { return null; }
  }

  function cacheSet_(key, data) {
    try { localStorage.setItem(CACHE_KEY + '_' + key, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
  }

  function localDistance(lat, lon) {
    if (!validPoint(lat, lon)) {
      return Promise.resolve({ ok: false, provider: 'local', road: false, error: 'GPS_NOT_AVAILABLE' });
    }
    var aLat = num(lat), aLon = num(lon);
    var key = aLat.toFixed(3) + '_' + aLon.toFixed(3);
    var cached = cacheGet_(key);
    if (cached) {
      cached.cached = true;
      return Promise.resolve(cached);
    }
    var result = {
      ok: true,
      provider: 'local',
      road: false,
      distanceKm: haversineKm(aLat, aLon, SERVICE.lat, SERVICE.lon),
      durationMin: null,
      cached: false,
      note: 'Расстояние по прямой GPS. API карт и платные сервисы не используются.'
    };
    cacheSet_(key, result);
    return Promise.resolve(result);
  }

  function getRoute(lat, lon) {
    return localDistance(lat, lon);
  }

  function open2gisRoute(lat, lon) {
    var origin = validPoint(lat, lon) ? (num(lon) + ',' + num(lat)) : '';
    var url = origin
      ? 'https://2gis.ru/almaty/directions/points/' + encodeURIComponent(origin + '|' + SERVICE.lon + ',' + SERVICE.lat)
      : 'https://2gis.ru/almaty/geo/' + SERVICE.gisId;
    return window.open(url, '_blank', 'noopener');
  }

  function openYandexRoute(lat, lon) {
    var url = 'https://yandex.ru/maps/?rtext=' +
      (validPoint(lat, lon) ? num(lat) + ',' + num(lon) + '~' : '') +
      SERVICE.lat + ',' + SERVICE.lon + '&rtt=auto';
    return window.open(url, '_blank', 'noopener');
  }

  global.CCSRoutingService = {
    getRoute: getRoute,
    localDistance: localDistance,
    open2gisRoute: open2gisRoute,
    openYandexRoute: openYandexRoute,
    service: SERVICE,
    isFreeMode: true
  };
})(window);
