import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Navbar from './components/Navbar.jsx';
import DetailModal from './components/DetailModal.jsx';
import Loader from './components/Loader.jsx';
import Setup from './pages/Setup.jsx';
import Home from './pages/Home.jsx';
import Browse from './pages/Browse.jsx';
import Search from './pages/Search.jsx';
import Watch from './pages/Watch.jsx';
import WatchTV from './pages/WatchTV.jsx';
import Settings from './pages/Settings.jsx';
import DetailTV from './pages/DetailTV.jsx';
import { TvContext, detectTV, useSpatialNav } from './hooks/useTv.js';
import { isConfigured as _xtreamDirect } from './xtreamTV.js';
import { useI18n } from './i18n.js';
// loadLibraryFromStorage removed — we download fresh on every startup

const UIContext = createContext(null);
export const useUI = () => useContext(UIContext);

export default function App() {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [splashDone, setSplashDone] = useState(false);
  const [splashMsg, setSplashMsg] = useState('');
  const [detail, setDetail] = useState(null);
  const [isTV, setIsTV] = useState(detectTV);
  const location = useLocation();

  useSpatialNav(isTV && splashDone);

  useEffect(() => {
    if (isTV) document.documentElement.classList.add('tv');
    else document.documentElement.classList.remove('tv');
  }, [isTV, t]);

  // TV Splash: download playlist from provider on every startup
  // Updates the HTML splash message (visible before React mounts) then hides it
  useEffect(() => {
    if (!isTV || !_xtreamDirect()) {
      setSplashDone(true);
      // Hide HTML splash immediately for non-TV or non-xtream
      var sp = document.getElementById('splash');
      if (sp) sp.style.display = 'none';
      return;
    }
    var splashEl = document.getElementById('splash');
    var msgEl = splashEl ? splashEl.querySelector('div:last-child') : null;
    function setMsg(t) { if (msgEl) msgEl.textContent = t; setSplashMsg(t); }

    var done = 0;
    function tick(label) {
      done++;
      setMsg(label + ' (' + done + '/3)');
      if (done >= 3) {
        setMsg(t('Pronto!'));
        setTimeout(function() {
          if (splashEl) { splashEl.style.transition = 'opacity 0.4s'; splashEl.style.opacity = '0'; setTimeout(function(){ splashEl.style.display = 'none'; }, 400); }
          setSplashDone(true);
        }, 300);
      }
    }
    setMsg(t('Scaricamento Film…'));
    api.content({ type: 'movie', category: '', sort: 'added', limit: 1, offset: 0 })
      .then(function() { tick(t('Film ✓')); setMsg(t('Scaricamento Serie TV…')); })
      .catch(function() { tick(t('Film')); })
      .then(function() {
        return api.content({ type: 'series', category: '', sort: 'added', limit: 1, offset: 0 });
      })
      .then(function() { tick(t('Serie TV ✓')); setMsg(t('Scaricamento Live TV…')); })
      .catch(function() { tick(t('Serie')); })
      .then(function() {
        return api.content({ type: 'live', category: '', sort: 'name', limit: 1, offset: 0 });
      })
      .then(function() { tick(t('Live TV ✓')); })
      .catch(function() { tick(t('Live')); });
  }, [isTV]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.getProvider();
      setStatus(s);
      return s;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const navigate = useNavigate();
  const openDetail = useCallback((type, id) => {
    if (isTV) navigate('/detail/' + type + '/' + id);
    else setDetail({ type, id });
  }, [isTV, navigate]);
  const closeDetail = useCallback(() => setDetail(null), []);

  // Fallback back handler — only fires if no page handler stopped propagation
  useEffect(() => {
    if (!isTV) return;
    const onBack = (e) => {
      var code = e.keyCode || e.which;
      if (code === 10009 || code === 27) {
        // If already handled by a page (Browse, Player, Detail), skip
        if (e._tvHandled) return;
        e.preventDefault();
        if (detail) { closeDetail(); return; }
        // Don't go back from Home
        if (location.pathname === '/') return;
        window.history.back();
      }
    };
    // Use bubble phase (no true) so page capture handlers fire first
    window.addEventListener('keydown', onBack);
    return () => window.removeEventListener('keydown', onBack);
  }, [isTV, detail, closeDetail, location.pathname]);

  // Wait for both: provider status loaded + TV splash done
  if (loading || (isTV && !splashDone)) return null;

  const configured = status?.configured && ((status?.stats?.movie + status?.stats?.series + status?.stats?.live) > 0 || _xtreamDirect());
  const isWatch = location.pathname.startsWith('/watch');
  const isDetail = location.pathname.startsWith('/detail');
  const isSetup = location.pathname.startsWith('/setup');

  return (
    <TvContext.Provider value={{ isTV, setIsTV }}>
      <UIContext.Provider value={{ status, refreshStatus, openDetail, closeDetail }}>
        {!isWatch && !isDetail && !isSetup && configured && <Navbar />}
        <Routes>
          <Route path="/setup" element={<Setup />} />
          {!configured ? (
            <Route path="*" element={<Navigate to="/setup" replace />} />
          ) : (
            <>
              <Route path="/" element={<Home />} />
              <Route path="/movies" element={<Browse type="movie" key="movie" />} />
              <Route path="/series" element={<Browse type="series" key="series" />} />
              <Route path="/live" element={<Browse type="live" key="live" />} />
              <Route path="/search" element={<Search key={'actor:' + (new URLSearchParams(location.search).get('actor') || '')} />} />
              <Route path="/detail/:type/:id" element={<DetailTV />} />
              <Route path="/watch/:type/:id" element={isTV ? <WatchTV /> : <Watch />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
        {detail && <DetailModal type={detail.type} id={detail.id} onClose={closeDetail} />}
      </UIContext.Provider>
    </TvContext.Provider>
  );
}
