import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { readApiError, UNIT_SUGGESTIONS, type PurchaseCategory, type PurchaseItem } from './types';
import './purchasing.css';

export default function PurchaseCatalogPage() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token],
  );
  const [categories, setCategories] = useState<PurchaseCategory[]>([]);
  const [items, setItems] = useState<PurchaseItem[]>([]);
  const [catName, setCatName] = useState('');
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState({ categoryId: '', name: '', description: '', unit: 'kg' });
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch('/api/purchasing/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.loadFail')));
      return;
    }
    const data = await res.json();
    setCategories(data.categories || []);
    setItems(data.items || []);
    setItemForm((f) => ({ ...f, categoryId: f.categoryId || data.categories?.[0]?._id || '' }));
  }, [token, t]);

  useEffect(() => { void load(); }, [load]);

  const saveCat = async () => {
    setErr('');
    const body = { name: catName, sortOrder: categories.length };
    const res = editingCat
      ? await apiFetch(`/api/purchasing/categories/${editingCat}`, { method: 'PUT', headers, body: JSON.stringify({ name: catName }) })
      : await apiFetch('/api/purchasing/categories', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    setCatName('');
    setEditingCat(null);
    await load();
  };

  const saveItem = async () => {
    setErr('');
    const body = itemForm;
    const res = editingItem
      ? await apiFetch(`/api/purchasing/items/${editingItem}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      : await apiFetch('/api/purchasing/items', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    setEditingItem(null);
    setItemForm({ categoryId: itemForm.categoryId, name: '', description: '', unit: itemForm.unit || 'kg' });
    await load();
  };

  const delCat = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/purchasing/categories/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    await load();
  };

  const delItem = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/purchasing/items/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      setErr(await readApiError(res, t('purchasing.saveFail')));
      return;
    }
    await load();
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{t('purchasing.navCatalog')}</h2>
      {err ? <div className="purch-banner">{err}</div> : null}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>{t('purchasing.categories')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input className="input" style={{ minWidth: 200 }} value={catName} onChange={(e) => setCatName(e.target.value)} placeholder={t('purchasing.categoryName')} />
          <button type="button" className="btn btn-primary" onClick={() => void saveCat()}>
            {editingCat ? t('common.save') : t('common.add')}
          </button>
          {editingCat ? (
            <button type="button" className="btn btn-outline" onClick={() => { setEditingCat(null); setCatName(''); }}>
              {t('common.cancel')}
            </button>
          ) : null}
        </div>
        {categories.map((c) => (
          <div key={c._id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            <span>{c.name}</span>
            <span>
              <button type="button" className="btn btn-ghost" onClick={() => { setEditingCat(c._id); setCatName(c.name); }}>{t('common.edit')}</button>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--red-primary)' }} onClick={() => void delCat(c._id)}>{t('common.delete')}</button>
            </span>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>{t('purchasing.items')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px', gap: 8, marginBottom: 12 }}>
          <select className="input" value={itemForm.categoryId} onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}>
            <option value="">{t('purchasing.colCategory')}</option>
            {categories.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
          <input className="input" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} placeholder={t('purchasing.itemName')} />
          <input className="input" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} placeholder={t('purchasing.itemDesc')} />
          <input className="input" list="purchase-units" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} placeholder={t('purchasing.colUnit')} />
        </div>
        <datalist id="purchase-units">
          {UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
        </datalist>
        <div style={{ marginBottom: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => void saveItem()}>
            {editingItem ? t('common.save') : t('common.add')}
          </button>
          {editingItem ? (
            <button type="button" className="btn btn-outline" style={{ marginLeft: 8 }} onClick={() => { setEditingItem(null); setItemForm({ ...itemForm, name: '', description: '' }); }}>
              {t('common.cancel')}
            </button>
          ) : null}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', background: 'var(--bg)' }}>
              <th style={{ padding: 8 }}>{t('purchasing.colCategory')}</th>
              <th style={{ padding: 8 }}>{t('purchasing.colInfo')}</th>
              <th style={{ padding: 8 }}>{t('purchasing.colUnit')}</th>
              <th style={{ padding: 8 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it._id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: 8 }}>{categories.find((c) => c._id === it.categoryId)?.name || ''}</td>
                <td style={{ padding: 8 }}>
                  <strong>{it.name}</strong>
                  {it.description ? <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{it.description}</div> : null}
                </td>
                <td style={{ padding: 8 }}>{it.unit}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>
                  <button type="button" className="btn btn-ghost" onClick={() => {
                    setEditingItem(it._id);
                    setItemForm({ categoryId: it.categoryId, name: it.name, description: it.description || '', unit: it.unit });
                  }}>{t('common.edit')}</button>
                  <button type="button" className="btn btn-ghost" style={{ color: 'var(--red-primary)' }} onClick={() => void delItem(it._id)}>{t('common.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
