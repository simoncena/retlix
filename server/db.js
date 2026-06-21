import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS provider (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    url TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    server_info TEXT,
    user_info TEXT,
    last_sync INTEGER
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- live | movie | series
    category_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(type, category_id)
  );

  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- live | movie | series
    stream_id TEXT NOT NULL,       -- xtream stream_id / series_id
    name TEXT NOT NULL,
    icon TEXT,                     -- poster (stream_icon / cover / movie_image)
    backdrop TEXT,
    category_id TEXT,
    rating REAL DEFAULT 0,
    added INTEGER DEFAULT 0,
    container_extension TEXT,
    epg_channel_id TEXT,
    plot TEXT,
    year TEXT,
    genre TEXT,
    tmdb TEXT,
    metadata TEXT,
    UNIQUE(type, stream_id)
  );

  CREATE INDEX IF NOT EXISTS idx_content_type_cat ON content(type, category_id);
  CREATE INDEX IF NOT EXISTS idx_content_type_added ON content(type, added DESC);
  CREATE INDEX IF NOT EXISTS idx_content_name ON content(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS progress (
    key TEXT PRIMARY KEY,          -- type:stream_id  (stream_id = episode id for series)
    type TEXT,
    stream_id TEXT,
    position REAL,
    duration REAL,
    updated_at INTEGER
  );
`);

// --- migrations: series resume needs to map an episode back to its series ---
const progCols = db.prepare('PRAGMA table_info(progress)').all().map((c) => c.name);
if (!progCols.includes('parent_id')) db.exec('ALTER TABLE progress ADD COLUMN parent_id TEXT'); // series_id for episodes
if (!progCols.includes('season')) db.exec('ALTER TABLE progress ADD COLUMN season TEXT');
if (!progCols.includes('ep_index')) db.exec('ALTER TABLE progress ADD COLUMN ep_index INTEGER');

// --- migrations: full local enrichment (everything stored in our own DB) ---
const contentCols = db.prepare('PRAGMA table_info(content)').all().map((c) => c.name);
const addContentCol = (name, decl) => { if (!contentCols.includes(name)) db.exec(`ALTER TABLE content ADD COLUMN ${name} ${decl}`); };
addContentCol('cast_names', 'TEXT');      // comma-separated names (provider); "cast" is a SQL keyword
addContentCol('director', 'TEXT');
addContentCol('duration', 'TEXT');
addContentCol('trailer', 'TEXT');         // youtube id
addContentCol('cast_json', 'TEXT');       // [{name,image,character}] from IMDb credits
addContentCol('imdb_id', 'TEXT');
addContentCol('details_at', 'INTEGER DEFAULT 0');  // 0 = provider details (plot/cast/episodes) not fetched yet
addContentCol('enriched_at', 'INTEGER DEFAULT 0'); // 0 = not yet fully enriched (provider + IMDb photos)

db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    series_id TEXT NOT NULL,
    season TEXT NOT NULL,
    ep_index INTEGER NOT NULL,    -- index within the season (matches the player's ?ei=)
    ep_id TEXT NOT NULL,          -- xtream episode stream id
    episode_num INTEGER,
    title TEXT,
    plot TEXT,
    duration TEXT,
    still TEXT,                   -- raw image url
    container_extension TEXT,
    PRIMARY KEY (series_id, season, ep_index)
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);

  -- key/value app settings (e.g. the TMDB API key) — stays in the data volume, never in the image
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- localized plot/genre from TMDB, cached per (content, language)
  CREATE TABLE IF NOT EXISTS tmdb_i18n (
    type TEXT NOT NULL,           -- movie | series
    stream_id TEXT NOT NULL,
    lang TEXT NOT NULL,           -- en | es | fr | de | pt …
    plot TEXT,
    genre TEXT,
    updated_at INTEGER,
    PRIMARY KEY (type, stream_id, lang)
  );
`);

export default db;
