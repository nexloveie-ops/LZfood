import { Fragment, useCallback, useEffect, useState } from 'react';
import { platformApiFetch } from '../../api/client';

interface StoreRow {
  _id: string;
  slug: string;
  displayName: string;
  status: string;
  subscriptionEndsAt?: string;
  basePlanId?: string | null;
  enabledAddOnIds?: string[];
  featureOverrides?: Record<string, boolean>;
}

interface AdminRow {
  _id: string;
  username: string;
  role: string;
}

interface FeaturePlanRow {
  _id: string;
  name: string;
  code: string;
  features: string[];
  isActive: boolean;
}

interface FeatureAddonRow {
  _id: string;
  name: string;
  code: string;
  features: string[];
  isActive: boolean;
}

/**
 * 平台配置 Plan/Add-on 时的功能键分组。
 *
 * `checkedAliases`（可选）—— 旧版本切分过的兄弟 key。任一 alias 命中也算"已勾选"，
 * 关闭时一起清理。仅为兼容历史数据，新 Plan 只会写入主 key。
 */
const FEATURE_GROUPS: {
  section: string;
  options: { key: string; label: string; checkedAliases?: string[]; infoOnly?: boolean }[];
}[] = [
  {
    section: 'Cashier',
    options: [
      {
        key: 'cashier.delivery.page',
        label: '送餐：队列、运费、顾客送餐入口与送餐二维码',
      },
      {
        key: 'cashier.member.wallet',
        label: '会员：储值/钱包结账、顾客会员中心、管理端会员与储值、扫码会员校验（与送餐独立）',
      },
    ],
  },
  {
    section: '管理员扩展',
    options: [
      { key: 'admin.optionGroupTemplates.page', label: '管理员-选项组模板' },
      { key: 'admin.offers.page', label: '管理员-套餐优惠' },
      { key: 'admin.coupons.page', label: '管理员-Coupon 管理' },
      { key: 'admin.orderHistory.page', label: '管理员-订单历史' },
      { key: 'admin.customerNotifications.page', label: '管理员-客人通知（短信/WhatsApp）' },
      { key: 'admin.reports.vatExport.action', label: '报表-VAT 导出' },
      { key: 'admin.inventory.restoreTime.action', label: '库存-恢复供应时间' },
      { key: 'admin.salesForecast.page', label: '管理员-备货预测（菜品份数预测 / 回测与校准）' },
      { key: 'admin.reportSegments.page', label: '管理员-品类结构报表（按餐品目录分组统计营业额）' },
      { key: 'admin.widget.api', label: '管理员-Owner Widget API（iOS 小组件只读数据）' },
    ],
  },
  {
    section: '库存追踪',
    options: [
      {
        key: 'inventory.tracking',
        label: '库存追踪（管理端：销量/进货/报损/流水/报表；收银端：到货录入、报损、初始库存）',
        checkedAliases: ['admin.inventory.tracking.page', 'cashier.inventory.restock.tab'],
      },
    ],
  },
  {
    section: '平台',
    options: [{ key: 'platform.postOrderAds.manage.action', label: '平台-广告管理' }],
  },
];

const FEATURE_OPTIONS: { key: string; label: string }[] = FEATURE_GROUPS.flatMap((g) =>
  g.options.filter((o) => !o.infoOnly),
);

const FEATURE_OVERRIDE_TEMPLATE: Record<string, boolean> = Object.fromEntries(
  FEATURE_OPTIONS.map((f) => [f.key, false]),
) as Record<string, boolean>;

function FeatureCheckboxList(props: {
  selected: string[];
  /**
   * 由父级实现。`aliases` 是该选项要一并清除的历史兄弟 key（关闭时同步删除），
   * 启用时父级只需写入主 key。
   */
  onToggle: (key: string, aliases?: string[]) => void;
  maxHeight?: number;
}) {
  const { selected, onToggle, maxHeight = 180 } = props;
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 8, marginBottom: 8, maxHeight, overflowY: 'auto' }}>
      {FEATURE_GROUPS.map((group) => (
        <div key={group.section} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#455a64', marginBottom: 6, letterSpacing: 0.2 }}>{group.section}</div>
          {group.options.map((opt) => {
            if (opt.infoOnly) {
              return (
                <p key={opt.key} style={{ fontSize: 12, color: '#546e7a', margin: '0 0 8px 4px', lineHeight: 1.45 }}>
                  {opt.label}
                </p>
              );
            }
            const isOn = selected.includes(opt.key)
              || (opt.checkedAliases?.some((a) => selected.includes(a)) ?? false);
            return (
              <label key={opt.key} style={{ display: 'block', fontSize: 12, marginBottom: 6, paddingLeft: 4 }}>
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(opt.key, opt.checkedAliases)}
                  style={{ marginRight: 6 }}
                />
                {opt.label}
                <span style={{ color: '#888', marginLeft: 6 }}>{opt.key}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function PlatformStoresPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createStoreOpen, setCreateStoreOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [plans, setPlans] = useState<FeaturePlanRow[]>([]);
  const [addons, setAddons] = useState<FeatureAddonRow[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [newPlanName, setNewPlanName] = useState('');
  const [newPlanCode, setNewPlanCode] = useState('');
  const [newPlanFeatures, setNewPlanFeatures] = useState<string[]>([]);
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<FeaturePlanRow | null>(null);
  const [editPlanName, setEditPlanName] = useState('');
  const [editPlanFeatures, setEditPlanFeatures] = useState<string[]>([]);
  const [editPlanActive, setEditPlanActive] = useState(true);
  const [newAddonName, setNewAddonName] = useState('');
  const [newAddonCode, setNewAddonCode] = useState('');
  const [newAddonFeatures, setNewAddonFeatures] = useState<string[]>([]);
  const [newAddonOpen, setNewAddonOpen] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [adminsByStore, setAdminsByStore] = useState<Record<string, AdminRow[]>>({});
  const [admLoad, setAdmLoad] = useState<string | null>(null);

  const [newAdminUser, setNewAdminUser] = useState('');
  const [newAdminPass, setNewAdminPass] = useState('');
  const [newAdminRole, setNewAdminRole] = useState<'owner' | 'cashier'>('owner');
  const [addingAdmin, setAddingAdmin] = useState(false);

  const [purgeOpenFor, setPurgeOpenFor] = useState<string | null>(null);
  const [purgeSlugInput, setPurgeSlugInput] = useState('');
  const [purging, setPurging] = useState(false);
  const [packageEditStoreId, setPackageEditStoreId] = useState<string | null>(null);
  const [pkgBasePlanId, setPkgBasePlanId] = useState('');
  const [pkgAddOnIds, setPkgAddOnIds] = useState<string[]>([]);
  const [pkgOverrides, setPkgOverrides] = useState('{}');

  const loadStores = useCallback(async () => {
    setErr('');
    const res = await platformApiFetch('/api/platform/stores');
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '加载失败');
      setStores([]);
      return;
    }
    setStores(await res.json());
  }, []);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const [pRes, aRes] = await Promise.all([
        platformApiFetch('/api/platform/feature-plans'),
        platformApiFetch('/api/platform/feature-addons'),
      ]);
      if (pRes.ok) setPlans(await pRes.json());
      if (aRes.ok) setAddons(await aRes.json());
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadStores(), loadProducts()]);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [loadStores, loadProducts]);

  /**
   * 切换功能勾选：
   * - 旧 plan 里残留的 `aliases`（如 `admin.inventory.tracking.page` / `cashier.inventory.restock.tab`）
   *   也算"已勾选"，关闭时一并清掉，避免合并后 plan 里还留着幽灵 key。
   * - 启用时只写入主 key（新存的数据干干净净的）。
   */
  const toggleInList = (list: string[], key: string, aliases?: string[]) => {
    const all = [key, ...(aliases || [])];
    const isOn = all.some((k) => list.includes(k));
    if (isOn) return list.filter((k) => !all.includes(k));
    return [...list, key];
  };

  const isAdsAddon = (addon: FeatureAddonRow): boolean => (
    addon.features.includes('platform.postOrderAds.manage.action') ||
    addon.features.includes('customer.postOrderAds.view.action')
  );

  const loadAdmins = async (storeId: string) => {
    setAdmLoad(storeId);
    try {
      const res = await platformApiFetch(`/api/platform/stores/${storeId}/admins`);
      if (res.ok) {
        const list = await res.json();
        setAdminsByStore(prev => ({ ...prev, [storeId]: list }));
      }
    } finally {
      setAdmLoad(null);
    }
  };

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!adminsByStore[id]) void loadAdmins(id);
  };

  const openPackageEditor = (store: StoreRow) => {
    setPackageEditStoreId(store._id);
    setPkgBasePlanId(store.basePlanId || '');
    setPkgAddOnIds(store.enabledAddOnIds || []);
    setPkgOverrides(JSON.stringify(store.featureOverrides || {}, null, 2));
    setErr('');
  };

  const closePackageEditor = () => {
    setPackageEditStoreId(null);
    setPkgBasePlanId('');
    setPkgAddOnIds([]);
    setPkgOverrides('{}');
  };

  const savePackageEditor = async () => {
    if (!packageEditStoreId) return;
    let parsedOverrides: Record<string, boolean> = {};
    try {
      parsedOverrides = pkgOverrides.trim() ? JSON.parse(pkgOverrides) : {};
    } catch {
      setErr('featureOverrides JSON 格式错误');
      return;
    }
    await patchStore(packageEditStoreId, {
      basePlanId: pkgBasePlanId || null,
      enabledAddOnIds: pkgAddOnIds,
      featureOverrides: parsedOverrides,
    });
    await loadStores();
    closePackageEditor();
  };

  const createStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug.trim() || !newName.trim()) return;
    setCreating(true);
    setErr('');
    try {
      const res = await platformApiFetch('/api/platform/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSlug.trim().toLowerCase(), displayName: newName.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error?.message || '创建失败');
        return;
      }
      setNewSlug('');
      setNewName('');
      await loadStores();
    } finally {
      setCreating(false);
    }
  };

  const patchStore = async (id: string, body: Record<string, unknown>) => {
    const res = await platformApiFetch(`/api/platform/stores/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) await loadStores();
    else {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '更新失败');
    }
  };

  const createPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlanName.trim() || !newPlanCode.trim()) return;
    const res = await platformApiFetch('/api/platform/feature-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newPlanName.trim(),
        code: newPlanCode.trim().toLowerCase(),
        features: newPlanFeatures,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '创建版本失败');
      return;
    }
    setNewPlanName('');
    setNewPlanCode('');
    setNewPlanFeatures([]);
    setNewPlanOpen(false);
    await loadProducts();
  };

  const createAddon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAddonName.trim() || !newAddonCode.trim()) return;
    const res = await platformApiFetch('/api/platform/feature-addons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAddonName.trim(),
        code: newAddonCode.trim().toLowerCase(),
        features: newAddonFeatures,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '创建 Add-on 失败');
      return;
    }
    setNewAddonName('');
    setNewAddonCode('');
    setNewAddonFeatures([]);
    setNewAddonOpen(false);
    await loadProducts();
  };

  const openEditPlan = (plan: FeaturePlanRow) => {
    setEditingPlan(plan);
    setEditPlanName(plan.name);
    setEditPlanFeatures(plan.features || []);
    setEditPlanActive(!!plan.isActive);
  };

  const saveEditPlan = async () => {
    if (!editingPlan) return;
    const res = await platformApiFetch(`/api/platform/feature-plans/${editingPlan._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editPlanName.trim(),
        features: editPlanFeatures,
        isActive: editPlanActive,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '更新版本失败');
      return;
    }
    setEditingPlan(null);
    await loadProducts();
  };

  const deletePlan = async (planId: string) => {
    if (!confirm('确认删除该 Plan？')) return;
    const res = await platformApiFetch(`/api/platform/feature-plans/${planId}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error?.message || '删除版本失败');
      return;
    }
    await loadProducts();
  };

  const addAdmin = async (e: React.FormEvent, storeId: string) => {
    e.preventDefault();
    if (!newAdminUser.trim() || !newAdminPass) return;
    setAddingAdmin(true);
    setErr('');
    try {
      const res = await platformApiFetch(`/api/platform/stores/${storeId}/admins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newAdminUser.trim(),
          password: newAdminPass,
          role: newAdminRole,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error?.message || '创建账号失败');
        return;
      }
      setNewAdminUser('');
      setNewAdminPass('');
      await loadAdmins(storeId);
    } finally {
      setAddingAdmin(false);
    }
  };

  const deleteAdmin = async (storeId: string, adminId: string) => {
    if (!confirm('确认删除该账号？')) return;
    const res = await platformApiFetch(`/api/platform/stores/${storeId}/admins/${adminId}`, { method: 'DELETE' });
    if (res.ok) await loadAdmins(storeId);
  };

  const openPurge = (storeId: string) => {
    setPurgeOpenFor(storeId);
    setPurgeSlugInput('');
    setErr('');
  };

  const cancelPurge = () => {
    setPurgeOpenFor(null);
    setPurgeSlugInput('');
  };

  const deleteStoreCascade = async (storeId: string, expectedSlug: string) => {
    const typed = purgeSlugInput.trim().toLowerCase();
    if (typed !== expectedSlug.toLowerCase()) {
      setErr('请输入与该行「标识」完全一致的 slug 以确认删除');
      return;
    }
    if (!confirm('最后确认：将永久删除该店铺及菜单、订单、配置、店内账号等全部数据，无法恢复。确定？')) {
      return;
    }
    setPurging(true);
    setErr('');
    try {
      const res = await platformApiFetch(`/api/platform/stores/${storeId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmSlug: typed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error?.message || '删除失败');
        return;
      }
      cancelPurge();
      if (expanded === storeId) setExpanded(null);
      setAdminsByStore(prev => {
        const next = { ...prev };
        delete next[storeId];
        return next;
      });
      await loadStores();
    } finally {
      setPurging(false);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a237e', marginBottom: 8 }}>店铺与账号</h1>
      <p style={{ fontSize: 14, color: '#555', marginBottom: 24, lineHeight: 1.6 }}>
        新建店铺时会分配 <strong>URL 标识（slug）</strong>。本地访问地址为{' '}
        <code>{`${origin}/{'{slug}'}/login`}</code>；若生产环境使用子域名，请在网关将{' '}
        <code>{'{slug}.你的域名.com'}</code> 指向前端同一应用，并由前端或网关解析出 slug（当前版本为路径前缀模式）。
      </p>

      {err && (
        <div style={{ padding: 12, background: '#ffebee', color: '#c62828', borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {err}
        </div>
      )}

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: createStoreOpen ? 14 : 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>新建店铺</h2>
          <button className="btn btn-outline" type="button" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setCreateStoreOpen(v => !v)}>
            {createStoreOpen ? '收起' : '展开'}
          </button>
        </div>
        {createStoreOpen ? (
          <form onSubmit={createStore} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>URL 标识（小写、数字、连字符）</label>
              <input className="input" style={{ width: 200 }} placeholder="例 my-shop" value={newSlug}
                onChange={e => setNewSlug(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>显示名称</label>
              <input className="input" style={{ width: 220 }} placeholder="例 某某茶餐厅" value={newName}
                onChange={e => setNewName(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={creating} style={{ background: '#1a237e' }}>
              {creating ? '创建中…' : '创建店铺'}
            </button>
          </form>
        ) : null}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: productsOpen ? 14 : 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>版本包（Base Plan）与 Add-on</h2>
          <button className="btn btn-outline" type="button" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setProductsOpen(v => !v)}>
            {productsOpen ? '收起' : '展开'}
          </button>
        </div>
        {productsOpen ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600 }}>新建 Base Plan</div>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setNewPlanOpen(v => !v)}>
                    {newPlanOpen ? '收起' : '展开'}
                  </button>
                </div>
                {newPlanOpen ? (
                  <form onSubmit={createPlan} style={{ marginTop: 8 }}>
                    <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="名称（如 Pro Base）" value={newPlanName} onChange={e => setNewPlanName(e.target.value)} />
                    <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="Code（如 pro-base）" value={newPlanCode} onChange={e => setNewPlanCode(e.target.value)} />
                    <FeatureCheckboxList
                      selected={newPlanFeatures}
                      onToggle={(key, aliases) => setNewPlanFeatures((prev) => toggleInList(prev, key, aliases))}
                      maxHeight={180}
                    />
                    <button className="btn btn-primary" type="submit">创建 Plan</button>
                  </form>
                ) : null}
              </div>
              <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600 }}>新建 Add-on</div>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setNewAddonOpen(v => !v)}>
                    {newAddonOpen ? '收起' : '展开'}
                  </button>
                </div>
                {newAddonOpen ? (
                  <form onSubmit={createAddon} style={{ marginTop: 8 }}>
                    <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="名称（如 VAT Export）" value={newAddonName} onChange={e => setNewAddonName(e.target.value)} />
                    <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="Code（如 vat-export）" value={newAddonCode} onChange={e => setNewAddonCode(e.target.value)} />
                    <FeatureCheckboxList
                      selected={newAddonFeatures}
                      onToggle={(key, aliases) => setNewAddonFeatures((prev) => toggleInList(prev, key, aliases))}
                      maxHeight={180}
                    />
                    <button className="btn btn-primary" type="submit">创建 Add-on</button>
                  </form>
                ) : null}
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: '#666' }}>
              {loadingProducts ? '加载版本包中…' : `Plan ${plans.length} 个，Add-on ${addons.length} 个`}
            </div>
            <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '10px 12px', background: '#fafafa', fontWeight: 600 }}>所有 Plan</div>
              {plans.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: '#888' }}>暂无 Plan</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f7f7f7', textAlign: 'left' }}>
                      <th style={{ padding: '8px 10px' }}>名称</th>
                      <th style={{ padding: '8px 10px' }}>Code</th>
                      <th style={{ padding: '8px 10px' }}>状态</th>
                      <th style={{ padding: '8px 10px' }}>功能数</th>
                      <th style={{ padding: '8px 10px' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map(p => (
                      <tr key={p._id} style={{ borderTop: '1px solid #eee' }}>
                        <td style={{ padding: '8px 10px' }}>{p.name}</td>
                        <td style={{ padding: '8px 10px', color: '#666' }}>{p.code}</td>
                        <td style={{ padding: '8px 10px' }}>{p.isActive ? '启用' : '停用'}</td>
                        <td style={{ padding: '8px 10px' }}>{p.features?.length || 0}</td>
                        <td style={{ padding: '8px 10px', display: 'flex', gap: 8 }}>
                          <button className="btn btn-outline" type="button" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openEditPlan(p)}>修改</button>
                          <button className="btn btn-outline" type="button" style={{ fontSize: 12, padding: '4px 10px', color: '#c62828', borderColor: '#ffcdd2' }} onClick={() => void deletePlan(p._id)}>删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', fontWeight: 600 }}>店铺列表</div>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>加载中…</div>
        ) : stores.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>暂无店铺</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                <th style={{ padding: '12px 16px' }}>标识 / 登录路径</th>
                <th style={{ padding: '12px 16px' }}>名称</th>
                <th style={{ padding: '12px 16px' }}>状态</th>
                <th style={{ padding: '12px 16px' }}>功能包分配</th>
                <th style={{ padding: '12px 16px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {stores.map(s => (
                <Fragment key={s._id}>
                  <tr style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600 }}>{s.slug}</div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                        <a href={`/${s.slug}/login`} target="_blank" rel="noreferrer">{`${origin}/${s.slug}/login`}</a>
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ marginTop: 8, fontSize: 11, padding: '4px 8px' }}
                        onClick={() => openPackageEditor(s)}
                      >
                        配置功能包
                      </button>
                    </td>
                    <td style={{ padding: '12px 16px' }}>{s.displayName}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <select
                        value={s.status}
                        onChange={e => patchStore(s._id, { status: e.target.value })}
                        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}>
                        <option value="active">营业</option>
                        <option value="suspended">暂停</option>
                        <option value="expired">过期</option>
                      </select>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600 }}>
                        {plans.find(p => p._id === s.basePlanId)?.name || '(未分配)'}
                      </div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                        Add-ons: {(s.enabledAddOnIds || []).length}
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '6px 12px' }}
                          onClick={() => toggleExpand(s._id)}>
                          {expanded === s._id ? '收起账号' : '管理店内账号'}
                        </button>
                        <button type="button" className="btn btn-outline" style={{
                          fontSize: 12,
                          padding: '6px 12px',
                          color: '#b71c1c',
                          borderColor: '#ffcdd2',
                        }}
                          onClick={() => (purgeOpenFor === s._id ? cancelPurge() : openPurge(s._id))}>
                          {purgeOpenFor === s._id ? '取消删除' : '删除店铺…'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {purgeOpenFor === s._id && (
                    <tr>
                      <td colSpan={5} style={{ padding: '12px 16px 16px', background: '#fff3e0', borderTop: '1px solid #ffe0b2' }}>
                        <div style={{ fontSize: 13, color: '#bf360c', fontWeight: 600, marginBottom: 8 }}>危险：永久删除店铺</div>
                        <p style={{ fontSize: 13, color: '#5d4037', margin: '0 0 12px', lineHeight: 1.5 }}>
                          将删除该店下<strong>全部</strong>数据：分类与菜品、过敏原、选项模板与规则、优惠与优惠券、订单与结账、日序号、系统配置、店内账号及与本店相关的审计日志。此操作<strong>不可恢复</strong>。
                          云存储中的图片文件不会按店自动清理，如需请另行在存储桶中处理。
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                          <span style={{ fontSize: 13 }}>请输入店铺标识 <code style={{ background: '#ffe0b2', padding: '2px 6px', borderRadius: 4 }}>{s.slug}</code> 以确认：</span>
                          <input className="input" style={{ width: 180 }} placeholder={s.slug} value={purgeSlugInput}
                            onChange={e => setPurgeSlugInput(e.target.value)} autoComplete="off" />
                          <button type="button" className="btn btn-primary" disabled={purging}
                            style={{ background: '#c62828', borderColor: '#c62828' }}
                            onClick={() => deleteStoreCascade(s._id, s.slug)}>
                            {purging ? '删除中…' : '确认永久删除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {expanded === s._id && (
                    <tr>
                      <td colSpan={5} style={{ padding: '0 16px 20px', background: '#fafafa' }}>
                        <div style={{ padding: '16px 0' }}>
                          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>店内账号（店主 / 收银员）</div>
                          {admLoad === s._id ? (
                            <div style={{ color: '#888', fontSize: 13 }}>加载账号…</div>
                          ) : (
                            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
                              {(adminsByStore[s._id] || []).map(a => (
                                <li key={a._id} style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '8px 12px',
                                  background: '#fff',
                                  borderRadius: 8,
                                  marginBottom: 8,
                                  border: '1px solid #eee',
                                }}>
                                  <span>{a.username} <span style={{ color: '#888' }}>({a.role})</span></span>
                                  <button type="button" className="btn btn-outline" style={{ fontSize: 12, color: '#c62828', borderColor: '#ffcdd2' }}
                                    onClick={() => deleteAdmin(s._id, a._id)}>删除</button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <form onSubmit={e => addAdmin(e, s._id)} style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 10,
                            alignItems: 'flex-end',
                            padding: 16,
                            background: '#fff',
                            borderRadius: 8,
                            border: '1px solid #e0e0e0',
                          }}>
                            <input className="input" style={{ width: 140 }} placeholder="用户名" value={newAdminUser}
                              onChange={e => setNewAdminUser(e.target.value)} />
                            <input className="input" style={{ width: 140 }} type="password" placeholder="初始密码" value={newAdminPass}
                              onChange={e => setNewAdminPass(e.target.value)} />
                            <select className="input" style={{ width: 120 }} value={newAdminRole}
                              onChange={e => setNewAdminRole(e.target.value as 'owner' | 'cashier')}>
                              <option value="owner">店主</option>
                              <option value="cashier">收银员</option>
                            </select>
                            <button type="submit" className="btn btn-primary" disabled={addingAdmin} style={{ background: '#3949ab' }}>
                              添加账号
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {packageEditStoreId ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 620, maxWidth: '94vw', background: '#fff', borderRadius: 12, padding: 16, maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>店铺功能包配置</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>Base Plan</label>
              <select
                value={pkgBasePlanId}
                onChange={e => setPkgBasePlanId(e.target.value)}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', width: 240 }}
              >
                <option value="">(无)</option>
                {plans.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>Add-ons（可多选）</label>
              <select
                multiple
                value={pkgAddOnIds}
                onChange={e => setPkgAddOnIds(Array.from(e.currentTarget.selectedOptions).map(o => o.value))}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', width: 340, minHeight: 120 }}
              >
                {addons.map(a => (
                  <option
                    key={a._id}
                    value={a._id}
                    disabled={(() => {
                      const selectedPlan = plans.find(p => p._id === pkgBasePlanId);
                      const enterprise = !!selectedPlan && selectedPlan.code.toLowerCase().includes('enterprise');
                      return enterprise && isAdsAddon(a);
                    })()}
                  >
                    {a.name}{isAdsAddon(a) ? '（广告）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>店铺覆盖（JSON）</label>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6, lineHeight: 1.45 }}>
                顾客端下单后广告默认开启。若需关闭，可加入：
                <code style={{ fontSize: 10 }}>{'{"customer.postOrderAds.view.action": false}'}</code>
                。Enterprise 套餐始终不展示广告。
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: 11, padding: '4px 8px' }}
                  onClick={() => setPkgOverrides(JSON.stringify(FEATURE_OVERRIDE_TEMPLATE, null, 2))}
                >
                  填入功能键模板
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: 11, padding: '4px 8px' }}
                  onClick={() => setPkgOverrides('{}')}
                >
                  清空
                </button>
              </div>
              <textarea
                className="input"
                style={{ width: '100%', minHeight: 140 }}
                value={pkgOverrides}
                onChange={e => setPkgOverrides(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={closePackageEditor}>取消</button>
              <button type="button" className="btn btn-primary" onClick={() => void savePackageEditor()}>保存</button>
            </div>
          </div>
        </div>
      ) : null}
      {editingPlan ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 620, maxWidth: '94vw', background: '#fff', borderRadius: 12, padding: 16, maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>修改 Plan</h3>
            <input className="input" style={{ width: '100%', marginBottom: 10 }} value={editPlanName} onChange={e => setEditPlanName(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
              <input type="checkbox" checked={editPlanActive} onChange={e => setEditPlanActive(e.target.checked)} style={{ marginRight: 6 }} />
              启用
            </label>
            <FeatureCheckboxList
              selected={editPlanFeatures}
              onToggle={(key, aliases) => setEditPlanFeatures((prev) => toggleInList(prev, key, aliases))}
              maxHeight={280}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => setEditingPlan(null)}>取消</button>
              <button type="button" className="btn btn-primary" onClick={() => void saveEditPlan()}>保存</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
