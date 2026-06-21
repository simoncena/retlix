import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Icon from '../components/Icons.jsx';

export default function Settings() {
  const { status, refreshStatus } = useUI();
  const { t, lang, setLang, languages } = useI18n();
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
    const es = new EventSource('/api/sync' + qs);
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

  return (
    <div className="page">
      <div className="page-head"><h1>{t('Impostazioni')}</h1></div>

      <div style={{ maxWidth: 640 }}>
        <div className="setup-card" style={{ width: '100%', padding: 28, marginBottom: 18 }}>
          <h3 style={{ marginTop: 0 }}>{t('Lingua')}</h3>
          <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('Lingua')}>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>

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
              />
              <button className="btn btn-info" onClick={saveTmdb} disabled={!tmdbInput.trim()}>{t('Salva')}</button>
            </div>
            <div style={{ color: '#777', fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              {t('Chiave gratuita su themoviedb.org → Impostazioni → API. I metadati del provider restano nella loro lingua; con TMDB le trame e i generi vengono mostrati nella lingua scelta (e salvati in cache).')}
            </div>
          </div>
        </div>

        <div className="setup-card" style={{ width: '100%', padding: 28 }}>
          <h3 style={{ marginTop: 0 }}>{t('Provider')}</h3>
          <div className="modal-facts" style={{ marginTop: 0, fontSize: 14 }}>
            <div><b>{t('Server:')}</b> {provider?.url}</div>
            <div><b>{t('Nome utente:')}</b> {provider?.username}</div>
            <div><b>{t('Stato:')}</b> {ui.status || '—'}</div>
            <div><b>{t('Scadenza:')}</b> {exp}</div>
            <div><b>{t('Connessioni max:')}</b> {ui.max_connections || '—'}</div>
            <div><b>{t('Ultima sincronizzazione:')}</b> {lastSync}</div>
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
              <button className="btn btn-red" onClick={() => resync('deep')}><Icon name="download" size={16} /> {t('Scarica tutto in locale')}</button>
              <button className="btn btn-info" onClick={() => resync('details')}><Icon name="refresh" size={16} /> {t('Aggiorna libreria')}</button>
              <button className="btn btn-info" onClick={resetContinue}><Icon name="trash" size={16} /> {t('Azzera Continua a guardare')}</button>
              <button className="btn btn-info" onClick={disconnect}>{t('Disconnetti')}</button>
            </div>
          )}
          {!sync && (
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
