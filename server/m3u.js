// M3U/M3U8 playlist parser.
// Parses #EXTINF lines and maps entries into the same categories/content
// schema used by the Xtream sync.

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
  // Channel name is everything after the last comma in the #EXTINF line
  const comma = line.lastIndexOf(',');
  attrs._name = comma >= 0 ? line.slice(comma + 1).trim() : '';
  return attrs;
}

// Heuristic: guess content type from group name or URL
function guessType(group, url) {
  const g = (group || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (/\b(vod|film|movie|cinema)\b/.test(g)) return 'movie';
  if (/\b(series?|tv\s*show|stagion|season|episod)\b/.test(g)) return 'series';
  if (/\.(mp4|mkv|avi|mov)(\?|$)/.test(u)) return 'movie';
  return 'live';
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
      const type = guessType(group, trimmed);
      entries.push({
        name: current['tvg-name'] || current._name || 'Untitled',
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

// Build categories + content arrays suitable for DB upsert
export function m3uToDb(entries) {
  const catMap = new Map(); // "type:group" -> category_id
  const categories = [];
  const content = [];
  let catCounter = 1;

  for (const e of entries) {
    const catKey = `${e.type}:${e.group}`;
    let catId;
    if (catMap.has(catKey)) {
      catId = catMap.get(catKey);
    } else {
      catId = String(catCounter++);
      catMap.set(catKey, catId);
      categories.push({ type: e.type, category_id: catId, name: e.group, sort_order: categories.length });
    }

    // Stable ID derived from URL so watch progress survives re-syncs
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

  return { categories, content };
}
