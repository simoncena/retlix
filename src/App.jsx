import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Navbar from './components/Navbar.jsx';
import DetailModal from './components/DetailModal.jsx';
import Loader from './components/Loader.jsx';
import Setup from './pages/Setup.jsx';
import Home from './pages/Home.jsx';
import Browse from './pages/Browse.jsx';
import Search from './pages/Search.jsx';
import Watch from './pages/Watch.jsx';
import Settings from './pages/Settings.jsx';

const UIContext = createContext(null);
export const useUI = () => useContext(UIContext);

export default function App() {
  const [status, setStatus] = useState(null); // {configured, provider, stats}
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null); // {type, id}
  const location = useLocation();

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

  const openDetail = useCallback((type, id) => setDetail({ type, id }), []);
  const closeDetail = useCallback(() => setDetail(null), []);

  if (loading) return <Loader full label="Caricamento…" />;

  const configured = status?.configured && (status?.stats?.movie + status?.stats?.series + status?.stats?.live) > 0;
  const isWatch = location.pathname.startsWith('/watch');
  const isSetup = location.pathname.startsWith('/setup');

  return (
    <UIContext.Provider value={{ status, refreshStatus, openDetail, closeDetail }}>
      {!isWatch && !isSetup && configured && <Navbar />}
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
            {/* Remount only when switching actor view (or leaving it), NOT on every
                ?q= change — the search page syncs the typed query to the URL with
                replace, so Back restores it, and a stable key keeps focus while typing. */}
            <Route path="/search" element={<Search key={'actor:' + (new URLSearchParams(location.search).get('actor') || '')} />} />
            <Route path="/watch/:type/:id" element={<Watch />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
      {detail && <DetailModal type={detail.type} id={detail.id} onClose={closeDetail} />}
    </UIContext.Provider>
  );
}
