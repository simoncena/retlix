// Free IMDb metadata via imdbapi.dev (no API key required).
// Used to fill in wide backdrops / plot / year that the Xtream provider often
// lacks. Results are persisted on the content row by the caller, so each title
// is looked up at most once.

const BASE = 'https://api.imdbapi.dev';
const UA = 'Mozilla/5.0 (Retlix)';

async function getJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Strip quality / codec / language tags and pull out a release year so the
// title matches IMDb's clean name (e.g. "Inception (2010) FHD" -> "Inception").
export function cleanTitle(raw) {
  let t = ` ${raw || ''} `;
  const ym = t.match(/(19|20)\d{2}/);
  const year = ym ? ym[0] : '';
  t = t
    .replace(/\(?\b(19|20)\d{2}\b\)?/g, ' ')
    .replace(/\b(4k|uhd|fhd|hd|sd|2160p?|1080p?|720p?|480p?|x264|x265|hevc|h\.?264|h\.?265|web-?dl|webrip|bluray|brrip|hdr|hdrip|dts|aac|ac3|ddp?5\.?1|multi|dual|ita|eng|sub|subs|vost|vo)\b/gi, ' ')
    .replace(/[\[\]\(\)\{\}|]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–:]\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: t, year };
}

export async function findImdbId(name) {
  const { title, year } = cleanTitle(name);
  if (!title) return null;
  const data = await getJson(`${BASE}/search/titles?query=${encodeURIComponent(title)}&limit=5`);
  const list = data?.titles || [];
  if (!list.length) return null;
  let best = list[0];
  if (year) {
    const exact = list.find((x) => String(x.startYear) === year);
    if (exact) best = exact;
  }
  return best?.id || null;
}

// The widest landscape image — IMDb "still_frame"s are ~16:9 and make good backdrops.
export async function imdbBackdrop(id) {
  const data = await getJson(`${BASE}/titles/${id}/images?limit=40`);
  const imgs = (data?.images || []).filter((i) => i.width && i.height && i.width > i.height * 1.4);
  if (!imgs.length) return null;
  imgs.sort((a, b) => b.width - a.width);
  return imgs[0].url || null;
}

export async function imdbInfo(id) {
  return getJson(`${BASE}/titles/${id}`);
}

// Top cast with photos + character names (used for "Con [Attore]" suggestions).
export async function imdbCredits(id, limit = 12) {
  const data = await getJson(`${BASE}/titles/${id}/credits?limit=${limit}`);
  const out = [];
  for (const c of data?.credits || []) {
    if (c.category !== 'actor' && c.category !== 'actress') continue;
    out.push({
      name: c.name?.displayName || '',
      image: c.name?.primaryImage?.url || '',
      character: Array.isArray(c.characters) ? c.characters[0] || '' : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// One-shot helper: resolve a title to { backdrop, plot, year, genre, rating }.
// Any field may be null/'' if IMDb has nothing usable. (Light; used as a lazy
// fallback for hero/detail.)
export async function imdbEnrich(name) {
  const id = await findImdbId(name);
  if (!id) return null;
  const [backdrop, info] = await Promise.all([imdbBackdrop(id), imdbInfo(id)]);
  return {
    id,
    backdrop: backdrop || null,
    plot: info?.plot || '',
    year: info?.startYear ? String(info.startYear) : '',
    genre: Array.isArray(info?.genres) ? info.genres.join(', ') : '',
    rating: info?.rating?.aggregateRating || 0,
  };
}

// Full resolve for the deep sync: backdrop + plot + year + genre + director +
// top cast (with photos). Three calls in parallel after the id lookup.
export async function imdbDeep(name) {
  const id = await findImdbId(name);
  if (!id) return null;
  const [backdrop, info, cast] = await Promise.all([
    imdbBackdrop(id),
    imdbInfo(id),
    imdbCredits(id),
  ]);
  return {
    id,
    backdrop: backdrop || null,
    plot: info?.plot || '',
    year: info?.startYear ? String(info.startYear) : '',
    genre: Array.isArray(info?.genres) ? info.genres.join(', ') : '',
    rating: info?.rating?.aggregateRating || 0,
    director: Array.isArray(info?.directors) ? info.directors.map((d) => d.displayName).filter(Boolean).join(', ') : '',
    cast,
  };
}
