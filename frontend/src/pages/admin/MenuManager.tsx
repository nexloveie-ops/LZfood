import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import { adminMenuName, useAdminMenus, type AdminMenu } from '../../hooks/useAdminMenus';

const CHANNELS = [
  { id: 'dine_in', zh: '堂食', en: 'Dine-in' },
  { id: 'takeout', zh: '外卖', en: 'Takeout' },
  { id: 'phone', zh: '电话', en: 'Phone' },
  { id: 'delivery', zh: '送餐', en: 'Delivery' },
] as const;

const DAYS = [
  { id: 1, zh: '一', en: 'Mon' },
  { id: 2, zh: '二', en: 'Tue' },
  { id: 3, zh: '三', en: 'Wed' },
  { id: 4, zh: '四', en: 'Thu' },
  { id: 5, zh: '五', en: 'Fri' },
  { id: 6, zh: '六', en: 'Sat' },
  { id: 0, zh: '日', en: 'Sun' },
];

type ScheduleWindow = { days: number[]; start: string; end: string };

function emptyWindow(): ScheduleWindow {
  return { days: [], start: '00:00', end: '00:00' };
}

export default function MenuManager() {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language.startsWith('en');
  const { token } = useAuth();
  const { menus, reload, setMenuId } = useAdminMenus();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [schedule, setSchedule] = useState<ScheduleWindow[]>([]);
  const [shareStock, setShareStock] = useState(true);
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const startEdit = (menu: AdminMenu | null) => {
    if (menu) {
      setEditingId(menu._id);
      setNameZh(menu.translations?.find((row) => row.locale === 'zh-CN')?.name || '');
      setNameEn(menu.translations?.find((row) => row.locale === 'en-US')?.name || '');
      setChannels([...(menu.channels || [])]);
      setSchedule(
        (menu.schedule || []).map((w) => ({
          days: [...(w.days || [])],
          start: w.start || '00:00',
          end: w.end || '00:00',
        })),
      );
    } else {
      setEditingId(null);
      setNameZh('');
      setNameEn('');
      setChannels([]);
      setSchedule([]);
    }
    setShowForm(true);
  };

  const handleSave = async () => {
    const body = {
      translations: [
        { locale: 'zh-CN', name: nameZh.trim() || (isEn ? 'Menu' : '菜单') },
        { locale: 'en-US', name: nameEn.trim() || nameZh.trim() || 'Menu' },
      ],
      channels,
      schedule,
    };
    const res = editingId
      ? await apiFetch(`/api/menus/${editingId}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      : await apiFetch('/api/menus', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
      return;
    }
    setShowForm(false);
    await reload();
  };

  const handleCopy = async (id: string) => {
    const res = await apiFetch(`/api/menus/${id}/copy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ shareStock }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
      return;
    }
    await reload();
  };

  const handleDelete = async (menu: AdminMenu) => {
    if (menu.isDefault) {
      alert(t('admin.menuCannotDeleteDefault'));
      return;
    }
    if (!confirm(`${t('common.confirm')}?`)) return;
    const res = await apiFetch(`/api/menus/${menu._id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
      return;
    }
    await reload();
  };

  const handleDrop = async (targetIdx: number) => {
    const fromIdx = dragIdx.current;
    dragIdx.current = null;
    setDragOverIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;
    const next = [...menus];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(targetIdx, 0, moved);
    const order = next.map((menu, i) => ({ id: menu._id, sortOrder: i }));
    const res = await apiFetch('/api/menus/reorder', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ order }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
    }
    await reload();
  };

  const toggleChannel = (id: string) => {
    setChannels((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const toggleDay = (idx: number, day: number) => {
    setSchedule((prev) => prev.map((w, i) => {
      if (i !== idx) return w;
      const days = w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day];
      return { ...w, days };
    }));
  };

  const channelLabel = useCallback((id: string) => {
    const row = CHANNELS.find((c) => c.id === id);
    return isEn ? row?.en : row?.zh;
  }, [isEn]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{t('admin.menus')}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, maxWidth: 640 }}>
            {t('admin.menusHint')}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => startEdit(null)}>{t('common.add')}</button>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={shareStock} onChange={(e) => setShareStock(e.target.checked)} />
        {t('admin.menuCopyShareStock')}
      </label>

      {showForm && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>中文名称</label>
              <input className="input" value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>English name</label>
              <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>{t('admin.menuChannels')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {CHANNELS.map((ch) => (
              <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={channels.includes(ch.id)} onChange={() => toggleChannel(ch.id)} />
                {isEn ? ch.en : ch.zh}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>{t('admin.menuSchedule')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{t('admin.menuScheduleHint')}</div>
          {schedule.map((w, idx) => (
            <div key={idx} className="card" style={{ padding: 10, marginTop: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {DAYS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`btn ${w.days.includes(d.id) ? 'btn-primary' : 'btn-outline'}`}
                    style={{ minWidth: 36, padding: '4px 8px' }}
                    onClick={() => toggleDay(idx, d.id)}
                  >
                    {isEn ? d.en : d.zh}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input" type="time" value={w.start} onChange={(e) => setSchedule((prev) => prev.map((row, i) => i === idx ? { ...row, start: e.target.value } : row))} />
                <span>–</span>
                <input className="input" type="time" value={w.end} onChange={(e) => setSchedule((prev) => prev.map((row, i) => i === idx ? { ...row, end: e.target.value } : row))} />
                <button className="btn btn-ghost" type="button" onClick={() => setSchedule((prev) => prev.filter((_, i) => i !== idx))}>{t('common.delete')}</button>
              </div>
            </div>
          ))}
          <button className="btn btn-outline" style={{ marginTop: 8 }} type="button" onClick={() => setSchedule((prev) => [...prev, emptyWindow()])}>
            {t('admin.menuAddWindow')}
          </button>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => void handleSave()}>{t('common.save')}</button>
            <button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-light)', background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
          {t('admin.menuPriorityHint')}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 16px', textAlign: 'center', width: 50 }}>#</th>
              <th style={{ padding: '10px 16px', textAlign: 'left' }}>{t('admin.menus')}</th>
              <th style={{ padding: '10px 16px', textAlign: 'left' }}>{t('admin.menuChannels')}</th>
              <th style={{ padding: '10px 16px', textAlign: 'right' }}>{t('common.edit')}</th>
            </tr>
          </thead>
          <tbody>
            {menus.map((menu, idx) => (
              <tr
                key={menu._id}
                draggable
                onDragStart={() => { dragIdx.current = idx; }}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx); }}
                onDragLeave={() => setDragOverIdx(null)}
                onDrop={() => void handleDrop(idx)}
                onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
                style={{
                  borderBottom: '1px solid #f0f0f0',
                  cursor: 'grab',
                  background: dragOverIdx === idx ? '#E3F2FD' : 'transparent',
                }}
              >
                <td style={{ padding: '10px 16px', textAlign: 'center', color: 'var(--text-light)' }}>☰ {idx + 1}</td>
                <td style={{ padding: '10px 16px', fontWeight: 600 }}>
                  {adminMenuName(menu, i18n.language)}
                  {menu.isDefault ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>{t('admin.menuDefault')}</span> : null}
                </td>
                <td style={{ padding: '10px 16px' }}>
                  {(menu.channels || []).length === 0
                    ? t('admin.menuNoChannel')
                    : (menu.channels || []).map(channelLabel).join(' / ')}
                </td>
                <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMenuId(menu._id)}>{t('admin.menuUseForEdit')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => startEdit(menu)}>{t('common.edit')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => void handleCopy(menu._id)}>{t('admin.menuCopy')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => void handleDelete(menu)}>{t('common.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
