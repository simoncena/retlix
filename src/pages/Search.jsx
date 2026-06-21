import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Card from '../components/Card.jsx';
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
  const navigate = useNavigate();

  const [text, setText] = useState(urlQ);
  const [suggest, setSuggest] = useState({ titles: [], actors: [] });
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const debRef = useRef(null);
  const inputRef = useRef(null);

  // autofocus only when starting a fresh search — NOT in actor mode (focusing
  // there would otherwise trigger an exit and strip the ?actor= param).
  useEffect(() => { if (!urlActor) inputRef.current?.focus(); }, []);

  // Fetch is driven by the URL. Actor mode short-circuits the text search; the
  // alive guards stop a stale text-search from clobbering the actor results.
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

  // Mirror the typed query into the URL (?q=) with replace, so pressing Play and
  // then Back restores the search. Debounced + replace keeps history clean and
  // (with the key change in App.jsx) doesn't remount/steal focus while typing.
  useEffect(() => {
    if (urlActor) return;
    const q = text.trim();
    if (q === urlQ) return;
    const t = setTimeout(() => setSearchParams(q ? { q } : {}, { replace: true }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, urlActor]);

  // Instant search + suggestions while typing (non-actor mode, debounced).
  useEffect(() => {
    if (urlActor) return;
    const q = text.trim();
    clearTimeout(debRef.current);
    if (q.length < 2) { setSuggest({ titles: [], actors: [] }); setResults(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    debRef.current = setTimeout(() => {
      api.suggest(q).then((s) => alive && setSuggest(s)).catch(() => alive && setSuggest({ titles: [], actors: [] }));
      api.search({ q }).then((r) => alive && setResults(r)).catch(() => alive && setResults(null)).finally(() => alive && setLoading(false));
    }, 220);
    return () => { alive = false; clearTimeout(debRef.current); };
  }, [text, urlActor]);

  // Remember the scroll position per query, so returning from a title (Back from
  // /watch) lands you where you were, not at the top.
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
  const clearAll = () => { setText(''); setResults(null); setSuggest({ titles: [], actors: [] }); navigate('/search'); inputRef.current?.focus(); };

  // On-screen keyboard handlers (TV remote / mouse). They edit `text`, which
  // drives the same debounced search as physical typing. Disabled in actor mode.
  const kbType = (ch) => { if (!urlActor) setText((t) => t + ch); };
  const kbBackspace = () => { if (!urlActor) setText((t) => t.slice(0, -1)); };
  const kbSpace = () => { if (!urlActor) setText((t) => t + ' '); };

  const r = results || {};
  const totalTitles = (r.movies?.length || 0) + (r.series?.length || 0) + (r.live?.length || 0);
  const hasQuery = urlActor || text.trim().length >= 2;

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
      {/* search field */}
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

      {/* On-screen keyboard (Netflix-style) — for TV remotes & touch. */}
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
          {/* left: suggestions */}
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

          {/* right: results */}
          <div className="search-results">
            {urlActor && <h1 className="search-actor-title">{t('Con {actor}', { actor: urlActor })}</h1>}
            {loading && !results && <div style={{ padding: 40 }}><Loader label={t('Ricerca…')} /></div>}
            {results && totalTitles === 0 && !r.actors?.length && (
              <div className="empty">
                {t('Nessun risultato')}{urlActor ? '' : ` ${t('per')} “${text.trim()}”`}.
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
