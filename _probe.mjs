import DB from 'better-sqlite3';
import { createClient } from './server/xtream.js';
const db = new DB('data/app.db', { readonly: true });
const client = createClient(db.prepare('SELECT * FROM provider WHERE id=1').get());
// one mp4 and one mkv movie
const mp4 = db.prepare("SELECT stream_id,name,container_extension FROM content WHERE type='movie' AND container_extension='mp4' LIMIT 1").get();
const mkv = db.prepare("SELECT stream_id,name,container_extension FROM content WHERE type='movie' AND container_extension='mkv' LIMIT 1").get();
for (const m of [mp4, mkv]) {
  console.log(`URL_${m.container_extension}=${client.movieUrl(m.stream_id, m.container_extension)}`);
  console.log(`NAME_${m.container_extension}=${m.name}`);
}
