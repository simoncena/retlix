// TMDB metadata in the user's language (plot + genres). Free API key required,
// stored in the `settings` table (or TMDB_API_KEY env). The provider/IMDb give
// content in one language only; TMDB has per-language overview/genres.
import db from './db.js';
import { cleanTitle } from './imdb.js';

const BASE = 'https://api.themoviedb.org/3';
const UA = 'Mozilla/5.0 (Retlix)';

const getKey = db.prepare("SELECT value FROM settings WHERE key='tmdb_key'");
export function tmdbKey() {
  try { const r = getKey.get(); if (r?.value) return r.value.trim(); } catch {}
  return (process.env.TMDB_API_KEY || '').trim();
}
export const tmdbEnabled = () => !!tmdbKey();

async function getJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// TMDB wants 'movie' | 'tv'. Two-letter language codes are accepted.
const ttype = (type) => (type === 'series' ? 'tv' : 'movie');

// Resolve a TMDB id for a title (prefer a provider-supplied tmdb id, else search).
async function resolveId(type, name, year, providerTmdb, key) {
  if (providerTmdb && /^\d+$/.test(String(providerTmdb))) return String(providerTmdb);
  const { title, year: y } = cleanTitle(name);
  const yr = year || y;
  if (!title) return null;
  const q = encodeURIComponent(title);
  const ykey = type === 'series' ? 'first_air_date_year' : 'year';
  const url = `${BASE}/search/${ttype(type)}?api_key=${key}&query=${q}${yr ? `&${ykey}=${yr}` : ''}&include_adult=true`;
  const data = await getJson(url);
  const list = data?.results || [];
  if (!list.length) return null;
  if (yr) {
    const exact = list.find((x) => String(x.release_date || x.first_air_date || '').slice(0, 4) === String(yr));
    if (exact) return String(exact.id);
  }
  return String(list[0].id);
}

// Localized { plot, genre } for a title, or null. Cached in tmdb_i18n.
const selCache = db.prepare('SELECT plot, genre FROM tmdb_i18n WHERE type=? AND stream_id=? AND lang=?');
const upCache = db.prepare(`
  INSERT INTO tmdb_i18n (type, stream_id, lang, plot, genre, updated_at)
  VALUES (@type, @stream_id, @lang, @plot, @genre, @updated_at)
  ON CONFLICT(type, stream_id, lang) DO UPDATE SET plot=excluded.plot, genre=excluded.genre, updated_at=excluded.updated_at
`);

export async function localized(type, streamId, name, year, providerTmdb, lang) {
  const key = tmdbKey();
  if (!key || !lang) return null;
  try {
    const cached = selCache.get(type, String(streamId), lang);
    if (cached) return { plot: cached.plot || '', genre: cached.genre || '' };
  } catch {}

  const id = await resolveId(type, name, year, providerTmdb, key);
  if (!id) return null;
  const data = await getJson(`${BASE}/${ttype(type)}/${id}?api_key=${key}&language=${lang}`);
  if (!data) return null;
  const plot = data.overview || '';
  const genre = Array.isArray(data.genres) ? data.genres.map((g) => g.name).filter(Boolean).join(', ') : '';
  if (!plot && !genre) return null;

  try {
    upCache.run({ type, stream_id: String(streamId), lang, plot, genre, updated_at: Math.floor(Date.now() / 1000) });
  } catch {}
  return { plot, genre };
}
