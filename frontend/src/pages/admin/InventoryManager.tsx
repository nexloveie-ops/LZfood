import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface MenuItem {
  _id: string;
  categoryId: string;
  isSoldOut?: boolean;
  soldOutUntil?: string;
  translations: { locale: string; name: string }[];
}

interface Category {
  _id: string;
  sortOrder: number;
  translations: { locale: string; name: string }[];
}

export default function InventoryManager() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canSetRestoreTime = hasFeature('admin.inventory.restoreTime.action');
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [showModal, setShowModal] = useState<string | null>(null); // item id
  const [restoreMode, setRestoreMode] = useState<'quick' | 'custom'>('quick');
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState('');

  const fetchItems = useCallback(async () => {
    const [itemsRes, catsRes] = await Promise.all([
      apiFetch('/api/menu/items?ownOptionGroups=1', { headers: { Authorization: `Bearer ${token}` } }),
      apiFetch('/api/menu/categories', { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (itemsRes.ok) setItems(await itemsRes.json());
    if (catsRes.ok) {
      const cats: Category[] = await catsRes.json();
      cats.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setCategories(cats);
    }
  }, [token]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  /** 按菜品目录 sortOrder 分组；目录已删但 item 仍存在 → 归到「其它」尾部 */
  const groups = useMemo(() => {
    const byCat = new Map<string, MenuItem[]>();
    for (const it of items) {
      const key = it.categoryId || '__uncategorized__';
      const arr = byCat.get(key) || [];
      arr.push(it);
      byCat.set(key, arr);
    }
    const sortedGroups: Array<{ id: string; name: string; nameEn: string; items: MenuItem[] }> = [];
    for (const cat of categories) {
      const list = byCat.get(cat._id);
      if (!list || list.length === 0) continue;
      sortedGroups.push({
        id: cat._id,
        name: cat.translations.find(tr => tr.locale === 'zh-CN')?.name || cat.translations[0]?.name || '',
        nameEn: cat.translations.find(tr => tr.locale === 'en-US')?.name || '',
        items: list,
      });
    }
    const orphans = byCat.get('__uncategorized__');
    if (orphans && orphans.length > 0) {
      sortedGroups.push({ id: '__uncategorized__', name: t('admin.uncategorized', { defaultValue: '其它' }), nameEn: '', items: orphans });
    }
    /** 目录顺序里漏掉的 categoryId（脏数据） */
    const seen = new Set(categories.map(c => c._id));
    for (const [cid, list] of byCat) {
      if (cid === '__uncategorized__' || seen.has(cid)) continue;
      sortedGroups.push({ id: cid, name: t('admin.uncategorized', { defaultValue: '其它' }), nameEn: '', items: list });
    }
    return sortedGroups;
  }, [items, categories, t]);

  const markSoldOut = async (id: string, soldOutUntil: string | null) => {
    await apiFetch(`/api/menu/items/${id}/sold-out`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ isSoldOut: true, soldOutUntil }),
    });
    setShowModal(null);
    fetchItems();
  };

  const restoreSupply = async (id: string) => {
    await apiFetch(`/api/menu/items/${id}/sold-out`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ isSoldOut: false }),
    });
    fetchItems();
  };

  const openSoldOutModal = (id: string) => {
    if (!canSetRestoreTime) {
      void markSoldOut(id, null);
      return;
    }
    setShowModal(id);
    setRestoreMode('quick');
    const now = new Date();
    setCustomDate(now.toISOString().slice(0, 10));
    setCustomTime(String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
  };

  const handleQuickSelect = (hours: number) => {
    if (!showModal) return;
    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    markSoldOut(showModal, until);
  };

  const handleCustomConfirm = () => {
    if (!showModal || !customDate || !customTime) return;
    const until = new Date(`${customDate}T${customTime}:00`).toISOString();
    markSoldOut(showModal, until);
  };

  const formatUntil = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = d.getTime() - now.getTime();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 24) return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const renderItemCard = (item: MenuItem) => {
    const name = item.translations.find(t2 => t2.locale === 'zh-CN')?.name || item.translations[0]?.name || '';
    const nameEn = item.translations.find(t2 => t2.locale === 'en-US')?.name || '';
    return (
      <div key={item._id} className="card" style={{
        padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        opacity: item.isSoldOut ? 0.6 : 1,
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          {nameEn && <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{nameEn}</div>}
          <span className="badge" style={{
            marginTop: 4,
            background: item.isSoldOut ? 'var(--red-light)' : 'var(--green-light)',
            color: item.isSoldOut ? 'var(--red-primary)' : 'var(--green)',
          }}>
            {item.isSoldOut ? t('customer.soldOut') : '在售'}
          </span>
          {item.isSoldOut && item.soldOutUntil && (
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
              ⏰ {formatUntil(item.soldOutUntil)}
            </div>
          )}
        </div>
        {item.isSoldOut ? (
          <button className="btn btn-primary" style={{ fontSize: 12, padding: '8px 14px' }}
            onClick={() => restoreSupply(item._id)}>
            恢复供应
          </button>
        ) : (
          <button className="btn btn-outline" style={{ fontSize: 12, padding: '8px 14px' }}
            onClick={() => openSoldOutModal(item._id)}>
            标记售罄
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.inventory')}</h2>
      {groups.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-light)' }}>{t('common.noData', { defaultValue: '暂无数据' })}</div>
      )}
      {groups.map(group => (
        <section key={group.id} style={{ marginBottom: 22 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 8,
            padding: '6px 0 8px', marginBottom: 10,
            borderBottom: '1px solid var(--border)',
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{group.name}</h3>
            {group.nameEn && <span style={{ fontSize: 11, color: 'var(--text-light)' }}>{group.nameEn}</span>}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-light)' }}>
              {group.items.length}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {group.items.map(renderItemCard)}
          </div>
        </section>
      ))}

      {/* Sold Out Time Modal */}
      {canSetRestoreTime && showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 380, maxWidth: '90%' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, textAlign: 'center' }}>⏰ 选择恢复供应时间</h3>

            {/* Mode tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button className="btn" onClick={() => setRestoreMode('quick')} style={{
                flex: 1, fontSize: 13, padding: '8px 0',
                background: restoreMode === 'quick' ? 'var(--red-primary)' : 'var(--bg)',
                color: restoreMode === 'quick' ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}>快速选择</button>
              <button className="btn" onClick={() => setRestoreMode('custom')} style={{
                flex: 1, fontSize: 13, padding: '8px 0',
                background: restoreMode === 'custom' ? 'var(--red-primary)' : 'var(--bg)',
                color: restoreMode === 'custom' ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}>自定义时间</button>
            </div>

            {restoreMode === 'quick' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button className="btn btn-outline" style={{ padding: '14px 0', fontSize: 14 }} onClick={() => handleQuickSelect(1)}>1 小时</button>
                <button className="btn btn-outline" style={{ padding: '14px 0', fontSize: 14 }} onClick={() => handleQuickSelect(3)}>3 小时</button>
                <button className="btn btn-outline" style={{ padding: '14px 0', fontSize: 14 }} onClick={() => handleQuickSelect(24)}>1 天</button>
                <button className="btn btn-outline" style={{ padding: '14px 0', fontSize: 14 }} onClick={() => handleQuickSelect(48)}>2 天</button>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>日期</label>
                    <input className="input" type="date" value={customDate} onChange={e => setCustomDate(e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>时间</label>
                    <input className="input" type="time" value={customTime} onChange={e => setCustomTime(e.target.value)} style={{ width: '100%' }} />
                  </div>
                </div>
                <button className="btn btn-primary" style={{ width: '100%', padding: '12px 0' }} onClick={handleCustomConfirm}>
                  确认
                </button>
              </div>
            )}

            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12, fontSize: 13 }} onClick={() => setShowModal(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
