import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';

export default function Setup() {
  const { refreshStatus } = useUI();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [mode, setMode] = useState('xtream'); // 'xtream' | 'm3u'
  const [form, setForm] = useState({ url: '', username: '', password: '', m3u_url: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const startSync = () => {
    setSync({ stage: 'start', message: t('Connessione…'), percent: 0, counts: {} });
    const es = new EventSource('/api/sync');
    es.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.log !== undefined) return;
      if (data.stage === 'error') {
        setError(t('Sincronizzazione fallita:') + ' ' + (data.message || t('errore sconosciuto')));
        setSync(null);
        es.close();
        return;
      }
      setSync(data);
      if (data.stage === 'complete') {
        es.close();
        setTimeout(async () => { await refreshStatus(); navigate('/'); }, 800);
      }
    };
    es.onerror = () => { es.close(); };
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'm3u') {
        await api.saveProvider({ type: 'm3u', m3u_url: form.m3u_url });
      } else {
        await api.saveProvider({ type: 'xtream', url: form.url, username: form.username, password: form.password });
      }
      startSync();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (sync) {
    const c = sync.counts || {};
    return (
      <div className="sync-screen">
        <div className="sync-box">
          <div className="logo">RETLIX</div>
          <div className="sync-stage">{sync.stage === 'complete' ? t('Fatto!') : t('Creazione della libreria…')}</div>
          <div className="sync-msg">{sync.message || ''}</div>
          <div className="progress-track"><div className="progress-fill" style={{ width: (sync.percent || 0) + '%' }} /></div>
          <div className="sync-counts">
            <div><b>{c.movie || 0}</b> {t('Film')}</div>
            <div><b>{c.series || 0}</b> {t('Serie TV')}</div>
            <div><b>{c.live || 0}</b> {t('Live')}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <form className="setup-card" onSubmit={submit}>
        <div className="logo">RETLIX</div>
        <div className="sub">{t('Collega la tua linea IPTV per iniziare')}</div>

        <div className="setup-tabs">
          <button type="button" className={`setup-tab${mode === 'xtream' ? ' active' : ''}`} onClick={() => setMode('xtream')}>
            Xtream Codes
          </button>
          <button type="button" className={`setup-tab${mode === 'm3u' ? ' active' : ''}`} onClick={() => setMode('m3u')}>
            M3U / M3U8
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {mode === 'xtream' ? (
          <>
            <div className="field">
              <label>{t('URL del server')}</label>
              <input type="text" placeholder="http://example.com:8080" value={form.url} onChange={set('url')} required />
            </div>
            <div className="field">
              <label>{t('Nome utente')}</label>
              <input type="text" placeholder={t('nome utente')} value={form.username} onChange={set('username')} autoComplete="off" required />
            </div>
            <div className="field">
              <label>{t('Password')}</label>
              <input type="password" placeholder={t('password')} value={form.password} onChange={set('password')} autoComplete="off" required />
            </div>
          </>
        ) : (
          <div className="field">
            <label>{t('URL della playlist M3U')}</label>
            <input type="url" placeholder="http://example.com/playlist.m3u8" value={form.m3u_url} onChange={set('m3u_url')} required />
            <div className="field-hint">{t('Inserisci l\'URL di una playlist M3U o M3U8')}</div>
          </div>
        )}

        <button className="btn btn-red" type="submit" disabled={busy}>
          {busy ? t('Connessione…') : t('Connetti e scarica la libreria')}
        </button>
      </form>
    </div>
  );
}
