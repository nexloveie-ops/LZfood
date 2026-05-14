import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';
import OptionSelectModal, { type OptionGroup } from '../../components/customer/OptionSelectModal';
import type { CartItemOption } from '../../context/CartContext';
import ReceiptPrint from '../../components/cashier/ReceiptPrint';
import { buildReceiptHTML, printViaIframe } from '../../components/cashier/ReceiptPrint';
import { matchBundles, calcBundleTotal, type OfferData, type MatchedBundle } from '../../utils/bundleMatcher';

interface Translation { locale: string; name: string; description?: string; }
interface Category { _id: string; sortOrder: number; translations: Translation[]; }
interface MenuItem {
  _id: string; categoryId: string; price: number;
  translations: Translation[];
  optionGroups?: OptionGroup[];
  isSoldOut?: boolean;
}
interface OrderItemOption {
  groupId?: string;
  choiceId?: string;
  groupName: Record<string, string>;
  choiceName: Record<string, string>;
  extraPrice: number;
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

export default function CashierOrder() {
  const { t, i18n } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const lang = i18n.language;

  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [activeCat, setActiveCat] = useState('');
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<OrderLine[]>([]);
  const [orderType, setOrderType] = useState<'dine_in' | 'takeout' | 'phone'>('dine_in');
  /** 电话单：后端要求 `customerPhone`（见 POST /api/orders type=phone） */
  const [phoneGuestPhone, setPhoneGuestPhone] = useState('');
  const [phoneGuestName, setPhoneGuestName] = useState('');
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

  /** 按分类拉菜：避免整本菜单一次 merge；切语言时清空 */
  const loadedCategoryIds = useRef(new Set<string>());
  const loadingCategoryIds = useRef(new Set<string>());

  const mergeMenuItems = useCallback((incoming: MenuItem[]) => {
    setMenuItems((prev) => {
      const map = new Map(prev.map((i) => [i._id, i]));
      for (const row of incoming) map.set(row._id, row);
      return Array.from(map.values());
    });
  }, []);

  const fetchItemsForCategory = useCallback(
    async (categoryId: string) => {
      if (!categoryId) return;
      if (loadedCategoryIds.current.has(categoryId) || loadingCategoryIds.current.has(categoryId)) return;
      loadingCategoryIds.current.add(categoryId);
      try {
        const res = await apiFetch(
          `/api/menu/items?lang=${encodeURIComponent(lang)}&category=${encodeURIComponent(categoryId)}`,
        );
        if (!res.ok) return;
        const rows: MenuItem[] = await res.json();
        loadedCategoryIds.current.add(categoryId);
        mergeMenuItems(rows);
      } finally {
        loadingCategoryIds.current.delete(categoryId);
      }
    },
    [lang, mergeMenuItems],
  );

  useEffect(() => {
    if (!canMemberWallet) {
      setPaymentMethod((pm) => (pm === 'member' ? 'cash' : pm));
      setMemberPreview(null);
    }
  }, [canMemberWallet]);

  /** 只拉分类；当前分类菜品由 fetchItemsForCategory + activeCat effect 拉取（后端按 category 缩小 merge 范围） */
  const fetchMenu = useCallback(async () => {
    loadedCategoryIds.current.clear();
    loadingCategoryIds.current.clear();
    setMenuItems([]);
    const catRes = await apiFetch(`/api/menu/categories?lang=${encodeURIComponent(lang)}`);
    if (!catRes.ok) return;
    const cats: Category[] = await catRes.json();
    setCategories(cats);
    if (cats.length > 0) {
      setActiveCat((prev) => (prev && cats.some((c) => c._id === prev) ? prev : cats[0]._id));
    } else {
      setActiveCat('');
    }
  }, [lang]);

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
  }, [fetchMenu]);

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
    if (!activeCat) return;
    void fetchItemsForCategory(activeCat);
  }, [activeCat, fetchItemsForCategory]);

  /** 搜索跨分类：防抖后拉全店菜品一次并 merge（有 lang） */
  useEffect(() => {
    const q = search.trim();
    if (!q) return;
    const tid = window.setTimeout(() => {
      void (async () => {
        const res = await apiFetch(`/api/menu/items?lang=${encodeURIComponent(lang)}`);
        if (!res.ok) return;
        mergeMenuItems(await res.json());
      })();
    }, 450);
    return () => window.clearTimeout(tid);
  }, [search, lang, mergeMenuItems]);

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

  const filteredItems = useMemo(() => {
    let list = menuItems.filter(i => i.categoryId === activeCat);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = menuItems.filter(i => i.translations.some(t2 => t2.name.toLowerCase().includes(q)));
    }
    return list;
  }, [menuItems, activeCat, search]);

  const activeTableKeyNorm = useMemo(() => {
    const raw = counterTableInput.trim();
    const n = parseInt(raw, 10);
    return raw !== '' && Number.isFinite(n) && n >= 1 ? String(n) : null;
  }, [counterTableInput]);

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
          const res = await apiFetch(`/api/menu/items?lang=${encodeURIComponent(lang)}`);
          if (res.ok) mergeMenuItems(await res.json());
        }
        setOrder((prev) => [...prev, ...lines]);
      } finally {
        setImportingActiveOrderId(null);
      }
    },
    [lang, menuItems, mergeMenuItems],
  );

  const addToOrder = (item: MenuItem) => {
    if (item.isSoldOut) return;
    if (item.optionGroups && item.optionGroups.length > 0) { setOptionModal(item); return; }
    setOrder((prev) => [...prev, { id: nextLineId(), menuItemId: item._id, name: getName(item.translations), price: item.price }]);
  };

  const addToOrderWithOptions = (item: MenuItem, cartOptions: CartItemOption[]) => {
    const options: OrderItemOption[] = cartOptions.map(o => ({
      groupId: o.groupId,
      choiceId: o.choiceId,
      groupName: o.groupName,
      choiceName: o.choiceName,
      extraPrice: o.extraPrice,
    }));
    setOrder((prev) => [
      ...prev,
      { id: nextLineId(), menuItemId: item._id, name: getName(item.translations), price: item.price, options },
    ]);
    setOptionModal(null);
  };

  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');

  const startEditPrice = (lineId: string, currentPrice: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingLineId(lineId);
    setEditPrice(currentPrice.toFixed(2));
  };

  const confirmEditPrice = (lineId: string) => {
    const newPrice = parseFloat(editPrice);
    if (!isNaN(newPrice) && newPrice >= 0) {
      setOrder(prev => prev.map(o => o.id === lineId ? { ...o, price: newPrice } : o));
    }
    setEditingLineId(null);
  };

  const removeLine = (lineId: string) => { if (editingLineId) return; setOrder(prev => prev.filter(o => o.id !== lineId)); };
  const clearOrder = () => {
    setOrder([]);
  };

  const totalAmount = order.reduce((s, o) => s + o.price + (o.options || []).reduce((sum, opt) => sum + opt.extraPrice, 0), 0);
  const getItemCount = (menuItemId: string) => order.filter(o => o.menuItemId === menuItemId).length;

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

  const switchOrderType = (next: 'dine_in' | 'takeout' | 'phone') => {
    setOrderType(next);
    setError('');
    if (next !== 'phone') {
      setPhoneGuestPhone('');
      setPhoneGuestName('');
    }
    if (next !== 'dine_in') {
      setCounterTableInput('');
      setCounterGuestLabel('');
    }
  };

  // Phone order: create order only, print kitchen receipt, no payment
  const handlePhoneOrder = async () => {
    setPaying(true);
    setError('');
    try {
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
      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) { const d = await orderRes.json().catch(() => null); throw new Error(d?.error?.message || 'Failed'); }
      const orderData = await orderRes.json();

      // Print receipt for phone order
      try {
        const configRes = await apiFetch('/api/admin/config');
        const cfg = configRes.ok ? await configRes.json() : {};
        const receiptData = {
          checkoutId: orderData._id,
          type: 'seat' as const,
          totalAmount: finalTotal,
          paymentMethod: 'cash' as const,
          checkedOutAt: new Date().toISOString(),
          orders: [{
            _id: orderData._id,
            type: 'phone' as const,
            dailyOrderNumber: orderData.dailyOrderNumber,
            status: 'pending',
            items: orderData.items,
          }],
        };
        const html = buildReceiptHTML(receiptData, cfg, undefined, undefined,
          matchedBundles.length > 0 ? matchedBundles.map(b => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings })) : undefined
        );
        printViaIframe(html, 1);
      } catch { /* print error ignored */ }

      setPhoneOrderId(orderData._id);
      setOrder([]);
      setPhoneGuestPhone('');
      setPhoneGuestName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPaying(false);
    }
  };

  // Build grouped items for API
  const buildGroupedItems = () => {
    const grouped = new Map<string, { menuItemId: string; quantity: number; selectedOptions?: { groupId: string; choiceId: string }[] }>();
    for (const line of order) {
      const mi = menuItems.find(m => m._id === line.menuItemId);
      let selOpts: { groupId: string; choiceId: string }[] | undefined;
      if (line.options && line.options.length > 0 && mi?.optionGroups) {
        selOpts = line.options.map((opt) => {
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
        }).filter((o) => o.groupId && o.choiceId);
      }
      const key = line.menuItemId + '|' + JSON.stringify(selOpts || []);
      const existing = grouped.get(key);
      if (existing) existing.quantity++;
      else grouped.set(key, { menuItemId: line.menuItemId, quantity: 1, selectedOptions: selOpts });
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
        throw new Error(d?.error?.message || 'Failed');
      }
      const orderData = (await orderRes.json()) as {
        _id: string;
        dineInOrderNumber?: string;
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
        const html = buildReceiptHTML(
          receiptData,
          cfg,
          undefined,
          undefined,
          matchedBundles.length > 0 ? matchedBundles.map((b) => ({ name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings })) : undefined,
        );
        void printViaIframe(html, 1);
      } catch {
        /* guest slip print is best-effort */
      }

      setDineInSubmittedInfo({
        id: orderData._id,
        dineInOrderNumber: orderData.dineInOrderNumber,
        tableNumber: tableNum,
      });
      setOrder([]);
      setCounterTableInput('');
      setCounterGuestLabel('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPaying(false);
    }
  };

  const handleOpenPayment = () => {
    if (order.length === 0) return;
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
    if (orderType === 'dine_in') {
      const wf = await refreshDineInWorkflowMode();
      if (wf === 'pay_after') {
        await handleSubmitDineInPayAfterOnly();
        return;
      }
    }
    handleOpenPayment();
  };

  // Confirm: create order + checkout in one go（先结堂食、外卖、电话以外不适用）
  const couponDiscount = selectedCoupon?.amount || 0;
  const amountAfterCoupon = Math.max(0, payingTotal - couponDiscount);
  const cashReceivedNum = parseFloat(cashReceived) || 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, cashReceivedNum - amountAfterCoupon) : 0;

  const handlePay = async () => {
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
      // Step 1: Create order
      const orderBody: Record<string, unknown> = { type: orderType, items: buildGroupedItems() };
      if (orderType === 'dine_in') { orderBody.tableNumber = 0; orderBody.seatNumber = 0; }
      if (matchedBundles.length > 0) {
        orderBody.appliedBundles = matchedBundles.map(b => ({ offerId: b.offer._id, name: b.offer.name, nameEn: b.offer.nameEn, discount: b.savings }));
      }

      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(orderBody),
      });
      if (!orderRes.ok) { const d = await orderRes.json().catch(() => null); throw new Error(d?.error?.message || 'Failed'); }
      const orderData = await orderRes.json();

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
      setError(e instanceof Error ? e.message : 'Failed');
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
          <h2 style={{ color: 'var(--blue, #1976D2)', marginBottom: 12 }}>电话订单已创建</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>客人来取时在"电话"页面完成支付</p>
          <button className="btn btn-primary" onClick={() => setPhoneOrderId(null)} style={{ marginBottom: 20 }}>继续点单</button>
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
          <button className="btn btn-primary" onClick={handleCloseReceipt} style={{ marginBottom: 20 }}>继续点单</button>
          <button className="btn btn-outline" onClick={() => window.print()} style={{ marginBottom: 20, marginLeft: 8 }}>
            🖨️ 打印小票
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
        {categories.map(cat => {
          const isActive = activeCat === cat._id;
          return (
            <button key={cat._id} onClick={() => { setActiveCat(cat._id); setSearch(''); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '14px 8px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: isActive ? 700 : 500, color: isActive ? 'var(--red-primary)' : 'var(--text-secondary)', background: isActive ? 'var(--red-light)' : 'transparent', borderLeft: isActive ? '4px solid var(--red-primary)' : '4px solid transparent', minHeight: 56 }}>
              {getName(cat.translations)}
            </button>
          );
        })}
      </div>

      {/* Center: Menu Grid */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <input className="input" placeholder={`🔍  ${t('common.search')}...`} value={search} onChange={e => setSearch(e.target.value)} style={{ width: '100%', padding: '10px 14px', fontSize: 14 }} />
        </div>
        <div style={{ padding: '10px 12px 6px', fontSize: 14, fontWeight: 700, background: 'var(--bg)', flexShrink: 0 }}>
          {search ? `搜索: "${search}"` : getName(categories.find(c => c._id === activeCat)?.translations || [])}
          <span style={{ fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>({filteredItems.length})</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8, alignContent: 'start' }}>
          {filteredItems.map(item => {
            const qty = getItemCount(item._id);
            return (
              <div key={item._id} onClick={() => addToOrder(item)} style={{ background: 'var(--bg-white)', border: qty > 0 ? '2px solid var(--red-primary)' : '1px solid var(--border)', borderRadius: 8, padding: '10px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', cursor: item.isSoldOut ? 'not-allowed' : 'pointer', opacity: item.isSoldOut ? 0.4 : 1, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', minHeight: 80, justifyContent: 'center', position: 'relative', userSelect: 'none' }}>
                {qty > 0 && <span style={{ position: 'absolute', top: -6, left: -6, width: 22, height: 22, borderRadius: '50%', background: 'var(--red-primary)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{qty}</span>}
                {item.isSoldOut && <span style={{ position: 'absolute', top: 4, right: 4, fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 600, background: '#9E9E9E', color: '#fff' }}>售罄</span>}
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, marginBottom: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{getName(item.translations)}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--red-primary)' }}>€{item.price}</div>
                {item.optionGroups && item.optionGroups.length > 0 && <div style={{ fontSize: 9, color: 'var(--text-light)', marginTop: 2 }}>⚙ {t('customer.selectOptions')}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Order Panel */}
      <div style={{ width: 320, flexShrink: 0, background: 'var(--bg-white)', borderLeft: '2px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>🧾 点单</h3>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={clearOrder}>清空</button>
        </div>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => switchOrderType('dine_in')} style={{ flex: 1, fontSize: 12, padding: '6px 0', background: orderType === 'dine_in' ? 'var(--red-primary)' : 'var(--bg)', color: orderType === 'dine_in' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>堂食</button>
            <button className="btn" onClick={() => switchOrderType('takeout')} style={{ flex: 1, fontSize: 12, padding: '6px 0', background: orderType === 'takeout' ? 'var(--red-primary)' : 'var(--bg)', color: orderType === 'takeout' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>外卖</button>
            <button className="btn" onClick={() => switchOrderType('phone')} style={{ flex: 1, fontSize: 12, padding: '6px 0', background: orderType === 'phone' ? 'var(--red-primary)' : 'var(--bg)', color: orderType === 'phone' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>📞 电话</button>
          </div>
        </div>

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
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>客人电话（可选）</label>
            <input
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="例如 0851234567"
              value={phoneGuestPhone}
              onChange={(e) => setPhoneGuestPhone(e.target.value)}
              style={{ width: '100%', fontSize: 15, padding: '10px 12px' }}
            />
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>称呼（可选）</label>
            <input
              className="input"
              type="text"
              placeholder="客人姓名"
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
              <span style={{ fontSize: 13 }}>点击左侧菜品加入</span>
            </div>
          ) : order.map((line, idx) => {
            const optExtra = (line.options || []).reduce((sum, opt) => sum + opt.extraPrice, 0);
            const isEditing = editingLineId === line.id;
            return (
              <div key={line.id} onClick={() => removeLine(line.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 16px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#FFEBEE')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span style={{ fontSize: 11, color: 'var(--text-light)', minWidth: 20 }}>{idx + 1}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.name}</div>
                  {line.options && line.options.length > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-light)' }}>
                      {line.options.map((opt, i) => <span key={i}>{i > 0 && ' · '}{opt.choiceName[lang] || Object.values(opt.choiceName)[0]}{opt.extraPrice > 0 && ` +€${opt.extraPrice}`}</span>)}
                    </div>
                  )}
                </div>
                {isEditing ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
                    <span style={{ fontSize: 12, color: 'var(--text-light)' }}>€</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      value={editPrice}
                      onChange={e => setEditPrice(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') confirmEditPrice(line.id); if (e.key === 'Escape') setEditingLineId(null); }}
                      onBlur={() => confirmEditPrice(line.id)}
                      autoFocus
                      style={{ width: 60, fontSize: 13, fontWeight: 700, padding: '2px 4px', textAlign: 'right' }}
                    />
                  </div>
                ) : (
                  <span
                    onClick={(e) => startEditPrice(line.id, line.price + optExtra, e)}
                    style={{ fontSize: 13, fontWeight: 700, color: 'var(--red-primary)', minWidth: 45, textAlign: 'right', cursor: 'text', borderBottom: '1px dashed var(--red-primary)' }}
                  >€{(line.price + optExtra).toFixed(2)}</span>
                )}
                <span style={{ fontSize: 14, color: 'var(--text-light)', marginLeft: 4 }}>✕</span>
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
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>合计 · {order.length} 件</span>
            <div style={{ textAlign: 'right' }}>
              {bundleTotals.bundleDiscount > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-light)', textDecoration: 'line-through' }}>€{totalAmount.toFixed(2)}</div>
              )}
              <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{finalTotal.toFixed(2)}</span>
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void handlePrimaryAction()}
            disabled={order.length === 0 || paying}
            style={{ width: '100%', fontSize: 15, padding: '12px 0', letterSpacing: 1 }}
          >
            {orderType === 'phone'
              ? t('cashier.createPhoneOrder')
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

      {/* Option selection modal */}
      {optionModal && optionModal.optionGroups && optionModal.optionGroups.length > 0 && (
        <OptionSelectModal
          itemName={getName(optionModal.translations)}
          price={optionModal.price}
          optionGroups={optionModal.optionGroups}
          onConfirm={(opts) => addToOrderWithOptions(optionModal, opts)}
          onClose={() => setOptionModal(null)}
        />
      )}
    </div>
  );
}
