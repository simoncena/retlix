import React, { useRef } from 'react';
import { useI18n } from '../i18n.js';
import Icon from './Icons.jsx';

// Netflix-style on-screen keyboard. Keys are real <button>s so they work with a
// mouse AND a TV remote: arrow keys move focus across the grid (roving focus),
// OK/Enter activates. Letters are laid out in a fixed-column grid.
const COLS = 6;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
const KEYS = [...LETTERS, ...DIGITS];

export default function SearchKeyboard({ onKey, onBackspace, onSpace, onClear }) {
  const { t } = useI18n();
  const gridRef = useRef(null);

  // Roving D-pad navigation within the key grid.
  const onGridKeyDown = (e) => {
    const btns = Array.from(gridRef.current?.querySelectorAll('button[data-k]') || []);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'ArrowDown') next = i + COLS;
    else if (e.key === 'ArrowUp') next = i - COLS;
    else return;
    if (next >= 0 && next < btns.length) { e.preventDefault(); btns[next].focus(); }
  };

  return (
    <div className="kbd" role="group" aria-label="Tastiera">
      <div className="kbd-grid" ref={gridRef} onKeyDown={onGridKeyDown}>
        {KEYS.map((k) => (
          <button key={k} type="button" data-k className="kbd-key" onClick={() => onKey(k)}>{k}</button>
        ))}
      </div>
      <div className="kbd-actions">
        <button type="button" className="kbd-key kbd-wide" onClick={onSpace}>{t('Spazio')}</button>
        <button type="button" className="kbd-key" onClick={onBackspace} aria-label="Cancella">
          <Icon name="back" size={20} />
        </button>
        <button type="button" className="kbd-key" onClick={onClear} aria-label="Pulisci">
          <Icon name="close" size={20} />
        </button>
      </div>
    </div>
  );
}
