import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import { useTV } from '../hooks/useTv.js';
import Card from '../components/Card.jsx';
import Row from '../components/Row.jsx';
import Loader from '../components/Loader.jsx';
import Icon from '../components/Icons.jsx';
import Avatar from '../components/Avatar.jsx';
import SearchKeyboard from '../components/SearchKeyboard.jsx';

export default function Search() {
  const [params, setSearchParams] = useSearchParams();
  const urlQ = params.get('q') || '';
  const urlActor = params.get('actor') || '';
  const { openDetail } = useUI();
  const { t } = useI18n();
  const { isTV } = useTV();
  const navigate = useNavigate();

  const [text, setText] = useState(urlQ);
  const [suggest, setSuggest] = useState({ titles: [], actors: [] });
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const debRef = useRef(null);
  const inputRef = useRef(null);

  // autofocus only when starting a fresh search — NOT in actor mode
  useEffect(() => { if (!urlActor && !isTV) inputRef.current?.focus(); }, []);

  // Fetch is driven by the URL
  useEffect(() => {
    if (!urlActor) { setText(urlQ); return; }
    setText('');
    setSuggest({ titles: [], actors: [] });
    setResults(null);
    setLoading(true);
    let alive = true;
    api.search({ actor: urlActor })
      .then((r) => { if (alive) setResults(r); })
      .catch(() => { if (alive) setResults(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [urlQ, urlActor]);

  // Mirror typed query into URL — TV: skip URL sync (causes re-renders)
  useEffect(() => {
    if (urlActor || isTV) return;
    const q = text.trim();
    if (q === urlQ) return;
    const t = setTimeout(() => setSearchParams(q ? { q } : {}, { replace: true }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, urlActor]);

  // Instant search + suggestions while typing
  useEffect(() => {
    if (urlActor) return;
    const q = text.trim();
    clearTimeout(debRef.current);
    var minLen = 2;
    var delay = isTV ? 500 : 220;
    if (q.length < minLen) { setSuggest({ titles: [], actors: [] }); setResults(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    debRef.current = setTimeout(() => {
      // TV: only call search (not suggest separately — it's redundant)
      if (isTV) {
        api.search({ q }).then((r) => alive && setResults(r)).catch(() => alive && setResults(null)).finally(() => alive && setLoading(false));
      } else {
        api.suggest(q).then((s) => alive && setSuggest(s)).catch(() => alive && setSuggest({ titles: [], actors: [] }));
        api.search({ q }).then((r) => alive && setResults(r)).catch(() => alive && setResults(null)).finally(() => alive && setLoading(false));
      }
    }, delay);
    return () => { alive = false; clearTimeout(debRef.current); };
  }, [text, urlActor]);

  // Scroll position persistence
  const scrollKey = `search-scroll:${urlActor ? 'actor:' + urlActor : 'q:' + urlQ}`;
  const restoredRef = useRef(false);
  useEffect(() => () => { try { sessionStorage.setItem(scrollKey, String(window.scrollY)); } catch {} }, [scrollKey]);
  useEffect(() => {
    if (restoredRef.current || loading || (!results && !urlActor)) return;
    const y = parseInt(sessionStorage.getItem(scrollKey) || '0', 10);
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    restoredRef.current = true;
  }, [results, loading, urlActor, scrollKey]);

  const onItem = (item) => {
    if (item.type === 'live') navigate(`/watch/${item.type}/${item.id}`);
    else openDetail(item.type, item.id);
  };
  const pickActor = (name) => navigate('/search?actor=' + encodeURIComponent(name));
  const exitActor = () => navigate('/search' + (text ? '?q=' + encodeURIComponent(text) : ''));
  const clearAll = () => { setText(''); setResults(null); setSuggest({ titles: [], actors: [] }); navigate('/search'); if (!isTV) inputRef.current?.focus(); };

  // On-screen keyboard handlers
  const kbType = (ch) => { if (!urlActor) setText((t) => t + ch); };
  const kbBackspace = () => { if (!urlActor) setText((t) => t.slice(0, -1)); };
  const kbSpace = () => { if (!urlActor) setText((t) => t + ' '); };

  // TV: handle Down arrow to escape input, Back to go back
  const tvInputKeyDown = (e) => {
    if (!isTV) return;
    var code = e.keyCode || e.which;
    // Down arrow: blur input and focus first result
    if (code === 40) {
      e.preventDefault();
      if (inputRef.current) inputRef.current.blur();
      setTimeout(function() {
        var firstCard = document.querySelector('.tv-search-results [data-focusable]');
        if (firstCard) firstCard.focus();
      }, 100);
    }
    // Back: blur and navigate back
    if (code === 10009) {
      e.preventDefault();
      if (inputRef.current) inputRef.current.blur();
      navigate(-1);
    }
  };

  const r = results || {};
  const totalTitles = (r.movies?.length || 0) + (r.series?.length || 0) + (r.live?.length || 0);
  const hasQuery = urlActor || text.trim().length >= 2;

  // --- TV LAYOUT ---
  if (isTV) {
    return (
      <div className="page tv-search">
        {/* Search bar — big, simple */}
        <div className="tv-search-bar">
          <Icon name="search" size={32} />
          <input
            ref={inputRef}
            value={urlActor ? urlActor : text}
            readOnly={!!urlActor}
            onChange={(e) => setText(e.target.value)}
            onClick={() => { if (urlActor) clearAll(); }}
            onKeyDown={tvInputKeyDown}
            placeholder={t('Cerca film, serie, attori…')}
            data-focusable
          />
          {(text || urlActor) && (
            <button className="tv-search-clear" onClick={clearAll} data-focusable><Icon name="close" size={28} /></button>
          )}
        </div>

        {/* Results */}
        <div className="tv-search-results">
          {!hasQuery && (
            <div className="tv-search-hint">
              <Icon name="search" size={64} />
              <p>{t('Cerca tra film, serie e attori.')}</p>
              <p>{t('Premi OK per aprire la tastiera.')}</p>
            </div>
          )}

          {hasQuery && loading && !results && (
            <div style={{ padding: 60 }}><Loader label={t('Ricerca…')} /></div>
          )}

          {hasQuery && results && totalTitles === 0 && (
            <div className="empty">{t('Nessun risultato')}{urlActor ? '' : ' per "' + text.trim() + '"'}.</div>
          )}

          {urlActor && (
            <div style={{ marginBottom: 20 }}>
              <button className="btn btn-info" onClick={exitActor} data-focusable>
                <Icon name="back" size={22} /> {t('Tutti i risultati')}
              </button>
            </div>
          )}

          {r.movies && r.movies.length > 0 && (
            <Row title={t('Film')} items={r.movies} poster onItem={onItem} />
          )}
          {r.series && r.series.length > 0 && (
            <Row title={t('Serie TV')} items={r.series} poster onItem={onItem} />
          )}
          {r.live && r.live.length > 0 && (
            <Row title={t('Live TV')} items={r.live} onItem={onItem} />
          )}
        </div>
      </div>
    );
  }

  // --- DESKTOP / MOBILE LAYOUT (unchanged) ---
  const Section = ({ title, items, poster }) =>
    items && items.length ? (
      <section className="search-section">
        <h2>{title}</h2>
        <div className={'grid' + (poster ? '' : ' live')}>
          {items.map((it) => <Card key={it.type + it.id} item={it} poster={poster} onClick={onItem} />)}
        </div>
      </section>
    ) : null;

  return (
    <div className="page search-page">
      <div className="search-bar">
        <Icon name="search" size={22} />
        <input
          ref={inputRef}
          value={urlActor ? urlActor : text}
          readOnly={!!urlActor}
          onChange={(e) => setText(e.target.value)}
          onClick={() => { if (urlActor) clearAll(); }}
          placeholder={t('Cerca film, serie, attori…')}
          aria-label={t('Cerca')}
        />
        {(text || urlActor) && (
          <button className="search-clear" onClick={clearAll} aria-label="Pulisci"><Icon name="close" size={20} /></button>
        )}
      </div>

      {!urlActor && (
        <SearchKeyboard onKey={kbType} onBackspace={kbBackspace} onSpace={kbSpace} onClear={clearAll} />
      )}

      {!hasQuery ? (
        <div className="search-hint">
          <Icon name="search" size={42} />
          <p>{t('Cerca tra film, serie e attori. Inizia a digitare…')}</p>
        </div>
      ) : (
        <div className="search-layout">
          <aside className="search-side">
            {urlActor && (
              <button className="search-back" onClick={exitActor}><Icon name="back" size={18} /> {t('Tutti i risultati')}</button>
            )}
            {!urlActor && suggest.actors.length > 0 && (
              <div className="search-sug-group">
                <h3>{t('Attori')}</h3>
                <div className="search-actor-list">
                  {suggest.actors.map((a) => (
                    <button className="search-actor" key={a.name} onClick={() => pickActor(a.name)}>
                      <Avatar src={a.image} name={a.name} phClass="search-actor-ph" />
                      <span className="search-actor-name">{a.name}</span>
                      <span className="search-actor-count">{a.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!urlActor && suggest.titles.length > 0 && (
              <div className="search-sug-group search-sug-titles">
                <h3>{t('Suggerimenti')}</h3>
                {suggest.titles.map((t) => (
                  <button className="search-sug" key={t.type + t.id} onClick={() => onItem(t)}>
                    {t.icon && <img src={t.icon} alt="" loading="lazy" />}
                    <span className="search-sug-name">{t.name}{t.year ? ` (${t.year})` : ''}</span>
                  </button>
                ))}
              </div>
            )}
            {r.didYouMean && (
              <div className="search-dym">
                {t('Forse cercavi:')} <button onClick={() => setText(r.didYouMean)}>{r.didYouMean}</button>
              </div>
            )}
          </aside>

          <div className="search-results">
            {urlActor && <h1 className="search-actor-title">{t('Con {actor}', { actor: urlActor })}</h1>}
            {loading && !results && <div style={{ padding: 40 }}><Loader label={t('Ricerca…')} /></div>}
            {results && totalTitles === 0 && !r.actors?.length && (
              <div className="empty">
                {t('Nessun risultato')}{urlActor ? '' : ` ${t('per')} "${text.trim()}"`}.
                {r.didYouMean && <> {t('Forse cercavi')} <button className="linklike" onClick={() => setText(r.didYouMean)}>{r.didYouMean}</button>?</>}
              </div>
            )}
            <Section title={t('Film')} items={r.movies} poster />
            <Section title={t('Serie TV')} items={r.series} poster />
            <Section title={t('Live TV')} items={r.live} poster={false} />
          </div>
        </div>
      )}
    </div>
  );
}
