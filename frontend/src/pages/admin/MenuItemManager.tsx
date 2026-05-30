import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import {
  buildPurchaseUnitPayload,
  splitPurchaseUnitLabels,
} from '../../utils/purchaseUnitLabel';
import { CONSUMPTION_QTY_MIN, roundConsumptionQty } from '../../utils/consumptionQty';
import BomQtyInput from '../../components/admin/BomQtyInput';

interface Translation { locale: string; name: string; description?: string; }
interface Category { _id: string; sortOrder?: number; translations: Translation[]; }
interface AllergenData { _id: string; name: string; icon: string; translations: { locale: string; name: string }[]; }
interface BoMEntryData { rawMaterialId: string; qty: number; }
interface OptionChoiceData { _id?: string; extraPrice: number; originalPrice?: number; translations: { locale: string; name: string }[]; consumption?: BoMEntryData[]; }
interface OptionGroupData { _id?: string; required?: boolean; minSelect?: number; maxSelect?: number; translations: { locale: string; name: string }[]; choices: OptionChoiceData[]; }
interface InventoryPurchaseUnit { code: string; label: string; factorToBase: number; translations?: { locale: string; label: string }[]; }
interface InventorySubdoc {
  baseUnit?: string;
  perServing?: number;
  purchaseUnits?: InventoryPurchaseUnit[];
  currentQty?: number;
  reorderFrequencyDays?: number;
  estimatedDailySales?: number;
}
interface MenuItem {
  _id: string; categoryId: string; price: number; calories?: number;
  avgWaitMinutes?: number; photoUrl?: string; arFileUrl?: string;
  isSoldOut?: boolean; translations: Translation[]; allergenIds?: string[];
  optionGroups?: OptionGroupData[];
  inventoryTracked?: boolean;
  inventory?: InventorySubdoc;
  consumption?: BoMEntryData[];
}

interface RawMaterialOption {
  _id: string;
  baseUnit: string;
  translations: { locale: string; name: string }[];
}

type TrackingMode = 'off' | 'finished' | 'raw';

interface FormOptionChoice { _id?: string; nameZh: string; nameEn: string; extraPrice: number; originalPrice: number; consumption: BoMEntryData[]; }
interface FormOptionGroup { _id?: string; nameZh: string; nameEn: string; required: boolean; minSelect: number; maxSelect: number; choices: FormOptionChoice[]; }
interface FormInventoryUnit { code: string; label: string; labelEn: string; factorToBase: number; }

const emptyForm = {
  categoryId: '',
  price: 0,
  calories: 0,
  avgWaitMinutes: 0,
  nameZh: '',
  nameEn: '',
  descZh: '',
  descEn: '',
  allergenIds: [] as string[],
  optionGroups: [] as FormOptionGroup[],
  inventoryTracked: false,
  invBaseUnit: '',
  invPerServing: 1,
  invPurchaseUnits: [] as FormInventoryUnit[],
  invReorderFrequencyDays: 3,
  trackingMode: 'off' as TrackingMode,
  itemConsumption: [] as BoMEntryData[],
};

export default function MenuItemManager() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canTrackInventory = hasFeature('inventory.tracking');
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [allergens, setAllergens] = useState<AllergenData[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingDailySales, setEditingDailySales] = useState<{ daily: number; basis: 'history' | 'estimate' | 'mixed'; windowDays: number } | null>(null);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialOption[]>([]);
  const bomFlushersRef = useRef(new Set<() => number>());
  const formSnapshotRef = useRef(form);

  useEffect(() => {
    formSnapshotRef.current = form;
  }, [form]);

  const registerBomFlush = useCallback((fn: () => number) => {
    bomFlushersRef.current.add(fn);
    return () => { bomFlushersRef.current.delete(fn); };
  }, []);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchData = useCallback(async () => {
    const requests: Promise<Response>[] = [
      apiFetch('/api/menu/categories', { headers: authHeaders }),
      apiFetch('/api/menu/items?ownOptionGroups=1', { headers: authHeaders }),
      apiFetch('/api/allergens', { headers: authHeaders }),
    ];
    if (canTrackInventory) {
      requests.push(apiFetch('/api/raw-materials', { headers: authHeaders }));
    }
    const responses = await Promise.all(requests);
    const [catRes, itemRes, allergenRes, rmRes] = responses;
    if (catRes.ok) {
      const cats: Category[] = await catRes.json();
      cats.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setCategories(cats);
    }
    if (itemRes.ok) setItems(await itemRes.json());
    if (allergenRes.ok) setAllergens(await allergenRes.json());
    if (rmRes?.ok) {
      const rms = (await rmRes.json()) as Array<{ _id: string; baseUnit?: string; translations?: { locale: string; name: string }[]; enabled?: boolean }>;
      setRawMaterials(
        rms
          .filter((r) => r.enabled !== false)
          .map((r) => ({ _id: r._id, baseUnit: r.baseUnit || '', translations: r.translations || [] })),
      );
    }
  }, [token, canTrackInventory]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /**
   * 按菜品目录 sortOrder 分组。
   * - 目录已删但 item 仍引用旧 categoryId（脏数据） → 归到尾部「其它」分组
   * - 没有 categoryId 的孤儿 item 同样落入「其它」
   * - 表格列宽全局共享，所以每组用独立 `<tbody>`，组首插一行 colSpan 7 的分组标题，
   *   保持列对齐的同时也能视觉上分隔
   */
  const groups = useMemo(() => {
    const byCat = new Map<string, MenuItem[]>();
    for (const it of items) {
      const key = it.categoryId || '__uncategorized__';
      const arr = byCat.get(key) || [];
      arr.push(it);
      byCat.set(key, arr);
    }
    const sortedGroups: Array<{ id: string; name: string; nameAlt: string; items: MenuItem[] }> = [];
    const seen = new Set<string>();
    for (const cat of categories) {
      const list = byCat.get(cat._id);
      if (!list || list.length === 0) continue;
      sortedGroups.push({
        id: cat._id,
        name: cat.translations.find(tr => tr.locale === 'zh-CN')?.name || cat.translations[0]?.name || '',
        nameAlt: cat.translations.find(tr => tr.locale === 'en-US')?.name || '',
        items: list,
      });
      seen.add(cat._id);
    }
    const orphanItems: MenuItem[] = [];
    for (const [cid, list] of byCat) {
      if (cid === '__uncategorized__' || seen.has(cid)) continue;
      orphanItems.push(...list);
    }
    const tail = [...orphanItems, ...(byCat.get('__uncategorized__') || [])];
    if (tail.length > 0) {
      sortedGroups.push({
        id: '__uncategorized__',
        name: t('admin.uncategorized', { defaultValue: '其它' }),
        nameAlt: '',
        items: tail,
      });
    }
    return sortedGroups;
  }, [items, categories, t]);

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
          required: !!g.required,
          minSelect: Math.max(0, Math.floor(Number((g as { minSelect?: number }).minSelect) || 0)),
          maxSelect: Math.max(0, Math.floor(Number((g as { maxSelect?: number }).maxSelect) || 0)),
          choices: choiceRows.map(c => ({
            _id: c._id != null ? String(c._id) : undefined,
            nameZh: c.translations.find(t2 => t2.locale === 'zh-CN')?.name || '',
            nameEn: c.translations.find(t2 => t2.locale === 'en-US')?.name || '',
            extraPrice: typeof c.extraPrice === 'number' && Number.isFinite(c.extraPrice) ? c.extraPrice : 0,
            originalPrice:
              typeof c.originalPrice === 'number' && Number.isFinite(c.originalPrice) ? c.originalPrice : 0,
            consumption: (c.consumption || [])
              .filter((x) => x && typeof x === 'object')
              .map((x) => ({
                rawMaterialId: String((x as { rawMaterialId?: unknown }).rawMaterialId ?? ''),
                qty: roundConsumptionQty((x as { qty?: unknown }).qty),
              }))
              .filter((x) => x.rawMaterialId && Number.isFinite(x.qty) && x.qty >= CONSUMPTION_QTY_MIN),
          })),
        };
      });
      const inv = item.inventory || {};
      const itemConsumption: BoMEntryData[] = (item.consumption || [])
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({
          rawMaterialId: String(x.rawMaterialId || ''),
          qty: roundConsumptionQty(x.qty),
        }))
        .filter((x) => x.rawMaterialId && Number.isFinite(x.qty) && x.qty >= CONSUMPTION_QTY_MIN);
      const initialMode: TrackingMode = item.inventoryTracked
        ? 'finished'
        : (itemConsumption.length > 0 || optionGroups.some((g) => g.choices.some((c) => c.consumption.length > 0)))
          ? 'raw'
          : 'off';
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
        inventoryTracked: !!item.inventoryTracked,
        invBaseUnit: inv.baseUnit || '',
        invPerServing: Math.max(1, Math.floor(Number(inv.perServing) || 1)),
        invPurchaseUnits: (inv.purchaseUnits || []).map((u) => {
          const { labelZh, labelEn } = splitPurchaseUnitLabels(u);
          return {
            code: String(u.code || ''),
            label: labelZh,
            labelEn,
            factorToBase: Math.max(1, Math.floor(Number(u.factorToBase) || 1)),
          };
        }),
        invReorderFrequencyDays: Math.max(1, Math.floor(Number(inv.reorderFrequencyDays) || 3)),
        trackingMode: initialMode,
        itemConsumption,
      });
      setEditingId(item._id);
      setEditingDailySales(null);
      if (canTrackInventory) {
        void (async () => {
          try {
            const res = await apiFetch(`/api/inventory/${item._id}/daily-sales`, { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              setEditingDailySales({
                daily: Number(data.daily) || 0,
                basis: (data.basis === 'history' ? 'history' : 'estimate') as 'history' | 'estimate' | 'mixed',
                windowDays: Math.max(1, Number(data.windowDays) || 14),
              });
            }
          } catch { /* ignore */ }
        })();
      }
    } else {
      setForm({ ...emptyForm, categoryId: categories[0]?._id || '' });
      setEditingId(null);
      setEditingDailySales(null);
    }
    setShowForm(true);
  };

  const handleSave = async () => {
    flushSync(() => {
      for (const flush of bomFlushersRef.current) flush();
    });
    const saveForm = formSnapshotRef.current;
    for (let gi = 0; gi < saveForm.optionGroups.length; gi++) {
      if (!saveForm.optionGroups[gi].choices?.length) {
        alert(`选项组 #${gi + 1} 须至少包含一个选项`);
        return;
      }
      const g = saveForm.optionGroups[gi];
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
    const trackFinished = canTrackInventory && editingId && form.trackingMode === 'finished';
    if (trackFinished) {
      const seenCodes = new Set<string>();
      for (let pi = 0; pi < form.invPurchaseUnits.length; pi++) {
        const u = form.invPurchaseUnits[pi];
        if (!u.code.trim()) { alert(`进货单位 #${pi + 1} 代码必填`); return; }
        if (!u.label.trim() && !u.labelEn.trim()) { alert(`进货单位 #${pi + 1} 中/英文名称至少填一项`); return; }
        if (!Number.isFinite(u.factorToBase) || u.factorToBase < 1) {
          alert(`进货单位 #${pi + 1} 换算系数必须为 ≥1 的整数`); return;
        }
        if (seenCodes.has(u.code)) { alert(`进货单位 code 重复：${u.code}`); return; }
        seenCodes.add(u.code);
      }
    }
    /** A/B 互斥前端预校验：raw 模式禁止 inventoryTracked，finished 模式禁止所有 consumption 非空 */
    const anyChoiceConsumption = saveForm.optionGroups.some((g) => g.choices.some((c) => c.consumption.length > 0));
    if (saveForm.trackingMode === 'finished' && (saveForm.itemConsumption.length > 0 || anyChoiceConsumption)) {
      alert(t('admin.bomMutexError', { defaultValue: 'A 模式与 B 模式互斥；请先清空 BoM 配置后再启用成品库存追踪' }));
      return;
    }

    const cleanBom = (rows: BoMEntryData[]): BoMEntryData[] => rows
      .map((r) => ({ rawMaterialId: r.rawMaterialId.trim(), qty: roundConsumptionQty(r.qty) }))
      .filter((r) => r.rawMaterialId && Number.isFinite(r.qty) && r.qty >= CONSUMPTION_QTY_MIN);

    const inventoryPayload =
      canTrackInventory && editingId
        ? {
            inventoryTracked: trackFinished,
            inventory: trackFinished
              ? {
                  baseUnit: form.invBaseUnit.trim(),
                  perServing: Math.max(1, Math.floor(form.invPerServing)),
                  purchaseUnits: form.invPurchaseUnits.map((u) => buildPurchaseUnitPayload(
                    u.code,
                    u.label,
                    u.labelEn,
                    Math.max(1, Math.floor(u.factorToBase)),
                  )),
                  reorderFrequencyDays: Math.max(1, Math.floor(form.invReorderFrequencyDays)),
                }
              : undefined,
            consumption: saveForm.trackingMode === 'raw' ? cleanBom(saveForm.itemConsumption) : [],
          }
        : {};
    const body = {
      categoryId: saveForm.categoryId, price: saveForm.price,
      calories: saveForm.calories, avgWaitMinutes: saveForm.avgWaitMinutes,
      allergenIds: saveForm.allergenIds,
      translations: [
        { locale: 'zh-CN', name: saveForm.nameZh, description: saveForm.descZh },
        { locale: 'en-US', name: saveForm.nameEn, description: saveForm.descEn },
      ],
      ...inventoryPayload,
      optionGroups: saveForm.optionGroups.map(g => ({
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
          consumption: canTrackInventory ? cleanBom(c.consumption || []) : undefined,
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

  // Option group helpers
  const addOptionGroup = () => {
    setForm(prev => ({
      ...prev,
      optionGroups: [...prev.optionGroups, { nameZh: '', nameEn: '', required: false, minSelect: 0, maxSelect: 0, choices: [{ nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0, consumption: [] }] }],
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
        i === gi ? { ...g, choices: [...g.choices, { nameZh: '', nameEn: '', extraPrice: 0, originalPrice: 0, consumption: [] }] } : g
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

  const addPurchaseUnit = () => setForm(prev => ({
    ...prev,
    invPurchaseUnits: [...prev.invPurchaseUnits, { code: '', label: '', labelEn: '', factorToBase: 1 }],
  }));
  const removePurchaseUnit = (idx: number) => setForm(prev => ({
    ...prev,
    invPurchaseUnits: prev.invPurchaseUnits.filter((_, i) => i !== idx),
  }));
  const updatePurchaseUnit = (idx: number, field: keyof FormInventoryUnit, value: unknown) => setForm(prev => ({
    ...prev,
    invPurchaseUnits: prev.invPurchaseUnits.map((u, i) => i === idx ? { ...u, [field]: value } : u),
  }));

  const updateItemBom = (idx: number, patch: Partial<BoMEntryData>) =>
    setForm((prev) => {
      const next = {
        ...prev,
        itemConsumption: prev.itemConsumption.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
      };
      formSnapshotRef.current = next;
      return next;
    });
  const addItemBom = () =>
    setForm((prev) => ({ ...prev, itemConsumption: [...prev.itemConsumption, { rawMaterialId: '', qty: 1 }] }));
  const removeItemBom = (idx: number) =>
    setForm((prev) => ({ ...prev, itemConsumption: prev.itemConsumption.filter((_, i) => i !== idx) }));

  const updateChoiceBom = (gi: number, ci: number, idx: number, patch: Partial<BoMEntryData>) =>
    setForm((prev) => {
      const next = {
        ...prev,
        optionGroups: prev.optionGroups.map((g, i) =>
          i !== gi ? g : {
            ...g,
            choices: g.choices.map((c, j) =>
              j !== ci ? c : { ...c, consumption: c.consumption.map((row, k) => (k === idx ? { ...row, ...patch } : row)) },
            ),
          }),
      };
      formSnapshotRef.current = next;
      return next;
    });
  const addChoiceBom = (gi: number, ci: number) =>
    setForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i !== gi ? g : {
          ...g,
          choices: g.choices.map((c, j) => (j !== ci ? c : { ...c, consumption: [...c.consumption, { rawMaterialId: '', qty: 1 }] })),
        }),
    }));
  const removeChoiceBom = (gi: number, ci: number, idx: number) =>
    setForm((prev) => ({
      ...prev,
      optionGroups: prev.optionGroups.map((g, i) =>
        i !== gi ? g : {
          ...g,
          choices: g.choices.map((c, j) => (j !== ci ? c : { ...c, consumption: c.consumption.filter((_, k) => k !== idx) })),
        }),
    }));

  const rmName = (rid: string): string => {
    const r = rawMaterials.find((x) => x._id === rid);
    if (!r) return rid;
    const zh = r.translations.find((tr) => tr.locale === 'zh-CN')?.name;
    const en = r.translations.find((tr) => tr.locale === 'en-US')?.name;
    return zh || en || r.translations[0]?.name || rid;
  };

  const renderBomRow = (
    row: BoMEntryData,
    onChange: (patch: Partial<BoMEntryData>) => void,
    onRemove: () => void,
  ): React.ReactElement => {
    const r = rawMaterials.find((x) => x._id === row.rawMaterialId);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 40px auto', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <select className="input" style={{ fontSize: 12 }} value={row.rawMaterialId}
          onChange={(e) => onChange({ rawMaterialId: e.target.value })}>
          <option value="">{t('admin.bomPickMaterial', { defaultValue: '-- 选择原材料 --' })}</option>
          {rawMaterials.map((rm) => (
            <option key={rm._id} value={rm._id}>{rmName(rm._id)}{rm.baseUnit ? ` (${rm.baseUnit})` : ''}</option>
          ))}
        </select>
        <BomQtyInput
          value={row.qty}
          style={{ fontSize: 12 }}
          registerFlush={registerBomFlush}
          onCommit={(qty) => onChange({ qty })}
        />
        <span style={{ fontSize: 11, color: 'var(--text-light)' }}>{r?.baseUnit || ''}</span>
        <button className="btn btn-ghost" style={{ fontSize: 14, color: 'var(--red-primary)' }} onClick={onRemove}>✕</button>
      </div>
    );
  };

  const renderInventorySection = (cardBg: string) => {
    if (!canTrackInventory) return null;
    if (!editingId) {
      return (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14, color: 'var(--text-light)', fontSize: 12 }}>
          {t('admin.inventoryConfigAfterCreate')}
        </div>
      );
    }
    return (
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 700 }}>📦 {t('admin.inventoryTracking')}</label>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' }}>
            {(['off', 'finished', 'raw'] as const).map((mode) => (
              <label key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="radio" name="trackingMode" checked={form.trackingMode === mode}
                  onChange={() => setForm((prev) => ({
                    ...prev,
                    trackingMode: mode,
                    inventoryTracked: mode === 'finished',
                  }))} />
                {mode === 'off' ? t('admin.trackingModeOff', { defaultValue: '不追踪' })
                  : mode === 'finished' ? t('admin.trackingModeFinished', { defaultValue: 'A：成品库存' })
                  : t('admin.trackingModeRaw', { defaultValue: 'B：原材料消耗' })}
              </label>
            ))}
          </div>
        </div>

        {form.trackingMode === 'raw' && (
          <div style={{ background: cardBg, borderRadius: 8, padding: 12, border: '1px solid var(--border)', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              🥩 {t('admin.bomItemTitle', { defaultValue: '本菜品每份消耗' })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>
              {t('admin.bomItemHint', { defaultValue: '不区分选项；选项的消耗在选项组里单独配置。' })}
            </div>
            {rawMaterials.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--red-primary)' }}>
                {t('admin.bomNoMaterials', { defaultValue: '尚未创建任何原材料，请先到 「🥩 原材料」 页面新建。' })}
              </div>
            )}
            {form.itemConsumption.map((row, idx) => renderBomRow(
              row,
              (patch) => updateItemBom(idx, patch),
              () => removeItemBom(idx),
            ))}
            {rawMaterials.length > 0 && (
              <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 4 }} onClick={addItemBom}>
                + {t('admin.bomAddRow', { defaultValue: '增加一条' })}
              </button>
            )}

            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 14, marginBottom: 6 }}>
              🧩 {t('admin.bomOptionTitle', { defaultValue: '选项消耗（按 group / choice 平铺）' })}
            </div>
            {form.optionGroups.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
                {t('admin.bomNoOptions', { defaultValue: '该菜品没有选项组' })}
              </div>
            ) : (
              form.optionGroups.map((g, gi) => (
                <div key={gi} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {g.nameZh || `选项组 #${gi + 1}`}{g.nameEn ? ` (${g.nameEn})` : ''}
                  </div>
                  {g.choices.map((c, ci) => (
                    <div key={ci} style={{ marginBottom: 6, paddingLeft: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
                        {c.nameZh || `choice #${ci + 1}`}{c.nameEn ? ` (${c.nameEn})` : ''}
                      </div>
                      {c.consumption.map((row, idx) => renderBomRow(
                        row,
                        (patch) => updateChoiceBom(gi, ci, idx, patch),
                        () => removeChoiceBom(gi, ci, idx),
                      ))}
                      {rawMaterials.length > 0 && (
                        <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 2 }}
                          onClick={() => addChoiceBom(gi, ci)}>
                          + {t('admin.bomAddRow', { defaultValue: '增加一条' })}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {form.trackingMode === 'finished' && (
          <div style={{ background: cardBg, borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.invBaseUnit')}</label>
                <input className="input" placeholder={t('admin.invBaseUnitPlaceholder')} value={form.invBaseUnit}
                  onChange={e => setForm(prev => ({ ...prev, invBaseUnit: e.target.value }))} style={{ width: '100%' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.invPerServing')}</label>
                <input className="input" type="number" min={1} value={form.invPerServing}
                  onChange={e => setForm(prev => ({ ...prev, invPerServing: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))} style={{ width: '100%' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('admin.invReorderFrequency')}</label>
                <input className="input" type="number" min={1} value={form.invReorderFrequencyDays}
                  onChange={e => setForm(prev => ({ ...prev, invReorderFrequencyDays: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))} style={{ width: '100%' }} />
              </div>
            </div>
            {editingDailySales && (
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12,
                padding: '6px 10px', background: 'var(--bg)', borderRadius: 6, border: '1px dashed var(--border)',
              }}>
                {t('admin.invAutoDailyLabel', { defaultValue: '系统自动统计的日均销量' })}：
                <strong style={{ color: 'var(--text-primary)' }}>
                  {editingDailySales.daily.toFixed(2)} {t('admin.invServings')} / {t('admin.invDay', { defaultValue: '天' })}
                </strong>
                <span style={{ marginLeft: 8, color: 'var(--text-light)' }}>
                  ({editingDailySales.basis === 'history'
                    ? t('admin.invFromHistory', { defaultValue: '基于近 14 天订单历史' })
                    : t('admin.invNoHistoryYet', { defaultValue: '暂无订单样本，阈值按 0 处理；有销售后自动启用阈值告警' })})
                </span>
                {editingDailySales.basis === 'history' && (
                  <div style={{ marginTop: 2, color: 'var(--text-light)' }}>
                    {t('admin.invThresholdPreview', {
                      defaultValue: '当前阈值估算 ≈ {{n}} {{u}}（= 补货周期 × 日均 × 每份数量）',
                      n: Math.ceil(form.invReorderFrequencyDays * editingDailySales.daily * Math.max(1, form.invPerServing)),
                      u: form.invBaseUnit || t('admin.invBaseUnit'),
                    })}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{t('admin.invPurchaseUnits')}</span>
              <button className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} onClick={addPurchaseUnit}>+ {t('admin.invAddPurchaseUnit')}</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 6 }}>{t('admin.invPurchaseUnitHint')}</div>
            {form.invPurchaseUnits.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-light)', padding: '6px 0' }}>{t('admin.invNoPurchaseUnits')}</div>
            )}
            {form.invPurchaseUnits.map((u, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1fr 0.8fr auto', gap: 6, marginBottom: 4 }}>
                <input className="input" placeholder="code (e.g. case)" value={u.code}
                  onChange={e => updatePurchaseUnit(idx, 'code', e.target.value)} style={{ fontSize: 12 }} />
                <input className="input" placeholder={t('admin.invUnitLabelPlaceholder')} value={u.label}
                  onChange={e => updatePurchaseUnit(idx, 'label', e.target.value)} style={{ fontSize: 12 }} />
                <input className="input" placeholder={t('admin.invUnitLabelEnPlaceholder')} value={u.labelEn}
                  onChange={e => updatePurchaseUnit(idx, 'labelEn', e.target.value)} style={{ fontSize: 12 }} />
                <input className="input" type="number" min={1} placeholder={t('admin.invFactorPlaceholder')} value={u.factorToBase}
                  onChange={e => updatePurchaseUnit(idx, 'factorToBase', Math.max(1, Math.floor(Number(e.target.value) || 1)))} style={{ fontSize: 12 }} />
                <button className="btn btn-ghost" style={{ fontSize: 14, color: 'var(--red-primary)' }} onClick={() => removePurchaseUnit(idx)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
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

          {renderInventorySection('var(--bg)')}

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button>
            <button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Items table grouped by category */}
      <div className="card" style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', width: 64 }}>照片</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>名称</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>价格</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>过敏原</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>AR</th>
              <th style={{ padding: '10px 12px', textAlign: 'center' }}>状态</th>
              <th style={{ padding: '10px 12px', textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={7} style={{ padding: '20px 12px', color: 'var(--text-light)', textAlign: 'center', fontSize: 12 }}>
                  {t('common.noData', { defaultValue: '暂无数据' })}
                </td>
              </tr>
            </tbody>
          )}
          {groups.map(group => (
          <tbody key={group.id}>
            <tr style={{ background: 'var(--bg)', borderTop: '2px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
              <td colSpan={7} style={{ padding: '10px 12px' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{group.name}</span>
                {group.nameAlt && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-light)' }}>{group.nameAlt}</span>
                )}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-light)', fontWeight: 500 }}>
                  · {group.items.length}
                </span>
              </td>
            </tr>
            {group.items.map(item => (
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
                <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--red-primary)' }}>€{item.price}</td>
                <td style={{ padding: '8px 12px' }}>{(item.allergenIds || []).map(aid => { const a = allergens.find(al => al._id === aid); return a ? <span key={aid} title={a.translations.find(t2 => t2.locale === 'zh-CN')?.name || a.name} style={{ marginRight: 2 }}>{a.icon}</span> : null; })}</td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <label style={{ cursor: 'pointer' }}>{item.arFileUrl ? (<span style={{ color: 'var(--green)', fontSize: 13 }}>✓ <span style={{ textDecoration: 'underline', fontSize: 11 }}>替换</span></span>) : (<span className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', display: 'inline-block' }}>上传 AR</span>)}<input type="file" accept=".usdz,.glb" hidden onChange={e => { if (e.target.files?.[0]) { uploadAR(item._id, e.target.files[0]); e.target.value = ''; } }} /></label>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {item.isSoldOut ? <span className="badge" style={{ background: 'var(--red-light)', color: 'var(--red-primary)' }}>售罄</span> : <span className="badge" style={{ background: 'var(--green-light)', color: 'var(--green)' }}>在售</span>}
                  {canTrackInventory && item.inventoryTracked && (
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-light)' }}>
                      📦 {Math.max(0, Number(item.inventory?.currentQty) || 0)}{item.inventory?.baseUnit ? ' ' + item.inventory.baseUnit : ''}
                    </div>
                  )}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { if (showForm && editingId === item._id) setShowForm(false); else startEdit(item); }}>{showForm && editingId === item._id ? '收起' : t('common.edit')}</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)' }} onClick={() => handleDelete(item._id)}>{t('common.delete')}</button>
                </td>
              </tr>
              {showForm && editingId === item._id && (
                <tr><td colSpan={7} style={{ padding: 16, background: 'var(--bg)', borderBottom: '2px solid var(--red-primary)' }}>
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
                  {renderInventorySection('#fff')}
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button className="btn btn-primary" onClick={handleSave}>{t('common.save')}</button><button className="btn btn-outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</button></div>
                </td></tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
