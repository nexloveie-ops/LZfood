import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { connectStoreSocket } from '../../api/storeSocket';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import { printBuiltReceipt, type BundleDiscountInfo } from '../../components/cashier/ReceiptPrint';
import { type ReceiptOptionSnapshot, receiptOptionExtraEuro } from '../../utils/receiptOptionPrice';
import { computeDineInUnsettledPayableEuro, computePartialDineInSettlementPreview, dineInHasUnsettledFoodLineQty } from '../../utils/orderPayableEuro';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';
import OrderItemOptionGroupList from '../../components/cashier/OrderItemOptionGroupList';

type OrderType = 'dine_in' | 'takeout' | 'phone' | 'delivery';
type OrderStatus = 'pending' | 'paid_online' | 'checked_out' | 'completed' | 'refunded' | 'checked_out-hide' | 'completed-hide';
type DeliveryStage = 'new' | 'accepted' | 'picked_up_by_driver' | 'out_for_delivery';

interface OrderRow {
  _id: string;
  type: OrderType;
  status: OrderStatus;
  dailyOrderNumber?: number;
  /** 堂食扫码单号（顾客端常见） */
  dineInOrderNumber?: string;
  tableNumber?: number;
  seatNumber?: number;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  postalCode?: string;
  deliverySource?: 'phone' | 'qr';
  deliveryStage?: DeliveryStage;
  deliveryDistanceKm?: number;
  deliveryFeeEuro?: number;
  /** 顾客 Stripe 支付成功时间（ISO）；完结后仍存在 */
  customerOnlinePaymentAt?: string;
  pickupSlotLabel?: string;
  pickupSlotStart?: string;
  items: {
    _id: string;
    quantity: number;
    unitPrice: number;
    itemName: string;
    itemNameEn?: string;
    lineKind?: string;
    refunded?: boolean;
    /** 已打印至厨房小票的份数（后结堂食增量打印） */
    kitchenPrintedQty?: number;
    settledQty?: number;
    selectedOptions?: {
      groupName?: string;
      groupNameEn?: string;
      choiceName?: string;
      choiceNameEn?: string;
      extraPrice?: number;
    }[];
  }[];
  appliedBundles?: { discount: number; name?: string; nameEn?: string }[];
  createdAt: string;
  stripePaymentIntentId?: string;
  memberCreditUsed?: number;
  memberPhoneSnapshot?: string;
  memberId?: string;
  /** 外卖：收银 JWT 创建为 cashier，顾客端为 customer */
  takeoutPlacementSource?: 'cashier' | 'customer';
  dineInGuestLabel?: string;
  dineInExposedToStaff?: boolean;
  dineInStaffLockedAt?: string;
  /** 收银创建时客人已通过「电话刷卡」付款；与 paid_online 同流程，结账记为 card */
  phoneCardPaidAtPlacement?: boolean;
  placementPrepaidMethod?: 'card' | 'member';
  paymentStatus?: string;
  fulfillmentStatus?: string;
  dualTrackVersion?: number;
}

function mapSelectedOptionsForReceipt(
  opts: OrderRow['items'][0]['selectedOptions'],
): ReceiptOptionSnapshot[] {
  return (opts || []).map((opt) => ({
    groupName: String(opt.groupName ?? '').trim(),
    groupNameEn: String(opt.groupNameEn ?? '').trim(),
    choiceName: String(opt.choiceName ?? '').trim(),
    choiceNameEn: String(opt.choiceNameEn ?? '').trim(),
    extraPrice: opt.extraPrice || 0,
  }));
}

function mapOrderItemToReceipt(item: OrderRow['items'][0], qtyOverride: number) {
  return {
    _id: item._id,
    ...(item.lineKind === 'delivery_fee' ? {} : { menuItemId: item._id }),
    lineKind: item.lineKind,
    quantity: qtyOverride,
    unitPrice: item.unitPrice,
    itemName: item.itemName,
    itemNameEn: item.itemNameEn,
    selectedOptions: mapSelectedOptionsForReceipt(item.selectedOptions),
  };
}

interface RestaurantConfig {
  restaurant_name_en?: string;
  restaurant_name_zh?: string;
  restaurant_address?: string;
  restaurant_phone?: string;
  restaurant_website?: string;
  restaurant_email?: string;
  receipt_terms?: string;
  receipt_print_copies?: string;
  dine_in_workflow_mode?: 'pay_first' | 'pay_after';
}

function orderNoForDisplay(o: OrderRow): string {
  if (o.type === 'dine_in' && o.dineInOrderNumber?.trim()) return o.dineInOrderNumber.trim();
  if (o.dailyOrderNumber != null && Number.isFinite(o.dailyOrderNumber)) return `#${o.dailyOrderNumber}`;
  return '—';
}

/** 顾客扫码自取（非收银点单） */
function isCustomerQrTakeout(o: OrderRow): boolean {
  return o.type === 'takeout' && o.takeoutPlacementSource !== 'cashier';
}

/** 顾客自取：厨房已接单（以服务端 kitchenPrintedQty 为准） */
function isTakeoutKitchenReleased(o: OrderRow): boolean {
  if (!isCustomerQrTakeout(o)) return true;
  return isOrderKitchenFullyPrinted(o);
}

function isOrderKitchenFullyPrinted(o: OrderRow): boolean {
  if (o.type === 'takeout' && o.takeoutPlacementSource === 'cashier') return true;
  let hasFood = false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    hasFood = true;
    const q = it.quantity;
    const p = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, q));
    if (p < q) return false;
  }
  return hasFood;
}

function fulfillmentStatusLabel(o: OrderRow, isEn: boolean): string {
  if (o.type === 'delivery') {
    const fs = o.fulfillmentStatus;
    if (fs === 'fulfilled' || o.deliveryStage === 'picked_up_by_driver') {
      return isEn ? 'Fulfilled' : '已取/已送';
    }
    return isOrderKitchenFullyPrinted(o)
      ? (isEn ? 'In kitchen' : '厨房制作中')
      : (isEn ? 'Awaiting kitchen' : '待送厨房');
  }
  if (isCustomerQrTakeout(o)) {
    return isOrderKitchenFullyPrinted(o)
      ? (isEn ? 'In kitchen' : '厨房制作中')
      : (isEn ? 'Awaiting kitchen' : '待送厨房');
  }
  const fs = o.fulfillmentStatus;
  if (fs === 'kitchen' || fs === 'ready') return isEn ? 'In kitchen' : '厨房制作中';
  if (fs === 'fulfilled') return isEn ? 'Fulfilled' : '已取/已送';
  return isEn ? 'Awaiting kitchen' : '待送厨房';
}

function paymentStatusLabel(o: OrderRow, isEn: boolean): string {
  const ps = o.paymentStatus;
  if (ps === 'paid') return isEn ? 'Paid' : '已付';
  if (ps === 'partial') return isEn ? 'Partial' : '部分已付';
  if (ps === 'refunded') return isEn ? 'Refunded' : '已退';
  if (o.status === 'paid_online' || o.status === 'checked_out') return isEn ? 'Paid' : '已付';
  return isEn ? 'Unpaid' : '未付';
}

/** 外卖：是否已在服务端标记厨房已打印（kitchenPrintedQty 满额） */
function takeoutKitchenPrintedOnOrder(o: OrderRow): boolean {
  return o.type === 'takeout' && isOrderKitchenFullyPrinted(o);
}

/** 收银端创建的外卖在 checked_out 下不再要求先点「打印厨房」 */
function isTakeoutCheckedOutKitchenStepDone(o: OrderRow, printedIds: Record<string, true>): boolean {
  if (o.type !== 'takeout' || o.status !== 'checked_out') return false;
  if (o.takeoutPlacementSource === 'cashier') return true;
  return takeoutKitchenPrintedOnOrder(o) || !!printedIds[o._id];
}

function isTakeoutKitchenPrintDone(o: OrderRow, _printedIds: Record<string, true>): boolean {
  return isTakeoutKitchenReleased(o);
}

function isPhonePlacementKitchenStepDone(o: OrderRow, printedIds: Record<string, true>): boolean {
  const prepaid =
    o.phoneCardPaidAtPlacement || o.placementPrepaidMethod === 'card' || o.placementPrepaidMethod === 'member';
  if (o.type !== 'phone' || !prepaid) return false;
  let hasFood = false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    hasFood = true;
    const q = it.quantity;
    const p = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, q));
    if (p < q) return false;
  }
  return hasFood || !!printedIds[o._id];
}

/** 堂食 pending：未出厨房、未部分结账时可整单取消 */
function dineInAllowCancelPending(o: OrderRow): boolean {
  if (o.type !== 'dine_in' || o.status !== 'pending') return false;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    if ((Number(it.kitchenPrintedQty) || 0) > 0) return false;
    if ((Number(it.settledQty) || 0) > 0) return false;
  }
  return true;
}

/** pending 单：未付/未送厨房/司机未取走时可取消（与 DELETE /api/orders/:id 一致） */
function pendingOrderAllowCancel(o: OrderRow): boolean {
  if (o.status !== 'pending') return false;
  if (o.type === 'dine_in') return dineInAllowCancelPending(o);
  if (isOrderKitchenFullyPrinted(o)) return false;
  if (o.type === 'delivery' && o.deliveryStage === 'picked_up_by_driver') return false;
  if (o.paymentStatus === 'paid' || o.paymentStatus === 'partial') return false;
  return true;
}

/** 后结堂食：仍有未打厨房小票的菜品份数（顾客加菜等）；含 checked_out 以便订单中心在已结账仍待出厨房时继续展示 */
function dineInKitchenUnprintedPortions(o: OrderRow): number {
  if (o.type !== 'dine_in') return 0;
  if (o.status !== 'pending' && o.status !== 'paid_online' && o.status !== 'checked_out') return 0;
  let s = 0;
  for (const it of o.items || []) {
    if (it.lineKind === 'delivery_fee' || it.refunded) continue;
    const p = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, it.quantity));
    s += it.quantity - p;
  }
  return s;
}

/** 后结堂食：需要走厨房增量/全量标记的订单（含已结账但厨房仍未打满的，否则全桌打印无法清队列） */
function dineInPayAfterEligibleForKitchenMark(o: OrderRow, dineInPayAfter: boolean): boolean {
  if (!dineInPayAfter || o.type !== 'dine_in') return false;
  if (o.status === 'pending' || o.status === 'paid_online') return true;
  return o.status === 'checked_out' && dineInKitchenUnprintedPortions(o) > 0;
}

function compareCreatedAt(a: OrderRow, b: OrderRow): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk && ta !== tb) return ta - tb;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  return String(a._id).localeCompare(String(b._id));
}

/** 同桌仅待结账（pending）堂食单按创建时间先后得到「轮次」1..N；有单结账离开后剩余单重新从 1 编号 */
function dineInRoundByOrderId(orders: OrderRow[]): Map<string, number> {
  const map = new Map<string, number>();
  const byTable = new Map<number, OrderRow[]>();
  for (const o of orders) {
    if (o.type !== 'dine_in' || o.status !== 'pending') continue;
    const t = typeof o.tableNumber === 'number' && Number.isFinite(o.tableNumber) ? o.tableNumber : -1;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t)!.push(o);
  }
  for (const [, list] of byTable) {
    [...list].sort(compareCreatedAt).forEach((o, i) => map.set(o._id, i + 1));
  }
  return map;
}

/** 堂食卡片主标题：柜台座 0 对待结账单显示「轮次 N」；非 pending 显示单号 */
function dineInSeatLineOrGuestLabel(o: OrderRow, roundById: Map<string, number>, isEn: boolean): string {
  if (o.type !== 'dine_in') return isEn ? `Seat ${o.seatNumber ?? '-'}` : `座 ${o.seatNumber ?? '-'}`;
  const seat = o.seatNumber ?? 0;
  if (seat === 0) {
    if (o.status !== 'pending') return orderNoForDisplay(o);
    const r = roundById.get(o._id);
    if (r != null && r >= 1) return isEn ? `Round ${r}` : `轮次 ${r}`;
    return isEn ? 'Round —' : '轮次 —';
  }
  return isEn ? `Seat ${seat}` : `座 ${seat}`;
}

/** 堂食「桌 / …」：座 0 对待结账显示桌号 + 轮次；非 pending 显示桌号 + 单号 */
function dineInTableAndSeatOrLabelLine(o: OrderRow, roundById: Map<string, number>, isEn: boolean): string {
  if (o.type !== 'dine_in') return '';
  const table = o.tableNumber ?? '-';
  const seat = o.seatNumber ?? 0;
  if (seat === 0) {
    if (o.status !== 'pending') {
      const no = orderNoForDisplay(o);
      return isEn ? `Table ${table} / ${no}` : `桌 ${table} / ${no}`;
    }
    const r = roundById.get(o._id);
    const roundText =
      r != null && r >= 1 ? (isEn ? `Round ${r}` : `轮次 ${r}`) : isEn ? 'Round —' : '轮次 —';
    return isEn ? `Table ${table} / ${roundText}` : `桌 ${table} / ${roundText}`;
  }
  return isEn ? `Table ${table} / Seat ${seat}` : `桌 ${table} / 座 ${seat}`;
}

function calcTotal(order: OrderRow): number {
  const itemTotal = order.items.reduce((sum, item) => {
    const extra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
    return sum + (item.unitPrice + extra) * item.quantity;
  }, 0);
  const disc = (order.appliedBundles || []).reduce((s, b) => s + b.discount, 0);
  const hasFeeLine = order.items.some((i) => i.lineKind === 'delivery_fee');
  const deliveryExtra =
    order.type === 'delivery' && !hasFeeLine ? (Number(order.deliveryFeeEuro) || 0) : 0;
  return itemTotal - disc + deliveryExtra;
}

/** 后结堂食 pending：应付为未结子集；若异常为 checked_out 仍有未结金额/份数，仍按未结展示 */
function counterPayable(o: OrderRow, dineInPayAfter: boolean): number {
  if (o.type === 'dine_in' && dineInPayAfter) {
    const unsettled = computeDineInUnsettledPayableEuro({
      type: o.type,
      items: o.items,
      appliedBundles: o.appliedBundles,
      deliveryFeeEuro: o.deliveryFeeEuro,
    });
    if (o.status === 'pending' || unsettled > 0.02 || dineInHasUnsettledFoodLineQty(o)) return unsettled;
  }
  return calcTotal(o);
}

/** 按桌结账弹窗：先结仅 pending；后结为仍有未结金额或仍有未结份数的单（避免一桌无 pending 时无法结账） */
function dineInOrdersForTableCheckoutModal(tableOrders: OrderRow[], dineInPayAfter: boolean): OrderRow[] {
  if (!dineInPayAfter) {
    return tableOrders.filter((o) => o.status === 'pending');
  }
  return tableOrders.filter((o) => counterPayable(o, true) > 0.02 || dineInHasUnsettledFoodLineQty(o));
}

/** 与 Stripe 区分：无 PaymentIntent 且已记会员扣款（顾客扫码会员付 / 柜台会员全额等） */
function isCustomerMemberWalletPrepaid(o: OrderRow): boolean {
  if (String(o.stripePaymentIntentId || '').trim()) return false;
  return (Number(o.memberCreditUsed) || 0) > 0.001;
}

export default function UnifiedOrderCenter() {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language?.startsWith('en');
  const { token, user, hasFeature } = useAuth();
  const canDelivery = hasFeature('cashier.delivery.page');
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const canCustomerNotify = hasFeature('admin.customerNotifications.page');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [config, setConfig] = useState<RestaurantConfig>({});
  const dineInPayAfter = config.dine_in_workflow_mode === 'pay_after';
  const [loadHint, setLoadHint] = useState('');
  const [queueMode, setQueueMode] = useState<'unified' | 'fallback'>('unified');
  const [checkoutModalOrder, setCheckoutModalOrder] = useState<OrderRow | null>(null);
  const [checkoutModalTable, setCheckoutModalTable] = useState<{ tableNumber: number; orders: OrderRow[] } | null>(null);
  /** 后结按桌结账：先勾选行再进入支付方式 */
  const [tableCheckoutStep, setTableCheckoutStep] = useState<'lines' | 'pay'>('pay');
  /** key = `${orderId}:${lineItemId}` → 本次结账份数 */
  const [tablePartialQtyByLineKey, setTablePartialQtyByLineKey] = useState<Record<string, number>>({});
  const [detailModalOrder, setDetailModalOrder] = useState<OrderRow | null>(null);
  const [partialModalOrder, setPartialModalOrder] = useState<OrderRow | null>(null);
  const [partialQtyByLineId, setPartialQtyByLineId] = useState<Record<string, number>>({});
  const [checkoutMethod, setCheckoutMethod] = useState<'cash' | 'card' | 'mixed' | 'member'>('cash');
  const [cashReceived, setCashReceived] = useState('');
  const [mixedCash, setMixedCash] = useState('');
  const [mixedCard, setMixedCard] = useState('');
  const [memberPhone, setMemberPhone] = useState('');
  const [memberPreview, setMemberPreview] = useState<CashierMemberPreview | null>(null);
  /** 外卖自提 paid_online：先厨房小票再完结。checked_out 且 takeoutPlacementSource=cashier 则视同厨房小票已在点单结账时完成 */
  const [takeoutKitchenTicketPrintedIds, setTakeoutKitchenTicketPrintedIds] = useState<Record<string, true>>({});
  /** 电话单「电话刷卡」已付：先厨房小票再调 complete-placement（与外卖 paid_online 两步类似） */
  const [placementCardKitchenPrintedIds, setPlacementCardKitchenPrintedIds] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!canMemberWallet && checkoutMethod === 'member') {
      setCheckoutMethod('cash');
      setMemberPreview(null);
    }
  }, [canMemberWallet, checkoutMethod]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersRes, cfgRes] = await Promise.all([
        apiFetch('/api/orders/active-all', { headers: { Authorization: `Bearer ${token}` } }),
        apiFetch('/api/admin/config'),
      ]);
      if (cfgRes.ok) {
        setConfig(await cfgRes.json());
      }
      if (ordersRes.ok) {
        setOrders(await ordersRes.json());
        setLoadHint('');
        setQueueMode('unified');
      } else {
        // Backward-compatible fallback: if backend hasn't restarted yet, aggregate from legacy endpoints.
        const [dineInRes, takeoutRes, phoneRes] = await Promise.all([
          apiFetch('/api/orders/dine-in', { headers: { Authorization: `Bearer ${token}` } }),
          apiFetch('/api/orders/takeout', { headers: { Authorization: `Bearer ${token}` } }),
          apiFetch('/api/orders/phone', { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const merged: OrderRow[] = [];
        if (dineInRes.ok) merged.push(...(await dineInRes.json()) as OrderRow[]);
        if (takeoutRes.ok) merged.push(...(await takeoutRes.json()) as OrderRow[]);
        if (phoneRes.ok) merged.push(...(await phoneRes.json()) as OrderRow[]);
        setOrders(merged);
        setLoadHint('当前后端未提供统一队列接口，已回退旧接口展示（delivery 可能不完整）。请重启后端以启用完整订单中心。');
        setQueueMode('fallback');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  /** Socket 高频事件时合并为一次拉取，避免订单中心「越用越卡」 */
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFetchAll = useCallback(() => {
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    fetchDebounceRef.current = setTimeout(() => {
      fetchDebounceRef.current = null;
      void fetchAll();
    }, 400);
  }, [fetchAll]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const query = user?.storeId ? { storeId: user.storeId } : {};
    const socket = connectStoreSocket(query);
    socket.on('order:new', scheduleFetchAll);
    socket.on('order:updated', scheduleFetchAll);
    socket.on('order:checked-out', scheduleFetchAll);
    socket.on('order:cancelled', scheduleFetchAll);
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      socket.disconnect();
    };
  }, [scheduleFetchAll, user?.storeId]);

  useEffect(() => {
    const allowed = new Set(
      orders
        .filter((o) => o.type === 'takeout' && (o.status === 'paid_online' || o.status === 'checked_out'))
        .map((o) => o._id),
    );
    setTakeoutKitchenTicketPrintedIds((prev) => {
      const next: Record<string, true> = {};
      for (const id of Object.keys(prev)) {
        if (allowed.has(id)) next[id] = true;
      }
      return next;
    });
  }, [orders]);

  const printCheckout = useCallback(async (checkoutId: string, opts?: { cashReceived?: number; changeAmount?: number }) => {
    const receiptRes = await apiFetch(`/api/checkout/receipt/${checkoutId}`);
    if (!receiptRes.ok) return;
    const receipt = await receiptRes.json();
    await printBuiltReceipt(receipt, config, {
      cashReceived: opts?.cashReceived,
      changeAmount: opts?.changeAmount,
      copies: 1,
    });
  }, [config]);

  const checkoutSeat = useCallback(async (
    order: OrderRow,
    paymentMethod: 'cash' | 'card' | 'mixed' | 'member',
    mixed?: { cashAmount: number; cardAmount: number },
    cashMeta?: { cashReceived: number; changeAmount: number },
    memberPay?: { phone: string },
  ) => {
    setBusyId(order._id);
    try {
      const total = counterPayable(order, dineInPayAfter);
      const body: Record<string, unknown> =
        paymentMethod === 'member' && memberPay
          ? buildMemberFullWalletCheckoutBody(total, memberPay.phone)
          : { paymentMethod };
      if (paymentMethod !== 'member') {
        if (paymentMethod === 'cash') body.cashAmount = total;
        if (paymentMethod === 'card') body.cardAmount = total;
        if (paymentMethod === 'mixed' && mixed) {
          body.cashAmount = mixed.cashAmount;
          body.cardAmount = mixed.cardAmount;
        }
      }
      const res = await apiFetch(`/api/checkout/seat/${order._id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setBusyId(null);
        if (data?._id) void printCheckout(String(data._id), cashMeta).catch(() => {});
        /** 收银结账已联动打印小票：顾客外卖单视为出餐/厨房步骤已满足 */
        if (order.type === 'takeout') {
          setTakeoutKitchenTicketPrintedIds((prev) => ({ ...prev, [order._id]: true }));
        }
        void fetchAll();
      }
    } finally {
      setBusyId(null);
    }
  }, [dineInPayAfter, fetchAll, printCheckout, token]);

  const checkoutTable = useCallback(async (
    tableNumber: number,
    paymentMethod: 'cash' | 'card' | 'mixed' | 'member',
    mixed?: { cashAmount: number; cardAmount: number },
    cashMeta?: { cashReceived: number; changeAmount: number },
    memberPay?: { phone: string },
  ) => {
    const busyKey = `table-${tableNumber}`;
    setBusyId(busyKey);
    try {
      const tableOrders = orders.filter((o) => o.type === 'dine_in' && o.tableNumber === tableNumber && o.status === 'pending');
      const total = tableOrders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0);
      const body: Record<string, unknown> =
        paymentMethod === 'member' && memberPay
          ? buildMemberFullWalletCheckoutBody(total, memberPay.phone)
          : { paymentMethod };
      if (paymentMethod !== 'member') {
        if (paymentMethod === 'cash') body.cashAmount = total;
        if (paymentMethod === 'card') body.cardAmount = total;
        if (paymentMethod === 'mixed' && mixed) {
          body.cashAmount = mixed.cashAmount;
          body.cardAmount = mixed.cardAmount;
        }
      }
      const res = await apiFetch(`/api/checkout/table/${tableNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setBusyId(null);
        if (data?._id) void printCheckout(String(data._id), cashMeta).catch(() => {});
        void fetchAll();
      }
    } finally {
      setBusyId(null);
    }
  }, [dineInPayAfter, fetchAll, orders, printCheckout, token]);

  const checkoutPartialTable = useCallback(
    async (
      tableNumber: number,
      lineSettlements: { orderId: string; lineId: string; qty: number }[],
      payableTotal: number,
      paymentMethod: 'cash' | 'card' | 'mixed' | 'member',
      mixed?: { cashAmount: number; cardAmount: number },
      cashMeta?: { cashReceived: number; changeAmount: number },
      memberPay?: { phone: string },
    ) => {
      const busyKey = `table-${tableNumber}`;
      setBusyId(busyKey);
      try {
        const body: Record<string, unknown> = { lineSettlements };
        if (paymentMethod === 'member' && memberPay) {
          Object.assign(body, buildMemberFullWalletCheckoutBody(payableTotal, memberPay.phone));
        } else {
          body.paymentMethod = paymentMethod;
          if (paymentMethod === 'cash') body.cashAmount = payableTotal;
          if (paymentMethod === 'card') body.cardAmount = payableTotal;
          if (paymentMethod === 'mixed' && mixed) {
            body.cashAmount = mixed.cashAmount;
            body.cardAmount = mixed.cardAmount;
          }
        }
        const res = await apiFetch(`/api/checkout/dine-in-partial-table/${tableNumber}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = await res.json();
          setBusyId(null);
          if (data?._id) void printCheckout(String(data._id), cashMeta).catch(() => {});
          void fetchAll();
          return true;
        }
        const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        alert(d?.error?.message || (isEn ? 'Checkout failed' : '结账失败'));
        return false;
      } catch {
        alert(isEn ? 'Checkout request failed.' : '结账请求失败。');
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, isEn, printCheckout, token],
  );

  const openCheckoutModal = (order: OrderRow) => {
    setCheckoutModalOrder(order);
    setCheckoutModalTable(null);
    setTableCheckoutStep('pay');
    setTablePartialQtyByLineKey({});
    setCheckoutMethod('cash');
    setCashReceived('');
    setMixedCash('');
    setMixedCard('');
    setMemberPhone('');
    setMemberPreview(null);
  };

  const openTableCheckoutModal = (tableNumber: number, tableOrders: OrderRow[]) => {
    setCheckoutModalOrder(null);
    setCheckoutModalTable({ tableNumber, orders: tableOrders });
    setTableCheckoutStep(dineInPayAfter ? 'lines' : 'pay');
    setTablePartialQtyByLineKey({});
    setCheckoutMethod('cash');
    setCashReceived('');
    setMixedCash('');
    setMixedCard('');
    setMemberPhone('');
    setMemberPreview(null);
  };

  const submitCheckoutModal = async () => {
    const targetOrder = checkoutModalOrder;
    const targetTable = checkoutModalTable;
    if (!targetOrder && !targetTable) return;
    const total = targetOrder
      ? counterPayable(targetOrder, dineInPayAfter)
      : targetTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok
        ? tablePartialPickPreview.payable
        : targetTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0;
    if (checkoutMethod === 'member') {
      if (!canMemberFullWalletPay(memberPreview, total)) {
        alert(isEn ? 'Load member and ensure balance covers the total.' : '请载入会员并确认余额不少于应付金额。');
        return;
      }
      const mp = { phone: memberPreview!.phone };
      if (targetOrder) {
        await checkoutSeat(targetOrder, 'member', undefined, undefined, mp);
      } else if (targetTable) {
        if (dineInPayAfter) {
          const prev = tablePartialPickPreview;
          if (!prev?.ok || prev.settlements.length === 0) {
            alert(isEn ? 'Select items to checkout.' : '请勾选本次要结账的菜品。');
            return;
          }
          const ok = await checkoutPartialTable(targetTable.tableNumber, prev.settlements, prev.payable, 'member', undefined, undefined, mp);
          if (!ok) return;
        } else {
          await checkoutTable(targetTable.tableNumber, 'member', undefined, undefined, mp);
        }
      }
      setCheckoutModalOrder(null);
      setCheckoutModalTable(null);
      setTableCheckoutStep('pay');
      setTablePartialQtyByLineKey({});
      return;
    }
    if (checkoutMethod === 'mixed') {
      const cash = Number(mixedCash) || 0;
      const card = Number(mixedCard) || 0;
      if (cash <= 0 || card <= 0) {
        alert('混合支付需填写现金和刷卡金额');
        return;
      }
      if (Math.abs(cash + card - total) > 0.001) {
        alert(`混合支付金额不匹配，应等于 €${total.toFixed(2)}`);
        return;
      }
      if (targetOrder) {
        await checkoutSeat(targetOrder, 'mixed', { cashAmount: cash, cardAmount: card });
      } else if (targetTable) {
        if (dineInPayAfter) {
          const prev = tablePartialPickPreview;
          if (!prev?.ok || prev.settlements.length === 0) {
            alert(isEn ? 'Select items to checkout.' : '请勾选本次要结账的菜品。');
            return;
          }
          const ok = await checkoutPartialTable(targetTable.tableNumber, prev.settlements, prev.payable, 'mixed', { cashAmount: cash, cardAmount: card });
          if (!ok) return;
        } else {
          await checkoutTable(targetTable.tableNumber, 'mixed', { cashAmount: cash, cardAmount: card });
        }
      }
      setCheckoutModalOrder(null);
      setCheckoutModalTable(null);
      setTableCheckoutStep('pay');
      setTablePartialQtyByLineKey({});
      return;
    }
    if (checkoutMethod === 'cash') {
      const paid = Number(cashReceived) || 0;
      if (paid <= 0) {
        alert('请先输入客人支付金额');
        return;
      }
      if (paid < total) {
        alert(`实收金额不足，应至少 €${total.toFixed(2)}`);
        return;
      }
      const changeAmount = Math.max(0, paid - total);
      if (targetOrder) {
        await checkoutSeat(targetOrder, 'cash', undefined, { cashReceived: paid, changeAmount });
      } else if (targetTable) {
        if (dineInPayAfter) {
          const prev = tablePartialPickPreview;
          if (!prev?.ok || prev.settlements.length === 0) {
            alert(isEn ? 'Select items to checkout.' : '请勾选本次要结账的菜品。');
            return;
          }
          const ok = await checkoutPartialTable(targetTable.tableNumber, prev.settlements, prev.payable, 'cash', undefined, { cashReceived: paid, changeAmount });
          if (!ok) return;
        } else {
          await checkoutTable(targetTable.tableNumber, 'cash', undefined, { cashReceived: paid, changeAmount });
        }
      }
      setCheckoutModalOrder(null);
      setCheckoutModalTable(null);
      setTableCheckoutStep('pay');
      setTablePartialQtyByLineKey({});
      return;
    }
    if (targetOrder) {
      await checkoutSeat(targetOrder, checkoutMethod);
    } else if (targetTable) {
      if (dineInPayAfter) {
        const prev = tablePartialPickPreview;
        if (!prev?.ok || prev.settlements.length === 0) {
          alert(isEn ? 'Select items to checkout.' : '请勾选本次要结账的菜品。');
          return;
        }
        const ok = await checkoutPartialTable(targetTable.tableNumber, prev.settlements, prev.payable, checkoutMethod);
        if (!ok) return;
      } else {
        await checkoutTable(targetTable.tableNumber, checkoutMethod);
      }
    }
    setCheckoutModalOrder(null);
    setCheckoutModalTable(null);
    setTableCheckoutStep('pay');
    setTablePartialQtyByLineKey({});
  };

  const cancelPending = useCallback(
    async (orderId: string, onAfterSuccess?: () => void) => {
      const msg = isEn ? 'Cancel this order?' : '确认取消该订单？';
      if (!confirm(msg)) return;
      setBusyId(orderId);
      try {
        const res = await apiFetch(`/api/orders/${orderId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          alert(d?.error?.message || (isEn ? 'Cancel failed' : '取消失败'));
          return;
        }
        await fetchAll();
        onAfterSuccess?.();
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, token, isEn],
  );

  const completeTakeout = useCallback(async (orderId: string) => {
    setBusyId(orderId);
    try {
      await apiFetch(`/api/orders/takeout/${orderId}/complete`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, token]);

  const completePhonePlacementCardPaid = useCallback(
    async (order: OrderRow) => {
      setBusyId(order._id);
      try {
        const res = await apiFetch(`/api/orders/phone/${order._id}/complete-placement-card-paid`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
          throw new Error(errBody?.error?.message || errBody?.message || `HTTP ${res.status}`);
        }
        await fetchAll();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(isEn ? `Could not complete phone order: ${msg}` : `未能完结电话单：${msg}`);
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, isEn, token],
  );

  const setDeliveryStage = useCallback(async (orderId: string, stage: DeliveryStage) => {
    setBusyId(orderId);
    try {
      await apiFetch(`/api/orders/${orderId}/delivery-stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deliveryStage: stage }),
      });
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, token]);


  type KitchenTicketMode = 'auto' | 'full_mark_all' | 'full_no_mark';

  const printOrderTicket = useCallback(
    async (order: OrderRow, kitchenTicket: KitchenTicketMode = 'auto') => {
      let src = order;
      if (order.type === 'delivery' || order.type === 'dine_in') {
        try {
          const res = await apiFetch(`/api/orders/${order._id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const full = (await res.json()) as OrderRow;
            src = { ...order, ...full };
          }
        } catch {
          /* keep list row */
        }
      }

      const receiptOrderType = src.type;
      const isPayAfterDineIn = dineInPayAfterEligibleForKitchenMark(src, config.dine_in_workflow_mode === 'pay_after');

      const isPhoneCardPlacement =
        !!(src as OrderRow).phoneCardPaidAtPlacement && (src.type === 'phone' || src.type === 'delivery');

      const mapItemToReceipt = mapOrderItemToReceipt;

      const pm: 'cash' | 'online' | 'member' | 'card' =
        src.status !== 'paid_online'
          ? 'cash'
          : !String(src.stripePaymentIntentId || '').trim() && (Number(src.memberCreditUsed) || 0) > 0.001
            ? 'member'
            : isPhoneCardPlacement
              ? 'card'
              : 'online';

      const useDelta =
        kitchenTicket === 'auto' &&
        isPayAfterDineIn &&
        src.items.some((it) => {
          if (it.lineKind === 'delivery_fee' || it.refunded) return false;
          const printed = Math.max(0, Math.min(Number(it.kitchenPrintedQty) || 0, it.quantity));
          return it.quantity - printed > 0;
        });

      if (kitchenTicket === 'auto' && isPayAfterDineIn && !useDelta) {
        alert(isEn ? 'No new kitchen items to print.' : '没有未打印的新增菜品。');
        return;
      }

      let receiptItems: ReturnType<typeof mapItemToReceipt>[];
      let receiptTotal: number;
      let bundleDiscounts: BundleDiscountInfo[] | undefined;

      if (useDelta) {
        receiptItems = [];
        const increments: { lineId: string; qty: number }[] = [];
        for (const item of src.items) {
          if (item.lineKind === 'delivery_fee' || item.refunded) continue;
          const printed = Math.max(0, Math.min(Number(item.kitchenPrintedQty) || 0, item.quantity));
          const unprinted = item.quantity - printed;
          if (unprinted <= 0) continue;
          receiptItems.push(mapItemToReceipt(item, unprinted));
          increments.push({ lineId: item._id, qty: unprinted });
        }
        if (receiptItems.length === 0 || increments.length === 0) {
          alert(isEn ? 'No new kitchen items to print.' : '没有未打印的新增菜品。');
          return;
        }
        receiptTotal = receiptItems.reduce((sum, item) => {
          const extra = (item.selectedOptions || []).reduce((s, o) => s + receiptOptionExtraEuro(o.extraPrice), 0);
          return sum + (item.unitPrice + extra) * item.quantity;
        }, 0);
        bundleDiscounts = undefined;

        const receiptData = {
          checkoutId: src._id,
          type: 'seat' as const,
          totalAmount: receiptTotal,
          paymentMethod: pm,
          ...(pm === 'member'
            ? {
                memberCreditUsed: Number(src.memberCreditUsed) || 0,
                memberPhoneSnapshot: String(src.memberPhoneSnapshot || ''),
              }
            : {}),
          checkedOutAt: new Date().toISOString(),
          tableNumber: src.tableNumber,
          orders: [
            {
              _id: src._id,
              type: receiptOrderType,
              seatNumber: src.seatNumber,
              dailyOrderNumber: src.dailyOrderNumber,
              dineInOrderNumber: src.dineInOrderNumber,
              status: src.status,
              items: receiptItems,
              customerName: src.customerName,
              customerPhone: src.customerPhone,
              deliveryAddress: src.deliveryAddress,
              postalCode: src.postalCode,
              deliveryFeeEuro: src.deliveryFeeEuro,
            },
          ],
        };
        await printBuiltReceipt(receiptData, config, { bundleDiscounts, copies: 1 });
        const mark = await apiFetch(`/api/orders/${src._id}/kitchen-printed-increment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ increments }),
        });
        if (!mark.ok) {
          const errBody = (await mark.json().catch(() => ({}))) as { error?: { message?: string } };
          alert(
            isEn
              ? `Print OK but failed to save kitchen state: ${errBody?.error?.message || mark.status}`
              : `已打印，但未能保存厨房出单记录：${errBody?.error?.message || mark.status}`,
          );
        }
        await fetchAll();
        return;
      }

      receiptItems = src.items.map((item) => mapItemToReceipt(item, item.quantity));
      receiptTotal = calcTotal(src);
      bundleDiscounts =
        (src.appliedBundles?.length ?? 0) > 0
          ? src.appliedBundles!.map((b) => ({
              name: b.name || '',
              nameEn: b.nameEn || '',
              discount: b.discount,
            }))
          : undefined;

      const receiptData = {
        checkoutId: src._id,
        type: 'seat' as const,
        totalAmount: receiptTotal,
        paymentMethod: pm,
        ...(pm === 'member'
          ? {
              memberCreditUsed: Number(src.memberCreditUsed) || 0,
              memberPhoneSnapshot: String(src.memberPhoneSnapshot || ''),
            }
          : {}),
        checkedOutAt: new Date().toISOString(),
        tableNumber: src.tableNumber,
        orders: [
          {
            _id: src._id,
            type: receiptOrderType,
            seatNumber: src.seatNumber,
            dailyOrderNumber: src.dailyOrderNumber,
            dineInOrderNumber: src.dineInOrderNumber,
            status: src.status,
            items: receiptItems,
            customerName: src.customerName,
            customerPhone: src.customerPhone,
            deliveryAddress: src.deliveryAddress,
            postalCode: src.postalCode,
            deliveryFeeEuro: src.deliveryFeeEuro,
          },
        ],
      };
      await printBuiltReceipt(receiptData, config, { bundleDiscounts, copies: 1 });

      const shouldMarkKitchenAll =
        (kitchenTicket === 'full_mark_all' && isPayAfterDineIn)
        || (kitchenTicket === 'auto' && (src.type === 'takeout' || src.type === 'phone' || src.type === 'delivery'));

      if (shouldMarkKitchenAll) {
        const mark = await apiFetch(`/api/orders/${src._id}/kitchen-printed-all`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!mark.ok) {
          const errBody = (await mark.json().catch(() => ({}))) as { error?: { message?: string } };
          alert(
            isEn
              ? `Could not mark kitchen printed: ${errBody?.error?.message || mark.status}`
              : `未能标记厨房已打印：${errBody?.error?.message || mark.status}`,
          );
        } else {
          await fetchAll();
        }
      }
    },
    [config.dine_in_workflow_mode, config, fetchAll, isEn, token],
  );

  /** 堂食：本桌所有订单的菜品合并打印在一张厨房小票上；后结标记各单已全量出厨房，再锁定本桌待结账订单 */
  const handleTablePrintAndLockAll = useCallback(
    async (tableGroup: { tableNumber: number; orders: OrderRow[]; pendingOrders: OrderRow[] }) => {
      const busyKey = `table-print-${tableGroup.tableNumber}`;
      if (tableGroup.orders.length === 0) return;
      setBusyId(busyKey);
      try {
        const sources: OrderRow[] = [];
        for (const o of tableGroup.orders) {
          let src = o;
          try {
            const res = await apiFetch(`/api/orders/${o._id}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
              const full = (await res.json()) as OrderRow;
              src = { ...o, ...full };
            }
          } catch {
            /* keep list row */
          }
          sources.push(src);
        }

        const mapItemToReceipt = mapOrderItemToReceipt;

        const hasAnyLine = sources.some((s) =>
          (s.items || []).some((it) => it.lineKind !== 'delivery_fee' && !it.refunded),
        );
        if (!hasAnyLine) {
          alert(isEn ? 'No items to print for this table.' : '本桌没有可打印的菜品。');
          return;
        }

        const receiptOrders = sources.map((src) => ({
          _id: src._id,
          type: 'dine_in' as const,
          seatNumber: src.seatNumber,
          dailyOrderNumber: src.dailyOrderNumber,
          dineInOrderNumber: src.dineInOrderNumber,
          dineInGuestLabel: src.dineInGuestLabel?.trim() || undefined,
          status: src.status,
          items: src.items
            .filter((it) => it.lineKind !== 'delivery_fee' && !it.refunded)
            .map((item) => mapItemToReceipt(item, item.quantity)),
        }));

        const totalAmount = sources.reduce((sum, s) => sum + calcTotal(s), 0);
        const bundleDiscounts: BundleDiscountInfo[] | undefined =
          sources.some((s) => (s.appliedBundles?.length ?? 0) > 0)
            ? sources.flatMap((s) =>
                (s.appliedBundles || []).map((b) => ({
                  name: b.name || '',
                  nameEn: b.nameEn || '',
                  discount: b.discount,
                })),
              )
            : undefined;

        const anyPending = sources.some((s) => s.status === 'pending');
        let pm: 'cash' | 'online' | 'member' = 'cash';
        let memberExtra: { memberCreditUsed?: number; memberPhoneSnapshot?: string } = {};
        if (!anyPending) {
          const allMemberPrepaid = sources.every(
            (s) => !String(s.stripePaymentIntentId || '').trim() && (Number(s.memberCreditUsed) || 0) > 0.001,
          );
          if (allMemberPrepaid && sources.length > 0) {
            pm = 'member';
            memberExtra = {
              memberCreditUsed: sources.reduce((acc, s) => acc + (Number(s.memberCreditUsed) || 0), 0),
              memberPhoneSnapshot: String(sources.find((s) => s.memberPhoneSnapshot)?.memberPhoneSnapshot || ''),
            };
          } else {
            pm = 'online';
          }
        }

        const receiptData = {
          checkoutId: `table-whole-${tableGroup.tableNumber}-${Date.now()}`,
          type: 'seat' as const,
          tableNumber: tableGroup.tableNumber,
          totalAmount,
          paymentMethod: pm,
          ...memberExtra,
          checkedOutAt: new Date().toISOString(),
          wholeTableKitchenTicket: true,
          orders: receiptOrders,
        };

        await printBuiltReceipt(receiptData, config, { bundleDiscounts, copies: 1 });

        for (const src of sources) {
          const isPayAfterDineIn = dineInPayAfterEligibleForKitchenMark(src, config.dine_in_workflow_mode === 'pay_after');
          if (!isPayAfterDineIn) continue;
          const mark = await apiFetch(`/api/orders/${src._id}/kitchen-printed-all`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!mark.ok) {
            const errBody = (await mark.json().catch(() => ({}))) as { error?: { message?: string } };
            alert(
              isEn
                ? `Printed but could not mark kitchen printed for ${orderNoForDisplay(src)}: ${errBody?.error?.message || mark.status}`
                : `已打印，但未能标记订单 ${orderNoForDisplay(src)} 的厨房出单：${errBody?.error?.message || mark.status}`,
            );
          }
        }

        if (dineInPayAfter) {
          for (const o of tableGroup.pendingOrders) {
            if (o.dineInStaffLockedAt) continue;
            const res = await apiFetch(`/api/orders/${o._id}/dine-in-staff-lock`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
              const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
              const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status}`;
              alert(
                isEn
                  ? `Printed, but could not lock order ${orderNoForDisplay(o)}: ${msg}`
                  : `已打印，但无法锁定订单 ${orderNoForDisplay(o)}：${msg}`,
              );
            }
          }
        }
        await fetchAll();
      } finally {
        setBusyId(null);
      }
    },
    [config, dineInPayAfter, fetchAll, isEn, token],
  );

  const completeTakeoutOnlinePaid = useCallback(async (order: OrderRow) => {
    setBusyId(order._id);
    try {
      let res = await apiFetch(`/api/orders/takeout/${order._id}/complete-online-paid`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      });

      // Backward compatibility: if backend has not restarted/deployed this endpoint yet,
      // finalize paid_online first, then complete takeout.
      if (res.status === 404 || res.status === 405) {
        const finalize = await apiFetch('/api/payments/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orderId: order._id }),
        });
        if (!finalize.ok) {
          const errBody = await finalize.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(errBody?.error?.message || `Finalize failed (${finalize.status})`);
        }
        res = await apiFetch(`/api/orders/takeout/${order._id}/complete`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
        throw new Error(errBody?.error?.message || errBody?.message || `HTTP ${res.status}`);
      }
      await fetchAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`未能完成外卖自提在线单：${msg}`);
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, token]);

  /** 堂食顾客已在线付款：打印出餐小票 → 后端记 completed + 在线 Checkout → 本单从订单中心移除（流程终结） */
  const completeDineInOnlinePaid = useCallback(async (order: OrderRow) => {
    setBusyId(order._id);
    try {
      await printOrderTicket(order, 'full_mark_all');
      const res = await apiFetch(`/api/orders/dine-in/${order._id}/complete-online-paid`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        await fetchAll();
        setDetailModalOrder((cur) => (cur?._id === order._id ? null : cur));
        return;
      }
      const errBody = await res.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status}`;
      alert(isEn ? `Could not close order: ${msg}` : `未能完结订单：${msg}`);
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, printOrderTicket, token]);

  const notifyCustomerReady = useCallback(async (order: OrderRow) => {
    const phone = String(order.customerPhone || '').trim();
    if (!phone) {
      alert(isEn ? 'No customer phone on this order.' : '该订单没有客人电话。');
      return;
    }
    setBusyId(order._id);
    try {
      const res = await apiFetch(`/api/orders/${order._id}/notify-customer-ready`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        sent?: boolean;
        skipped?: boolean;
        skipReason?: string;
        error?: { message?: string };
        message?: string;
      };
      if (res.ok) {
        if (data.sent) {
          alert(isEn ? 'Customer notified.' : '已通知客人。');
        } else if (data.skipped) {
          alert(
            isEn
              ? `Notification skipped: ${data.skipReason || 'policy off or duplicate'}`
              : `未发送：${data.skipReason || '策略关闭或重复发送'}`,
          );
        } else {
          alert(isEn ? 'Done.' : '已完成。');
        }
        return;
      }
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      alert(isEn ? `Could not notify customer: ${msg}` : `无法通知客人：${msg}`);
    } finally {
      setBusyId(null);
    }
  }, [isEn, token]);

  const canNotifyCustomerReady = useCallback((order: OrderRow) => {
    if (!canCustomerNotify) return false;
    if (order.type !== 'phone' && order.type !== 'delivery') return false;
    if (!String(order.customerPhone || '').trim()) return false;
    if (order.status === 'refunded' || order.status === 'completed' || order.status === 'completed-hide') return false;
    return true;
  }, [canCustomerNotify]);

  /** 后结堂食：锁定后顾客仅可加菜 */
  const openPartialModal = useCallback((o: OrderRow) => {
    const init: Record<string, number> = {};
    for (const it of o.items) {
      if (it.lineKind === 'delivery_fee' || it.refunded) continue;
      const settled = Math.max(0, Math.min(Number(it.settledQty) || 0, it.quantity));
      const un = it.quantity - settled;
      if (un > 0) init[it._id] = 0;
    }
    setPartialQtyByLineId(init);
    setPartialModalOrder(o);
  }, []);

  const submitPartialCash = useCallback(async () => {
    if (!partialModalOrder) return;
    const settlements = Object.entries(partialQtyByLineId)
      .map(([lineId, qty]) => ({ lineId, qty: Math.floor(Number(qty)) || 0 }))
      .filter((x) => x.qty > 0);
    if (settlements.length === 0) {
      alert(isEn ? 'Check at least one line to pay.' : '请至少勾选一行。');
      return;
    }
    const preview = computePartialDineInSettlementPreview(partialModalOrder, settlements);
    if (!preview.ok) {
      alert(preview.message);
      return;
    }
    setBusyId(partialModalOrder._id);
    try {
      const res = await apiFetch(`/api/checkout/dine-in-partial/${partialModalOrder._id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          lineSettlements: settlements,
          paymentMethod: 'cash',
          cashAmount: preview.payable,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { _id?: string };
        setPartialModalOrder(null);
        setPartialQtyByLineId({});
        setDetailModalOrder(null);
        if (data?._id) void printCheckout(String(data._id)).catch(() => {});
        await fetchAll();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        alert(j?.error?.message || `HTTP ${res.status}`);
      }
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, partialModalOrder, partialQtyByLineId, printCheckout, token]);

  const partialPreview = useMemo(() => {
    if (!partialModalOrder) return null;
    const settlements = Object.entries(partialQtyByLineId)
      .map(([lineId, qty]) => ({ lineId, qty: Math.floor(Number(qty)) || 0 }))
      .filter((x) => x.qty > 0);
    if (settlements.length === 0) return null;
    return computePartialDineInSettlementPreview(partialModalOrder, settlements);
  }, [partialModalOrder, partialQtyByLineId]);

  /** 按桌结账（后结）：勾选多笔单上的行 → 一次支付 */
  const tablePartialPickPreview = useMemo(() => {
    if (!checkoutModalTable || !dineInPayAfter) return null;
    const settlements: { orderId: string; lineId: string; qty: number }[] = [];
    for (const [key, qtyRaw] of Object.entries(tablePartialQtyByLineKey)) {
      const n = Math.floor(Number(qtyRaw)) || 0;
      if (n <= 0) continue;
      const colon = key.indexOf(':');
      if (colon <= 0) continue;
      const orderId = key.slice(0, colon);
      const lineId = key.slice(colon + 1);
      if (!orderId || !lineId) continue;
      settlements.push({ orderId, lineId, qty: n });
    }
    if (settlements.length === 0) {
      return { ok: false as const, message: '', payable: 0, settlements: [] as typeof settlements };
    }
    const byOrder = new Map<string, Map<string, number>>();
    for (const s of settlements) {
      if (!byOrder.has(s.orderId)) byOrder.set(s.orderId, new Map());
      const m = byOrder.get(s.orderId)!;
      m.set(s.lineId, (m.get(s.lineId) || 0) + s.qty);
    }
    let payable = 0;
    for (const o of checkoutModalTable.orders) {
      const m = byOrder.get(o._id);
      if (!m || m.size === 0) continue;
      const rows = [...m.entries()].map(([lineId, qty]) => ({ lineId, qty }));
      const p = computePartialDineInSettlementPreview(o, rows);
      if (!p.ok) return { ok: false as const, message: p.message, payable: 0, settlements };
      payable += p.payable;
    }
    return {
      ok: true as const,
      message: '',
      payable: Math.round(payable * 100) / 100,
      settlements,
    };
  }, [checkoutModalTable, dineInPayAfter, tablePartialQtyByLineKey]);

  const lockDineInPayAfter = useCallback(
    async (order: OrderRow) => {
      setBusyId(order._id);
      try {
        const res = await apiFetch(`/api/orders/${order._id}/dine-in-staff-lock`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const updated = (await res.json()) as OrderRow;
          setDetailModalOrder(updated);
          await fetchAll();
          return;
        }
        const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
        const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status}`;
        alert(isEn ? `Could not lock order: ${msg}` : `无法锁定订单：${msg}`);
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, isEn, token],
  );

  const handleDeliveryKitchenRelease = useCallback(async (order: OrderRow) => {
    setBusyId(order._id);
    try {
      await printOrderTicket(order, 'auto');
      const stage = order.deliveryStage;
      if (!stage || stage === 'new') {
        await setDeliveryStage(order._id, 'accepted');
      } else {
        await fetchAll();
      }
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, printOrderTicket, setDeliveryStage]);

  const handleDeliveryDriverPickup = useCallback(async (order: OrderRow) => {
    if (!isOrderKitchenFullyPrinted(order)) {
      alert(isEn ? 'Send the order to the kitchen first.' : '请先送厨房制作，再安排司机取餐。');
      return;
    }
    await setDeliveryStage(order._id, 'picked_up_by_driver');
  }, [isEn, setDeliveryStage]);

  const grouped = useMemo(() => {
    const byType: Record<OrderType, OrderRow[]> = { dine_in: [], takeout: [], phone: [], delivery: [] };
    for (const o of orders) {
      if (o.type === 'dine_in' && o.status === 'checked_out') {
        if (!dineInPayAfter) continue;
        const stillUnsettledEuro = computeDineInUnsettledPayableEuro({
          type: o.type,
          items: o.items,
          appliedBundles: o.appliedBundles,
          deliveryFeeEuro: o.deliveryFeeEuro,
        });
        const stillUnsettledQty = dineInHasUnsettledFoodLineQty(o);
        const kitchenUnprinted = dineInKitchenUnprintedPortions(o) > 0;
        if (stillUnsettledEuro <= 0.02 && !stillUnsettledQty && !kitchenUnprinted) continue;
      }
      // 送餐扫码 Stripe 成功后为 checked_out（已线上结账，配送未完成），必须在队列中继续走制作/取餐，不能隐藏
      if (o.type === 'delivery' && !canDelivery) continue;
      byType[o.type].push(o);
    }
    return byType;
  }, [orders, canDelivery, dineInPayAfter]);

  const dineInRoundById = useMemo(() => dineInRoundByOrderId(orders), [orders]);

  const dineInByTable = useMemo(() => {
    const map = new Map<number, OrderRow[]>();
    for (const o of grouped.dine_in) {
      const tableNo = o.tableNumber ?? -1;
      if (!map.has(tableNo)) map.set(tableNo, []);
      map.get(tableNo)!.push(o);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tableNumber, tableOrders]) => ({
        tableNumber,
        orders: tableOrders.sort((a, b) => compareCreatedAt(a, b)),
        pendingOrders: tableOrders.filter((o) => o.status === 'pending'),
        kitchenUnprintedPortions: dineInPayAfter
          ? tableOrders.reduce((s, o) => s + dineInKitchenUnprintedPortions(o), 0)
          : 0,
      }));
  }, [grouped.dine_in, dineInPayAfter]);

  const handleCustomerTakeoutKitchen = useCallback(
    async (order: OrderRow) => {
      setBusyId(order._id);
      try {
        await printOrderTicket(order);
        await fetchAll();
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, printOrderTicket],
  );

  const L = {
    title: isEn ? 'Order Center' : '订单中心',
    refresh: isEn ? 'Refresh' : '刷新',
    refreshing: isEn ? 'Refreshing…' : '刷新中…',
    unifiedMode: isEn ? 'Unified API Mode' : '统一接口模式',
    fallbackMode: isEn ? 'Fallback Mode' : '回退模式',
    empty: isEn ? 'No orders' : '暂无',
    paymentAndPrint: isEn ? 'Payment & Printing' : '收款与出单',
    fulfillmentLine: isEn ? 'Fulfillment' : '履约',
    paymentLine: isEn ? 'Payment' : '收款',
    sendToKitchen: isEn ? 'Send to kitchen' : '送厨房制作',
    kitchenPreparing: isEn ? 'Kitchen is preparing' : '厨房制作中',
    dualTrackIndependentHint: isEn ? 'Fulfillment and payment can be handled in any order' : '履约与收款可分别操作，互不影响',
    deliveryStage: isEn ? 'Delivery Stage' : '配送阶段',
    checkout: isEn ? 'Checkout' : '结账',
    cancel: isEn ? 'Cancel' : '取消',
    closeModal: isEn ? 'Close' : '关闭',
    cancelOrder: isEn ? 'Cancel order' : '取消订单',
    dineInCancelHint: isEn ? 'Only before kitchen print & partial pay' : '仅未打厨房单且未部分结账时可整单取消',
    markComplete: isEn ? 'Mark Complete' : '标记完成',
    printAndKitchenDone: isEn ? 'Print ticket & prep' : '打印小票并制作',
    printAndComplete: isEn ? 'Print & Complete' : '打印并完成',
    processing: isEn ? 'Processing…' : '处理中…',
    checkoutModalTitle: isEn ? 'Order Checkout' : '订单结账',
    total: isEn ? 'Total' : '合计',
    cash: isEn ? 'Cash' : '现金',
    card: isEn ? 'Card' : '刷卡',
    mixed: isEn ? 'Mixed' : '混合',
    member: isEn ? 'Member' : '会员',
    cashAmount: isEn ? 'Cash amount' : '现金金额',
    cardAmount: isEn ? 'Card amount' : '刷卡金额',
    paidAmount: isEn ? 'Amount paid by customer' : '客人支付金额',
    paidOnlineBadge: isEn ? 'Paid online' : '线上已付',
    memberPaidBadge: isEn ? 'Paid (member wallet)' : '会员已付',
    phoneCardPaidBadge: isEn ? 'Paid (phone card)' : '电话刷卡已付',
    memberPaidBanner: isEn ? 'MEMBER PAID · PRIORITY ORDER' : '会员已付 · 优先出单',
    stripePaidBanner: isEn ? 'ONLINE PAID · PRIORITY ORDER' : '线上已付 · 优先出单',
    phoneCardPaidBanner: isEn ? 'PHONE CARD PAID · PRINT KITCHEN THEN COMPLETE' : '电话刷卡已付 · 打印厨房后点完成',
    paymentMethodLabel: isEn ? 'Payment' : '支付方式',
    change: isEn ? 'Change' : '找零',
    confirmCheckout: isEn ? 'Confirm Checkout' : '确认结账',
    deliverySource: isEn ? 'Source' : '来源',
    stage: isEn ? 'Stage' : '阶段',
    printAndCook: isEn ? 'Print Ticket & Start Cooking' : '打印小票并开始制作',
    deliveryKitchenBeforeDriver: isEn ? 'Kitchen must start before driver pickup' : '须先出厨房单，再安排司机取餐',
    driverPickedUp: isEn ? 'Driver Picked Up' : '司机取走',
    waitDriverCash: isEn ? 'Driver picked up. Wait for driver to return and pay; payment completes the order.' : '司机已取走，等待司机回店结账；结账即完成订单。',
    cashierCollectHint: isEn ? 'Cashier collects payment after driver returns. Payment means delivered and completed.' : '司机回店后由 cashier 收款；收款即代表已送达并完成。',
    detailsTitle: isEn ? 'Order Details' : '订单详情',
    status: isEn ? 'Status' : '状态',
    customer: isEn ? 'Customer' : '客户',
    guestPhone: isEn ? 'Guest tel.' : '客人电话',
    notifyCustomerReady: isEn ? 'Notify customer — ready' : '通知客人 — 可取餐',
    notifyCustomerReadyHint: isEn ? 'Send SMS or WhatsApp per admin notification settings' : '按后台通知设置发送短信或 WhatsApp',
    address: isEn ? 'Address' : '地址',
    postalCode: isEn ? 'Postal Code' : '邮编',
    guestDeliveryAddress: isEn ? 'Delivery address (guest)' : '送餐地址（客人填写）',
    guestDeliveryPostcode: isEn ? 'Postcode (guest)' : '送餐邮编（客人填写）',
    items: isEn ? 'Items' : '菜品',
    clickToView: isEn ? 'Click to view details' : '点击查看详情',
    orderNo: isEn ? 'Order no.' : '订单号',
    printReceipt: isEn ? 'Print Ticket' : '打印小票',
    tableCheckout: isEn ? 'Checkout Table' : '按桌结账',
    tablePrintAll: isEn ? 'Print whole table' : '全桌打印',
    tablePrintAllTitle: isEn
      ? 'Print one kitchen ticket listing all dishes from every order on this table. Pay-later: mark kitchen printed for each order, then lock all pending orders.'
      : '将本桌所有订单的菜品打在一张厨房小票上；后结堂食下会标记各单已出厨房，并锁定本桌全部待结账订单。',
    tablePrintAllTitlePayFirst: isEn
      ? 'Print one kitchen ticket listing all dishes from every order on this table.'
      : '将本桌所有订单的菜品打在一张厨房小票上。',
    seatCheckout: isEn ? 'Checkout Seat' : '按座结账',
    tableLabel: isEn ? 'Table' : '桌号',
    /** 订单中心按桌分组时，数字为「本桌在列表中的订单条数」，不是物理座位数 */
    payFirstCounterGroup: isEn ? 'Counter (pay-first)' : '柜台先结',
    ordersOnTableLabel: isEn ? 'Orders on table' : '本桌订单',
    dineInGuestLabel: isEn ? 'Guest label' : '称呼/备注',
    dineInLockOrder: isEn ? 'Lock order (add-only for guest)' : '锁定订单（顾客仅可加菜）',
    dineInLockedBadge: isEn ? 'Locked · guest can only add items' : '已锁定 · 顾客仅可加菜',
    kitchenUnprinted: isEn ? 'Unprinted kitchen qty' : '厨房未打出份数',
    tableNewKitchenBadge: isEn ? 'NEW KITCHEN' : '待出厨房',
    tableKitchenNewTitle: isEn
      ? 'This table has dishes not yet on a kitchen ticket — print kitchen or whole table.'
      : '本桌有未出厨房单的菜品，请打印厨房小票或「全桌打印」。',
    partialPayTitle: isEn ? 'Partial checkout (cash)' : '部分结账（现金）',
    partialPayHint: isEn
      ? 'Check lines to settle all unsettled qty on each line; bundle discount is split by food subtotal ratio.'
      : '勾选菜品即按该行全部未结份数结账；套餐优惠按菜品原价比例摊入本次。',
    partialPayConfirm: isEn ? 'Confirm cash payment' : '确认收现金',
    partialPayOpen: isEn ? 'Partial pay' : '部分结账',
    tableCheckoutPickLines: isEn
      ? 'Check items to pay for all unsettled qty on each line (repeat until the table is fully settled).'
      : '勾选菜品即按该行全部未结份数计入本次（可多次结账直至本桌结清）。',
    tableCheckoutNextPay: isEn ? 'Next: payment' : '下一步：支付方式',
    tableCheckoutBackLines: isEn ? 'Back to item selection' : '返回修改勾选',
    tableCheckoutSelectAllUnsettled: isEn ? 'Select all unsettled' : '全选未结',
    tableCheckoutClearPick: isEn ? 'Clear selection' : '清空勾选',
    tableCheckoutThisPayment: isEn ? 'This payment' : '本次应付',
  } as const;

  const deliverySourceLabel = (source?: OrderRow['deliverySource']) => {
    if (source === 'phone') return isEn ? 'Phone' : '电话';
    if (source === 'qr') return 'QR';
    return '-';
  };

  const deliveryStageLabel = (stage?: DeliveryStage) => {
    if (!stage || stage === 'new') return isEn ? 'New' : '新单';
    if (stage === 'accepted') return isEn ? 'Accepted' : '已接单';
    if (stage === 'picked_up_by_driver') return L.driverPickedUp;
    if (stage === 'out_for_delivery') return isEn ? 'Out for Delivery' : '配送中';
    return stage;
  };

  const typeLabel: Record<OrderType, string> = {
    dine_in: isEn ? 'Dine-in Orders' : '堂食订单',
    takeout: isEn ? 'Takeout' : '外卖自提',
    phone: isEn ? 'Phone Orders' : '电话订单',
    delivery: isEn ? 'Delivery Orders' : '送餐订单',
  };

  const statusStyle = (status: OrderStatus): { bg: string; fg: string } => {
    if (status === 'pending') return { bg: '#fff3e0', fg: '#e65100' };
    if (status === 'paid_online') return { bg: '#e3f2fd', fg: '#1565c0' };
    if (status === 'checked_out') return { bg: '#e8f5e9', fg: '#1b5e20' };
    if (status === 'completed') return { bg: '#ede7f6', fg: '#4527a0' };
    return { bg: '#f5f5f5', fg: '#424242' };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>{L.title}</h2>
          <span
            title={queueMode === 'unified' ? '已连接统一订单接口 /api/orders/active-all' : '后端暂未提供统一订单接口，使用旧接口回退'}
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.2,
              padding: '3px 8px',
              borderRadius: 999,
              border: queueMode === 'unified' ? '1px solid #a5d6a7' : '1px solid #ffcc80',
              color: queueMode === 'unified' ? '#1b5e20' : '#8d6e63',
              background: queueMode === 'unified' ? '#e8f5e9' : '#fff8e1',
            }}
          >
            {queueMode === 'unified' ? L.unifiedMode : L.fallbackMode}
          </span>
        </div>
        <button className="btn btn-outline" onClick={() => void fetchAll()}>{loading ? L.refreshing : L.refresh}</button>
      </div>
      {loadHint ? (
        <div style={{ padding: '8px 10px', border: '1px solid #ffe0b2', borderRadius: 8, background: '#fff8e1', fontSize: 12, color: '#8d6e63' }}>
          {loadHint}
        </div>
      ) : null}

      {(Object.keys(grouped) as OrderType[]).filter((type) => canDelivery || type !== 'delivery').map((type) => (
        <section key={type} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{typeLabel[type]} ({grouped[type].length})</h3>
          {type === 'dine_in' ? (
            dineInByTable.length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: 13 }}>{L.empty}</div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 340px))',
                  gap: 8,
                  justifyContent: 'start',
                }}
              >
                {dineInByTable.map((tableGroup) => {
                  /** 仅 pending 可「按桌结账」；金额展示本桌当前列表中全部单（含已在线付）避免全 paid_online 时显示 0 */
                  const tableAllTotal = tableGroup.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0);
                  const showTableKitchenNew = dineInPayAfter && tableGroup.kitchenUnprintedPortions > 0;
                  return (
                    <div
                      key={`table-${tableGroup.tableNumber}`}
                      style={{
                        border: showTableKitchenNew ? '2px solid #F57C00' : '1px solid #eee',
                        borderRadius: 8,
                        padding: 8,
                        background: showTableKitchenNew ? '#fff8e1' : '#fafafa',
                        boxShadow: showTableKitchenNew ? '0 0 0 1px rgba(245, 124, 0, 0.2)' : undefined,
                      }}
                      title={showTableKitchenNew ? L.tableKitchenNewTitle : undefined}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>
                            {tableGroup.tableNumber === 0
                              ? L.payFirstCounterGroup
                              : `${L.tableLabel} ${tableGroup.tableNumber}`}{' '}
                            · {L.ordersOnTableLabel} {tableGroup.orders.length}
                          </div>
                          {showTableKitchenNew ? (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 800,
                                padding: '3px 9px',
                                borderRadius: 999,
                                background: '#F57C00',
                                color: '#fff',
                                letterSpacing: 0.3,
                                flexShrink: 0,
                              }}
                            >
                              {L.tableNewKitchenBadge} +{tableGroup.kitchenUnprintedPortions}
                            </span>
                          ) : null}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <span style={{ fontSize: 11, color: '#666' }} title={isEn ? 'Sum of all seats shown for this table (incl. paid online)' : '本桌当前展示订单合计（含已在线支付）'}>€{tableAllTotal.toFixed(2)}</span>
                          <button
                            type="button"
                            className="btn btn-outline"
                            style={{ fontSize: 11, padding: '4px 8px', lineHeight: 1.2 }}
                            disabled={
                              tableGroup.orders.length === 0 ||
                              busyId === `table-print-${tableGroup.tableNumber}` ||
                              busyId === `table-${tableGroup.tableNumber}`
                            }
                            title={dineInPayAfter ? L.tablePrintAllTitle : L.tablePrintAllTitlePayFirst}
                            onClick={() => void handleTablePrintAndLockAll(tableGroup)}
                          >
                            {busyId === `table-print-${tableGroup.tableNumber}` ? L.processing : L.tablePrintAll}
                          </button>
                          <button
                            className="btn btn-primary"
                            style={{ fontSize: 11, padding: '4px 8px', lineHeight: 1.2 }}
                            disabled={
                              dineInOrdersForTableCheckoutModal(tableGroup.orders, dineInPayAfter).length === 0 ||
                              busyId === `table-${tableGroup.tableNumber}` ||
                              busyId === `table-print-${tableGroup.tableNumber}`
                            }
                            onClick={() =>
                              openTableCheckoutModal(
                                tableGroup.tableNumber,
                                dineInOrdersForTableCheckoutModal(tableGroup.orders, dineInPayAfter),
                              )
                            }
                          >
                            {busyId === `table-${tableGroup.tableNumber}` ? L.processing : L.tableCheckout}
                          </button>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                        {tableGroup.orders.map((o) => {
                          const seatOnlinePaid = String(o.status || '').toLowerCase().includes('paid');
                          const seatMemberPaid = o.status === 'paid_online' && isCustomerMemberWalletPrepaid(o);
                          const paidAccent = seatMemberPaid
                            ? {
                                border: '1px solid #7E57C2',
                                bg: 'linear-gradient(180deg, #F3E5F5 0%, #FFFFFF 100%)',
                                padLeft: 10,
                                bar: '6px solid #6A1B9A',
                                shadow: '0 0 0 1px rgba(106, 27, 154, 0.2)',
                                chipBg: '#EDE7F6',
                                chipFg: '#4A148C',
                              }
                            : seatOnlinePaid
                              ? {
                                  border: '1px solid #43A047',
                                  bg: 'linear-gradient(180deg, #ECF9F0 0%, #FFFFFF 100%)',
                                  padLeft: 10,
                                  bar: '6px solid #2E7D32',
                                  shadow: '0 0 0 1px rgba(67, 160, 71, 0.18)',
                                  chipBg: '#DFF6E3',
                                  chipFg: '#1B5E20',
                                }
                              : {
                                  border: '1px solid #e8e8e8',
                                  bg: '#fff',
                                  padLeft: 7,
                                  bar: undefined as string | undefined,
                                  shadow: 'none',
                                  chipBg: '#eee',
                                  chipFg: '#333',
                                };
                          const kitchenUnprinted = dineInPayAfter ? dineInKitchenUnprintedPortions(o) : 0;
                          return (
                          <div
                            key={o._id}
                            onClick={() => setDetailModalOrder(o)}
                            title={L.clickToView}
                            style={{
                              border: paidAccent.border,
                              borderRadius: 7,
                              background: paidAccent.bg,
                              padding: 7,
                              paddingLeft: paidAccent.padLeft,
                              borderLeft: paidAccent.bar,
                              boxShadow: paidAccent.shadow,
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              minHeight: 168,
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, minHeight: 22 }}>
                              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, minWidth: 0, flex: 1 }}>
                                <span
                                  style={{
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    color: (o.seatNumber ?? 0) === 0 ? '#6d4c41' : undefined,
                                  }}
                                  title={dineInSeatLineOrGuestLabel(o, dineInRoundById, isEn)}
                                >
                                  {dineInSeatLineOrGuestLabel(o, dineInRoundById, isEn)}
                                </span>
                                <button
                                  className="btn btn-outline"
                                  style={{ fontSize: 10, padding: '1px 6px', lineHeight: 1.1 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void printOrderTicket(o);
                                  }}
                                  title={L.printReceipt}
                                >
                                  🖨
                                </button>
                              </div>
                              <span style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 10,
                                background: paidAccent.chipBg,
                                color: paidAccent.chipFg,
                                fontWeight: seatOnlinePaid ? 700 : 500,
                              }}>{o.status}</span>
                            </div>
                            {seatMemberPaid ? (
                              <div style={{
                                marginBottom: 5,
                                fontSize: 10,
                                fontWeight: 700,
                                color: '#fff',
                                background: 'linear-gradient(90deg, #6A1B9A 0%, #8E24AA 100%)',
                                borderRadius: 6,
                                padding: '2px 6px',
                                width: 'fit-content',
                              }}>
                                {L.memberPaidBadge}
                              </div>
                            ) : seatOnlinePaid ? (
                              <div style={{
                                marginBottom: 5,
                                fontSize: 10,
                                fontWeight: 700,
                                color: '#fff',
                                background: '#2E7D32',
                                borderRadius: 6,
                                padding: '2px 6px',
                                width: 'fit-content',
                              }}>
                                {L.paidOnlineBadge}
                              </div>
                            ) : null}
                            {o.type === 'dine_in' && o.dineInGuestLabel?.trim() ? (
                              <div style={{ fontSize: 10, color: '#6d4c41', marginBottom: 4, lineHeight: 1.35 }}>
                                {L.dineInGuestLabel}：{o.dineInGuestLabel.trim()}
                              </div>
                            ) : null}
                            <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>
                              {(o.items || []).length} items · €{counterPayable(o, dineInPayAfter).toFixed(2)}
                            </div>
                            {dineInPayAfter && kitchenUnprinted > 0 ? (
                              <div
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: '#E65100',
                                  marginBottom: 6,
                                  padding: '3px 6px',
                                  background: '#FFF3E0',
                                  borderRadius: 4,
                                  border: '1px solid #FFB74D',
                                  width: 'fit-content',
                                }}
                              >
                                {L.kitchenUnprinted}：{kitchenUnprinted}
                              </div>
                            ) : null}
                            <div
                              onClick={(e) => e.stopPropagation()}
                              style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto', width: '100%' }}
                            >
                              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                                {o.status === 'pending' ? (
                                  <button className="btn btn-outline" style={{ fontSize: 11, padding: '4px 8px', lineHeight: 1.2 }} disabled={busyId === o._id} onClick={() => openCheckoutModal(o)}>
                                    {L.seatCheckout}
                                  </button>
                                ) : null}
                                {o.status === 'paid_online' ? (
                                  <button
                                    className="btn btn-primary"
                                    style={{ fontSize: 11, padding: '4px 8px', lineHeight: 1.2 }}
                                    disabled={busyId === o._id}
                                    onClick={() => void completeDineInOnlinePaid(o)}
                                  >
                                    {busyId === o._id ? L.processing : L.printAndKitchenDone}
                                  </button>
                                ) : null}
                              </div>
                              {o.status === 'pending' && dineInAllowCancelPending(o) ? (
                                <button
                                  type="button"
                                  className="btn btn-outline"
                                  style={{
                                    width: '100%',
                                    fontSize: 11,
                                    padding: '6px 8px',
                                    lineHeight: 1.2,
                                    borderColor: 'var(--red-primary)',
                                    color: 'var(--red-primary)',
                                    fontWeight: 600,
                                  }}
                                  disabled={busyId === o._id}
                                  title={L.dineInCancelHint}
                                  onClick={() => void cancelPending(o._id)}
                                >
                                  {L.cancelOrder}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )})}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : grouped[type].length === 0 ? (
            <div style={{ color: 'var(--text-light)', fontSize: 13 }}>{L.empty}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
              {grouped[type].map((o) => {
                const statusLower = String(o.status || '').toLowerCase();
                const isPhoneCardPlacementPrepaid = !!(
                  o.phoneCardPaidAtPlacement &&
                  (o.type === 'phone' || o.type === 'delivery')
                );
                const isOnlinePaidFlow =
                  !isPhoneCardPlacementPrepaid &&
                  (statusLower.includes('paid') ||
                    (o.type === 'delivery' &&
                      (o.customerOnlinePaymentAt ||
                        (o.deliverySource === 'qr' &&
                          (statusLower.includes('paid') || o.status === 'checked_out')))));
                const memberWalletPaidUi =
                  isCustomerMemberWalletPrepaid(o) &&
                  (o.status === 'paid_online' || o.status === 'checked_out');
                const emphasizePaidOnline = !!(
                  isOnlinePaidFlow ||
                  memberWalletPaidUi ||
                  (isPhoneCardPlacementPrepaid && o.status === 'paid_online')
                );
                const memberPayTitle = [
                  o.memberPhoneSnapshot?.trim() || '',
                  o.memberCreditUsed != null
                    ? `€${(Number(o.memberCreditUsed) || 0).toFixed(2)}`
                    : '',
                  o.customerOnlinePaymentAt || '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                const paidBannerKind = memberWalletPaidUi
                  ? 'member'
                  : (isPhoneCardPlacementPrepaid && o.status === 'paid_online')
                    ? 'phone_card'
                    : isOnlinePaidFlow
                      ? 'online'
                      : null;
                const payLabel = paymentStatusLabel(o, isEn);
                const showLegacyStatusChip = !paidBannerKind;
                const showPaymentTrackBadge =
                  (o.dualTrackVersion === 1 || o.paymentStatus)
                  && (!paidBannerKind || payLabel === (isEn ? 'Unpaid' : '未付'));
                return (
                <div
                  key={o._id}
                  onClick={() => setDetailModalOrder(o)}
                  style={{
                    border: memberWalletPaidUi
                      ? '1px solid #7E57C2'
                      : emphasizePaidOnline
                        ? '1px solid #43A047'
                        : '1px solid #eee',
                    borderRadius: 10,
                    padding: 10,
                    paddingLeft: emphasizePaidOnline ? 14 : 10,
                    background: memberWalletPaidUi
                      ? 'linear-gradient(180deg, #F3E5F5 0%, #FDFBFF 100%)'
                      : emphasizePaidOnline
                        ? 'linear-gradient(180deg, #EAF9EE 0%, #F7FFF9 100%)'
                        : '#fafafa',
                    boxShadow: memberWalletPaidUi
                      ? '0 0 0 2px rgba(106, 27, 154, 0.18)'
                      : emphasizePaidOnline
                        ? '0 0 0 2px rgba(67, 160, 71, 0.22)'
                        : 'none',
                    borderLeft: memberWalletPaidUi
                      ? '8px solid #6A1B9A'
                      : emphasizePaidOnline
                        ? '8px solid #2E7D32'
                        : undefined,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 238,
                  }}
                  title={L.clickToView}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, minHeight: 28 }}>
                    <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{o.type === 'dine_in' ? dineInTableAndSeatOrLabelLine(o, dineInRoundById, isEn) : `#${o.dailyOrderNumber ?? '--'}`}</span>
                      <button
                        className="btn btn-outline"
                        style={{ fontSize: 11, padding: '2px 8px', lineHeight: 1.2 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void printOrderTicket(o);
                        }}
                        title={L.printReceipt}
                      >
                        🖨 {L.printReceipt}
                      </button>
                    </div>
                    {showLegacyStatusChip ? (
                    <span
                      style={{
                        fontSize: 12,
                        padding: '2px 8px',
                        borderRadius: 12,
                        background: memberWalletPaidUi
                          ? '#EDE7F6'
                          : emphasizePaidOnline
                            ? '#DFF6E3'
                            : '#eee',
                        color: memberWalletPaidUi
                          ? '#4A148C'
                          : emphasizePaidOnline
                            ? '#1B5E20'
                            : '#333',
                        fontWeight: emphasizePaidOnline ? 700 : 500,
                      }}
                    >
                      {o.status}
                    </span>
                    ) : null}
                    {o.dualTrackVersion === 1 || o.fulfillmentStatus ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 8,
                          background: '#E3F2FD',
                          color: '#1565C0',
                        }}
                        title={L.fulfillmentLine}
                      >
                        {fulfillmentStatusLabel(o, isEn)}
                      </span>
                    ) : null}
                    {showPaymentTrackBadge ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: 8,
                            background: payLabel === (isEn ? 'Unpaid' : '未付') ? '#FFF3E0' : '#E8F5E9',
                            color: payLabel === (isEn ? 'Unpaid' : '未付') ? '#E65100' : '#2E7D32',
                          }}
                          title={L.paymentLine}
                        >
                          {payLabel}
                        </span>
                    ) : null}
                    {!paidBannerKind && memberWalletPaidUi ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 8,
                          background: '#EDE7F6',
                          color: '#4A148C',
                          border: '1px solid #B39DDB',
                        }}
                        title={memberPayTitle}
                      >
                        {L.memberPaidBadge}
                      </span>
                    ) : !paidBannerKind && isPhoneCardPlacementPrepaid && o.status === 'paid_online' ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 8,
                          background: '#E3F2FD',
                          color: '#0D47A1',
                          border: '1px solid #90CAF9',
                        }}
                        title={isEn ? 'Card payment taken by phone when order was placed' : '下单时已通过电话收取刷卡款'}
                      >
                        {L.phoneCardPaidBadge}
                      </span>
                    ) : !paidBannerKind && isOnlinePaidFlow ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 8,
                          background: '#E8F5E9',
                          color: '#2E7D32',
                        }}
                        title={o.customerOnlinePaymentAt || ''}
                      >
                        {L.paidOnlineBadge}
                      </span>
                    ) : null}
                  </div>
                  {memberWalletPaidUi ? (
                    <div
                      style={{
                        marginBottom: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#fff',
                        background: 'linear-gradient(90deg, #6A1B9A 0%, #8E24AA 100%)',
                        border: '1px solid #5E35B1',
                        borderRadius: 8,
                        padding: '5px 10px',
                        letterSpacing: 0.2,
                      }}
                    >
                      {L.memberPaidBanner}
                    </div>
                  ) : isPhoneCardPlacementPrepaid && o.status === 'paid_online' ? (
                    <div
                      style={{
                        marginBottom: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#fff',
                        background: 'linear-gradient(90deg, #1565C0 0%, #1976D2 100%)',
                        border: '1px solid #0D47A1',
                        borderRadius: 8,
                        padding: '5px 10px',
                        letterSpacing: 0.2,
                      }}
                    >
                      {L.phoneCardPaidBanner}
                    </div>
                  ) : isOnlinePaidFlow ? (
                    <div
                      style={{
                        marginBottom: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#fff',
                        background: 'linear-gradient(90deg, #2E7D32 0%, #43A047 100%)',
                        border: '1px solid #2E7D32',
                        borderRadius: 8,
                        padding: '5px 10px',
                        letterSpacing: 0.2,
                      }}
                    >
                      {L.stripePaidBanner}
                    </div>
                  ) : null}
                  {o.type === 'delivery' ? (
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 6, lineHeight: 1.5, minHeight: 38 }}>
                      <div>{o.customerName} · {o.customerPhone}</div>
                      <div>
                        {L.deliverySource}：{deliverySourceLabel(o.deliverySource)} · {L.stage}：{deliveryStageLabel(o.deliveryStage)}
                      </div>
                    </div>
                  ) : null}
                  {o.type === 'phone' ? (
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 6, lineHeight: 1.5, minHeight: 38 }}>
                      {o.customerName?.trim() ? <div style={{ marginBottom: 2 }}>{o.customerName.trim()}</div> : null}
                      <div>
                        {L.guestPhone}：{o.customerPhone?.trim() || '—'}
                      </div>
                    </div>
                  ) : null}
                  {o.type === 'dine_in' ? (
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 6, lineHeight: 1.45, minHeight: 38 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>
                        {L.orderNo} {orderNoForDisplay(o)}
                      </div>
                      {o.type === 'dine_in' && o.dineInGuestLabel?.trim() ? (
                        <div style={{ color: '#6d4c41' }}>{L.dineInGuestLabel}：{o.dineInGuestLabel.trim()}</div>
                      ) : null}
                    </div>
                  ) : (o.type !== 'delivery' && o.type !== 'phone') ? (
                    <div style={{ minHeight: 38 }} />
                  ) : null}
                  {o.type === 'takeout' ? (
                    <div
                      style={{
                        marginBottom: 8,
                        padding: '6px 8px',
                        borderRadius: 8,
                        background: '#fff',
                        border: '1px solid #ececec',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ color: '#666', width: 78, flexShrink: 0 }}>菜品数量</span>
                        <span style={{ fontWeight: 700, color: '#333', marginLeft: 'auto', minWidth: 56, textAlign: 'right' }}>{o.items.length}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ color: '#666', width: 78, flexShrink: 0 }}>订单金额</span>
                        <span style={{ fontWeight: 800, color: 'var(--red-primary)', marginLeft: 'auto', minWidth: 56, textAlign: 'right' }}>€{counterPayable(o, dineInPayAfter).toFixed(2)}</span>
                      </div>
                      {o.pickupSlotLabel?.trim() ? (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingTop: 4, borderTop: '1px dashed #eee' }}>
                          <span style={{ color: '#666', width: 78, flexShrink: 0 }}>取餐</span>
                          <span style={{ fontWeight: 600, color: '#1565c0', flex: 1, textAlign: 'right' }}>{o.pickupSlotLabel.trim()}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                      {o.items.length} items · €{counterPayable(o, dineInPayAfter).toFixed(2)}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }} onClick={(e) => e.stopPropagation()}>
                    {o.type === 'delivery' ? (
                      !isOrderKitchenFullyPrinted(o) ? (
                        <div
                          style={{
                            padding: 8,
                            border: '1px solid #BBDEFB',
                            borderRadius: 8,
                            background: '#F5FAFF',
                          }}
                        >
                          <div style={{ fontSize: 11, color: '#1565C0', marginBottom: 6, fontWeight: 600 }}>{L.fulfillmentLine}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'stretch' }}>
                            <button
                              className="btn btn-primary"
                              style={{ fontSize: 12, minWidth: 198 }}
                              disabled={busyId === o._id}
                              onClick={() => void handleDeliveryKitchenRelease(o)}
                            >
                              {busyId === o._id
                                ? L.processing
                                : (!o.deliveryStage || o.deliveryStage === 'new')
                                  ? L.printAndCook
                                  : L.sendToKitchen}
                            </button>
                            {pendingOrderAllowCancel(o) ? (
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 12, color: 'var(--red-primary)', minWidth: 96, alignSelf: 'stretch' }}
                                disabled={busyId === o._id}
                                onClick={() => void cancelPending(o._id)}
                              >
                                {L.cancel}
                              </button>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>{L.deliveryKitchenBeforeDriver}</div>
                        </div>
                      ) : (
                        <div style={{ padding: 8, border: '1px solid #e6e6e6', borderRadius: 8, background: '#fff' }}>
                          <div style={{ fontSize: 11, color: '#666', marginBottom: 6, fontWeight: 600 }}>{L.deliveryStage}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {o.deliveryStage === 'accepted' ? (
                              <button
                                className="btn btn-primary"
                                style={{ fontSize: 12 }}
                                disabled={busyId === o._id}
                                onClick={() => void handleDeliveryDriverPickup(o)}
                              >
                                {L.driverPickedUp}
                              </button>
                            ) : null}
                            {o.deliveryStage === 'picked_up_by_driver' && o.status === 'pending' ? (
                              <span style={{ fontSize: 11, color: '#666', alignSelf: 'center' }}>{L.waitDriverCash}</span>
                            ) : null}
                          </div>
                        </div>
                      )
                    ) : null}

                    {o.type !== 'delivery' || (
                      (o.deliveryStage === 'picked_up_by_driver' && o.status === 'pending')
                      || (o.fulfillmentStatus === 'fulfilled' && o.paymentStatus === 'unpaid')
                    ) ? (
                      <>
                        {isCustomerQrTakeout(o) && o.status === 'pending' ? (
                          <div
                            style={{
                              padding: 8,
                              border: '1px solid #BBDEFB',
                              borderRadius: 8,
                              background: '#F5FAFF',
                              marginBottom: 8,
                            }}
                          >
                            <div style={{ fontSize: 11, color: '#1565C0', marginBottom: 6, fontWeight: 600 }}>{L.fulfillmentLine}</div>
                            {!isTakeoutKitchenReleased(o) ? (
                              <>
                                <button
                                  className="btn btn-primary"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => void handleCustomerTakeoutKitchen(o)}
                                >
                                  {busyId === o._id ? L.processing : L.sendToKitchen}
                                </button>
                                <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>{L.dualTrackIndependentHint}</div>
                              </>
                            ) : (
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#2E7D32' }}>{L.kitchenPreparing}</div>
                            )}
                          </div>
                        ) : null}
                      <div
                        style={{
                          padding: 8,
                          border: '1px solid #e6e6e6',
                          borderRadius: 8,
                          background: '#fff',
                          minHeight: o.type === 'takeout' ? 84 : undefined,
                        }}
                      >
                        <div style={{ fontSize: 11, color: '#666', marginBottom: 6, fontWeight: 600 }}>{L.paymentLine}</div>
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 6,
                            alignItems: 'stretch',
                          }}
                        >
                          {o.status === 'pending' ? (
                            <>
                              <button className="btn btn-primary" style={{ fontSize: 12, minWidth: o.type === 'takeout' ? 96 : undefined }} disabled={busyId === o._id} onClick={() => openCheckoutModal(o)}>{L.checkout}</button>
                              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red-primary)', minWidth: o.type === 'takeout' ? 96 : undefined }} disabled={busyId === o._id} onClick={() => void cancelPending(o._id)}>{L.cancel}</button>
                            </>
                          ) : null}
                          {o.type === 'phone' && o.status === 'paid_online' && (o.phoneCardPaidAtPlacement || o.placementPrepaidMethod) ? (
                            <>
                              {!isPhonePlacementKitchenStepDone(o, placementCardKitchenPrintedIds) ? (
                                <button
                                  className="btn btn-outline"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => {
                                    void printOrderTicket(o);
                                    setPlacementCardKitchenPrintedIds((prev) => ({ ...prev, [o._id]: true }));
                                  }}
                                >
                                  {L.printAndKitchenDone}
                                </button>
                              ) : (
                                <button
                                  className="btn btn-primary"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => void completePhonePlacementCardPaid(o)}
                                >
                                  {busyId === o._id ? L.processing : L.markComplete}
                                </button>
                              )}
                            </>
                          ) : null}
                          {o.type === 'takeout' && o.status === 'checked_out' ? (
                            <>
                              {!isTakeoutCheckedOutKitchenStepDone(o, takeoutKitchenTicketPrintedIds) ? (
                                <button
                                  className="btn btn-outline"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => {
                                    void printOrderTicket(o);
                                    setTakeoutKitchenTicketPrintedIds((prev) => ({ ...prev, [o._id]: true }));
                                  }}
                                >
                                  {L.printAndKitchenDone}
                                </button>
                              ) : (
                                <button
                                  className="btn btn-primary"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => void completeTakeout(o._id)}
                                >
                                  {busyId === o._id ? L.processing : L.markComplete}
                                </button>
                              )}
                            </>
                          ) : null}
                          {o.type === 'takeout' && o.status === 'paid_online' ? (
                            <>
                              {!isTakeoutKitchenPrintDone(o, takeoutKitchenTicketPrintedIds) ? (
                                <button
                                  className="btn btn-outline"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => {
                                    void printOrderTicket(o);
                                    setTakeoutKitchenTicketPrintedIds((prev) => ({ ...prev, [o._id]: true }));
                                  }}
                                >
                                  {L.printAndKitchenDone}
                                </button>
                              ) : (
                                <button
                                  className="btn btn-primary"
                                  style={{ fontSize: 12, minWidth: 198 }}
                                  disabled={busyId === o._id}
                                  onClick={() => void completeTakeoutOnlinePaid(o)}
                                >
                                  {busyId === o._id ? L.processing : L.markComplete}
                                </button>
                              )}
                            </>
                          ) : null}
                        </div>
                        {o.type === 'delivery' ? (
                          <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>{L.cashierCollectHint}</div>
                        ) : null}
                      </div>
                      </>
                    ) : null}
                  </div>
                </div>
              )})}
            </div>
          )}
        </section>
      ))}
      <div style={{ fontSize: 12, color: 'var(--text-light)' }}>{t('cashier.noOrders')}</div>
      {checkoutModalOrder || checkoutModalTable ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              width: checkoutModalTable && dineInPayAfter ? 540 : 380,
              maxWidth: '92vw',
              background: '#fff',
              borderRadius: 12,
              padding: 16,
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{L.checkoutModalTitle}</h3>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 10 }}>
              {checkoutModalOrder ? (
                `#${checkoutModalOrder.dailyOrderNumber ?? '--'} · ${L.total} €${counterPayable(checkoutModalOrder, dineInPayAfter).toFixed(2)}`
              ) : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'lines' ? (
                <div>
                  {`${L.tableLabel} ${checkoutModalTable.tableNumber} · ${L.total}（${isEn ? 'table unsettled' : '本桌未结'}）€${checkoutModalTable.orders.reduce((s, o) => s + counterPayable(o, dineInPayAfter), 0).toFixed(2)}`}
                </div>
              ) : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok ? (
                <div>{`${L.tableLabel} ${checkoutModalTable.tableNumber} · ${L.tableCheckoutThisPayment} €${tablePartialPickPreview.payable.toFixed(2)}`}</div>
              ) : (
                `${L.tableLabel} ${checkoutModalTable?.tableNumber ?? '-'} · ${L.total} €${(checkoutModalTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0).toFixed(2)}`
              )}
            </div>
            {checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'lines' ? (
              <div style={{ maxHeight: '48vh', overflowY: 'auto', marginBottom: 12, border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{L.tableCheckoutPickLines}</div>
                {checkoutModalTable.orders.map((o) => (
                  <div key={o._id} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>
                      {orderNoForDisplay(o)} · {dineInTableAndSeatOrLabelLine(o, dineInRoundById, isEn)}
                    </div>
                    {o.items.map((it) => {
                      if (it.lineKind === 'delivery_fee' || it.refunded) return null;
                      const settled = Math.max(0, Math.min(Number(it.settledQty) || 0, it.quantity));
                      const maxQ = it.quantity - settled;
                      if (maxQ <= 0) return null;
                      const lk = `${o._id}:${it._id}`;
                      const v = tablePartialQtyByLineKey[lk] ?? 0;
                      const lineChecked = v >= maxQ;
                      return (
                        <label
                          key={it._id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12,
                            marginBottom: 4,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={lineChecked}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setTablePartialQtyByLineKey((prev) => {
                                const next = { ...prev };
                                if (on) next[lk] = maxQ;
                                else delete next[lk];
                                return next;
                              });
                            }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            {it.itemName}
                            <span style={{ color: '#888' }}> · max {maxQ}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ fontSize: 11 }}
                    onClick={() => {
                      const next: Record<string, number> = {};
                      for (const o of checkoutModalTable.orders) {
                        for (const it of o.items) {
                          if (it.lineKind === 'delivery_fee' || it.refunded) continue;
                          const settled = Math.max(0, Math.min(Number(it.settledQty) || 0, it.quantity));
                          const maxQ = it.quantity - settled;
                          if (maxQ <= 0) continue;
                          next[`${o._id}:${it._id}`] = maxQ;
                        }
                      }
                      setTablePartialQtyByLineKey(next);
                    }}
                  >
                    {L.tableCheckoutSelectAllUnsettled}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ fontSize: 11 }} onClick={() => setTablePartialQtyByLineKey({})}>
                    {L.tableCheckoutClearPick}
                  </button>
                </div>
                {tablePartialPickPreview && !tablePartialPickPreview.ok && tablePartialPickPreview.message ? (
                  <div style={{ fontSize: 11, color: '#c62828', marginTop: 6 }}>{tablePartialPickPreview.message}</div>
                ) : null}
                {tablePartialPickPreview?.ok ? (
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, color: 'var(--red-primary)' }}>
                    {L.tableCheckoutThisPayment} €{tablePartialPickPreview.payable.toFixed(2)}
                  </div>
                ) : null}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setCheckoutModalOrder(null);
                      setCheckoutModalTable(null);
                      setTableCheckoutStep('pay');
                      setTablePartialQtyByLineKey({});
                    }}
                  >
                    {L.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!tablePartialPickPreview?.ok || tablePartialPickPreview.settlements.length === 0}
                    onClick={() => setTableCheckoutStep('pay')}
                  >
                    {L.tableCheckoutNextPay}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' ? (
                  <button type="button" className="btn btn-outline" style={{ fontSize: 11, marginBottom: 10 }} onClick={() => setTableCheckoutStep('lines')}>
                    {L.tableCheckoutBackLines}
                  </button>
                ) : null}
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{L.paymentMethodLabel}</div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    marginBottom: 10,
                    padding: '8px 10px',
                    border: '1px solid #eee',
                    borderRadius: 8,
                    background: '#fafafa',
                  }}
                  role="radiogroup"
                  aria-label={L.paymentMethodLabel}
                >
                  {(['cash', 'card', 'mixed', 'member'] as const)
                    .filter((m) => m !== 'member' || canMemberWallet)
                    .map((m) => (
                      <label
                        key={m}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                      >
                        <input
                          type="radio"
                          name="unifiedOrderCheckoutPayment"
                          checked={checkoutMethod === m}
                          onChange={() => {
                            setCheckoutMethod(m);
                            if (m !== 'member') setMemberPreview(null);
                          }}
                        />
                        <span>{m === 'cash' ? L.cash : m === 'card' ? L.card : m === 'mixed' ? L.mixed : L.member}</span>
                      </label>
                    ))}
                </div>
                {checkoutMethod === 'member' ? (
                  <CashierMemberCheckoutBlock
                    payAmount={
                      checkoutModalOrder
                        ? counterPayable(checkoutModalOrder, dineInPayAfter)
                        : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok
                          ? tablePartialPickPreview.payable
                          : checkoutModalTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0
                    }
                    phone={memberPhone}
                    setPhone={setMemberPhone}
                    preview={memberPreview}
                    setPreview={setMemberPreview}
                    compact
                  />
                ) : null}
                {checkoutMethod === 'mixed' ? (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    <input className="input" type="number" placeholder={L.cashAmount} value={mixedCash} onChange={(e) => setMixedCash(e.target.value)} />
                    <input className="input" type="number" placeholder={L.cardAmount} value={mixedCard} onChange={(e) => setMixedCard(e.target.value)} />
                  </div>
                ) : null}
                {checkoutMethod === 'cash' ? (
                  <div style={{ marginBottom: 10 }}>
                    <input className="input" type="number" placeholder={L.paidAmount} value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} />
                    {(Number(cashReceived) || 0) > 0 ? (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color:
                            (Number(cashReceived) || 0) >=
                            (checkoutModalOrder
                              ? counterPayable(checkoutModalOrder, dineInPayAfter)
                              : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok
                                ? tablePartialPickPreview.payable
                                : checkoutModalTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0)
                              ? '#2e7d32'
                              : '#c62828',
                        }}
                      >
                        {L.change}：€
                        {Math.max(
                          0,
                          (Number(cashReceived) || 0) -
                            (checkoutModalOrder
                              ? counterPayable(checkoutModalOrder, dineInPayAfter)
                              : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok
                                ? tablePartialPickPreview.payable
                                : checkoutModalTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0),
                        ).toFixed(2)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    className="btn btn-outline"
                    onClick={() => {
                      setCheckoutModalOrder(null);
                      setCheckoutModalTable(null);
                      setTableCheckoutStep('pay');
                      setTablePartialQtyByLineKey({});
                    }}
                  >
                    {L.cancel}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={
                      busyId === (checkoutModalOrder?._id || `table-${checkoutModalTable?.tableNumber ?? '-'}`) ||
                      (checkoutMethod === 'member' &&
                        !canMemberFullWalletPay(
                          memberPreview,
                          checkoutModalOrder
                            ? counterPayable(checkoutModalOrder, dineInPayAfter)
                            : checkoutModalTable && dineInPayAfter && tableCheckoutStep === 'pay' && tablePartialPickPreview?.ok
                              ? tablePartialPickPreview.payable
                              : checkoutModalTable?.orders.reduce((sum, o) => sum + counterPayable(o, dineInPayAfter), 0) || 0,
                        ))
                    }
                    onClick={() => void submitCheckoutModal()}
                  >
                    {busyId === (checkoutModalOrder?._id || `table-${checkoutModalTable?.tableNumber ?? '-'}`) ? L.processing : L.confirmCheckout}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {detailModalOrder ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 460, maxWidth: '94vw', background: '#fff', borderRadius: 12, padding: 16, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{L.detailsTitle}</h3>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: statusStyle(detailModalOrder.status).bg,
                  color: statusStyle(detailModalOrder.status).fg,
                }}
              >
                {detailModalOrder.status}
              </span>
            </div>

            <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, marginBottom: 10, background: '#fafafa' }}>
              <div style={{ fontSize: 14, color: '#222', fontWeight: 700, marginBottom: 4 }}>
                {L.orderNo}：{orderNoForDisplay(detailModalOrder)} · {typeLabel[detailModalOrder.type]}
              </div>
              {detailModalOrder.type === 'dine_in' && detailModalOrder.dineInOrderNumber?.trim() && detailModalOrder.dailyOrderNumber != null ? (
                <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>
                  {isEn ? 'Daily no.' : '日序'}：#{detailModalOrder.dailyOrderNumber}
                </div>
              ) : null}
              <div style={{ fontSize: 12, color: '#777' }}>
                {new Date(detailModalOrder.createdAt).toLocaleString()}
              </div>
              {detailModalOrder.status === 'paid_online' || detailModalOrder.status === 'checked_out' ? (
                isCustomerMemberWalletPrepaid(detailModalOrder) ? (
                  <div style={{ fontSize: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid #e8e8e8', color: '#4A148C', fontWeight: 600 }}>
                    {L.paymentMethodLabel}：{L.memberPaidBadge}
                    {detailModalOrder.memberPhoneSnapshot?.trim()
                      ? ` · ${detailModalOrder.memberPhoneSnapshot.trim()}`
                      : ''}
                    {detailModalOrder.memberCreditUsed != null
                      ? ` · €${(Number(detailModalOrder.memberCreditUsed) || 0).toFixed(2)}`
                      : ''}
                  </div>
                ) : detailModalOrder.customerOnlinePaymentAt || String(detailModalOrder.stripePaymentIntentId || '').trim() ? (
                  <div style={{ fontSize: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid #e8e8e8', color: '#2E7D32', fontWeight: 600 }}>
                    {L.paymentMethodLabel}：{L.paidOnlineBadge}
                    {detailModalOrder.customerOnlinePaymentAt
                      ? ` · ${new Date(detailModalOrder.customerOnlinePaymentAt).toLocaleString()}`
                      : ''}
                  </div>
                ) : null
              ) : null}
            </div>

            {detailModalOrder.type === 'dine_in' ? (
              <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>桌台信息</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {dineInTableAndSeatOrLabelLine(detailModalOrder, dineInRoundById, isEn)}
                </div>
                {detailModalOrder.type === 'dine_in' && detailModalOrder.dineInGuestLabel?.trim() ? (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>
                    {L.dineInGuestLabel}：{detailModalOrder.dineInGuestLabel.trim()}
                  </div>
                ) : null}
                {detailModalOrder.dineInStaffLockedAt ? (
                  <div style={{ fontSize: 12, color: '#c62828', marginTop: 8, fontWeight: 600 }}>{L.dineInLockedBadge}</div>
                ) : null}
                {config.dine_in_workflow_mode === 'pay_after' &&
                detailModalOrder.type === 'dine_in' &&
                dineInKitchenUnprintedPortions(detailModalOrder) > 0 ? (
                  <div style={{ fontSize: 12, color: '#E65100', marginTop: 8, fontWeight: 600 }}>
                    {L.kitchenUnprinted}：{dineInKitchenUnprintedPortions(detailModalOrder)}
                  </div>
                ) : null}
              </div>
            ) : null}
            {detailModalOrder.type === 'phone' ? (
              <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, marginBottom: 10, lineHeight: 1.6 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{isEn ? 'Phone order' : '电话订单'}</div>
                <div style={{ fontSize: 13 }}>{L.customer}: {detailModalOrder.customerName || '-'}</div>
                <div style={{ fontSize: 13 }}>{L.guestPhone}: {detailModalOrder.customerPhone || '-'}</div>
              </div>
            ) : null}
            {detailModalOrder.type === 'delivery' ? (
              <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, marginBottom: 10, lineHeight: 1.6 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>配送信息</div>
                <div style={{ fontSize: 13 }}>{L.customer}: {detailModalOrder.customerName || '-'} · {detailModalOrder.customerPhone || '-'}</div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{L.guestDeliveryAddress}</div>
                <div style={{ fontSize: 13 }}>{detailModalOrder.deliveryAddress || '-'}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 6, marginBottom: 2 }}>{L.guestDeliveryPostcode}</div>
                <div style={{ fontSize: 13 }}>{detailModalOrder.postalCode || '-'}</div>
                <div style={{ fontSize: 13 }}>{L.deliverySource}: {deliverySourceLabel(detailModalOrder.deliverySource)} · {L.stage}: {deliveryStageLabel(detailModalOrder.deliveryStage)}</div>
                {detailModalOrder.deliveryDistanceKm != null ? (
                  <div style={{ fontSize: 12, marginTop: 6, color: '#555' }}>
                    {isEn ? 'Straight-line km' : '直线距离'}: {detailModalOrder.deliveryDistanceKm} km
                  </div>
                ) : null}
                {(detailModalOrder.deliveryFeeEuro ?? 0) > 0 ? (
                  <div style={{ fontSize: 13, marginTop: 6, fontWeight: 600 }}>
                    {isEn ? 'Delivery fee' : '送餐费'}: €{Number(detailModalOrder.deliveryFeeEuro).toFixed(2)}
                  </div>
                ) : null}
                {detailModalOrder.customerOnlinePaymentAt ? (
                  <div style={{ fontSize: 12, marginTop: 8, color: '#2E7D32', fontWeight: 600 }}>
                    {isEn ? 'Paid online (customer)' : '顾客线上支付'}:{' '}
                    {new Date(detailModalOrder.customerOnlinePaymentAt).toLocaleString()}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{L.items}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, border: '1px solid #eee', borderRadius: 10, padding: 10 }}>
              {detailModalOrder.items.map((item) => (
                <div
                  key={item._id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 10,
                    fontSize: 13,
                    paddingBottom: 8,
                    borderBottom: '1px dashed #f0f0f0',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, color: '#333' }}>
                    <div style={{ fontWeight: 600 }}>
                      {item.itemName} ×{item.quantity}
                    </div>
                    <OrderItemOptionGroupList options={item.selectedOptions} isEn={isEn} compact />
                  </div>
                  <span style={{ fontWeight: 600, flexShrink: 0 }}>
                    €{((item.unitPrice + (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0)) * item.quantity).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ background: '#fff7f7', border: '1px solid #ffdfe0', borderRadius: 10, padding: 10, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#666' }}>{L.total}</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--red-primary)' }}>€{counterPayable(detailModalOrder, dineInPayAfter).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              {config.dine_in_workflow_mode === 'pay_after' &&
              detailModalOrder.type === 'dine_in' &&
              detailModalOrder.status === 'pending' &&
              counterPayable(detailModalOrder, dineInPayAfter) > 0.02 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ background: '#3949AB', border: 'none' }}
                  disabled={busyId === detailModalOrder._id}
                  onClick={() => openPartialModal(detailModalOrder)}
                >
                  {L.partialPayOpen}
                </button>
              ) : null}
              {config.dine_in_workflow_mode === 'pay_after' &&
              detailModalOrder.type === 'dine_in' &&
              detailModalOrder.status === 'pending' &&
              !detailModalOrder.dineInStaffLockedAt ? (
                <button
                  className="btn btn-primary"
                  disabled={busyId === detailModalOrder._id}
                  onClick={() => void lockDineInPayAfter(detailModalOrder)}
                >
                  {busyId === detailModalOrder._id ? L.processing : L.dineInLockOrder}
                </button>
              ) : null}
              {detailModalOrder.type === 'dine_in' && detailModalOrder.status === 'paid_online' ? (
                <button
                  className="btn btn-primary"
                  disabled={busyId === detailModalOrder._id}
                  onClick={() => void completeDineInOnlinePaid(detailModalOrder)}
                >
                  {busyId === detailModalOrder._id ? L.processing : L.printAndKitchenDone}
                </button>
              ) : null}
              {(detailModalOrder.type === 'dine_in'
                ? dineInAllowCancelPending(detailModalOrder)
                : pendingOrderAllowCancel(detailModalOrder)) ? (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{
                    borderColor: 'var(--red-primary)',
                    color: 'var(--red-primary)',
                    fontWeight: 600,
                  }}
                  disabled={busyId === detailModalOrder._id}
                  title={L.dineInCancelHint}
                  onClick={() => void cancelPending(detailModalOrder._id, () => setDetailModalOrder(null))}
                >
                  {L.cancelOrder}
                </button>
              ) : null}
              {canNotifyCustomerReady(detailModalOrder) ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ background: '#00897B', border: 'none' }}
                  disabled={busyId === detailModalOrder._id}
                  title={L.notifyCustomerReadyHint}
                  onClick={() => void notifyCustomerReady(detailModalOrder)}
                >
                  {busyId === detailModalOrder._id ? L.processing : L.notifyCustomerReady}
                </button>
              ) : null}
              <button className="btn btn-outline" onClick={() => setDetailModalOrder(null)}>{L.closeModal}</button>
            </div>
          </div>
        </div>
      ) : null}
      {partialModalOrder ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 420, maxWidth: '94vw', background: '#fff', borderRadius: 12, padding: 16, maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{L.partialPayTitle}</h3>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 12, lineHeight: 1.45 }}>{L.partialPayHint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
              {partialModalOrder.items.map((it) => {
                if (it.lineKind === 'delivery_fee' || it.refunded) return null;
                const settled = Math.max(0, Math.min(Number(it.settledQty) || 0, it.quantity));
                const maxQ = it.quantity - settled;
                if (maxQ <= 0) return null;
                const v = partialQtyByLineId[it._id] ?? 0;
                const lineChecked = v >= maxQ;
                return (
                  <label key={it._id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={lineChecked}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setPartialQtyByLineId((prev) => ({ ...prev, [it._id]: on ? maxQ : 0 }));
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>{it.itemName}</span>
                    <span style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap' }}>max {maxQ}</span>
                  </label>
                );
              })}
            </div>
            {partialPreview && partialPreview.ok ? (
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: 'var(--red-primary)' }}>
                {L.total} €{partialPreview.payable.toFixed(2)}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>—</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => { setPartialModalOrder(null); setPartialQtyByLineId({}); }}>
                {L.cancel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyId === partialModalOrder._id || !partialPreview || !partialPreview.ok}
                onClick={() => void submitPartialCash()}
              >
                {busyId === partialModalOrder._id ? L.processing : L.partialPayConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
