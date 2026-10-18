import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCart } from '../../context/CartContext';
import type { CartItem } from '../../context/CartContext';
import PaymentModal from '../../components/customer/PaymentModal';
import MemberWalletPayModal from '../../components/customer/MemberWalletPayModal';
import { apiFetch } from '../../api/client';
import { resolveBackendAssetUrl } from '../../utils/backendPublicUrl';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useBusinessStatus } from '../../hooks/useBusinessStatus';
import { computeCustomerFacingPayableEuro } from '../../utils/orderPayableEuro';
import {
  computeServiceChargeEuro,
  isPayAfterDineInServiceCharge,
  parseServiceChargePercent,
  parseServiceChargeWaived,
  payableWithServiceCharge,
} from '../../utils/dineInServiceCharge';

interface OrderItem {
  _id: string;
  menuItemId?: string;
  lineKind?: string;
  quantity: number;
  unitPrice: number;
  itemName: string;
  itemNameEn?: string;
  settledQty?: number;
  refunded?: boolean;
  /** 与后端 DELETE 堂食取消规则、收银 dineInAllowCancelPending 一致 */
  kitchenPrintedQty?: number;
  roundIndex?: number;
  isMarketPrice?: boolean;
  weightKg?: number;
  pricePerKg?: number;
  selectedOptions?: { groupName: string; groupNameEn?: string; choiceName: string; choiceNameEn?: string; extraPrice: number }[];
}
interface AppliedBundle { offerId?: string; name: string; nameEn?: string; discount: number; }
interface Order {
  _id: string; type: string; tableNumber?: number; seatNumber?: number;
  dailyOrderNumber?: number; dineInOrderNumber?: string; status: string; items: OrderItem[];
  appliedBundles?: AppliedBundle[];
  deliveryFeeEuro?: number;
  pickupSlotLabel?: string;
  dineInExposedToStaff?: boolean;
  dineInStaffLockedAt?: string;
  dineInGuestLabel?: string;
  stripePaymentIntentId?: string;
  phoneCardPaidAtPlacement?: boolean;
  placementPrepaidMethod?: string;
  memberCreditUsed?: number;
  paymentStatus?: string;
  createdAt?: string;
}

interface PostOrderSlide {
  imageUrl: string;
  captionZh?: string;
  captionEn?: string;
}

interface PostOrderAdBanner {
  _id: string;
  titleZh: string;
  titleEn?: string;
  linkUrl: string;
  slides: PostOrderSlide[];
}

/** 下单后在本页即可展示广告（含待支付） */
const POST_ORDER_AD_STATUSES = new Set(['pending', 'paid_online', 'checked_out', 'completed']);

/** 堂食 pending：已出厨房或已有部分结账（加菜/锁行基准，与取消无关） */
function dineInKitchenOrSettlementStarted(o: Order): boolean {
  if (o.type !== 'dine_in' || o.status !== 'pending') return false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return true;
    if ((Number(it.settledQty) || 0) > 0) return true;
  }
  return false;
}

function dineInHasKitchenPrint(o: Order): boolean {
  if (o.type !== 'dine_in') return false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return true;
  }
  return false;
}

/** pending 且未付：顾客可自助取消（与 DELETE /api/orders/:id 一致）。跑单出厨后不可取消。 */
function customerMaySelfCancelOrder(o: Order, dineInWorkflowMode?: string): boolean {
  if (o.status !== 'pending') return false;
  if (o.stripePaymentIntentId) return false;
  if (o.phoneCardPaidAtPlacement) return false;
  if (o.placementPrepaidMethod) return false;
  if ((Number(o.memberCreditUsed) || 0) > 0.001) return false;
  const ps = String(o.paymentStatus || 'unpaid');
  if (ps === 'paid' || ps === 'partial') return false;
  if (dineInWorkflowMode === 'pay_after' && dineInHasKitchenPrint(o)) return false;
  return true;
}

function customerOrderTypeLabel(type: string, t: (key: string) => string): string {
  switch (type) {
    case 'dine_in':
      return t('customer.orderTypeLabelDineIn');
    case 'takeout':
      return t('customer.orderTypeLabelTakeout');
    case 'delivery':
      return t('customer.orderTypeLabelDelivery');
    default:
      return type;
  }
}

function customerOrderTypeBadgeStyle(type: string): { background: string; color: string } {
  switch (type) {
    case 'dine_in':
      return { background: 'rgba(196, 30, 36, 0.12)', color: '#c41e24' };
    case 'delivery':
      return { background: 'rgba(29, 78, 216, 0.12)', color: '#1d4ed8' };
    default:
      return { background: 'rgba(196, 30, 36, 0.12)', color: '#c41e24' };
  }
}

function formatCustomerOrderNumber(order: Order): string {
  if (order.type === 'dine_in' && order.dineInOrderNumber?.trim()) {
    return order.dineInOrderNumber.trim();
  }
  if (order.dailyOrderNumber != null) {
    return `#${order.dailyOrderNumber}`;
  }
  return order._id.slice(-8).toUpperCase();
}

function itemLineEuro(item: OrderItem): number {
  const extra = (item.selectedOptions || []).reduce((a, o) => a + (o.extraPrice || 0), 0);
  return (item.unitPrice + extra) * item.quantity;
}

type TableRoundSection = { round: number; items: OrderItem[] };

function OrderStatusLine({
  item,
  lang,
  qtyLabel,
  awaitWeighLabel,
}: {
  item: OrderItem;
  lang: string;
  qtyLabel: string;
  awaitWeighLabel: string;
}) {
  const title = item.isMarketPrice && Number(item.weightKg) > 0 && Number(item.pricePerKg) > 0
    ? `${lang === 'en-US' && item.itemNameEn ? item.itemNameEn : item.itemName} ${Number(item.weightKg).toFixed(2)}kg × €${Number(item.pricePerKg).toFixed(2)}/kg`
    : (lang === 'en-US' && item.itemNameEn ? item.itemNameEn : item.itemName);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
      borderBottom: '1px solid #f0f0f0',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {title}
          {item.isMarketPrice && !(Number(item.weightKg) > 0) ? (
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: '#E65100' }}>{awaitWeighLabel}</span>
          ) : null}
        </div>
        {item.selectedOptions && item.selectedOptions.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
            {item.selectedOptions.map((o, i) => (
              <span key={i}>{i > 0 && ' · '}
                {lang === 'en-US' ? (o.groupNameEn || o.groupName) : o.groupName}: {lang === 'en-US' ? (o.choiceNameEn || o.choiceName) : o.choiceName}
                {o.extraPrice > 0 && ` +€${o.extraPrice}`}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-light)' }}>€{item.unitPrice} / {qtyLabel}</div>
      </div>
      <span style={{ fontSize: 14, fontWeight: 600 }}>×{item.quantity}</span>
      <span style={{ fontWeight: 700, color: 'var(--red-primary)', minWidth: 50, textAlign: 'right', fontFamily: "'Noto Serif SC', serif" }}>
        €{itemLineEuro(item).toFixed(2)}
      </span>
    </div>
  );
}

function groupTableOrdersIntoRounds(orders: Order[]): TableRoundSection[] {
  const sorted = [...orders].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(a._id).localeCompare(String(b._id));
  });
  const sections: TableRoundSection[] = [];
  for (const o of sorted) {
    const byRound = new Map<number, OrderItem[]>();
    for (const it of o.items || []) {
      if (it.lineKind === 'delivery_fee') continue;
      const r = Math.max(1, Math.floor(Number(it.roundIndex) || 1));
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r)!.push(it);
    }
    for (const r of [...byRound.keys()].sort((a, b) => a - b)) {
      sections.push({ round: sections.length + 1, items: byRound.get(r)! });
    }
  }
  return sections;
}

function PostOrderAdCarousel({ slides, lang }: { slides: PostOrderSlide[]; lang: string }) {
  const [idx, setIdx] = useState(0);
  const scRef = useRef<HTMLDivElement>(null);

  const onScroll = useCallback(() => {
    const el = scRef.current;
    if (!el) return;
    const w = el.clientWidth || 1;
    setIdx(Math.min(slides.length - 1, Math.max(0, Math.round(el.scrollLeft / w))));
  }, [slides.length]);

  useEffect(() => {
    setIdx(0);
    const el = scRef.current;
    if (el && slides.length > 0) el.scrollTo({ left: 0, behavior: 'auto' });
  }, [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const tick = () => {
      const el = scRef.current;
      if (!el) return;
      const w = el.clientWidth;
      if (!w) return;
      const n = slides.length;
      const cur = Math.min(n - 1, Math.max(0, Math.round(el.scrollLeft / w)));
      const next = (cur + 1) % n;
      // `auto` snaps reliably; `smooth` often misses final scrollLeft / snap on some browsers
      el.scrollTo({ left: next * w, behavior: 'auto' });
      setIdx(next);
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [slides.length]);

  return (
    <>
      <div
        ref={scRef}
        onScroll={onScroll}
        style={{
          overflowX: 'auto',
          display: 'flex',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          maxHeight: 220,
        }}
      >
        {slides.map((s, i) => (
          <div
            key={i}
            style={{
              flex: '0 0 100%',
              scrollSnapAlign: 'start',
              minWidth: 0,
            }}
          >
            <img
              src={resolveBackendAssetUrl(s.imageUrl)}
              alt=""
              style={{ width: '100%', height: 'auto', display: 'block', maxHeight: 180, objectFit: 'cover' }}
            />
            {(lang === 'en-US' ? s.captionEn : s.captionZh)?.trim() ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px 4px', lineHeight: 1.35 }}>
                {lang === 'en-US' ? s.captionEn?.trim() : s.captionZh?.trim()}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {slides.length > 1 ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 6,
            padding: '6px 0 2px',
            pointerEvents: 'none',
          }}
        >
          {slides.map((_, i) => (
            <span
              key={i}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: i === idx ? 'var(--red-primary, #C41E24)' : 'rgba(0,0,0,0.15)',
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export default function OrderStatusPage() {
  const { orderId, storeSlug } = useParams<{ orderId: string; storeSlug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { config } = useRestaurantConfig();
  const { memberWalletEnabled } = useBusinessStatus();
  /** 与店首页/会员页一致：套餐未开通 `cashier.member.wallet` 时不展示会员支付 */
  const canMemberWallet = memberWalletEnabled !== false;
  const storePhone = (config.restaurant_phone || '').trim();
  const { clearCart, setItems, setEditOrderId } = useCart();
  const [order, setOrder] = useState<Order | null>(null);
  const [tableOrders, setTableOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [showMemberWallet, setShowMemberWallet] = useState(false);
  const [postOrderAds, setPostOrderAds] = useState<PostOrderAdBanner[]>([]);
  const menuHref = useMemo(() => {
    if (!storeSlug) return '/';
    const p = new URLSearchParams(searchParams);
    p.set('fromOrder', '1');
    const q = p.toString();
    return `/${storeSlug}/customer/menu${q ? `?${q}` : ''}`;
  }, [storeSlug, searchParams]);

  const tableQs = searchParams.get('table');
  const seatQs = searchParams.get('seat');

  const fetchOrder = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/orders/${orderId}`);
      if (!res.ok) throw new Error();
      const primary = (await res.json()) as Order;
      setOrder(primary);
      const tableNum = primary.tableNumber ?? Number(tableQs || 0);
      const seatQ = seatQs != null && seatQs !== '' ? seatQs : '0';
      if (primary.type === 'dine_in' && tableNum > 0) {
        const listRes = await apiFetch(`/api/orders/dine-in/active?table=${tableNum}&seat=${seatQ}`);
        const list = listRes.ok ? ((await listRes.json()) as Order[]) : [];
        const byId = new Map<string, Order>();
        for (const o of Array.isArray(list) ? list : []) byId.set(String(o._id), o);
        byId.set(String(primary._id), primary);
        const sorted = [...byId.values()].sort((a, b) => {
          const ta = new Date(a.createdAt || 0).getTime();
          const tb = new Date(b.createdAt || 0).getTime();
          if (ta !== tb) return ta - tb;
          return String(a._id).localeCompare(String(b._id));
        });
        setTableOrders(sorted);
      } else {
        setTableOrders([primary]);
      }
    } catch {
      setOrder(null);
      setTableOrders([]);
      clearCart();
    }
    finally { setLoading(false); }
  }, [orderId, clearCart, tableQs, seatQs]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);

  useEffect(() => {
    if (!order || !POST_ORDER_AD_STATUSES.has(order.status)) {
      setPostOrderAds([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/public/post-order-ads');
        if (!res.ok) return;
        const data = (await res.json()) as unknown;
        if (!cancelled && Array.isArray(data)) {
          setPostOrderAds(data as PostOrderAdBanner[]);
        }
      } catch {
        if (!cancelled) setPostOrderAds([]);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.status, orderId]);

  const impressionLoggedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!order || !POST_ORDER_AD_STATUSES.has(order.status)) return;
    if (postOrderAds.length === 0) return;
    const key = `${orderId}:${postOrderAds.map(a => a._id).sort().join(',')}`;
    if (impressionLoggedKey.current === key) return;
    impressionLoggedKey.current = key;
    void apiFetch('/api/public/post-order-ads/impressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adIds: postOrderAds.map(a => a._id) }),
    });
  }, [order?.status, orderId, postOrderAds]);

  const handleModifyOrder = async () => {
    if (!order) return;
    try {
      const payAfterDineIn = order.type === 'dine_in' && config.dine_in_workflow_mode === 'pay_after';
      if (
        !payAfterDineIn &&
        order.type === 'dine_in' &&
        order.status === 'pending' &&
        !order.dineInStaffLockedAt
      ) {
        const w = await apiFetch(`/api/orders/${order._id}/dine-in-exposed`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exposed: false }),
          omitStaffToken: true,
        });
        if (!w.ok) {
          const j = (await w.json().catch(() => null)) as { error?: { message?: string } } | null;
          alert(j?.error?.message || (lang.startsWith('zh') ? '暂时无法进入改单，请稍后再试' : 'Could not start edit'));
          return;
        }
      }
      // Fetch menu items to resolve groupId/choiceId from stored groupName/choiceName
      const menuRes = await apiFetch('/api/menu/items');
      const menuItems: {
        _id: string;
        optionGroups?: {
          _id: string;
          translations: { locale: string; name: string }[];
          choices: { _id: string; extraPrice: number; translations: { locale: string; name: string }[] }[];
        }[];
      }[] = menuRes.ok ? await menuRes.json() : [];
      const menuMap = new Map(menuItems.map(m => [m._id, m]));

      const useLockedLineBaselines =
        order.type === 'dine_in' &&
        order.status === 'pending' &&
        (payAfterDineIn ||
          dineInKitchenOrSettlementStarted(order) ||
          !!order.dineInStaffLockedAt);

      const cartItems: CartItem[] = order.items
        .filter(
          (item): item is OrderItem & { menuItemId: string } =>
            Boolean(item.menuItemId) && item.lineKind !== 'delivery_fee',
        )
        .map(item => {
        const menuItem = menuMap.get(item.menuItemId);
        const options: CartItem['options'] = [];

        if (item.selectedOptions && item.selectedOptions.length > 0 && menuItem?.optionGroups) {
          for (const sel of item.selectedOptions) {
            // Find matching group by name
            const group = menuItem.optionGroups.find(g =>
              g.translations.some(t2 => t2.name === sel.groupName)
            );
            if (group) {
              // Find matching choice by name
              const choice = group.choices.find(c =>
                c.translations.some(t2 => t2.name === sel.choiceName)
              );
              if (choice) {
                const groupNames: Record<string, string> = {};
                for (const t2 of group.translations) groupNames[t2.locale] = t2.name;
                const choiceNames: Record<string, string> = {};
                for (const t2 of choice.translations) choiceNames[t2.locale] = t2.name;
                options.push({
                  groupId: group._id,
                  choiceId: choice._id,
                  groupName: groupNames,
                  choiceName: choiceNames,
                  extraPrice: choice.extraPrice || 0,
                });
              }
            }
          }
        }

        const row: CartItem = {
          menuItemId: item.menuItemId,
          names: { 'zh-CN': item.itemName, 'en-US': item.itemNameEn || item.itemName },
          price: item.unitPrice,
          quantity: item.quantity,
          options: options.length > 0 ? options : undefined,
        };
        return useLockedLineBaselines ? { ...row, lockedBaselineQty: item.quantity } : row;
      });

      clearCart();
      setItems(cartItems);
      setEditOrderId(order._id);
      navigate(menuHref);
    } catch {
      navigate(menuHref);
    }
  };

  const handleCancelOrder = async () => {
    if (!order) return;
    if (!confirm(t('customer.confirmCancel'))) return;
    try {
      const res = await apiFetch(`/api/orders/${order._id}`, { method: 'DELETE' });
      if (res.ok) navigate(menuHref, { replace: true });
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="order-status-page">
        <div className="order-status-scroll" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {t('customer.loadingOrder')}
        </div>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="order-status-page">
        <div className="order-status-scroll" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-light)' }}>
          {t('customer.orderNotFound')}
        </div>
      </div>
    );
  }

  const isPending = order.status === 'pending';
  const displayOrders = tableOrders.length > 0 ? tableOrders : [order];
  const roundSections = order.type === 'dine_in' ? groupTableOrdersIntoRounds(displayOrders) : [];
  const payAfter = config.dine_in_workflow_mode === 'pay_after';
  const pendingPayOrders = displayOrders.filter((o) => o.status === 'pending');
  const combinedFoodPayable = pendingPayOrders.reduce(
    (s, o) => s + computeCustomerFacingPayableEuro(o, o.type === 'dine_in' && payAfter),
    0,
  );
  const serviceChargePercent = isPayAfterDineInServiceCharge(config.dine_in_workflow_mode, order.type === 'dine_in')
    ? parseServiceChargePercent(config.dine_in_service_charge_percent)
    : 0;
  const serviceChargeAmount = computeServiceChargeEuro(combinedFoodPayable, serviceChargePercent);
  const serviceChargeWaived = parseServiceChargeWaived(config.dine_in_service_charge_waived);
  const combinedPayable = payableWithServiceCharge(combinedFoodPayable, serviceChargeAmount, serviceChargeWaived);
  const payOrderIds = pendingPayOrders.map((o) => String(o._id));
  const payBlockedWeigh = pendingPayOrders.some((o) =>
    o.items.some((it) => it.isMarketPrice && !(Number(it.weightKg) > 0) && !it.refunded),
  );
  const allBundles = displayOrders.flatMap((o) => o.appliedBundles || []);
  const maySelfCancel = customerMaySelfCancelOrder(order, config.dine_in_workflow_mode);
  const showDineInPrimaryAsAddDishes =
    order.type === 'dine_in' &&
    isPending &&
    (config.dine_in_workflow_mode === 'pay_after' ||
      dineInKitchenOrSettlementStarted(order) ||
      !!order.dineInStaffLockedAt);
  const hideBackToMenu =
    order.type === 'takeout' ||
    order.type === 'delivery' ||
    (order.type === 'dine_in' && isPending);
  const modifyOrderLabel = showDineInPrimaryAsAddDishes ? t('customer.addDishes') : t('customer.modifyOrder');
  const isPaidOnline = order.status === 'paid_online';
  /** 扫码送餐：Stripe 成功后订单为 checked_out 且已写 Checkout，顾客仍显示「已支付」 */
  const isDeliveryPaidCheckout = order.type === 'delivery' && order.status === 'checked_out';
  const orderTypeLabel = customerOrderTypeLabel(order.type, t);
  const orderTypeBadgeStyle = customerOrderTypeBadgeStyle(order.type);
  const orderNumberDisplay = formatCustomerOrderNumber(order);
  const showOrderPlacedBanner = isPending;
  const isCustomerPaid = isPaidOnline || isDeliveryPaidCheckout;
  const showOrderPaidBanner = isCustomerPaid;
  const orderPlacedHint =
    order.type === 'dine_in' && config.dine_in_workflow_mode === 'pay_after'
      ? t('customer.orderPlacedDineInPayAfterHint')
      : t('customer.orderPlacedPendingPayHint');
  const orderPaidHint = order.type === 'delivery'
    ? t('customer.orderPaidDeliveryHint')
    : t('customer.orderPaidKitchenHint');

  return (
    <div className="order-status-page">
      <div className="order-status-scroll">
      {/* Status header — compact row to leave room for line items + ads */}
      <div style={{
        background: 'var(--bg-white)', borderRadius: 10, padding: '10px 14px', marginBottom: 12,
        border: '1px solid rgba(232,213,184,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 11, color: 'var(--text-light)', lineHeight: 1.2, marginBottom: 2 }}>{t('customer.orderNumber')}</div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Noto Serif SC', serif", lineHeight: 1.2 }}>
            {displayOrders.length > 1
              ? displayOrders.map(formatCustomerOrderNumber).join(' · ')
              : orderNumberDisplay}
          </div>
          {order.type === 'dine_in' && order.dineInGuestLabel?.trim() ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {t('customer.dineInGuestLabelOnOrder')}：{order.dineInGuestLabel.trim()}
            </div>
          ) : null}
        </div>
        <span style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 14,
          background: orderTypeBadgeStyle.background, color: orderTypeBadgeStyle.color, fontWeight: 600, fontSize: 12,
          flexShrink: 0,
        }}>{orderTypeLabel}</span>
      </div>

      {showOrderPlacedBanner ? (
        <div style={{
          marginBottom: 12,
          padding: '12px 14px',
          borderRadius: 10,
          background: '#E8F5E9',
          border: '1px solid #A5D6A7',
          fontSize: 13,
          lineHeight: 1.55,
          color: '#1B5E20',
          textAlign: 'center',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>✅ {t('customer.orderPlacedSuccessTitle')}</div>
          <p style={{ margin: 0 }}>{orderPlacedHint}</p>
        </div>
      ) : null}

      {showDineInPrimaryAsAddDishes ? (
        <button
          className="btn btn-primary"
          style={{ width: '100%', marginBottom: 12 }}
          onClick={handleModifyOrder}
        >
          {modifyOrderLabel}
        </button>
      ) : null}

      {showOrderPaidBanner ? (
        <div style={{
          marginBottom: 12,
          padding: '12px 14px',
          borderRadius: 10,
          background: '#E8F5E9',
          border: '1px solid #A5D6A7',
          fontSize: 13,
          lineHeight: 1.55,
          color: '#1B5E20',
          textAlign: 'center',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>✅ {t('customer.orderPaidSuccessTitle')}</div>
          <p style={{ margin: 0 }}>{orderPaidHint}</p>
        </div>
      ) : null}

      {order.type === 'takeout' && order.pickupSlotLabel?.trim() ? (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: '#E3F2FD',
          border: '1px solid #90CAF9',
          fontSize: 13,
          color: '#1565c0',
        }}>
          {t('customer.orderPickupSlotLabel')}：<strong>{order.pickupSlotLabel.trim()}</strong>
        </div>
      ) : null}

      {isPending &&
        order.type === 'dine_in' &&
        config.dine_in_workflow_mode === 'pay_after' &&
        order.dineInStaffLockedAt && (
          <div
            style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#FFF3E0',
              border: '1px solid #FFB74D',
              fontSize: 13,
              color: '#E65100',
              lineHeight: 1.5,
            }}
          >
            {t('customer.dineInStaffLockedHint')}
          </div>
        )}
      {isPending && order.type === 'delivery' && (
        <div style={{
          marginBottom: 12,
          padding: '12px 14px',
          borderRadius: 10,
          border: '1px solid #E65100',
          background: '#FFF8E1',
          fontSize: 13,
          lineHeight: 1.55,
          color: '#5D4037',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#E65100' }}>{t('customer.deliveryPolicyTitle')}</div>
          <p style={{ margin: '0 0 8px' }}>{t('customer.deliveryPolicyUnpaidNoKitchen')}</p>
          <p style={{ margin: '0 0 6px' }}>{t('customer.deliveryPolicyCashCallUs')}</p>
          {storePhone ? (
            <a href={`tel:${storePhone.replace(/\s/g, '')}`} style={{ fontWeight: 700, color: '#BF360C', wordBreak: 'break-all' }}>
              {t('customer.deliveryStorePhoneLabel')}：{storePhone}
            </a>
          ) : (
            <span style={{ fontSize: 12, color: '#6D4C41' }}>{t('customer.deliveryNoPhoneConfigured')}</span>
          )}
        </div>
      )}

      {/* Items */}
      <div style={{ background: 'var(--bg-white)', borderRadius: 12, border: '1px solid rgba(232,213,184,0.5)', overflow: 'hidden' }}>
        {roundSections.length > 0
          ? roundSections.flatMap((section) => [
            <div
              key={`round-${section.round}`}
              className={`order-status-round-head${section.round > 1 ? ' is-next' : ''}`}
            >
              {t('customer.orderRound', { n: section.round })}
            </div>,
            ...section.items.map((item, idx) => (
              <OrderStatusLine
                key={item._id || `r${section.round}-${idx}`}
                item={item}
                lang={lang}
                qtyLabel={t('customer.quantity')}
                awaitWeighLabel={t('customer.marketPriceAwaitWeigh')}
              />
            )),
          ])
          : order.items.map((item, idx) => (
            <OrderStatusLine
              key={item._id || idx}
              item={item}
              lang={lang}
              qtyLabel={t('customer.quantity')}
              awaitWeighLabel={t('customer.marketPriceAwaitWeigh')}
            />
          ))}
        {allBundles.length > 0 && (
          <div style={{ padding: '0 16px 12px' }}>
            {allBundles.map((b, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#2E7D32', padding: '2px 0' }}>
                <span>🎁 {b.name}{b.nameEn ? ` ${b.nameEn}` : ''}</span>
                <span style={{ fontWeight: 600 }}>-€{b.discount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
        {serviceChargeAmount > 0.001 ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 16px 8px', fontSize: 14, color: serviceChargeWaived ? '#94a3b8' : '#475569' }}>
            <span>{t(serviceChargeWaived ? 'customer.serviceChargeWaived' : 'customer.serviceCharge', { percent: serviceChargePercent })}</span>
            <span style={serviceChargeWaived ? { textDecoration: 'line-through' } : undefined}>€{serviceChargeAmount.toFixed(2)}</span>
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 16px', fontWeight: 700, fontSize: 16 }}>
          <span>{t('customer.totalAmount')}</span>
          <span style={{ color: 'var(--red-primary)', fontFamily: "'Noto Serif SC', serif" }}>€{combinedPayable.toFixed(2)}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {isPending && payBlockedWeigh ? (
          <div style={{ padding: '12px 14px', background: '#FFF8E1', borderRadius: 10, fontSize: 13, color: '#E65100', fontWeight: 600 }}>
            {t('customer.payBlockedAwaitWeigh')}
          </div>
        ) : null}
        {isPending && (
          <>
            {/* Online Payment Button */}
            <button className="btn" onClick={() => setShowPayment(true)}
              disabled={payBlockedWeigh}
              style={{
                width: '100%', padding: '14px 0', fontSize: 16, fontWeight: 700,
                background: '#000', color: '#fff', border: 'none', borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
              <span style={{ fontSize: 20 }}>💳</span> {t('customer.payNow')} · €{combinedPayable.toFixed(2)}
            </button>
            {canMemberWallet ? (
              <button
                className="btn btn-outline"
                disabled={payBlockedWeigh}
                onClick={() => setShowMemberWallet(true)}
                style={{
                  width: '100%',
                  padding: '14px 0',
                  fontSize: 15,
                  fontWeight: 700,
                  borderRadius: 12,
                  border: '2px solid var(--gold-primary, #C5A059)',
                  color: 'var(--text-dark)',
                  background: 'linear-gradient(180deg, #fffef8 0%, #faf6eb 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 20 }}>👛</span> {t('customer.memberWalletPay')} · €{combinedPayable.toFixed(2)}
              </button>
            ) : null}
            {hideBackToMenu ? (
              showDineInPrimaryAsAddDishes ? (
                maySelfCancel ? (
                  <button
                    onClick={handleCancelOrder}
                    style={{
                      width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600,
                      background: 'none', border: '1px dashed #F44336', borderRadius: 10,
                      color: '#F44336', cursor: 'pointer',
                    }}
                  >
                    ✕ {t('customer.cancelOrder')}
                  </button>
                ) : null
              ) : (
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className="btn btn-primary"
                    style={{ flex: maySelfCancel ? 1 : undefined, width: maySelfCancel ? undefined : '100%' }}
                    onClick={handleModifyOrder}
                  >
                    {modifyOrderLabel}
                  </button>
                  {maySelfCancel ? (
                    <button
                      onClick={handleCancelOrder}
                      style={{
                        flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600,
                        background: 'none', border: '1px dashed #F44336', borderRadius: 10,
                        color: '#F44336', cursor: 'pointer',
                      }}
                    >
                      ✕ {t('customer.cancelOrder')}
                    </button>
                  ) : null}
                </div>
              )
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10 }}>
                  {showDineInPrimaryAsAddDishes ? null : (
                    <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleModifyOrder}>
                      {modifyOrderLabel}
                    </button>
                  )}
                  {maySelfCancel ? (
                    <button
                      onClick={handleCancelOrder}
                      style={{
                        flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600,
                        background: 'none', border: '1px dashed #F44336', borderRadius: 10,
                        color: '#F44336', cursor: 'pointer',
                      }}
                    >
                      ✕ {t('customer.cancelOrder')}
                    </button>
                  ) : (
                    <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => navigate(menuHref)}>
                      {t('customer.backToMenu')}
                    </button>
                  )}
                </div>
                {maySelfCancel ? (
                  <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => navigate(menuHref)}>
                    {t('customer.backToMenu')}
                  </button>
                ) : null}
              </>
            )}
          </>
        )}
        {(isPaidOnline || isDeliveryPaidCheckout) && order.type !== 'takeout' && order.type !== 'delivery' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => navigate(menuHref)}>
              {t('customer.backToMenu')}
            </button>
          </div>
        )}
        {!isPending && !isPaidOnline && !isDeliveryPaidCheckout && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: 'var(--text-light)', fontSize: 13, textAlign: 'center', width: '100%' }}>
              {t('customer.orderNotModifiable')}
            </p>
            {order.type !== 'takeout' && order.type !== 'delivery' ? (
              <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => navigate(menuHref)}>
                {t('customer.backToMenu')}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {order && POST_ORDER_AD_STATUSES.has(order.status) && postOrderAds.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10,
            color: 'var(--text-light)',
            marginBottom: 6,
            letterSpacing: 0.03,
          }}>
            {t('customer.postOrderSponsored')}
          </div>
          {postOrderAds.map((ad) => (
            <a
              key={ad._id}
              href={ad.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                void apiFetch('/api/public/post-order-ads/click', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ adId: ad._id }),
                });
              }}
              style={{
                display: 'block',
                marginBottom: 12,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid rgba(232,213,184,0.45)',
                background: 'var(--bg-white)',
                textDecoration: 'none',
                color: 'inherit',
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}
            >
              {ad.slides && ad.slides.length > 0 ? (
                <PostOrderAdCarousel slides={ad.slides} lang={lang} />
              ) : null}
              <div style={{ padding: '10px 14px', fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
                {lang === 'en-US' && ad.titleEn?.trim() ? ad.titleEn : ad.titleZh}
              </div>
            </a>
          ))}
        </div>
      )}

      </div>

      {/* Payment Modal */}
      {showPayment && order && (
        <PaymentModal
          orderId={order._id}
          orderIds={payOrderIds}
          amount={combinedPayable}
          onSuccess={() => {
            setShowPayment(false);
            fetchOrder(); // Refresh to show checked_out status
          }}
          onClose={() => setShowPayment(false)}
        />
      )}
      {canMemberWallet && showMemberWallet && order && (
        <MemberWalletPayModal
          orderId={order._id}
          orderIds={payOrderIds}
          tableNumber={order.tableNumber}
          amount={combinedPayable}
          onSuccess={() => {
            setShowMemberWallet(false);
            fetchOrder();
          }}
          onClose={() => setShowMemberWallet(false)}
        />
      )}
    </div>
  );
}
