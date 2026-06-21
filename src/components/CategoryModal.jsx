import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n.js';
import Icon from './Icons.jsx';

// Full-screen, minimal Netflix-style category picker with search.
export default function CategoryModal({ categories, current, onSelect, onClose }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  const term = q.trim().toLowerCase();
  const filtered = term ? categories.filter((c) => c.name.toLowerCase().includes(term)) : categories;
  const pick = (id) => { onSelect(id); onClose(); };

  return (
    <div className="catmodal-overlay">
      <button className="catmodal-x" onClick={onClose} aria-label="Chiudi"><Icon name="close" size={26} /></button>
      <div className="catmodal-inner">
        <div className="catmodal-search">
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('Cerca categoria')}
            aria-label={t('Cerca categoria')}
          />
          {q && <button className="catmodal-clear" onClick={() => setQ('')} aria-label="Pulisci"><Icon name="close" size={18} /></button>}
        </div>
        <div className="catmodal-list">
          <button className={'catmodal-item' + (current === '' ? ' active' : '')} onClick={() => pick('')}>{t('Tutte le categorie')}</button>
          {filtered.map((c) => (
            <button
              key={c.category_id}
              className={'catmodal-item' + (current === c.category_id ? ' active' : '')}
              onClick={() => pick(c.category_id)}
            >
              {c.name}
            </button>
          ))}
          {filtered.length === 0 && <div className="catmodal-empty">{t('Nessuna categoria trovata')}</div>}
        </div>
      </div>
    </div>
  );
}
