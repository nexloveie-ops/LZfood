import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface Translation { locale: string; name: string; }
interface Category { _id: string; sortOrder: number; translations: Translation[]; }

export default function CategoryManager() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canTrackInventory = hasFeature('inventory.tracking');
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [sortOrder, setSortOrder] = useState(0);

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchCategories = useCallback(async () => {
    const res = await apiFetch('/api/menu/categories', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data: Category[] = await res.json();
      setCategories(data.sort((a, b) => a.sortOrder - b.sortOrder));
    }
  }, [token]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const startEdit = (cat: Category | null) => {
    if (cat) {
      setEditingId(cat._id);
      setNameZh(cat.translations.find(t2 => t2.locale === 'zh-CN')?.name || '');
      setNameEn(cat.translations.find(t2 => t2.locale === 'en-US')?.name || '');
      setSortOrder(cat.sortOrder);
    } else {
      setEditingId(null);
      setNameZh(''); setNameEn(''); setSortOrder(categories.length);
    }
    setShowForm(true);
  };

  const handleSave = async () => {
    const body = {
      sortOrder,
      translations: [
        { locale: 'zh-CN', name: nameZh },
        { locale: 'en-US', name: nameEn },
      ],
    };
    const res = editingId
      ? await apiFetch(`/api/menu/categories/${editingId}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      : await apiFetch('/api/menu/categories', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || `保存失败（${res.status}）`);
      return;
    }
    setShowForm(false);
    fetchCategories();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/menu/categories/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || '删除失败');
      return;
    }
    fetchCategories();
  };

  // Drag handlers
  const handleDragStart = (idx: number) => {
    dragIdx.current = idx;
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDragLeave = () => {
    setDragOverIdx(null);
  };

  const handleDrop = async (targetIdx: number) => {
    const fromIdx = dragIdx.current;
    dragIdx.current = null;
    setDragOverIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;

    // Reorder locally
    const newList = [...categories];
    const [moved] = newList.splice(fromIdx, 1);
    newList.splice(targetIdx, 0, moved);

    // Update sortOrder values
    const reordered = newList.map((cat, i) => ({ ...cat, sortOrder: i }));
    setCategories(reordered);

    // Save to backend
    const res = await apiFetch('/api/menu/categories/reorder', {
      method: 'PUT', headers,
      body: JSON.stringify({ order: reordered.map(c => ({ id: c._id, sortOrder: c.sortOrder })) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || `排序保存失败（${res.status}）`);
      fetchCategories();
    }
  };

  const handleDragEnd = () => {
    dragIdx.current = null;
    setDragOverIdx(null);
  };

  const bulkToggleTracking = async (catId: string, enabled: boolean) => {
    const cat = categories.find(c => c._id === catId);
    const name = cat?.translations.find(t2 => t2.locale === 'zh-CN')?.name || catId;
    const msg = enabled
      ? `将「${name}」目录下所有菜品启用库存追踪？\n（之后仍需逐项配置基础单位、份内数量等）`
      : `关闭「${name}」目录下所有菜品的库存追踪？`;
    if (!confirm(msg)) return;
    const res = await apiFetch(`/api/inventory/categories/${catId}/tracking`, {
      method: 'POST', headers, body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || '操作失败');
      return;
    }
    const data = await res.json().catch(() => null);
    alert(`已${enabled ? '启用' : '关闭'} ${data?.modifiedCount ?? 0} 个菜品的库存追踪`);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>{t('admin.categories')}</h2>
        <button className="btn btn-primary" onClick={() => startEdit(null)}>{t('common.add')}</button>
      </div>

      {showForm && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'end' }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文名称</label>
              <input className="input" value={nameZh} onChange={e => setNameZh(e.target.value)} placeholder="中文名称" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English Name</label>
              <input className="input" value={nameEn} onChange={e => setNameEn(e.target.value)} placeholder="English Name" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button>
            <button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-light)', background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
          ↕ 拖拽行可调整顺序，松开后自动保存
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 16px', textAlign: 'center', width: 50 }}>#</th>
              <th style={{ padding: '10px 16px', textAlign: 'left' }}>中文</th>
              <th style={{ padding: '10px 16px', textAlign: 'left' }}>English</th>
              <th style={{ padding: '10px 16px', textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, idx) => (
              <tr key={cat._id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragLeave={handleDragLeave}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                style={{
                  borderBottom: '1px solid #f0f0f0',
                  cursor: 'grab',
                  background: dragOverIdx === idx ? '#E3F2FD' : 'transparent',
                  transition: 'background 0.15s',
                }}>
                <td style={{ padding: '10px 16px', textAlign: 'center', color: 'var(--text-light)' }}>
                  <span style={{ cursor: 'grab', fontSize: 16 }}>☰</span> {idx + 1}
                </td>
                <td style={{ padding: '10px 16px', fontWeight: 600 }}>{cat.translations.find(t2 => t2.locale === 'zh-CN')?.name}</td>
                <td style={{ padding: '10px 16px' }}>{cat.translations.find(t2 => t2.locale === 'en-US')?.name}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                  {canTrackInventory && (
                    <>
                      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => bulkToggleTracking(cat._id, true)}>📦 启用追踪</button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--text-light)' }} onClick={() => bulkToggleTracking(cat._id, false)}>关闭追踪</button>
                    </>
                  )}
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => startEdit(cat)}>{t('common.edit')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => handleDelete(cat._id)}>{t('common.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
