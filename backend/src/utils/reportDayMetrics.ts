import mongoose from 'mongoose';
import { getModels } from '../getModels';
import {
  aggregateDeliveryFeeExclusions,
  computeOrderRefundAmount,
  type ReportCheckoutLike,
} from './reportNetRevenue';
import { queryUtcBoundsForZonedRange } from './reportSegmentBreakdown';

const REPORT_STATS_ORDER_STATUSES = ['checked_out', 'completed', 'refunded'] as const;

function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

async function checkoutIdsToSkipWhenLinkedOrderHidden(
  storeId: mongoose.Types.ObjectId,
  checkouts: { _id: unknown; orderIds?: mongoose.Types.ObjectId[] }[],
  Order: mongoose.Model<any>,
): Promise<Set<string>> {
  const skip = new Set<string>();
  if (checkouts.length === 0) return skip;
  const oidStrs = [
    ...new Set(checkouts.flatMap((c) => (c.orderIds || []).map((id) => id.toString()))),
  ].filter((id) => mongoose.isValidObjectId(id));
  if (oidStrs.length === 0) return skip;
  const rows = (await Order.find({
    storeId,
    _id: { $in: oidStrs.map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select('_id status')
    .lean()) as { _id: mongoose.Types.ObjectId; status?: string }[];
  const stById = new Map(rows.map((r) => [r._id.toString(), r.status]));
  for (const c of checkouts) {
    const anyHide = (c.orderIds || []).some((oid) => statusContainsHide(stById.get(oid.toString())));
    if (anyHide) skip.add(String(c._id));
  }
  return skip;
}

function toReportCheckout(co: unknown): ReportCheckoutLike | undefined {
  if (!co || typeof co !== 'object') return undefined;
  const c = co as {
    totalAmount?: unknown;
    paymentMethod?: string;
    cashAmount?: number;
    cardAmount?: number;
  };
  if (c.totalAmount == null) return undefined;
  return {
    totalAmount: Number(c.totalAmount) || 0,
    paymentMethod: c.paymentMethod,
    cashAmount: c.cashAmount,
    cardAmount: c.cardAmount,
  };
}

export type StoreDayReportMetrics = {
  totalRevenue: number;
  orderCount: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  cashOrderCount: number;
  cardOrderCount: number;
  onlineOrderCount: number;
};

/**
 * 单日营业指标（与 GET /api/reports/detailed 口径一致）。
 * `dateYmd` 按指定时区的日历日解释（与品类结构报表相同）。
 */
export async function computeStoreDayReportMetrics(
  storeId: mongoose.Types.ObjectId,
  dateYmd: string,
): Promise<StoreDayReportMetrics> {
  const { Order, Checkout } = getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
  };

  const { start, endExclusive } = queryUtcBoundsForZonedRange(dateYmd, dateYmd);

  const orderFilter: Record<string, unknown> = {
    storeId,
    status: { $in: [...REPORT_STATS_ORDER_STATUSES] },
    createdAt: { $gte: start, $lt: endExclusive },
  };

  const allOrdersRaw = (await Order.find(orderFilter).lean()) as any[];
  let allOrders = allOrdersRaw.filter((o) => !statusContainsHide(o.status));

  const orderIds = allOrders.map((o) => o._id);
  const checkouts =
    orderIds.length > 0
      ? await Checkout.find({ storeId, orderIds: { $in: orderIds } }).lean()
      : [];
  const skipCheckoutIds = await checkoutIdsToSkipWhenLinkedOrderHidden(storeId, checkouts, Order);
  const orderCheckoutMap = new Map<string, (typeof checkouts)[0]>();
  for (const c of checkouts) {
    for (const oid of (c as { orderIds?: mongoose.Types.ObjectId[] }).orderIds || []) {
      orderCheckoutMap.set(oid.toString(), c);
    }
  }

  allOrders = allOrders.filter((o) => {
    const co = orderCheckoutMap.get(o._id.toString());
    if (!co) return true;
    return !skipCheckoutIds.has(String((co as { _id: { toString(): string } })._id));
  });

  let grossRevenue = 0;
  let cashTotal = 0;
  let cardTotal = 0;
  let onlineTotal = 0;
  let cashCount = 0;
  let cardCount = 0;
  let mixedCount = 0;
  let onlineCount = 0;
  const countedCheckoutIds = new Set<string>();

  for (const order of allOrders) {
    const checkout = orderCheckoutMap.get(order._id.toString());
    if (checkout) {
      const cid = (checkout as unknown as { _id: { toString(): string } })._id.toString();
      if (!countedCheckoutIds.has(cid)) {
        countedCheckoutIds.add(cid);
        grossRevenue += checkout.totalAmount;
        if (checkout.paymentMethod === 'cash') {
          cashTotal += checkout.totalAmount;
          cashCount++;
        } else if (checkout.paymentMethod === 'card') {
          cardTotal += checkout.totalAmount;
          cardCount++;
        } else if (checkout.paymentMethod === 'mixed') {
          mixedCount++;
          cashTotal += checkout.cashAmount || 0;
          cardTotal += checkout.cardAmount || 0;
        } else if (checkout.paymentMethod === 'online') {
          onlineTotal += checkout.totalAmount;
          onlineCount++;
        }
      }
    }
  }

  let refundedAmount = 0;
  let cashRefund = 0;
  let cardRefund = 0;
  let onlineRefund = 0;
  for (const order of allOrders) {
    const checkout = orderCheckoutMap.get(order._id.toString());
    const pm = checkout?.paymentMethod;
    const refundedItems = order.items.filter((item: { refunded?: boolean }) => item.refunded);
    if (refundedItems.length === 0) continue;

    const amt = computeOrderRefundAmount(order, toReportCheckout(checkout));
    refundedAmount += amt;
    if (pm === 'cash') cashRefund += amt;
    else if (pm === 'card') cardRefund += amt;
    else if (pm === 'mixed') {
      const mixedTotal2 = checkout ? (checkout.totalAmount || 1) : 1;
      const cashRatio = checkout ? (checkout.cashAmount || 0) / mixedTotal2 : 0;
      const cardRatio = checkout ? (checkout.cardAmount || 0) / mixedTotal2 : 0;
      cashRefund += amt * cashRatio;
      cardRefund += amt * cardRatio;
    } else if (pm === 'online') onlineRefund += amt;
  }

  const deliveryFeeCheckoutMap = new Map<string, ReportCheckoutLike>();
  for (const [oid, co] of orderCheckoutMap.entries()) {
    deliveryFeeCheckoutMap.set(oid, {
      totalAmount: Number(co.totalAmount) || 0,
      paymentMethod: co.paymentMethod,
      cashAmount: co.cashAmount,
      cardAmount: co.cardAmount,
    });
  }
  const { total: deliveryFeeExcludedFromNet, byPayment: deliveryFeeByPayment } =
    aggregateDeliveryFeeExclusions(allOrders, deliveryFeeCheckoutMap);

  const totalRevenue = grossRevenue - refundedAmount - deliveryFeeExcludedFromNet;
  const activeOrders = allOrders.filter((o: { status?: string }) => o.status !== 'refunded');

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    orderCount: activeOrders.length,
    cashTotal: Math.round((cashTotal - cashRefund - deliveryFeeByPayment.cash) * 100) / 100,
    cardTotal: Math.round((cardTotal - cardRefund - deliveryFeeByPayment.card) * 100) / 100,
    onlineTotal: Math.round((onlineTotal - onlineRefund - deliveryFeeByPayment.online) * 100) / 100,
    cashOrderCount: cashCount + mixedCount,
    cardOrderCount: cardCount + mixedCount,
    onlineOrderCount: onlineCount,
  };
}
