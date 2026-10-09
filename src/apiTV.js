// Fully standalone Xtream Codes API for Samsung TV.
// No server needed — fetches everything directly from the provider.
// Stores progress in localStorage. Caches stream lists in memory.

import { isConfigured, getProvider, saveProvider as xtreamSave, clearProvider as xtreamClear, xtreamApi, liveUrl, movieUrl, seriesUrl } from './xtreamTV.js';

// ---- Cache: memory + localStorage persistence ----
var _cache = { live: null, movie: null, series: null, liveCats: null, vodCats: null, seriesCats: null }; _adultCatIds = null;

// Compact storage: save as arrays [id, name, catId, rating, added, ext, icon] to fit in 5MB localStorage
function saveToStorage(key, items) {
  try {
    if (key === 'liveCats' || key === 'vodCats' || key === 'seriesCats') {
      localStorage.setItem('retflix-lib-' + key, JSON.stringify(items));
      return;
    }
    // Compact: array of arrays
    var compact = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      compact.push([it.id, it.name || '', it.category_id || '', it.rating || 0, it.added || 0, it.container_extension || '', it.icon || '']);
    }
    localStorage.setItem('retflix-lib-' + key, JSON.stringify(compact));
  } catch(e) {
    // localStorage full — try without icons (saves ~40%)
    try {
      var noIcon = [];
      for (var j = 0; j < items.length; j++) {
        var it2 = items[j];
        noIcon.push([it2.id, it2.name || '', it2.category_id || '', it2.rating || 0, it2.added || 0, it2.container_extension || '']);
      }
      localStorage.setItem('retflix-lib-' + key, JSON.stringify(noIcon));
    } catch(e2) {}
  }
}

function loadFromStorage(key, type) {
  try {
    var raw = localStorage.getItem('retflix-lib-' + key);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.length) return null;
    // Categories are stored as-is
    if (key === 'liveCats' || key === 'vodCats' || key === 'seriesCats') return data;
    // Compact arrays → full objects
    var items = [];
    for (var i = 0; i < data.length; i++) {
      var a = data[i];
      items.push({
        id: a[0], type: type || 'movie', name: a[1] || '',
        icon: a[6] || '', backdrop: a[6] || '', rawIcon: a[6] || '', rawBackdrop: '',
        category_id: String(a[2] || ''), rating: a[3] || 0,
        added: a[4] || 0, container_extension: a[5] || 'mp4',
        epg_channel_id: '', plot: '', year: '', genre: '',
        cast: '', director: '', duration: '', trailer: '', castList: null,
        enriched: false, metadata: null
      });
    }
    return items;
  } catch(e) { return null; }
}

// Deferred loading: don't block startup with 4.6MB JSON parse
var _storageLoaded = false;
export function loadLibraryFromStorage() {
  if (_storageLoaded) return;
  _storageLoaded = true;
  _cache.live = loadFromStorage('live', 'live');
  _cache.movie = loadFromStorage('movie', 'movie');
  _cache.series = loadFromStorage('series', 'series');
  _cache.liveCats = loadFromStorage('liveCats');
  _cache.vodCats = loadFromStorage('vodCats');
  _cache.seriesCats = loadFromStorage('seriesCats');
}
export function isLibraryLoaded() {
  return !!(_cache.movie || _cache.series || _cache.live);
}

// Pre-built safe lists (no adult) + lowercase name index for instant search
var _safe = { movie: null, series: null, live: null };
var _nameIdx = { movie: null, series: null, live: null };

function buildIndex(type) {
  var items = _cache[type] || [];
  if (type === 'live') {
    _safe.live = items;
  } else {
    var safe = [];
    for (var i = 0; i < items.length; i++) {
      if (!isAdult(items[i])) safe.push(items[i]);
    }
    _safe[type] = safe;
  }
  var s = _safe[type];
  var idx = [];
  for (var j = 0; j < s.length; j++) idx[j] = (s[j].name || '').toLowerCase();
  _nameIdx[type] = idx;
}

function getSafe(type) {
  if (!_safe[type] && _cache[type]) buildIndex(type);
  return _safe[type] || [];
}
function getNameIdx(type) {
  if (!_nameIdx[type] && _cache[type]) buildIndex(type);
  return _nameIdx[type] || [];
}

function ensureCache(type) {
  if (_cache[type]) return Promise.resolve(_cache[type]);

  var fetcher, mapper;
  if (type === 'live') { fetcher = xtreamApi.liveStreams; mapper = mapLive; }
  else if (type === 'movie') { fetcher = xtreamApi.vodStreams; mapper = mapMovie; }
  else { fetcher = xtreamApi.series; mapper = mapSeries; }

  // Load categories first so adult filter works when building index
  return ensureCats(type).then(function() {
    return fetcher();
  }).then(function(streams) {
    _cache[type] = (streams || []).map(mapper);
    saveToStorage(type, _cache[type]);
    _adultCatIds = null; // force reload with fresh categories
    buildIndex(type);
    return _cache[type];
  });
}

function ensureCats(type) {
  if (type === 'live' && _cache.liveCats) return Promise.resolve(_cache.liveCats);
  if (type === 'movie' && _cache.vodCats) return Promise.resolve(_cache.vodCats);
  if (type === 'series' && _cache.seriesCats) return Promise.resolve(_cache.seriesCats);

  var fetcher = type === 'live' ? xtreamApi.liveCategories :
                type === 'movie' ? xtreamApi.vodCategories :
                xtreamApi.seriesCategories;
  return fetcher().then(function(cats) {
    var mapped = (cats || []).map(function(c) {
      return { category_id: String(c.category_id), name: c.category_name, count: 0 };
    });
    if (type === 'live') { _cache.liveCats = mapped; saveToStorage('liveCats', mapped); }
    else if (type === 'movie') { _cache.vodCats = mapped; saveToStorage('vodCats', mapped); }
    else { _cache.seriesCats = mapped; saveToStorage('seriesCats', mapped); }
    return mapped;
  });
}

// ---- Mappers: Xtream format → Retflix format ----
function mapLive(s) {
  return {
    id: s.stream_id, type: 'live', name: s.name || '',
    icon: s.stream_icon || '', backdrop: '', rawIcon: s.stream_icon || '', rawBackdrop: '',
    category_id: String(s.category_id || ''), rating: 0,
    added: s.added ? Number(s.added) : 0, container_extension: 'ts',
    epg_channel_id: s.epg_channel_id || '', plot: '', year: '', genre: '',
    cast: '', director: '', duration: '', trailer: '', castList: null,
    enriched: false, metadata: null
  };
}

function mapMovie(s) {
  return {
    id: s.stream_id, type: 'movie', name: s.name || '',
    icon: s.stream_icon || '', backdrop: s.stream_icon || '', rawIcon: s.stream_icon || '', rawBackdrop: '',
    category_id: String(s.category_id || ''), rating: parseFloat(s.rating) || 0,
    added: s.added ? Number(s.added) : 0, container_extension: s.container_extension || 'mp4',
    epg_channel_id: '', plot: '', year: '', genre: '',
    cast: '', director: '', duration: '', trailer: '', castList: null,
    enriched: false, metadata: null
  };
}

function mapSeries(s) {
  return {
    id: s.series_id, type: 'series', name: s.name || '',
    icon: s.cover || '', backdrop: s.cover || '', rawIcon: s.cover || '', rawBackdrop: '',
    category_id: String(s.category_id || ''), rating: parseFloat(s.rating) || 0,
    added: s.last_modified ? Number(s.last_modified) : 0, container_extension: 'mp4',
    epg_channel_id: '', plot: s.plot || '', year: s.year || '', genre: s.genre || '',
    cast: s.cast || '', director: s.director || '', duration: '', trailer: '', castList: null,
    enriched: false, metadata: null
  };
}

// ---- Favorites (localStorage) ----
function getFavoritesData() {
  try { return JSON.parse(localStorage.getItem('retflix-favorites') || '[]'); } catch(e) { return []; }
}
function saveFavoritesData(arr) {
  try { localStorage.setItem('retflix-favorites', JSON.stringify(arr)); } catch(e) {}
}

// ---- Progress (localStorage) ----
function getProgressData() {
  try { return JSON.parse(localStorage.getItem('retflix-progress') || '[]'); } catch(e) { return []; }
}
function saveProgressData(arr) {
  try { localStorage.setItem('retflix-progress', JSON.stringify(arr)); } catch(e) {}
}

// ---- Adult content filter ----
var ADULT_PATTERNS = /xxx|porn|adult|18\+|erotic|erotico|porno|hentai|sex|for\s*adults|per\s*adulti|mature|milf|lesbian|gay|fetish|bdsm|strip|nude|nud[io]|hard\s*core|hardcore|kamasutra|playboy|brazzers|bang\s*bros|naughty|x\s*rated|xrated/i;
var _adultCatIds = null;

function loadAdultCatIds() {
  if (_adultCatIds) return _adultCatIds;
  _adultCatIds = {};
  var allCats = (_cache.vodCats || []).concat(_cache.seriesCats || []).concat(_cache.liveCats || []);
  for (var i = 0; i < allCats.length; i++) {
    if (ADULT_PATTERNS.test(allCats[i].name)) {
      _adultCatIds[String(allCats[i].category_id)] = true;
    }
  }
  return _adultCatIds;
}

function isAdult(item) {
  // Check category first
  var ids = loadAdultCatIds();
  if (ids[String(item.category_id)]) return true;
  // Check item name
  if (item.name && ADULT_PATTERNS.test(item.name)) return true;
  return false;
}

// ---- Sorting ----
function sortItems(items, sort) {
  var sorted = items.slice();
  if (sort === 'name') sorted.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
  else if (sort === 'rating') sorted.sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
  else sorted.sort(function(a, b) { return (b.added || 0) - (a.added || 0); }); // 'added' default
  return sorted;
}

// ---- The API object (same interface as api.js) ----
export var apiTV = {
  getProvider: function() {
    if (!isConfigured()) return Promise.resolve({ configured: false, provider: null, stats: { movie: 0, series: 0, live: 0 } });
    // Don't call the provider API on startup — just return local config
    var p = getProvider();
    return Promise.resolve({
      configured: true,
      provider: { url: p.url, username: p.username, last_sync: null, type: 'xtream', m3u_url: '', user_info: null, server_info: null },
      stats: { movie: 1, series: 1, live: 1 }
    });
  },

  saveProvider: function(body) {
    if (body && body.type === 'xtream' && body.url && body.username && body.password) {
      xtreamSave(body.url, body.username, body.password);
      _cache = { live: null, movie: null, series: null, liveCats: null, vodCats: null, seriesCats: null }; _adultCatIds = null;
    }
    return Promise.resolve({ ok: true, provider: { url: body.url, username: body.username } });
  },
  deleteProvider: function() {
    xtreamClear();
    _cache = { live: null, movie: null, series: null, liveCats: null, vodCats: null, seriesCats: null }; _adultCatIds = null;
    return Promise.resolve({ ok: true });
  },

  home: function() {
    // Fast Home: use pre-built safe lists (no filterSafe iteration).
    var movies = getSafe('movie');
    var series = getSafe('series');
    var live = getSafe('live');

    // Hero: only if we have cached movies
    var hero = null;
    if (movies.length > 0) {
      var moviesWithImg = movies.filter(function(m) { return m.icon; });
      hero = moviesWithImg.length > 0 ? moviesWithImg[Math.floor(Math.random() * moviesWithImg.length)] : movies[0];
    }

    // Build rows only from cached data
    var rows = [];
    if (movies.length > 0) {
      var recent = movies.slice().sort(function(a, b) { return (b.added || 0) - (a.added || 0); });
      rows.push({ title: 'Film aggiunti di recente', items: recent.slice(0, 20), type: 'movie' });
      var topRated = movies.slice().sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
      rows.push({ title: 'Film più votati', items: topRated.slice(0, 20), type: 'movie' });
    }
    if (series.length > 0) rows.push({ title: 'Serie TV', items: series.slice(0, 20), type: 'series' });
    if (live.length > 0) rows.push({ title: 'Live TV', items: live.slice(0, 20), type: 'live' });

    return Promise.resolve(true).then(function() {

      // Continue watching
      var progress = getProgressData();
      var continueItems = [];
      var seenIds = {};
      for (var i = 0; i < progress.length; i++) {
        var p = progress[i];
        if (p.position > 10 && p.duration > 0 && p.position < p.duration - 30) {
          var found = null;
          // For series episodes, p.parent is the series ID; match on that
          var matchId = p.parent || p.id;
          var matchType = p.parent ? 'series' : p.type;
          if (seenIds[matchType + ':' + matchId]) continue;
          var all = movies.concat(series);
          for (var j = 0; j < all.length; j++) {
            if (String(all[j].id) === String(matchId) && all[j].type === matchType) { found = all[j]; break; }
          }
          if (found) {
            seenIds[matchType + ':' + matchId] = true;
            var item = Object.assign({}, found);
            item.progress = { position: p.position, duration: p.duration };
            if (p.season && p.ep_index != null) item.resume = { season: p.season, ei: p.ep_index };
            continueItems.push(item);
          }
        }
      }

      return { hero: hero, rows: rows, continue: continueItems, recommended: [] };
    });
  },

  categories: function(type) {
    return ensureCats(type).then(function(cats) {
      // Count items per category
      return ensureCache(type).then(function(items) {
        var counts = {};
        for (var i = 0; i < items.length; i++) {
          var cid = String(items[i].category_id);
          counts[cid] = (counts[cid] || 0) + 1;
        }
        return cats.map(function(c) { return { category_id: c.category_id, name: c.name, count: counts[c.category_id] || 0 }; })
          .filter(function(c) { return c.count > 0; });
      });
    });
  },

  content: function(opts) {
    var type = opts.type;
    var category = opts.category || '';
    var sort = opts.sort || 'added';
    var limit = opts.limit || 60;
    var offset = opts.offset || 0;
    return ensureCache(type).then(function(items) {
      var filtered = items;
      if (category) {
        filtered = items.filter(function(it) { return String(it.category_id) === String(category); });
      }
      var sorted = sortItems(filtered, sort);
      return { items: sorted.slice(offset, offset + limit), total: sorted.length };
    });
  },

  detail: function(type, id) {
    if (type === 'movie') {
      return xtreamApi.vodInfo(id).then(function(data) {
        var info = (data && data.info) || {};
        var movieData = (data && data.movie_data) || {};
        return {
          id: id, type: 'movie', name: info.name || movieData.name || '',
          icon: info.movie_image || info.cover || '',
          backdrop: info.backdrop_path && info.backdrop_path.length > 0 ? info.backdrop_path[0] : (info.movie_image || ''),
          rating: parseFloat(info.rating) || parseFloat(info.rating_5based) || 0,
          plot: info.plot || info.description || '', year: info.releasedate || info.year || '',
          genre: info.genre || '', cast: info.cast || '', director: info.director || '',
          duration: info.duration || '', trailer: info.youtube_trailer || '',
          container_extension: movieData.container_extension || info.container_extension || 'mp4',
          castList: null, enriched: true, metadata: null, seasons: null
        };
      });
    }
    if (type === 'series') {
      return xtreamApi.seriesInfo(id).then(function(data) {
        var info = (data && data.info) || {};
        var episodes = (data && data.episodes) || {};
        var seasons = {};
        var seasonKeys = Object.keys(episodes);
        for (var i = 0; i < seasonKeys.length; i++) {
          var sk = seasonKeys[i];
          var eps = episodes[sk] || [];
          seasons[sk] = eps.map(function(ep) {
            return {
              id: ep.id, episode_num: ep.episode_num || ep.sort || '',
              title: ep.title || '', plot: ep.info ? ep.info.plot || '' : '',
              still: ep.info ? ep.info.movie_image || '' : '',
              container_extension: ep.container_extension || 'mp4'
            };
          });
        }
        return {
          id: id, type: 'series', name: info.name || '',
          icon: info.cover || '', backdrop: info.backdrop_path && info.backdrop_path.length > 0 ? info.backdrop_path[0] : (info.cover || ''),
          rating: parseFloat(info.rating) || parseFloat(info.rating_5based) || 0,
          plot: info.plot || info.description || '', year: info.releaseDate || info.year || '',
          genre: info.genre || '', cast: info.cast || '', director: info.director || '',
          duration: '', trailer: info.youtube_trailer || '',
          container_extension: 'mp4', castList: null, enriched: true, metadata: null,
          seasons: seasons
        };
      });
    }
    // live — just return cached item
    return ensureCache('live').then(function(items) {
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].id) === String(id)) return items[i];
      }
      return { id: id, type: 'live', name: 'Live' };
    });
  },

  epg: function() { return Promise.resolve([]); },

  suggest: function(q) {
    if (!q || q.length < 3) return Promise.resolve([]);
    var lq = q.toLowerCase();
    var matches = [];
    // Search movies then series using pre-built index
    var types = ['movie', 'series'];
    for (var t = 0; t < types.length && matches.length < 8; t++) {
      var safe = getSafe(types[t]);
      var idx = getNameIdx(types[t]);
      for (var i = 0; i < idx.length && matches.length < 8; i++) {
        if (idx[i].indexOf(lq) >= 0) {
          matches.push({ name: safe[i].name, type: safe[i].type, id: safe[i].id, icon: safe[i].icon });
        }
      }
    }
    return Promise.resolve(matches);
  },

  search: function(opts) {
    var q = (opts.q || '').toLowerCase();
    var actor = (opts.actor || '').toLowerCase();
    if ((!q || q.length < 2) && !actor) return Promise.resolve({ movies: [], series: [], live: [] });
    var max = 50;
    // Fast search using pre-built name index (no toLowerCase per item)
    function searchType(type) {
      var safe = getSafe(type);
      var idx = getNameIdx(type);
      var results = [];
      for (var i = 0; i < safe.length && results.length < max; i++) {
        if (q && idx[i].indexOf(q) >= 0) results.push(safe[i]);
        else if (actor && safe[i].cast && safe[i].cast.toLowerCase().indexOf(actor) >= 0) results.push(safe[i]);
      }
      return results;
    }
    return Promise.resolve({
      movies: searchType('movie'),
      series: searchType('series'),
      live: searchType('live')
    });
  },

  getProgress: function() {
    return Promise.resolve(getProgressData().map(function(p) {
      return { key: p.type + ':' + p.id, type: p.type, id: p.id, position: p.position, duration: p.duration };
    }));
  },

  saveProgress: function(body) {
    var arr = getProgressData();
    var key = body.type + ':' + body.id;
    var found = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].type === body.type && String(arr[i].id) === String(body.id)) {
        arr[i] = body;
        found = true;
        break;
      }
    }
    if (!found) arr.push(body);
    // Keep only last 50
    if (arr.length > 50) arr = arr.slice(arr.length - 50);
    saveProgressData(arr);
    return Promise.resolve({ ok: true });
  },

  clearProgress: function(type, id) {
    var arr = getProgressData().filter(function(p) { return !(p.type === type && String(p.id) === String(id)); });
    saveProgressData(arr);
    return Promise.resolve({ ok: true });
  },

  clearAllProgress: function() {
    saveProgressData([]);
    return Promise.resolve({ ok: true });
  },

  removeContinue: function(type, id) {
    return apiTV.clearProgress(type, id);
  },

  getSettings: function() { return Promise.resolve({ tmdbEnabled: false }); },
  saveSettings: function() { return Promise.resolve({ tmdbEnabled: false }); },

  getFavorites: function() { return Promise.resolve(getFavoritesData()); },
  addFavorite: function(type, id, name, icon) {
    var arr = getFavoritesData();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].type === type && String(arr[i].id) === String(id)) return Promise.resolve(arr);
    }
    arr.push({ type: type, id: String(id), name: name || '', icon: icon || '' });
    saveFavoritesData(arr);
    return Promise.resolve(arr);
  },
  removeFavorite: function(type, id) {
    var arr = getFavoritesData().filter(function(f) { return !(f.type === type && String(f.id) === String(id)); });
    saveFavoritesData(arr);
    return Promise.resolve(arr);
  },
  isFavorite: function(type, id) {
    var arr = getFavoritesData();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].type === type && String(arr[i].id) === String(id)) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  },
};

// Stream URL builders — direct from provider
export function streamUrlTV(type, id, ext) {
  if (type === 'live') return liveUrl(id);
  if (type === 'movie') return movieUrl(id, ext);
  if (type === 'series') return seriesUrl(id, ext);
  return '';
}

export function clearCache() {
  _cache = { live: null, movie: null, series: null, liveCats: null, vodCats: null, seriesCats: null }; _adultCatIds = null;
  _safe = { movie: null, series: null, live: null }; _nameIdx = { movie: null, series: null, live: null };
  try {
    localStorage.removeItem('retflix-lib-live');
    localStorage.removeItem('retflix-lib-movie');
    localStorage.removeItem('retflix-lib-series');
    localStorage.removeItem('retflix-lib-liveCats');
    localStorage.removeItem('retflix-lib-vodCats');
    localStorage.removeItem('retflix-lib-seriesCats');
  } catch(e) {}
}
