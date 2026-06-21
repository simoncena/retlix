import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';

import db from './db.js';
import { createClient, UA } from './xtream.js';
import { runSync } from './sync.js';
import { imdbEnrich, imdbDeep } from './imdb.js';
import { IMG_CACHE_DIR, cacheFile, sniffImageType } from './imgcache.js';
import { ensureSession, getSession, stopSession, waitForFile, probeInfo } from './transcode.js';
import { tmdbEnabled, tmdbKey, localized as tmdbLocalized } from './tmdb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

// ---------- helpers ----------
function getProvider() {
  return db.prepare('SELECT * FROM provider WHERE id = 1').get();
}
function getClient() {
  const p = getProvider();
  return p ? createClient(p) : null;
}
function publicProvider(p) {
  if (!p) return null;
  let user_info = null;
  let server_info = null;
  try { user_info = p.user_info ? JSON.parse(p.user_info) : null; } catch {}
  try { server_info = p.server_info ? JSON.parse(p.server_info) : null; } catch {}
  return {
    url: p.url,
    username: p.username,
    last_sync: p.last_sync,
    user_info,
    server_info,
  };
}
// IMDb/Amazon photos carry a size/crop transform (._V1_CR…_.jpg) that often
// 404s; strip it back to the always-present original (._V1_.jpg).
const cleanImg = (u) =>
  (u || '').replace(/(\.media-amazon\.com\/.*\._V1_).*?(\.[a-zA-Z]+)$/, '$1$2');
const img = (u) => (u ? '/api/image?url=' + encodeURIComponent(cleanImg(u)) : '');
function rowToItem(r) {
  let metadata = null;
  try { metadata = r.metadata ? JSON.parse(r.metadata) : null; } catch {}
  let castList = null;
  try { castList = r.cast_json ? JSON.parse(r.cast_json) : null; } catch {}
  // proxy actor photos through our image cache
  if (Array.isArray(castList)) castList = castList.map((c) => ({ ...c, image: img(c.image) }));
  return {
    id: r.stream_id,
    type: r.type,
    name: r.name,
    icon: img(r.icon),
    backdrop: img(r.backdrop),
    rawIcon: r.icon || '',
    rawBackdrop: r.backdrop || '',
    category_id: r.category_id,
    rating: r.rating,
    added: r.added,
    container_extension: r.container_extension,
    epg_channel_id: r.epg_channel_id,
    plot: r.plot,
    year: r.year,
    genre: r.genre,
    cast: r.cast_names || '',
    director: r.director || '',
    duration: r.duration || '',
    trailer: r.trailer || '',
    castList,
    enriched: !!r.enriched_at,
    metadata,
  };
}

// ---------- provider ----------
app.get('/api/provider', (req, res) => {
  const p = getProvider();
  const stats = {
    movie: db.prepare("SELECT COUNT(*) c FROM content WHERE type='movie'").get().c,
    series: db.prepare("SELECT COUNT(*) c FROM content WHERE type='series'").get().c,
    live: db.prepare("SELECT COUNT(*) c FROM content WHERE type='live'").get().c,
  };
  res.json({ configured: !!p, provider: publicProvider(p), stats });
});

app.post('/api/provider', async (req, res) => {
  const { url, username, password } = req.body || {};
  if (!url || !username || !password) {
    return res.status(400).json({ error: 'url, username and password are required' });
  }
  try {
    const client = createClient({ url, username, password });
    const info = await client.info();
    if (!info || !info.user_info || String(info.user_info.auth) === '0') {
      return res.status(401).json({ error: 'Authentication failed — check your credentials.' });
    }
    db.prepare(`
      INSERT INTO provider (id, url, username, password, server_info, user_info, last_sync)
      VALUES (1, @url, @username, @password, @server_info, @user_info, NULL)
      ON CONFLICT(id) DO UPDATE SET
        url=excluded.url, username=excluded.username, password=excluded.password,
        server_info=excluded.server_info, user_info=excluded.user_info
    `).run({
      url: client.base,
      username: client.username,
      password: client.password,
      server_info: JSON.stringify(info.server_info || {}),
      user_info: JSON.stringify(info.user_info || {}),
    });
    res.json({ ok: true, provider: publicProvider(getProvider()) });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach provider: ' + e.message });
  }
});

app.delete('/api/provider', (req, res) => {
  db.exec('DELETE FROM provider; DELETE FROM categories; DELETE FROM content; DELETE FROM progress;');
  // Drop the cached images too so disconnecting is a real fresh start.
  fs.rmSync(IMG_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
  res.json({ ok: true });
});

// ---------- sync (Server-Sent Events) ----------
// A deep sync over a big library is long-running, so it must survive the browser
// tab closing: it's decoupled from the HTTP connection (keeps running server-side
// once started) and guarded against concurrent runs. Because enrichment is
// incremental (enriched_at != 0 is skipped), re-launching simply resumes.
let syncRunning = false;
app.get('/api/sync', async (req, res) => {
  if (!getProvider()) return res.status(400).json({ error: 'No provider configured' });
  res.setHeader('Content-Type', 'text/event-stream');
  // 'no-transform' stops the compression middleware from buffering the stream;
  // X-Accel-Buffering disables buffering in proxies (nginx / Vite dev proxy).
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Once the client goes away we stop writing — but the sync itself keeps going.
  let clientGone = false;
  req.on('close', () => { clientGone = true; });
  const send = (data) => {
    if (clientGone) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); res.flush?.(); } catch {}
  };

  if (syncRunning) {
    send({ stage: 'error', message: 'Una sincronizzazione è già in corso.' });
    return res.end();
  }
  syncRunning = true;
  const deep = req.query.deep === '1';
  const details = req.query.details === '1';
  try {
    const counts = await runSync((p) => send(p), { deep, details, precache: deep });
    send({ stage: 'complete', percent: 100, counts });
  } catch (e) {
    console.error('[sync] failed:', e);
    send({ stage: 'error', message: e.message });
  } finally {
    syncRunning = false;
    try { res.end(); } catch {}
  }
});

// ---------- categories ----------
app.get('/api/categories', (req, res) => {
  const type = req.query.type || 'movie';
  const rows = db.prepare(`
    SELECT c.category_id, c.name, COUNT(ct.id) AS count
    FROM categories c
    LEFT JOIN content ct ON ct.type = c.type AND ct.category_id = c.category_id
    WHERE c.type = ?
    GROUP BY c.category_id
    HAVING count > 0
    ORDER BY c.sort_order, c.name
  `).all(type);
  res.json(rows);
});

// ---------- content listing ----------
app.get('/api/content', (req, res) => {
  const type = req.query.type || 'movie';
  const category = req.query.category || '';
  const search = (req.query.search || '').trim();
  const sort = req.query.sort === 'name' ? 'name COLLATE NOCASE ASC'
    : req.query.sort === 'rating' ? 'rating DESC, added DESC'
    : 'added DESC, id DESC';
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  const where = ['type = ?'];
  const params = [type];
  if (category) { where.push('category_id = ?'); params.push(category); }
  if (search) { where.push('name LIKE ?'); params.push('%' + search + '%'); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM content WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM content WHERE ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ total, items: rows.map(rowToItem) });
});

// ---------- search (instant suggestions + grouped results + actors) ----------
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Levenshtein distance (small strings) for typo-tolerant "did you mean".
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Titles whose name matches — prefix matches first.
function titleSuggestions(q, limit = 8) {
  return db.prepare(
    `SELECT type, stream_id, name, year, icon FROM content
     WHERE type IN ('movie','series','live') AND name LIKE ?
     ORDER BY (name LIKE ?) DESC, rating DESC, added DESC LIMIT ?`
  ).all('%' + q + '%', q + '%', limit)
    .map((r) => ({ type: r.type, id: r.stream_id, name: r.name, year: r.year, icon: img(r.icon) }));
}

// Actors whose name matches, with a photo and how many titles they're in.
// Breadth comes from provider cast_names; the photo comes from IMDb cast_json.
function actorSuggestions(q, limit = 8) {
  const ql = norm(q);
  const found = new Map(); // nameLc -> { name, image, seen }
  const add = (name, image) => {
    if (!name) return;
    const key = norm(name);
    if (!key.includes(ql)) return;
    let e = found.get(key);
    if (!e) { e = { name, image: '', seen: 0 }; found.set(key, e); }
    e.seen++;
    if (!e.image && image) e.image = image;
  };
  // IMDb cast — gives the photos
  for (const r of db.prepare("SELECT cast_json FROM content WHERE cast_json LIKE ? LIMIT 600").all('%' + q + '%')) {
    let arr; try { arr = JSON.parse(r.cast_json); } catch { continue; }
    for (const c of arr || []) add(c.name, c.image);
  }
  // provider cast — extra coverage (no photo)
  for (const r of db.prepare("SELECT cast_names FROM content WHERE cast_names LIKE ? AND cast_names != '' LIMIT 600").all('%' + q + '%')) {
    for (const raw of (r.cast_names || '').split(',')) add(raw.trim(), '');
  }
  const top = [...found.values()].sort((a, b) => b.seen - a.seen).slice(0, limit);
  return top.map((a) => ({
    name: a.name,
    image: img(a.image),
    count: db.prepare("SELECT COUNT(*) c FROM content WHERE cast_json LIKE ? OR cast_names LIKE ?")
      .get('%' + a.name + '%', '%' + a.name + '%').c,
  }));
}

function didYouMean(q) {
  const ql = norm(q);
  if (ql.length < 3) return null;
  // candidates share the first 2 letters; compare word-by-word so titles with
  // year/quality suffixes (e.g. "Avengers (2019) FHD") still match a typo.
  const cands = db.prepare(
    "SELECT name FROM content WHERE name LIKE ? ORDER BY rating DESC, added DESC LIMIT 1500"
  ).all(ql.slice(0, 2) + '%').map((r) => r.name);
  const maxD = Math.max(2, Math.floor(ql.length * 0.4));
  let bestWord = null, bestD = Infinity;
  for (const n of cands) {
    for (const ow of n.split(/[^\p{L}\p{N}]+/u)) {
      if (ow.length < 3) continue;
      const w = norm(ow);
      if (Math.abs(w.length - ql.length) > maxD) continue;
      const d = lev(ql, w);
      if (d > 0 && d < bestD) { bestD = d; bestWord = ow; }
    }
  }
  return bestD <= maxD ? bestWord : null;
}

// Lightweight as-you-type suggestions.
app.get('/api/suggest', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ titles: [], actors: [] });
  res.json({ titles: titleSuggestions(q), actors: actorSuggestions(q) });
});

// Full results page: grouped titles + actor matches, or all titles for one actor.
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const actor = (req.query.actor || '').trim();

  if (actor) {
    const items = db.prepare(
      "SELECT * FROM content WHERE cast_json LIKE ? OR cast_names LIKE ? ORDER BY rating DESC, added DESC LIMIT 80"
    ).all('%' + actor + '%', '%' + actor + '%').map(rowToItem);
    return res.json({
      actor,
      movies: items.filter((i) => i.type === 'movie'),
      series: items.filter((i) => i.type === 'series'),
      live: [], actors: [],
    });
  }

  if (!q) return res.json({ query: '', movies: [], series: [], live: [], actors: [] });
  const term = '%' + q + '%';
  const grab = (type, limit) => db.prepare(
    `SELECT * FROM content WHERE type=? AND name LIKE ? ORDER BY (name LIKE ?) DESC, rating DESC, added DESC LIMIT ?`
  ).all(type, term, q + '%', limit).map(rowToItem);
  const movies = grab('movie', 40);
  const series = grab('series', 40);
  const live = grab('live', 24);
  const actors = actorSuggestions(q, 10);
  const empty = !movies.length && !series.length && !live.length && !actors.length;
  res.json({ query: q, movies, series, live, actors, didYouMean: empty ? didYouMean(q) : null });
});

// Give the hero a real wide background + description. Tries the provider first
// (get_vod_info / get_series_info), then falls back to IMDb (imdbapi.dev) for a
// backdrop the provider doesn't have. Anything found is persisted on the content
// row, so a title is only looked up once.
async function enrichHero(item) {
  if (!item) return item;
  const client = getClient();
  let rawBd = item.rawBackdrop || '';

  // 1) provider details
  try {
    if (client && item.type === 'movie') {
      const info = await client.vodInfo(item.id).catch(() => null);
      if (info && info.info) {
        item.plot = info.info.plot || info.info.description || item.plot || '';
        item.genre = info.info.genre || item.genre || '';
        item.year = (info.info.releasedate || info.info.releaseDate || item.year || '').toString().slice(0, 4);
        const bd = info.info.backdrop_path;
        const u = Array.isArray(bd) ? bd[0] : bd;
        if (u) rawBd = u;
      }
    } else if (client && item.type === 'series') {
      const info = await client.seriesInfo(item.id).catch(() => null);
      if (info && info.info) {
        item.plot = info.info.plot || item.plot || '';
        item.genre = info.info.genre || item.genre || '';
        const bd = info.info.backdrop_path;
        const u = Array.isArray(bd) ? bd[0] : bd;
        if (u && !rawBd) rawBd = u;
      }
    }
  } catch {}

  // 2) IMDb fallback when the provider gave no backdrop (or no plot)
  if (!rawBd || !item.plot) {
    try {
      const im = await imdbEnrich(item.name);
      if (im) {
        if (!rawBd && im.backdrop) rawBd = im.backdrop;
        if (!item.plot) item.plot = im.plot || '';
        if (!item.year) item.year = im.year || '';
        if (!item.genre) item.genre = im.genre || '';
      }
    } catch {}
  }

  // 3) persist + expose proxied (cached) backdrop
  if (rawBd && rawBd !== item.rawBackdrop) {
    try {
      db.prepare('UPDATE content SET backdrop=?, plot=?, year=?, genre=? WHERE type=? AND stream_id=?')
        .run(rawBd, item.plot || '', item.year || '', item.genre || '', item.type, item.id);
    } catch {}
  }
  item.rawBackdrop = rawBd;
  if (rawBd) item.backdrop = '/api/image?url=' + encodeURIComponent(rawBd);
  return item;
}

// ---------- home (curated rows + hero) ----------
app.get('/api/home', async (req, res) => {
  const rows = [];

  const pick = (sql, params = []) => db.prepare(sql).all(...params).map(rowToItem);

  const recentMovies = pick(
    "SELECT * FROM content WHERE type='movie' ORDER BY added DESC, id DESC LIMIT 24"
  );
  const recentSeries = pick(
    "SELECT * FROM content WHERE type='series' ORDER BY added DESC, id DESC LIMIT 24"
  );
  const topRated = pick(
    "SELECT * FROM content WHERE type='movie' AND rating > 0 ORDER BY rating DESC, added DESC LIMIT 24"
  );

  // titleKey/titleParams let the client localize row titles (title = IT fallback).
  if (recentMovies.length) rows.push({ title: 'Nuovi film', titleKey: 'Nuovi film', type: 'movie', items: recentMovies });
  if (recentSeries.length) rows.push({ title: 'Nuove serie', titleKey: 'Nuove serie', type: 'series', items: recentSeries });
  if (topRated.length) rows.push({ title: 'Più votati', titleKey: 'Più votati', type: 'movie', items: topRated });

  // Category rows (movies then series), biggest categories first
  const catRows = db.prepare(`
    SELECT c.type, c.category_id, c.name, COUNT(ct.id) AS count
    FROM categories c
    JOIN content ct ON ct.type = c.type AND ct.category_id = c.category_id
    WHERE c.type IN ('movie','series')
    GROUP BY c.type, c.category_id
    HAVING count >= 4
    ORDER BY count DESC
    LIMIT 14
  `).all();
  for (const cr of catRows) {
    const items = pick(
      'SELECT * FROM content WHERE type=? AND category_id=? ORDER BY added DESC LIMIT 24',
      [cr.type, cr.category_id]
    );
    if (items.length) rows.push({ title: cr.name, type: cr.type, category: cr.category_id, items });
  }

  // ---- watch history (drives the hero, "Continue Watching" + recommendations) ----
  const history = db.prepare('SELECT * FROM progress ORDER BY updated_at DESC LIMIT 40').all();
  const watchedKeys = new Set(history.map((p) => p.key));
  const getContent = db.prepare('SELECT * FROM content WHERE type=? AND stream_id=?');
  // map a progress row to its content row (series episodes resolve via parent_id)
  const contentOf = (p) =>
    p.type === 'series' ? (p.parent_id ? getContent.get('series', p.parent_id) : null)
      : getContent.get(p.type, p.stream_id);

  // Continue Watching: resolved from the DB, so it works for ANY title you've
  // started (a movie found via search) and for series (an episode maps back to
  // its series via parent_id, deduped so a series shows once with resume info).
  const continueItems = [];
  const seenCont = new Set();
  for (const p of history) {
    if (!(p.duration > 0) || p.position / p.duration >= 0.95) continue; // finished / unknown length
    if (p.type === 'movie') {
      if (seenCont.has('movie:' + p.stream_id)) continue;
      seenCont.add('movie:' + p.stream_id);
      const row = getContent.get('movie', p.stream_id);
      if (row) continueItems.push(rowToItem(row));
    } else if (p.type === 'series' && p.parent_id) {
      if (seenCont.has('series:' + p.parent_id)) continue; // most-recent episode wins
      seenCont.add('series:' + p.parent_id);
      const row = getContent.get('series', p.parent_id);
      if (row) {
        const it = rowToItem(row);
        it.resume = { season: p.season, ei: p.ep_index };          // where to jump back in
        it.progress = { position: p.position, duration: p.duration }; // for the card's bar
        continueItems.push(it);
      }
    }
  }

  // Recommendation rows built from your history: same category, shared genre,
  // shared lead actor, and same director. Uses the locally-enriched fields, so
  // it gets richer as the deep sync fills the DB.
  const recommended = [];
  const usedTitles = new Set();   // avoid two rows for the same watched title
  const notWatched = (r) => !watchedKeys.has(`${r.type}:${r.stream_id}`);
  const toItems = (rows) => rows.filter(notWatched).map(rowToItem);
  const pushRow = (title, type, rows, titleKey, titleParams) => {
    const items = toItems(rows);
    if (items.length >= 4) recommended.push({ title, titleKey, titleParams, type, items });
  };

  for (const p of history) {
    if (recommended.length >= 6) break;
    if (p.type !== 'movie' && p.type !== 'series') continue;
    const w = contentOf(p);
    if (!w || usedTitles.has(w.name)) continue;
    usedTitles.add(w.name);

    // by category (always available)
    if (w.category_id && recommended.length < 6) {
      pushRow(`Perché hai guardato ${w.name}`, w.type, db.prepare(
        `SELECT * FROM content WHERE type=? AND category_id=? AND stream_id!=? ORDER BY rating DESC, added DESC LIMIT 24`
      ).all(w.type, w.category_id, w.stream_id), 'Perché hai guardato {name}', { name: w.name });
    }
    // by lead actor (enriched)
    const lead = (w.cast || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
    if (lead && recommended.length < 6) {
      pushRow(`Con ${lead}`, w.type, db.prepare(
        `SELECT * FROM content WHERE cast_names LIKE ? AND stream_id!=? ORDER BY rating DESC, added DESC LIMIT 24`
      ).all('%' + lead + '%', w.stream_id), 'Con {name}', { name: lead });
    }
    // by director (enriched)
    if (w.director && recommended.length < 6) {
      const dir = w.director.split(',')[0].trim();
      pushRow(`Diretto da ${dir}`, w.type, db.prepare(
        `SELECT * FROM content WHERE director LIKE ? AND stream_id!=? ORDER BY rating DESC, added DESC LIMIT 24`
      ).all('%' + dir + '%', w.stream_id), 'Diretto da {name}', { name: dir });
    }
  }

  // Hero: must have a WIDE backdrop (landscape) — never a portrait poster.
  // 1) a recommended title that already has a backdrop; else
  // 2) any DB title that has a backdrop (enriched movies + all series); else
  // 3) a top title (enrichHero will try to fetch a backdrop for it).
  const recPool = recommended.flatMap((r) => r.items);
  let heroItem = recPool.find((it) => it.rawBackdrop) || null;
  if (!heroItem) {
    const pool = db.prepare(
      "SELECT * FROM content WHERE type IN ('movie','series') AND backdrop != '' AND plot != '' ORDER BY rating DESC, added DESC LIMIT 50"
    ).all();
    if (pool.length) heroItem = rowToItem(pool[Math.floor(pool.length / 2)]);
  }
  if (!heroItem) {
    const any = db.prepare(
      "SELECT * FROM content WHERE type IN ('movie','series') ORDER BY rating DESC, added DESC LIMIT 30"
    ).all();
    heroItem = any.length ? rowToItem(any[Math.floor(any.length / 2)]) : null;
  }
  heroItem = await enrichHero(heroItem);

  // localize the hero's plot/genre to the requested language (TMDB), if enabled
  const lang = (req.query.lang || '').slice(0, 2).toLowerCase();
  if (heroItem && lang && lang !== 'it' && tmdbEnabled()) {
    try {
      const loc = await tmdbLocalized(heroItem.type, heroItem.id, heroItem.name, heroItem.year, heroItem.metadata?.tmdb, lang);
      if (loc) { if (loc.plot) heroItem.plot = loc.plot; if (loc.genre) heroItem.genre = loc.genre; }
    } catch {}
  }

  res.json({ hero: heroItem, continue: continueItems, recommended, rows });
});

// ---------- detail ----------
// Build season->episodes map from our local episodes table (deep-synced).
function localSeasons(seriesId) {
  const rows = db.prepare(
    'SELECT * FROM episodes WHERE series_id=? ORDER BY CAST(season AS INTEGER), ep_index'
  ).all(seriesId);
  const seasons = {};
  for (const e of rows) {
    (seasons[e.season] ||= []).push({
      id: e.ep_id,
      episode_num: e.episode_num,
      title: e.title || `Episodio ${e.episode_num}`,
      container_extension: e.container_extension || 'mp4',
      plot: e.plot || '',
      duration: e.duration || '',
      still: img(e.still),
    });
  }
  return seasons;
}

// Persist provider-fetched detail locally, so opening a title saves its data
// (and makes it findable by actor search) without waiting for the deep sync.
// We deliberately DON'T set enriched_at: the deep sync still owns full
// enrichment (IMDb cast/photos + the episodes table), so leaving it 0 lets the
// sync pick this title up later. Empty values never overwrite existing data.
const persistDetail = db.prepare(`
  UPDATE content SET
    plot       = CASE WHEN @plot       <> '' THEN @plot       ELSE plot       END,
    genre      = CASE WHEN @genre      <> '' THEN @genre      ELSE genre      END,
    year       = CASE WHEN @year       <> '' THEN @year       ELSE year       END,
    rating     = CASE WHEN @rating     >  0  THEN @rating     ELSE rating     END,
    duration   = CASE WHEN @duration   <> '' THEN @duration   ELSE duration   END,
    cast_names = CASE WHEN @cast_names <> '' THEN @cast_names ELSE cast_names END,
    director   = CASE WHEN @director   <> '' THEN @director   ELSE director   END,
    trailer    = CASE WHEN @trailer    <> '' THEN @trailer    ELSE trailer    END,
    backdrop   = CASE WHEN @backdrop   <> '' THEN @backdrop   ELSE backdrop   END
  WHERE type=@type AND stream_id=@stream_id
`);
const persistEpisode = db.prepare(`
  INSERT OR REPLACE INTO episodes
    (series_id, season, ep_index, ep_id, episode_num, title, plot, duration, still, container_extension)
  VALUES (@series_id, @season, @ep_index, @ep_id, @episode_num, @title, @plot, @duration, @still, @container_extension)
`);

// ---------- app settings (TMDB key for multilingual metadata) ----------
const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

app.get('/api/settings', (req, res) => {
  // never echo the key back; just whether multilingual metadata is enabled
  res.json({ tmdbEnabled: tmdbEnabled() });
});
app.post('/api/settings', (req, res) => {
  const { tmdbKey: key } = req.body || {};
  if (typeof key === 'string') setSetting.run('tmdb_key', key.trim());
  res.json({ ok: true, tmdbEnabled: tmdbEnabled() });
});

app.get('/api/detail/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const row = db.prepare('SELECT * FROM content WHERE type=? AND stream_id=?').get(type, id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const base = rowToItem(row);
  const client = getClient();

  // Deep-synced titles serve from our DB. Only hit the provider when we still
  // need something (a non-enriched title, or a series whose episodes aren't stored).
  let needProvider = !row.enriched_at;
  if (row.enriched_at && type === 'series') {
    const seasons = localSeasons(id);
    if (Object.keys(seasons).length) base.seasons = seasons;
    else needProvider = true;
  }

  try {
    if (needProvider && type === 'movie' && client) {
      const info = await client.vodInfo(id).catch(() => null);
      if (info && info.info) {
        base.plot = info.info.plot || info.info.description || base.plot;
        base.genre = info.info.genre || base.genre;
        base.rating = parseFloat(info.info.rating_5based || info.info.rating) || base.rating;
        base.year = (info.info.releasedate || info.info.releaseDate || base.year || '').toString().slice(0, 4);
        base.duration = info.info.duration || '';
        base.cast = info.info.cast || info.info.actors || '';
        base.director = info.info.director || '';
        base.trailer = info.info.youtube_trailer || '';
        const bd = info.info.backdrop_path;
        const bdUrl = Array.isArray(bd) ? bd[0] : bd;
        if (bdUrl) { base.backdrop = '/api/image?url=' + encodeURIComponent(bdUrl); base.rawBackdrop = bdUrl; }
        if (info.movie_data && info.movie_data.container_extension) {
          base.container_extension = info.movie_data.container_extension;
        }
        // Save what the provider gave us so it survives and is searchable.
        try {
          persistDetail.run({
            type: 'movie', stream_id: id,
            plot: base.plot || '', genre: base.genre || '', year: base.year || '',
            rating: base.rating || 0, duration: base.duration || '',
            cast_names: base.cast || '', director: base.director || '',
            trailer: base.trailer || '', backdrop: base.rawBackdrop || '',
          });
        } catch {}
      }
    } else if (needProvider && type === 'series' && client) {
      const info = await client.seriesInfo(id).catch(() => null);
      if (info) {
        if (info.info) {
          base.plot = info.info.plot || base.plot;
          base.genre = info.info.genre || base.genre;
          base.cast = info.info.cast || '';
          base.director = info.info.director || '';
          base.trailer = info.info.youtube_trailer || '';
        }
        const seasons = {};
        const episodesObj = info.episodes || {};
        for (const seasonNum of Object.keys(episodesObj)) {
          const eps = (episodesObj[seasonNum] || []).map((ep) => ({
            id: String(ep.id),
            episode_num: ep.episode_num,
            title: ep.title || `Episodio ${ep.episode_num}`,
            container_extension: ep.container_extension || 'mp4',
            plot: ep.info?.plot || ep.info?.overview || '',
            duration: ep.info?.duration || '',
            still: ep.info?.movie_image
              ? '/api/image?url=' + encodeURIComponent(ep.info.movie_image)
              : '',
          }));
          seasons[seasonNum] = eps;
        }
        base.seasons = seasons;
        // Save the series info + episodes locally (raw still URLs, as the
        // episodes table expects) so the title is searchable and loads fast next time.
        try {
          persistDetail.run({
            type: 'series', stream_id: id,
            plot: base.plot || '', genre: base.genre || '', year: base.year || '',
            rating: base.rating || 0, duration: '',
            cast_names: base.cast || '', director: base.director || '',
            trailer: base.trailer || '', backdrop: base.rawBackdrop || '',
          });
          const tx = db.transaction(() => {
            for (const seasonNum of Object.keys(episodesObj)) {
              (episodesObj[seasonNum] || []).forEach((ep, idx) => {
                persistEpisode.run({
                  series_id: id, season: String(seasonNum), ep_index: idx,
                  ep_id: String(ep.id),
                  episode_num: ep.episode_num != null ? Number(ep.episode_num) : idx + 1,
                  title: ep.title || `Episodio ${ep.episode_num || idx + 1}`,
                  plot: ep.info?.plot || ep.info?.overview || '',
                  duration: ep.info?.duration || '',
                  still: ep.info?.movie_image || '',
                  container_extension: ep.container_extension || 'mp4',
                });
              });
            }
          });
          tx();
        } catch {}
      }
    }
  } catch {}

  // On-demand IMDb: fetch the cast (with photos) + a backdrop the first time a
  // title is opened, even if it hasn't been deep-synced yet. Persisted so it's
  // only fetched once. This is why opening any title shows its cast.
  if (!base.castList || !base.castList.length) {
    try {
      const im = await imdbDeep(base.name);
      if (im) {
        if (im.cast && im.cast.length) {
          db.prepare('UPDATE content SET cast_json=?, imdb_id=? WHERE type=? AND stream_id=?')
            .run(JSON.stringify(im.cast), im.id, type, id);
          base.castList = im.cast.map((c) => ({ ...c, image: img(c.image) }));
        }
        if (!base.rawBackdrop && im.backdrop) {
          base.rawBackdrop = im.backdrop;
          base.backdrop = img(im.backdrop);
          db.prepare('UPDATE content SET backdrop=? WHERE type=? AND stream_id=?').run(im.backdrop, type, id);
        }
        if (!base.plot && im.plot) base.plot = im.plot;
      }
    } catch {}
  }

  // Localized plot + genres via TMDB (if a key is set and a non-Italian language
  // is requested). Cached per (title, lang); falls back to the provider/IMDb text.
  const lang = (req.query.lang || '').slice(0, 2).toLowerCase();
  if (lang && lang !== 'it' && tmdbEnabled()) {
    try {
      const loc = await tmdbLocalized(type, id, base.name, base.year, row.tmdb, lang);
      if (loc) { if (loc.plot) base.plot = loc.plot; if (loc.genre) base.genre = loc.genre; }
    } catch {}
  }

  res.json(base);
});

// ---------- short EPG for live ----------
app.get('/api/epg/:id', async (req, res) => {
  const client = getClient();
  if (!client) return res.json({ epg_listings: [] });
  try {
    const data = await client.shortEpg(req.params.id);
    res.json(data || { epg_listings: [] });
  } catch {
    res.json({ epg_listings: [] });
  }
});

// ---------- watch progress ----------
app.get('/api/progress', (req, res) => {
  const rows = db.prepare('SELECT * FROM progress ORDER BY updated_at DESC LIMIT 40').all();
  res.json(rows);
});
app.post('/api/progress', (req, res) => {
  const { type, id, position, duration, parent, season, ep_index } = req.body || {};
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  const key = `${type}:${id}`;
  db.prepare(`
    INSERT INTO progress (key, type, stream_id, position, duration, updated_at, parent_id, season, ep_index)
    VALUES (@key, @type, @stream_id, @position, @duration, @updated_at, @parent_id, @season, @ep_index)
    ON CONFLICT(key) DO UPDATE SET
      position=excluded.position, duration=excluded.duration, updated_at=excluded.updated_at,
      parent_id=excluded.parent_id, season=excluded.season, ep_index=excluded.ep_index
  `).run({
    key, type, stream_id: String(id),
    position: position || 0, duration: duration || 0,
    updated_at: Math.floor(Date.now() / 1000),
    parent_id: parent != null ? String(parent) : null,
    season: season != null ? String(season) : null,
    ep_index: ep_index != null ? parseInt(ep_index, 10) : null,
  });
  res.json({ ok: true });
});
app.delete('/api/progress/:type/:id', (req, res) => {
  db.prepare('DELETE FROM progress WHERE key = ?').run(`${req.params.type}:${req.params.id}`);
  res.json({ ok: true });
});
// Reset the whole "Continue Watching" list.
app.delete('/api/progress', (req, res) => {
  db.exec('DELETE FROM progress;');
  res.json({ ok: true });
});
// Remove one title from "Continue Watching" (a series clears all its episodes).
app.delete('/api/continue/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (type === 'series') db.prepare("DELETE FROM progress WHERE type='series' AND parent_id = ?").run(id);
  else db.prepare('DELETE FROM progress WHERE key = ?').run(`${type}:${id}`);
  res.json({ ok: true });
});

// ---------- image proxy (with on-disk cache) ----------
app.get('/api/image', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).end();

  const cacheFilePath = cacheFile(url);

  // Cache hit: serve the stored bytes without ever touching the provider.
  try {
    const buf = await fs.promises.readFile(cacheFilePath);
    if (buf.length) {
      res.setHeader('Content-Type', sniffImageType(buf));
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Image-Cache', 'HIT');
      return res.end(buf);
    }
  } catch { /* miss — fall through to fetch */ }

  // Cache miss: download once, store to disk, then serve.
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok || !r.body) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || sniffImageType(buf));
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Image-Cache', 'MISS');
    res.end(buf);
    // Persist after responding; write to a temp file + rename so a crash
    // mid-write can never leave a truncated image in the cache.
    if (buf.length) {
      const tmp = cacheFilePath + '.' + process.pid + '.tmp';
      fs.promises.writeFile(tmp, buf)
        .then(() => fs.promises.rename(tmp, cacheFilePath))
        .catch(() => fs.promises.unlink(tmp).catch(() => {}));
    }
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
});

// ---------- stream proxy (with HTTP range for VOD) ----------
async function proxyStream(targetUrl, req, res) {
  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) return res.end();
    const nodeStream = Readable.fromWeb(upstream.body);
    req.on('close', () => nodeStream.destroy());
    nodeStream.on('error', () => { try { res.end(); } catch {} });
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).end();
  }
}

function resolveTarget(client, type, id, ext) {
  if (type === 'live') return client.liveUrl(id, 'ts');
  if (type === 'movie') {
    const row = db.prepare("SELECT container_extension FROM content WHERE type='movie' AND stream_id=?").get(id);
    return client.movieUrl(id, ext || row?.container_extension || 'mp4');
  }
  if (type === 'series') return client.seriesUrl(id, ext || 'mp4');
  return null;
}

app.get('/api/stream/:type/:id', (req, res) => {
  const client = getClient();
  if (!client) return res.status(400).end();
  const target = resolveTarget(client, req.params.type, req.params.id, req.query.ext);
  if (!target) return res.status(400).end();
  proxyStream(target, req, res);
});

// ---------- on-the-fly HLS transcode (VOD the browser can't demux: MKV/AVI…) ----------
// Makes MKV/AVI play and exposes multi-audio (language switching). No subtitles.
const HLS_CT = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' };

// Subtitle list + transcode-completion flag (the player adds <track>s and, once
// done, refreshes the active subtitle so late cues from the growing .vtt appear).
app.get('/api/hls/vod/:type/:id/tracks.json', async (req, res) => {
  const client = getClient();
  if (!client) return res.status(400).end();
  const { type, id } = req.params;
  const target = resolveTarget(client, type, id, req.query.ext);
  if (!target || type === 'live') return res.status(400).end();
  try {
    const info = await probeInfo(target);          // duration + subs, without disturbing the session offset
    const s = getSession(`${type}:${id}`);
    res.json({ subs: info.subs, duration: info.duration, done: s ? !!s.done : false });
  } catch {
    res.json({ subs: [], duration: 0, done: true });
  }
});

app.get('/api/hls/vod/:type/:id/master.m3u8', async (req, res) => {
  const client = getClient();
  if (!client) return res.status(400).end();
  const { type, id } = req.params;
  const target = resolveTarget(client, type, id, req.query.ext);
  if (!target || type === 'live') return res.status(400).end();
  try {
    const ss = Math.max(0, parseFloat(req.query.ss) || 0); // seek-on-demand start offset
    const s = await ensureSession(`${type}:${id}`, target, ss);
    const master = path.join(s.dir, 'master.m3u8');
    // transcoded sources (esp. 4K) can take longer than the default to initialize
    if (!(await waitForFile(master, 45000)) || s.error) return res.status(502).end();
    res.setHeader('Content-Type', HLS_CT['.m3u8']);
    res.setHeader('Cache-Control', 'no-store');
    res.send(fs.readFileSync(master, 'utf8'));
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
});

app.get('/api/hls/vod/:type/:id/:file', async (req, res) => {
  const { type, id, file } = req.params;
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return res.status(400).end(); // no path traversal
  const s = getSession(`${type}:${id}`);
  if (!s) return res.status(404).end();
  const full = path.join(s.dir, file);
  const isVtt = path.extname(file) === '.vtt';
  res.setHeader('Cache-Control', 'no-store');
  // Subtitles fill progressively — always return a valid WebVTT (even empty/partial),
  // never 404, so the <track> loads. The player refreshes it once transcode is done.
  if (isVtt) {
    res.setHeader('Content-Type', 'text/vtt');
    try { return res.send(fs.readFileSync(full, 'utf8') || 'WEBVTT\n\n'); }
    catch { return res.send('WEBVTT\n\n'); }
  }
  // a segment listed in a playlist is already fully written, but a just-requested
  // one can lag the playlist by a beat — wait briefly before giving up.
  if (!(await waitForFile(full, 8000))) return res.status(404).end();
  res.setHeader('Content-Type', HLS_CT[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(full).on('error', () => { try { res.end(); } catch {} }).pipe(res);
});

app.delete('/api/hls/vod/:type/:id', (req, res) => {
  stopSession(`${req.params.type}:${req.params.id}`);
  res.json({ ok: true });
});

// ---------- HLS proxy (fallback for live channels served as m3u8) ----------
// Child playlist/segment URLs are referenced by an opaque token so the
// provider URL (which embeds username/password) is never sent to the browser.
const hlsMap = new Map();
function hlsToken(url) {
  const t = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  if (hlsMap.size > 4000) hlsMap.clear(); // live windows churn; old segments are dead
  hlsMap.set(t, url);
  return t;
}
function rewriteHls(text, baseUrl) {
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // rewrite URI="…" inside tags (EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP)
      return line.replace(/URI="([^"]+)"/g, (_m, uri) =>
        `URI="/api/hls/seg/${hlsToken(new URL(uri, baseUrl).toString())}"`);
    }
    return `/api/hls/seg/${hlsToken(new URL(t, baseUrl).toString())}`;
  }).join('\n');
}
async function serveHls(targetUrl, res) {
  try {
    const r = await fetch(targetUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 7).toString('ascii') === '#EXTM3U') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(rewriteHls(buf.toString('utf8'), r.url || targetUrl));
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
}
app.get('/api/hls/live/:id', (req, res) => {
  const client = getClient();
  if (!client) return res.status(400).end();
  serveHls(client.liveUrl(req.params.id, 'm3u8'), res);
});
app.get('/api/hls/seg/:token', (req, res) => {
  const url = hlsMap.get(req.params.token);
  if (!url) return res.status(404).end();
  serveHls(url, res);
});

// ---------- static client (production) ----------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Listen on all interfaces by default so phones/other devices on the same
// Wi-Fi can reach it via the machine's LAN IP. Override with HOST=127.0.0.1.
const HOST = process.env.HOST || '0.0.0.0';
function lanIPs() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}
app.listen(PORT, HOST, () => {
  console.log(`\n  🎬  Retlix server running:`);
  console.log(`      • locale   → http://127.0.0.1:${PORT}`);
  for (const ip of lanIPs()) console.log(`      • rete     → http://${ip}:${PORT}   (da telefono/altri dispositivi)`);
  if (!fs.existsSync(distDir)) {
    console.log('  ⚙️   Dev mode: avvia Vite ("npm run dev:client"); da telefono usa l\'IP di rete sulla porta 5173');
  }
  console.log('');
});
