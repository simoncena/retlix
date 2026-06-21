import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Hero from '../components/Hero.jsx';
import Row from '../components/Row.jsx';
import Loader from '../components/Loader.jsx';

export default function Home() {
  const { openDetail } = useUI();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState([]);
  const [progressMap, setProgressMap] = useState({});

  const loadProgress = useCallback(async () => {
    try {
      const rows = await api.getProgress();
      setProgress(rows);
      const map = {};
      rows.forEach((r) => { map[r.key] = r; });
      setProgressMap(map);
    } catch {}
  }, []);

  useEffect(() => {
    api.home().then(setData).catch(() => setData({ hero: null, rows: [] }));
    loadProgress();
  }, [loadProgress]);

  const onItem = (item) => {
    if (item.type === 'live') navigate(`/watch/${item.type}/${item.id}`);
    else openDetail(item.type, item.id);
  };

  // Continue Watching jumps straight back into playback (movie resumes from its
  // saved position; a series resumes the exact episode it left off).
  const onContinue = (item) => {
    if (item.type === 'series' && item.resume) {
      const { season, ei } = item.resume;
      navigate(`/watch/series/${item.id}?s=${encodeURIComponent(season)}&ei=${ei}`);
    } else {
      navigate(`/watch/${item.type}/${item.id}`);
    }
  };

  // remove a single tile from "Continue Watching"
  const removeContinue = async (item) => {
    try { await api.removeContinue(item.type, item.id); } catch {}
    setData((d) => (d ? { ...d, continue: (d.continue || []).filter((x) => !(x.type === item.type && x.id === item.id)) } : d));
  };

  if (!data) return <Loader full label={t('Caricamento…')} />;

  // Continue Watching is resolved server-side, so titles found via search work too.
  const continueItems = data.continue || [];
  const recommended = data.recommended || [];

  // Merge in the per-series progress the server sends (its key is the episode id,
  // not the series id, so the card's progress bar needs this explicit mapping).
  const continueProgress = { ...progressMap };
  continueItems.forEach((it) => {
    if (it.progress) continueProgress[`${it.type}:${it.id}`] = it.progress;
  });

  return (
    <div>
      <Hero item={data.hero} onMore={(it) => openDetail(it.type, it.id)} />
      <div className="rows">
        {continueItems.length > 0 && (
          <Row title={t('Continua a guardare')} items={continueItems} poster progressMap={continueProgress} onItem={onContinue} onRemove={removeContinue} />
        )}
        {recommended.map((r, i) => (
          <Row key={'rec' + i} title={r.titleKey ? t(r.titleKey, r.titleParams) : r.title} items={r.items} poster={r.type !== 'live'} progressMap={progressMap} onItem={onItem} />
        ))}
        {(data.rows || []).map((r, i) => (
          <Row key={i} title={r.titleKey ? t(r.titleKey, r.titleParams) : r.title} items={r.items} poster={r.type !== 'live'} progressMap={progressMap} onItem={onItem} />
        ))}
        {(!data.rows || data.rows.length === 0) && (
          <div className="empty">{t('La tua libreria è vuota. Prova a ri-sincronizzare dalle Impostazioni.')}</div>
        )}
      </div>
    </div>
  );
}
