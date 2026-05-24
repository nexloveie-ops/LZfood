import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';

interface Translation { locale: string; name: string; }
interface Category { _id: string; translations: Translation[]; }
interface MenuItemRow { _id: string; categoryId: string; price: number; translations: Translation[]; }

interface OptionChoiceData { extraPrice?: number; originalPrice?: number; translations?: Translation[]; }
interface OptionGroupData { required?: boolean; minSelect?: number; maxSelect?: number; translations?: Translation[]; choices?: OptionChoiceData[]; }

interface TemplateDoc {
  _id: string;
  name: string;
  enabled: boolean;
  /** API may omit or shape differently until detail fetch */
  optionGroups?: unknown;
  updatedAt?: string;
}

interface RuleDoc {
  _id: string;
  templateId: string;
  enabled: boolean;
  priority: number;
  categoryIds: string[];
  menuItemIds: string[];
  excludedMenuItemIds: string[];
}

interface FormOptionChoice { nameZh: string; nameEn: string; extraPrice: number; originalPrice: number; }
interface FormOptionGroup { nameZh: string; nameEn: string; required: boolean; minSelect: number; maxSelect: number; choices: FormOptionChoice[]; }

const emptyTemplateForm = { _id: null as string | null, name: '', enabled: true, optionGroups: [] as FormOptionGroup[] };

/** Normalize Mongo _id from JSON (string or rare ObjectId / EJSON). */
function templateIdString(id: unknown): string {
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && '$oid' in (id as Record<string, unknown>)) {
    return String((id as { $oid: string }).$oid);
  }
  if (id != null && typeof (id as { toString?: () => string }).toString === 'function') {
    const s = (id as { toString: () => string }).toString();
    if (/^[a-f0-9]{24}$/i.test(s)) return s;
  }
  return id != null ? String(id) : '';
}

const emptyRuleForm = {
  _id: null as string | null,
  templateId: '',
  enabled: true,
  priority: 100,
  categoryIds: [] as string[],
  menuItemIds: [] as string[],
  excludedMenuItemIds: [] as string[],
};

function reorderList<T>(list: T[], fromIdx: number, toIdx: number): T[] {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

const dragHandleStyle: CSSProperties = {
  cursor: 'grab',
  color: 'var(--text-light)',
  fontSize: 16,
  lineHeight: 1,
  userSelect: 'none',
  padding: '2px 4px',
  flexShrink: 0,
};

/** Accept translation array or locale→name map from API / legacy data */
function normalizeTranslationsArray(raw: unknown): Translation[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is { locale?: unknown; name?: unknown } => x != null && typeof x === 'object')
      .map((x) => ({ locale: String(x.locale ?? ''), name: String(x.name ?? '') }))
      .filter((x) => x.locale);
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([locale, v]) => ({
      locale,
      name:
        typeof v === 'string'
          ? v
          : v != null && typeof v === 'object' && 'name' in (v as object)
            ? String((v as { name: unknown }).name ?? '')
            : String(v ?? ''),
    }));
  }
  return [];
}

function pickZhEnNames(tr: Translation[]): { nameZh: string; nameEn: string } {
  const list = tr;
  const byExact = (locales: string[]) => {
    for (const loc of locales) {
      const x = list.find((t) => t.locale === loc);
      const n = (x?.name ?? '').trim();
      if (n) return n;
    }
    return '';
  };
  let nameZh = byExact(['zh-CN', 'zh_CN', 'zh-Hans', 'zh']);
  if (!nameZh) {
    const z = list.find((t) => (t.locale || '').toLowerCase().startsWith('zh'));
    nameZh = (z?.name ?? '').trim();
  }
  if (!nameZh) nameZh = (list[0]?.name ?? '').trim();

  let nameEn = byExact(['en-US', 'en_GB', 'en']);
  if (!nameEn) {
    const e = list.find((t) => (t.locale || '').toLowerCase().startsWith('en'));
    nameEn = (e?.name ?? '').trim();
  }
  if (!nameEn) {
    const nonZh = list.find((t) => !(t.locale || '').toLowerCase().startsWith('zh'));
    nameEn = (nonZh?.name ?? '').trim();
  }
  if (!nameEn) nameEn = (list[1]?.name ?? '').trim();

  return { nameZh, nameEn };
}

function isGroupLikeObject(x: unknown): x is Record<string, unknown> {
  return (
    x != null &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    ('translations' in (x as object) || 'choices' in (x as object) || 'required' in (x as object) || 'minSelect' in (x as object))
  );
}

/**
 * Mongo / legacy saves sometimes nest as [[{ group }]] instead of [{ group }].
 * Flatten until we have a list of group-shaped objects.
 */
function unwrapOptionGroupRows(rows: unknown[]): unknown[] {
  function inner(rs: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const row of rs) {
      if (!Array.isArray(row)) {
        if (isGroupLikeObject(row)) out.push(row);
        continue;
      }
      if (row.length === 0) continue;
      if (row.every(isGroupLikeObject)) {
        out.push(...row);
        continue;
      }
      out.push(...inner(row));
    }
    return out;
  }
  return inner(rows);
}

/** Coerce API / DB optionGroups into a stable shape (arrays, locale fallbacks, numeric-key objects). */
function coerceOptionGroupsFromApi(raw: unknown): OptionGroupData[] {
  if (raw == null) return [];
  let rows: unknown[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    rows = keys.length > 0 ? keys.map((k) => o[k]) : [];
  } else return [];

  rows = unwrapOptionGroupRows(rows);

  const out: OptionGroupData[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const g = row as Record<string, unknown>;
    let translations = normalizeTranslationsArray(g.translations);
    if (translations.length === 0 && (typeof g.nameZh === 'string' || typeof g.nameEn === 'string')) {
      translations = [
        { locale: 'zh-CN', name: String(g.nameZh ?? '') },
        { locale: 'en-US', name: String(g.nameEn ?? '') },
      ];
    }
    let choicesIn: unknown[] = [];
    if (Array.isArray(g.choices)) choicesIn = g.choices;
    else if (g.choices && typeof g.choices === 'object') {
      const c = g.choices as Record<string, unknown>;
      const ck = Object.keys(c)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b));
      if (ck.length > 0) choicesIn = ck.map((k) => c[k]);
    }
    const choices: OptionChoiceData[] = choicesIn
      .filter((c) => c != null && typeof c === 'object')
      .map((c) => {
        const ch = c as Record<string, unknown>;
        let ctr = normalizeTranslationsArray(ch.translations);
        if (ctr.length === 0 && (typeof ch.nameZh === 'string' || typeof ch.nameEn === 'string')) {
          ctr = [
            { locale: 'zh-CN', name: String(ch.nameZh ?? '') },
            { locale: 'en-US', name: String(ch.nameEn ?? '') },
          ];
        }
        return {
          extraPrice: typeof ch.extraPrice === 'number' ? ch.extraPrice : 0,
          originalPrice: typeof ch.originalPrice === 'number' ? ch.originalPrice : undefined,
          translations: ctr,
        };
      });
    const minSel =
      typeof (g as Record<string, unknown>).minSelect === 'number' && Number.isFinite((g as Record<string, unknown>).minSelect as number)
        ? Math.max(0, Math.floor((g as Record<string, unknown>).minSelect as number))
        : 0;
    const maxSel =
      typeof (g as Record<string, unknown>).maxSelect === 'number' && Number.isFinite((g as Record<string, unknown>).maxSelect as number)
        ? Math.max(0, Math.floor((g as Record<string, unknown>).maxSelect as number))
        : 0;
    out.push({ required: !!g.required, minSelect: minSel, maxSelect: maxSel, translations, choices });
  }
  return out;
}

function toFormGroups(raw: unknown): FormOptionGroup[] {
  return coerceOptionGroupsFromApi(raw).map((g) => {
    const { nameZh, nameEn } = pickZhEnNames(g.translations ?? []);
    let choices = (g.choices ?? []).map((c) => {
      const names = pickZhEnNames(c.translations ?? []);
      return {
        ...names,
        extraPrice: typeof c.extraPrice === 'number' ? c.extraPrice : 0,
        originalPrice: typeof c.originalPrice === 'number' ? c.originalPrice : 0,
      };
    });
    if (choices.length === 0) {
      choices = [{ nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0 }];
    }
    return { nameZh, nameEn, required: !!g.required, minSelect: g.minSelect ?? 0, maxSelect: g.maxSelect ?? 0, choices };
  });
}

function fromFormGroups(groups: FormOptionGroup[]): OptionGroupData[] {
  return groups.map((g) => ({
    required: g.required,
    ...(!g.required ? { minSelect: Math.max(0, Math.floor(Number(g.minSelect) || 0)), maxSelect: Math.max(0, Math.floor(Number(g.maxSelect) || 0)) } : {}),
    translations: [
      { locale: 'zh-CN', name: g.nameZh },
      { locale: 'en-US', name: g.nameEn },
    ],
    choices: g.choices.map((c) => ({
      extraPrice: c.extraPrice,
      originalPrice: c.originalPrice || undefined,
      translations: [
        { locale: 'zh-CN', name: c.nameZh },
        { locale: 'en-US', name: c.nameEn },
      ],
    })),
  }));
}

export default function OptionGroupTemplates() {
  const { t, i18n } = useTranslation();
  const { token } = useAuth();
  const lang = i18n.language;

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);

  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [templates, setTemplates] = useState<TemplateDoc[]>([]);
  const [rules, setRules] = useState<RuleDoc[]>([]);

  const [templateForm, setTemplateForm] = useState(emptyTemplateForm);
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [filter, setFilter] = useState('');

  const groupDragFromRef = useRef<number | null>(null);
  const [groupDragOverIdx, setGroupDragOverIdx] = useState<number | null>(null);
  const choiceDragFromRef = useRef<{ gi: number; ci: number } | null>(null);
  const [choiceDragOver, setChoiceDragOver] = useState<{ gi: number; ci: number } | null>(null);

  const getName = (translations: Translation[]) => {
    const found = translations.find((t2) => t2.locale === lang) || translations[0];
    return found?.name || '';
  };

  const fetchAll = useCallback(async () => {
    const [catRes, itemRes, tplRes, ruleRes] = await Promise.all([
      apiFetch('/api/menu/categories', { headers: { Authorization: `Bearer ${token}` } }),
      apiFetch('/api/menu/items?ownOptionGroups=1', { headers: { Authorization: `Bearer ${token}` } }),
      apiFetch('/api/admin/option-group-templates', { headers: { Authorization: `Bearer ${token}` } }),
      apiFetch('/api/admin/option-group-templates/rules', { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (catRes.ok) setCategories(await catRes.json());
    if (itemRes.ok) setMenuItems(await itemRes.json());
    if (tplRes.ok) setTemplates(await tplRes.json());
    if (ruleRes.ok) setRules(await ruleRes.json());
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return menuItems;
    return menuItems.filter((i) => getName(i.translations).toLowerCase().includes(q));
  }, [menuItems, filter, lang]);

  const toggleInList = (list: string[], id: string, on: boolean) => {
    const set = new Set(list);
    if (on) set.add(id);
    else set.delete(id);
    return Array.from(set);
  };

  // --- Template editor helpers (same behavior as MenuItemManager) ---
  const addTemplateGroup = () => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: [...prev.optionGroups, { nameZh: '', nameEn: '', required: false, minSelect: 0, maxSelect: 0, choices: [{ nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0 }] }],
    }));
  };
  const removeTemplateGroup = (gi: number) => {
    setTemplateForm((prev) => ({ ...prev, optionGroups: prev.optionGroups.filter((_, i) => i !== gi) }));
  };
  const updateTemplateGroup = (gi: number, field: string, value: unknown) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) => (i === gi ? { ...g, [field]: value } : g)),
    }));
  };
  const addTemplateChoice = (gi: number) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: [...g.choices, { nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0 }] } : g,
      ),
    }));
  };
  const removeTemplateChoice = (gi: number, ci: number) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: g.choices.filter((_, j) => j !== ci) } : g,
      ),
    }));
  };
  const updateTemplateChoice = (gi: number, ci: number, field: string, value: unknown) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: g.choices.map((c, j) => (j === ci ? { ...c, [field]: value } : c)) } : g,
      ),
    }));
  };

  const moveTemplateGroup = (fromIdx: number, toIdx: number) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: reorderList(prev.optionGroups, fromIdx, toIdx),
    }));
  };

  const moveTemplateChoice = (gi: number, fromCi: number, toCi: number) => {
    setTemplateForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i === gi ? { ...g, choices: reorderList(g.choices, fromCi, toCi) } : g,
      ),
    }));
  };

  const handleGroupDragStart = (idx: number) => {
    groupDragFromRef.current = idx;
  };

  const handleGroupDragOver = (e: DragEvent, idx: number) => {
    e.preventDefault();
    setGroupDragOverIdx(idx);
  };

  const handleGroupDrop = (targetIdx: number) => {
    const fromIdx = groupDragFromRef.current;
    groupDragFromRef.current = null;
    setGroupDragOverIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;
    moveTemplateGroup(fromIdx, targetIdx);
  };

  const handleGroupDragEnd = () => {
    groupDragFromRef.current = null;
    setGroupDragOverIdx(null);
  };

  const handleChoiceDragStart = (gi: number, ci: number) => {
    choiceDragFromRef.current = { gi, ci };
  };

  const handleChoiceDragOver = (e: DragEvent, gi: number, ci: number) => {
    e.preventDefault();
    setChoiceDragOver({ gi, ci });
  };

  const handleChoiceDrop = (gi: number, targetCi: number) => {
    const from = choiceDragFromRef.current;
    choiceDragFromRef.current = null;
    setChoiceDragOver(null);
    if (!from || from.gi !== gi || from.ci === targetCi) return;
    moveTemplateChoice(gi, from.ci, targetCi);
  };

  const handleChoiceDragEnd = () => {
    choiceDragFromRef.current = null;
    setChoiceDragOver(null);
  };

  const saveTemplate = async () => {
    setSavingTemplate(true);
    try {
      for (let gi = 0; gi < templateForm.optionGroups.length; gi++) {
        const g = templateForm.optionGroups[gi];
        if (!g.choices?.length) {
          alert(`选项组 #${gi + 1} 须至少包含一个选项`);
          setSavingTemplate(false);
          return;
        }
        if (!g.required) {
          const minS = Math.max(0, Math.floor(Number(g.minSelect) || 0));
          const maxS = Math.max(0, Math.floor(Number(g.maxSelect) || 0));
          if (maxS > 0 && minS > maxS) {
            alert(`选项组 #${gi + 1}：最少选择数不能大于最多选择数`);
            setSavingTemplate(false);
            return;
          }
          if (minS > g.choices.length) {
            alert(`选项组 #${gi + 1}：最少选择数不能大于选项个数`);
            setSavingTemplate(false);
            return;
          }
          if (maxS > 0 && maxS > g.choices.length) {
            alert(`选项组 #${gi + 1}：最多选择数不能大于选项个数`);
            setSavingTemplate(false);
            return;
          }
        }
      }
      const body = {
        name: templateForm.name,
        enabled: templateForm.enabled,
        optionGroups: fromFormGroups(templateForm.optionGroups),
      };
      const res = templateForm._id
        ? await apiFetch(`/api/admin/option-group-templates/${encodeURIComponent(templateForm._id)}`, { method: 'PUT', headers, body: JSON.stringify(body) })
        : await apiFetch('/api/admin/option-group-templates', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || '保存失败');
        return;
      }
      setTemplateForm(emptyTemplateForm);
      setTemplateEditorOpen(false);
      fetchAll();
    } catch {
      alert('保存失败');
    } finally {
      setSavingTemplate(false);
    }
  };

  const deleteTemplate = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/admin/option-group-templates/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
      return;
    }
    setTemplateForm(emptyTemplateForm);
    setTemplateEditorOpen(false);
    fetchAll();
  };

  const saveRule = async () => {
    setSavingRule(true);
    try {
      if (!ruleForm.templateId) {
        alert('请选择模板');
        setSavingRule(false);
        return;
      }
      if (ruleForm.categoryIds.length === 0 && ruleForm.menuItemIds.length === 0) {
        alert('请至少选择一个分类或菜品');
        setSavingRule(false);
        return;
      }
      const body = {
        templateId: ruleForm.templateId,
        enabled: ruleForm.enabled,
        priority: Number(ruleForm.priority),
        categoryIds: ruleForm.categoryIds,
        menuItemIds: ruleForm.menuItemIds,
        excludedMenuItemIds: ruleForm.excludedMenuItemIds,
      };
      const res = ruleForm._id
        ? await apiFetch(`/api/admin/option-group-templates/rules/${encodeURIComponent(ruleForm._id)}`, { method: 'PUT', headers, body: JSON.stringify(body) })
        : await apiFetch('/api/admin/option-group-templates/rules', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error?.message || '保存失败');
        return;
      }
      setRuleForm(emptyRuleForm);
      setRuleEditorOpen(false);
      fetchAll();
    } catch {
      alert('保存失败');
    } finally {
      setSavingRule(false);
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm(t('common.confirm') + '?')) return;
    const res = await apiFetch(`/api/admin/option-group-templates/rules/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error?.message || t('common.error'));
      return;
    }
    setRuleForm(emptyRuleForm);
    setRuleEditorOpen(false);
    fetchAll();
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{t('admin.optionGroupTemplatesTitle')}</h2>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{t('admin.optionGroupTemplates')}</div>
          <button
            className="btn btn-outline"
            style={{ fontSize: 12 }}
            onClick={() => {
              setTemplateForm({ _id: null, name: '', enabled: true, optionGroups: [] });
              setTemplateEditorOpen(true);
            }}
          >
            + {t('common.add')}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {templates.map((tpl) => (
            <button
              key={templateIdString(tpl._id)}
              className="btn btn-ghost"
              style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 999, padding: '6px 10px' }}
              onClick={async () => {
                const tid = templateIdString(tpl._id);
                if (!tid) return;
                setTemplateEditorOpen(true);
                setTemplateForm({
                  _id: tid,
                  name: tpl.name,
                  enabled: tpl.enabled,
                  optionGroups: toFormGroups(tpl.optionGroups),
                });
                try {
                  const res = await apiFetch(`/api/admin/option-group-templates/${encodeURIComponent(tid)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (!res.ok) return;
                  const data = (await res.json()) as { name?: string; enabled?: boolean; optionGroups?: unknown };
                  setTemplateForm({
                    _id: tid,
                    name: typeof data.name === 'string' ? data.name : tpl.name,
                    enabled: typeof data.enabled === 'boolean' ? data.enabled : tpl.enabled,
                    optionGroups: toFormGroups(data.optionGroups),
                  });
                } catch {
                  /* keep list snapshot */
                }
              }}
            >
              {tpl.name}{tpl.enabled ? '' : ` (${t('admin.enabledOff')})`}
            </button>
          ))}
        </div>

        {templateEditorOpen && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 10, alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.templateName')}</label>
                <input className="input" value={templateForm.name} onChange={(e) => setTemplateForm((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.enabled')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40 }}>
                  <input type="checkbox" checked={templateForm.enabled} onChange={(e) => setTemplateForm((p) => ({ ...p, enabled: e.target.checked }))} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{templateForm.enabled ? t('admin.enabledOn') : t('admin.enabledOff')}</span>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                {templateForm._id && (
                  <button className="btn btn-outline" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => deleteTemplate(templateForm._id!)}>
                    {t('common.delete')}
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{t('admin.optionGroups')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                    ☰ {t('admin.dragToReorder', { defaultValue: 'Drag handle to reorder groups and choices' })}
                  </div>
                </div>
                <button className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }} onClick={addTemplateGroup}>
                  + {t('admin.addOptionGroup')}
                </button>
              </div>

              {templateForm.optionGroups.map((group, gi) => (
                <div
                  key={gi}
                  onDragOver={(e) => handleGroupDragOver(e, gi)}
                  onDragLeave={() => setGroupDragOverIdx(null)}
                  onDrop={() => handleGroupDrop(gi)}
                  style={{
                    background: groupDragOverIdx === gi ? '#E3F2FD' : 'var(--bg)',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 10,
                    border: `1px solid ${groupDragOverIdx === gi ? '#90CAF9' : 'var(--border)'}`,
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        draggable
                        onDragStart={() => handleGroupDragStart(gi)}
                        onDragEnd={handleGroupDragEnd}
                        style={dragHandleStyle}
                        title={t('admin.dragToReorder', { defaultValue: 'Drag to reorder' })}
                        aria-hidden
                      >
                        ☰
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>#{gi + 1}</span>
                    </div>
                    <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red-primary)' }} onClick={() => removeTemplateGroup(gi)}>
                      {t('common.delete')}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.groupName')} (中文)</label>
                      <input className="input" value={group.nameZh} onChange={(e) => updateTemplateGroup(gi, 'nameZh', e.target.value)} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.groupName')} (EN)</label>
                      <input className="input" value={group.nameEn} onChange={(e) => updateTemplateGroup(gi, 'nameEn', e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={group.required}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setTemplateForm((prev) => ({
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
                          onChange={(e) => updateTemplateGroup(gi, 'minSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
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
                          onChange={(e) => updateTemplateGroup(gi, 'maxSelect', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        />
                      </div>
                    </div>
                  )}

                  {group.choices.map((choice, ci) => {
                    const choiceDropActive = choiceDragOver?.gi === gi && choiceDragOver.ci === ci;
                    return (
                    <div
                      key={ci}
                      onDragOver={(e) => handleChoiceDragOver(e, gi, ci)}
                      onDragLeave={() => setChoiceDragOver(null)}
                      onDrop={() => handleChoiceDrop(gi, ci)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr 1fr 90px 90px auto',
                        gap: 6,
                        marginBottom: 4,
                        alignItems: 'center',
                        borderRadius: 6,
                        background: choiceDropActive ? '#E3F2FD' : 'transparent',
                        outline: choiceDropActive ? '1px solid #90CAF9' : 'none',
                      }}
                    >
                      <span
                        draggable
                        onDragStart={() => handleChoiceDragStart(gi, ci)}
                        onDragEnd={handleChoiceDragEnd}
                        style={dragHandleStyle}
                        title={t('admin.dragToReorder', { defaultValue: 'Drag to reorder' })}
                        aria-hidden
                      >
                        ☰
                      </span>
                      <input className="input" placeholder={`${t('admin.choiceName')} (中文)`} value={choice.nameZh} onChange={(e) => updateTemplateChoice(gi, ci, 'nameZh', e.target.value)} style={{ fontSize: 12 }} />
                      <input className="input" placeholder={`${t('admin.choiceName')} (EN)`} value={choice.nameEn} onChange={(e) => updateTemplateChoice(gi, ci, 'nameEn', e.target.value)} style={{ fontSize: 12 }} />
                      <input className="input" type="number" placeholder={t('admin.originalPrice')} value={choice.originalPrice || ''} onChange={(e) => updateTemplateChoice(gi, ci, 'originalPrice', Number(e.target.value))} style={{ fontSize: 12 }} />
                      <input className="input" type="number" placeholder={t('admin.extraPrice')} value={choice.extraPrice} onChange={(e) => updateTemplateChoice(gi, ci, 'extraPrice', Number(e.target.value))} style={{ fontSize: 12 }} />
                      <button className="btn btn-ghost" style={{ fontSize: 14, color: 'var(--red-primary)' }} onClick={() => removeTemplateChoice(gi, ci)}>✕</button>
                    </div>
                    );
                  })}
                  <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 4 }} onClick={() => addTemplateChoice(gi)}>
                    + {t('admin.addChoice')}
                  </button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary" onClick={saveTemplate} disabled={savingTemplate}>
                  {savingTemplate ? t('common.loading') : t('common.save')}
                </button>
                <button className="btn btn-outline" onClick={() => { setTemplateForm(emptyTemplateForm); setTemplateEditorOpen(false); }}>{t('common.cancel')}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{t('admin.optionGroupTemplateRules')}</div>
          <button
            className="btn btn-outline"
            style={{ fontSize: 12 }}
            disabled={templates.length === 0}
            onClick={() => {
              setRuleForm({ ...emptyRuleForm, templateId: templateIdString(templates[0]?._id) });
              setRuleEditorOpen(true);
            }}
          >
            + {t('common.add')}
          </button>
        </div>

        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: 8, textAlign: 'left' }}>{t('admin.priority')}</th>
                <th style={{ padding: 8, textAlign: 'left' }}>{t('admin.template')}</th>
                <th style={{ padding: 8, textAlign: 'left' }}>{t('admin.categories')}</th>
                <th style={{ padding: 8, textAlign: 'left' }}>{t('admin.targetMenuItems')}</th>
                <th style={{ padding: 8, textAlign: 'left' }}>{t('admin.excludedItems')}</th>
                <th style={{ padding: 8, textAlign: 'center' }}>{t('admin.enabled')}</th>
                <th style={{ padding: 8, textAlign: 'right' }}>{t('common.edit')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const rid = templateIdString(r.templateId);
                const tplName = templates.find((x) => templateIdString(x._id) === rid)?.name || rid;
                return (
                  <tr key={templateIdString(r._id)} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 8 }}>{r.priority}</td>
                    <td style={{ padding: 8 }}>{tplName}</td>
                    <td style={{ padding: 8 }}>{r.categoryIds.length}</td>
                    <td style={{ padding: 8 }}>{r.menuItemIds.length}</td>
                    <td style={{ padding: 8 }}>{r.excludedMenuItemIds.length}</td>
                    <td style={{ padding: 8, textAlign: 'center' }}>{r.enabled ? '✓' : '—'}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>
                      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => {
                        setRuleForm({
                          _id: templateIdString(r._id),
                          templateId: templateIdString(r.templateId),
                          enabled: r.enabled,
                          priority: r.priority,
                          categoryIds: r.categoryIds || [],
                          menuItemIds: r.menuItemIds || [],
                          excludedMenuItemIds: r.excludedMenuItemIds || [],
                        });
                        setRuleEditorOpen(true);
                      }}>{t('common.edit')}</button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => deleteRule(templateIdString(r._id))}>{t('common.delete')}</button>
                    </td>
                  </tr>
                );
              })}
              {rules.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: 'var(--text-light)' }}>{t('admin.noRules')}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {ruleEditorOpen && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.template')}</label>
                <select className="input" value={ruleForm.templateId} onChange={(e) => setRuleForm((p) => ({ ...p, templateId: e.target.value }))}>
                  <option value="">{t('admin.pickTemplate')}</option>
                  {templates.map((tpl) => {
                    const optId = templateIdString(tpl._id);
                    return <option key={optId} value={optId}>{tpl.name}</option>;
                  })}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.priority')}</label>
                <input className="input" type="number" value={ruleForm.priority} onChange={(e) => setRuleForm((p) => ({ ...p, priority: Number(e.target.value) }))} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('admin.enabled')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40 }}>
                  <input type="checkbox" checked={ruleForm.enabled} onChange={(e) => setRuleForm((p) => ({ ...p, enabled: e.target.checked }))} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ruleForm.enabled ? t('admin.enabledOn') : t('admin.enabledOff')}</span>
                </label>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('admin.ruleTargetsHelp')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>{t('admin.categories')}</div>
                  <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                    {categories.map((c) => {
                      const checked = ruleForm.categoryIds.includes(c._id);
                      return (
                        <label key={c._id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setRuleForm((p) => ({ ...p, categoryIds: toggleInList(p.categoryIds, c._id, e.target.checked) }))}
                          />
                          <span>{getName(c.translations)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>{t('admin.targetMenuItems')}</div>
                  <input className="input" placeholder={t('admin.itemFilter')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
                  <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                    {filteredItems.map((i) => {
                      const checked = ruleForm.menuItemIds.includes(i._id);
                      return (
                        <label key={i._id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setRuleForm((p) => ({ ...p, menuItemIds: toggleInList(p.menuItemIds, i._id, e.target.checked) }))}
                          />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getName(i.translations)}</span>
                          <span style={{ color: 'var(--text-light)', flexShrink: 0 }}>€{i.price}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('admin.excludedItems')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>{t('admin.excludedItemsHelp')}</div>
              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                {menuItems.map((i) => {
                  const checked = ruleForm.excludedMenuItemIds.includes(i._id);
                  return (
                    <label key={i._id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setRuleForm((p) => ({ ...p, excludedMenuItemIds: toggleInList(p.excludedMenuItemIds, i._id, e.target.checked) }))}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getName(i.translations)}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary" onClick={saveRule} disabled={savingRule}>
                {savingRule ? t('common.loading') : t('common.save')}
              </button>
              <button className="btn btn-outline" onClick={() => { setRuleForm(emptyRuleForm); setRuleEditorOpen(false); }}>{t('common.cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
