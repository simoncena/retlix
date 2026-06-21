import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.js';
import Icon from './Icons.jsx';

const TYPE_LABEL = { movie: 'Film', series: 'Serie TV', live: 'Live TV' };

export default function Hero({ item, onMore }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!item) return null;
  // Use the wide backdrop only (never a portrait poster). If it's missing/slow,
  // the .hero-bg CSS gradient shows through — we never blank it to black.
  const bg = item.backdrop || '';

  const play = () => {
    if (item.type === 'series') onMore(item);
    else navigate(`/watch/${item.type}/${item.id}`);
  };

  return (
    <div className="hero">
      <div className="hero-bg" style={bg ? { backgroundImage: `url("${bg}")` } : undefined} />
      <div className="hero-content">
        <h1 className="hero-title">{item.name}</h1>
        <div className="hero-meta">
          {item.rating > 0 && <span className="hero-badge"><Icon name="star" size={13} /> {Number(item.rating).toFixed(1)}</span>}
          {item.year && <span>{item.year}</span>}
          <span style={{ textTransform: 'capitalize' }}>{t(TYPE_LABEL[item.type] || item.type)}</span>
          {item.genre && <span>{item.genre}</span>}
        </div>
        {item.plot && <p className="hero-plot">{item.plot}</p>}
        <div className="hero-actions">
          <button className="btn btn-play" onClick={play}><Icon name="play" size={18} /> {t('Riproduci')}</button>
          <button className="btn btn-info" onClick={() => onMore(item)}><Icon name="info" size={18} /> {t('Altre info')}</button>
        </div>
      </div>
    </div>
  );
}
