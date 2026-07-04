import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, getConfiguredStoreSlug } from '../../api/client';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';
import CashierAdHocOptionModal, { type AdHocOptionFormResult } from '../../components/cashier/CashierAdHocOptionModal';
import OptionSelectModal, { type OptionGroup } from '../../components/customer/OptionSelectModal';
import type { CartItemOption } from '../../context/CartContext';
import ReceiptPrint from '../../components/cashier/ReceiptPrint';
import { printBuiltReceipt } from '../../components/cashier/ReceiptPrint';
import { matchBundles, calcBundleTotal, type OfferData, type MatchedBundle } from '../../utils/bundleMatcher';
import {
  cashierMenuSessionCacheKey,
  getCashierMenuSessionCache,
  setCashierMenuSessionCache,
  patchCashierMenuInventoryQty,
  CASHIER_MENU_CACHE_MAX_AGE_MS,
} from '../../utils/cashierMenuSessionCache';
import {
  DELIVERY_FEE_RULES_CONFIG_KEY,
  deliveryFeeForDistance,
  parseDeliveryFeeEuroInput,
  parseDeliveryFeeRulesJson,
  type DeliveryFeeTier,
} from '../../utils/deliveryFeeRules';
import {
  type BomAvailabilitySnapshot,
  computeCartRawDemand,
  emptyBomSnapshot,
  isItemServingBlocked,
} from '../../utils/bomAvailability';

interface Translation { locale: string; name: string; description?: string; }
interface Category { _id: string; sortOrder: number; translations: Translation[]; }
interface MenuItem {
  _id: string; categoryId: string; price: number;
  translations: Translation[];
  optionGroups?: OptionGroup[];
  isSoldOut?: boolean;
  inventoryTracked?: boolean;
  inventory?: {
    baseUnit?: string;
    perServing?: number;
    currentQty?: number;
  };
}

interface InventorySummaryRow {
  menuItemId: string;
  color: 'red' | 'orange' | 'green';
  currentQty: number;
  remainingServings: number;
}
interface OrderItemOption {
  groupId?: string;
  choiceId?: string;
  isAdHoc?: boolean;
  groupName: Record<string, string>;
  choiceName: Record<string, string>;
  extraPrice: number;
}
const AD_HOC_MAX_PER_LINE = 3;

function formatCashierOptionLabel(opt: OrderItemOption, lang: string): string {
  return opt.choiceName[lang] || Object.values(opt.choiceName)[0] || '';
}

function adHocPayloadFromOption(opt: OrderItemOption) {
  return {
    groupName: opt.groupName['zh-CN'] || '加料',
    groupNameEn: opt.groupName['en-US'] || 'Extra',
    choiceName: opt.choiceName['zh-CN'] || Object.values(opt.choiceName)[0] || '',
    choiceNameEn: opt.choiceName['en-US'] || opt.choiceName['zh-CN'] || '',
    extraPrice: opt.extraPrice,
  };
}
interface OrderLine {
  id: string;
  menuItemId: string;
  name: string;
  price: number;
  options?: OrderItemOption[];
}

/** GET /api/orders/dine-in/active 返回行（本桌待结列表，点击行载入点单） */
interface ActiveDineInOrderRow {
  _id: string;
  dineInOrderNumber?: string;
  dineInGuestLabel?: string;
  items: Array<{
    menuItemId?: string;
    lineKind?: string;
    quantity: number;
    unitPrice: number;
    itemName: string;
    itemNameEn?: string;
    refunded?: boolean;
    selectedOptions?: Array<{
      groupName?: string;
      groupNameEn?: string;
      choiceName?: string;
      choiceNameEn?: string;
      extraPrice?: number;
      source?: string;
    }>;
  }>;
}

/** 从同桌 active 订单构造点单行（每份一行） */
function buildLinesFromActiveDineInOrders(orders: ActiveDineInOrderRow[], lang: string): OrderLine[] {
  const lines: OrderLine[] = [];
  for (const ord of orders) {
    for (const it of ord.items) {
      if (it.lineKind === 'delivery_fee' || !it.menuItemId || it.refunded) continue;
      const q = Math.max(1, Math.floor(Number(it.quantity)) || 1);
      const rawOpts = it.selectedOptions || [];
      const opts: OrderItemOption[] = rawOpts.map((o) => ({
        isAdHoc: o.source === 'cashier_adhoc',
        groupName: {
          'zh-CN': o.groupName || '',
          'en-US': (o.groupNameEn || o.groupName || '').trim() || (o.groupName || ''),
        },
        choiceName: {
          'zh-CN': o.choiceName || '',
          'en-US': (o.choiceNameEn || o.choiceName || '').trim() || (o.choiceName || ''),
        },
        extraPrice: typeof o.extraPrice === 'number' ? o.extraPrice : 0,
      }));
      const displayName = String(lang).toLowerCase().startsWith('zh')
        ? it.itemName
        : (it.itemNameEn || it.itemName);
      for (let i = 0; i < q; i++) {
        lines.push({
          id: nextLineId(),
          menuItemId: String(it.menuItemId),
          name: displayName,
          price: it.unitPrice,
          options: opts.length ? opts : undefined,
        });
      }
    }
  }
  return lines;
}

let lineIdCounter = 0;
function nextLineId() { return `line-${++lineIdCounter}-${Date.now()}`; }

function lineGroupKey(line: OrderLine): string {
  const optsKey =
    line.options && line.options.length > 0
      ? JSON.stringify(
          line.options.map((o) => ({
            g: o.groupId,
            c: o.choiceId,
            a: o.isAdHoc,
            gn: o.groupName,
            cn: o.choiceName,
            e: o.extraPrice,
          })),
        )
      : '';
  return `${line.menuItemId}|${optsKey}|${line.price.toFixed(2)}`;
}

type OrderLineGroup = {
  key: string;
  representative: OrderLine;
  lineIds: string[];
  quantity: number;
};

function groupOrderLines(lines: OrderLine[]): OrderLineGroup[] {
  const map = new Map<string, OrderLineGroup>();
  for (const line of lines) {
    const key = lineGroupKey(line);
    const existing = map.get(key);
    if (existing) {
      existing.lineIds.push(line.id);
      existing.quantity += 1;
    } else {
      map.set(key, {
        key,
        representative: line,
        lineIds: [line.id],
        quantity: 1,
      });
    }
  }
  return [...map.values()];
}

const QUICK_ADD_QTY_MAX = 99;

const qtyBtnStyle: CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  fontSize: 12,
  lineHeight: '20px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const FREQUENT_LOOKBACK_DAYS = 60;
const FREQUENT_ITEMS_LIMIT = 8;

/** 多档案下「手填新地址」：POST 不传 customerProfileId，由后端按地址键匹配或新建 */
const DELIVERY_PROFILE_NEW_MANUAL = '__new_delivery_address__';

function isMongoObjectId(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s.trim());
}

function isValidEircodeInput(raw: string): boolean {
  const norm = raw.toUpperCase().replace(/[\s-]/g, '');
  return norm.length === 7 && /^[A-Z][0-9][0-9W][0-9A-Z]{4}$/.test(norm);
}

type DeliveryProfileRow = {
  _id: string;
  customerName: string;
  deliveryAddress: string;
  postalCode: string;
};

/** 同号多档案：优先选有邮编的（API 已按 updatedAt 降序，取第一条有邮编的） */
function pickPreferredDeliveryProfile(profiles: DeliveryProfileRow[]): DeliveryProfileRow | null {
  if (!profiles.length) return null;
  if (profiles.length === 1) return profiles[0];
  const withPostal = profiles.filter((p) => (p.postalCode || '').trim().length > 0);
  return withPostal[0] ?? profiles[0];
}

interface FrequentItemRow {
  menuItemId: string;
  itemName: string;
  itemNameEn: string;
  orderCount: number;
}

export default function CashierOrder() {
  const { t, i18n } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canDelivery = hasFeature('cashier.delivery.page');
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const canInventoryTracking = hasFeature('inventory.tracking');
  const lang = i18n.language;

  const menuSessionCacheKey = cashierMenuSessionCacheKey(getConfiguredStoreSlug(), lang);
  const initialMenuCache = getCashierMenuSessionCache(menuSessionCacheKey);

  const [categories, setCategories] = useState<Category[]>(() => (initialMenuCache?.categories as Category[]) ?? []);
  const [menuItems, setMenuItems] = useState<MenuItem[]>(() => (initialMenuCache?.menuItems as MenuItem[]) ?? []);
  const [invSummary, setInvSummary] = useState<Map<string, InventorySummaryRow>>(new Map());
  const [bomSnapshot, setBomSnapshot] = useState<BomAvailabilitySnapshot>(emptyBomSnapshot());

  const fetchBomSnapshot = useCallback(async () => {
    try {
      const res = await apiFetch('/api/menu/bom-availability');
      if (!res.ok) {
        setBomSnapshot(emptyBomSnapshot());
        return;
      }
      const data = (await res.json()) as BomAvailabilitySnapshot;
      setBomSnapshot(data?.enabled ? data : emptyBomSnapshot());
    } catch {
      setBomSnapshot(emptyBomSnapshot());
    }
  }, []);

  /**
   * 就地 patch 三处缓存：menuItems state、会话缓存、invSummary（颜色 / 剩余份数同步）。
   * 由下单 / 加菜成功后的 `inventoryUpdates` 调用；任何 currentQty 变化都应走这里。
   */
  const applyInventoryUpdates = useCallback((updates: Array<{ menuItemId: string; currentQty: number; perServing?: number; baseUnit?: string }>) => {
    if (Array.isArray(updates) && updates.length > 0) {
      setMenuItems(prev => prev.map(it => {
        const u = updates.find(x => x.menuItemId === it._id);
        if (!u) return it;
        return {
          ...it,
          inventory: {
            ...(it.inventory || {}),
            currentQty: Math.max(0, Math.floor(Number(u.currentQty) || 0)),
          },
        };
      }));
      setInvSummary(prev => {
        const next = new Map(prev);
        for (const u of updates) {
          const old = next.get(u.menuItemId);
          const perServing = Math.max(1, Math.floor(Number(u.perServing ?? old?.remainingServings ? 1 : 1) || 1));
          const cur = Math.max(0, Math.floor(Number(u.currentQty) || 0));
          const remainingServings = Math.floor(cur / perServing);
          let color: 'red' | 'orange' | 'green' = old?.color ?? 'green';
          if (cur <= 0 || remainingServings <= 0) color = 'red';
          else if (old && old.color === 'red') color = 'green';
          next.set(u.menuItemId, {
            menuItemId: u.menuItemId,
            color,
            currentQty: cur,
            remainingServings,
          });
        }
        return next;
      });
      const cacheKey = cashierMenuSessionCacheKey(getConfiguredStoreSlug(), lang);
      for (const u of updates) {
        patchCashierMenuInventoryQty(cacheKey, u.menuItemId, u.currentQty);
      }
    }
    void fetchBomSnapshot();
  }, [lang, fetchBomSnapshot]);
  const [activeCat, setActiveCat] = useState(() => initialMenuCache?.categories[0]?._id ?? '');
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<OrderLine[]>([]);
  const [orderType, setOrderType] = useState<'dine_in' | 'takeout' | 'phone' | 'delivery'>('dine_in');
  /** 电话单：后端要求 `customerPhone`（见 POST /api/orders type=phone） */
  const [phoneGuestPhone, setPhoneGuestPhone] = useState('');
  const [phoneGuestName, setPhoneGuestName] = useState('');
  /** 电话单 / 电话来源送餐：下单时已通过电话收取刷卡款（Checkout 记为 card） */
  const [phoneCardPaidAtPlacement, setPhoneCardPaidAtPlacement] = useState(false);
  /** 收银送餐（phone 来源）：与历史版本一致，下单后为 pending，顾客可再线上支付 */
  const [deliveryCustomerName, setDeliveryCustomerName] = useState('');
  const [deliveryCustomerPhone, setDeliveryCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryPostalCode, setDeliveryPostalCode] = useState('');
  const [deliveryFeeRules, setDeliveryFeeRules] = useState<DeliveryFeeTier[]>([]);
  const [deliveryGeoLoading, setDeliveryGeoLoading] = useState(false);
  const [deliveryDistanceKm, setDeliveryDistanceKm] = useState<number | null>(null);
  const [deliveryFeeInput, setDeliveryFeeInput] = useState('0.00');
  const [deliveryFeeTouched, setDeliveryFeeTouched] = useState(false);
  const [deliveryGeoError, setDeliveryGeoError] = useState('');
  const [deliveryCustomerProfileId, setDeliveryCustomerProfileId] = useState('');
  const [deliveryProfiles, setDeliveryProfiles] = useState<DeliveryProfileRow[]>([]);
  const geoReqRef = useRef(0);
  const memberDeliveryLookupReqRef = useRef(0);
  const deliveryPhoneRef = useRef('');
  const [deliveryCustomerCollapsed, setDeliveryCustomerCollapsed] = useState(false);
  const menuScrollRef = useRef<HTMLDivElement>(null);
  const categorySectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const categoryBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuScrollLockRef = useRef(false);
  const menuScrollLockTimerRef = useRef<number | undefined>(undefined);
  const pendingScrollCatRef = useRef<string | null>(null);
  const sidebarFollowCatRef = useRef(false);
  const [menuLoading, setMenuLoading] = useState(() => !(initialMenuCache && initialMenuCache.menuItems.length > 0));
  const frequentFetchGenRef = useRef(0);
  const [frequentItems, setFrequentItems] = useState<FrequentItemRow[]>([]);
  const [frequentItemsLoading, setFrequentItemsLoading] = useState(false);
  const [error, setError] = useState('');
  const [optionModal, setOptionModal] = useState<MenuItem | null>(null);

  // Payment modal state
  const [showPayment, setShowPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mixed' | 'member'>('cash');
  const [memberPhone, setMemberPhone] = useState('');
  const [memberPreview, setMemberPreview] = useState<CashierMemberPreview | null>(null);
  const [cashReceived, setCashReceived] = useState('');
  const [mixedCash, setMixedCash] = useState('');
  const [mixedCard, setMixedCard] = useState('');
  const [payingTotal, setPayingTotal] = useState(0);
  const [paying, setPaying] = useState(false);
  const [selectedCoupon, setSelectedCoupon] = useState<{ name: string; nameEn: string; amount: number } | null>(null);
  const [availableCoupons, setAvailableCoupons] = useState<{ _id: string; name: string; nameEn: string; amount: number }[]>([]);

  // Receipt state
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [checkoutMeta, setCheckoutMeta] = useState<{ total: number; cashReceived: number; change: number } | null>(null);
  const [receiptBundleDiscounts, setReceiptBundleDiscounts] = useState<{ name: string; nameEn: string; discount: number }[]>([]);
  const [phoneOrderId, setPhoneOrderId] = useState<string | null>(null);
  const [offers, setOffers] = useState<OfferData[]>([]);

  /** 与后台 / 管理端「堂食流程」一致：切换 pay_first / pay_after 时分流 */
  const [dineInWorkflowMode, setDineInWorkflowMode] = useState<'pay_first' | 'pay_after'>('pay_first');
  const [counterTableInput, setCounterTableInput] = useState('');
  const [counterGuestLabel, setCounterGuestLabel] = useState('');
  const [activeTableOrders, setActiveTableOrders] = useState<ActiveDineInOrderRow[]>([]);
  const [activeTableOrdersLoading, setActiveTableOrdersLoading] = useState(false);
  const dineInActiveFetchGen = useRef(0);
  const [importingActiveOrderId, setImportingActiveOrderId] = useState<string | null>(null);
  const [dineInSubmittedInfo, setDineInSubmittedInfo] = useState<{
    id: string;
    dineInOrderNumber?: string;
    tableNumber: number;
  } | null>(null);

  const refreshDineInWorkflowMode = useCallback(async (): Promise<'pay_first' | 'pay_after'> => {
    try {
      const r = await apiFetch('/api/admin/config');
      if (!r.ok) return 'pay_first';
      const d = (await r.json()) as { dine_in_workflow_mode?: string };
      const m = d.dine_in_workflow_mode === 'pay_after' ? 'pay_after' : 'pay_first';
      setDineInWorkflowMode(m);
      return m;
    } catch {
      return 'pay_first';
    }
  }, []);

  /** 全店菜单：缓存秒开 + 始终后台刷新（售罄/库存与后台同步） */
  const fetchMenu = useCallback(async (opts?: { force?: boolean }): Promise<MenuItem[]> => {
    const cacheKey = cashierMenuSessionCacheKey(getConfiguredStoreSlug(), lang);
    const cached = getCashierMenuSessionCache(cacheKey);
    const cacheFresh = !opts?.force
      && cached
      && Date.now() - cached.fetchedAt < CASHIER_MENU_CACHE_MAX_AGE_MS;

    if (cached && cached.menuItems.length > 0) {
      setCategories(cached.categories as Category[]);
      setMenuItems(cached.menuItems as MenuItem[]);
      if (cached.categories.length > 0) {
        setActiveCat((prev) =>
          prev && cached.categories.some((c) => c._id === prev) ? prev : cached.categories[0]._id,
        );
      } else {
        setActiveCat('');
      }
      if (cacheFresh) {
        setMenuLoading(false);
        void (async () => {
          try {
            const itemsRes = await apiFetch(`/api/menu/items?lang=${encodeURIComponent(lang)}`);
            if (!itemsRes.ok) return;
            const items: MenuItem[] = await itemsRes.json();
            setMenuItems(items);
            setCashierMenuSessionCache(cacheKey, {
              categories: cached!.categories,
              menuItems: items,
            });
          } catch {
            /* background refresh — ignore */
          }
        })();
        return cached.menuItems as MenuItem[];
      }
    } else {
      setMenuLoading(true);
      setMenuItems([]);
      categorySectionRefs.current = {};
    }

    try {
      const [catRes, itemsRes] = await Promise.all([
        apiFetch(`/api/menu/categories?lang=${encodeURIComponent(lang)}`),
        apiFetch(`/api/menu/items?lang=${encodeURIComponent(lang)}`),
      ]);
      let cats: Category[] = cached?.categories as Category[] ?? [];
      let items: MenuItem[] = cached?.menuItems as MenuItem[] ?? [];
      if (catRes.ok) {
        cats = await catRes.json();
        setCategories(cats);
        if (cats.length > 0) {
          setActiveCat((prev) => (prev && cats.some((c) => c._id === prev) ? prev : cats[0]._id));
        } else {
          setActiveCat('');
        }
      }
      if (itemsRes.ok) {
        items = await itemsRes.json();
        setMenuItems(items);
      }
      if (cats.length > 0 || items.length > 0) {
        setCashierMenuSessionCache(cacheKey, { categories: cats, menuItems: items });
      }
      return items;
    } finally {
      setMenuLoading(false);
    }
  }, [lang]);

  useEffect(() => {
    if (!canMemberWallet) {
      setPaymentMethod((pm) => (pm === 'member' ? 'cash' : pm));
      setMemberPreview(null);
    }
  }, [canMemberWallet]);

  const applyDeliveryProfileRow = useCallback((p: DeliveryProfileRow) => {
    setDeliveryCustomerProfileId(String(p._id));
    if (p.customerName?.trim()) setDeliveryCustomerName(p.customerName.trim());
    if (p.deliveryAddress?.trim()) setDeliveryAddress(p.deliveryAddress.trim());
    if (p.postalCode?.trim()) setDeliveryPostalCode(p.postalCode.trim());
    setDeliveryCustomerCollapsed(true);
  }, []);

  useEffect(() => {
    if (orderType !== 'delivery' || !token) {
      setDeliveryProfiles([]);
      return;
    }
    const phone = deliveryCustomerPhone.trim();
    if (phone.length < 5) {
      setDeliveryProfiles([]);
      return;
    }
    const tmr = window.setTimeout(() => {
      void apiFetch(`/api/orders/customer-profiles?phone=${encodeURIComponent(phone)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : []))
        .then((list: unknown) => {
          const arr = Array.isArray(list) ? (list as DeliveryProfileRow[]) : [];
          setDeliveryProfiles(arr);
          const preferred = pickPreferredDeliveryProfile(arr);
          if (preferred) applyDeliveryProfileRow(preferred);
        })
        .catch(() => setDeliveryProfiles([]));
    }, 400);
    return () => window.clearTimeout(tmr);
  }, [orderType, deliveryCustomerPhone, token, applyDeliveryProfileRow]);

  useEffect(() => {
    deliveryPhoneRef.current = deliveryCustomerPhone;
  }, [deliveryCustomerPhone]);

  useEffect(() => {
    if (!token || !canDelivery) {
      setDeliveryFeeRules([]);
      return;
    }
    let cancelled = false;
    void apiFetch('/api/admin/config', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, unknown>) => {
        if (cancelled) return;
        const raw = d[DELIVERY_FEE_RULES_CONFIG_KEY];
        setDeliveryFeeRules(typeof raw === 'string' ? parseDeliveryFeeRulesJson(raw) : []);
      })
      .catch(() => {
        if (!cancelled) setDeliveryFeeRules([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, canDelivery]);

  const lookupEircode = useCallback(async (raw: string) => {
    const norm = raw.toUpperCase().replace(/[\s-]/g, '');
    if (norm.length !== 7 || !/^[A-Z][0-9][0-9W][0-9A-Z]{4}$/.test(norm)) {
      setDeliveryDistanceKm(null);
      setDeliveryGeoError('');
      setDeliveryGeoLoading(false);
      return;
    }
    const id = ++geoReqRef.current;
    setDeliveryGeoLoading(true);
    setDeliveryGeoError('');
    try {
      const codeParam = `${norm.slice(0, 3)} ${norm.slice(3)}`;
      const res = await apiFetch(`/api/geo/eircode?code=${encodeURIComponent(codeParam)}`);
      const data = (await res.json().catch(() => null)) as {
        formattedAddress?: string;
        distanceKm?: number;
        error?: { message?: string };
      } | null;
      if (id !== geoReqRef.current) return;
      if (!res.ok) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      // 仅在没有地址时由邮编反填；已有地址（含地址→邮编推导）时不覆盖店员/档案原文
      setDeliveryAddress((prev) => {
        if (prev.trim()) return prev;
        return data?.formattedAddress || '';
      });
      setDeliveryDistanceKm(typeof data?.distanceKm === 'number' ? data.distanceKm : null);
    } catch (e) {
      if (id !== geoReqRef.current) return;
      setDeliveryDistanceKm(null);
      setDeliveryGeoError(e instanceof Error ? e.message : t('cashier.geoLookupErrorFallback'));
    } finally {
      if (id === geoReqRef.current) setDeliveryGeoLoading(false);
    }
  }, [t]);

  const lookupAddressToEircode = useCallback(
    async (addressRaw: string, profileId?: string) => {
      const address = addressRaw.trim();
      if (address.length < 8) {
        setDeliveryDistanceKm(null);
        setDeliveryGeoError('');
        setDeliveryGeoLoading(false);
        return;
      }
      const id = ++geoReqRef.current;
      setDeliveryGeoLoading(true);
      setDeliveryGeoError('');
      try {
        const q = new URLSearchParams({ address });
        const pid = profileId?.trim() || '';
        if (pid && isMongoObjectId(pid)) {
          q.set('customerProfileId', pid);
        }
        const res = await apiFetch(`/api/geo/address?${q.toString()}`);
        const data = (await res.json().catch(() => null)) as {
          eircode?: string;
          distanceKm?: number;
          error?: { message?: string };
        } | null;
        if (id !== geoReqRef.current) return;
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const code = String(data?.eircode || '').trim();
        if (!code) {
          throw new Error(t('cashier.geoAddressNoEircode'));
        }
        setDeliveryPostalCode(code);
        setDeliveryDistanceKm(typeof data?.distanceKm === 'number' ? data.distanceKm : null);
      } catch (e) {
        if (id !== geoReqRef.current) return;
        setDeliveryDistanceKm(null);
        setDeliveryGeoError(
          e instanceof Error ? e.message : t('cashier.geoAddressLookupErrorFallback'),
        );
      } finally {
        if (id === geoReqRef.current) setDeliveryGeoLoading(false);
      }
    },
    [t],
  );

  const runMemberDeliveryLookup = useCallback(
    async (phoneRaw?: string) => {
      if (orderType !== 'delivery' || !token) return;
      const raw = phoneRaw ?? deliveryPhoneRef.current;
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 8) return;
      const id = ++memberDeliveryLookupReqRef.current;
      try {
        const res = await apiFetch(`/api/members/delivery-lookup?phone=${encodeURIComponent(raw.trim() || digits)}`);
        const data = (res.ok ? await res.json().catch(() => null) : null) as {
          _id?: string;
          displayName?: string;
          deliveryAddress?: string;
          postalCode?: string;
        } | null;
        if (id !== memberDeliveryLookupReqRef.current) return;
        if (deliveryPhoneRef.current.replace(/\D/g, '') !== digits) return;
        if (!data?._id) return;
        setDeliveryCustomerName(String(data.displayName || '').trim());
        setDeliveryPostalCode(String(data.postalCode || '').trim());
        setDeliveryAddress(String(data.deliveryAddress || '').trim());
        setDeliveryCustomerCollapsed(true);
      } catch {
        /* ignore */
      }
    },
    [orderType, token],
  );

  useEffect(() => {
    if (orderType !== 'delivery' || !token) return;
    const digits = deliveryCustomerPhone.replace(/\D/g, '');
    if (digits.length < 10) return;
    const timerId = window.setTimeout(() => {
      void runMemberDeliveryLookup(deliveryPhoneRef.current);
    }, 450);
    return () => window.clearTimeout(timerId);
  }, [orderType, token, deliveryCustomerPhone, runMemberDeliveryLookup]);

  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryCustomerCollapsed(false);
      setFrequentItems([]);
    }
  }, [orderType]);

  /** 常点：不依赖 canDelivery（避免 features 尚未从 /api/admin/features 返回时跳过首刷）；与送餐模式一致即可 */
  useEffect(() => {
    if (orderType !== 'delivery' || !token) {
      setFrequentItems([]);
      setFrequentItemsLoading(false);
      return;
    }
    const digits = deliveryCustomerPhone.replace(/\D/g, '');
    if (digits.length < 8) {
      setFrequentItems([]);
      setFrequentItemsLoading(false);
      return;
    }
    const gen = ++frequentFetchGenRef.current;
    const phoneSnapshot = deliveryCustomerPhone.trim();
    const tid = window.setTimeout(() => {
      setFrequentItemsLoading(true);
      const phoneQ = encodeURIComponent(phoneSnapshot);
      void apiFetch(
        `/api/orders/customer-frequent-items?phone=${phoneQ}&days=${FREQUENT_LOOKBACK_DAYS}&limit=${FREQUENT_ITEMS_LIMIT}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
        .then((r) => (r.ok ? r.json() : []))
        .then((list: unknown) => {
          if (gen !== frequentFetchGenRef.current) return;
          setFrequentItems(Array.isArray(list) ? (list as FrequentItemRow[]) : []);
        })
        .catch(() => {
          if (gen !== frequentFetchGenRef.current) return;
          setFrequentItems([]);
        })
        .finally(() => {
          if (gen !== frequentFetchGenRef.current) return;
          setFrequentItemsLoading(false);
        });
    }, 350);
    return () => window.clearTimeout(tid);
  }, [orderType, deliveryCustomerPhone, token]);

  useEffect(() => {
    if (orderType !== 'delivery' || !canDelivery) {
      setDeliveryDistanceKm(null);
      setDeliveryGeoError('');
      setDeliveryGeoLoading(false);
      return;
    }
    const timerId = window.setTimeout(() => {
      void lookupEircode(deliveryPostalCode);
    }, 500);
    return () => window.clearTimeout(timerId);
  }, [deliveryPostalCode, orderType, canDelivery, lookupEircode]);

  useEffect(() => {
    if (orderType !== 'delivery' || !canDelivery) return;
    const address = deliveryAddress.trim();
    if (address.length < 8) return;
    if (isValidEircodeInput(deliveryPostalCode)) return;
    const timerId = window.setTimeout(() => {
      void lookupAddressToEircode(address, deliveryCustomerProfileId);
    }, 600);
    return () => window.clearTimeout(timerId);
  }, [
    deliveryAddress,
    deliveryPostalCode,
    deliveryCustomerProfileId,
    orderType,
    canDelivery,
    lookupAddressToEircode,
  ]);

  const fetchPromosDeferred = useCallback(async () => {
    const [offersRes, couponsRes] = await Promise.all([
      apiFetch('/api/offers'),
      apiFetch('/api/coupons'),
    ]);
    if (offersRes.ok) setOffers(await offersRes.json());
    if (couponsRes.ok) setAvailableCoupons(await couponsRes.json());
  }, []);

  useEffect(() => {
    void fetchMenu();
    void fetchBomSnapshot();
  }, [fetchMenu, fetchBomSnapshot]);

  /** 窗口重新聚焦时强制刷新菜单（售罄可能在其它标签页被修改） */
  useEffect(() => {
    const onFocus = () => { void fetchMenu({ force: true }); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchMenu]);

  useEffect(() => {
    if (!canInventoryTracking || !token) {
      setInvSummary(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/inventory/summary', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const rows: InventorySummaryRow[] = await res.json();
        if (cancelled) return;
        const map = new Map<string, InventorySummaryRow>();
        for (const r of rows) map.set(r.menuItemId, r);
        setInvSummary(map);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [canInventoryTracking, token, menuItems]);

  useEffect(() => {
    void refreshDineInWorkflowMode();
  }, [refreshDineInWorkflowMode, token]);

  useEffect(() => {
    const gen = ++dineInActiveFetchGen.current;
    if (!token || orderType !== 'dine_in' || dineInWorkflowMode !== 'pay_after') {
      setActiveTableOrders([]);
      setActiveTableOrdersLoading(false);
      return;
    }
    const raw = counterTableInput.trim();
    const n = parseInt(raw, 10);
    if (raw === '' || !Number.isFinite(n) || n < 1) {
      setActiveTableOrders([]);
      setActiveTableOrdersLoading(false);
      return;
    }
    const tid = window.setTimeout(() => {
      void (async () => {
        setActiveTableOrdersLoading(true);
        try {
          const res = await apiFetch(`/api/orders/dine-in/active?table=${n}&seat=0`);
          const rows = res.ok ? ((await res.json()) as ActiveDineInOrderRow[]) : [];
          if (gen !== dineInActiveFetchGen.current) return;
          setActiveTableOrders(Array.isArray(rows) ? rows : []);
        } catch {
          if (gen !== dineInActiveFetchGen.current) return;
          setActiveTableOrders([]);
        } finally {
          if (gen === dineInActiveFetchGen.current) setActiveTableOrdersLoading(false);
        }
      })();
    }, 200);
    return () => {
      window.clearTimeout(tid);
    };
  }, [counterTableInput, orderType, dineInWorkflowMode, token]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshDineInWorkflowMode();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshDineInWorkflowMode]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void fetchPromosDeferred();
    };
    let idleId: number | undefined;
    /** DOM 下 setTimeout 返回 number，与 Node Timeout 区分 */
    let timeoutId: number | undefined;
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(run, { timeout: 2500 });
    } else {
      timeoutId = window.setTimeout(run, 1);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [fetchPromosDeferred]);

  const getName = (translations: Translation[]) => {
    const found = translations.find(t2 => t2.locale === lang) || translations[0];
    return found?.name || '';
  };

  const menuSections = useMemo(() => {
    const byCat = new Map<string, MenuItem[]>();
    for (const item of menuItems) {
      const cid = item.categoryId || '';
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid)!.push(item);
    }
    return categories
      .map((cat) => ({ category: cat, items: byCat.get(cat._id) || [] }))
      .filter((sec) => sec.items.length > 0);
  }, [categories, menuItems]);

  const searchFilteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return menuItems.filter((i) => i.translations.some((t2) => t2.name.toLowerCase().includes(q)));
  }, [menuItems, search]);

  const getSectionScrollTop = useCallback((root: HTMLElement, section: HTMLElement) => {
    const rootRect = root.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return Math.max(0, root.scrollTop + (sectionRect.top - rootRect.top) - 4);
  }, []);

  const pickActiveCategoryFromScroll = useCallback(
    (root: HTMLElement) => {
      const anchorY = root.getBoundingClientRect().top + 48;
      let currentId = menuSections[0]?.category._id ?? '';
      for (const sec of menuSections) {
        const el = categorySectionRefs.current[sec.category._id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= anchorY) {
          currentId = sec.category._id;
        }
      }
      return currentId;
    },
    [menuSections],
  );

  const lockMenuScrollSync = useCallback((root: HTMLElement, ms: number) => {
    menuScrollLockRef.current = true;
    if (menuScrollLockTimerRef.current) window.clearTimeout(menuScrollLockTimerRef.current);
    const unlock = () => {
      menuScrollLockRef.current = false;
      root.removeEventListener('scrollend', unlock);
    };
    menuScrollLockTimerRef.current = window.setTimeout(unlock, ms);
    root.addEventListener('scrollend', unlock, { once: true });
  }, []);

  const scrollToCategory = useCallback(
    (catId: string) => {
      if (search.trim()) {
        pendingScrollCatRef.current = catId;
        setSearch('');
        return;
      }
      const root = menuScrollRef.current;
      const el = categorySectionRefs.current[catId];
      if (!root || !el) {
        setActiveCat(catId);
        return;
      }
      sidebarFollowCatRef.current = true;
      setActiveCat(catId);
      lockMenuScrollSync(root, 900);
      root.scrollTo({ top: getSectionScrollTop(root, el), behavior: 'smooth' });
    },
    [search, getSectionScrollTop, lockMenuScrollSync],
  );

  useEffect(() => {
    const catId = pendingScrollCatRef.current;
    if (!catId || search.trim() || menuSections.length === 0) return;
    pendingScrollCatRef.current = null;
    const root = menuScrollRef.current;
    const el = categorySectionRefs.current[catId];
    if (root && el) {
      sidebarFollowCatRef.current = true;
      setActiveCat(catId);
      lockMenuScrollSync(root, 400);
      root.scrollTo({ top: getSectionScrollTop(root, el), behavior: 'auto' });
    } else {
      setActiveCat(catId);
    }
  }, [search, menuSections, getSectionScrollTop, lockMenuScrollSync]);

  useEffect(() => {
    const root = menuScrollRef.current;
    if (!root || search.trim() || menuSections.length === 0) return;
    let raf = 0;
    const onScroll = () => {
      if (menuScrollLockRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const currentId = pickActiveCategoryFromScroll(root);
        if (currentId) {
          setActiveCat((prev) => (prev === currentId ? prev : currentId));
        }
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [menuSections, search, pickActiveCategoryFromScroll]);

  useEffect(() => {
    if (search.trim() || !sidebarFollowCatRef.current) return;
    sidebarFollowCatRef.current = false;
    const btn = categoryBtnRefs.current[activeCat];
    btn?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [activeCat, search]);

  /** 将同桌某条待结订单的菜品追加到当前点单（显式点击列表行） */
  const appendActiveOrderToCart = useCallback(
    async (ord: ActiveDineInOrderRow) => {
      const lines = buildLinesFromActiveDineInOrders([ord], lang);
      if (lines.length === 0) return;
      setImportingActiveOrderId(ord._id);
      try {
        const mids = new Set(lines.map((l) => l.menuItemId));
        const needMerge = [...mids].some((id) => !menuItems.some((m) => m._id === id));
        if (needMerge) {
          await fetchMenu();
        }
        setOrder((prev) => [...prev, ...lines]);
      } finally {
        setImportingActiveOrderId(null);
      }
    },
    [menuItems, fetchMenu, lang],
  );

  const computeInvAvailability = (item: MenuItem): { remaining: number; blocked: boolean; color: 'red' | 'orange' | 'green' | null } => {
    if (!item.inventoryTracked) return { remaining: Infinity, blocked: false, color: null };
    const perServing = Math.max(1, Math.floor(Number(item.inventory?.perServing) || 1));
    const cur = Math.max(0, Number(item.inventory?.currentQty) || 0);
    const remaining = Math.floor(cur / perServing) - getItemCount(item._id);
    const color = invSummary.get(item._id)?.color ?? (cur <= 0 ? 'red' : null);
    return { remaining, blocked: remaining <= 0, color };
  };

  const orderBomLines = useMemo(
    () => order.map((o) => ({
      menuItemId: o.menuItemId,
      quantity: 1,
      options: (o.options || [])
        .filter((opt) => !opt.isAdHoc && opt.groupId && opt.choiceId)
        .map((opt) => ({ groupId: opt.groupId!, choiceId: opt.choiceId! })),
    })),
    [order],
  );

  const orderBomDemand = useMemo(
    () => (bomSnapshot.enabled ? computeCartRawDemand(orderBomLines, bomSnapshot) : {}),
    [orderBomLines, bomSnapshot],
  );

  const computeBomItemBlocked = (item: MenuItem): boolean => {
    if (!bomSnapshot.enabled) return false;
    const itemBom = bomSnapshot.items[item._id];
    if (!itemBom || itemBom.itemConsumption.length === 0) return false;
    return isItemServingBlocked(itemBom, bomSnapshot.materials, orderBomDemand);
  };

  const rejectItemAdd = (item: MenuItem): boolean => {
    if (item.isSoldOut) {
      alert(t('cashier.orderSoldOutNotice'));
      return true;
    }
    const av = computeInvAvailability(item);
    if (av.blocked) {
      alert(t('cashier.invOutOfStockNotice', { defaultValue: '该菜品库存不足' }));
      return true;
    }
    if (computeBomItemBlocked(item)) {
      alert(t('cashier.invOutOfStockNotice', { defaultValue: '该菜品库存不足' }));
      return true;
    }
    return false;
  };

  /** 提交前校验：购物车是否含售罄菜（强制拉最新菜单） */
  const findSoldOutInOrder = (lines: OrderLine[], items: MenuItem[]): string[] => {
    const byId = new Map(items.map((m) => [m._id, m]));
    const names = new Set<string>();
    for (const line of lines) {
      const mi = byId.get(line.menuItemId);
      if (mi?.isSoldOut) names.add(line.name);
    }
    return [...names];
  };

  const ensureOrderNotSoldOut = useCallback(async (): Promise<boolean> => {
    const freshItems = await fetchMenu({ force: true });
    const soldOutNames = findSoldOutInOrder(order, freshItems);
    if (soldOutNames.length > 0) {
      setError(t('cashier.orderContainsSoldOut', { names: soldOutNames.join('、') }));
      return false;
    }
    return true;
  }, [fetchMenu, order, t]);

  const addToOrder = (item: MenuItem) => {
    if (rejectItemAdd(item)) return;
    if (item.optionGroups && item.optionGroups.length > 0) { setOptionModal(item); return; }
    setOrder((prev) => [
      ...prev,
      {
        id: nextLineId(),
        menuItemId: item._id,
        name: getName(item.translations),
        price: item.price,
      },
    ]);
  };

  const addToOrderWithOptions = (item: MenuItem, cartOptions: CartItemOption[]) => {
    if (rejectItemAdd(item)) return;
    const options: OrderItemOption[] = cartOptions.map(o => ({
      groupId: o.groupId,
      choiceId: o.choiceId,
      groupName: o.groupName,
      choiceName: o.choiceName,
      extraPrice: o.extraPrice,
    }));
    setOrder((prev) => [
      ...prev,
      {
        id: nextLineId(),
        menuItemId: item._id,
        name: getName(item.translations),
        price: item.price,
        options: options.map((o) => ({ ...o })),
      },
    ]);
    setOptionModal(null);
  };

  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [adHocModalGroup, setAdHocModalGroup] = useState<OrderLineGroup | null>(null);

  const openAdHocModal = (group: OrderLineGroup) => {
    const adHocCount = (group.representative.options || []).filter((o) => o.isAdHoc).length;
    if (adHocCount >= AD_HOC_MAX_PER_LINE) {
      setError(t('cashier.adHocMaxReached'));
      return;
    }
    setError('');
    setAdHocModalGroup(group);
  };

  const applyAdHocOption = (result: AdHocOptionFormResult) => {
    if (!adHocModalGroup) return;
    const newOpt: OrderItemOption = {
      isAdHoc: true,
      groupName: { 'zh-CN': '加料', 'en-US': 'Extra' },
      choiceName: { 'zh-CN': result.choiceNameZh, 'en-US': result.choiceNameEn },
      extraPrice: result.extraPrice,
    };
    const ids = new Set(adHocModalGroup.lineIds);
    setOrder((prev) =>
      prev.map((o) => (ids.has(o.id) ? { ...o, options: [...(o.options || []), newOpt] } : o)),
    );
    setAdHocModalGroup(null);
  };

  const startEditPrice = (lineId: string, currentPrice: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingLineId(lineId);
    setEditPrice(currentPrice.toFixed(2));
  };

  const confirmEditPrice = (lineId: string) => {
    const newPrice = parseFloat(editPrice);
    if (!isNaN(newPrice) && newPrice >= 0) {
      const line = order.find((o) => o.id === lineId);
      if (line) {
        const key = lineGroupKey(line);
        setOrder((prev) => prev.map((o) => (lineGroupKey(o) === key ? { ...o, price: newPrice } : o)));
      }
    }
    setEditingLineId(null);
  };

  const removeGroup = (lineIds: string[]) => {
    if (editingLineId) return;
    const drop = new Set(lineIds);
    setOrder((prev) => prev.filter((o) => !drop.has(o.id)));
  };

  const setGroupQuantity = (group: OrderLineGroup, newQty: number) => {
    if (editingLineId) return;
    const qty = Math.max(0, Math.min(QUICK_ADD_QTY_MAX, Math.floor(newQty)));
    if (qty === group.quantity) return;
    if (qty === 0) {
      removeGroup(group.lineIds);
      return;
    }
    if (qty > group.quantity) {
      const add = qty - group.quantity;
      const template = group.representative;
      setOrder((prev) => [
        ...prev,
        ...Array.from({ length: add }, () => ({
          id: nextLineId(),
          menuItemId: template.menuItemId,
          name: template.name,
          price: template.price,
          options: template.options?.map((o) => ({ ...o })),
        })),
      ]);
      return;
    }
    const removeIds = new Set(group.lineIds.slice(qty));
    setOrder((prev) => prev.filter((o) => !removeIds.has(o.id)));
  };

  const groupedOrderLines = useMemo(() => groupOrderLines(order), [order]);

  const totalAmount = order.reduce((s, o) => s + o.price + (o.options || []).reduce((sum, opt) => sum + opt.extraPrice, 0), 0);
  const getItemCount = (menuItemId: string) => order.filter(o => o.menuItemId === menuItemId).length;

  const renderMenuItemCard = (item: MenuItem) => {
    const qty = getItemCount(item._id);
    const av = computeInvAvailability(item);
    const bomBlocked = computeBomItemBlocked(item);
    const invBlocked = av.blocked || bomBlocked;
    const cardClass = [
      'cashier-menu-card',
      qty > 0 ? 'is-selected' : '',
      item.isSoldOut || invBlocked ? 'is-disabled' : '',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={item._id}
        className={cardClass}
        onClick={() => addToOrder(item)}
        style={qty > 0 ? undefined : !item.isSoldOut && invBlocked && av.color === 'red' ? { border: '2px solid #C62828' }
          : !item.isSoldOut && invBlocked && av.color === 'orange' ? { border: '2px solid #E65100' }
          : undefined}
      >
        {qty > 0 && <span className="cashier-menu-card-qty">{qty}</span>}
        {item.isSoldOut && (
          <span className="cashier-menu-card-soldout">{t('cashier.orderSoldOutBadge')}</span>
        )}
        <div className="cashier-menu-card-name">{getName(item.translations)}</div>
        <div className="cashier-menu-card-price">€{item.price}</div>
        {item.optionGroups && item.optionGroups.length > 0 && (
          <div className="cashier-menu-card-meta">⚙ {t('customer.selectOptions')}</div>
        )}
        {item.inventoryTracked && !item.isSoldOut && (
          <div
            className="cashier-menu-card-inv"
            style={{
              background: av.color === 'red' ? '#FFEBEE' : av.color === 'orange' ? '#FFF3E0' : '#F1F8E9',
              color: av.color === 'red' ? '#C62828' : av.color === 'orange' ? '#E65100' : '#2E7D32',
            }}
          >
            📦 {Math.max(0, av.remaining)} {t('cashier.invServings')}
          </div>
        )}
      </div>
    );
  };

  // Bundle matching
  const matchedBundles: MatchedBundle[] = useMemo(() => {
    if (offers.length === 0 || order.length === 0) return [];
    const cartEntries = order.map(line => {
      const mi = menuItems.find(m => m._id === line.menuItemId);
      const optExtra = (line.options || []).reduce((s, o) => s + o.extraPrice, 0);
      return {
        key: line.id,
        menuItemId: line.menuItemId,
        categoryId: mi?.categoryId || '',
        basePrice: line.price,
        optionExtra: optExtra,
        quantity: 1,
      };
    });
    return matchBundles(cartEntries, offers);
  }, [order, offers, menuItems]);

  const bundleTotals = useMemo(() => {
    const cartEntries = order.map(line => {
      const optExtra = (line.options || []).reduce((s, o) => s + o.extraPrice, 0);
      return {
        key: line.id,
        menuItemId: line.menuItemId,
        categoryId: menuItems.find(m => m._id === line.menuItemId)?.categoryId || '',
        basePrice: line.price,
        optionExtra: optExtra,
        quantity: 1,
      };
    });
    return calcBundleTotal(cartEntries, matchedBundles);
  }, [order, matchedBundles, menuItems]);

  const finalTotal = bundleTotals.finalTotal;

  const autoDeliveryFee = useMemo(() => {
    if (orderType !== 'delivery' || deliveryDistanceKm == null) return 0;
    return deliveryFeeForDistance(deliveryFeeRules, deliveryDistanceKm);
  }, [orderType, deliveryDistanceKm, deliveryFeeRules]);

  const effectiveDeliveryFee = useMemo(() => {
    const parsed = parseDeliveryFeeEuroInput(deliveryFeeInput);
    if (deliveryFeeTouched && parsed !== null) return parsed;
    return autoDeliveryFee;
  }, [deliveryFeeInput, deliveryFeeTouched, autoDeliveryFee]);

  useEffect(() => {
    if (orderType !== 'delivery' || deliveryFeeTouched) return;
    setDeliveryFeeInput(autoDeliveryFee.toFixed(2));
  }, [orderType, autoDeliveryFee, deliveryFeeTouched, deliveryDistanceKm]);

  const grandTotal = finalTotal + (orderType === 'delivery' ? effectiveDeliveryFee : 0);
  const displayTotal = orderType === 'delivery' ? grandTotal : finalTotal;
  const deliveryFeeEditable = deliveryFeeRules.length === 0 || deliveryDistanceKm != null;

  const renderDeliveryFeeField = (compact = false) => {
    const feeInput = (
      <>
        <span style={{ color: compact ? 'var(--text-light)' : undefined, fontSize: compact ? 11 : undefined }}>
          {t('cashier.deliveryFee')}:
        </span>
        <span style={{ fontWeight: 600 }}>€</span>
        <input
          className="cashier-qty-input"
          type="number"
          min={0}
          step="0.01"
          value={deliveryFeeInput}
          disabled={!deliveryFeeEditable}
          onChange={(e) => {
            setDeliveryFeeTouched(true);
            setDeliveryFeeInput(e.target.value);
          }}
          style={{ width: 56, textAlign: 'center', fontWeight: 600 }}
        />
        {deliveryFeeTouched &&
        deliveryFeeRules.length > 0 &&
        deliveryDistanceKm != null &&
        Math.abs(effectiveDeliveryFee - autoDeliveryFee) > 0.001 ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: '2px 6px' }}
            onClick={() => {
              setDeliveryFeeTouched(false);
              setDeliveryFeeInput(autoDeliveryFee.toFixed(2));
            }}
          >
            {t('cashier.deliveryFeeResetAuto')}
          </button>
        ) : null}
      </>
    );

    if (compact) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 12, whiteSpace: 'nowrap' }}>
          {feeInput}
        </span>
      );
    }

    return (
      <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>{feeInput}</div>
        <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 4 }}>{t('cashier.deliveryFeeEditableHint')}</div>
        {deliveryFeeTouched &&
        deliveryFeeRules.length > 0 &&
        deliveryDistanceKm != null &&
        Math.abs(effectiveDeliveryFee - autoDeliveryFee) > 0.001 ? (
          <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
            {t('cashier.deliveryFeeAutoHint', { amount: autoDeliveryFee.toFixed(2) })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderDeliveryGeoSection = () => (
    <>
      {deliveryGeoLoading ? (
        <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('cashier.deliveryParsingPostcode')}</div>
      ) : null}
      {deliveryGeoError ? (
        <div style={{ fontSize: 11, color: 'var(--red-primary)' }}>{deliveryGeoError}</div>
      ) : null}
      {deliveryDistanceKm != null && !deliveryGeoLoading ? (
        <div style={{ fontSize: 12, color: '#1565c0' }}>{t('cashier.deliveryDistanceKm', { km: deliveryDistanceKm })}</div>
      ) : null}
      {deliveryAddress.trim() || deliveryPostalCode.trim() ? (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(deliveryAddress.trim() || deliveryPostalCode.trim())}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#1565c0', textDecoration: 'underline', display: 'inline-block', marginTop: 2 }}
        >
          {t('cashier.openInGoogleMaps')} ↗
        </a>
      ) : null}
      {deliveryFeeRules.length > 0 &&
      !deliveryGeoLoading &&
      deliveryPostalCode.trim().length >= 5 &&
      deliveryDistanceKm == null &&
      !deliveryGeoError ? (
        <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>{t('cashier.deliveryFeeRulesNeedDistance')}</div>
      ) : null}
      {renderDeliveryFeeField()}
    </>
  );

  const renderDeliveryFrequentSection = () => {
    const digitLen = deliveryCustomerPhone.replace(/\D/g, '').length;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
          {t('cashier.frequentItemsTitle', { days: FREQUENT_LOOKBACK_DAYS })}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-light)', marginBottom: 6, lineHeight: 1.35 }}>
          {t('cashier.frequentItemsHint')}
        </div>
        {digitLen < 8 ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
            {t('cashier.frequentItemsPhoneHint', { days: FREQUENT_LOOKBACK_DAYS })}
          </div>
        ) : frequentItemsLoading ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('cashier.frequentItemsLoading')}</div>
        ) : frequentItems.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-light)' }}>{t('cashier.frequentItemsEmpty')}</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, lineHeight: 1.45 }}>
            {frequentItems.map((row) => {
              const label = lang.startsWith('zh') || !row.itemNameEn?.trim() ? row.itemName : row.itemNameEn;
              return (
                <li key={row.menuItemId} style={{ marginBottom: 3 }}>
                  <span style={{ fontWeight: 600 }}>{label}</span>
                  <span style={{ color: 'var(--text-light)', marginLeft: 4 }}>
                    {t('cashier.frequentItemsCount', { count: row.orderCount })}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    );
  };

  const switchOrderType = (next: 'dine_in' | 'takeout' | 'phone' | 'delivery') => {
    setOrderType(next);
    setError('');
    setDeliveryCustomerProfileId('');
    if (next !== 'phone') {
      setPhoneGuestPhone('');
      setPhoneGuestName('');
    }
    setPhoneCardPaidAtPlacement(false);
    if (next !== 'dine_in') {
      setCounterTableInput('');
      setCounterGuestLabel('');
    }
    if (next !== 'delivery') {
      setDeliveryCustomerName('');
      setDeliveryCustomerPhone('');
      setDeliveryAddress('');
      setDeliveryPostalCode('');
      setDeliveryDistanceKm(null);
      setDeliveryGeoError('');
      setDeliveryGeoLoading(false);
      setDeliveryFeeInput('0.00');
      setDeliveryFeeTouched(false);
      setDeliveryCustomerCollapsed(false);
      setDeliveryProfiles([]);
      setFrequentItems([]);
    }
  };

  // Phone order: create order only, print kitchen receipt, no payment
  const handlePhoneOrder = async () => {
    setPaying(true);
    setError('');
    try {
      if (!(await ensureOrderNotSoldOut())) return;
      const orderBody: Record<string, unknown> = {
        type: 'phone',
        items: buildGroupedItems(),
      };
      if (phoneGuestPhone.trim()) {
        orderBody.customerPhone = phoneGuestPhone.trim();
      }
      if (phoneGuestName.trim()) {
        orderBody.customerName = phoneGuestName.trim();
      }
      if (matchedBundles.length > 0) {
        orderBody.appliedBundles = matchedBundles.map(b => ({ offerId: b.offer._id, name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }));
      }
      if (phoneCardPaidAtPlacement) {
        orderBody.placementPrepaidMethod = 'card';
        orderBody.phoneCardPaidAtPlacement = true;
      }
      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) { const d = await orderRes.json().catch(() => null); throw new Error(d?.error?.message || t('common.error')); }
      const orderData = await orderRes.json();
      applyInventoryUpdates(orderData?.inventoryUpdates || []);

      // Print receipt for phone order
      try {
        const configRes = await apiFetch('/api/admin/config');
        const cfg = configRes.ok ? await configRes.json() : {};
        const receiptData = {
          checkoutId: orderData._id,
          type: 'seat' as const,
          totalAmount: finalTotal,
          paymentMethod: ((orderData as { phoneCardPaidAtPlacement?: boolean }).phoneCardPaidAtPlacement ? 'card' : 'cash') as 'cash' | 'card',
          checkedOutAt: new Date().toISOString(),
          orders: [{
            _id: orderData._id,
            type: 'phone' as const,
            dailyOrderNumber: orderData.dailyOrderNumber,
            status: (orderData.status as string) || 'pending',
            items: orderData.items,
          }],
        };
        void printBuiltReceipt(receiptData, cfg, {
          bundleDiscounts: matchedBundles.length > 0
            ? matchedBundles.map((b) => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }))
            : undefined,
          copies: 1,
        });
      } catch { /* print error ignored */ }

      setPhoneOrderId(orderData._id);
      setOrder([]);
      setPhoneGuestPhone('');
      setPhoneGuestName('');
      setPhoneCardPaidAtPlacement(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setPaying(false);
    }
  };

  const handleDeliveryPhoneOrder = async () => {
    if (!deliveryCustomerName.trim() || !deliveryCustomerPhone.trim() || !deliveryAddress.trim() || !deliveryPostalCode.trim()) {
      setError(t('cashier.errDeliveryNeedFields'));
      return;
    }
    if (deliveryFeeRules.length > 0 && deliveryDistanceKm == null) {
      setError(t('cashier.deliveryFeeRulesNeedDistance'));
      return;
    }
    const parsedDeliveryFee = parseDeliveryFeeEuroInput(deliveryFeeInput);
    if (parsedDeliveryFee === null) {
      setError(t('cashier.deliveryFeeInvalidInput'));
      return;
    }
    if (deliveryProfiles.length > 1) {
      const pid = deliveryCustomerProfileId.trim();
      if (!pid) {
        setError(t('cashier.deliveryPickProfileRequired'));
        return;
      }
      if (pid !== DELIVERY_PROFILE_NEW_MANUAL && !isMongoObjectId(pid)) {
        setError(t('cashier.deliveryPickProfileRequired'));
        return;
      }
    }
    setPaying(true);
    setError('');
    try {
      if (!(await ensureOrderNotSoldOut())) return;
      const orderBody: Record<string, unknown> = {
        type: 'delivery',
        deliverySource: 'phone',
        customerName: deliveryCustomerName.trim(),
        customerPhone: deliveryCustomerPhone.trim(),
        deliveryAddress: deliveryAddress.trim(),
        postalCode: deliveryPostalCode.trim(),
        items: buildGroupedItems(),
      };
      if (matchedBundles.length > 0) {
        orderBody.appliedBundles = matchedBundles.map((b) => ({
          offerId: b.offer._id,
          name: b.offer.name,
          nameEn: b.offer.nameEn,
          discount: b.savings,
        }));
      }
      if (deliveryDistanceKm != null) {
        orderBody.deliveryDistanceKm = deliveryDistanceKm;
      }
      orderBody.deliveryFeeEuroOverride = parsedDeliveryFee;
      const profileIdRaw = deliveryCustomerProfileId.trim();
      if (profileIdRaw && profileIdRaw !== DELIVERY_PROFILE_NEW_MANUAL && isMongoObjectId(profileIdRaw)) {
        orderBody.customerProfileId = profileIdRaw;
      }
      if (phoneCardPaidAtPlacement) {
        orderBody.placementPrepaidMethod = 'card';
        orderBody.phoneCardPaidAtPlacement = true;
      }
      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) {
        const d = (await orderRes.json().catch(() => null)) as {
          error?: { message?: string; details?: { customerProfiles?: typeof deliveryProfiles } };
        } | null;
        if (orderRes.status === 409 && d?.error?.details?.customerProfiles?.length) {
          const profiles = d.error.details.customerProfiles;
          setDeliveryProfiles(profiles);
          const preferred = pickPreferredDeliveryProfile(profiles);
          if (preferred) applyDeliveryProfileRow(preferred);
        }
        throw new Error(d?.error?.message || t('common.error'));
      }
      const orderData = await orderRes.json();
      applyInventoryUpdates(orderData?.inventoryUpdates || []);
      try {
        const configRes = await apiFetch('/api/admin/config');
        const cfg = configRes.ok ? await configRes.json() : {};
        type ReceiptLine = {
          _id?: string;
          menuItemId?: string;
          lineKind?: string;
          unitPrice: number;
          quantity: number;
          itemName?: string;
          itemNameEn?: string;
          selectedOptions?: { groupName?: string; choiceName?: string; extraPrice?: number }[];
        };
        const deliveryFeeCharged = Number(orderData.deliveryFeeEuro) || 0;
        const mapReceiptLine = (item: ReceiptLine) => ({
          _id: String(item._id ?? item.lineKind ?? 'line'),
          menuItemId: item.menuItemId,
          lineKind: item.lineKind,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          itemName: item.itemName ?? '',
          itemNameEn: item.itemNameEn,
          selectedOptions: item.selectedOptions,
        });
        let receiptItems = (orderData.items as ReceiptLine[]).map((item) => {
          const mapped = mapReceiptLine(item);
          if (item.lineKind === 'delivery_fee' && deliveryFeeCharged > 0) {
            return { ...mapped, unitPrice: deliveryFeeCharged };
          }
          return mapped;
        });
        if (deliveryFeeCharged > 0 && !receiptItems.some((i) => i.lineKind === 'delivery_fee')) {
          receiptItems = [
            ...receiptItems,
            mapReceiptLine({
              _id: 'delivery_fee',
              lineKind: 'delivery_fee',
              quantity: 1,
              unitPrice: deliveryFeeCharged,
              itemName: '送餐费',
              itemNameEn: 'Delivery fee',
              selectedOptions: [],
            }),
          ];
        }
        const foodGross = receiptItems
          .filter((i) => i.lineKind !== 'delivery_fee')
          .reduce((s, i) => {
            const ox = (i.selectedOptions || []).reduce((a, o) => a + (o.extraPrice || 0), 0);
            return s + (i.unitPrice + ox) * i.quantity;
          }, 0);
        const feeGross = receiptItems
          .filter((i) => i.lineKind === 'delivery_fee')
          .reduce((s, i) => s + i.unitPrice * i.quantity, 0);
        const disc =
          (orderData.appliedBundles as Array<{ discount: number }> | undefined)?.reduce((a, b) => a + b.discount, 0) ??
          0;
        const receiptData = {
          checkoutId: orderData._id,
          type: 'seat' as const,
          totalAmount: foodGross + feeGross - disc,
          paymentMethod: ((orderData as { phoneCardPaidAtPlacement?: boolean }).phoneCardPaidAtPlacement ? 'card' : 'cash') as 'cash' | 'card',
          checkedOutAt: new Date().toISOString(),
          orders: [
            {
              _id: orderData._id,
              type: 'delivery' as const,
              dailyOrderNumber: orderData.dailyOrderNumber,
              status: (orderData.status as string) || 'pending',
              items: receiptItems,
              deliveryFeeEuro: deliveryFeeCharged,
              customerName:
                typeof orderData.customerName === 'string' && orderData.customerName.trim()
                  ? orderData.customerName.trim()
                  : deliveryCustomerName.trim(),
              customerPhone:
                typeof orderData.customerPhone === 'string' && orderData.customerPhone.trim()
                  ? orderData.customerPhone.trim()
                  : deliveryCustomerPhone.trim(),
              deliveryAddress:
                typeof orderData.deliveryAddress === 'string' && orderData.deliveryAddress.trim()
                  ? orderData.deliveryAddress.trim()
                  : deliveryAddress.trim(),
              postalCode:
                typeof orderData.postalCode === 'string' && orderData.postalCode.trim()
                  ? orderData.postalCode.trim()
                  : deliveryPostalCode.trim(),
            },
          ],
        };
        void printBuiltReceipt(receiptData, cfg, {
          bundleDiscounts: matchedBundles.length > 0
            ? matchedBundles.map((b) => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }))
            : undefined,
          copies: 1,
        });
      } catch {
        /* print error ignored */
      }
      setPhoneOrderId(orderData._id);
      setOrder([]);
      setDeliveryCustomerName('');
      setDeliveryCustomerPhone('');
      setDeliveryAddress('');
      setDeliveryPostalCode('');
      setDeliveryCustomerProfileId('');
      setDeliveryProfiles([]);
      setDeliveryCustomerCollapsed(false);
      setFrequentItems([]);
      setPhoneCardPaidAtPlacement(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setPaying(false);
    }
  };

  // Build grouped items for API
  const buildGroupedItems = () => {
    type Payload = {
      menuItemId: string;
      quantity: number;
      selectedOptions?: { groupId: string; choiceId: string }[];
      adHocOptions?: ReturnType<typeof adHocPayloadFromOption>[];
    };
    const grouped = new Map<string, Payload>();
    for (const line of order) {
      const mi = menuItems.find((m) => m._id === line.menuItemId);
      const menuOpts = (line.options || []).filter((o) => !o.isAdHoc);
      const adHocOpts = (line.options || []).filter((o) => o.isAdHoc);
      let selOpts: { groupId: string; choiceId: string }[] | undefined;
      if (menuOpts.length > 0 && mi?.optionGroups) {
        selOpts = menuOpts
          .map((opt) => {
            if (opt.groupId && opt.choiceId) {
              return { groupId: opt.groupId, choiceId: opt.choiceId };
            }
            const choiceNameVals = Object.values(opt.choiceName).filter(Boolean);
            const groupNameVals = Object.values(opt.groupName).filter(Boolean);
            let group: OptionGroup | undefined;
            let choice: OptionGroup['choices'][0] | undefined;
            for (const g of mi.optionGroups!) {
              const hitChoice = g.choices.find((c) =>
                c.translations.some((t2) => choiceNameVals.includes(t2.name)),
              );
              if (!hitChoice) continue;
              if (groupNameVals.length === 0) {
                group = g;
                choice = hitChoice;
                break;
              }
              const groupNameHit = g.translations.some((t2) => groupNameVals.includes(t2.name));
              if (groupNameHit) {
                group = g;
                choice = hitChoice;
                break;
              }
            }
            if (!group || !choice) {
              for (const g of mi.optionGroups!) {
                const hitChoice = g.choices.find((c) =>
                  c.translations.some((t2) => choiceNameVals.includes(t2.name)),
                );
                if (hitChoice) {
                  group = g;
                  choice = hitChoice;
                  break;
                }
              }
            }
            return { groupId: group?._id || '', choiceId: choice?._id || '' };
          })
          .filter((o) => o.groupId && o.choiceId);
      }
      const adHocPayload = adHocOpts.map(adHocPayloadFromOption);
      const key =
        line.menuItemId +
        '|' +
        JSON.stringify({ sel: selOpts || [], ad: adHocPayload });
      const existing = grouped.get(key);
      if (existing) {
        existing.quantity++;
      } else {
        grouped.set(key, {
          menuItemId: line.menuItemId,
          quantity: 1,
          selectedOptions: selOpts?.length ? selOpts : undefined,
          adHocOptions: adHocPayload.length ? adHocPayload : undefined,
        });
      }
    }
    return [...grouped.values()];
  };

  /** 后结堂食：仅 POST 订单，不结账（与先结+外卖路径隔离） */
  const handleSubmitDineInPayAfterOnly = async () => {
    if (order.length === 0) return;
    const wf = await refreshDineInWorkflowMode();
    if (wf !== 'pay_after') {
      setError(t('cashier.dineInModeSwitchedToPayFirst'));
      return;
    }
    const rawTable = counterTableInput.trim();
    if (rawTable === '') {
      setError(t('cashier.counterTableRequired'));
      return;
    }
    const tableNum = parseInt(rawTable, 10);
    if (!Number.isFinite(tableNum) || tableNum < 1) {
      setError(t('cashier.counterTableInvalidFormat'));
      return;
    }
    setPaying(true);
    setError('');
    try {
      if (!(await ensureOrderNotSoldOut())) return;
      const orderBody: Record<string, unknown> = {
        type: 'dine_in',
        tableNumber: tableNum,
        seatNumber: 0,
        items: buildGroupedItems(),
      };
      const gl = counterGuestLabel.trim();
      if (gl) orderBody.dineInGuestLabel = gl.slice(0, 40);
      if (matchedBundles.length > 0) {
        orderBody.appliedBundles = matchedBundles.map((b) => ({
          offerId: b.offer._id,
          name: b.offer.name,
          nameEn: b.offer.nameEn,
          discount: b.savings,
        }));
      }
      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) {
        const d = await orderRes.json().catch(() => null);
        throw new Error(d?.error?.message || t('common.error'));
      }
      const orderData = (await orderRes.json()) as {
        _id: string;
        dineInOrderNumber?: string;
        inventoryUpdates?: Array<{ menuItemId: string; currentQty: number; perServing?: number; baseUnit?: string }>;
        items?: Array<{
          _id?: string;
          menuItemId?: string;
          lineKind?: string;
          quantity: number;
          unitPrice: number;
          itemName: string;
          itemNameEn?: string;
          selectedOptions?: Array<{
            groupName?: string;
            choiceName?: string;
            extraPrice?: number;
          }>;
        }>;
      };

      // 客人凭条：后结堂食提交成功后自动打印 1 份
      try {
        const configRes = await apiFetch('/api/admin/config');
        const cfg = configRes.ok ? await configRes.json() : {};
        const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
        const receiptItems = rawItems
          .filter((it) => it.lineKind !== 'delivery_fee')
          .map((it) => ({
            _id: String(it._id ?? ''),
            menuItemId: it.menuItemId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            itemName: it.itemName,
            itemNameEn: it.itemNameEn,
            selectedOptions: (it.selectedOptions || []).map((o) => ({
              groupName: o.groupName ?? '',
              choiceName: o.choiceName ?? '',
              extraPrice: typeof o.extraPrice === 'number' ? o.extraPrice : 0,
            })),
          }));
        const receiptData = {
          checkoutId: orderData._id,
          type: 'seat' as const,
          tableNumber: tableNum,
          totalAmount: finalTotal,
          paymentMethod: 'pending' as const,
          checkedOutAt: new Date().toISOString(),
          orders: [{
            _id: orderData._id,
            type: 'dine_in' as const,
            tableNumber: tableNum,
            seatNumber: 0,
            dineInOrderNumber: orderData.dineInOrderNumber,
            status: 'pending',
            items: receiptItems,
          }],
        };
        void printBuiltReceipt(receiptData, cfg, {
          bundleDiscounts: matchedBundles.length > 0
            ? matchedBundles.map((b) => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }))
            : undefined,
          copies: 1,
        });
      } catch {
        /* guest slip print is best-effort */
      }

      applyInventoryUpdates(orderData?.inventoryUpdates || []);
      setDineInSubmittedInfo({
        id: orderData._id,
        dineInOrderNumber: orderData.dineInOrderNumber,
        tableNumber: tableNum,
      });
      setOrder([]);
      setCounterTableInput('');
      setCounterGuestLabel('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setPaying(false);
    }
  };

  const handleOpenPayment = () => {
    if (order.length === 0) return;
    if (orderType === 'delivery') return;
    setPayingTotal(finalTotal);
    setCashReceived('');
    setPaymentMethod('cash');
    setMemberPhone('');
    setMemberPreview(null);
    setSelectedCoupon(null);
    setError('');
    setShowPayment(true);
  };

  const handlePrimaryAction = async () => {
    if (order.length === 0) return;
    if (orderType === 'phone') {
      await handlePhoneOrder();
      return;
    }
    if (orderType === 'delivery') {
      if (!canDelivery) {
        setError(t('cashier.deliveryNotEnabledPlan'));
        return;
      }
      await handleDeliveryPhoneOrder();
      return;
    }
    if (orderType === 'dine_in') {
      const wf = await refreshDineInWorkflowMode();
      if (wf === 'pay_after') {
        await handleSubmitDineInPayAfterOnly();
        return;
      }
    }
    if (!(await ensureOrderNotSoldOut())) return;
    handleOpenPayment();
  };

  // Confirm: create order + checkout in one go（先结堂食、外卖、电话以外不适用）
  const couponDiscount = selectedCoupon?.amount || 0;
  const amountAfterCoupon = Math.max(0, payingTotal - couponDiscount);
  const cashReceivedNum = parseFloat(cashReceived) || 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, cashReceivedNum - amountAfterCoupon) : 0;

  const handlePay = async () => {
    if (orderType === 'delivery') {
      setShowPayment(false);
      return;
    }
    setPaying(true);
    setError('');
    try {
      if (orderType === 'dine_in') {
        const wf = await refreshDineInWorkflowMode();
        if (wf === 'pay_after') {
          setShowPayment(false);
          setError(t('cashier.modeSwitchedToPayAfterCloseModal'));
          setPaying(false);
          return;
        }
      }
      if (!(await ensureOrderNotSoldOut())) return;
      // Step 1: Create order
      const orderBody: Record<string, unknown> = { type: orderType, items: buildGroupedItems() };
      if (orderType === 'dine_in') { orderBody.tableNumber = 0; orderBody.seatNumber = 0; }
      if (orderType === 'takeout') orderBody.staffTakeoutPlacement = true;
      if (matchedBundles.length > 0) {
        orderBody.appliedBundles = matchedBundles.map(b => ({ offerId: b.offer._id, name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }));
      }

      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) { const d = await orderRes.json().catch(() => null); throw new Error(d?.error?.message || t('common.error')); }
      const orderData = await orderRes.json();
      applyInventoryUpdates(orderData?.inventoryUpdates || []);

      // Step 2: Checkout immediately
      let checkoutBody: Record<string, unknown>;
      if (paymentMethod === 'member' && memberPreview) {
        checkoutBody = buildMemberFullWalletCheckoutBody(amountAfterCoupon, memberPreview.phone);
      } else {
        checkoutBody = { paymentMethod };
        if (paymentMethod === 'cash') checkoutBody.cashAmount = amountAfterCoupon;
        else if (paymentMethod === 'card') checkoutBody.cardAmount = amountAfterCoupon;
        else { checkoutBody.cashAmount = Number(mixedCash); checkoutBody.cardAmount = Number(mixedCard); }
      }
      if (bundleTotals.bundleDiscount > 0) {
        checkoutBody.totalAmountOverride = payingTotal;
      }
      if (selectedCoupon) {
        checkoutBody.couponName = selectedCoupon.name;
        checkoutBody.couponAmount = selectedCoupon.amount;
      }

      const checkoutRes = await apiFetch(`/api/checkout/seat/${orderData._id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(checkoutBody),
      });
      if (!checkoutRes.ok) { const d = await checkoutRes.json().catch(() => null); throw new Error(d?.error?.message || 'Checkout failed'); }
      const checkoutData = await checkoutRes.json();
      setCheckoutId(checkoutData._id);
      setCheckoutMeta(
        paymentMethod === 'member'
          ? { total: amountAfterCoupon, cashReceived: 0, change: 0 }
          : { total: amountAfterCoupon, cashReceived: cashReceivedNum, change: changeAmount },
      );
      setReceiptBundleDiscounts(matchedBundles.map(b => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings })));
      setShowPayment(false);
      setOrder([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setPaying(false);
    }
  };

  const handleCloseReceipt = () => {
    setCheckoutId(null);
    setCheckoutMeta(null);
    setReceiptBundleDiscounts([]);
  };

  if (dineInSubmittedInfo) {
    const no = dineInSubmittedInfo.dineInOrderNumber || dineInSubmittedInfo.id.slice(-6);
    return (
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🍽️</div>
          <h2 style={{ color: 'var(--green)', marginBottom: 12 }}>{t('cashier.dineInOrderCreatedTitle')}</h2>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            {t('cashier.dineInOrderCreatedBody', {
              table: dineInSubmittedInfo.tableNumber,
              orderNo: no,
            })}
          </p>
          <button className="btn btn-primary" onClick={() => setDineInSubmittedInfo(null)} style={{ marginBottom: 20 }}>
            {t('cashier.continueOrder')}
          </button>
        </div>
      </div>
    );
  }

  // Phone order success screen
  if (phoneOrderId) {
    return (
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>📞</div>
          <h2 style={{ color: 'var(--blue, #1976D2)', marginBottom: 12 }}>{t('cashier.phoneOrderCreated')}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('cashier.phoneOrderPayLater')}</p>
          <button className="btn btn-primary" onClick={() => setPhoneOrderId(null)} style={{ marginBottom: 20 }}>{t('cashier.continueOrder')}</button>
        </div>
      </div>
    );
  }

  // Receipt screen
  if (checkoutId) {
    return (
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
          <h2 style={{ color: 'var(--green)', marginBottom: 12 }}>{t('cashier.checkoutSuccess')}</h2>
          {checkoutMeta && paymentMethod === 'cash' && checkoutMeta.change > 0 && (
            <div style={{ background: '#FFF3E0', border: '2px solid #FF9800', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('cashier.total')}: €{checkoutMeta.total.toFixed(2)}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('cashier.cashReceived')}: €{checkoutMeta.cashReceived.toFixed(2)}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#E65100' }}>{t('cashier.change')}: €{checkoutMeta.change.toFixed(2)}</div>
            </div>
          )}
          <button className="btn btn-primary" onClick={handleCloseReceipt} style={{ marginBottom: 20 }}>{t('cashier.continueOrder')}</button>
          <button className="btn btn-outline" onClick={() => window.print()} style={{ marginBottom: 20, marginLeft: 8 }}>
            {t('cashier.printReceiptBtn')}
          </button>
        </div>
        <ReceiptPrint checkoutId={checkoutId} cashReceived={checkoutMeta?.cashReceived} changeAmount={checkoutMeta?.change} bundleDiscounts={receiptBundleDiscounts} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', gap: 0 }}>
      {/* Left: Category Sidebar */}
      <div style={{ width: 110, flexShrink: 0, background: 'var(--bg-white)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '8px 0' }}>
        {menuSections.map((sec) => {
          const cat = sec.category;
          const isActive = activeCat === cat._id;
          return (
            <button
              key={cat._id}
              ref={(el) => {
                categoryBtnRefs.current[cat._id] = el;
              }}
              type="button"
              className={`cashier-cat-btn${isActive ? ' is-active' : ''}`}
              onClick={() => scrollToCategory(cat._id)}
            >
              {getName(cat.translations)}
            </button>
          );
        })}
      </div>

      {/* Center: Menu Grid */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <input className="input cashier-menu-search" placeholder={t('cashier.searchMenuPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {search.trim() ? (
          <div style={{ padding: '10px 12px 6px', fontSize: 14, fontWeight: 700, background: 'var(--bg)', flexShrink: 0 }}>
            {t('cashier.searchResultsFor', { q: search.trim() })}
            <span style={{ fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>({searchFilteredItems.length})</span>
          </div>
        ) : null}
        <div ref={menuScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
          {menuLoading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)', fontSize: 13 }}>
              {t('cashier.menuLoading')}
            </div>
          ) : search.trim() ? (
            searchFilteredItems.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)', fontSize: 13 }}>
                {t('cashier.menuSearchEmpty')}
              </div>
            ) : (
              <div className="cashier-menu-grid">{searchFilteredItems.map((item) => renderMenuItemCard(item))}</div>
            )
          ) : menuSections.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)', fontSize: 13 }}>
              {t('cashier.menuEmpty')}
            </div>
          ) : (
            menuSections.map((sec) => (
              <section
                key={sec.category._id}
                ref={(el) => {
                  categorySectionRefs.current[sec.category._id] = el;
                }}
                data-category-id={sec.category._id}
                style={{ marginBottom: 16 }}
              >
                <div className="cashier-menu-section-title">
                  {getName(sec.category.translations)}
                  <span style={{ fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>({sec.items.length})</span>
                </div>
                <div className="cashier-menu-grid">{sec.items.map((item) => renderMenuItemCard(item))}</div>
              </section>
            ))
          )}
        </div>
      </div>

      {/* Right: Order Panel */}
      <div style={{ width: 320, flexShrink: 0, background: 'var(--bg-white)', borderLeft: '2px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              type="button"
              className="btn"
              onClick={() => switchOrderType('dine_in')}
              style={{
                flex: '1 1 30%',
                minWidth: 72,
                fontSize: 12,
                padding: '6px 0',
                background: orderType === 'dine_in' ? 'var(--red-primary)' : 'var(--bg)',
                color: orderType === 'dine_in' ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {t('cashier.orderTypeDineIn')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => switchOrderType('takeout')}
              style={{
                flex: '1 1 30%',
                minWidth: 72,
                fontSize: 12,
                padding: '6px 0',
                background: orderType === 'takeout' ? 'var(--red-primary)' : 'var(--bg)',
                color: orderType === 'takeout' ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {t('cashier.orderTypeTakeout')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => switchOrderType('phone')}
              style={{
                flex: '1 1 30%',
                minWidth: 72,
                fontSize: 12,
                padding: '6px 0',
                background: orderType === 'phone' ? 'var(--red-primary)' : 'var(--bg)',
                color: orderType === 'phone' ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {t('cashier.orderTypePhone')}
            </button>
            {canDelivery ? (
              <button
                type="button"
                className="btn"
                onClick={() => switchOrderType('delivery')}
                style={{
                  flex: '1 1 30%',
                  minWidth: 72,
                  fontSize: 12,
                  padding: '6px 0',
                  background: orderType === 'delivery' ? 'var(--red-primary)' : 'var(--bg)',
                  color: orderType === 'delivery' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('cashier.orderTypeDelivery')}
              </button>
            ) : null}
          </div>
        </div>

        {orderType === 'delivery' && deliveryCustomerCollapsed ? (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('cashier.deliverySummaryTitle')}</span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setDeliveryCustomerCollapsed(false)}
              >
                {t('cashier.deliveryExpandCustomer')}
              </button>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                lineHeight: 1.35,
                minWidth: 0,
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--text-light)', fontSize: 11 }}>{t('cashier.deliverySummaryName')}</span>{' '}
                <span style={{ fontWeight: 600 }}>{deliveryCustomerName.trim() || t('cashier.profileAddressDash')}</span>
              </span>
              <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--text-light)', fontSize: 11 }}>{t('cashier.deliverySummaryPhone')}</span>{' '}
                <span style={{ fontWeight: 600 }}>{deliveryCustomerPhone.trim() || t('cashier.profileAddressDash')}</span>
              </span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{renderDeliveryFeeField(true)}</span>
            </div>
          </div>
        ) : null}
        {orderType === 'delivery' && !deliveryCustomerCollapsed ? (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 6, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('cashier.deliverySummaryTitle')}</span>
              {(deliveryCustomerName.trim() || deliveryCustomerPhone.trim() || deliveryAddress.trim()) ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                  onClick={() => setDeliveryCustomerCollapsed(true)}
                >
                  {t('cashier.deliveryCollapseCustomer')}
                </button>
              ) : null}
            </div>
            <input
              className="input"
              placeholder={t('cashier.deliveryPhonePlaceholder')}
              value={deliveryCustomerPhone}
              onChange={(e) => {
                deliveryPhoneRef.current = e.target.value;
                setDeliveryCustomerPhone(e.target.value);
                setDeliveryCustomerProfileId('');
                setDeliveryCustomerCollapsed(false);
              }}
              onBlur={(e) => void runMemberDeliveryLookup(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const el = e.target as HTMLInputElement;
                  void runMemberDeliveryLookup(el.value);
                  el.blur();
                }
              }}
            />
            <input
              className="input"
              placeholder={t('cashier.deliveryCustomerNamePlaceholder')}
              value={deliveryCustomerName}
              onChange={(e) => setDeliveryCustomerName(e.target.value)}
            />
            {deliveryProfiles.length > 1 ? (
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>
                  {t('cashier.deliveryProfileLabelMulti')}
                </label>
                <select
                  className="input"
                  style={{ width: '100%', fontSize: 13 }}
                  value={deliveryCustomerProfileId}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDeliveryCustomerProfileId(v);
                    if (v && v !== DELIVERY_PROFILE_NEW_MANUAL && isMongoObjectId(v)) {
                      const p = deliveryProfiles.find((x) => x._id === v);
                      if (p) {
                        if (p.customerName) setDeliveryCustomerName(p.customerName);
                        if (p.deliveryAddress) setDeliveryAddress(p.deliveryAddress);
                        if (p.postalCode) setDeliveryPostalCode(p.postalCode);
                      }
                      setDeliveryCustomerCollapsed(true);
                    } else {
                      setDeliveryCustomerCollapsed(false);
                    }
                  }}
                >
                  <option value="">{t('cashier.deliveryProfilePickPlaceholder')}</option>
                  <option value={DELIVERY_PROFILE_NEW_MANUAL}>{t('cashier.deliveryProfileNewManualOption')}</option>
                  {deliveryProfiles.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.deliveryAddress || t('cashier.profileAddressDash')} ·{' '}
                      {p.postalCode || t('cashier.profileAddressDash')}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <input
              className="input"
              placeholder={t('cashier.deliveryEircodePlaceholder')}
              value={deliveryPostalCode}
              onChange={(e) => setDeliveryPostalCode(e.target.value)}
              autoCapitalize="characters"
            />
            <input
              className="input"
              placeholder={t('cashier.deliveryAddressPlaceholder')}
              value={deliveryAddress}
              onChange={(e) => setDeliveryAddress(e.target.value)}
            />
            {renderDeliveryGeoSection()}
            {renderDeliveryFrequentSection()}
          </div>
        ) : null}

        {orderType === 'dine_in' && dineInWorkflowMode === 'pay_after' && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <label style={{ flex: '0 0 96px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('cashier.table')} *</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder={t('cashier.counterTablePlaceholder')}
                  value={counterTableInput}
                  onChange={(e) => setCounterTableInput(e.target.value)}
                  style={{ width: '100%', fontSize: 14, padding: '8px 10px' }}
                />
              </label>
              <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('cashier.dineInGuestLabelShort')}</span>
                <input
                  className="input"
                  type="text"
                  maxLength={40}
                  placeholder={t('cashier.dineInGuestInputPh')}
                  value={counterGuestLabel}
                  onChange={(e) => setCounterGuestLabel(e.target.value)}
                  style={{ width: '100%', fontSize: 14, padding: '8px 10px' }}
                />
              </label>
            </div>
            {(() => {
              const rawT = counterTableInput.trim();
              const tn = parseInt(rawT, 10);
              const tableOk = rawT !== '' && Number.isFinite(tn) && tn >= 1;
              if (!tableOk) return null;
              if (activeTableOrdersLoading) {
                return (
                  <div style={{ fontSize: 11, color: 'var(--text-light)', padding: '2px 0' }}>…</div>
                );
              }
              return (
                <div
                  style={{
                    padding: '8px 8px',
                    borderRadius: 8,
                    border: '1px solid #eee',
                    background: '#fafafa',
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}
                >
                  <div style={{ fontWeight: 700, color: '#424242', marginBottom: 8 }}>{t('cashier.activeTableOrdersTitle')}</div>
                  {activeTableOrders.length === 0 ? (
                    <div style={{ color: '#9e9e9e', fontStyle: 'italic' }}>{t('cashier.activeTableOrdersEmpty')}</div>
                  ) : (
                    activeTableOrders.map((ord, idx) => {
                      const busy = importingActiveOrderId === ord._id;
                      const summary = (ord.items || [])
                        .filter((it) => it.lineKind !== 'delivery_fee' && it.menuItemId && !it.refunded)
                        .map((it) => {
                          const label = String(lang).toLowerCase().startsWith('zh')
                            ? it.itemName
                            : (it.itemNameEn || it.itemName);
                          return `${label}×${it.quantity}`;
                        })
                        .join(' · ');
                      return (
                        <div
                          key={ord._id}
                          role="button"
                          tabIndex={0}
                          aria-busy={busy}
                          aria-label={t('cashier.activeTableOrdersRowAria', {
                            orderNo: ord.dineInOrderNumber?.trim() || ord._id.slice(-6),
                          })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              if (!busy) void appendActiveOrderToCart(ord);
                            }
                          }}
                          onClick={() => {
                            if (!busy) void appendActiveOrderToCart(ord);
                          }}
                          style={{
                            marginBottom: idx < activeTableOrders.length - 1 ? 6 : 0,
                            paddingBottom: idx < activeTableOrders.length - 1 ? 6 : 0,
                            borderBottom: idx < activeTableOrders.length - 1 ? '1px dashed #e8e8e8' : 'none',
                            cursor: busy ? 'wait' : 'pointer',
                            opacity: busy ? 0.65 : 1,
                            borderRadius: 6,
                            padding: '6px 6px',
                            marginLeft: -6,
                            marginRight: -6,
                            outline: 'none',
                          }}
                          onMouseEnter={(e) => {
                            if (!busy) (e.currentTarget as HTMLDivElement).style.background = '#f0f0f0';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                          }}
                        >
                          <div style={{ fontWeight: 600, color: '#333' }}>
                            {ord.dineInOrderNumber?.trim() || ord._id.slice(-6)}
                            {ord.dineInGuestLabel?.trim() ? (
                              <span style={{ fontWeight: 500, color: '#6d4c41', marginLeft: 6 }}>· {ord.dineInGuestLabel.trim()}</span>
                            ) : null}
                            {busy ? <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--text-light)' }}>…</span> : null}
                          </div>
                          <div style={{ color: '#616161', marginTop: 3 }}>{summary || '—'}</div>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {orderType === 'phone' && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('cashier.phoneGuestPhoneOptionalLabel')}</label>
            <input
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t('cashier.phoneGuestPhoneExamplePlaceholder')}
              value={phoneGuestPhone}
              onChange={(e) => setPhoneGuestPhone(e.target.value)}
              style={{ width: '100%', fontSize: 15, padding: '10px 12px' }}
            />
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('cashier.phoneGuestNameOptionalLabel')}</label>
            <input
              className="input"
              type="text"
              placeholder={t('cashier.deliveryCustomerNamePlaceholder')}
              value={phoneGuestName}
              onChange={(e) => setPhoneGuestName(e.target.value)}
              style={{ width: '100%', fontSize: 14, padding: '8px 12px' }}
            />
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {order.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-light)', gap: 8 }}>
              <span style={{ fontSize: 36, opacity: 0.3 }}>📋</span>
              <span style={{ fontSize: 13 }}>{t('cashier.emptyOrderHint')}</span>
            </div>
          ) : groupedOrderLines.map((group, idx) => {
            const line = group.representative;
            const optExtra = (line.options || []).reduce((sum, opt) => sum + opt.extraPrice, 0);
            const unitPrice = line.price + optExtra;
            const isEditing = editingLineId === line.id;
            return (
              <div key={group.key} style={{ padding: '6px 10px', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-light)', width: 14, flexShrink: 0, paddingTop: 2 }}>{idx + 1}.</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                      <button
                        type="button"
                        style={{ ...qtyBtnStyle, flexShrink: 0, marginTop: 1 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openAdHocModal(group);
                        }}
                        aria-label={t('cashier.adHocAddBtn')}
                        title={t('cashier.adHocAddBtn')}
                      >
                        +
                      </button>
                      <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{line.name}</div>
                    </div>
                    {line.options && line.options.length > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--text-light)', lineHeight: 1.35, wordBreak: 'break-word', marginTop: 2, paddingLeft: 24 }}>
                        {line.options.map((opt, i) => (
                          <span key={i}>
                            {i > 0 && ' · '}
                            {formatCashierOptionLabel(opt, lang)}
                            {opt.extraPrice > 0 && ` +€${opt.extraPrice.toFixed(2)}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingTop: 1 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }} onClick={(e) => e.stopPropagation()}>
                      <button type="button" style={qtyBtnStyle} onClick={() => setGroupQuantity(group, group.quantity - 1)} aria-label={t('cashier.lineQtyDecrease')}>−</button>
                      <input
                        type="number"
                        min={0}
                        max={QUICK_ADD_QTY_MAX}
                        value={group.quantity}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!Number.isFinite(v)) return;
                          setGroupQuantity(group, v);
                        }}
                        className="cashier-qty-input"
                      />
                      <button type="button" style={qtyBtnStyle} onClick={() => setGroupQuantity(group, group.quantity + 1)} aria-label={t('cashier.lineQtyIncrease')}>+</button>
                    </div>
                    {isEditing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 11, color: 'var(--text-light)' }}>€</span>
                        <input
                          className="input"
                          type="number"
                          step="0.01"
                          value={editPrice}
                          onChange={e => setEditPrice(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') confirmEditPrice(line.id); if (e.key === 'Escape') setEditingLineId(null); }}
                          onBlur={() => confirmEditPrice(line.id)}
                          autoFocus
                          style={{ width: 52, minHeight: 0, height: 24, fontSize: 12, fontWeight: 700, padding: '2px 4px', textAlign: 'right' }}
                        />
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 48 }}>
                        <span
                          onClick={(e) => startEditPrice(line.id, unitPrice, e)}
                          style={{ fontSize: 13, fontWeight: 700, color: 'var(--red-primary)', cursor: 'text', borderBottom: '1px dashed var(--red-primary)', whiteSpace: 'nowrap' }}
                        >
                          {group.quantity > 1 ? `€${(unitPrice * group.quantity).toFixed(2)}` : `€${unitPrice.toFixed(2)}`}
                        </span>
                        {group.quantity > 1 ? (
                          <span style={{ fontSize: 10, color: 'var(--text-light)', whiteSpace: 'nowrap' }}>×{group.quantity} €{unitPrice.toFixed(2)}</span>
                        ) : null}
                      </div>
                    )}
                    <button
                      type="button"
                      style={{ fontSize: 12, color: 'var(--text-light)', padding: 0, border: 'none', background: 'none', cursor: 'pointer', lineHeight: 1 }}
                      onClick={() => removeGroup(group.lineIds)}
                      aria-label={t('cashier.lineRemove')}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: '2px solid var(--border)', padding: '12px 16px', flexShrink: 0 }}>
          {error && <div style={{ color: 'var(--red-primary)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {/* Bundle discount display */}
          {matchedBundles.length > 0 && (
            <div style={{ marginBottom: 8, padding: '8px 10px', background: '#E8F5E9', borderRadius: 8 }}>
              {matchedBundles.map((b, i) => (
                <div key={i} style={{ fontSize: 12, color: '#2E7D32', display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>🎁 {b.offer.name}</span>
                  <span style={{ fontWeight: 600 }}>-€{b.savings.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('cashier.totalItemsLine', { count: order.length })}</span>
            <div style={{ textAlign: 'right' }}>
              {bundleTotals.bundleDiscount > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-light)', textDecoration: 'line-through' }}>€{totalAmount.toFixed(2)}</div>
              )}
              <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{displayTotal.toFixed(2)}</span>
            </div>
          </div>
          {(orderType === 'phone' || orderType === 'delivery') && (
            <div style={{ marginBottom: 10 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontSize: 12,
                  color: '#333',
                  cursor: 'pointer',
                  lineHeight: 1.45,
                }}
              >
                <input
                  type="checkbox"
                  checked={phoneCardPaidAtPlacement}
                  onChange={(e) => setPhoneCardPaidAtPlacement(e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <span>{t('cashier.placementPrepaidLabel')}</span>
              </label>
            </div>
          )}
          <button
            className="btn btn-primary"
            onClick={() => void handlePrimaryAction()}
            disabled={order.length === 0 || paying}
            style={{ width: '100%', fontSize: 15, padding: '12px 0', letterSpacing: 1 }}
          >
            {orderType === 'phone'
              ? t('cashier.createPhoneOrder')
              : orderType === 'delivery'
                ? t('cashier.placeOrderCheckout')
                : orderType === 'dine_in' && dineInWorkflowMode === 'pay_after'
                  ? t('cashier.submitDineInPayAfter')
                  : t('cashier.placeOrderCheckout')}
          </button>
        </div>
      </div>

      {/* Payment Modal */}
      {showPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 380, maxWidth: '90%' }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, textAlign: 'center' }}>{t('cashier.checkout')}</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 20, marginBottom: 12 }}>
              <span>{t('cashier.total')}</span>
              <span style={{ color: 'var(--red-primary)' }}>€{payingTotal.toFixed(2)}</span>
            </div>

            {/* Coupon selection */}
            {availableCoupons.length > 0 && (
              <div style={{ marginBottom: 12, padding: 10, background: 'var(--bg)', borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 6 }}>🎟️ Coupon</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {availableCoupons.map(c => {
                    const isSelected = selectedCoupon?.name === c.name && selectedCoupon?.amount === c.amount;
                    return (
                      <button key={c._id} onClick={() => {
                        if (isSelected) { setSelectedCoupon(null); setCashReceived(''); }
                        else { setSelectedCoupon(c); setCashReceived(''); }
                      }}
                        className="btn" style={{
                          padding: '6px 12px', fontSize: 12, borderRadius: 20,
                          background: isSelected ? '#4CAF50' : 'var(--bg-white)',
                          color: isSelected ? '#fff' : 'var(--text-secondary)',
                          border: isSelected ? '2px solid #388E3C' : '1px solid var(--border)',
                        }}>
                        {c.name} -€{c.amount.toFixed(2)}
                      </button>
                    );
                  })}
                </div>
                {selectedCoupon && (
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16 }}>
                    <span style={{ color: '#2E7D32' }}>After Coupon</span>
                    <span style={{ color: '#2E7D32' }}>€{amountAfterCoupon.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {(canMemberWallet ? (['cash', 'card', 'mixed', 'member'] as const) : (['cash', 'card', 'mixed'] as const)).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setPaymentMethod(m);
                    setCashReceived('');
                    if (m !== 'member') setMemberPreview(null);
                  }}
                  className="btn"
                  style={{
                    flex: '1 1 30%',
                    minWidth: 72,
                    background: paymentMethod === m ? 'var(--red-primary)' : 'var(--bg)',
                    color: paymentMethod === m ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {t(`cashier.${m}`)}
                </button>
              ))}
            </div>

            {paymentMethod === 'member' ? (
              <CashierMemberCheckoutBlock
                payAmount={amountAfterCoupon}
                phone={memberPhone}
                setPhone={setMemberPhone}
                preview={memberPreview}
                setPreview={setMemberPreview}
                compact
              />
            ) : null}

            {paymentMethod === 'cash' && (
              <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 8, marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>{t('cashier.cashReceived')}</label>
                <input className="input" type="number" step="0.01" value={cashReceived} onChange={e => setCashReceived(e.target.value)}
                  style={{ width: '100%', fontSize: 18, fontWeight: 700, padding: '8px 10px', textAlign: 'right' }} />
                {cashReceivedNum > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 6, background: cashReceivedNum >= amountAfterCoupon ? '#E8F5E9' : '#FFEBEE' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{t('cashier.change')}</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: cashReceivedNum >= amountAfterCoupon ? 'var(--green)' : 'var(--red-primary)' }}>€{changeAmount.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {paymentMethod === 'mixed' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input className="input" placeholder={t('cashier.cashAmount')} value={mixedCash} onChange={e => setMixedCash(e.target.value)} type="number" />
                <input className="input" placeholder={t('cashier.cardAmount')} value={mixedCard} onChange={e => setMixedCard(e.target.value)} type="number" />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowPayment(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handlePay}
                disabled={
                  paying ||
                  (paymentMethod === 'cash' && cashReceivedNum < amountAfterCoupon) ||
                  (paymentMethod === 'member' && !canMemberFullWalletPay(memberPreview, amountAfterCoupon))
                }>
                {paying ? t('common.loading') : t('cashier.submitCheckout')}
              </button>
            </div>
          </div>
        </div>
      )}

      {adHocModalGroup ? (
        <CashierAdHocOptionModal
          dishName={adHocModalGroup.representative.name}
          existingCount={(adHocModalGroup.representative.options || []).filter((o) => o.isAdHoc).length}
          maxPerLine={AD_HOC_MAX_PER_LINE}
          onConfirm={applyAdHocOption}
          onClose={() => setAdHocModalGroup(null)}
        />
      ) : null}

      {/* Option selection modal */}
      {optionModal && optionModal.optionGroups && optionModal.optionGroups.length > 0 && (
        <OptionSelectModal
          itemName={getName(optionModal.translations)}
          price={optionModal.price}
          optionGroups={optionModal.optionGroups}
          menuItemId={optionModal._id}
          bomSnapshot={bomSnapshot}
          reservedDemand={orderBomDemand}
          layout="cashier"
          onConfirm={(opts) => addToOrderWithOptions(optionModal, opts)}
          onClose={() => setOptionModal(null)}
        />
      )}
    </div>
  );
}
