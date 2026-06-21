import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import mpegts from 'mpegts.js';
import Hls from 'hls.js';
import { api, streamUrl, hlsVodMaster, hlsVodFile, hlsVodTracks, stopHlsVod } from '../api.js';
import { useI18n } from '../i18n.js';
import Icon from '../components/Icons.jsx';

function fmt(t) {
  if (!t || isNaN(t) || !isFinite(t)) return '0:00';
  t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Netflix-style continuous buffering: favor a healthy, stable forward buffer over
// low latency, and recover from stalls automatically instead of parking on a spinner.
const STALL_TICKS = 6;        // ~seconds of no real progress (while playing) before we act
const NUDGE_AHEAD = 0.3;      // buffered seconds ahead the playhead → a decoder nudge can recover
const MAX_VOD_RETRIES = 10;   // cap upstream reconnects for VOD before surfacing an error
const PREFETCH_LEAD = 60;     // start warming the next episode this many seconds before the end

export default function Watch() {
  const { t } = useI18n();
  const { type, id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const hlsRef = useRef(null);
  const hideTimer = useRef(null);
  const clickTimerRef = useRef(null);                   // disambiguate single click (play) vs double click (fullscreen)
  const progressSaveRef = useRef(null);
  const reconnectRef = useRef(null);                    // watchdog → re-establish the current stream
  const stallRef = useRef({ t: 0, ticks: 0, retries: 0 }); // progress tracking for the stall watchdog
  const waitTimerRef = useRef(null);                    // debounce for the buffering spinner
  const prefetchRef = useRef(null);                     // index of the episode we've already warmed
  const transcodeRef = useRef(false);                   // true when VOD plays via the ffmpeg HLS pipeline
  const vodDurationRef = useRef(0);                     // real (ffprobe) duration for transcoded VOD timeline
  const baseOffsetRef = useRef(0);                      // transcode start offset → absolute time = base + video.currentTime
  const seekTranscodeRef = useRef(null);               // restart the transcode at an absolute time (seek-on-demand)
  const subPollRef = useRef(null);                       // poll: refresh subtitles when transcode finishes
  const activeTextRef = useRef(-1);                     // mirror of activeText for stable closures

  // content
  const [detail, setDetail] = useState(null);          // movie/live/series base
  const [seasons, setSeasons] = useState(null);        // {seasonKey: [eps]}
  const [flat, setFlat] = useState([]);                // [{season, idx, ep}]
  const [current, setCurrent] = useState(0);           // index into flat
  const [seasonView, setSeasonView] = useState(null);  // season shown in episodes panel

  // playback
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [showUI, setShowUI] = useState(true);
  const [status, setStatus] = useState(t('Caricamento…'));
  const [error, setError] = useState('');

  // tracks / panels
  const [textTracks, setTextTracks] = useState([]);
  const [audioTracks, setAudioTracks] = useState([]);
  const [activeText, setActiveText] = useState(-1);
  const [activeAudio, setActiveAudio] = useState(0);
  const [panel, setPanel] = useState(null); // 'episodes' | 'settings' | null

  const isSeries = type === 'series';
  const isLive = type === 'live';

  // ---------- load content ----------
  useEffect(() => {
    let alive = true;
    api.detail(isSeries ? 'series' : type, id).then((d) => {
      if (!alive) return;
      setDetail(d);
      if (d.seasons) {
        setSeasons(d.seasons);
        const keys = Object.keys(d.seasons).sort((a, b) => Number(a) - Number(b));
        const list = [];
        keys.forEach((k) => (d.seasons[k] || []).forEach((ep, idx) =>
          list.push({ season: k, idxInSeason: idx, ep })));
        setFlat(list);
        const qs = params.get('s');
        const qei = parseInt(params.get('ei'), 10);
        let start = 0;
        if (qs != null && !isNaN(qei)) {
          const found = list.findIndex((x) => x.season === qs && x.idxInSeason === qei);
          if (found >= 0) start = found;
        }
        setCurrent(start);
        setSeasonView(list[start]?.season || keys[0]);
      }
    }).catch(() => setError(t('Impossibile caricare questo titolo.')));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  // ---------- resolve current source ----------
  const source = useMemo(() => {
    if (isLive) return { streamType: 'live', streamId: id, ext: 'ts', title: detail?.name || '' };
    if (type === 'movie') {
      if (!detail) return null;
      return { streamType: 'movie', streamId: id, ext: detail.container_extension || 'mp4', title: detail.name };
    }
    // series
    if (!flat.length) return null;
    const node = flat[current];
    if (!node) return null;
    const ep = node.ep;
    return {
      streamType: 'series',
      streamId: ep.id,
      ext: ep.container_extension || 'mp4',
      title: `${detail?.name || ''}  ·  S${node.season}:E${ep.episode_num}${ep.title ? ' · ' + ep.title : ''}`,
      seriesId: id,                 // parent, so Continue Watching can resolve the series
      season: node.season,
      epIndex: node.idxInSeason,
    };
  }, [isLive, type, id, detail, flat, current]);

  const sourceKey = source ? `${source.streamType}:${source.streamId}:${source.ext}` : null;

  // ---------- set up media element on source change ----------
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    let destroyed = false;
    const url = streamUrl(source.streamType, source.streamId, source.ext);
    setError('');
    setStatus(t('Caricamento…'));
    stallRef.current = { t: 0, ticks: 0, retries: 0 };

    // MKV/AVI/etc. can't be demuxed by the browser — route them through the server
    // ffmpeg HLS pipeline so they play and expose audio-track (language) switching.
    const ext = (source.ext || '').toLowerCase();
    const useTranscode = !isLive && !['mp4', 'm4v'].includes(ext);
    // map a language code to a localized name (via i18n); falls back to the code
    const lang = (code) => {
      const it = { ita: 'Italiano', eng: 'Inglese', spa: 'Spagnolo', fre: 'Francese', fra: 'Francese',
        ger: 'Tedesco', deu: 'Tedesco', por: 'Portoghese', rus: 'Russo', jpn: 'Giapponese', und: '' }[(code || '').toLowerCase()];
      return it != null ? t(it) : (code || '');
    };

    const readTracks = () => {
      const tt = video.textTracks ? Array.from(video.textTracks) : [];
      setTextTracks(tt.map((tk, i) => ({ i, label: tk.label || lang(tk.language) || t('Sottotitolo {n}', { n: i + 1 }) })));
      const hls = hlsRef.current;
      if (transcodeRef.current && hls && hls.audioTracks && hls.audioTracks.length) {
        setAudioTracks(hls.audioTracks.map((tk, i) => ({ i, label: lang(tk.lang) || t('Audio {n}', { n: i + 1 }) })));
        setActiveAudio(hls.audioTrack >= 0 ? hls.audioTrack : 0);
      } else {
        const at = video.audioTracks ? Array.from(video.audioTracks) : [];
        setAudioTracks(at.map((tk, i) => ({ i, label: tk.label || lang(tk.language) || t('Audio {n}', { n: i + 1 }) })));
        const en = at.findIndex((tk) => tk.enabled);
        setActiveAudio(en >= 0 ? en : 0);
      }
    };

    const getResume = async (resumeOverride) => {
      if (resumeOverride != null) return resumeOverride;
      try {
        const rows = await api.getProgress();
        const p = rows.find((r) => r.key === `${source.streamType}:${source.streamId}`);
        if (p && p.position) return p.position;
      } catch {}
      return 0;
    };

    // VOD path A: native progressive playback over our range-proxied URL.
    const startVodNative = async (resumeOverride) => {
      const resumeAt = await getResume(resumeOverride);
      if (destroyed) return;
      transcodeRef.current = false;
      vodDurationRef.current = 0;
      video.src = url;
      video.load();
      const onMeta = () => {
        readTracks();
        if (resumeAt > 5 && resumeAt < (video.duration || Infinity) - 5) video.currentTime = resumeAt;
        video.play().catch(() => {});
      };
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.textTracks && (video.textTracks.onaddtrack = readTracks);
    };

    // VOD path B: server-side HLS transcode (plays MKV/AVI + multi-audio + subtitles).
    const removeTracks = () => Array.from(video.querySelectorAll('track')).forEach((t) => t.remove());
    const addSubtitleTracks = (subs) => {
      removeTracks();
      subs.forEach((s, i) => {
        const tr = document.createElement('track');
        tr.kind = 'subtitles';
        tr.src = hlsVodFile(source.streamType, source.streamId, s.file, source.ext);
        tr.label = s.name && !/^[a-z]{2,3}$/i.test(s.name) ? s.name : (lang(s.lang || s.name) || `Sottotitolo ${i + 1}`);
        if (s.lang) tr.srclang = s.lang;
        video.appendChild(tr);
      });
      readTracks();
    };

    let subsLoaded = false; // load subtitle sidecars once (they don't change across seeks)
    const loadSubs = async () => {
      if (subsLoaded) return;
      subsLoaded = true;
      try {
        const t = await hlsVodTracks(source.streamType, source.streamId, source.ext);
        vodDurationRef.current = t.duration || 0;
        if (t.duration && !destroyed) setDuration(t.duration);
        if (destroyed) return;
        addSubtitleTracks(t.subs || []);
        clearInterval(subPollRef.current);
        if ((t.subs || []).length) {
          subPollRef.current = setInterval(async () => {
            try {
              const t2 = await hlsVodTracks(source.streamType, source.streamId, source.ext);
              if (!t2.done || destroyed) return;
              clearInterval(subPollRef.current);
              const active = activeTextRef.current;
              addSubtitleTracks(t2.subs || []);
              if (active >= 0 && video.textTracks[active]) {
                Array.from(video.textTracks).forEach((tt, idx) => { tt.mode = idx === active ? 'showing' : 'disabled'; });
              }
            } catch { clearInterval(subPollRef.current); }
          }, 15000);
        }
      } catch {}
    };

    // Start the transcode at absolute time `startAt` (0 / resume / seek target).
    // The HLS stream is 0-based from there; absolute time = startAt + video.currentTime.
    const startVodHls = async (startAt) => {
      if (startAt == null) startAt = await getResume();
      if (destroyed) return;
      transcodeRef.current = true;
      baseOffsetRef.current = Math.max(0, Math.floor(startAt || 0));
      const master = hlsVodMaster(source.streamType, source.streamId, source.ext, baseOffsetRef.current);
      loadSubs(); // fire-and-forget; doesn't depend on the offset

      const onReady = () => { readTracks(); video.play().catch(() => {}); };
      if (video.canPlayType('application/vnd.apple.mpegurl') && !Hls.isSupported()) {
        video.src = master; // Safari native HLS
        video.addEventListener('loadedmetadata', onReady, { once: true });
      } else if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, maxBufferLength: 30, maxMaxBufferLength: 60 });
        hlsRef.current = hls;
        hls.loadSource(master);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, readTracks);
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (destroyed || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); return; } catch {} }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch {} }
          setError(t('Impossibile riprodurre questo titolo (transcodifica non riuscita).'));
        });
      } else {
        setError(t('La riproduzione di questo formato non è supportata in questo browser.'));
      }
    };

    // Seek-on-demand: restart the transcode from an absolute time. Used when the
    // user seeks past what's been produced (the live HLS window can't reach it).
    seekTranscodeRef.current = (absTime) => {
      if (destroyed) return;
      setStatus(t('Caricamento…'));
      setTime(absTime);
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
      startVodHls(absTime);
    };

    const startVod = (resumeOverride) => (useTranscode ? startVodHls(resumeOverride) : startVodNative(resumeOverride));

    // HLS fallback: many Xtream providers serve live as .m3u8 (proxied so creds
    // stay server-side). Used when the browser/codec can't play the raw MPEG-TS.
    const startHls = () => {
      if (destroyed) return;
      const src = `/api/hls/live/${id}`;
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src; // Safari plays HLS natively
        video.play().catch(() => {});
      } else if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          liveDurationInfinity: true,
          // Keep a deeper buffer so transient drops don't stall playback, and
          // don't sit right on the live edge (that's what causes micro-stutter).
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          liveSyncDurationCount: 4,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (destroyed || !data.fatal) return;
          // Self-heal fatal network/media errors before giving up — hls.js can
          // resume loading or flush the decoder without a full teardown.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); return; } catch {} }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch {} }
          setError(t('Impossibile riprodurre questo canale (offline o codec non supportato).'));
        });
      } else {
        setError(t('La riproduzione live non è supportata in questo browser.'));
      }
    };

    const startMpegts = () => {
      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url },
        {
          enableWorker: true,
          // A larger stash + a forgiving latency window keep a steady buffer
          // instead of constantly racing to the live edge (the usual cause of
          // micro-stutter). We only chase latency once it drifts past ~5s, and
          // auto-clean the source buffer so long sessions don't bloat memory.
          enableStashBuffer: true,
          stashInitialSize: 384 * 1024,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 5.0,
          liveBufferLatencyMinRemain: 1.0,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
        }
      );
      playerRef.current = player;
      player.attachMediaElement(video);
      let switched = false;
      player.on(mpegts.Events.ERROR, () => {
        if (destroyed || switched) return;
        switched = true; // MPEG-TS path failed → try HLS before giving up
        try { player.destroy(); } catch {}
        playerRef.current = null;
        startHls();
      });
      player.on(mpegts.Events.MEDIA_INFO, readTracks);
      player.load();
      player.play().catch(() => {});
    };

    const startLive = () => {
      if (mpegts.getFeatureList().mseLivePlayback) startMpegts();
      else startHls();
    };

    // Tear down any live engine, then rebuild it — used to recover a live stream
    // that has stalled with an empty buffer (provider dropped the connection).
    const restartLive = () => {
      if (playerRef.current) { try { playerRef.current.destroy(); } catch {} playerRef.current = null; }
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
      if (!destroyed) startLive();
    };

    // Called by the stall watchdog (and the error handler) to re-establish the
    // stream after an upstream drop, resuming VOD at the current position.
    reconnectRef.current = () => {
      if (destroyed) return;
      setStatus(t('Riconnessione…'));
      if (isLive) { restartLive(); return; }
      if (transcodeRef.current) {
        if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
        startVodHls(baseOffsetRef.current + (video.currentTime || 0)); // absolute time
      } else {
        startVodNative(video.currentTime || 0);
      }
    };

    if (isLive) startLive();
    else startVod();

    progressSaveRef.current = () => {
      // for transcoded VOD use the real duration + absolute position (the HLS
      // stream is 0-based from baseOffset; video.duration grows / can be Infinity)
      const dur = transcodeRef.current ? vodDurationRef.current : video.duration;
      const pos = (transcodeRef.current ? baseOffsetRef.current : 0) + video.currentTime;
      if (isLive || !dur || isNaN(dur) || !isFinite(dur)) return;
      api.saveProgress({
        type: source.streamType, id: source.streamId,
        position: pos, duration: dur,
        parent: source.seriesId, season: source.season, ep_index: source.epIndex,
      }).catch(() => {});
    };
    const saver = setInterval(() => progressSaveRef.current && progressSaveRef.current(), 10000);

    return () => {
      destroyed = true;
      reconnectRef.current = null;
      seekTranscodeRef.current = null;
      clearInterval(saver);
      clearInterval(subPollRef.current);
      if (progressSaveRef.current) progressSaveRef.current();
      if (playerRef.current) { try { playerRef.current.destroy(); } catch {} playerRef.current = null; }
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
      if (transcodeRef.current) { stopHlsVod(source.streamType, source.streamId); transcodeRef.current = false; }
      Array.from(video.querySelectorAll('track')).forEach((t) => t.remove());
      if (video.textTracks) video.textTracks.onaddtrack = null;
      video.removeAttribute('src');
      try { video.load(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // ---------- media events ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // transcoded VOD plays a 0-based stream starting at baseOffset → report absolute time
    const base = () => (transcodeRef.current ? baseOffsetRef.current : 0);
    const onTime = () => setTime(base() + v.currentTime);
    // transcoded VOD: trust the real ffprobe duration, not the growing HLS playlist
    const onDur = () => setDuration(vodDurationRef.current || v.duration || 0);
    const clearWait = () => { clearTimeout(waitTimerRef.current); waitTimerRef.current = null; };
    const onPlay = () => { setPlaying(true); clearWait(); setStatus(''); };
    const onPause = () => setPlaying(false);
    // Debounce the spinner: a sub-350ms re-buffer shouldn't flash anything (Netflix
    // rides through micro-stalls invisibly). Longer waits show "Bufferizzazione…".
    const onWaiting = () => {
      clearWait();
      waitTimerRef.current = setTimeout(() => setStatus(t('Bufferizzazione…')), 350);
    };
    const onPlaying = () => { clearWait(); setStatus(''); };
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onProg = () => {
      try { if (v.buffered.length) setBuffered(base() + v.buffered.end(v.buffered.length - 1)); } catch {}
    };
    const onEnded = () => {
      if (isSeries && current < flat.length - 1) setCurrent((c) => c + 1);
    };
    const onErr = () => {
      // A transient upstream drop surfaces as a media error; for VOD, reconnect at
      // the current position a few times before showing the failure screen.
      if (!isLive && reconnectRef.current && stallRef.current.retries < MAX_VOD_RETRIES) {
        stallRef.current.retries++;
        reconnectRef.current();
        return;
      }
      setError(isLive
        ? t('Impossibile riprodurre questo canale.')
        : t('Impossibile riprodurre questo titolo. Alcuni contenitori (.mkv/.avi) richiedono la transcodifica per essere riprodotti nel browser.'));
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('durationchange', onDur);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('volumechange', onVol);
    v.addEventListener('progress', onProg);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onErr);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('durationchange', onDur);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('volumechange', onVol);
      v.removeEventListener('progress', onProg);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onErr);
      clearTimeout(waitTimerRef.current);
    };
  }, [isSeries, isLive, current, flat.length]);

  // ---------- stall watchdog: keep playback continuous (Netflix-style) ----------
  // Native <video> and the live engines will sometimes sit on an empty buffer after
  // a transient upstream drop and never resume on their own. We watch *real* progress
  // and either nudge the decoder (data is buffered) or reconnect upstream (buffer dry).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source) return;
    const tick = () => {
      if (v.paused || v.seeking || v.ended) {            // not meant to be advancing
        stallRef.current.t = v.currentTime;
        stallRef.current.ticks = 0;
        return;
      }
      if (v.currentTime > stallRef.current.t + 0.05) {   // healthy: making progress
        stallRef.current.t = v.currentTime;
        stallRef.current.ticks = 0;
        stallRef.current.retries = 0;
        return;
      }
      if (++stallRef.current.ticks < STALL_TICKS) return; // tolerate brief hiccups
      stallRef.current.ticks = 0;

      // How much is buffered ahead of the playhead?
      let aheadEnd = v.currentTime;
      try {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime + 0.25 && v.buffered.end(i) > aheadEnd) {
            aheadEnd = v.buffered.end(i);
          }
        }
      } catch {}

      if (aheadEnd - v.currentTime > NUDGE_AHEAD) {
        // Data is there but the decoder is wedged — a tiny seek unsticks it.
        try { v.currentTime = Math.min(aheadEnd - 0.05, v.currentTime + 0.1); } catch {}
        v.play().catch(() => {});
      } else if (isLive) {
        // Live: keep trying forever — a channel can come back at any time.
        stallRef.current.retries++;
        reconnectRef.current && reconnectRef.current();
      } else if (stallRef.current.retries < MAX_VOD_RETRIES) {
        stallRef.current.retries++;
        reconnectRef.current && reconnectRef.current();
      } else {
        setError(t('Riproduzione interrotta: connessione instabile o sorgente non disponibile.'));
      }
    };
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, isLive]);

  // ---------- preload the next episode (Netflix-style) ----------
  // A small range request near the end primes both our proxy and the provider, so
  // the next episode starts instantly instead of cold-buffering.
  useEffect(() => {
    if (!isSeries || !duration || time < duration - PREFETCH_LEAD) return;
    if (prefetchRef.current === current) return;          // already warmed for this episode
    const next = flat[current + 1];
    if (!next) return;
    prefetchRef.current = current;
    const url = streamUrl('series', next.ep.id, next.ep.container_extension || 'mp4');
    fetch(url, { headers: { Range: 'bytes=0-524287' } }).catch(() => {});
  }, [isSeries, duration, time, current, flat]);

  useEffect(() => { activeTextRef.current = activeText; }, [activeText]);

  // ---------- controls ----------
  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);
  // seek takes an ABSOLUTE time. For transcoded VOD the HLS stream is 0-based from
  // baseOffset: seek locally if the target is within what's been produced, else
  // restart the transcode from there (seek-on-demand).
  const seek = (val) => {
    const v = videoRef.current; if (!v) return;
    if (transcodeRef.current) {
      const rel = val - baseOffsetRef.current;
      const end = (() => { try { return v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch { return 0; } })();
      if (rel >= 0 && rel <= end + 0.5) { v.currentTime = rel; setTime(val); }
      else if (seekTranscodeRef.current) seekTranscodeRef.current(Math.max(0, val));
      return;
    }
    v.currentTime = val; setTime(val);
  };
  const skip = useCallback((s) => {
    const v = videoRef.current; if (!v) return;
    const base = transcodeRef.current ? baseOffsetRef.current : 0;
    const dur = (transcodeRef.current ? vodDurationRef.current : v.duration) || 0;
    seek(Math.max(0, Math.min(dur || Infinity, base + v.currentTime + s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeVol = (val) => { const v = videoRef.current; if (v) { v.volume = val; v.muted = val === 0; } };
  const toggleMute = () => { const v = videoRef.current; if (v) v.muted = !v.muted; };
  const toggleFs = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  };
  const goEpisode = (flatIndex) => { if (flatIndex >= 0 && flatIndex < flat.length) { setCurrent(flatIndex); setPanel(null); } };
  const nextEp = () => isSeries && goEpisode(current + 1);
  const prevEp = () => isSeries && goEpisode(current - 1);

  const selectText = (i) => {
    const v = videoRef.current; if (!v?.textTracks) return;
    Array.from(v.textTracks).forEach((t, idx) => { t.mode = idx === i ? 'showing' : 'disabled'; });
    activeTextRef.current = i;
    setActiveText(i);
  };
  const selectAudio = (i) => {
    const v = videoRef.current; if (!v) return;
    // transcoded VOD switches audio through hls.js; native files use audioTracks
    if (transcodeRef.current && hlsRef.current) {
      hlsRef.current.audioTrack = i;
    } else if (v.audioTracks) {
      Array.from(v.audioTracks).forEach((t, idx) => { t.enabled = idx === i; });
    }
    setActiveAudio(i);
  };

  // ---------- fullscreen + ui autohide + keyboard ----------
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const poke = useCallback(() => {
    setShowUI(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!videoRef.current?.paused) { setShowUI(false); setPanel(null); } }, 3200);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      poke();
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': case 'j': skip(-10); break;
        case 'ArrowRight': case 'l': skip(10); break;
        case 'ArrowUp': changeVol(Math.min(1, (videoRef.current?.volume || 0) + 0.1)); break;
        case 'ArrowDown': changeVol(Math.max(0, (videoRef.current?.volume || 0) - 0.1)); break;
        case 'f': toggleFs(); break;
        case 'm': toggleMute(); break;
        case 'n': nextEp(); break;
        case 'p': prevEp(); break;
        case 'Escape': if (!document.fullscreenElement) navigate(-1); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poke, togglePlay, skip, current, flat.length]);

  const showNext = isSeries && current < flat.length - 1 && duration > 0 && time > duration - 45;
  const epList = seasons && seasonView ? seasons[seasonView] || [] : [];
  const seasonKeys = seasons ? Object.keys(seasons).sort((a, b) => Number(a) - Number(b)) : [];
  const flatIndexOf = (seasonKey, idx) => flat.findIndex((x) => x.season === seasonKey && x.idxInSeason === idx);

  return (
    <div
      className={'watch' + (showUI ? ' ui' : ' no-cursor')}
      ref={containerRef}
      onMouseMove={poke}
      onTouchStart={poke}
      onClick={(e) => {
        poke();
        if (e.target !== videoRef.current) return; // let control buttons handle their own clicks
        const wasVisible = showUI;
        // Defer the play toggle so a double click (→ fullscreen) can cancel it,
        // and only toggle play when the controls were already visible (first tap reveals them).
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = setTimeout(() => { if (wasVisible) togglePlay(); }, 240);
      }}
      onDoubleClick={(e) => {
        if (e.target !== videoRef.current) return;
        clearTimeout(clickTimerRef.current); // cancel the pending single-click play toggle
        toggleFs();
      }}
    >
      <video ref={videoRef} playsInline autoPlay />

      {status && !error && <div className="watch-status"><div className="spinner" /></div>}

      {/* top bar */}
      <div className={'pl-top' + (showUI ? '' : ' hidden')}>
        <button className="pl-iconbtn" onClick={() => navigate(-1)} aria-label={t("Indietro")}><Icon name="back" size={26} /></button>
        <div className="pl-title">{source?.title || detail?.name || ''}</div>
      </div>

      {/* top-right info card (Netflix/Prime style; fades with the controls) */}
      {!error && detail && (
        <div className={'pl-info' + (showUI ? '' : ' hidden')}>
          {detail.icon && <img className="pl-info-poster" src={detail.icon} alt="" />}
          <div className="pl-info-meta">
            <h3>{detail.name}</h3>
            <div className="pl-info-sub">
              {detail.year && <span>{detail.year}</span>}
              {detail.rating > 0 && <span>★ {Number(detail.rating).toFixed(1)}</span>}
              {detail.duration && <span>{detail.duration}</span>}
              {detail.genre && <span className="pl-info-genre">{detail.genre}</span>}
            </div>
            {detail.plot && <p>{detail.plot}</p>}
          </div>
        </div>
      )}

      {/* center cluster */}
      {!error && (
        <div className={'pl-center' + (showUI ? '' : ' hidden')}>
          {isSeries && <button className="pl-bigbtn" onClick={prevEp} disabled={current === 0} title={t("Episodio precedente (p)")}><Icon name="prev" size={26} /></button>}
          <button className="pl-bigbtn" onClick={() => skip(-10)} title={t("Indietro 10s (←)")}><Icon name="back10" size={28} /><span>10</span></button>
          <button className="pl-bigbtn play" onClick={togglePlay} title={t("Riproduci/Pausa (spazio)")}><Icon name={playing ? 'pause' : 'play'} size={34} /></button>
          <button className="pl-bigbtn" onClick={() => skip(10)} title={t("Avanti 10s (→)")}><Icon name="forward10" size={28} /><span>10</span></button>
          {isSeries && <button className="pl-bigbtn" onClick={nextEp} disabled={current >= flat.length - 1} title={t("Episodio successivo (n)")}><Icon name="next" size={26} /></button>}
        </div>
      )}

      {/* next-episode prompt */}
      {showNext && (
        <button className="pl-next-prompt" onClick={nextEp}><Icon name="play" size={16} /> {t("Episodio successivo")}</button>
      )}

      {/* bottom controls */}
      {!isLive && (
        <div className={'pl-bottom' + (showUI ? '' : ' hidden')}>
          <div className="pl-seek">
            <div className="pl-seek-rail" />
            <div className="pl-seek-buffer" style={{ width: duration ? (buffered / duration) * 100 + '%' : 0 }} />
            <div className="pl-seek-played" style={{ width: duration ? (time / duration) * 100 + '%' : 0 }} />
            <input
              type="range" min={0} max={duration || 0} step="0.1" value={time}
              onChange={(e) => seek(parseFloat(e.target.value))} aria-label="Seek"
            />
          </div>
          <div className="pl-controls">
            <button className="pl-iconbtn" onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
            <button className="pl-iconbtn pl-skip" onClick={() => skip(-10)} title={t("Indietro 10s")}><Icon name="back10" size={20} /></button>
            <button className="pl-iconbtn pl-skip" onClick={() => skip(10)} title={t("Avanti 10s")}><Icon name="forward10" size={20} /></button>
            <div className="pl-vol">
              <button className="pl-iconbtn" onClick={toggleMute}><Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={20} /></button>
              <input type="range" min={0} max={1} step="0.05" value={muted ? 0 : volume} onChange={(e) => changeVol(parseFloat(e.target.value))} aria-label="Volume" />
            </div>
            <span className="pl-time">{fmt(time)} / {fmt(duration)}</span>

            <div className="pl-spacer" />

            {isSeries && <button className="pl-iconbtn" onClick={() => setPanel(panel === 'episodes' ? null : 'episodes')} title={t("Episodi")}><Icon name="list" size={20} /> <span className="pl-label">{t("Episodi")}</span></button>}
            <button className="pl-iconbtn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title={t("Audio e sottotitoli")}><Icon name="captions" size={20} /></button>
            {isSeries && <button className="pl-iconbtn" onClick={nextEp} disabled={current >= flat.length - 1} title={t("Episodio successivo")}><Icon name="next" size={20} /></button>}
            <button className="pl-iconbtn" onClick={toggleFs} title={t("Schermo intero")}><Icon name={isFs ? 'fullscreenExit' : 'fullscreen'} size={20} /></button>
          </div>
        </div>
      )}

      {/* live: minimal bottom bar */}
      {isLive && (
        <div className={'pl-bottom live' + (showUI ? '' : ' hidden')}>
          <div className="pl-controls">
            <button className="pl-iconbtn" onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
            <div className="pl-vol">
              <button className="pl-iconbtn" onClick={toggleMute}><Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={20} /></button>
              <input type="range" min={0} max={1} step="0.05" value={muted ? 0 : volume} onChange={(e) => changeVol(parseFloat(e.target.value))} />
            </div>
            <span className="pl-live-badge"><i className="live-dot" /> LIVE</span>
            <div className="pl-spacer" />
            <button className="pl-iconbtn" onClick={toggleFs}><Icon name={isFs ? 'fullscreenExit' : 'fullscreen'} size={20} /></button>
          </div>
        </div>
      )}

      {/* Settings popover: audio + subtitles */}
      {panel === 'settings' && (
        <div className="pl-popover" onClick={(e) => e.stopPropagation()}>
          <div className="pl-pop-col">
            <h4>{t("Audio")}</h4>
            {audioTracks.length ? audioTracks.map((t) => (
              <button key={t.i} className={activeAudio === t.i ? 'on' : ''} onClick={() => selectAudio(t.i)}>{t.label}</button>
            )) : <span className="pl-pop-empty">{t("Traccia unica")}</span>}
          </div>
          <div className="pl-pop-col">
            <h4>{t("Sottotitoli")}</h4>
            <button className={activeText === -1 ? 'on' : ''} onClick={() => selectText(-1)}>{t("Disattivati")}</button>
            {textTracks.length ? textTracks.map((t) => (
              <button key={t.i} className={activeText === t.i ? 'on' : ''} onClick={() => selectText(t.i)}>{t.label}</button>
            )) : <span className="pl-pop-empty">{t("Nessuno disponibile")}</span>}
          </div>
        </div>
      )}

      {/* Episodes panel */}
      {panel === 'episodes' && isSeries && (
        <div className="pl-episodes" onClick={(e) => e.stopPropagation()}>
          <div className="pl-ep-head">
            <h3>{t("Episodi")}</h3>
            <select className="select" value={seasonView || ''} onChange={(e) => setSeasonView(e.target.value)}>
              {seasonKeys.map((s) => <option key={s} value={s}>{t("Stagione {n}", { n: s })}</option>)}
            </select>
            <button className="pl-iconbtn" onClick={() => setPanel(null)}><Icon name="close" size={20} /></button>
          </div>
          <div className="pl-ep-list">
            {epList.map((ep, idx) => {
              const fi = flatIndexOf(seasonView, idx);
              const isCur = fi === current;
              return (
                <div key={ep.id} className={'pl-ep' + (isCur ? ' current' : '')} onClick={() => goEpisode(fi)}>
                  <div className="pl-ep-num">{ep.episode_num}</div>
                  {ep.still ? <img src={ep.still} alt="" loading="lazy" /> : <div className="pl-ep-still" />}
                  <div className="pl-ep-info">
                    <h4>{ep.title}{isCur ? <Icon name="play" size={12} className="pl-ep-cur" /> : ''}</h4>
                    {ep.plot && <p>{ep.plot}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="watch-error">
          <div className="box">
            <h3 style={{ marginTop: 0 }}>{t("Problema di riproduzione")}</h3>
            <p style={{ color: '#bbb' }}>{error}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {isSeries && current < flat.length - 1 && <button className="btn btn-info" onClick={nextEp}>{t("Vai al prossimo")}</button>}
              <button className="btn btn-red" onClick={() => navigate(-1)}>{t("Torna indietro")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
