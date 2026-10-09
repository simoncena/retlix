import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { api, hlsVodMaster, getServerUrl } from '../api.js';
import { isConfigured as xtreamConfigured, liveUrl as xtreamLive, movieUrl as xtreamMovie, seriesUrl as xtreamSeries } from '../xtreamTV.js';
import { useI18n } from '../i18n.js';
import Icon from '../components/Icons.jsx';

function fmt(t) {
  if (!t || isNaN(t) || !isFinite(t)) return '0:00';
  t = Math.floor(t);
  var h = Math.floor(t / 3600);
  var m = Math.floor((t % 3600) / 60);
  var s = t % 60;
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}

function hasAVPlay() {
  try {
    return !!(window.webapis && window.webapis.avplay && typeof window.webapis.avplay.open === 'function');
  } catch(e) { return false; }
}

function parseTrackInfo(track) {
  var x = {};
  try { x = JSON.parse(track.extra_info || '{}') || {}; } catch(e) {}
  return x;
}

function normalizeLang(v) {
  return String(v || '').trim().toLowerCase().replace('_', '-');
}

function cleanSubtitleText(value) {
  var s = String(value || '');
  if (!s) return '';
  // AVPlay can return light HTML/SAMI-like markup. Keep line breaks, strip tags.
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/p\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&amp;/gi, '&');
  s = s.replace(/&lt;/gi, '<');
  s = s.replace(/&gt;/gi, '>');
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&#39;/gi, "'");
  return s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function langLabel(raw, t) {
  var v = normalizeLang(raw);
  var base = v.split('-')[0];
  var map = {
    it: 'Italiano', ita: 'Italiano', italian: 'Italiano',
    en: 'Inglese', eng: 'Inglese', english: 'Inglese',
    es: 'Spagnolo', spa: 'Spagnolo', esp: 'Spagnolo', spanish: 'Spagnolo',
    fr: 'Francese', fra: 'Francese', fre: 'Francese', french: 'Francese',
    de: 'Tedesco', deu: 'Tedesco', ger: 'Tedesco', german: 'Tedesco',
    pt: 'Portoghese', por: 'Portoghese', portuguese: 'Portoghese',
    ru: 'Russo', rus: 'Russo', russian: 'Russo',
    ja: 'Giapponese', jpn: 'Giapponese', japanese: 'Giapponese'
  };
  var key = map[v] || map[base];
  return key ? t(key) : (raw || '');
}

function mapTracks(list, t) {
  var audio = [];
  var text = [];
  for (var i = 0; i < (list || []).length; i++) {
    var tr = list[i];
    if (!tr) continue;
    var info = parseTrackInfo(tr);
    var rawLang = info.track_lang || info.language || info.lang || info.Language || '';
    var rawName = info.track_name || info.title || info.name || info.codec || '';
    var target = tr.type === 'AUDIO' ? audio : (tr.type === 'TEXT' ? text : null);
    if (!target) continue;
    var n = target.length + 1;
    var fallback = tr.type === 'AUDIO' ? t('Audio {n}').replace('{n}', n) : t('Sottotitolo {n}').replace('{n}', n);
    var label = langLabel(rawLang, t) || rawName || fallback;
    if (rawName && label !== rawName && rawName.toLowerCase().indexOf(String(rawLang).toLowerCase()) < 0) label += ' · ' + rawName;
    target.push({ index: tr.index, type: tr.type, lang: rawLang, label: label, info: info });
  }
  return { audio: audio, text: text };
}

function safeAvState(av) {
  try { return av.getState(); } catch(e) { return 'NONE'; }
}

function closeAVPlay(av) {
  if (!av) return;
  try {
    var st = safeAvState(av);
    if (st === 'PLAYING' || st === 'PAUSED' || st === 'READY') av.stop();
  } catch(e) {}
  try {
    if (safeAvState(av) !== 'NONE') av.close();
  } catch(e) {}
}

export default function WatchTV() {
  var { t } = useI18n();
  var { type, id } = useParams();
  var [params] = useSearchParams();
  var navigate = useNavigate();

  var videoRef = useRef(null);
  var containerRef = useRef(null);
  var hideTimer = useRef(null);
  var layerRef = useRef('center');
  var baseOffsetRef = useRef(0);
  var playingRef = useRef(false);
  var useAVPlayRef = useRef(false);
  var sourceRef = useRef(null);
  var tracksOpenRef = useRef(false);
  var subtitleEnabledRef = useRef(false);
  var subtitleTimerRef = useRef(null);

  var [detail, setDetail] = useState(null);
  var [seasons, setSeasons] = useState(null);
  var [flat, setFlat] = useState([]);
  var [current, setCurrent] = useState(0);

  var [playing, setPlaying] = useState(false);
  var [time, setTime] = useState(0);
  var [duration, setDuration] = useState(0);
  var [showUI, setShowUI] = useState(true);
  var [status, setStatus] = useState(t('Caricamento…'));
  var [error, setError] = useState('');
  var [liveChannels, setLiveChannels] = useState([]);
  var [audioTracks, setAudioTracks] = useState([]);
  var [subtitleTracks, setSubtitleTracks] = useState([]);
  var [selectedAudio, setSelectedAudio] = useState(null);
  var [selectedSubtitle, setSelectedSubtitle] = useState(null);
  var [tracksOpen, setTracksOpen] = useState(false);
  var [subtitleText, setSubtitleText] = useState('');

  var isSeries = type === 'series';
  var isLive = type === 'live';
  var canUseAVPlay = hasAVPlay() && xtreamConfigured();

  function setPlayingState(v) {
    playingRef.current = !!v;
    setPlaying(!!v);
  }

  useEffect(function() {
    tracksOpenRef.current = tracksOpen;
  }, [tracksOpen]);

  // Load content details
  useEffect(function() {
    var alive = true;
    api.detail(isSeries ? 'series' : type, id).then(function(d) {
      if (!alive) return;
      setDetail(d);
      if (d.seasons) {
        setSeasons(d.seasons);
        var keys = Object.keys(d.seasons).sort(function(a, b) { return Number(a) - Number(b); });
        var list = [];
        keys.forEach(function(k) {
          (d.seasons[k] || []).forEach(function(ep, idx) {
            list.push({ season: k, idxInSeason: idx, ep: ep });
          });
        });
        setFlat(list);
        var qs = params.get('s');
        var qei = parseInt(params.get('ei'), 10);
        var start = 0;
        if (qs != null && !isNaN(qei)) {
          var found = -1;
          for (var i = 0; i < list.length; i++) {
            if (list[i].season === qs && list[i].idxInSeason === qei) { found = i; break; }
          }
          if (found >= 0) start = found;
        }
        setCurrent(start);
      }
    }).catch(function() { setError(t('Impossibile caricare questo titolo.')); });
    return function() { alive = false; };
  }, [type, id]);

  // Live TV: load the complete current category so CH+/CH- can switch channels
  useEffect(function() {
    if (!isLive || !detail) { setLiveChannels([]); return; }
    var alive = true;
    var category = detail.category_id || '';
    api.content({ type: 'live', category: category, sort: 'name', limit: 10000, offset: 0 })
      .then(function(res) { if (alive) setLiveChannels((res && res.items) || []); })
      .catch(function() { if (alive) setLiveChannels([]); });
    return function() { alive = false; };
  }, [isLive, detail && detail.category_id]);

  // Resolve current source
  var source = useMemo(function() {
    if (isLive) return { streamType: 'live', streamId: id, ext: 'ts', title: (detail && detail.name) || '' };
    if (type === 'movie') {
      if (!detail) return null;
      return { streamType: 'movie', streamId: id, ext: detail.container_extension || 'mp4', title: detail.name };
    }
    if (!flat.length) return null;
    var node = flat[current];
    if (!node) return null;
    var ep = node.ep;
    return {
      streamType: 'series', streamId: ep.id,
      ext: ep.container_extension || 'mp4',
      title: ((detail && detail.name) || '') + '  ·  S' + node.season + ':E' + ep.episode_num,
      seriesId: id, season: node.season, epIndex: node.idxInSeason
    };
  }, [isLive, type, id, detail, flat, current]);

  sourceRef.current = source;
  var sourceKey = source ? source.streamType + ':' + source.streamId : null;

  function buildSourceUrl(src, directMode, resumePos) {
    if (isLive) return directMode ? xtreamLive(src.streamId) : (getServerUrl() + '/api/hls/live/' + src.streamId);
    if (directMode) {
      return src.streamType === 'movie' ? xtreamMovie(src.streamId, src.ext) : xtreamSeries(src.streamId, src.ext);
    }
    return hlsVodMaster(src.streamType, src.streamId, src.ext, resumePos || 0);
  }

  function saveProgressNow(src) {
    if (!src || isLive) return;
    var pos = 0;
    var dur = 0;
    if (useAVPlayRef.current && hasAVPlay()) {
      try {
        pos = (window.webapis.avplay.getCurrentTime() || 0) / 1000;
        dur = (window.webapis.avplay.getDuration() || 0) / 1000;
      } catch(e) { return; }
    } else {
      var v = videoRef.current;
      if (!v || !v.duration || isNaN(v.duration)) return;
      pos = baseOffsetRef.current + (v.currentTime || 0);
      dur = v.duration || 0;
    }
    if (!dur || isNaN(dur)) return;
    api.saveProgress({
      type: src.streamType, id: src.streamId,
      position: pos, duration: dur,
      parent: src.seriesId, season: src.season, ep_index: src.epIndex
    }).catch(function() {});
  }

  function getResume(src) {
    if (isLive) return Promise.resolve(0);
    return api.getProgress().then(function(rows) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].key === src.streamType + ':' + src.streamId && rows[i].position > 5) return Math.floor(rows[i].position);
      }
      return 0;
    }).catch(function() { return 0; });
  }

  function refreshAVTracks(av) {
    try {
      var mapped = mapTracks(av.getTotalTrackInfo() || [], t);
      setAudioTracks(mapped.audio);
      setSubtitleTracks(mapped.text);

      var currentInfo = [];
      try { currentInfo = av.getCurrentStreamInfo() || []; } catch(e) {}
      var curAudio = null;
      for (var i = 0; i < currentInfo.length; i++) {
        if (currentInfo[i].type === 'AUDIO') curAudio = currentInfo[i].index;
      }
      if (curAudio == null && mapped.audio.length) curAudio = mapped.audio[0].index;
      setSelectedAudio(curAudio);

      // Subtitles start disabled unless the user previously enabled them.
      var wantSubs = false;
      var savedSubLang = '';
      var savedAudioLang = '';
      try {
        wantSubs = localStorage.getItem('retlix-subtitles-enabled') === '1';
        savedSubLang = localStorage.getItem('retlix-subtitle-lang') || '';
        savedAudioLang = localStorage.getItem('retlix-audio-lang') || '';
      } catch(e) {}

      // Restore preferred audio language when present in this title.
      if (savedAudioLang && mapped.audio.length > 1) {
        for (var a = 0; a < mapped.audio.length; a++) {
          if (normalizeLang(mapped.audio[a].lang) === normalizeLang(savedAudioLang)) {
            try { av.setSelectTrack('AUDIO', mapped.audio[a].index); setSelectedAudio(mapped.audio[a].index); } catch(e) {}
            break;
          }
        }
      }

      if (wantSubs && mapped.text.length) {
        var chosen = mapped.text[0];
        if (savedSubLang) {
          for (var s = 0; s < mapped.text.length; s++) {
            if (normalizeLang(mapped.text[s].lang) === normalizeLang(savedSubLang)) { chosen = mapped.text[s]; break; }
          }
        }
        try {
          // Let Samsung AVPlay render the selected internal subtitle natively.
          // This handles both text and bitmap subtitle tracks on older TVs.
          av.setSelectTrack('TEXT', chosen.index);
          av.setSilentSubtitle(false);
          try { av.setSubtitlePosition(0); } catch(x) {}
          subtitleEnabledRef.current = true;
          setSelectedSubtitle(chosen.index);
          try { console.log('[Retlix AVPlay] native subtitle restored index=' + chosen.index + ' lang=' + (chosen.lang || '')); } catch(x) {}
        } catch(e) {
          subtitleEnabledRef.current = false;
          setSelectedSubtitle(null);
        }
      } else {
        try { av.setSilentSubtitle(true); } catch(e) {}
        subtitleEnabledRef.current = false;
        setSelectedSubtitle(null);
      }
      try {
        console.log('[Retlix AVPlay] tracks audio=' + mapped.audio.length + ' subtitles=' + mapped.text.length);
        for (var ti = 0; ti < mapped.text.length; ti++) {
          console.log('[Retlix AVPlay] subtitle track index=' + mapped.text[ti].index + ' lang=' + (mapped.text[ti].lang || '') + ' info=' + JSON.stringify(mapped.text[ti].info || {}));
        }
      } catch(e) {}
    } catch(e) {
      setAudioTracks([]);
      setSubtitleTracks([]);
      try { console.log('[Retlix AVPlay] track detection failed: ' + e); } catch(x) {}
    }
  }

  // Playback lifecycle: AVPlay on Samsung, HTML5 fallback elsewhere.
  useEffect(function() {
    var video = videoRef.current;
    if (!source) return;
    var alive = true;
    var saver = null;
    var watchdog = null;
    var directMode = xtreamConfigured();
    var av = hasAVPlay() && directMode ? window.webapis.avplay : null;
    useAVPlayRef.current = !!av;

    setError('');
    setStatus(t('Caricamento…'));
    setPlayingState(false);
    setTime(0);
    setDuration(0);
    setAudioTracks([]);
    setSubtitleTracks([]);
    setSelectedAudio(null);
    setSelectedSubtitle(null);
    setTracksOpen(false);
    setSubtitleText('');
    if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
    subtitleEnabledRef.current = false;

    function finishSeries() {
      if (isSeries && current < flat.length - 1) setCurrent(function(c) { return c + 1; });
    }

    function startAVPlay(resumePos) {
      var url = buildSourceUrl(source, true, resumePos);
      baseOffsetRef.current = 0;
      try {
        closeAVPlay(av);
        av.open(url);
        try { av.setDisplayRect(0, 0, 1920, 1080); } catch(e) {}
        try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch(e) {}
        try { av.setTimeoutForBuffering(20); } catch(e) {}
        try { av.setSilentSubtitle(true); } catch(e) {}

        av.setListener({
          onbufferingstart: function() { if (alive) setStatus(t('Bufferizzazione…')); },
          onbufferingprogress: function() {},
          onbufferingcomplete: function() { if (alive) setStatus(''); },
          oncurrentplaytime: function(ms) { if (alive) setTime((ms || 0) / 1000); },
          onstreamcompleted: function() {
            if (!alive) return;
            saveProgressNow(source);
            setPlayingState(false);
            finishSeries();
          },
          onerror: function(err) {
            if (!alive) return;
            try { console.log('[Retlix AVPlay] error: ' + err); } catch(e) {}
            setPlayingState(false);
            setStatus('');
            setError(t('Impossibile riprodurre questo contenuto.'));
          },
          onevent: function(eventType, eventData) {
            try { console.log('[Retlix AVPlay] event ' + eventType + ': ' + eventData); } catch(e) {}
          },
          onsubtitlechange: function(subDuration, subtitles, subType, attributes) {
            // With setSilentSubtitle(false), Samsung renders subtitles itself and
            // normally does not emit this callback. Keep a diagnostic fallback for
            // firmware that still emits text events.
            if (!alive || !subtitleEnabledRef.current) return;
            try { console.log('[Retlix AVPlay] subtitle event type=' + subType + ' duration=' + subDuration + ' text=' + String(subtitles || '').slice(0, 160)); } catch(e) {}
          },
          ondrmevent: function() {}
        });

        av.prepareAsync(function() {
          if (!alive) return;
          try { setDuration((av.getDuration() || 0) / 1000); } catch(e) {}
          function doPlay() {
            if (!alive) return;
            try {
              av.play();
              setPlayingState(true);
              setStatus('');
              setTimeout(function() { if (alive) refreshAVTracks(av); }, 350);
            } catch(e) {
              setError(t('Impossibile riprodurre questo contenuto.'));
            }
          }
          if (!isLive && resumePos > 5) {
            try { av.seekTo(Math.floor(resumePos * 1000), doPlay, doPlay); } catch(e) { doPlay(); }
          } else doPlay();
        }, function(err) {
          if (!alive) return;
          try { console.log('[Retlix AVPlay] prepare failed: ' + err); } catch(e) {}
          setStatus('');
          setError(t('Impossibile riprodurre questo contenuto.'));
        });
      } catch(e) {
        try { console.log('[Retlix AVPlay] open failed: ' + e); } catch(x) {}
        setStatus('');
        setError(t('Impossibile riprodurre questo contenuto.'));
      }
    }

    function startHTML5(resumePos) {
      if (!video) return;
      var url = buildSourceUrl(source, directMode, resumePos);
      if (isLive || directMode) baseOffsetRef.current = 0;
      else baseOffsetRef.current = resumePos || 0;

      video.src = url;
      video.load();

      if (directMode && !isLive && resumePos > 5) {
        var onMeta = function() {
          video.removeEventListener('loadedmetadata', onMeta);
          try { video.currentTime = resumePos; } catch(e) {}
        };
        video.addEventListener('loadedmetadata', onMeta);
      }

      var onCanPlay = function() {
        setStatus('');
        video.play().catch(function() {});
      };
      var onError = function() { setError(t('Impossibile riprodurre questo contenuto.')); };
      var onTime = function() { setTime(baseOffsetRef.current + (video.currentTime || 0)); };
      var onDur = function() { setDuration(video.duration || 0); };
      var onPlay = function() { setPlayingState(true); setStatus(''); };
      var onPause = function() { setPlayingState(false); };
      var onEnded = function() { finishSeries(); };

      video.addEventListener('canplay', onCanPlay);
      video.addEventListener('error', onError);
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('durationchange', onDur);
      video.addEventListener('play', onPlay);
      video.addEventListener('pause', onPause);
      video.addEventListener('ended', onEnded);

      var stallTime = 0;
      var stallTicks = 0;
      var retries = 0;
      var maxRetries = isLive ? 9999 : 10;
      watchdog = setInterval(function() {
        if (video.paused || video.ended) { stallTime = video.currentTime; stallTicks = 0; return; }
        if (video.currentTime > stallTime + 0.05) { stallTime = video.currentTime; stallTicks = 0; retries = 0; return; }
        stallTicks++;
        if (stallTicks < 6) return;
        stallTicks = 0;
        if (retries >= maxRetries) { setError(t('Connessione persa.')); return; }
        retries++;
        setStatus(t('Riconnessione…'));
        var pos = video.currentTime || 0;
        video.src = url;
        video.load();
        if (pos > 5) {
          var onSeek = function() {
            video.removeEventListener('loadedmetadata', onSeek);
            video.currentTime = pos;
            video.play().catch(function() {});
          };
          video.addEventListener('loadedmetadata', onSeek);
        }
      }, 1000);

      return function() {
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('error', onError);
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('durationchange', onDur);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('ended', onEnded);
      };
    }

    var cleanupHTML = null;
    getResume(source).then(function(resumePos) {
      if (!alive) return;
      if (av) startAVPlay(resumePos); else cleanupHTML = startHTML5(resumePos);
    });

    saver = setInterval(function() { saveProgressNow(source); }, 10000);

    return function() {
      alive = false;
      saveProgressNow(source);
      if (saver) clearInterval(saver);
      if (watchdog) clearInterval(watchdog);
      if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
      setSubtitleText('');
      if (cleanupHTML) cleanupHTML();
      if (av) closeAVPlay(av);
      if (video) {
        video.removeAttribute('src');
        try { video.load(); } catch(e) {}
      }
      useAVPlayRef.current = false;
    };
  }, [sourceKey]);

  var togglePlay = useCallback(function() {
    if (useAVPlayRef.current && hasAVPlay()) {
      var av = window.webapis.avplay;
      try {
        var st = safeAvState(av);
        if (st === 'PLAYING') { av.pause(); setPlayingState(false); }
        else if (st === 'PAUSED' || st === 'READY') { av.play(); setPlayingState(true); }
      } catch(e) {}
      return;
    }
    var v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(function() {}); else v.pause();
  }, []);

  var seekAbsolute = useCallback(function(sec) {
    if (isLive || !source) return;
    sec = Math.max(0, Math.min(duration || Infinity, Number(sec) || 0));
    if (useAVPlayRef.current && hasAVPlay()) {
      try {
        window.webapis.avplay.seekTo(Math.floor(sec * 1000), function() { setTime(sec); }, function() {});
      } catch(e) {}
      return;
    }
    var v = videoRef.current;
    if (!v) return;
    if (xtreamConfigured()) {
      try { v.currentTime = sec; setTime(sec); } catch(e) {}
    } else {
      setStatus(t('Caricamento…'));
      setTime(sec);
      baseOffsetRef.current = Math.floor(sec);
      var newUrl = hlsVodMaster(source.streamType, source.streamId, source.ext, Math.floor(sec));
      v.src = newUrl;
      v.load();
    }
  }, [source, isLive, duration]);

  var skip = useCallback(function(s) {
    if (isLive || !source) return;
    if (useAVPlayRef.current && hasAVPlay()) {
      var av = window.webapis.avplay;
      try {
        if (s > 0) av.jumpForward(Math.abs(s) * 1000, function() {
          try { setTime((av.getCurrentTime() || 0) / 1000); } catch(e) {}
        }, function() {});
        else av.jumpBackward(Math.abs(s) * 1000, function() {
          try { setTime((av.getCurrentTime() || 0) / 1000); } catch(e) {}
        }, function() {});
      } catch(e) {}
      return;
    }
    var v = videoRef.current;
    if (!v) return;
    if (xtreamConfigured()) {
      var newTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + s));
      v.currentTime = newTime;
      setTime(newTime);
    } else {
      var absTime = baseOffsetRef.current + (v.currentTime || 0) + s;
      seekAbsolute(Math.max(0, absTime));
    }
  }, [source, isLive, seekAbsolute]);

  var chooseAudio = useCallback(function(track) {
    if (!track || !hasAVPlay()) return;
    var av = window.webapis.avplay;
    function apply() {
      try {
        av.setSelectTrack('AUDIO', track.index);
        setSelectedAudio(track.index);
        try { localStorage.setItem('retlix-audio-lang', track.lang || ''); } catch(e) {}
      } catch(e) { try { console.log('[Retlix AVPlay] audio select failed: ' + e); } catch(x) {} }
    }
    try {
      var st = safeAvState(av);
      if (st === 'PAUSED') {
        av.play();
        setTimeout(function() { apply(); try { av.pause(); } catch(e) {} }, 120);
      } else apply();
    } catch(e) {}
  }, []);

  var chooseSubtitle = useCallback(function(track) {
    if (!hasAVPlay()) return;
    var av = window.webapis.avplay;

    function disableSubs() {
      try { av.setSilentSubtitle(true); } catch(e) {}
      subtitleEnabledRef.current = false;
      setSelectedSubtitle(null);
      setSubtitleText('');
      if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
      try { localStorage.setItem('retlix-subtitles-enabled', '0'); } catch(e) {}
      try { console.log('[Retlix AVPlay] subtitles disabled'); } catch(e) {}
    }

    if (!track) { disableSubs(); return; }

    function apply() {
      try {
        av.setSelectTrack('TEXT', track.index);
        // false = show subtitles with Samsung's native renderer. This is more
        // compatible than the 1.2.1 custom overlay, especially for bitmap tracks.
        av.setSilentSubtitle(false);
        try { av.setSubtitlePosition(0); } catch(e) {}
        subtitleEnabledRef.current = true;
        setSelectedSubtitle(track.index);
        setSubtitleText('');
        try {
          localStorage.setItem('retlix-subtitles-enabled', '1');
          localStorage.setItem('retlix-subtitle-lang', track.lang || '');
        } catch(e) {}
        try {
          var cur = av.getCurrentStreamInfo ? (av.getCurrentStreamInfo() || []) : [];
          console.log('[Retlix AVPlay] native subtitle selected index=' + track.index + ' lang=' + (track.lang || '') + ' current=' + JSON.stringify(cur));
        } catch(x) {}
      } catch(e) {
        try { console.log('[Retlix AVPlay] subtitle select failed: ' + e); } catch(x) {}
      }
    }

    // Some Samsung firmware only accepts track changes while PLAYING.
    try {
      var st = safeAvState(av);
      if (st === 'PAUSED') {
        av.play();
        setTimeout(function() {
          apply();
          setTimeout(function() { try { av.pause(); } catch(e) {} }, 80);
        }, 120);
      } else {
        apply();
      }
    } catch(e) {
      try { console.log('[Retlix AVPlay] subtitle state/select failed: ' + e); } catch(x) {}
    }
  }, []);

  var goBack = function() {
    if (tracksOpenRef.current) { setTracksOpen(false); return; }
    navigate(-1);
  };
  var nextEp = function() { if (isSeries && current < flat.length - 1) setCurrent(current + 1); };
  var prevEp = function() { if (isSeries && current > 0) setCurrent(current - 1); };

  var liveIndex = -1;
  if (isLive && liveChannels.length) {
    for (var lci = 0; lci < liveChannels.length; lci++) {
      if (String(liveChannels[lci].id) === String(id)) { liveIndex = lci; break; }
    }
  }

  var changeLiveChannel = useCallback(function(delta) {
    if (!isLive || !liveChannels.length) return;
    var idx = -1;
    for (var i = 0; i < liveChannels.length; i++) {
      if (String(liveChannels[i].id) === String(id)) { idx = i; break; }
    }
    if (idx < 0) idx = 0;
    var next = (idx + delta + liveChannels.length) % liveChannels.length;
    var target = liveChannels[next];
    if (!target) return;
    setShowUI(true);
    setStatus(t('Cambio canale…'));
    navigate('/watch/live/' + target.id, { replace: true });
  }, [isLive, liveChannels, id, navigate]);

  // Auto-hide UI
  var poke = useCallback(function() {
    setShowUI(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(function() {
      if (playingRef.current && !tracksOpenRef.current) setShowUI(false);
    }, 5000);
  }, []);

  function getFocusedLayer() {
    var active = document.activeElement;
    if (active && active.closest) {
      var layer = active.closest('[data-player-layer]');
      if (layer) {
        var name = layer.getAttribute('data-player-layer');
        if (name) {
          layerRef.current = name;
          return name;
        }
      }
    }
    return layerRef.current;
  }

  function focusLayer(layerName) {
    layerRef.current = layerName;
    var container = containerRef.current;
    if (!container) return;
    var layer = container.querySelector('[data-player-layer="' + layerName + '"]');
    if (!layer) return;
    var btns = layer.querySelectorAll('[data-focusable]');
    if (!btns.length) return;
    var target = null;

    // Player UX: moving DOWN from Back should land on Play/Pause in the
    // bottom-left transport cluster, not on a distant control or disabled item.
    if (layerName === 'bottom') {
      target = layer.querySelector('.pl-transport .transport-play[data-focusable]:not(:disabled)');
      if (!target) target = layer.querySelector('.pl-transport [data-focusable]:not(:disabled)');
      if (!target) target = layer.querySelector('.pl-controls [data-focusable]:not(:disabled)');
    }

    if (!target) {
      for (var i = 0; i < btns.length; i++) {
        if (!btns[i].disabled && btns[i].className && String(btns[i].className).indexOf('play') >= 0) { target = btns[i]; break; }
      }
    }
    if (!target) {
      for (var j = 0; j < btns.length; j++) {
        if (!btns[j].disabled) { target = btns[j]; break; }
      }
    }
    if (target) target.focus();
  }

  function moveFocusInLayer(dir) {
    var c = containerRef.current;
    if (!c) return false;
    var layer = c.querySelector('[data-player-layer=\"' + layerRef.current + '\"]');
    if (!layer) return false;
    var els = layer.querySelectorAll('[data-focusable]');
    var visible = [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].offsetParent !== null && !els[i].disabled) visible.push(els[i]);
    }
    var cur = document.activeElement;
    var idx = -1;
    for (var j = 0; j < visible.length; j++) if (visible[j] === cur) { idx = j; break; }
    if (idx < 0) return false;
    var next = idx + (dir === 'right' ? 1 : -1);
    if (next < 0 || next >= visible.length) return false;
    visible[next].focus();
    return true;
  }

  function focusTrackMenu() {
    setTimeout(function() {
      var c = containerRef.current;
      if (!c) return;
      var first = c.querySelector('.pl-popover [data-focusable]');
      if (first) first.focus();
    }, 80);
  }

  function toggleTracks() {
    var next = !tracksOpenRef.current;
    tracksOpenRef.current = next;
    setTracksOpen(next);
    setShowUI(true);
    if (next) focusTrackMenu();
  }

  function moveTrackFocus(code) {
    var c = containerRef.current;
    if (!c) return false;
    var currentEl = document.activeElement;
    var col = currentEl && currentEl.closest ? currentEl.closest('.pl-pop-col') : null;
    if (!col) {
      focusTrackMenu();
      return true;
    }
    var cols = c.querySelectorAll('.pl-popover .pl-pop-col');
    var colIndex = -1;
    for (var ci = 0; ci < cols.length; ci++) if (cols[ci] === col) { colIndex = ci; break; }
    var items = col.querySelectorAll('[data-focusable]');
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i] === currentEl) { idx = i; break; }
    if (idx < 0) idx = 0;
    if (code === 38 || code === 40) {
      var ni = idx + (code === 40 ? 1 : -1);
      if (ni >= 0 && ni < items.length) items[ni].focus();
      return true;
    }
    if (code === 37 || code === 39) {
      var nc = colIndex + (code === 39 ? 1 : -1);
      if (nc >= 0 && nc < cols.length) {
        var targetItems = cols[nc].querySelectorAll('[data-focusable]');
        if (targetItems.length) targetItems[Math.min(idx, targetItems.length - 1)].focus();
      }
      return true;
    }
    return false;
  }

  var layers = ['top', 'bottom'];

  useEffect(function() {
    if (!isLive) return;
    try {
      if (typeof tizen !== 'undefined' && tizen.tvinputdevice) {
        try { tizen.tvinputdevice.registerKey('ChannelUp'); } catch(e) {}
        try { tizen.tvinputdevice.registerKey('ChannelDown'); } catch(e) {}
      }
    } catch(e) {}
  }, [isLive]);

  useEffect(function() {
    var onKey = function(e) {
      var code = e.keyCode || e.which;
      poke();

      // Back: close track menu first, then leave player.
      if (code === 10009 || code === 27) {
        e.preventDefault();
        e._tvHandled = true;
        if (tracksOpenRef.current) { tracksOpenRef.current = false; setTracksOpen(false); focusLayer('bottom'); return; }
        navigate(-1);
        return;
      }

      if (isLive && (code === 427 || code === 428)) {
        e.preventDefault();
        e.stopPropagation();
        changeLiveChannel(code === 427 ? 1 : -1);
        return;
      }

      if (code === 13) {
        e.preventDefault();
        var focused = document.activeElement;
        if (focused && focused.hasAttribute && focused.hasAttribute('data-focusable') && focused.closest && focused.closest('.watch')) focused.click();
        else togglePlay();
        return;
      }

      if (code === 415 || code === 19 || code === 10252) { e.preventDefault(); togglePlay(); return; }
      if (code === 412) { e.preventDefault(); skip(-10); return; }
      if (code === 417) { e.preventDefault(); skip(10); return; }
      if (code === 32) { e.preventDefault(); togglePlay(); return; }

      if (tracksOpenRef.current && (code === 37 || code === 38 || code === 39 || code === 40)) {
        e.preventDefault();
        moveTrackFocus(code);
        return;
      }

      if (code === 38) {
        e.preventDefault();
        // Never trust only the cached layer: Samsung can move DOM focus while
        // the cache still says "bottom". Derive it from the focused element.
        var activeLayerUp = getFocusedLayer();
        var li = layers.indexOf(activeLayerUp);
        if (li > 0) focusLayer(layers[li - 1]);
        return;
      }
      if (code === 40) {
        e.preventDefault();
        var activeLayerDown = getFocusedLayer();
        var li2 = layers.indexOf(activeLayerDown);
        if (li2 < layers.length - 1) focusLayer(layers[li2 + 1]);
        return;
      }
      if (code === 37) {
        e.preventDefault();
        if (getFocusedLayer() === 'bottom') { moveFocusInLayer('left'); return; }
        skip(-10);
        return;
      }
      if (code === 39) {
        e.preventDefault();
        if (getFocusedLayer() === 'bottom') { moveFocusInLayer('right'); return; }
        skip(10);
        return;
      }
    };

    var onFocusIn = function(e) {
      var el = e && e.target;
      if (!el || !el.closest) return;
      var layer = el.closest('[data-player-layer]');
      if (!layer) return;
      var name = layer.getAttribute('data-player-layer');
      if (name) layerRef.current = name;
    };

    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKey, true);
    return function() {
      window.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [poke, togglePlay, skip, current, flat.length, isLive, changeLiveChannel, navigate]);

  useEffect(function() {
    poke();
    setTimeout(function() { focusLayer('bottom'); }, 500);
    return function() { clearTimeout(hideTimer.current); };
  }, []);

  return (
    <div className="watch" ref={containerRef} style={{cursor: showUI ? 'default' : 'none'}}>
      <object id="retlix-av-player" type="application/avplayer" className={canUseAVPlay ? 'av-player' : 'av-player hidden-player'} />
      <video ref={videoRef} playsInline autoPlay className={canUseAVPlay ? 'hidden-player' : ''} style={{width:'100%',height:'100%',background:'#000',objectFit:'contain'}} />

      {status && !error && <div className="watch-status"><div className="spinner" /></div>}

      <div className={'pl-top' + (showUI ? '' : ' hidden')} data-player-layer="top">
        <button className="pl-iconbtn" data-focusable onClick={goBack}><Icon name="back" size={26} /></button>
        <div className="pl-title">{source ? source.title : ''}</div>
      </div>


      {!isLive && (
        <div className={'pl-bottom' + (showUI ? '' : ' hidden')} data-player-layer="bottom">
          <div className="pl-seek">
            <div className="pl-seek-rail" />
            <div className="pl-seek-played" style={{width: duration ? Math.min(100, (time / duration) * 100) + '%' : 0}} />
            <input
              type="range" min={0} max={duration || 0} step="1" value={Math.min(time, duration || time)}
              onChange={function(e) { seekAbsolute(parseFloat(e.target.value)); }}
            />
          </div>
          <div className="pl-controls">
            <div className="pl-transport">
              {isSeries && <button className="pl-iconbtn transport-btn" data-focusable onClick={prevEp} disabled={current === 0} title={t('Episodio precedente')}><Icon name="prev" size={24} /></button>}
              <button className="pl-iconbtn transport-btn" data-focusable onClick={function() { skip(-10); }} title={t('Indietro 10s')}><Icon name="back10" size={26} /><span className="transport-ten">10</span></button>
              <button className="pl-iconbtn transport-btn transport-play" data-focusable onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={30} /></button>
              <button className="pl-iconbtn transport-btn" data-focusable onClick={function() { skip(10); }} title={t('Avanti 10s')}><Icon name="forward10" size={26} /><span className="transport-ten">10</span></button>
              {isSeries && <button className="pl-iconbtn transport-btn" data-focusable onClick={nextEp} disabled={current >= flat.length - 1} title={t('Episodio successivo')}><Icon name="next" size={24} /></button>}
            </div>
            <span className="pl-time">{fmt(time)} / {fmt(duration)}</span>
            <div className="pl-spacer" />
            {canUseAVPlay && (
              <button className={'pl-iconbtn pl-track-btn' + (tracksOpen ? ' active' : '')} data-focusable onClick={toggleTracks} title={t('Audio e sottotitoli')}>
                <Icon name="captions" size={22} /><span className="pl-track-label">{t('Audio e sottotitoli')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {isLive && (
        <div className={'pl-bottom live' + (showUI ? '' : ' hidden')} data-player-layer="bottom">
          <div className="pl-controls">
            <div className="pl-transport">
              <button className="pl-iconbtn transport-btn" data-focusable onClick={function() { changeLiveChannel(-1); }} disabled={liveChannels.length < 2}><Icon name="prev" size={24} /></button>
              <button className="pl-iconbtn transport-btn transport-play" data-focusable onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={30} /></button>
              <button className="pl-iconbtn transport-btn" data-focusable onClick={function() { changeLiveChannel(1); }} disabled={liveChannels.length < 2}><Icon name="next" size={24} /></button>
            </div>
            <span className="pl-live-badge"><i className="live-dot" /> LIVE</span>
            {liveIndex >= 0 && <span className="pl-live-channel"><b>{liveIndex + 1}</b> / {liveChannels.length}</span>}
            {liveChannels.length > 1 && <span className="pl-live-hint">{t('CH − / CH + cambia canale')}</span>}
            <div className="pl-spacer" />
            {canUseAVPlay && (
              <button className={'pl-iconbtn pl-track-btn' + (tracksOpen ? ' active' : '')} data-focusable onClick={toggleTracks} title={t('Audio e sottotitoli')}>
                <Icon name="captions" size={22} /><span className="pl-track-label">{t('Audio e sottotitoli')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {tracksOpen && (
        <div className="pl-popover av-track-popover">
          <div className="pl-pop-col">
            <h4>{t('Audio')}</h4>
            {audioTracks.length ? audioTracks.map(function(tr) {
              return <button key={'a' + tr.index} data-focusable className={selectedAudio === tr.index ? 'on' : ''} onClick={function() { chooseAudio(tr); }}>{tr.label}</button>;
            }) : <div className="pl-pop-empty">{t('Nessuno disponibile')}</div>}
          </div>
          <div className="pl-pop-col">
            <h4>{t('Sottotitoli')}</h4>
            <button data-focusable className={selectedSubtitle == null ? 'on' : ''} onClick={function() { chooseSubtitle(null); }}>{t('Disattivati')}</button>
            {subtitleTracks.map(function(tr) {
              return <button key={'s' + tr.index} data-focusable className={selectedSubtitle === tr.index ? 'on' : ''} onClick={function() { chooseSubtitle(tr); }}>{tr.label}</button>;
            })}
            {!subtitleTracks.length && <div className="pl-pop-empty">{t('Nessuno disponibile')}</div>}
          </div>
        </div>
      )}

      {error && (
        <div className="watch-error">
          <div className="box">
            <h3 style={{marginTop: 0}}>{t('Problema di riproduzione')}</h3>
            <p style={{color: '#bbb'}}>{error}</p>
            <button className="btn btn-red" data-focusable onClick={goBack}>{t('Torna indietro')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
