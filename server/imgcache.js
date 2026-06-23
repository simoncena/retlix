// On-disk cache for images (posters, backdrops, actor photos, episode stills).
// Shared by the /api/image proxy and the deep-sync precache so they hash URLs
// the same way and never download the same image twice.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
export const IMG_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

export function cacheFile(url) {
  return path.join(IMG_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'));
}

// Sniff the content-type from the first bytes so we don't need a sidecar file.
export function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

// Download a URL into the cache if not already present. Returns true if the file
// is on disk afterwards. Writes via temp file + rename so a crash mid-write can
// never leave a truncated image.
export async function ensureCached(url, ua) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const f = cacheFile(url);
  try { const st = await fs.promises.stat(f); if (st.size) return true; } catch { /* miss */ }
  try {
    const r = await fetch(url, { headers: ua ? { 'User-Agent': ua } : {} });
    if (!r.ok || !r.body) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return false;
    const tmp = f + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, f);
    return true;
  } catch {
    return false;
  }
}
