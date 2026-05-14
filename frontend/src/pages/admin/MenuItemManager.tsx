import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface Translation { locale: string; name: string; description?: string; }
interface Category { _id: string; translations: Translation[]; }
interface AllergenData { _id: string; name: string; icon: string; translations: { locale: string; name: string }[]; }
interface OptionChoiceData { _id?: string; extraPrice: number; originalPrice?: number; translations: { locale: string; name: string }[]; }
interface OptionGroupData { _id?: string; required?: boolean; minSelect?: number; maxSelect?: number; translations: { locale: string; name: string }[]; choices: OptionChoiceData[]; }
interface MenuItem {
  _id: string; categoryId: string; price: number; calories?: number;
  avgWaitMinutes?: number; photoUrl?: string; arFileUrl?: string;
  isSoldOut?: boolean; translations: Translation[]; allergenIds?: string[];
  optionGroups?: OptionGroupData[];
}

interface FormOptionChoice { _id?: string; nameZh: string; nameEn: string; extraPrice: number; originalPrice: number; }
interface FormOptionGroup { _id?: string; nameZh: string; nameEn: string; required: boolean; minSelect: number; maxSelect: number; choices: FormOptionChoice[]; }

const emptyForm = { categoryId: '', price: 0, calories: 0, avgWaitMinutes: 0, nameZh: '', nameEn: '', descZh: '', descEn: '', allergenIds: [] as string[], optionGroups: [] as FormOptionGroup[] };

export default function MenuItemManager() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [allergens, setAllergens] = useState<AllergenData[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchData = useCallback(async () => {
    const [catRes, itemRes, allergenRes] = await Promise.all([
      apiFetch('/api/menu/categories', { headers: authHeaders }),
      apiFetch('/api/menu/items?ownOptionGroups=1', { headers: authHeaders }),
      apiFetch('/api/allergens', { headers: authHeaders }),
    ]);
    if (catRes.ok) setCategories(await catRes.json());
    if (itemRes.ok) setItems(await itemRes.json());
    if (allergenRes.ok) setAllergens(await allergenRes.json());
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const startEdit = (item: MenuItem | null) => {
    if (item) {
      const optionGroups: FormOptionGroup[] = (item.optionGroups || []).map(g => {
        const choicesRaw = Array.isArray(g.choices) ? g.choices : [];
        const choiceRows =
          choicesRaw.length > 0
            ? choicesRaw
            : [{ translations: [] as { locale: string; name: string }[], extraPrice: 0, originalPrice: 0 }];
        return {
          _id: g._id != null ? String(g._id) : undefined,
          nameZh: g.translations.find(t2 => t2.locale === 'zh-CN')?.name || '',
          nameEn: g.translations.find(t2 => t2.locale === 'en-US')?.name || '',
          required: g.required,
          minSelect: Math.max(0, Math.floor(Number((g as { minSelect?: number }).minSelect) || 0)),
          maxSelect: Math.max(0, Math.floor(Number((g as { maxSelect?: number }).maxSelect) || 0)),
          choices: choiceRows.map(c => ({
            _id: c._id != null ? String(c._id) : undefined,
            nameZh: c.translations.find(t2 => t2.locale === 'zh-CN')?.name || '',
            nameEn: c.translations.find(t2 => t2.locale === 'en-US')?.name || '',
            extraPrice: typeof c.extraPrice === 'number' && Number.isFinite(c.extraPrice) ? c.extraPrice : 0,
            originalPrice:
              typeof c.originalPrice === 'number' && Number.isFinite(c.originalPrice) ? c.originalPrice : 0,
          })),
        };
      });
      setForm({
        categoryId: item.categoryId,
        price: item.price,
        calories: item.calories || 0,
        avgWaitMinutes: item.avgWaitMinutes || 0,
        nameZh: item.translations.find(t2 => t2.locale === 'zh-CN')?.name || '',
        nameEn: item.translations.find(t2 => t2.locale === 'en-US')?.name || '',
        descZh: item.translations.find(t2 => t2.locale === 'zh-CN')?.description || '',
        descEn: item.translations.find(t2 => t2.locale === 'en-US')?.description || '',
        allergenIds: item.allergenIds || [],
        optionGroups,
      });
      setEditingId(item._id);
    } else {
      setForm({ ...emptyForm, categoryId: categories[0]?._id || '' });
      setEditingId(null);
    }
    setShowForm(true);
  };

  const handleSave = async () => {
    for (let gi = 0; gi < form.optionGroups.length; gi++) {
      if (!form.optionGroups[gi].choices?.length) {
        alert(`选项组 #${gi + 1} 须至少包含一个选项`);
        return;
      }
      const g = form.optionGroups[gi];
      if (!g.required) {
        const minS = Math.max(0, Math.floor(Number(g.minSelect) || 0));
        const maxS = Math.max(0, Math.floor(Number(g.maxSelect) || 0));
        if (maxS > 0 && minS > maxS) {
          alert(`选项组 #${gi + 1}：最少选择数不能大于最多选择数`);
          return;
        }
        if (minS > g.choices.length) {
          alert(`选项组 #${gi + 1}：最少选择数不能大于选项个数`);
          return;
        }
        if (maxS > 0 && maxS > g.choices.length) {
          alert(`选项组 #${gi + 1}：最多选择数不能大于选项个数`);
          return;
        }
      }
    }
    const body = {
      categoryId: form.categoryId, price: form.price,
      calories: form.calories, avgWaitMinutes: form.avgWaitMinutes,
      allergenIds: form.allergenIds,
      translations: [
        { locale: 'zh-CN', name: form.nameZh, description: form.descZh },
        { locale: 'en-US', name: form.nameEn, description: form.descEn },
      ],
      optionGroups: form.optionGroups.map(g => ({
        ...(g._id ? { _id: g._id } : {}),
        required: g.required,
        ...(!g.required
          ? {
              minSelect: Math.max(0, Math.floor(Number(g.minSelect) || 0)),
              maxSelect: Math.max(0, Math.floor(Number(g.maxSelect) || 0)),
            }
          : {}),
        translations: [
          { locale: 'zh-CN', name: g.nameZh },
          { locale: 'en-US', name: g.nameEn },
        ],
        choices: g.choices.map(c => ({
          ...(c._id ? { _id: c._id } : {}),
          extraPrice: Number.isFinite(c.extraPrice) ? c.extraPrice : 0,
          originalPrice: Number.isFinite(c.originalPrice) ? c.originalPrice : undefined,
          translations: [
            { locale: 'zh-CN', name: c.nameZh },
            { locale: 'en-US', name: c.nameEn },
          ],
        })),
      })),
    };
    try {
      let res: Response;
      if (editingId) {
        res = await apiFetch(`/api/menu/items/${editingId}`, { method: 'PUT', headers, body: JSON.stringify(body) });
      } else {
        res = await apiFetch('/api/menu/items', { method: 'POST', headers, body: JSON.stringify(body) });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || '保存失败');
        return;
      }
      setShowForm(false);
      fetchData();
    } catch {
      alert('保存失败，请检查网络连接');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    await apiFetch(`/api/menu/items/${id}`, { method: 'DELETE', headers });
    fetchData();
  };

  const uploadPhoto = async (id: string, file: File) => {
    const fd = new FormData(); fd.append('photo', file);
    await apiFetch(`/api/menu/items/${id}/photo`, { method: 'POST', headers: authHeaders, body: fd });
    fetchData();
  };

  const uploadAR = async (id: string, file: File) => {
    const fd = new FormData(); fd.append('ar', file);
    try {
      const res = await apiFetch(`/api/menu/items/${id}/ar`, { method: 'POST', headers: authHeaders, body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || `AR upload failed (${res.status})`);
        return;
      }
      fetchData();
    } catch (e) {
      alert(`AR upload error: ${e instanceof Error ? e.message : 'Network error'}`);
    }
  };

  const getCatName = (catId: string) => {
    const cat = categories.find(c => c._id === catId);
    return cat?.translations.find(t2 => t2.locale === 'zh-CN')?.name || '';
  };

  // Option group helpers
  const addOptionGroup = () => {
    setForm(prev => ({
      ...prev,
      optionGroups: [...prev.optionGroups, { nameZh: '', nameEn: '', required: false, minSelect: 0, maxSelect: 0, choices: [{ nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0 }] }],
    }));
  };

  const removeOptionGroup = (gi: number) => {
    setForm(prev => ({ ...prev, optionGroups: prev.optionGroups.filter((_, i) => i !== gi) }));
  };

  const updateOptionGroup = (gi: number, field: string, value: unknown) => {
    setForm(prev => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) => i === gi ? { ...g, [field]: value } : g),
    }));
  };

  const addChoice = (gi: number) => {
    setForm(prev => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: [...g.choices, { nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0 }] } : g
      ),
    }));
  };

  const removeChoice = (gi: number, ci: number) => {
    setForm(prev => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) => {
        if (i !== gi) return g;
        if (g.choices.length <= 1) return g;
        return { ...g, choices: g.choices.filter((_, j) => j !== ci) };
      }),
    }));
  };

  const updateChoice = (gi: number, ci: number, field: string, value: unknown) => {
    setForm(prev => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: g.choices.map((c, j) => j === ci ? { ...c, [field]: value } : c) } : g
      ),
    }));
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>{t('admin.menuItems')}</h2>
        <button className="btn btn-primary" onClick={() => startEdit(null)}>{t('common.add')}</button>
      </div>

      {showForm && !editingId && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>分类</label>
              <select className="input" value={form.categoryId} onChange={e => setForm({ ...form, categoryId: e.target.value })}>
                {categories.map(c => <option key={c._id} value={c._id}>{c.translations.find(t2 => t2.locale === 'zh-CN')?.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>价格</label>
              <input className="input" type="number" value={form.price} onChange={e => setForm({ ...form, price: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>热量 (卡)</label>
              <input className="input" type="number" value={form.calories} onChange={e => setForm({ ...form, calories: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>等待时间 (分钟)</label>
              <input className="input" type="number" value={form.avgWaitMinutes} onChange={e => setForm({ ...form, avgWaitMinutes: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文名称</label>
              <input className="input" value={form.nameZh} onChange={e => setForm({ ...form, nameZh: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English Name</label>
              <input className="input" value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文描述</label>
              <textarea className="input" value={form.descZh} onChange={e => setForm({ ...form, descZh: e.target.value })} rows={2} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English Description</label>
              <textarea className="input" value={form.descEn} onChange={e => setForm({ ...form, descEn: e.target.value })} rows={2} />
            </div>
          </div>
          {allergens.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 6 }}>过敏原</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allergens.map(a => {
                  const checked = form.allergenIds.includes(a._id);
                  return (
                    <label key={a._id} style={{
                      display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
                      borderRadius: 6, fontSize: 13, cursor: 'pointer',
                      background: checked ? 'var(--red-light)' : 'var(--bg)',
                      border: checked ? '1px solid var(--red-primary)' : '1px solid var(--border)',
                      color: checked ? 'var(--red-primary)' : 'var(--text-secondary)',
                    }}>
                      <input type="checkbox" checked={checked} style={{ display: 'none' }}
                        onChange={() => {
                          setForm(prev => ({
                            ...prev,
                            allergenIds: checked
                              ? prev.allergenIds.filter(id => id !== a._id)
                              : [...prev.allergenIds, a._id],
                          }));
                        }} />
                      <span>{a.icon}</span>
                      <span>{a.translations.find(t2 => t2.locale === 'zh-CN')?.name || a.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Option Groups Section */}
          <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 700 }}>{t('admin.optionGroups')}</label>
              <button className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }} onClick={addOptionGroup}>
                + {t('admin.addOptionGroup')}
              </button>
            </div>
            {form.optionGroups.map((group, gi) => (
              <div key={gi} style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 10, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t('admin.optionGroups')} #{gi + 1}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red-primary)', padding: '2px 6px' }} onClick={() => removeOptionGroup(gi)}>
                    {t('common.delete')}
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.groupName')} (中文)</label>
                    <input className="input" value={group.nameZh} onChange={e => updateOptionGroup(gi, 'nameZh', e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.groupName')} (EN)</label>
                    <input className="input" value={group.nameEn} onChange={e => updateOptionGroup(gi, 'nameEn', e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={group.required}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setForm((prev) => ({
                            ...prev,
                            optionGroups: prev.optionGroups.map((g, i) =>
                              i !== gi ? g : { ...g, required: checked, ...(checked ? { minSelect: 0, maxSelect: 0 } : {}) },
                            ),
                          }));
                        }}
                      />
                      {t('admin.required')}
                    </label>
                  </div>
                </div>
                {!group.required && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.optionGroupMinSelect')}</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={group.minSelect}
                        onChange={(e) => updateOptionGroup(gi, 'minSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-light)' }}>
                        {t('admin.optionGroupMaxSelect')} <span style={{ opacity: 0.75 }}>({t('admin.optionGroupMaxSelectHint')})</span>
                      </label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={group.maxSelect}
                        onChange={(e) => updateOptionGroup(gi, 'maxSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                )}
                {/* Choices */}
                {group.choices.map((choice, ci) => (
                  <div key={ci} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 80px auto', gap: 6, marginBottom: 4 }}>
                    <input className="input" placeholder={`${t('admin.choiceName')} (中文)`} value={choice.nameZh}
                      onChange={e => updateChoice(gi, ci, 'nameZh', e.target.value)} style={{ fontSize: 12 }} />
                    <input className="input" placeholder={`${t('admin.choiceName')} (EN)`} value={choice.nameEn}
                      onChange={e => updateChoice(gi, ci, 'nameEn', e.target.value)} style={{ fontSize: 12 }} />
                    <input className="input" type="number" placeholder="原价" value={choice.originalPrice || ''}
                      onChange={e => {
                        const v = e.target.value;
                        const n = v === '' ? 0 : Number(v);
                        updateChoice(gi, ci, 'originalPrice', Number.isFinite(n) ? n : 0);
                      }} style={{ fontSize: 12 }} />
                    <input className="input" type="number" placeholder={t('admin.extraPrice')} value={choice.extraPrice}
                      onChange={e => {
                        const v = e.target.value;
                        const n = v === '' ? 0 : Number(v);
                        updateChoice(gi, ci, 'extraPrice', Number.isFinite(n) ? n : 0);
                      }} style={{ fontSize: 12 }} />
                    <button className="btn btn-ghost" style={{ fontSize: 14, color: 'var(--red-primary)', padding: '0 4px' }}
                      onClick={() => removeChoice(gi, ci)}>✕</button>
                  </div>
                ))}
                <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 4 }} onClick={() => addChoice(gi)}>
                  + {t('admin.addChoice')}
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button>
            <button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Items table */}
      <div className="card" style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>照片</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>名称</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>分类</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>价格</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>过敏原</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>AR</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>状态</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <React.Fragment key={item._id}>
              <tr style={{ borderBottom: showForm && editingId === item._id ? 'none' : '1px solid #f0f0f0', background: showForm && editingId === item._id ? '#FFF5F5' : undefined }}>
                <td style={{ padding: '8px 12px' }}>
                  <label style={{ cursor: 'pointer', display: 'block' }}>
                    <div style={{ width: 48, height: 48, borderRadius: 6, background: item.photoUrl ? `url(${item.photoUrl}) center/cover` : 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{!item.photoUrl && '📷'}</div>
                    <input type="file" accept="image/*" hidden onChange={e => { if (e.target.files?.[0]) { uploadPhoto(item._id, e.target.files[0]); e.target.value = ''; } }} />
                  </label>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <div style={{ fontWeight: 600 }}>{item.translations.find(t2 => t2.locale === 'zh-CN')?.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{item.translations.find(t2 => t2.locale === 'en-US')?.name}</div>
                  {item.optionGroups && item.optionGroups.length > 0 && (<div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>⚙ {item.optionGroups.length} {t('admin.optionGroups').toLowerCase()}</div>)}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{getCatName(item.categoryId)}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--red-primary)' }}>€{item.price}</td>
                <td style={{ padding: '8px 12px' }}>{(item.allergenIds || []).map(aid => { const a = allergens.find(al => al._id === aid); return a ? <span key={aid} title={a.translations.find(t2 => t2.locale === 'zh-CN')?.name || a.name} style={{ marginRight: 2 }}>{a.icon}</span> : null; })}</td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <label style={{ cursor: 'pointer' }}>{item.arFileUrl ? (<span style={{ color: 'var(--green)', fontSize: 13 }}>✓ <span style={{ textDecoration: 'underline', fontSize: 11 }}>替换</span></span>) : (<span className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', display: 'inline-block' }}>上传 AR</span>)}<input type="file" accept=".usdz,.glb" hidden onChange={e => { if (e.target.files?.[0]) { uploadAR(item._id, e.target.files[0]); e.target.value = ''; } }} /></label>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>{item.isSoldOut ? <span className="badge" style={{ background: 'var(--red-light)', color: 'var(--red-primary)' }}>售罄</span> : <span className="badge" style={{ background: 'var(--green-light)', color: 'var(--green)' }}>在售</span>}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { if (showForm && editingId === item._id) setShowForm(false); else startEdit(item); }}>{showForm && editingId === item._id ? '收起' : t('common.edit')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => handleDelete(item._id)}>{t('common.delete')}</button>
                </td>
              </tr>
              {showForm && editingId === item._id && (
                <tr><td colSpan={8} style={{ padding: 16, background: 'var(--bg)', borderBottom: '2px solid var(--red-primary)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>分类</label><select className="input" value={form.categoryId} onChange={e => setForm({ ...form, categoryId: e.target.value })}>{categories.map(c => <option key={c._id} value={c._id}>{c.translations.find(t2 => t2.locale === 'zh-CN')?.name}</option>)}</select></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>价格</label><input className="input" type="number" value={form.price} onChange={e => setForm({ ...form, price: Number(e.target.value) })} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文名称</label><input className="input" value={form.nameZh} onChange={e => setForm({ ...form, nameZh: e.target.value })} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English Name</label><input className="input" value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文描述</label><textarea className="input" value={form.descZh} onChange={e => setForm({ ...form, descZh: e.target.value })} rows={2} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English Description</label><textarea className="input" value={form.descEn} onChange={e => setForm({ ...form, descEn: e.target.value })} rows={2} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>热量</label><input className="input" type="number" value={form.calories} onChange={e => setForm({ ...form, calories: Number(e.target.value) })} /></div>
                    <div><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>等待时间(分)</label><input className="input" type="number" value={form.avgWaitMinutes} onChange={e => setForm({ ...form, avgWaitMinutes: Number(e.target.value) })} /></div>
                  </div>
                  {allergens.length > 0 && (<div style={{ marginTop: 12 }}><label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 6 }}>过敏原</label><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{allergens.map(a => { const ck = form.allergenIds.includes(a._id); return (<label key={a._id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: ck ? 'var(--red-light)' : '#fff', border: ck ? '1px solid var(--red-primary)' : '1px solid var(--border)', color: ck ? 'var(--red-primary)' : 'var(--text-secondary)' }}><input type="checkbox" checked={ck} style={{ display: 'none' }} onChange={() => setForm(prev => ({ ...prev, allergenIds: ck ? prev.allergenIds.filter(id => id !== a._id) : [...prev.allergenIds, a._id] }))} /><span>{a.icon}</span><span>{a.translations.find(t2 => t2.locale === 'zh-CN')?.name || a.name}</span></label>); })}</div></div>)}
                  <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><label style={{ fontSize: 13, fontWeight: 700 }}>{t('admin.optionGroups')}</label><button className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }} onClick={addOptionGroup}>+ {t('admin.addOptionGroup')}</button></div>
                    {form.optionGroups.map((group, gi) => (<div key={gi} style={{ background: '#fff', borderRadius: 8, padding: 12, marginBottom: 10, border: '1px solid var(--border)' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}><span style={{ fontSize: 12, fontWeight: 600 }}>#{gi + 1}</span><button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red-primary)' }} onClick={() => removeOptionGroup(gi)}>{t('common.delete')}</button></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}><div><label style={{ fontSize: 11, color: 'var(--text-light)' }}>名称(中)</label><input className="input" value={group.nameZh} onChange={e => updateOptionGroup(gi, 'nameZh', e.target.value)} style={{ width: '100%' }} /></div><div><label style={{ fontSize: 11, color: 'var(--text-light)' }}>Name(EN)</label><input className="input" value={group.nameEn} onChange={e => updateOptionGroup(gi, 'nameEn', e.target.value)} style={{ width: '100%' }} /></div><div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}><label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><input type="checkbox" checked={group.required} onChange={(e) => { const checked = e.target.checked; setForm((prev) => ({ ...prev, optionGroups: prev.optionGroups.map((g, i) => (i !== gi ? g : { ...g, required: checked, ...(checked ? { minSelect: 0, maxSelect: 0 } : {}) })) })); }} />{t('admin.required')}</label></div></div>{!group.required && (<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}><div><label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.optionGroupMinSelect')}</label><input className="input" type="number" min={0} value={group.minSelect} onChange={(e) => updateOptionGroup(gi, 'minSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))} style={{ width: '100%' }} /></div><div><label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.optionGroupMaxSelect')} <span style={{ opacity: 0.75 }}>({t('admin.optionGroupMaxSelectHint')})</span></label><input className="input" type="number" min={0} value={group.maxSelect} onChange={(e) => updateOptionGroup(gi, 'maxSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))} style={{ width: '100%' }} /></div></div>)}{group.choices.map((choice, ci) => (<div key={ci} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px 70px auto', gap: 6, marginBottom: 4 }}><input className="input" placeholder="中文" value={choice.nameZh} onChange={e => updateChoice(gi, ci, 'nameZh', e.target.value)} style={{ fontSize: 12 }} /><input className="input" placeholder="EN" value={choice.nameEn} onChange={e => updateChoice(gi, ci, 'nameEn', e.target.value)} style={{ fontSize: 12 }} /><input className="input" type="number" placeholder="原价" value={choice.originalPrice || ''} onChange={e => { const v = e.target.value; const n = v === '' ? 0 : Number(v); updateChoice(gi, ci, 'originalPrice', Number.isFinite(n) ? n : 0); }} style={{ fontSize: 12 }} /><input className="input" type="number" placeholder="现价" value={choice.extraPrice} onChange={e => { const v = e.target.value; const n = v === '' ? 0 : Number(v); updateChoice(gi, ci, 'extraPrice', Number.isFinite(n) ? n : 0); }} style={{ fontSize: 12 }} /><button className="btn btn-ghost" style={{ fontSize: 14, color: 'var(--red-primary)' }} onClick={() => removeChoice(gi, ci)}>✕</button></div>))}<button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 4 }} onClick={() => addChoice(gi)}>+ {t('admin.addChoice')}</button></div>))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button><button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button></div>
                </td></tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
