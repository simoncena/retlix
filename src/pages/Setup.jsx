import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';

export default function Setup() {
  const { refreshStatus } = useUI();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [form, setForm] = useState({ url: '', username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState(null); // {stage, message, percent, counts}

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const startSync = () => {
    setSync({ stage: 'start', message: t('Connessione…'), percent: 0, counts: {} });
    const es = new EventSource('/api/sync');
    es.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.log !== undefined) return; // log lines are only shown in Settings
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
      await api.saveProvider(form);
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
        <div className="sub">{t('Collega la tua linea Xtream Codes per iniziare')}</div>
        {error && <div className="error-box">{error}</div>}
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
        <button className="btn btn-red" type="submit" disabled={busy}>
          {busy ? t('Connessione…') : t('Connetti e scarica la libreria')}
        </button>
      </form>
    </div>
  );
}
