import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isWaiterMode } from '../../utils/waiterMode';
import { useTranslation } from 'react-i18next';
import { connectStoreSocket } from '../../api/storeSocket';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../api/client';
import { printBuiltReceipt, type BundleDiscountInfo } from '../../components/cashier/ReceiptPrint';
import { type ReceiptOptionSnapshot } from '../../utils/receiptOptionPrice';
import { resolveReceiptPaymentMethodFromOrder } from '../../utils/receiptPaymentMethod';
import CashierMemberCheckoutBlock, {
  buildMemberFullWalletCheckoutBody,
  canMemberFullWalletPay,
  type CashierMemberPreview,
} from '../../components/cashier/CashierMemberCheckoutBlock';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import {
  dineInPayable,
  guestTitle,
  groupItemsByRound,
  hasGuestIdentity,
  hasGuestQrAdd,
  isOpenDineIn,
  kitchenUnprintedQty,
  unprintedFoodLineIds,
  type PayAfterOrder,
  type PayAfterOrderItem,
} from '../../utils/payAfterBoard';
import WeighMarketDialog from '../../components/cashier/WeighMarketDialog';
import { formatMarketLineTitle, isUnweighedMarketLine } from '../../utils/marketPriceDisplay';
import { applyStaffZheToAmount, staffZheCouponPayload } from '../../utils/staffZheDiscount';
import CashierStaffZheDiscountField from '../../components/cashier/CashierStaffZheDiscountField';
import CashierServiceChargeWaiveField from '../../components/cashier/CashierServiceChargeWaiveField';
import {
  computeServiceChargeEuro,
  parseServiceChargePercent,
  parseServiceChargeWaived,
  payableWithServiceCharge,
} from '../../utils/dineInServiceCharge';

type FulfillTab = 'takeout' | 'delivery';
type PayMethod = 'cash' | 'card' | 'member';

function mapOpts(opts: PayAfterOrderItem['selectedOptions']): ReceiptOptionSnapshot[] {
  return (opts || []).map((opt) => ({
    groupName: String(opt.groupName ?? '').trim(),
    groupNameEn: String(opt.groupNameEn ?? '').trim(),
    choiceName: String(opt.choiceName ?? '').trim(),
    choiceNameEn: String(opt.choiceNameEn ?? '').trim(),
    extraPrice: opt.extraPrice || 0,
  }));
}

function mapItem(item: PayAfterOrderItem, qty: number) {
  return {
    _id: item._id,
    menuItemId: item.menuItemId,
    lineKind: item.lineKind,
    quantity: qty,
    unitPrice: item.unitPrice,
    itemName: item.itemName,
    itemNameEn: item.itemNameEn,
    roundIndex: item.roundIndex,
    placedBy: item.placedBy,
    isMarketPrice: item.isMarketPrice,
    weightKg: item.weightKg,
    pricePerKg: item.pricePerKg,
    selectedOptions: mapOpts(item.selectedOptions),
  };
}

function lineTotal(item: PayAfterOrderItem, qty = item.quantity): number {
  const extra = (item.selectedOptions || []).reduce((s, o) => s + (o.extraPrice || 0), 0);
  return (item.unitPrice + extra) * qty;
}

function foodLineIds(items: PayAfterOrderItem[], round?: number): string[] {
  return (items || [])
    .filter((it) => {
      if (it.lineKind === 'delivery_fee' || it.refunded) return false;
      if (round == null) return true;
      return Math.max(1, Math.floor(Number(it.roundIndex) || 1)) === round;
    })
    .map((it) => it._id);
}

const DISHES_PER_COL = 5;

type TableDishColumn = {
  key: string;
  order: PayAfterOrder;
  coverIdx: number;
  round: number;
  items: PayAfterOrderItem[];
  startIdx: number;
  showCoverHead: boolean;
};

function buildTableDishColumns(orders: PayAfterOrder[]): TableDishColumn[] {
  const cols: TableDishColumn[] = [];
  orders.forEach((order, coverIdx) => {
    const rounds = groupItemsByRound(order.items);
    if (rounds.length === 0) {
      cols.push({
        key: `${order._id}-empty`,
        order,
        coverIdx,
        round: 1,
        items: [],
        startIdx: 0,
        showCoverHead: true,
      });
      return;
    }
    rounds.forEach((rd, roundIdx) => {
      if (rd.items.length === 0) return;
      for (let i = 0; i < rd.items.length; i += DISHES_PER_COL) {
        cols.push({
          key: `${order._id}-r${rd.round}-c${i}`,
          order,
          coverIdx,
          round: rd.round,
          items: rd.items.slice(i, i + DISHES_PER_COL),
          startIdx: i,
          showCoverHead: roundIdx === 0 && i === 0,
        });
      }
    });
  });
  return cols;
}

function dishOptionSummary(it: PayAfterOrderItem): string {
  return (it.selectedOptions || [])
    .map((o) => String(o.choiceName || o.choiceNameEn || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function PayAfterDishCard({
  it,
  lineIdx,
  isEn,
  weighLabel,
  onWeigh,
  onVoid,
}: {
  it: PayAfterOrderItem;
  lineIdx: number;
  isEn: boolean;
  weighLabel: string;
  onWeigh: () => void;
  onVoid: () => void;
}) {
  const opts = dishOptionSummary(it);
  return (
    <div className={`pay-after-line pay-after-dish${it.refunded ? ' is-void' : ''}`}>
      <div className="pay-after-line-main">
        <span className="pay-after-line-name">
          {it.isMarketPrice ? formatMarketLineTitle(it.itemName, it.weightKg, it.pricePerKg) : `${it.quantity}× ${it.itemName}`}
          {it.isMarketPrice && isUnweighedMarketLine(it) ? <em className="is-warn"> · {isEn ? 'await weigh' : '待称重'}</em> : null}
          {it.placedBy === 'customer_qr' ? <em> · {isEn ? 'guest' : '客人'}</em> : null}
          {(Number(it.kitchenPrintedQty) || 0) > 0 ? <em> · {isEn ? 'in kitchen' : '厨房中'}</em> : null}
          {opts ? <span className="pay-after-dish-opts">{opts}</span> : null}
        </span>
        <span className="pay-after-line-price">€{lineTotal(it).toFixed(2)}</span>
      </div>
      <div className="pay-after-dish-foot">
        {!it.refunded ? (
          <div className="pay-after-line-actions">
            {it.isMarketPrice ? (
              <button type="button" className="btn btn-outline" onClick={onWeigh}>
                {weighLabel}
              </button>
            ) : null}
            <button type="button" className="btn btn-outline pay-after-btn-danger" onClick={onVoid}>
              {isEn ? 'Void' : '退菜'}
            </button>
          </div>
        ) : null}
        <span className="pay-after-line-seq">{lineIdx + 1}</span>
      </div>
    </div>
  );
}

function fulfillStatusLabel(status: string, isEn: boolean): string {
  const map: Record<string, [string, string]> = {
    pending: ['待结', 'Unpaid'],
    paid_online: ['已线上付', 'Paid online'],
    checked_out: ['已结账', 'Checked out'],
    preparing: ['制作中', 'Preparing'],
    ready: ['可取餐', 'Ready'],
    completed: ['完成', 'Done'],
  };
  const hit = map[status];
  if (hit) return isEn ? hit[1] : hit[0];
  return status.replace(/_/g, ' ');
}

export default function PayAfterOrderCenter() {
  const { t, i18n } = useTranslation();
  const isEn = Boolean(i18n.language?.startsWith('en'));
  const { token, user, hasFeature } = useAuth();
  const waiterMode = isWaiterMode();
  const canDelivery = hasFeature('cashier.delivery.page');
  const canMemberWallet = hasFeature('cashier.member.wallet');
  const { config } = useRestaurantConfig();
  const [orders, setOrders] = useState<PayAfterOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fulfillTab, setFulfillTab] = useState<FulfillTab>('takeout');
  const [selectedTable, setSelectedTable] = useState<number | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<{ kind: 'table' | 'order'; tableNumber: number; orderId?: string } | null>(null);
  const [payMethod, setPayMethod] = useState<PayMethod>('cash');
  const [cashReceived, setCashReceived] = useState('');
  const [memberPhone, setMemberPhone] = useState('');
  const [memberPreview, setMemberPreview] = useState<CashierMemberPreview | null>(null);
  const [discountZhe, setDiscountZhe] = useState('');
  const [weighTarget, setWeighTarget] = useState<{ orderId: string; item: PayAfterOrderItem } | null>(null);
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/orders/active-all', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setOrders(await res.json());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const socket = connectStoreSocket(user?.storeId ? { storeId: user.storeId } : {});
    const bump = () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchDebounceRef.current = null;
        void fetchAll();
      }, 400);
    };
    socket.on('order:new', bump);
    socket.on('order:updated', bump);
    socket.on('order:checked-out', bump);
    socket.on('order:cancelled', bump);
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      socket.disconnect();
    };
  }, [fetchAll, user?.storeId]);

  const dineInOpen = useMemo(() => orders.filter(isOpenDineIn), [orders]);
  const tables = useMemo(() => {
    const map = new Map<number, PayAfterOrder[]>();
    for (const o of dineInOpen) {
      const tno = typeof o.tableNumber === 'number' ? o.tableNumber : 0;
      if (!map.has(tno)) map.set(tno, []);
      map.get(tno)!.push(o);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tableNumber, list]) => ({
        tableNumber,
        orders: list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
        unpaid: list.reduce((s, o) => s + dineInPayable(o), 0),
        kitchenPending: list.reduce((s, o) => s + kitchenUnprintedQty(o), 0),
        guestAdd: list.some(hasGuestQrAdd),
      }));
  }, [dineInOpen]);

  const takeoutOrders = useMemo(
    () => orders.filter((o) => o.type === 'takeout' || o.type === 'phone'),
    [orders],
  );
  const deliveryOrders = useMemo(
    () => (canDelivery ? orders.filter((o) => o.type === 'delivery') : []),
    [orders, canDelivery],
  );

  const selected = tables.find((t) => t.tableNumber === selectedTable) || tables[0] || null;
  useEffect(() => {
    if (selectedTable == null && tables[0]) setSelectedTable(tables[0].tableNumber);
  }, [selectedTable, tables]);

  const printKitchenLocal = useCallback(async (order: PayAfterOrder, lineIds: string[]) => {
    const idSet = new Set(lineIds);
    const receiptItems: ReturnType<typeof mapItem>[] = [];
    const increments: { lineId: string; qty: number }[] = [];
    for (const item of order.items) {
      if (!idSet.has(item._id) || item.lineKind === 'delivery_fee' || item.refunded) continue;
      const printed = Math.max(0, Math.min(Number(item.kitchenPrintedQty) || 0, item.quantity));
      const unprinted = item.quantity - printed;
      if (unprinted <= 0) continue;
      receiptItems.push(mapItem(item, unprinted));
      increments.push({ lineId: item._id, qty: unprinted });
    }
    if (receiptItems.length === 0) {
      alert(isEn ? 'No kitchen items to print.' : '没有可打印的菜品。');
      return;
    }
    const total = receiptItems.reduce((s, it) => s + lineTotal(it as PayAfterOrderItem, it.quantity), 0);
    await printBuiltReceipt({
      checkoutId: order._id,
      type: 'seat' as const,
      totalAmount: total,
      paymentMethod: 'pending' as const,
      checkedOutAt: new Date().toISOString(),
      tableNumber: order.tableNumber,
      orders: [{
        _id: order._id,
        type: order.type,
        seatNumber: order.seatNumber,
        dailyOrderNumber: order.dailyOrderNumber,
        dineInOrderNumber: order.dineInOrderNumber,
        dineInGuestLabel: order.dineInGuestLabel,
        status: order.status,
        items: receiptItems,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryAddress: order.deliveryAddress,
        postalCode: order.postalCode,
        deliveryFeeEuro: order.deliveryFeeEuro,
      }],
    }, config, { copies: 1 });
    if (increments.length > 0) {
      const mark = await apiFetch(`/api/orders/${order._id}/kitchen-printed-increment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ increments }),
      });
      if (!mark.ok) {
        const err = (await mark.json().catch(() => ({}))) as { error?: { message?: string } };
        alert(err?.error?.message || (isEn ? 'Printed but failed to save kitchen state.' : '已打印，但未能保存厨房出单。'));
      }
    }
  }, [config, isEn, token]);

  const printKitchenTableLocal = useCallback(async (orders: PayAfterOrder[]) => {
    const receiptOrders = orders
      .map((order) => {
        const items = (order.items || [])
          .filter((it) => it.lineKind !== 'delivery_fee' && !it.refunded)
          .map((it) => mapItem(it, it.quantity));
        return {
          _id: order._id,
          type: order.type,
          seatNumber: order.seatNumber,
          dailyOrderNumber: order.dailyOrderNumber,
          dineInGuestLabel: order.dineInGuestLabel,
          status: order.status,
          items,
        };
      })
      .filter((o) => o.items.length > 0);
    if (receiptOrders.length === 0) {
      alert(isEn ? 'No kitchen items to print.' : '没有可打印的菜品。');
      return;
    }
    const total = orders.reduce((sum, order) => (
      sum + (order.items || []).reduce((s, it) => (
        it.lineKind === 'delivery_fee' || it.refunded ? s : s + lineTotal(it)
      ), 0)
    ), 0);
    await printBuiltReceipt({
      checkoutId: `table-whole-${orders[0]?.tableNumber ?? 0}`,
      type: 'seat' as const,
      totalAmount: total,
      paymentMethod: 'pending' as const,
      checkedOutAt: new Date().toISOString(),
      tableNumber: orders[0]?.tableNumber,
      wholeTableKitchenTicket: true,
      orders: receiptOrders,
    }, config, { copies: 1 });
    for (const order of orders) {
      if (foodLineIds(order.items).length === 0) continue;
      const mark = await apiFetch(`/api/orders/${order._id}/kitchen-printed-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!mark.ok) {
        const err = (await mark.json().catch(() => ({}))) as { error?: { message?: string } };
        alert(err?.error?.message || (isEn ? 'Printed but failed to save kitchen state.' : '已打印，但未能保存厨房出单。'));
      }
    }
  }, [config, isEn, token]);

  const printKitchenTable = useCallback(async (tableNumber: number, orders: PayAfterOrder[]) => {
    if (orders.every((o) => foodLineIds(o.items).length === 0)) {
      alert(isEn ? 'No kitchen items to print.' : '没有可打印的菜品。');
      return;
    }
    setBusyId(`table-k-${tableNumber}`);
    try {
      await printKitchenTableLocal(orders);
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, printKitchenTableLocal, t]);

  const printKitchenCloud = useCallback(async (order: PayAfterOrder, lineIds: string[], roundIndex?: number, append?: boolean) => {
    if (lineIds.length === 0) {
      alert(isEn ? 'No kitchen items to print.' : '没有可打印的菜品。');
      return;
    }
    const res = await apiFetch(`/api/orders/${order._id}/kitchen-cloud-print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        lineIds,
        ...(roundIndex != null ? { roundIndex } : {}),
        ...(append ? { append: true } : {}),
      }),
    });
    const d = await res.json().catch(() => null) as { kitchenPrint?: string; error?: { message?: string } } | null;
    if (res.ok && d?.kitchenPrint === 'cloud') return;
    if (!res.ok && d?.error?.message) {
      /* still try local so the kitchen can cook */
    }
    await printKitchenLocal(order, lineIds);
  }, [isEn, printKitchenLocal, token]);

  const runKitchenPrint = useCallback(async (busyKey: string, jobs: Array<{ order: PayAfterOrder; lineIds: string[]; roundIndex?: number; append?: boolean }>) => {
    if (jobs.length === 0) {
      alert(isEn ? 'No kitchen items to print.' : '没有可打印的菜品。');
      return;
    }
    setBusyId(busyKey);
    try {
      for (const job of jobs) {
        await printKitchenCloud(job.order, job.lineIds, job.roundIndex, job.append);
      }
      await fetchAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, printKitchenCloud, t]);

  const printTakeoutDeliveryKitchen = useCallback(async (order: PayAfterOrder) => {
    const items = order.items.filter((it) => it.lineKind !== 'delivery_fee' && !it.refunded).map((it) => mapItem(it, it.quantity));
    const total = items.reduce((s, it) => s + lineTotal(it as PayAfterOrderItem, it.quantity), 0);
    const bundles: BundleDiscountInfo[] | undefined = (order.appliedBundles?.length ?? 0) > 0
      ? order.appliedBundles!.map((b) => ({ name: b.name || '', nameEn: b.nameEn || '', discount: b.discount }))
      : undefined;
    const pm = resolveReceiptPaymentMethodFromOrder(order);
    await printBuiltReceipt({
      checkoutId: order._id,
      type: 'seat',
      totalAmount: total,
      paymentMethod: pm,
      checkedOutAt: new Date().toISOString(),
      orders: [{
        _id: order._id,
        type: order.type,
        dailyOrderNumber: order.dailyOrderNumber,
        status: order.status,
        items,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryAddress: order.deliveryAddress,
        postalCode: order.postalCode,
        deliveryFeeEuro: order.deliveryFeeEuro,
      }],
    }, config, { bundleDiscounts: bundles, copies: 1 });
    await apiFetch(`/api/orders/${order._id}/kitchen-printed-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetchAll();
  }, [config, fetchAll, token]);

  const cancelOrder = useCallback(async (order: PayAfterOrder) => {
    if (!confirm(isEn ? 'Cancel this order?' : '确认取消该订单？')) return;
    setBusyId(order._id);
    try {
      const res = await apiFetch(`/api/orders/${order._id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const d = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        alert(d?.error?.message || (isEn ? 'Cancel failed' : '取消失败'));
        return;
      }
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, token]);

  const voidLine = useCallback(async (order: PayAfterOrder, lineId: string) => {
    if (!confirm(isEn ? 'Void this dish?' : '确认退这道菜？')) return;
    setBusyId(order._id);
    try {
      const res = await apiFetch(`/api/orders/${order._id}/void-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lineIds: [lineId] }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        alert(d?.error?.message || (isEn ? 'Void failed' : '退菜失败'));
        return;
      }
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, token]);

  const weighLine = useCallback(async (orderId: string, lineId: string, weightKg: number, pricePerKg: number) => {
    const res = await apiFetch(`/api/orders/${orderId}/weigh-line`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lineId, weightKg, pricePerKg }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(d?.error?.message || (isEn ? 'Weigh failed' : '称重失败'));
    }
    await fetchAll();
  }, [fetchAll, isEn, token]);

  const checkoutSubtotal = useMemo(() => {
    if (!checkoutTarget) return 0;
    if (checkoutTarget.kind === 'order') {
      const o = orders.find((x) => x._id === checkoutTarget.orderId);
      return o ? dineInPayable(o) : 0;
    }
    return dineInOpen.filter((o) => (o.tableNumber ?? 0) === checkoutTarget.tableNumber).reduce((s, o) => s + dineInPayable(o), 0);
  }, [checkoutTarget, dineInOpen, orders]);

  const checkoutZhe = applyStaffZheToAmount(checkoutSubtotal, discountZhe);
  const serviceChargePercent = parseServiceChargePercent(config.dine_in_service_charge_percent);
  const serviceChargeAmount = computeServiceChargeEuro(checkoutSubtotal, serviceChargePercent);
  const serviceChargeWaived = parseServiceChargeWaived(config.dine_in_service_charge_waived);
  const foodAfterZhe = checkoutZhe.status === 'ok' ? checkoutZhe.payableEuro : checkoutSubtotal;
  const checkoutPayable = payableWithServiceCharge(foodAfterZhe, serviceChargeAmount, serviceChargeWaived);

  useEffect(() => {
    setDiscountZhe('');
  }, [checkoutTarget]);

  const cashNum = parseFloat(cashReceived) || 0;
  const changeAmt = payMethod === 'cash' ? Math.max(0, cashNum - checkoutPayable) : 0;

  const submitCheckout = useCallback(async () => {
    if (!checkoutTarget) return;
    if (checkoutZhe.status === 'invalid') return;
    if (payMethod === 'cash' && cashNum + 0.001 < checkoutPayable) return;
    if (payMethod === 'member' && !canMemberFullWalletPay(memberPreview, checkoutPayable)) return;
    const busyKey = checkoutTarget.orderId || `table-${checkoutTarget.tableNumber}`;
    setBusyId(busyKey);
    try {
      const body: Record<string, unknown> = payMethod === 'member' && memberPreview
        ? buildMemberFullWalletCheckoutBody(checkoutPayable, memberPhone)
        : { paymentMethod: payMethod };
      if (payMethod === 'cash') {
        body.cashAmount = checkoutPayable;
        body.cashReceived = cashNum;
        body.changeAmount = changeAmt;
      }
      if (payMethod === 'card') body.cardAmount = checkoutPayable;
      if (checkoutZhe.status === 'ok') {
        const coupon = staffZheCouponPayload(checkoutZhe);
        body.couponName = coupon.name;
        body.couponAmount = coupon.amount;
      }
      body.skipCloudPrint = true;
      const url = checkoutTarget.kind === 'order' && checkoutTarget.orderId
        ? `/api/checkout/seat/${checkoutTarget.orderId}`
        : `/api/checkout/table/${checkoutTarget.tableNumber}`;
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        alert(d?.error?.message || (isEn ? 'Checkout failed' : '结账失败'));
        return;
      }
      const data = await res.json() as { _id?: string };
      if (data?._id) {
        const receiptRes = await apiFetch(`/api/checkout/receipt/${data._id}`);
        if (receiptRes.ok) {
          const receipt = await receiptRes.json();
          await printBuiltReceipt(receipt, config, {
            cashReceived: payMethod === 'cash' ? cashNum : undefined,
            changeAmount: payMethod === 'cash' ? changeAmt : undefined,
          });
        }
      }
      setCheckoutTarget(null);
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [cashNum, changeAmt, checkoutPayable, checkoutTarget, checkoutZhe, config, fetchAll, isEn, memberPhone, memberPreview, payMethod, token]);

  const finishTakeout = useCallback(async (order: PayAfterOrder) => {
    setBusyId(order._id);
    try {
      if (order.status === 'paid_online' && order.type === 'takeout') {
        await apiFetch(`/api/orders/takeout/${order._id}/complete-online-paid`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
      } else if (order.type === 'takeout') {
        await apiFetch(`/api/orders/takeout/${order._id}/complete`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, token]);

  const setDeliveryPickedUp = useCallback(async (order: PayAfterOrder) => {
    if (kitchenUnprintedQty(order) > 0) {
      alert(isEn ? 'Send to kitchen first.' : '请先送厨房制作。');
      return;
    }
    setBusyId(order._id);
    try {
      await apiFetch(`/api/orders/${order._id}/delivery-stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deliveryStage: 'picked_up_by_driver' }),
      });
      await fetchAll();
    } finally {
      setBusyId(null);
    }
  }, [fetchAll, isEn, token]);

  const fulfillList = fulfillTab === 'delivery' ? deliveryOrders : takeoutOrders;

  return (
    <div className="pay-after-board">
      <div className="pay-after-board-head">
        <div>
          <h1>{isEn ? 'Running tab' : '跑单工作台'}</h1>
          <p className="pay-after-board-sub">
            {isEn
              ? `${tables.length} open table${tables.length === 1 ? '' : 's'} · kitchen first, then weigh, then pay`
              : `${tables.length} 桌未结 · 先出厨，称重后再结账`}
          </p>
        </div>
        <button type="button" className="btn btn-outline pay-after-refresh" onClick={() => void fetchAll()} disabled={loading}>
          {loading ? (isEn ? 'Refreshing…' : '刷新中…') : (isEn ? 'Refresh' : '刷新')}
        </button>
      </div>

      <section className="pay-after-dine">
        {tables.length === 0 ? (
          <div className="pay-after-empty" style={{ gridColumn: '1 / -1' }}>{isEn ? 'No open tables' : '暂无未结桌'}</div>
        ) : (
          <>
        <div className="pay-after-dine-tables">
          {tables.map((tbl) => (
            <button
              key={tbl.tableNumber}
              type="button"
              className={`pay-after-table-chip${selected?.tableNumber === tbl.tableNumber ? ' is-active' : ''}`}
              onClick={() => setSelectedTable(tbl.tableNumber)}
            >
              <span className="pay-after-table-chip-top">
                <span className="pay-after-table-no">{tbl.tableNumber === 0 ? (isEn ? 'No table' : '无桌号') : `${isEn ? 'Table' : '桌'} ${tbl.tableNumber}`}</span>
                <span className="pay-after-table-meta">€{tbl.unpaid.toFixed(2)}</span>
              </span>
              <span>
                {tbl.kitchenPending > 0 ? <span className="pay-after-badge warn">{isEn ? 'Kitchen' : '待出厨'} {tbl.kitchenPending}</span> : null}
                {tbl.guestAdd ? <span className="pay-after-badge guest">{isEn ? 'Guest add' : '客人加菜'}</span> : null}
              </span>
            </button>
          ))}
        </div>

        {selected ? (
          <div className="pay-after-table-detail">
            <div className="pay-after-table-detail-bar">
              <h3>{selected.tableNumber === 0 ? (isEn ? 'Walk-in' : '无桌号') : (isEn ? `Table ${selected.tableNumber}` : `桌 ${selected.tableNumber}`)}</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={busyId != null || selected.orders.every((o) => foodLineIds(o.items).length === 0)}
                  onClick={() => void printKitchenTable(selected.tableNumber, selected.orders)}
                >
                  {isEn ? 'Print table' : '整桌打印'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId != null || selected.unpaid <= 0.02 || selected.orders.some((o) => o.items.some(isUnweighedMarketLine))}
                  onClick={() => {
                    if (selected.orders.some((o) => o.items.some(isUnweighedMarketLine))) {
                      alert(t('cashier.unweighedCannotCheckout'));
                      return;
                    }
                    if (waiterMode) {
                      alert(isEn ? 'Take payment on the cashier POS.' : '请在收银台结账。');
                      return;
                    }
                    setPayMethod('cash');
                    setCashReceived('');
                    setMemberPhone('');
                    setMemberPreview(null);
                    setCheckoutTarget({ kind: 'table', tableNumber: selected.tableNumber });
                  }}
                >
                  {isEn ? 'Checkout table' : '整桌结账'} €{selected.unpaid.toFixed(2)}
                </button>
              </div>
            </div>
            <div className="pay-after-cover-block">
              {selected.orders.map((o) => {
                const addOnlyIds = unprintedFoodLineIds(o.items);
                const printIds = hasGuestQrAdd(o) || addOnlyIds.length < foodLineIds(o.items).length
                  ? addOnlyIds
                  : foodLineIds(o.items);
                const printAppend = hasGuestQrAdd(o) || addOnlyIds.length < foodLineIds(o.items).length;
                return (
                  <div key={o._id} className="pay-after-cover-toolbar">
                    <div className="pay-after-cover-head">
                      {hasGuestIdentity(o) ? <strong>{guestTitle(o, isEn)}</strong> : null}
                      {kitchenUnprintedQty(o) > 0 ? <span className="pay-after-badge warn">{isEn ? 'Awaiting kitchen' : '待出厨房'}</span> : null}
                      <span className="pay-after-cover-amt">€{dineInPayable(o).toFixed(2)}</span>
                      {hasGuestQrAdd(o) ? <span className="pay-after-badge guest">{isEn ? 'Guest add' : '客人加菜'}</span> : null}
                    </div>
                    <div className="pay-after-cover-actions">
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={busyId != null || printIds.length === 0}
                        onClick={() => void runKitchenPrint(o._id, [{ order: o, lineIds: printIds, append: printAppend }])}
                      >
                        {isEn ? 'Print order' : '打印整单'}
                      </button>
                      <button type="button" className="btn btn-outline pay-after-btn-quiet" disabled={busyId === o._id} onClick={() => void cancelOrder(o)}>
                        {isEn ? 'Cancel order' : '整单取消'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busyId != null || dineInPayable(o) <= 0.02 || o.items.some(isUnweighedMarketLine)}
                        onClick={() => {
                          if (o.items.some(isUnweighedMarketLine)) {
                            alert(t('cashier.unweighedCannotCheckout'));
                            return;
                          }
                          if (waiterMode) {
                            alert(isEn ? 'Take payment on the cashier POS.' : '请在收银台结账。');
                            return;
                          }
                          setPayMethod('cash');
                          setCashReceived('');
                          setMemberPhone('');
                          setMemberPreview(null);
                          setCheckoutTarget({ kind: 'order', tableNumber: selected.tableNumber, orderId: o._id });
                        }}
                      >
                        {isEn ? 'Checkout round' : '结账'}
                      </button>
                    </div>
                  </div>
                );
              })}
              {(() => {
                const cols = buildTableDishColumns(selected.orders);
                const bands: TableDishColumn[][] = [];
                for (let i = 0; i < cols.length; i += 5) bands.push(cols.slice(i, i + 5));
                return bands.map((band, bandIdx) => (
                  <div
                    key={band.map((c) => c.key).join('|')}
                    className="pay-after-dish-grid is-columns"
                    style={{ ['--pay-after-cols' as string]: Math.min(5, Math.max(1, band.length)) }}
                  >
                    {band.map((col, colIdx) => {
                      const prev = colIdx > 0 ? band[colIdx - 1] : (bandIdx > 0 ? bands[bandIdx - 1][bands[bandIdx - 1].length - 1] : undefined);
                      const newRound = !!prev && (prev.order._id !== col.order._id || prev.round !== col.round);
                      const pad = Math.max(0, DISHES_PER_COL - col.items.length);
                      return (
                        <div
                          key={col.key}
                          className={`pay-after-round-col${newRound ? ' is-new-round' : ''}`}
                        >
                          {col.items.map((it, lineIdx) => (
                            <PayAfterDishCard
                              key={it._id}
                              it={it}
                              lineIdx={col.startIdx + lineIdx}
                              isEn={isEn}
                              weighLabel={t('cashier.weigh')}
                              onWeigh={() => setWeighTarget({ orderId: col.order._id, item: it })}
                              onVoid={() => void voidLine(col.order, it._id)}
                            />
                          ))}
                          {Array.from({ length: pad }, (_, i) => (
                            <div key={`${col.key}-pad-${i}`} className="pay-after-dish-pad" aria-hidden />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          </div>
        ) : (
          <div className="pay-after-table-detail">
            <div className="pay-after-empty">{isEn ? 'Select a table' : '请选择桌台'}</div>
          </div>
        )}
          </>
        )}
      </section>

      <section className="pay-after-fulfill">
        <div className="pay-after-fulfill-head">
          <h2>{isEn ? 'Collection' : '外卖 / 送餐'}</h2>
          <div className="pay-after-fulfill-tabs">
            <button type="button" className={fulfillTab === 'takeout' ? 'is-active' : ''} onClick={() => setFulfillTab('takeout')}>
              {isEn ? 'Takeout' : '外卖自提'} ({takeoutOrders.length})
            </button>
            {canDelivery ? (
              <button type="button" className={fulfillTab === 'delivery' ? 'is-active' : ''} onClick={() => setFulfillTab('delivery')}>
                {isEn ? 'Delivery' : '送餐'} ({deliveryOrders.length})
              </button>
            ) : null}
          </div>
        </div>
        {fulfillList.length === 0 ? (
          <div className="pay-after-empty">{isEn ? 'No orders' : '暂无'}</div>
        ) : (
          <div className="pay-after-fulfill-grid">
            {fulfillList.map((o) => {
              const pendingKitchen = kitchenUnprintedQty(o) > 0;
              return (
                <div key={o._id} className="pay-after-fulfill-card">
                  <div className="pay-after-cover-head">
                    <strong>#{o.dailyOrderNumber ?? '—'} {o.type === 'phone' ? (isEn ? 'Phone' : '电话') : o.type === 'delivery' ? (isEn ? 'Delivery' : '送餐') : (isEn ? 'Pickup' : '自提')}</strong>
                    <span className="pay-after-badge neutral">{fulfillStatusLabel(o.status, isEn)}</span>
                  </div>
                  <p className="pay-after-fulfill-meta">
                    {o.customerPhone || o.customerName || o.pickupSlotLabel || '—'}
                  </p>
                  {pendingKitchen ? <span className="pay-after-badge warn">{isEn ? 'Awaiting kitchen' : '待出厨房'}</span> : null}
                  <div className="pay-after-cover-actions">
                    {pendingKitchen ? (
                      <button type="button" className="btn btn-primary" disabled={busyId === o._id} onClick={() => void printTakeoutDeliveryKitchen(o)}>
                        {isEn ? 'Print kitchen' : '出厨房'}
                      </button>
                    ) : null}
                    {o.type === 'takeout' && (o.status === 'paid_online' || o.status === 'checked_out') && !pendingKitchen ? (
                      <button type="button" className="btn btn-primary" disabled={busyId === o._id} onClick={() => void finishTakeout(o)}>
                        {isEn ? 'Picked up' : '客人取餐完成'}
                      </button>
                    ) : null}
                    {o.type === 'delivery' && !pendingKitchen ? (
                      <button type="button" className="btn btn-primary" disabled={busyId === o._id} onClick={() => void setDeliveryPickedUp(o)}>
                        {isEn ? 'Driver picked up' : '司机取走'}
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-outline pay-after-btn-quiet" disabled={busyId === o._id} onClick={() => void cancelOrder(o)}>
                      {t('common.cancel', isEn ? 'Cancel' : '取消')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {checkoutTarget ? (
        <div className="pay-after-modal-backdrop" onClick={() => setCheckoutTarget(null)}>
          <div className="pay-after-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{checkoutTarget.kind === 'table' ? (isEn ? 'Checkout table' : '整桌结账') : (isEn ? 'Checkout this round' : '结账当前轮次')}</h3>
            <div className="pay-after-modal-amt">
              {checkoutZhe.status === 'ok' ? <div className="pay-after-modal-amt-was">€{checkoutSubtotal.toFixed(2)}</div> : null}
              €{checkoutPayable.toFixed(2)}
            </div>
            <CashierStaffZheDiscountField
              value={discountZhe}
              onChange={setDiscountZhe}
              applied={checkoutZhe}
              isEn={isEn}
            />
            <CashierServiceChargeWaiveField
              percent={serviceChargePercent}
              amount={serviceChargeAmount}
              waived={serviceChargeWaived}
              isEn={isEn}
            />
            <div className="pay-after-pay-methods">
              {(['cash', 'card'] as const).map((m) => (
                <button key={m} type="button" className={`btn ${payMethod === m ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPayMethod(m)}>
                  {m === 'cash' ? (isEn ? 'Cash' : '现金') : (isEn ? 'Card' : '刷卡')}
                </button>
              ))}
              {canMemberWallet ? (
                <button type="button" className={`btn ${payMethod === 'member' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPayMethod('member')}>
                  {isEn ? 'Member' : '会员'}
                </button>
              ) : null}
            </div>
            {payMethod === 'cash' ? (
              <label style={{ display: 'block', marginBottom: 12, fontSize: 13, fontWeight: 600, color: '#475569' }}>
                {isEn ? 'Cash received' : '实收'}
                <input className="input" type="number" min={0} step="0.01" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} style={{ display: 'block', marginTop: 6 }} />
                {changeAmt > 0 ? <span style={{ fontWeight: 600, color: '#0369a1' }}>{isEn ? 'Change' : '找零'} €{changeAmt.toFixed(2)}</span> : null}
              </label>
            ) : null}
            {canMemberWallet && payMethod === 'member' ? (
              <CashierMemberCheckoutBlock
                payAmount={checkoutPayable}
                phone={memberPhone}
                setPhone={setMemberPhone}
                preview={memberPreview}
                setPreview={setMemberPreview}
                compact
              />
            ) : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-outline" onClick={() => setCheckoutTarget(null)}>{isEn ? 'Back' : '返回'}</button>
              <button type="button" className="btn btn-primary" disabled={busyId != null || checkoutZhe.status === 'invalid'} onClick={() => void submitCheckout()}>
                {isEn ? 'Confirm' : '确认结账'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <WeighMarketDialog
        open={!!weighTarget}
        title={weighTarget?.item.itemName || t('cashier.weigh')}
        menuItemId={weighTarget?.item.menuItemId}
        initialKg={weighTarget?.item.weightKg}
        initialPricePerKg={weighTarget?.item.pricePerKg}
        busy={busyId === 'weigh'}
        onClose={() => setWeighTarget(null)}
        onSave={async (kg, rate) => {
          if (!weighTarget) return;
          setBusyId('weigh');
          try {
            await weighLine(weighTarget.orderId, weighTarget.item._id, kg, rate);
            setWeighTarget(null);
          } catch (e) {
            alert(e instanceof Error ? e.message : t('common.error'));
          } finally {
            setBusyId(null);
          }
        }}
      />
    </div>
  );
}
