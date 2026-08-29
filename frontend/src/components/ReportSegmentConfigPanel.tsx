import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

export interface SegmentGroupRow {
  id?: string;
  sortOrder: number;
  nameZh: string;
  nameEn: string;
  categoryIds: string[];
}

interface CategoryRow {
  _id: string;
  nameZh: string;
  nameEn: string;
}

interface Props {
  canEdit: boolean;
  onSaved?: (payload: { enabled: boolean; groups: SegmentGroupRow[] }) => void;
  onLoaded?: (payload: { enabled: boolean; groups: SegmentGroupRow[] }) => void;
}

function emptyGroup(sortOrder: number): SegmentGroupRow {
  return { sortOrder, nameZh: '', nameEn: '', categoryIds: [] };
}

export default function ReportSegmentConfigPanel({ canEdit, onSaved, onLoaded }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [groups, setGroups] = useState<SegmentGroupRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/reports/segment-config');
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error?.message || '加载失败');
      setEnabled(!!j.enabled);
      setCategories(j.categories || []);
      const loadedGroups = (j.groups || []).length
        ? (j.groups as SegmentGroupRow[]).map((g, i) => ({
            id: g.id,
            sortOrder: g.sortOrder ?? i,
            nameZh: g.nameZh || '',
            nameEn: g.nameEn || '',
            categoryIds: g.categoryIds || [],
          }))
        : [emptyGroup(0)];
      setGroups(loadedGroups);
      onLoaded?.({ enabled: !!j.enabled, groups: loadedGroups });
    } catch (e) {
      alert(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [onLoaded]);

  useEffect(() => { void load(); }, [load]);

  const assignedElsewhere = (catId: string, groupIdx: number) =>
    groups.some((g, i) => i !== groupIdx && g.categoryIds.includes(catId));

  const addGroup = () => {
    setGroups((prev) => [...prev, emptyGroup(prev.length)]);
  };

  const removeGroup = (idx: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== idx).map((g, i) => ({ ...g, sortOrder: i })));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled,
        groups: groups.map((g, i) => ({
          sortOrder: i,
          translations: [
            { locale: 'zh-CN', name: g.nameZh.trim() },
            { locale: 'en-US', name: g.nameEn.trim() },
          ],
          categoryIds: g.categoryIds,
        })),
      };
      const res = await apiFetch('/api/reports/segment-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error?.message || '保存失败');
      const savedGroups = (j.groups || []).map((g: SegmentGroupRow, i: number) => ({
        id: g.id,
        sortOrder: g.sortOrder ?? i,
        nameZh: g.nameZh || '',
        nameEn: g.nameEn || '',
        categoryIds: g.categoryIds || [],
      }));
      setEnabled(!!j.enabled);
      setGroups(savedGroups.length ? savedGroups : [emptyGroup(0)]);
      onSaved?.({ enabled: !!j.enabled, groups: savedGroups });
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 16, color: '#888' }}>加载配置…</div>;
  }

  const configuredGroups = groups.filter((g) => g.nameZh.trim() || g.nameEn.trim() || g.categoryIds.length > 0);
  const statusText = enabled
    ? `已开通 · ${configuredGroups.length || groups.length} 个分组`
    : '未开通';

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>分组配置</h3>
          {!expanded && (
            <p style={{ fontSize: 13, color: '#666', margin: 0 }}>{statusText}</p>
          )}
        </div>
        <span style={{ fontSize: 13, color: '#888', marginLeft: 12, flexShrink: 0 }}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </span>
      </button>

      {expanded && (
        <>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 12, marginTop: 8 }}>
        将餐品目录划分为若干分组，用于统计各品类营业额占比。目录在各分组间互斥。
      </p>

      {!canEdit && (
        <p style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
          仅店铺 owner 账号可修改配置；当前为只读查看。
        </p>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 14 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        开通品类结构报表
      </label>

      {groups.map((g, idx) => (
        <div key={idx} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>分组 {idx + 1}</strong>
            {canEdit && groups.length > 1 && (
              <button type="button" className="btn btn-outline" style={{ fontSize: 11, padding: '2px 8px', color: '#c62828' }} onClick={() => removeGroup(idx)}>
                删除
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 12, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'block' }}>
                <span style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>中文名</span>
                <input
                  className="input"
                  placeholder="中文名"
                  value={g.nameZh}
                  disabled={!canEdit}
                  onChange={(e) => setGroups((prev) => prev.map((x, i) => i === idx ? { ...x, nameZh: e.target.value } : x))}
                  style={{ width: '100%' }}
                />
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>English name</span>
                <input
                  className="input"
                  placeholder="English name"
                  value={g.nameEn}
                  disabled={!canEdit}
                  onChange={(e) => setGroups((prev) => prev.map((x, i) => i === idx ? { ...x, nameEn: e.target.value } : x))}
                  style={{ width: '100%' }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>餐品目录（互斥）</div>
              <div style={{ flex: 1, minHeight: 88, maxHeight: 160, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 8 }}>
                {categories.map((c) => {
                  const checked = g.categoryIds.includes(c._id);
                  const disabled = !canEdit || (!checked && assignedElsewhere(c._id, idx));
                  return (
                    <label key={c._id} style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: disabled && !checked ? 0.45 : 1 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(e) => {
                          setGroups((prev) => prev.map((x, i) => {
                            if (i !== idx) return x;
                            const ids = new Set(x.categoryIds);
                            if (e.target.checked) ids.add(c._id);
                            else ids.delete(c._id);
                            return { ...x, categoryIds: [...ids] };
                          }));
                        }}
                        style={{ marginRight: 6 }}
                      />
                      {c.nameZh || c.nameEn} {c.nameEn && c.nameZh ? ` / ${c.nameEn}` : ''}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ))}

      {canEdit && (
        <>
          <button type="button" className="btn btn-outline" style={{ marginBottom: 16 }} onClick={addGroup}>+ 添加分组</button>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
