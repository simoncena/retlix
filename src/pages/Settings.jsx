import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getServerUrl, setServerUrl } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Icon from '../components/Icons.jsx';
import { useTV, enableTV } from '../hooks/useTv.js';
import { getProvider as getXtreamProvider, saveProvider as saveXtreamProvider, clearProvider as clearXtreamProvider, isConfigured as xtreamConfigured, xtreamApi } from '../xtreamTV.js';
import { clearCache as clearXtreamCache } from '../apiTV.js';

export default function Settings() {
  const { status, refreshStatus } = useUI();
  const { t, lang, setLang, languages } = useI18n();
  const { isTV, setIsTV } = useTV();
  const [serverInput, setServerInput] = useState(getServerUrl);
  const navigate = useNavigate();
  const [sync, setSync] = useState(null);
  const [msg, setMsg] = useState('');
  const [log, setLog] = useState([]);
  const logRef = useRef(null);
  const [tmdbEnabled, setTmdbEnabled] = useState(false);
  const [tmdbInput, setTmdbInput] = useState('');

  // keep the log pinned to the newest line
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  useEffect(() => { api.getSettings().then((s) => setTmdbEnabled(!!s.tmdbEnabled)).catch(() => {}); }, []);

  const saveTmdb = async () => {
    try { const s = await api.saveSettings({ tmdbKey: tmdbInput }); setTmdbEnabled(!!s.tmdbEnabled); setTmdbInput(''); setMsg(t('Chiave TMDB salvata.')); } catch {}
  };

  const provider = status?.provider;
  const stats = status?.stats || {};
  const ui = provider?.user_info || {};
  const exp = ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toLocaleDateString() : '—';
  const lastSync = provider?.last_sync ? new Date(provider.last_sync * 1000).toLocaleString() : t('mai');

  // mode: 'deep' = provider details + IMDb photos + immagini; 'details' = solo
  // dati provider (trama/cast/regista/episodi), niente foto né immagini.
  const resync = (mode) => {
    setMsg('');
    setLog([]);
    setSync({ percent: 0, message: t('Avvio…'), counts: {} });
    const qs = mode === 'deep' ? '?deep=1' : mode === 'details' ? '?details=1' : '';
    const es = new EventSource(getServerUrl() + '/api/sync' + qs);
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      // log line: append (cap the buffer so a huge library stays responsive)
      if (d.log !== undefined) { setLog((l) => [...l, d.log].slice(-300)); return; }
      if (d.stage === 'error') { setMsg(t('Sincronizzazione fallita:') + ' ' + d.message); setSync(null); es.close(); return; }
      setSync(d);
      if (d.stage === 'complete') {
        es.close();
        refreshStatus();
        setTimeout(() => { setSync(null); setMsg(t('Libreria aggiornata.')); }, 800);
      }
    };
    es.onerror = () => es.close();
  };

  const resetContinue = async () => {
    if (!confirm(t('Azzerare la lista "Continua a guardare"?'))) return;
    await api.clearAllProgress();
    setMsg(t('"Continua a guardare" azzerato.'));
  };

  const disconnect = async () => {
    if (!confirm(t('Disconnettere questo provider ed eliminare la libreria scaricata?'))) return;
    await api.deleteProvider();
    await refreshStatus();
    navigate('/setup');
  };

  // TV standalone settings — clean, simple, big text
  if (isTV && xtreamConfigured()) {
    var xp = getXtreamProvider() || {};
    var xui = (provider && provider.user_info) || {};
    var xexp = xui.exp_date ? new Date(Number(xui.exp_date) * 1000).toLocaleDateString() : '—';
    return (
      <div className="page tv-settings">
        <h1 className="tv-settings-title">{t('Impostazioni')}</h1>

        <div className="tv-settings-section">
          <h2>{t('Idioma de la interfaz')}</h2>
          <div style={{ color: '#999', fontSize: 18, marginBottom: 16 }}>{t('Cambia el idioma de menús, botones y mensajes.')}</div>
          <div className="language-buttons" data-focus-group>
            {languages.map((l) => (
              <button
                key={l.code}
                type="button"
                className={'language-btn tv-language-btn' + (lang === l.code ? ' active' : '')}
                onClick={() => setLang(l.code)}
                data-focusable
              >{l.label}</button>
            ))}
          </div>
        </div>

        <div className="tv-settings-section">
          <h2>{t('Provider')}</h2>
          <div className="tv-settings-info">
            <div><b>{t('Server:')}</b> {xp.url}</div>
            <div><b>{t('Nome utente:')}</b> {xp.username}</div>
            {xui.status && <div><b>{t('Stato:')}</b> {xui.status}</div>}
            {xui.exp_date && <div><b>{t('Scadenza:')}</b> {xexp}</div>}
            {xui.max_connections && <div><b>{t('Connessioni max:')}</b> {xui.max_connections}</div>}
            {xui.active_cons != null && <div><b>{t('Connessioni attive:')}</b> {xui.active_cons}</div>}
          </div>
        </div>

        <div className="tv-settings-actions">
          <button className="btn btn-red tv-settings-btn" data-focusable onClick={function() {
            clearXtreamCache();
            setMsg(t('Scaricamento in corso…'));
            // Re-download all lists from provider
            var done = 0;
            var total = 3;
            function tick() { done++; setMsg(t('Scaricamento…') + ' ' + done + '/' + total); if (done >= total) setMsg('✅ ' + t('Playlist aggiornata!')); }
            api.content({ type: 'movie', category: '', sort: 'added', limit: 1, offset: 0 }).then(tick).catch(tick);
            api.content({ type: 'series', category: '', sort: 'added', limit: 1, offset: 0 }).then(tick).catch(tick);
            api.content({ type: 'live', category: '', sort: 'name', limit: 1, offset: 0 }).then(tick).catch(tick);
          }}>
            <Icon name="refresh" size={28} /> {t('Aggiorna playlist')}
          </button>

          <button className="btn btn-info tv-settings-btn" data-focusable onClick={function() {
            api.clearAllProgress();
            setMsg(t('"Continua a guardare" azzerato.'));
          }}>
            <Icon name="trash" size={28} /> {t('Azzera Continua a guardare')}
          </button>

          <button className="btn btn-info tv-settings-btn" data-focusable onClick={function() {
            clearXtreamProvider();
            clearXtreamCache();
            navigate('/setup');
          }}>
            {t('Disconnetti provider')}
          </button>
        </div>

        {msg && <div className="tv-settings-msg">{msg}</div>}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head"><h1>{t('Impostazioni')}</h1></div>

      <div style={{ maxWidth: 640 }}>
        <div className="setup-card" style={{ width: '100%', padding: 28, marginBottom: 18 }}>
          <h3 style={{ marginTop: 0 }}>{t('Idioma de la interfaz')}</h3>
          <div style={{ color: '#999', fontSize: 13, marginBottom: 12 }}>{t('Cambia el idioma de menús, botones y mensajes.')}</div>
          <div className="language-buttons" data-focus-group>
            {languages.map((l) => (
              <button
                key={l.code}
                type="button"
                className={'language-btn' + (lang === l.code ? ' active' : '')}
                onClick={() => setLang(l.code)}
                data-focusable
              >{l.label}</button>
            ))}
          </div>

          <div className="tv-toggle">
            <input
              type="checkbox" id="tv-mode" checked={isTV}
              onChange={(e) => { setIsTV(e.target.checked); enableTV(e.target.checked); }}
              data-focusable
            />
            <label htmlFor="tv-mode">{t('Modalità TV')} — {t('navigazione con telecomando (frecce + OK)')}</label>
          </div>

          <div style={{ marginTop: 24, borderTop: '1px solid #333', paddingTop: 18 }}>
            <h3 style={{ marginTop: 0 }}>{t('Connessione diretta (come IPTV Smarters)')}</h3>
            <div style={{ color: '#999', fontSize: 13, marginBottom: 12 }}>
              {xtreamConfigured() ? '✅ ' + t('Connesso — lo streaming va direttamente dal provider senza server intermedio.') : t('Collega l\'app direttamente al provider IPTV. Lo streaming va dal provider alla TV senza passare dal Mac.')}
            </div>
            <div className="field">
              <label>Server URL</label>
              <input className="input" placeholder="http://provider.com" defaultValue={(getXtreamProvider() || {}).url || ''} id="xtream-url" data-focusable />
            </div>
            <div className="field">
              <label>Username</label>
              <input className="input" placeholder="username" defaultValue={(getXtreamProvider() || {}).username || ''} id="xtream-user" data-focusable />
            </div>
            <div className="field">
              <label>Password</label>
              <input className="input" type="password" placeholder="password" defaultValue={(getXtreamProvider() || {}).password || ''} id="xtream-pass" data-focusable />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              <button className="btn btn-red" data-focusable onClick={() => {
                var u = document.getElementById('xtream-url').value;
                var un = document.getElementById('xtream-user').value;
                var pw = document.getElementById('xtream-pass').value;
                if (!u || !un || !pw) { setMsg('Compila tutti i campi.'); return; }
                saveXtreamProvider(u, un, pw);
                setMsg(t('Provider salvato! Lo streaming ora va direttamente dal provider.'));
              }}>{t('Connetti')}</button>
              {xtreamConfigured() && (
                <button className="btn btn-info" style={{ marginLeft: 12 }} data-focusable onClick={() => {
                  clearXtreamProvider();
                  setMsg(t('Connessione diretta rimossa. Usa il server Retflix.'));
                }}>{t('Disconnetti')}</button>
              )}
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <label style={{ display: 'block', fontSize: 13, color: '#bbb', marginBottom: 6 }}>
              {t('Server Retflix (per libreria e immagini)')}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input" style={{ flex: 1, minWidth: 220 }}
                placeholder="http://192.168.0.39:3000"
                value={serverInput} onChange={(e) => setServerInput(e.target.value)}
                data-focusable
              />
              <button className="btn btn-info" onClick={() => { setServerUrl(serverInput.replace(/\/+$/, '')); setMsg(t('Server salvato. Ricarica la pagina.')); }} data-focusable>{t('Salva')}</button>
            </div>
            <div style={{ color: '#777', fontSize: 12, marginTop: 6 }}>
              {t('Il server Retflix serve per la libreria, i poster e i metadati. Lo streaming va diretto dal provider se configurato sopra.')}
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <label style={{ display: 'block', fontSize: 13, color: '#bbb', marginBottom: 6 }}>
              {t('Trame e generi in altre lingue (TMDB)')}
              {tmdbEnabled && <span style={{ color: '#46d369', marginLeft: 8 }}>● {t('Attivo')}</span>}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input" style={{ flex: 1, minWidth: 220 }}
                type="password" autoComplete="off"
                placeholder={tmdbEnabled ? '••••••••  (' + t('inserisci una nuova chiave per sostituire') + ')' : t('Incolla la tua API key TMDB')}
                value={tmdbInput} onChange={(e) => setTmdbInput(e.target.value)}
                data-focusable
              />
              <button className="btn btn-info" onClick={saveTmdb} disabled={!tmdbInput.trim()} data-focusable>{t('Salva')}</button>
            </div>
            <div style={{ color: '#777', fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              {t('Chiave gratuita su themoviedb.org → Impostazioni → API. I metadati del provider restano nella loro lingua; con TMDB le trame e i generi vengono mostrati nella lingua scelta (e salvati in cache).')}
            </div>
          </div>
        </div>

        <div className="setup-card" style={{ width: '100%', padding: 28 }}>
          <h3 style={{ marginTop: 0 }}>{t('Provider')}</h3>
          <div className="modal-facts" style={{ marginTop: 0, fontSize: 14 }}>
            {provider?.type === 'm3u' ? (
              <>
                <div><b>Tipo:</b> M3U / M3U8</div>
                <div><b>URL:</b> {provider?.m3u_url}</div>
                <div><b>{t('Ultima sincronizzazione:')}</b> {lastSync}</div>
              </>
            ) : (
              <>
                <div><b>{t('Server:')}</b> {provider?.url}</div>
                <div><b>{t('Nome utente:')}</b> {provider?.username}</div>
                <div><b>{t('Stato:')}</b> {ui.status || '—'}</div>
                <div><b>{t('Scadenza:')}</b> {exp}</div>
                <div><b>{t('Connessioni max:')}</b> {ui.max_connections || '—'}</div>
                <div><b>{t('Ultima sincronizzazione:')}</b> {lastSync}</div>
              </>
            )}
          </div>

          <div className="sync-counts" style={{ justifyContent: 'flex-start', gap: 34, marginTop: 24 }}>
            <div><b>{stats.movie || 0}</b> {t('Film')}</div>
            <div><b>{stats.series || 0}</b> {t('Serie TV')}</div>
            <div><b>{stats.live || 0}</b> {t('Live')}</div>
          </div>

          {sync ? (
            <div style={{ marginTop: 24 }}>
              <div className="sync-msg">{sync.message}</div>
              <div className="progress-track"><div className="progress-fill" style={{ width: (sync.percent || 0) + '%' }} /></div>
              {sync.counts?.toEnrich > 0 && (
                <div className="sync-msg" style={{ marginTop: 8, color: '#888' }}>
                  {t('Dettagli scaricati: {a}/{b}', { a: sync.counts.enriched || 0, b: sync.counts.toEnrich })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap' }}>
              {provider?.type !== 'm3u' && (
                <>
                  <button className="btn btn-red" onClick={() => resync('deep')} data-focusable><Icon name="download" size={16} /> {t('Scarica tutto in locale')}</button>
                  <button className="btn btn-info" onClick={() => resync('details')} data-focusable><Icon name="refresh" size={16} /> {t('Aggiorna libreria')}</button>
                </>
              )}
              {provider?.type === 'm3u' && (
                <button className="btn btn-info" onClick={() => resync('details')}><Icon name="refresh" size={16} /> {t('Aggiorna playlist')}</button>
              )}
              <button className="btn btn-info" onClick={resetContinue} data-focusable><Icon name="trash" size={16} /> {t('Azzera Continua a guardare')}</button>
              <button className="btn btn-info" onClick={disconnect} data-focusable>{t('Disconnetti')}</button>
            </div>
          )}
          {!sync && provider?.type !== 'm3u' && (
            <div style={{ color: '#777', fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>
              <b>{t('Scarica tutto in locale')}</b>: {t('salva nel database trame, cast, generi, episodi, le foto del cast (IMDb) e le immagini di navigazione (poster, sfondi, locandine episodi). È il più completo ma il più lento.')}<br />
              <b>{t('Aggiorna libreria')}</b>: {t('aggiorna il catalogo e scarica in locale i dati del provider — trame, cast, regista, episodi (cercabili per attore) — senza le foto del cast e senza pre-scaricare le immagini. Molto più veloce.')}<br />
              {t('Entrambi sono incrementali: non riscaricano ciò che è già presente, quindi puoi rilanciarli per continuare e riprendono da dove erano rimasti. Le foto del cast vengono comunque salvate quando apri una scheda.')}
            </div>
          )}
          {msg && <div style={{ color: '#46d369', marginTop: 14 }}>{msg}</div>}

          {log.length > 0 && (
            <div className="sync-log-wrap">
              <div className="sync-log-head">
                <span>Log {sync ? '(in corso…)' : '(completato)'}</span>
                <span style={{ color: '#666' }}>{log.length} righe</span>
              </div>
              <div className="sync-log" ref={logRef}>
                {log.map((line, i) => (
                  <div key={i} className={line.startsWith('✗') ? 'err' : line.startsWith('✓') ? 'ok' : ''}>{line}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
