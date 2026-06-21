import React, { useState } from 'react';

// Circular avatar that falls back to the person's initial if the photo is
// missing or fails to load (some IMDb photo URLs are dead).
export default function Avatar({ src, name, imgClass, phClass }) {
  const [err, setErr] = useState(false);
  if (src && !err) {
    return <img className={imgClass} src={src} alt={name || ''} loading="lazy" onError={() => setErr(true)} />;
  }
  return <span className={phClass}>{(name || '?').charAt(0)}</span>;
}
