import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface SlotData {
  _id?: string;
  type: 'item' | 'category';
  itemId?: string;
  categoryId?: string;
}

interface OfferData {
  _id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  bundlePrice: number;
  slots: SlotData[];
  excludedItemIds?: string[];
  active: boolean;
  startDate?: string;
  endDate?: string;
}

interface CategoryOption { _id: string; name: string; sortOrder: number; }
interface MenuItemOption { _id: string; name: string; categoryId: string; price: number; }

export default function OfferManager() {
  const { t, i18n } = useTranslation();
  const { token } = useAuth();
  const lang = i18n.language;

  const [offers, setOffers] = useState<OfferData[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [editing, setEditing] = useState<OfferData | null>(null);
  const [formName, setFormName] = useState('');
  const [formNameEn, setFormNameEn] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formDescEn, setFormDescEn] = useState('');
  const [formPrice, setFormPrice] = useState('');
  const [formSlots, setFormSlots] = useState<SlotData[]>([{ type: 'category' }, { type: 'category' }]);
  const [formActive, setFormActive] = useState(true);
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formExcluded, setFormExcluded] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const getName = (translations: { locale: string; name: string }[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.name || '';
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [offersRes, catsRes, itemsRes] = await Promise.all([
        apiFetch('/api/offers/all', { headers: { Authorization: `Bearer ${token}` } }),
        apiFetch(`/api/menu/categories?lang=${lang}`),
        apiFetch('/api/menu/items?ownOptionGroups=1'),
      ]);
      if (offersRes.ok) setOffers(await offersRes.json());
      let catOrder = new Map<string, number>();
      if (catsRes.ok) {
        const cats = await catsRes.json() as Array<{
          _id: string;
          sortOrder?: number;
          translations: { locale: string; name: string }[];
        }>;
        const mapped = cats
          .map((c) => ({
            _id: c._id,
            name: getName(c.translations),
            sortOrder: Number(c.sortOrder) || 0,
          }))
          .sort((a, b) => a.sortOrder - b.sortOrder);
        catOrder = new Map(mapped.map((c, i) => [c._id, i]));
        setCategories(mapped);
      }
      if (itemsRes.ok) {
        const items = await itemsRes.json() as Array<{
          _id: string;
          categoryId: string;
          price: number;
          translations: { locale: string; name: string }[];
        }>;
        const mapped = items.map((i) => ({
          _id: i._id,
          name: getName(i.translations),
          categoryId: i.categoryId,
          price: i.price,
        }));
        mapped.sort((a, b) => {
          const oa = catOrder.has(a.categoryId) ? catOrder.get(a.categoryId)! : 9999;
          const ob = catOrder.has(b.categoryId) ? catOrder.get(b.categoryId)! : 9999;
          if (oa !== ob) return oa - ob;
          return 0;
        });
        setMenuItems(mapped);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [token, lang]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const resetForm = () => {
    setEditing(null);
    setFormName(''); setFormNameEn(''); setFormDesc(''); setFormDescEn('');
    setFormPrice(''); setFormSlots([{ type: 'category' }, { type: 'category' }]);
    setFormActive(true); setFormStart(''); setFormEnd(''); setFormExcluded([]);
  };

  const openCreate = () => { resetForm(); setShowForm(true); };

  const openEdit = (offer: OfferData) => {
    setEditing(offer);
    setFormName(offer.name);
    setFormNameEn(offer.nameEn);
    setFormDesc(offer.description);
    setFormDescEn(offer.descriptionEn);
    setFormPrice(offer.bundlePrice.toString());
    setFormSlots(offer.slots.map(s => ({ type: s.type, itemId: s.itemId, categoryId: s.categoryId })));
    setFormActive(offer.active);
    setFormStart(offer.startDate ? offer.startDate.slice(0, 10) : '');
    setFormEnd(offer.endDate ? offer.endDate.slice(0, 10) : '');
    setFormExcluded(offer.excludedItemIds || []);
    setShowForm(true);
  };

  const addSlot = () => setFormSlots(prev => [...prev, { type: 'category' }]);
  const removeSlot = (idx: number) => setFormSlots(prev => prev.filter((_, i) => i !== idx));

  const updateSlot = (idx: number, field: string, value: string) => {
    setFormSlots(prev => prev.map((s, i) => {
      if (i !== idx) return s;
      if (field === 'type') return { type: value as 'item' | 'category' };
      return { ...s, [field]: value };
    }));
  };

  const handleSave = async () => {
    if (!formName.trim() || !formPrice) return;
    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        nameEn: formNameEn.trim(),
        description: formDesc.trim(),
        descriptionEn: formDescEn.trim(),
        bundlePrice: parseFloat(formPrice),
        slots: formSlots,
        excludedItemIds: formExcluded,
        active: formActive,
        startDate: formStart || null,
        endDate: formEnd || null,
      };

      const url = editing ? `/api/offers/${editing._id}` : '/api/offers';
      const method = editing ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setShowForm(false);
        resetForm();
        fetchData();
      } else {
        const d = await res.json().catch(() => null);
        alert(d?.error?.message || 'Save failed');
      }
    } catch { alert('Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此优惠？')) return;
    await apiFetch(`/api/offers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  const excludeItemGroups = useMemo(() => {
    const remaining = menuItems.filter((i) => !formExcluded.includes(i._id));
    const byCat = new Map<string, MenuItemOption[]>();
    for (const it of remaining) {
      const key = it.categoryId || '__uncategorized__';
      const arr = byCat.get(key) || [];
      arr.push(it);
      byCat.set(key, arr);
    }
    const groups: Array<{ id: string; name: string; items: MenuItemOption[] }> = [];
    const seen = new Set<string>();
    for (const cat of categories) {
      const list = byCat.get(cat._id);
      if (!list || list.length === 0) continue;
      groups.push({ id: cat._id, name: cat.name, items: list });
      seen.add(cat._id);
    }
    const orphanItems: MenuItemOption[] = [];
    for (const [cid, list] of byCat) {
      if (cid === '__uncategorized__' || seen.has(cid)) continue;
      orphanItems.push(...list);
    }
    const tail = [...orphanItems, ...(byCat.get('__uncategorized__') || [])];
    if (tail.length > 0) {
      groups.push({
        id: '__uncategorized__',
        name: t('admin.uncategorized', { defaultValue: '其它' }),
        items: tail,
      });
    }
    return groups;
  }, [menuItems, categories, formExcluded, t]);

  const handleToggle = async (offer: OfferData) => {
    await apiFetch(`/api/offers/${offer._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ active: !offer.active }),
    });
    fetchData();
  };

  const getSlotLabel = (slot: SlotData) => {
    if (slot.type === 'item') {
      const item = menuItems.find(i => i._id === slot.itemId);
      return item ? `🍽️ ${item.name} (€${item.price})` : '未选择菜品';
    }
    const cat = categories.find(c => c._id === slot.categoryId);
    return cat ? `📂 ${cat.name} 中任意一项` : '未选择分类';
  };

  const calcOriginalPrice = (slots: SlotData[]) => {
    let total = 0;
    for (const slot of slots) {
      if (slot.type === 'item') {
        const item = menuItems.find(i => i._id === slot.itemId);
        if (item) total += item.price;
      } else if (slot.type === 'category') {
        const catItems = menuItems.filter(i => i.categoryId === slot.categoryId);
        if (catItems.length > 0) {
          const avg = catItems.reduce((s, i) => s + i.price, 0) / catItems.length;
          total += avg;
        }
      }
    }
    return total;
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-light)' }}>加载中...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>🎁 套餐优惠管理</h2>
        <button className="btn btn-primary" onClick={openCreate}>+ 新建优惠</button>
      </div>

      {/* Offer list */}
      {offers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-light)' }}>
          <div style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>🎁</div>
          <p>暂无优惠，点击上方按钮创建</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {offers.map(offer => {
            const origPrice = calcOriginalPrice(offer.slots);
            const saving = origPrice - offer.bundlePrice;
            return (
              <div key={offer._id} className="card" style={{ padding: 16, opacity: offer.active ? 1 : 0.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 18, fontWeight: 700 }}>{offer.name}</span>
                      {offer.nameEn && <span style={{ fontSize: 13, color: 'var(--text-light)' }}>{offer.nameEn}</span>}
                      {!offer.active && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: '#9E9E9E', color: '#fff' }}>已停用</span>}
                    </div>
                    {(offer.description || offer.descriptionEn) && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                        {offer.description}{offer.description && offer.descriptionEn && ' / '}{offer.descriptionEn}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {offer.slots.map((slot, idx) => (
                        <span key={idx} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 16, background: slot.type === 'item' ? '#E3F2FD' : '#FFF3E0', color: slot.type === 'item' ? '#1565C0' : '#E65100', fontWeight: 500 }}>
                          {idx > 0 && '+ '}{getSlotLabel(slot)}
                        </span>
                      ))}
                      {offer.excludedItemIds && offer.excludedItemIds.length > 0 && (
                        <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 16, background: '#FFEBEE', color: '#C62828' }}>
                          🚫 排除: {offer.excludedItemIds.map(id => menuItems.find(i => i._id === id)?.name || id).join(', ')}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--red-primary)' }}>€{offer.bundlePrice.toFixed(2)}</span>
                      {saving > 0 && <span style={{ fontSize: 12, color: 'var(--green, #388E3C)', fontWeight: 600 }}>省 €{saving.toFixed(2)}</span>}
                      {offer.startDate && <span style={{ fontSize: 11, color: 'var(--text-light)' }}>从 {offer.startDate.slice(0, 10)}</span>}
                      {offer.endDate && <span style={{ fontSize: 11, color: 'var(--text-light)' }}>至 {offer.endDate.slice(0, 10)}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => handleToggle(offer)}>
                      {offer.active ? '停用' : '启用'}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => openEdit(offer)}>编辑</button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, color: '#F44336' }} onClick={() => handleDelete(offer._id)}>删除</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setShowForm(false); resetForm(); }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 520, maxWidth: '95%', maxHeight: '90vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
              {editing ? '编辑优惠' : '新建套餐优惠'}
            </h3>

            {/* Name */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>名称 (中文) *</label>
                <input className="input" value={formName} onChange={e => setFormName(e.target.value)} placeholder="例: 午餐套餐A" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>Name (English)</label>
                <input className="input" value={formNameEn} onChange={e => setFormNameEn(e.target.value)} placeholder="e.g. Lunch Set A" />
              </div>
            </div>

            {/* Description */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>描述 (中文)</label>
                <input className="input" value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="可选" style={{ width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>Description (English)</label>
                <input className="input" value={formDescEn} onChange={e => setFormDescEn(e.target.value)} placeholder="Optional" style={{ width: '100%' }} />
              </div>
            </div>

            {/* Bundle Price */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>套餐价格 (€) *</label>
              <input className="input" type="number" step="0.01" value={formPrice} onChange={e => setFormPrice(e.target.value)}
                style={{ width: 140, fontSize: 18, fontWeight: 700 }} />
            </div>

            {/* Slots */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>套餐内容 ({formSlots.length} 项)</label>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addSlot}>+ 添加</button>
              </div>
              {formSlots.map((slot, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, padding: 10, background: 'var(--bg, #f9f9f9)', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-light)', minWidth: 20 }}>{idx + 1}.</span>
                  <select className="input" value={slot.type} onChange={e => updateSlot(idx, 'type', e.target.value)} style={{ width: 90 }}>
                    <option value="category">分类</option>
                    <option value="item">菜品</option>
                  </select>
                  {slot.type === 'category' ? (
                    <select className="input" value={slot.categoryId || ''} onChange={e => updateSlot(idx, 'categoryId', e.target.value)} style={{ flex: 1 }}>
                      <option value="">选择分类...</option>
                      {categories.map(c => <option key={c._id} value={c._id}>{c.name}</option>)}
                    </select>
                  ) : (
                    <select className="input" value={slot.itemId || ''} onChange={e => updateSlot(idx, 'itemId', e.target.value)} style={{ flex: 1 }}>
                      <option value="">选择菜品...</option>
                      {menuItems.map(i => <option key={i._id} value={i._id}>{i.name} (€{i.price})</option>)}
                    </select>
                  )}
                  {formSlots.length > 2 && (
                    <button className="btn btn-ghost" style={{ fontSize: 14, color: '#F44336', padding: '2px 6px' }} onClick={() => removeSlot(idx)}>✕</button>
                  )}
                </div>
              ))}
            </div>

            {/* Excluded Items */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>排除菜品（不参与此优惠）</label>
              <select className="input" value="" onChange={e => {
                const val = e.target.value;
                if (val && !formExcluded.includes(val)) {
                  setFormExcluded(prev => [...prev, val]);
                }
              }} style={{ width: '100%', marginBottom: 8 }}>
                <option value="">+ 选择要排除的菜品...</option>
                {excludeItemGroups.map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.items.map((i) => (
                      <option key={i._id} value={i._id}>{i.name} (€{i.price})</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {formExcluded.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 10, background: '#FFF8E1', borderRadius: 8, border: '1px solid #FFE082' }}>
                  {formExcluded.map(id => {
                    const item = menuItems.find(i => i._id === id);
                    return (
                      <span key={id} style={{
                        fontSize: 13, padding: '6px 12px', borderRadius: 20,
                        background: '#FFEBEE', color: '#C62828', fontWeight: 500,
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                      }}>
                        🚫 {item?.name || id}
                        <span
                          style={{ cursor: 'pointer', fontWeight: 700, fontSize: 15, lineHeight: 1 }}
                          onClick={() => setFormExcluded(prev => prev.filter(x => x !== id))}
                        >✕</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Active + Dates */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={formActive} onChange={e => setFormActive(e.target.checked)} />
                启用
              </label>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 2 }}>开始日期</label>
                <input className="input" type="date" value={formStart} onChange={e => setFormStart(e.target.value)} style={{ width: 140 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 2 }}>结束日期</label>
                <input className="input" type="date" value={formEnd} onChange={e => setFormEnd(e.target.value)} style={{ width: 140 }} />
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => { setShowForm(false); resetForm(); }}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving || !formName.trim() || !formPrice}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
