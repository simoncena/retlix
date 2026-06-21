import React, { useState } from 'react';
import { useI18n } from '../i18n.js';
import Icon from './Icons.jsx';

export default function Card({ item, poster, progress, onClick, onRemove }) {
  const { t } = useI18n();
  const [err, setErr] = useState(false);
  const pct = progress && progress.duration > 0
    ? Math.min(100, (progress.position / progress.duration) * 100)
    : 0;

  // Poster cards (2:3) prefer the vertical poster; landscape cards (16:9) prefer
  // the wide backdrop — so each image fills its box with object-fit: cover
  // instead of being cropped from the wrong aspect ratio.
  const src = poster ? (item.icon || item.backdrop) : (item.backdrop || item.icon);

  return (
    <div className={'card' + (poster ? ' poster' : '')} onClick={() => onClick(item)} title={item.name}>
      {item.type === 'live' && <span className="card-badge">{t('Live')}</span>}
      {onRemove && (
        <button
          className="card-remove"
          aria-label="Rimuovi da Continua a guardare"
          onClick={(e) => { e.stopPropagation(); onRemove(item); }}
        >
          <Icon name="close" size={16} />
        </button>
      )}
      {!err && src ? (
        <img src={src} alt={item.name} loading="lazy" onError={() => setErr(true)} />
      ) : (
        <div className="card-fallback">{item.name}</div>
      )}
      <div className="card-playhint" aria-hidden><Icon name="play" size={20} /></div>
      <div className="card-hovercap">{item.name}</div>
      {pct > 0 && <div className="card-progress"><i style={{ width: pct + '%' }} /></div>}
    </div>
  );
}
