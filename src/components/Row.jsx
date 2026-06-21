import React, { useRef } from 'react';
import Card from './Card.jsx';
import Icon from './Icons.jsx';

export default function Row({ title, items, poster, progressMap, onItem, onRemove }) {
  const trackRef = useRef(null);
  if (!items || !items.length) return null;

  const scroll = (dir) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * (el.clientWidth * 0.85), behavior: 'smooth' });
  };

  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      <div className="row-track-wrap">
        <button className="row-arrow left" onClick={() => scroll(-1)} aria-label="Scorri a sinistra"><Icon name="chevronLeft" size={28} /></button>
        <div className="row-track" ref={trackRef}>
          {items.map((it) => (
            <Card
              key={it.type + it.id}
              item={it}
              poster={poster}
              progress={progressMap && progressMap[`${it.type}:${it.id}`]}
              onClick={onItem}
              onRemove={onRemove}
            />
          ))}
        </div>
        <button className="row-arrow right" onClick={() => scroll(1)} aria-label="Scorri a destra"><Icon name="chevronRight" size={28} /></button>
      </div>
    </section>
  );
}
