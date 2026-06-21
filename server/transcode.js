// On-the-fly HLS transcoding for VOD the browser can't demux natively (MKV/AVI…).
// ffmpeg reads the provider stream ONCE and produces an HLS master with the video
// (copied if h264, else x264) + every audio track as a selectable rendition
// (hls.js exposes them as audioTracks). Subtitles are intentionally not handled.
// Sessions are keyed by type:id, reused, idle-expired, and capped, so at most a
// handful of ffmpeg processes ever run (typically one — personal use).
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { UA } from './xtream.js';

// Hardware H.264 encoder on macOS keeps even 4K/HEVC sources real-time; elsewhere
// fall back to libx264 veryfast. (h264_videotoolbox exists on Apple platforms.)
const HW_ENC = process.platform === 'darwin';

const ROOT = path.join(os.tmpdir(), 'retlix-hls');
fs.mkdirSync(ROOT, { recursive: true });

// Subtitle codecs we can convert to WebVTT. Image-based subs (PGS/dvdsub) can't.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'subviewer', 'text']);
const SESSION_TTL = 30 * 60 * 1000; // kill a session idle this long
const MAX_SESSIONS = 4;

const sessions = new Map(); // key -> session
const probeCache = new Map(); // url -> probe (so seek-restarts skip re-probing)

const dirFor = (key) => path.join(ROOT, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16));
// var_stream_map is space/comma-delimited, so names must not contain either.
const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'x';

function ffprobe(url) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format',
      '-probesize', '8M', '-analyzeduration', '8M',
      '-user_agent', UA, url,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const streams = j.streams || [];
        resolve({
          video: streams.find((s) => s.codec_type === 'video'),
          audios: streams.filter((s) => s.codec_type === 'audio'),
          subs: streams.filter((s) => s.codec_type === 'subtitle'),
          duration: parseFloat(j.format?.duration) || 0,
        });
      } catch { resolve(null); }
    });
  });
}

async function getProbe(url) {
  if (probeCache.has(url)) return probeCache.get(url);
  const p = await ffprobe(url);
  if (p) probeCache.set(url, p);
  return p;
}

// Text subtitle tracks → sidecar list (shared by buildArgs and the API so the
// sub<N>.vtt filenames always line up).
function textSubs(probe) {
  const out = [];
  (probe.subs || []).forEach((s) => {
    if (!TEXT_SUBS.has(s.codec_name)) return;
    out.push({ file: `sub${out.length}.vtt`, lang: s.tags?.language || '', name: s.tags?.title || s.tags?.language || '', idx: out.length });
  });
  return out;
}

export async function probeInfo(url) {
  const p = await getProbe(url);
  if (!p) return { duration: 0, subs: [] };
  return { duration: p.duration || 0, subs: textSubs(p).map(({ file, lang, name }) => ({ file, lang, name })) };
}

function buildArgs(url, dir, probe, ss) {
  const videoCopy = probe.video && probe.video.codec_name === 'h264';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-user_agent', UA];
  if (ss > 0) args.push('-ss', String(ss)); // fast input seek; output timestamps reset to 0
  args.push('-i', url, '-map', '0:v:0');
  probe.audios.forEach((_, i) => args.push('-map', `0:a:${i}`));

  if (videoCopy) {
    args.push('-c:v', 'copy');
  } else if (HW_ENC) {
    // hardware encode (fast enough for 4K in real time)
    args.push('-c:v', 'h264_videotoolbox', '-b:v', '6M', '-g', '48');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '48', '-sc_threshold', '0');
  }
  args.push('-c:a', 'aac', '-ac', '2');

  // one HLS variant (the video) + one audio rendition per track, all in group "aud"
  const vsm = ['v:0,agroup:aud'];
  probe.audios.forEach((a, i) => {
    const lang = sanitize(a.tags?.language || 'und');
    // name must be UNIQUE per variant (it becomes the playlist filename).
    vsm.push(`a:${i},agroup:aud,language:${lang},name:a${i}_${lang}${i === 0 ? ',default:yes' : ''}`);
  });
  args.push(
    // 'event' = an append-only (growing) VOD playlist: hls.js can seek anywhere
    // already produced, instead of treating it as a sliding live window.
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', vsm.join(' '),
    '-hls_segment_filename', path.join(dir, 'seg_%v_%03d.ts'),
    path.join(dir, 'v%v.m3u8'),
  );

  // Text subtitle tracks → full WebVTT sidecars, written in the SAME input read.
  const subs = textSubs(probe);
  subs.forEach((s) => {
    args.push('-map', `0:s:${s.idx}`, '-c:s', 'webvtt', '-f', 'webvtt', path.join(dir, s.file));
  });
  return { args, subs: subs.map(({ file, lang, name }) => ({ file, lang, name })) };
}

function killSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try { s.proc && s.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}

function evictIfNeeded() {
  if (sessions.size < MAX_SESSIONS) return;
  let oldestKey = null, oldest = Infinity;
  for (const [k, s] of sessions) if (s.lastAccess < oldest) { oldest = s.lastAccess; oldestKey = k; }
  if (oldestKey) killSession(oldestKey);
}

// Start (or reuse) a transcode session at start offset `ss` (seconds). A seek to
// an un-transcoded point restarts ffmpeg from there (offset changes → relaunch).
// Resolves once ffmpeg has been spawned; callers then waitForFile(master).
export function ensureSession(key, url, ss = 0) {
  ss = Math.max(0, Math.floor(ss || 0));
  const existing = sessions.get(key);
  if (existing && existing.offset === ss) { existing.lastAccess = Date.now(); return existing.ready.then(() => existing); }
  if (existing) killSession(key); // different offset → relaunch from the new point

  evictIfNeeded();
  const dir = dirFor(key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const session = { dir, proc: null, subs: [], duration: 0, offset: ss, done: false, error: null, createdAt: Date.now(), lastAccess: Date.now() };
  session.ready = (async () => {
    const probe = await getProbe(url);
    if (!probe || !probe.video) { session.error = 'probe failed'; throw new Error('probe failed'); }
    session.duration = probe.duration || 0;
    const { args, subs } = buildArgs(url, dir, probe, ss);
    session.subs = subs;
    const proc = spawn('ffmpeg', args);
    session.proc = proc;
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    proc.on('error', (e) => { session.done = true; session.error = e.message; });
    proc.on('close', (code) => {
      session.done = true;
      if (code && !fs.existsSync(path.join(dir, 'master.m3u8'))) session.error = errTail.slice(-400) || `ffmpeg exit ${code}`;
    });
  })();
  sessions.set(key, session);
  return session.ready.then(() => session);
}

export function getSession(key) {
  const s = sessions.get(key);
  if (s) s.lastAccess = Date.now();
  return s;
}

export function stopSession(key) { killSession(key); }

// Poll for a file (a freshly-spawned ffmpeg writes master/playlists within ~1s).
export function waitForFile(file, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

// Idle sweep
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastAccess > SESSION_TTL) killSession(k);
}, 60 * 1000).unref?.();

// Best-effort cleanup of the whole scratch dir on exit.
const wipe = () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} };
process.on('exit', wipe);
process.on('SIGINT', () => { wipe(); process.exit(0); });
process.on('SIGTERM', () => { wipe(); process.exit(0); });
