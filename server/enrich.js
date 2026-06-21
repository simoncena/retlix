// Deep enrichment: pull every detail the provider + IMDb expose for a title and
// store it in our own DB, so at runtime nothing external is called. Incremental:
// a title with enriched_at != 0 is skipped. Each enrich returns the list of raw
// image URLs it touched, so the caller can pre-cache them to disk.
import db from './db.js';
import { imdbDeep } from './imdb.js';

const firstUrl = (b) => (Array.isArray(b) ? b[0] : b) || '';

// In light (provider-only) mode @cast_json/@imdb_id are null and @enriched_at is 0;
// COALESCE/CASE keep any IMDb data already fetched (e.g. lazily on a detail open)
// instead of wiping it. @details_at is always set (provider details were fetched).
const updContent = db.prepare(`
  UPDATE content SET
    plot=@plot, genre=@genre, year=@year, rating=@rating, backdrop=@backdrop,
    cast_names=@cast_names, director=@director, duration=@duration, trailer=@trailer,
    cast_json=COALESCE(@cast_json, cast_json),
    imdb_id=COALESCE(@imdb_id, imdb_id),
    enriched_at=CASE WHEN @enriched_at > 0 THEN @enriched_at ELSE enriched_at END,
    details_at=@details_at
  WHERE type=@type AND stream_id=@stream_id
`);

const delEpisodes = db.prepare('DELETE FROM episodes WHERE series_id=?');
const insEpisode = db.prepare(`
  INSERT OR REPLACE INTO episodes
    (series_id, season, ep_index, ep_id, episode_num, title, plot, duration, still, container_extension)
  VALUES (@series_id, @season, @ep_index, @ep_id, @episode_num, @title, @plot, @duration, @still, @container_extension)
`);

// Images to pre-cache during the deep sync: the ones shown while browsing
// (poster + backdrop, plus episode stills for series). Actor photos are NOT
// pre-fetched in bulk — at full-library scale that's ~1M files; they are cached
// on demand by /api/image the first time a detail modal is opened.
function browseImages(icon, backdrop) {
  const urls = [];
  if (icon) urls.push(icon);
  if (backdrop) urls.push(backdrop);
  return urls;
}

// opts.skipImdb → light mode: only provider data (plot/cast/director/duration),
// no IMDb call, no image precache, and the title is left not-fully-enriched so a
// later full sync can still add the IMDb cast photos.
export async function enrichMovie(client, row, now, opts = {}) {
  const skipImdb = !!opts.skipImdb;
  let { plot, genre, year, rating, backdrop } = row;
  let cast = '', director = '', duration = '', trailer = '', castJson = null, imdbId = null;

  // 1) provider — get_vod_info has plot/genre/cast/director/duration/backdrop/trailer
  const info = await client.vodInfo(row.stream_id).catch(() => null);
  if (info && info.info) {
    const i = info.info;
    plot = i.plot || i.description || plot || '';
    genre = i.genre || genre || '';
    year = (i.releasedate || i.releaseDate || year || '').toString().slice(0, 4);
    rating = parseFloat(i.rating_5based || i.rating) || rating || 0;
    duration = i.duration || '';
    cast = i.cast || i.actors || '';
    director = i.director || '';
    trailer = i.youtube_trailer || '';
    const u = firstUrl(i.backdrop_path);
    if (u) backdrop = u;
  }

  // 2) IMDb — backdrop fallback + normalized genres + cast photos + director
  if (!skipImdb) {
    const im = await imdbDeep(row.name).catch(() => null);
    if (im) {
      imdbId = im.id;
      if (!backdrop && im.backdrop) backdrop = im.backdrop;
      if (!plot) plot = im.plot;
      if (!year) year = im.year;
      if (!genre) genre = im.genre;
      if (!director && im.director) director = im.director;
      if (im.cast && im.cast.length) castJson = JSON.stringify(im.cast);
    }
  }

  updContent.run({
    type: 'movie', stream_id: row.stream_id,
    plot: plot || '', genre: genre || '', year: year || '', rating: rating || 0, backdrop: backdrop || '',
    cast_names: cast || '', director: director || '', duration: duration || '', trailer: trailer || '',
    cast_json: castJson, imdb_id: imdbId,
    enriched_at: skipImdb ? 0 : now, details_at: now,
  });
  return skipImdb ? [] : browseImages(row.icon, backdrop);
}

export async function enrichSeries(client, row, now, opts = {}) {
  const skipImdb = !!opts.skipImdb;
  let { plot, genre, year, rating, backdrop } = row;
  let cast = '', director = '', trailer = '', castJson = null, imdbId = null;
  // series bulk already filled cast/director into metadata
  try {
    const meta = row.metadata ? JSON.parse(row.metadata) : null;
    if (meta) { cast = meta.cast || ''; director = meta.director || ''; trailer = meta.youtube_trailer || ''; }
  } catch {}

  // 1) provider — get_series_info gives richer info + all episodes
  const info = await client.seriesInfo(row.stream_id).catch(() => null);
  if (info) {
    if (info.info) {
      plot = info.info.plot || plot || '';
      genre = info.info.genre || genre || '';
      cast = info.info.cast || cast || '';
      director = info.info.director || director || '';
      trailer = info.info.youtube_trailer || trailer || '';
      const u = firstUrl(info.info.backdrop_path);
      if (u && !backdrop) backdrop = u;
    }
    const episodesObj = info.episodes || {};
    const tx = db.transaction(() => {
      delEpisodes.run(row.stream_id);
      for (const seasonNum of Object.keys(episodesObj)) {
        (episodesObj[seasonNum] || []).forEach((ep, idx) => {
          insEpisode.run({
            series_id: row.stream_id,
            season: String(seasonNum),
            ep_index: idx,
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
  }

  // 2) IMDb — cast photos + backdrop fallback + normalized genres
  if (!skipImdb) {
    const im = await imdbDeep(row.name).catch(() => null);
    if (im) {
      imdbId = im.id;
      if (!backdrop && im.backdrop) backdrop = im.backdrop;
      if (!plot) plot = im.plot;
      if (!genre) genre = im.genre;
      if (!director && im.director) director = im.director;
      if (im.cast && im.cast.length) castJson = JSON.stringify(im.cast);
    }
  }

  updContent.run({
    type: 'series', stream_id: row.stream_id,
    plot: plot || '', genre: genre || '', year: year || '', rating: rating || 0, backdrop: backdrop || '',
    cast_names: cast || '', director: director || '', duration: '', trailer: trailer || '',
    cast_json: castJson, imdb_id: imdbId,
    enriched_at: skipImdb ? 0 : now, details_at: now,
  });

  if (skipImdb) return [];
  // collect episode stills for precache too
  const stills = db.prepare("SELECT still FROM episodes WHERE series_id=? AND still != ''").all(row.stream_id).map((r) => r.still);
  return browseImages(row.icon, backdrop).concat(stills);
}

// Run an async worker over items with bounded concurrency. onTick(doneCount) is
// called after each item so the caller can emit progress.
export async function runPool(items, concurrency, worker, onTick = () => {}) {
  let i = 0, done = 0;
  const next = async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch { /* keep going */ }
      onTick(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}
