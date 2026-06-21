import db from './db.js';
import { createClient, UA } from './xtream.js';
import { enrichMovie, enrichSeries, runPool } from './enrich.js';
import { ensureCached } from './imgcache.js';

// Parse a possibly-array / possibly-string backdrop field into a single URL
function firstBackdrop(b) {
  if (!b) return null;
  if (Array.isArray(b)) return b[0] || null;
  if (typeof b === 'string') return b;
  return null;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

const upsertCategory = db.prepare(`
  INSERT INTO categories (type, category_id, name, sort_order)
  VALUES (@type, @category_id, @name, @sort_order)
  ON CONFLICT(type, category_id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order
`);

const upsertContent = db.prepare(`
  INSERT INTO content (type, stream_id, name, icon, backdrop, category_id, rating, added, container_extension, epg_channel_id, plot, year, genre, tmdb, metadata)
  VALUES (@type, @stream_id, @name, @icon, @backdrop, @category_id, @rating, @added, @container_extension, @epg_channel_id, @plot, @year, @genre, @tmdb, @metadata)
  ON CONFLICT(type, stream_id) DO UPDATE SET
    name = excluded.name, icon = excluded.icon,
    category_id = excluded.category_id, rating = excluded.rating, added = excluded.added,
    container_extension = excluded.container_extension, epg_channel_id = excluded.epg_channel_id,
    tmdb = excluded.tmdb, metadata = excluded.metadata,
    -- keep already-enriched values when the bulk payload has nothing for them
    backdrop = CASE WHEN excluded.backdrop <> '' THEN excluded.backdrop ELSE backdrop END,
    plot = CASE WHEN excluded.plot <> '' THEN excluded.plot ELSE plot END,
    year = CASE WHEN excluded.year <> '' THEN excluded.year ELSE year END,
    genre = CASE WHEN excluded.genre <> '' THEN excluded.genre ELSE genre END
`);

function writeCategories(type, cats) {
  const tx = db.transaction((rows) => {
    rows.forEach((c, i) => {
      upsertCategory.run({
        type,
        category_id: String(c.category_id),
        name: c.category_name || `Category ${c.category_id}`,
        sort_order: i,
      });
    });
  });
  tx(Array.isArray(cats) ? cats : []);
}

function writeContent(type, items, mapFn) {
  const tx = db.transaction((rows) => {
    for (const raw of rows) {
      const r = mapFn(raw);
      if (r) upsertContent.run(r);
    }
  });
  tx(Array.isArray(items) ? items : []);
}

const mapMovie = (m) => ({
  type: 'movie',
  stream_id: String(m.stream_id),
  name: m.name || 'Untitled',
  icon: m.stream_icon || m.movie_image || '',
  backdrop: '',
  category_id: m.category_id != null ? String(m.category_id) : '',
  rating: num(m.rating_5based || m.rating),
  added: parseInt(m.added, 10) || 0,
  container_extension: m.container_extension || 'mp4',
  epg_channel_id: '',
  plot: '',
  year: m.year || '',
  genre: '',
  tmdb: m.tmdb || '',
  metadata: null,
});

const mapSeries = (s) => ({
  type: 'series',
  stream_id: String(s.series_id),
  name: s.name || 'Untitled',
  icon: s.cover || '',
  backdrop: firstBackdrop(s.backdrop_path) || '',
  category_id: s.category_id != null ? String(s.category_id) : '',
  rating: num(s.rating_5based || s.rating),
  added: parseInt(s.last_modified, 10) || 0,
  container_extension: '',
  epg_channel_id: '',
  plot: s.plot || '',
  year: (s.releaseDate || s.release_date || '').slice(0, 4),
  genre: s.genre || '',
  tmdb: s.tmdb || '',
  metadata: JSON.stringify({
    cast: s.cast || '',
    director: s.director || '',
    youtube_trailer: s.youtube_trailer || '',
    episode_run_time: s.episode_run_time || '',
  }),
});

const mapLive = (c) => ({
  type: 'live',
  stream_id: String(c.stream_id),
  name: c.name || 'Channel',
  icon: c.stream_icon || '',
  backdrop: '',
  category_id: c.category_id != null ? String(c.category_id) : '',
  rating: 0,
  added: parseInt(c.added, 10) || 0,
  container_extension: '',
  epg_channel_id: c.epg_channel_id || '',
  plot: '',
  year: '',
  genre: '',
  tmdb: '',
  metadata: JSON.stringify({
    tv_archive: c.tv_archive || 0,
    tv_archive_duration: c.tv_archive_duration || 0,
  }),
});

/**
 * Download everything from the configured provider into the DB.
 * onProgress({ stage, message, percent, counts }) is called repeatedly.
 */
export async function runSync(onProgress = () => {}, opts = {}) {
  const provider = db.prepare('SELECT * FROM provider WHERE id = 1').get();
  if (!provider) throw new Error('No provider configured');

  const client = createClient(provider);
  const counts = { live: 0, movie: 0, series: 0, categories: 0, enriched: 0, toEnrich: 0 };

  // Two enrichment modes share the same per-title machinery:
  //   • deep    → provider details + IMDb cast photos + image precache (slow, complete)
  //   • details → provider details only: plot/cast/director/episodes, no IMDb, no images
  //               (the "Aggiorna libreria" button — fast and reliable, photos load lazily)
  const wantEnrich = opts.deep || opts.details;
  const skipImdb = !opts.deep;

  const emit = (stage, message, percent) => onProgress({ stage, message, percent, counts });
  // Log lines go to BOTH the server console and the client (SSE), so a sync
  // is observable in either place.
  const log = (line) => { console.log('[sync] ' + line); onProgress({ log: line }); };
  // When enrichment follows, the bulk download only occupies the first 20%.
  const bulkPct = (p) => (wantEnrich ? Math.round(p * 0.2) : p);

  emit('start', 'Connessione al provider…', bulkPct(2));
  log(opts.deep ? 'Sincronizzazione COMPLETA (dettagli + immagini) avviata'
    : opts.details ? 'Sincronizzazione DETTAGLI provider (senza foto) avviata'
    : 'Sincronizzazione avviata');

  // Categories (3 calls)
  emit('categories', 'Scarico le categorie…', bulkPct(6));
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    client.liveCategories().catch(() => []),
    client.vodCategories().catch(() => []),
    client.seriesCategories().catch(() => []),
  ]);
  writeCategories('live', liveCats);
  writeCategories('movie', vodCats);
  writeCategories('series', seriesCats);
  counts.categories =
    (liveCats?.length || 0) + (vodCats?.length || 0) + (seriesCats?.length || 0);
  emit('categories', `${counts.categories} categorie`, bulkPct(15));
  log(`Categorie: ${counts.categories}`);

  // Movies
  emit('movies', 'Scarico i film…', bulkPct(20));
  const vods = await client.vodStreams().catch(() => []);
  writeContent('movie', vods, mapMovie);
  counts.movie = Array.isArray(vods) ? vods.length : 0;
  emit('movies', `${counts.movie} film`, bulkPct(50));
  log(`Film: ${counts.movie}`);

  // Series
  emit('series', 'Scarico le serie…', bulkPct(55));
  const series = await client.series().catch(() => []);
  writeContent('series', series, mapSeries);
  counts.series = Array.isArray(series) ? series.length : 0;
  emit('series', `${counts.series} serie`, bulkPct(75));
  log(`Serie: ${counts.series}`);

  // Live
  emit('live', 'Scarico i canali live…', bulkPct(80));
  const live = await client.liveStreams().catch(() => []);
  writeContent('live', live, mapLive);
  counts.live = Array.isArray(live) ? live.length : 0;
  emit('live', `${counts.live} canali live`, bulkPct(95));
  log(`Canali live: ${counts.live}`);

  // Prune categories that ended up with no content (keeps the UI clean)
  db.prepare(`
    DELETE FROM categories
    WHERE NOT EXISTS (
      SELECT 1 FROM content
      WHERE content.type = categories.type
        AND content.category_id = categories.category_id
    )
  `).run();

  db.prepare('UPDATE provider SET last_sync = ? WHERE id = 1').run(Math.floor(Date.now() / 1000));

  // ---- enrichment: store provider (and optionally IMDb) detail locally ----
  if (wantEnrich) {
    const now = Math.floor(Date.now() / 1000);
    // deep: titles missing full enrichment. details: titles missing provider
    // details (and not already fully enriched, which implies details are present).
    const todo = opts.deep
      ? db.prepare(
          "SELECT * FROM content WHERE type IN ('movie','series') AND COALESCE(enriched_at,0) = 0"
        ).all()
      : db.prepare(
          "SELECT * FROM content WHERE type IN ('movie','series') AND COALESCE(details_at,0) = 0 AND COALESCE(enriched_at,0) = 0"
        ).all();
    counts.toEnrich = todo.length;

    // Light mode is pure provider-API (no IMDb rate-limit, no image downloads), so
    // it can run far more in parallel than the full deep sync. Tunable via env.
    const enrichConc = parseInt(process.env.SYNC_CONCURRENCY, 10) || (opts.deep ? 8 : 16);

    if (todo.length) {
      emit('enrich', `Scarico i dettagli di ${todo.length} titoli…`, 20);
      log(`Arricchimento: ${todo.length} titoli da scaricare (${todo.filter((r) => r.type === 'movie').length} film, ${todo.filter((r) => r.type === 'series').length} serie) · ${enrichConc} in parallelo`);
      let imgCount = 0;
      await runPool(todo, enrichConc, async (row) => {
        try {
          const imgs = row.type === 'movie'
            ? await enrichMovie(client, row, now, { skipImdb })
            : await enrichSeries(client, row, now, { skipImdb });
          let cached = 0;
          if (opts.precache && imgs && imgs.length) {
            await runPool(imgs, 3, async (u) => { if (await ensureCached(u, UA)) cached++; });
            imgCount += cached;
          }
          const eps = row.type === 'series'
            ? db.prepare('SELECT COUNT(*) c FROM episodes WHERE series_id=?').get(row.stream_id).c : 0;
          const tag = row.type === 'series' ? `${eps} ep` : 'film';
          log(`✓ ${row.name} · ${tag} · ${cached} img`);
        } catch (e) {
          log(`✗ ${row.name} · errore: ${e.message}`);
        }
      }, (done) => {
        counts.enriched = done;
        if (done % 10 === 0 || done === todo.length) {
          emit('enrich', `Dettagli ${done}/${todo.length} · ${imgCount} immagini salvate`, 20 + Math.floor((done / todo.length) * 76));
        }
      });
      log(`Arricchimento completato: ${counts.enriched} titoli, ${imgCount} immagini salvate`);
    } else {
      emit('enrich', 'Dettagli già aggiornati', 96);
      log('Tutti i titoli erano già arricchiti — niente da scaricare');
    }

    // Pre-cache live channel logos too (they aren't "enriched").
    if (opts.precache) {
      const liveIcons = db.prepare("SELECT icon FROM content WHERE type='live' AND icon != ''").all().map((r) => r.icon);
      if (liveIcons.length) {
        emit('enrich', `Salvo ${liveIcons.length} loghi dei canali…`, 98);
        log(`Loghi canali live: ${liveIcons.length} da salvare…`);
        let n = 0;
        await runPool(liveIcons, 6, async (u) => { if (await ensureCached(u, UA)) n++; });
        log(`Loghi canali live salvati: ${n}`);
      }
    }
  }

  emit('done', 'Libreria pronta', 100);
  log('Fatto. Libreria pronta.');
  return counts;
}
