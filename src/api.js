// Current UI language (set by the i18n layer) → sent to the server so it can
// return localized plot/genre via TMDB.
function lang() {
  try { return localStorage.getItem('retlix-lang') || 'it'; } catch { return 'it'; }
}

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const e = await r.json(); if (e.error) msg = e.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  getProvider: () => j('/api/provider'),
  saveProvider: (body) =>
    j('/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteProvider: () => j('/api/provider', { method: 'DELETE' }),

  home: () => j(`/api/home?lang=${lang()}`),
  categories: (type) => j(`/api/categories?type=${type}`),
  content: ({ type, category = '', search = '', sort = 'added', limit = 60, offset = 0 }) =>
    j(`/api/content?type=${type}&category=${encodeURIComponent(category)}&search=${encodeURIComponent(search)}&sort=${sort}&limit=${limit}&offset=${offset}`),
  detail: (type, id) => j(`/api/detail/${type}/${id}?lang=${lang()}`),
  epg: (id) => j(`/api/epg/${id}`),
  suggest: (q) => j(`/api/suggest?q=${encodeURIComponent(q)}`),
  search: ({ q = '', actor = '' }) =>
    j(`/api/search?${actor ? 'actor=' + encodeURIComponent(actor) : 'q=' + encodeURIComponent(q)}`),

  getProgress: () => j('/api/progress'),
  saveProgress: (body) =>
    j('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  clearProgress: (type, id) => j(`/api/progress/${type}/${id}`, { method: 'DELETE' }),
  clearAllProgress: () => j('/api/progress', { method: 'DELETE' }),
  removeContinue: (type, id) => j(`/api/continue/${type}/${id}`, { method: 'DELETE' }),

  getSettings: () => j('/api/settings'),
  saveSettings: (body) =>
    j('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

export function streamUrl(type, id, ext) {
  const q = ext ? `?ext=${encodeURIComponent(ext)}` : '';
  return `/api/stream/${type}/${id}${q}`;
}

// On-the-fly HLS transcode (for VOD containers the browser can't demux, e.g. MKV):
// makes them play and exposes multi-audio (language switching).
const hlsVodQ = (ext) => (ext ? `?ext=${encodeURIComponent(ext)}` : '');
export function hlsVodMaster(type, id, ext, ss = 0) {
  const q = hlsVodQ(ext);
  return `/api/hls/vod/${type}/${id}/master.m3u8${q}${ss > 0 ? (q ? '&' : '?') + 'ss=' + Math.floor(ss) : ''}`;
}
export function hlsVodFile(type, id, file, ext) { return `/api/hls/vod/${type}/${id}/${file}${hlsVodQ(ext)}`; }
export function hlsVodTracks(type, id, ext) { return fetch(`/api/hls/vod/${type}/${id}/tracks.json${hlsVodQ(ext)}`).then((r) => r.json()); }
export function stopHlsVod(type, id) { return fetch(`/api/hls/vod/${type}/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); }
