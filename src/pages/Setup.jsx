import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getServerUrl } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Icon from '../components/Icons.jsx';
import {
  isConfigured as xtreamConfigured,
  saveProvider as saveXtreamProvider,
  clearProvider as clearXtreamProvider,
  xtreamApi
} from '../xtreamTV.js';

export default function Setup() {
  const { refreshStatus } = useUI();
  const { t, lang, setLang, languages } = useI18n();
  const navigate = useNavigate();
  const [mode, setMode] = useState('xtream'); // 'xtream' | 'm3u'
  const [form, setForm] = useState({ url: '', username: '', password: '', m3u_url: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sync, setSync] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const startSync = () => {
    setSync({ stage: 'start', message: t('Connessione…'), percent: 0, counts: {} });
    const es = new EventSource(getServerUrl() + '/api/sync');
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
        startSync();
        return;
      }

      var tvStandalone = false;
      try {
        tvStandalone = localStorage.getItem('retlix_tv') === '1';
      } catch (e) {}

      if (tvStandalone) {
        // Samsung TV: save Xtream credentials locally FIRST.
        // This activates apiTV and avoids the Retlix PC backend.
        saveXtreamProvider(form.url, form.username, form.password);

        try {
          // Validate credentials directly against Xtream provider.
          await xtreamApi.info();
        } catch (err) {
          clearXtreamProvider();
          throw err;
        }

        await refreshStatus();
        navigate('/');
        return;
      }

      // Web/Desktop mode still uses Retlix backend.
      await api.saveProvider({
        type: 'xtream',
        url: form.url,
        username: form.username,
        password: form.password
      });

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
          <div className="logo">RETFLIX</div>
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
        <div className="logo">RETFLIX</div>
        <div className="setup-language" data-focus-group>
          <div className="setup-language-label">{t('Idioma de la interfaz')}</div>
          <div className="language-buttons">
            {languages.map((l) => (
              <button
                key={l.code}
                type="button"
                className={'language-btn' + (lang === l.code ? ' active' : '')}
                onClick={() => setLang(l.code)}
                data-focusable
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
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
              <div className="password-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('password')}
                  value={form.password}
                  onChange={set('password')}
                  autoComplete="off"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  data-focusable
                  aria-label={showPassword ? t('Ocultar contraseña') : t('Mostrar contraseña')}
                  title={showPassword ? t('Ocultar contraseña') : t('Mostrar contraseña')}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={22} />
                </button>
              </div>
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
