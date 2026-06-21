import React from 'react';

export default function Loader({ full, label }) {
  return (
    <div className={'loader' + (full ? ' full' : '')}>
      <div className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}
