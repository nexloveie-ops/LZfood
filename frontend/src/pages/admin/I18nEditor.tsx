import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface Translation { locale: string; name: string; description?: string; }
interface RawEntry { _id: string; translations: Translation[]; }
interface Translatable { _id: string; translations: Translation[]; kind: 'category' | 'item'; }

export default function I18nEditor() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [entries, setEntries] = useState<Translatable[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, { name: string; description: string }>>>({});

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchData = useCallback(async () => {
    const [catRes, itemRes] = await Promise.all([
      apiFetch('/api/menu/categories', { headers: { Authorization: `Bearer ${token}` } }),
      apiFetch('/api/menu/items?ownOptionGroups=1&includeHidden=1', { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const cats: Translatable[] = catRes.ok ? (await catRes.json()).map((c: RawEntry) => ({ ...c, kind: 'category' as const })) : [];
    const items: Translatable[] = itemRes.ok ? (await itemRes.json()).map((i: RawEntry) => ({ ...i, kind: 'item' as const })) : [];
    const all = [...cats, ...items];
    setEntries(all);
    const editMap: typeof edits = {};
    for (const entry of all) {
      editMap[entry._id] = {};
      for (const locale of ['zh-CN', 'en-US']) {
        const tr = entry.translations.find(t2 => t2.locale === locale);
        editMap[entry._id][locale] = { name: tr?.name || '', description: tr?.description || '' };
      }
    }
    setEdits(editMap);
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const updateField = (id: string, locale: string, field: 'name' | 'description', value: string) => {
    setEdits(prev => ({
      ...prev,
      [id]: { ...prev[id], [locale]: { ...prev[id][locale], [field]: value } },
    }));
  };

  const saveEntry = async (entry: Translatable) => {
    const translations = ['zh-CN', 'en-US'].map(locale => ({
      locale,
      name: edits[entry._id]?.[locale]?.name || '',
      description: edits[entry._id]?.[locale]?.description || '',
    }));
    const url = entry.kind === 'category'
      ? `/api/menu/categories/${entry._id}`
      : `/api/menu/items/${entry._id}`;
    await apiFetch(url, { method: 'PUT', headers, body: JSON.stringify({ translations }) });
    fetchData();
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.i18nEditor')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {entries.map(entry => (
          <div key={entry._id} className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span className="badge" style={{
                background: entry.kind === 'category' ? 'var(--blue-light)' : 'var(--gold-light)',
                color: entry.kind === 'category' ? 'var(--blue)' : 'var(--gold-dark)',
              }}>{entry.kind === 'category' ? '分类' : '菜品'}</span>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => saveEntry(entry)}>
                {t('common.save')}
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {['zh-CN', 'en-US'].map(locale => (
                <div key={locale}>
                  <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 2 }}>{locale} 名称</label>
                  <input className="input" value={edits[entry._id]?.[locale]?.name || ''}
                    onChange={e => updateField(entry._id, locale, 'name', e.target.value)} />
                  {entry.kind === 'item' && (
                    <>
                      <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 2, marginTop: 6 }}>{locale} 描述</label>
                      <textarea className="input" rows={2} value={edits[entry._id]?.[locale]?.description || ''}
                        onChange={e => updateField(entry._id, locale, 'description', e.target.value)} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
