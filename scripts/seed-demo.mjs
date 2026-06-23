// Seeds an ISOLATED demo DB (DATA_DIR) with fake content + generated gradient
// artwork, for README screenshots. Never touches the real data dir.
// Run: DATA_DIR=/tmp/shots/data node scripts/seed-demo.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../server/db.js';
import { cacheFile } from '../server/imgcache.js';

const FONT = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']
  .find((f) => fs.existsSync(f)) || '/System/Library/Fonts/Supplemental/Arial.ttf';
const IMGTMP = '/tmp/shots/img';
fs.mkdirSync(IMGTMP, { recursive: true });

const esc = (s) => s.replace(/'/g, "’").replace(/:/g, '\\:');
function gen(file, w, h, c0, c1, lines) {
  const out = path.join(IMGTMP, file);
  let vf = `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:type=linear:n=2`;
  const dt = lines.map((l, i) =>
    `drawtext=fontfile='${FONT}':text='${esc(l.t)}':fontcolor=${l.c}:fontsize=${l.s}:x=(w-text_w)/2:y=${l.y}`).join(',');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', vf, '-frames:v', '1', '-vf', dt, out]);
  return out;
}
// put a generated image into the proxy cache under sha1(url) so /api/image serves it offline
function cacheAs(url, file) {
  fs.copyFileSync(file, cacheFile(url));
}

const PALETTES = [
  ['0xe50914', '0x141414'], ['0x1f4068', '0x0b1c2c'], ['0x3a0ca3', '0x10002b'],
  ['0x2d6a4f', '0x081c15'], ['0x9d0208', '0x1a040a'], ['0x14213d', '0x000000'],
  ['0x4a4e69', '0x16161a'], ['0x6a040f', '0x100b0c'],
];
const GENRES = ['Action', 'Thriller', 'Sci-Fi', 'Drama', 'Comedy', 'Crime', 'Adventure', 'Mystery'];
const CATS = { movie: [['101', 'Action & Adventure'], ['102', 'Sci-Fi & Fantasy'], ['103', 'Drama'], ['104', 'Comedy']],
  series: [['201', 'Top Series'], ['202', 'Crime & Mystery']], live: [['301', 'Sport'], ['302', 'News'], ['303', 'Kids']] };

const MOVIE_TITLES = ['Neon Skyline', 'The Last Signal', 'Crimson Harbor', 'Echoes of Tomorrow', 'Silent Vector',
  'Midnight Protocol', 'Paper Tigers', 'The Glass Horizon', 'Velvet Static', 'Iron Meridian',
  'Northern Lights', 'The Quiet Mile', 'Solar Drift', 'Hollow Crown', 'After the Rain', 'Zero Daylight'];
const SERIES_TITLES = ['Dark Harbor', 'The Bureau', 'Wildcards', 'Lighthouse', 'Kingmakers', 'Static Town',
  'The Cartographer', 'Nightfall', 'Greyzone', 'Saltwater'];
const LIVE_TITLES = ['Sky Sport One', 'Prime Sports', 'World News 24', 'Cinema Live', 'Kids Toon', 'Music Hits',
  'Discovery Plus', 'Nature HD'];

const upContent = db.prepare(`INSERT OR REPLACE INTO content
  (type, stream_id, name, icon, backdrop, category_id, rating, added, container_extension, epg_channel_id, plot, year, genre, tmdb, metadata, cast_names, director, duration, enriched_at, details_at)
  VALUES (@type,@stream_id,@name,@icon,@backdrop,@category_id,@rating,@added,@container_extension,@epg_channel_id,@plot,@year,@genre,'', @metadata,@cast_names,@director,@duration,@enriched_at,@details_at)`);

const now = Math.floor(Date.now() / 1000);
const plot = (t, g) => `${t} follows a small crew pulled into something far larger than themselves. A taut ${g.toLowerCase()} where every choice has a price and nothing stays hidden for long.`;

let added = now;
function addItem(type, i, title, withBackdrop) {
  const id = `${type[0]}${1000 + i}`;
  const [c0, c1] = PALETTES[i % PALETTES.length];
  const year = 2018 + (i % 7);
  const genre = `${GENRES[i % GENRES.length]}, ${GENRES[(i + 3) % GENRES.length]}`;
  const cats = CATS[type]; const [cid] = cats[i % cats.length];
  const iconUrl = `http://demo.local/${type}/${id}/poster.png`;
  gen(`${id}.png`, 400, 600, c0, c1, [
    { t: title, c: 'white', s: title.length > 14 ? 30 : 38, y: 'h-170' },
    { t: `${GENRES[i % GENRES.length]} · ${year}`, c: '0xbbbbbb', s: 20, y: 'h-110' },
  ]);
  cacheAs(iconUrl, path.join(IMGTMP, `${id}.png`));
  let backdrop = '';
  if (withBackdrop) {
    const bdUrl = `http://demo.local/${type}/${id}/bd.png`;
    gen(`${id}-bd.png`, 1280, 720, c0, c1, [
      { t: title, c: 'white', s: 72, y: 'h*0.42' },
      { t: `${GENRES[i % GENRES.length]} · ${year}`, c: '0xcccccc', s: 30, y: 'h*0.56' },
    ]);
    cacheAs(bdUrl, path.join(IMGTMP, `${id}-bd.png`));
    backdrop = bdUrl;
  }
  upContent.run({
    type, stream_id: id, name: type === 'live' ? title : `${title} (${year})`,
    icon: iconUrl, backdrop, category_id: cid,
    rating: type === 'live' ? 0 : (5.5 + ((i * 7) % 40) / 10),
    added: added--, container_extension: 'mp4', epg_channel_id: '',
    plot: type === 'live' ? '' : plot(title, GENRES[i % GENRES.length]),
    year: type === 'live' ? '' : String(year), genre: type === 'live' ? '' : genre,
    metadata: null, cast_names: 'Alex Carver, Mara Lindqvist, Tom Becker', director: 'J. R. Falk',
    duration: type === 'movie' ? '1h 52m' : '', enriched_at: 0, details_at: now,
  });
  return id;
}

const tx = db.transaction(() => {
  // categories
  const upCat = db.prepare(`INSERT OR REPLACE INTO categories (type,category_id,name,sort_order) VALUES (?,?,?,?)`);
  for (const type of Object.keys(CATS)) CATS[type].forEach(([cid, name], i) => upCat.run(type, cid, name, i));

  MOVIE_TITLES.forEach((t, i) => addItem('movie', i, t, i < 6));     // first 6 get backdrops (hero pool)
  SERIES_TITLES.forEach((t, i) => addItem('series', i, t, i < 3));
  LIVE_TITLES.forEach((t, i) => addItem('live', i, t, false));

  // episodes for the first series (Dark Harbor → s2000)
  const upEp = db.prepare(`INSERT OR REPLACE INTO episodes
    (series_id,season,ep_index,ep_id,episode_num,title,plot,duration,still,container_extension)
    VALUES (@series_id,@season,@ep_index,@ep_id,@episode_num,@title,@plot,@duration,@still,@container_extension)`);
  for (let e = 0; e < 6; e++) {
    const stillUrl = `http://demo.local/ep/s2000/${e}.png`;
    gen(`ep-${e}.png`, 480, 270, PALETTES[e % PALETTES.length][0], PALETTES[e % PALETTES.length][1],
      [{ t: `Episode ${e + 1}`, c: 'white', s: 34, y: '(h-text_h)/2' }]);
    cacheAs(stillUrl, path.join(IMGTMP, `ep-${e}.png`));
    upEp.run({ series_id: 's2000', season: '1', ep_index: e, ep_id: `ep${e}`, episode_num: e + 1,
      title: `The Tide Turns, Part ${e + 1}`, plot: 'The crew closes in while old loyalties fracture.',
      duration: '48m', still: stillUrl, container_extension: 'mp4' });
  }

  // provider (fake) so the app is "configured"
  db.prepare(`INSERT OR REPLACE INTO provider (id,url,username,password,server_info,user_info,last_sync)
    VALUES (1,'http://demo.local','demo','demo', @si, @ui, @ls)`).run({
    si: JSON.stringify({ url: 'demo.local', port: '80' }),
    ui: JSON.stringify({ status: 'Active', exp_date: String(now + 86400 * 200), max_connections: '2', active_cons: '0' }),
    ls: now,
  });

  // watch history → Continue Watching + recommendations
  const upProg = db.prepare(`INSERT OR REPLACE INTO progress (key,type,stream_id,position,duration,updated_at,parent_id,season,ep_index)
    VALUES (@key,@type,@stream_id,@position,@duration,@updated_at,@parent_id,@season,@ep_index)`);
  upProg.run({ key: 'movie:m1000', type: 'movie', stream_id: 'm1000', position: 2400, duration: 6700, updated_at: now, parent_id: null, season: null, ep_index: null });
  upProg.run({ key: 'movie:m1002', type: 'movie', stream_id: 'm1002', position: 1200, duration: 6300, updated_at: now - 100, parent_id: null, season: null, ep_index: null });
  upProg.run({ key: 'series:ep1', type: 'series', stream_id: 'ep1', position: 900, duration: 2880, updated_at: now - 200, parent_id: 's2000', season: '1', ep_index: 1 });
});
tx();

const c = (t) => db.prepare('SELECT COUNT(*) c FROM content WHERE type=?').get(t).c;
console.log(`seeded → movies:${c('movie')} series:${c('series')} live:${c('live')}`);
