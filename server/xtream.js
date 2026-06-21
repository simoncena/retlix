// Minimal Xtream Codes API client (Node 18+ native fetch).
// Reference for endpoints/behavior taken from the legacy IPTV-Manager sync service.

const UA = 'VLC/3.0.20 LibVLC/3.0.20';

function normalizeBase(url) {
  let base = (url || '').trim();
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  return base.replace(/\/+$/, '');
}

async function getJson(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      if (ct.includes('json')) throw new Error('Invalid JSON from provider');
      return null;
    }
  } finally {
    clearTimeout(t);
  }
}

export function createClient({ url, username, password }) {
  const base = normalizeBase(url);
  const user = (username || '').trim();
  const pass = (password || '').trim();
  const auth = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  const api = (action, params = {}) => {
    const extra = Object.entries(params)
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join('');
    return getJson(`${base}/player_api.php?${auth}&action=${action}${extra}`);
  };

  return {
    base,
    username: user,
    password: pass,
    info: () => getJson(`${base}/player_api.php?${auth}`),
    liveCategories: () => api('get_live_categories'),
    vodCategories: () => api('get_vod_categories'),
    seriesCategories: () => api('get_series_categories'),
    liveStreams: () => api('get_live_streams'),
    vodStreams: () => api('get_vod_streams'),
    series: () => api('get_series'),
    vodInfo: (id) => api('get_vod_info', { vod_id: id }),
    seriesInfo: (id) => api('get_series_info', { series_id: id }),
    shortEpg: (id, limit = 12) => api('get_short_epg', { stream_id: id, limit }),
    // Stream URL builders
    liveUrl: (id, ext = 'ts') => `${base}/live/${user}/${pass}/${id}.${ext}`,
    movieUrl: (id, ext = 'mp4') => `${base}/movie/${user}/${pass}/${id}.${ext}`,
    seriesUrl: (id, ext = 'mp4') => `${base}/series/${user}/${pass}/${id}.${ext}`,
  };
}

export { UA, normalizeBase };
