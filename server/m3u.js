// M3U/M3U8 playlist parser.
// Parses #EXTINF lines and maps entries into the same categories/content
// schema used by the Xtream sync. Handles both generic M3U playlists and
// Xtream-generated M3U exports (which embed /live/, /movie/, /series/ in URLs).

import crypto from 'crypto';
import { UA } from './xtream.js';

export async function fetchM3U(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Channel Name
const ATTR_RE = /([a-z_-]+)="([^"]*)"/gi;

function parseAttrs(line) {
  const attrs = {};
  let m;
  while ((m = ATTR_RE.exec(line))) attrs[m[1].toLowerCase()] = m[2];
  ATTR_RE.lastIndex = 0;
  const comma = line.lastIndexOf(',');
  attrs._name = comma >= 0 ? line.slice(comma + 1).trim() : '';
  return attrs;
}

// Heuristic: guess content type from URL path, group name, and title.
// Priority: URL path (most reliable for Xtream exports) > group name > file extension.
function guessType(group, url, name) {
  const u = (url || '').toLowerCase();
  const g = (group || '').toLowerCase();
  const n = (name || '').toLowerCase();

  // Xtream-generated M3U exports embed the type in the URL path
  if (/\/movie\//.test(u)) return 'movie';
  if (/\/series\//.test(u)) return 'series';
  if (/\/live\//.test(u)) return 'live';

  // Group name keywords (multilingual)
  if (/\b(vod|film[ie]?|movie|cinema|pelicula|кино)\b/.test(g)) return 'movie';
  if (/\b(ser[iy]e?s?|tv\s*shows?|stagion|temporada|saison|staffel|season|episod|сериал)\b/.test(g)) return 'series';
  if (/\b(live|diretta|en\s*vivo|direct|canali?|channel|tv\s*live|прямой)\b/.test(g)) return 'live';

  // Title patterns: "S01 E03", "S01E03", "1x03", "Stagione 1", "Season 2"
  if (/\b(?:s\d{1,2}\s*e\d{1,2}|\d{1,2}x\d{1,2}|stagione|season|saison|staffel)\b/i.test(n)) return 'series';

  // File extension in URL
  if (/\.(mp4|mkv|avi|mov)(\?|$)/.test(u)) return 'movie';
  if (/\.(m3u8?|ts)(\?|$)/.test(u)) return 'live';

  return 'live';
}

// Try to extract series name and season/episode from a title like:
// "Breaking Bad S01 E03", "The Office 2x05", "Narcos Stagione 3 Episodio 7"
const SERIES_RE = /^(.+?)\s*[–—-]?\s*(?:s(\d{1,2})\s*e(\d{1,3})|(\d{1,2})x(\d{1,3})|(?:stagione|season|saison|staffel)\s*(\d{1,2})(?:\s*(?:episodio|episode|ep\.?|épisode|folge)\s*(\d{1,3}))?)/i;

function parseSeriesTitle(name) {
  const m = SERIES_RE.exec(name);
  if (!m) return null;
  const seriesName = m[1].trim().replace(/[\s._-]+$/, '');
  const season = m[2] || m[4] || m[6] || '1';
  const episode = m[3] || m[5] || m[7] || null;
  return { seriesName, season, episode };
}

export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      current = parseAttrs(trimmed);
    } else if (trimmed && !trimmed.startsWith('#') && current) {
      const group = current['group-title'] || 'Uncategorized';
      const name = current['tvg-name'] || current._name || 'Untitled';
      const type = guessType(group, trimmed, name);
      entries.push({
        name,
        url: trimmed,
        icon: current['tvg-logo'] || '',
        group,
        type,
        epg_channel_id: current['tvg-id'] || '',
      });
      current = null;
    }
  }
  return entries;
}

// Build categories + content arrays suitable for DB upsert.
// Series episodes are grouped: the parent series gets a content row,
// and individual episodes go into the episodes array.
export function m3uToDb(entries) {
  const catMap = new Map();
  const categories = [];
  const content = [];
  const episodes = [];
  let catCounter = 1;

  // First pass: group series episodes by series name
  const seriesMap = new Map(); // "group|seriesName" -> { entries[], icon, group }
  const nonSeriesEntries = [];

  for (const e of entries) {
    if (e.type === 'series') {
      const parsed = parseSeriesTitle(e.name);
      if (parsed) {
        const key = `${e.group}|${parsed.seriesName.toLowerCase()}`;
        if (!seriesMap.has(key)) {
          seriesMap.set(key, { seriesName: parsed.seriesName, icon: e.icon, group: e.group, eps: [] });
        }
        const s = seriesMap.get(key);
        if (!s.icon && e.icon) s.icon = e.icon;
        s.eps.push({ ...e, parsed });
      } else {
        // Can't parse season/episode — treat as standalone content
        nonSeriesEntries.push(e);
      }
    } else {
      nonSeriesEntries.push(e);
    }
  }

  function ensureCat(type, group) {
    const catKey = `${type}:${group}`;
    if (catMap.has(catKey)) return catMap.get(catKey);
    const catId = String(catCounter++);
    catMap.set(catKey, catId);
    categories.push({ type, category_id: catId, name: group, sort_order: categories.length });
    return catId;
  }

  // Non-series entries (live + movies + unparseable series)
  for (const e of nonSeriesEntries) {
    const catId = ensureCat(e.type, e.group);
    const streamId = crypto.createHash('sha1').update(e.url).digest('hex').slice(0, 12);
    content.push({
      type: e.type,
      stream_id: streamId,
      name: e.name,
      icon: e.icon,
      backdrop: '',
      category_id: catId,
      rating: 0,
      added: Math.floor(Date.now() / 1000),
      container_extension: e.type === 'live' ? '' : (e.url.match(/\.(\w{2,4})(?:\?|$)/)?.[1] || 'mp4'),
      epg_channel_id: e.epg_channel_id,
      plot: '',
      year: '',
      genre: '',
      tmdb: '',
      metadata: JSON.stringify({ m3u_url: e.url }),
    });
  }

  // Grouped series: one content row per series, episodes in the episodes array
  for (const [, s] of seriesMap) {
    const catId = ensureCat('series', s.group);
    // Stable series ID from the series name within its group
    const seriesId = crypto.createHash('sha1').update(`series:${s.group}:${s.seriesName.toLowerCase()}`).digest('hex').slice(0, 12);

    content.push({
      type: 'series',
      stream_id: seriesId,
      name: s.seriesName,
      icon: s.icon,
      backdrop: '',
      category_id: catId,
      rating: 0,
      added: Math.floor(Date.now() / 1000),
      container_extension: '',
      epg_channel_id: '',
      plot: '',
      year: '',
      genre: '',
      tmdb: '',
      metadata: JSON.stringify({ m3u_series: true }),
    });

    // Sort episodes by season then episode number
    s.eps.sort((a, b) => {
      const sa = parseInt(a.parsed.season) || 0;
      const sb = parseInt(b.parsed.season) || 0;
      if (sa !== sb) return sa - sb;
      const ea = parseInt(a.parsed.episode) || 0;
      const eb = parseInt(b.parsed.episode) || 0;
      return ea - eb;
    });

    for (let i = 0; i < s.eps.length; i++) {
      const ep = s.eps[i];
      const epId = crypto.createHash('sha1').update(ep.url).digest('hex').slice(0, 12);
      const epNum = parseInt(ep.parsed.episode) || (i + 1);
      episodes.push({
        series_id: seriesId,
        season: String(parseInt(ep.parsed.season) || 1),
        ep_index: i,
        ep_id: epId,
        episode_num: epNum,
        title: ep.name,
        plot: '',
        duration: '',
        still: '',
        container_extension: ep.url.match(/\.(\w{2,4})(?:\?|$)/)?.[1] || 'mp4',
        m3u_url: ep.url,
      });
    }
  }

  return { categories, content, episodes };
}
