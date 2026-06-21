import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useUI } from '../App.jsx';
import { useI18n } from '../i18n.js';
import Card from '../components/Card.jsx';
import Loader from '../components/Loader.jsx';
import CategoryModal from '../components/CategoryModal.jsx';
import Icon from '../components/Icons.jsx';

const TITLES = { movie: 'Film', series: 'Serie TV', live: 'Live TV' };
const PAGE = 60;

export default function Browse({ type }) {
  const { openDetail } = useUI();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [cats, setCats] = useState([]);
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState(type === 'live' ? 'name' : 'added');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCats, setShowCats] = useState(false);

  useEffect(() => {
    api.categories(type).then(setCats).catch(() => setCats([]));
  }, [type]);

  const load = useCallback(async (reset) => {
    setLoading(true);
    const offset = reset ? 0 : items.length;
    try {
      const res = await api.content({ type, category, sort, limit: PAGE, offset });
      setTotal(res.total);
      setItems(reset ? res.items : [...items, ...res.items]);
    } catch {
      if (reset) { setItems([]); setTotal(0); }
    } finally {
      setLoading(false);
    }
  }, [type, category, sort, items]);

  // reload on filter change (text search lives only in the global navbar search)
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, category, sort]);

  const onItem = (item) => {
    if (type === 'live') navigate(`/watch/${type}/${item.id}`);
    else openDetail(type, item.id);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t(TITLES[type])}</h1>
        {type !== 'live' && (
          <div className="toolbar">
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="added">{t('Aggiunti di recente')}</option>
              <option value="name">{t('A → Z')}</option>
              <option value="rating">{t('Più votati')}</option>
            </select>
          </div>
        )}
      </div>

      <div className="chips" style={{ marginBottom: 22 }}>
        <button className="chip chip-cats" onClick={() => setShowCats(true)}>
          <Icon name="search" size={14} /> {category ? (cats.find((c) => c.category_id === category)?.name || t('Categoria')) : t('Categorie')}
        </button>
        <button className={'chip' + (category === '' ? ' active' : '')} onClick={() => setCategory('')}>{t('Tutti')}</button>
        {cats.map((c) => (
          <button key={c.category_id} className={'chip' + (category === c.category_id ? ' active' : '')} onClick={() => setCategory(c.category_id)}>
            {c.name} <span style={{ opacity: .5 }}>({c.count})</span>
          </button>
        ))}
      </div>

      {items.length === 0 && !loading ? (
        <div className="empty">{t('Ancora niente qui.')}</div>
      ) : (
        <div className={'grid' + (type === 'live' ? ' live' : '')}>
          {items.map((it) => (
            <Card key={it.type + it.id} item={it} poster={type !== 'live'} onClick={onItem} />
          ))}
        </div>
      )}

      {loading && <div style={{ padding: 40 }}><Loader label="Caricamento…" /></div>}
      {!loading && items.length < total && (
        <button className="btn btn-info load-more" onClick={() => load(false)}>Carica altri ({items.length}/{total})</button>
      )}

      {showCats && (
        <CategoryModal
          categories={cats}
          current={category}
          onSelect={setCategory}
          onClose={() => setShowCats(false)}
          title={`Categorie · ${TITLES[type]}`}
        />
      )}
    </div>
  );
}
