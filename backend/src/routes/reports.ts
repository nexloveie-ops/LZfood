import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getModels } from '../getModels';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/featureAccess';
import { createAppError } from '../middleware/errorHandler';
import { FeatureKeys } from '../utils/featureCatalog';
import { aggregateVatSalesByMonth, assertVatExportReady, checkVatExportReadiness } from '../utils/vatReportAggregation';
import { buildVatReportPdfBuffer } from '../utils/vatReportPdf';
import { checkoutCheckedOutFilterUtc, orderCreatedAtFilterUtc } from '../utils/reportDateRange';
import { deliveryFeePortionEuro } from '../utils/orderPayableTotal';
import {
  aggregateDeliveryFeeExclusions,
  computeOrderRefundAmount,
  deliveryFeeExcludedFromOrderNet,
  type ReportCheckoutLike,
} from '../utils/reportNetRevenue';
import {
  computeSegmentBreakdown,
  mapSegmentGroupsFromDoc,
  queryUtcBoundsForZonedRange,
  validateSegmentConfigPayload,
  type SegmentBreakdownResult,
} from '../utils/reportSegmentBreakdown';

const router = Router();

/** 营业报表 / 汇总 / VAT / 默认钻取：仅这些状态，且再经 statusContainsHide 过滤（防枚举外带 hide 字样的值） */
const REPORT_STATS_ORDER_STATUSES = ['checked_out', 'completed', 'refunded'] as const;

/** 订单历史页 ?includeHiddenOrders=1 时额外包含 */
const ORDER_HISTORY_EXTRA_HIDE_STATUSES = ['checked_out-hide', 'completed-hide'] as const;

function reportModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
  };
}

function requireStoreId(req: Request): mongoose.Types.ObjectId {
  if (!req.storeId) {
    throw createAppError('STORE_REQUIRED', '缺少店铺上下文（X-Store-Slug / storeSlug / DEFAULT_STORE_SLUG）');
  }
  return req.storeId;
}

/** status 含 hide（不区分大小写）的订单不计入营业报表、汇总、VAT；订单历史可 ?includeHiddenOrders=1 查看 */
function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

/** 若结账所关联的任一订单为 hide，则该结账不参与报表金额（与「隐藏单不统计」一致） */
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

// GET /api/reports/orders — 默认不含 hide（与营业报表一致）；订单历史传 includeHiddenOrders=1
router.get('/orders', authMiddleware, requirePermission('report:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { Order, Checkout } = reportModels();
    const { startDate, endDate, type, paymentMethod, source, status } = req.query;

    const includeHidden =
      req.query.includeHiddenOrders === 'true' || req.query.includeHiddenOrders === '1';
    const statusList = includeHidden
      ? [...REPORT_STATS_ORDER_STATUSES, ...ORDER_HISTORY_EXTRA_HIDE_STATUSES]
      : [...REPORT_STATS_ORDER_STATUSES];

    const filter: Record<string, unknown> = { storeId };

    if (status === 'refunded') {
      // Orders that have ANY refunded items (partial or full)
      filter.status = { $in: statusList };
      filter['items.refunded'] = true;
    } else {
      filter.status = { $in: statusList };
    }

    const createdUtc = orderCreatedAtFilterUtc(startDate as string | undefined, endDate as string | undefined);
    if (createdUtc) filter.createdAt = createdUtc;

    if (type && ['dine_in', 'takeout', 'phone', 'delivery'].includes(type as string)) {
      filter.type = type;
    }

    // Source filter: scan (table>0 & seat>0) vs cashier (table=0 or seat=0)
    if (source === 'scan') {
      filter.tableNumber = { $gt: 0 };
      filter.seatNumber = { $gt: 0 };
    } else if (source === 'cashier') {
      filter.$or = [{ tableNumber: { $in: [0, null] } }, { seatNumber: { $in: [0, null] } }];
    }

    const orders = (await Order.find(filter).sort({ createdAt: -1 }).lean()) as any[];

    // Attach checkout info to each order
    const orderIds = orders.map((o) => o._id);
    const checkouts =
      orderIds.length > 0
        ? await Checkout.find({ storeId, orderIds: { $in: orderIds } }).lean()
        : [];

    const orderCheckoutMap = new Map<string, (typeof checkouts)[0]>();
    for (const c of checkouts) {
      for (const oid of (c as { orderIds?: mongoose.Types.ObjectId[] }).orderIds || []) {
        orderCheckoutMap.set(oid.toString(), c);
      }
    }

    let result = orders.map((order: any) => {
      const checkout = orderCheckoutMap.get(order._id.toString());
      return {
        ...order,
        checkout: checkout ? {
          checkoutId: (checkout as unknown as { _id: { toString(): string } })._id.toString(),
          totalAmount: checkout.totalAmount,
          paymentMethod: checkout.paymentMethod,
          cashAmount: checkout.cashAmount,
          cardAmount: checkout.cardAmount,
          checkedOutAt: checkout.checkedOutAt,
          couponName: (checkout as unknown as { couponName?: string }).couponName,
          couponAmount: (checkout as unknown as { couponAmount?: number }).couponAmount,
        } : null,
      };
    });

    // Filter by payment method after joining with checkout.
    // Align with GET /api/reports/detailed: "现金/刷卡"汇总含混合支付中的现金、刷卡部分，明细也应列出对应订单。
    if (paymentMethod && ['cash', 'card', 'mixed', 'online', 'member'].includes(paymentMethod as string)) {
      const pm = paymentMethod as string;
      if (pm === 'cash') {
        result = result.filter((r: any) => {
          const c = r.checkout;
          if (!c) return false;
          if (c.paymentMethod === 'cash') return true;
          if (c.paymentMethod === 'mixed' && (Number(c.cashAmount) || 0) > 0) return true;
          return false;
        });
      } else if (pm === 'card') {
        result = result.filter((r: any) => {
          const c = r.checkout;
          if (!c) return false;
          if (c.paymentMethod === 'card') return true;
          if (c.paymentMethod === 'mixed' && (Number(c.cardAmount) || 0) > 0) return true;
          return false;
        });
      } else {
        result = result.filter((r: any) => r.checkout?.paymentMethod === pm);
      }
    }

    // Filter by coupon usage
    if (req.query.hasCoupon === 'true') {
      result = result.filter(
        (r: any) =>
          r.checkout &&
          (r.checkout as unknown as { couponAmount?: number }).couponAmount &&
          (r.checkout as unknown as { couponAmount: number }).couponAmount > 0,
      );
    }

    // Filter by bundle usage
    if (req.query.hasBundle === 'true') {
      result = result.filter((r: any) => {
        const bundles = (r as unknown as { appliedBundles?: unknown[] }).appliedBundles;
        return bundles && bundles.length > 0;
      });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/summary — Revenue summary (requires auth + report:view)
router.get('/summary', authMiddleware, requirePermission('report:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { Checkout, Order } = reportModels();
    const { startDate, endDate } = req.query;

    const filter: Record<string, unknown> = { storeId };

    const checkedUtc = checkoutCheckedOutFilterUtc(startDate as string | undefined, endDate as string | undefined);
    if (checkedUtc) filter.checkedOutAt = checkedUtc;

    const checkouts = (await Checkout.find(filter).lean()) as any[];
    const skipCheckoutIds = await checkoutIdsToSkipWhenLinkedOrderHidden(storeId, checkouts, Order);

    let totalRevenue = 0;
    let cashTotal = 0;
    let cardTotal = 0;
    let mixedTotal = 0;

    for (const c of checkouts) {
      if (skipCheckoutIds.has(String(c._id))) continue;
      totalRevenue += c.totalAmount;
      if (c.paymentMethod === 'cash') {
        cashTotal += c.totalAmount;
      } else if (c.paymentMethod === 'card') {
        cardTotal += c.totalAmount;
      } else if (c.paymentMethod === 'mixed') {
        mixedTotal += c.totalAmount;
      }
    }

    const counted = checkouts.filter((c) => !skipCheckoutIds.has(String(c._id)));
    res.json({
      totalRevenue,
      orderCount: counted.length,
      cashTotal,
      cardTotal,
      mixedTotal,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/detailed — Detailed stats with order breakdown and top items (requires auth + report:view)
router.get('/detailed', authMiddleware, requirePermission('report:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { Order, Checkout } = reportModels();
    const { startDate, endDate } = req.query;

    const createdUtc = orderCreatedAtFilterUtc(startDate as string | undefined, endDate as string | undefined);

    // Fetch ALL orders in date range (including refunded, excluding hidden)
    const orderFilter: Record<string, unknown> = {
      storeId,
      status: { $in: [...REPORT_STATS_ORDER_STATUSES] },
    };
    if (createdUtc) orderFilter.createdAt = createdUtc;

    const allOrdersRaw = (await Order.find(orderFilter).lean()) as any[];
    let allOrders = allOrdersRaw.filter((o) => !statusContainsHide(o.status));

    // Attach checkout info
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

    // 与 hide 单共用结账时：整笔结账不参与报表（避免漏排除 hide 金额）
    allOrders = allOrders.filter((o) => {
      const co = orderCheckoutMap.get(o._id.toString());
      if (!co) return true;
      return !skipCheckoutIds.has(String((co as { _id: { toString(): string } })._id));
    });

    // Calculate revenue from checkout amounts, then subtract refunded items
    let grossRevenue = 0;
    let cashTotal = 0;
    let cardTotal = 0;
    let mixedTotal = 0;
    let cashCount = 0;
    let cardCount = 0;
    let mixedCount = 0;
    let onlineTotal = 0;
    let onlineCount = 0;
    let memberTotal = 0;
    let memberCount = 0;
    let couponCount = 0;
    let couponTotalAmount = 0;
    let grossCashAmount = 0;
    let grossCardAmount = 0;
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
            grossCashAmount += checkout.totalAmount;
          } else if (checkout.paymentMethod === 'card') {
            cardTotal += checkout.totalAmount;
            cardCount++;
            grossCardAmount += checkout.totalAmount;
          } else if (checkout.paymentMethod === 'mixed') {
            mixedTotal += checkout.totalAmount;
            mixedCount++;
            // Also add mixed cash/card parts into cashTotal/cardTotal
            cashTotal += checkout.cashAmount || 0;
            cardTotal += checkout.cardAmount || 0;
            grossCashAmount += checkout.cashAmount || 0;
            grossCardAmount += checkout.cardAmount || 0;
          } else if (checkout.paymentMethod === 'member') {
            memberTotal += checkout.totalAmount;
            memberCount++;
          } else if (checkout.paymentMethod === 'online') {
            onlineTotal += checkout.totalAmount;
            onlineCount++;
          }
          // Count coupons
          if ((checkout as unknown as { couponAmount?: number }).couponAmount && (checkout as unknown as { couponAmount: number }).couponAmount > 0) {
            couponCount++;
            couponTotalAmount += (checkout as unknown as { couponAmount: number }).couponAmount;
          }
        }
      }
    }

    // Count bundle offers used
    let bundleOfferCount = 0;
    let bundleOfferDiscount = 0;
    const bundleOfferBreakdown: Record<string, { name: string; nameEn: string; count: number; discount: number }> = {};
    for (const order of allOrders) {
      const bundles = (order as unknown as { appliedBundles?: { offerId?: string; name: string; nameEn?: string; discount: number }[] }).appliedBundles || [];
      for (const b of bundles) {
        bundleOfferCount++;
        bundleOfferDiscount += b.discount;
        const key = b.name;
        if (!bundleOfferBreakdown[key]) bundleOfferBreakdown[key] = { name: b.name, nameEn: b.nameEn || '', count: 0, discount: 0 };
        bundleOfferBreakdown[key].count++;
        bundleOfferBreakdown[key].discount += b.discount;
      }
    }

    // Count refunded items and calculate refund amount per payment method
    let refundedCount = 0;
    let refundedAmount = 0;
    let cashRefund = 0;
    let cardRefund = 0;
    let mixedRefund = 0;
    let onlineRefund = 0;
    let memberRefund = 0;
    for (const order of allOrders) {
      const checkout = orderCheckoutMap.get(order._id.toString());
      const pm = checkout?.paymentMethod;
      const refundedItems = order.items.filter((item: { refunded?: boolean }) => (item as unknown as { refunded?: boolean }).refunded);
      if (refundedItems.length === 0) continue;

      refundedCount += refundedItems.length;
      const amt = computeOrderRefundAmount(order, toReportCheckout(checkout));

      refundedAmount += amt;
      if (pm === 'cash') cashRefund += amt;
      else if (pm === 'card') cardRefund += amt;
      else if (pm === 'mixed') {
        // Split mixed refund proportionally between cash and card
        const mixedTotal2 = checkout ? (checkout.totalAmount || 1) : 1;
        const cashRatio = checkout ? (checkout.cashAmount || 0) / mixedTotal2 : 0;
        const cardRatio = checkout ? (checkout.cardAmount || 0) / mixedTotal2 : 0;
        cashRefund += amt * cashRatio;
        cardRefund += amt * cardRatio;
        mixedRefund += amt;
      }
      else if (pm === 'online') onlineRefund += amt;
      else if (pm === 'member') memberRefund += amt;
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

    // 净营业额：结账账本 − 退款 − 送餐费（司机代收/代付，非店铺餐食销售；QR 与货到付款均剔除）
    const totalRevenue = grossRevenue - refundedAmount - deliveryFeeExcludedFromNet;

    // Order counts and revenue by type
    const activeOrders = allOrders.filter((o: any) => o.status !== 'refunded');
    let dineInCount = 0;
    let takeoutCount = 0;
    let phoneCount = 0;
    let deliveryCount = 0;
    let otherTypeCount = 0;
    let dineInScanCount = 0;
    let dineInCashierCount = 0;
    let dineInRevenue = 0;
    let takeoutRevenue = 0;
    let phoneRevenue = 0;
    let deliveryRevenue = 0;

    for (const order of activeOrders) {
      const checkout = orderCheckoutMap.get(order._id.toString());
      const orderItemTotal = order.items.reduce((s: number, i: { unitPrice: number; quantity: number }) => s + i.unitPrice * i.quantity, 0);
      if (order.type === 'dine_in') {
        dineInCount++;
        dineInRevenue += checkout?.totalAmount ?? orderItemTotal;
        if ((order.tableNumber ?? 0) > 0 && (order.seatNumber ?? 0) > 0) {
          dineInScanCount++;
        } else {
          dineInCashierCount++;
        }
      } else if (order.type === 'takeout') {
        takeoutCount++;
        takeoutRevenue += checkout?.totalAmount ?? orderItemTotal;
      } else if (order.type === 'phone') {
        phoneCount++;
        phoneRevenue += checkout?.totalAmount ?? orderItemTotal;
      } else if (order.type === 'delivery') {
        deliveryCount++;
        const co = toReportCheckout(checkout);
        const refundAmt = computeOrderRefundAmount(order, co);
        const grossOrder = co?.totalAmount ?? orderItemTotal;
        const feeExcluded = deliveryFeeExcludedFromOrderNet(order, co, refundAmt);
        deliveryRevenue += Math.max(0, grossOrder - refundAmt - feeExcluded);
      } else {
        otherTypeCount++;
      }
    }

    /** 送餐费合计（订单 delivery_fee 行或 deliveryFeeEuro；司机代收，不计店铺收入口径提示用） */
    let deliveryDriverFeeTotal = 0;
    for (const order of activeOrders) {
      if ((order as { type?: string }).type !== 'delivery') continue;
      let feeFromLines = 0;
      for (const item of (order as { items?: unknown[] }).items || []) {
        const it = item as { refunded?: boolean; lineKind?: string; unitPrice: number; quantity: number; selectedOptions?: { extraPrice?: number }[] };
        if (it.refunded) continue;
        if (it.lineKind === 'delivery_fee') {
          const optExtra = (it.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
          feeFromLines += (it.unitPrice + optExtra) * it.quantity;
        }
      }
      if (feeFromLines > 0.001) {
        deliveryDriverFeeTotal += feeFromLines;
      } else {
        deliveryDriverFeeTotal += Number((order as { deliveryFeeEuro?: number }).deliveryFeeEuro) || 0;
      }
    }
    deliveryDriverFeeTotal = Math.round(deliveryDriverFeeTotal * 100) / 100;

    // Top items aggregation (only non-refunded items)
    const itemMap = new Map<string, { itemName: string; itemNameEn: string; quantity: number; revenue: number }>();

    for (const order of allOrders) {
      for (const item of order.items) {
        if ((item as unknown as { refunded?: boolean }).refunded) continue;
        if ((item as { lineKind?: string }).lineKind === 'delivery_fee') continue;
        const key = item.itemName;
        const optExtra = ((item.selectedOptions || []) as { extraPrice?: number }[]).reduce((s, o) => s + (o.extraPrice || 0), 0);
        const existing = itemMap.get(key);
        if (existing) {
          existing.quantity += item.quantity;
          existing.revenue += (item.unitPrice + optExtra) * item.quantity;
        } else {
          itemMap.set(key, {
            itemName: item.itemName,
            itemNameEn: item.itemNameEn || '',
            quantity: item.quantity,
            revenue: (item.unitPrice + optExtra) * item.quantity,
          });
        }
      }
    }

    const topItems = Array.from(itemMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 20)
      .map(item => ({
        ...item,
        revenue: Math.round(item.revenue * 100) / 100,
      }));

    res.json({
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      grossRevenue: Math.round(grossRevenue * 100) / 100,
      deliveryFeeExcludedFromNet: Math.round(deliveryFeeExcludedFromNet * 100) / 100,
      orderCount: activeOrders.length,
      cashTotal: Math.round((cashTotal - cashRefund - deliveryFeeByPayment.cash) * 100) / 100,
      cardTotal: Math.round((cardTotal - cardRefund - deliveryFeeByPayment.card) * 100) / 100,
      mixedTotal: Math.round((mixedTotal - mixedRefund) * 100) / 100,
      cashCount,
      cardCount,
      mixedCount,
      onlineTotal: Math.round((onlineTotal - onlineRefund - deliveryFeeByPayment.online) * 100) / 100,
      onlineCount,
      memberTotal: Math.round((memberTotal - memberRefund - deliveryFeeByPayment.member) * 100) / 100,
      memberCount,
      couponCount,
      couponTotalAmount: Math.round(couponTotalAmount * 100) / 100,
      bundleOfferCount,
      bundleOfferDiscount: Math.round(bundleOfferDiscount * 100) / 100,
      grossCashAmount: Math.round(grossCashAmount * 100) / 100,
      grossCardAmount: Math.round(grossCardAmount * 100) / 100,
      dineInCount,
      dineInRevenue: Math.round(dineInRevenue * 100) / 100,
      takeoutCount,
      takeoutRevenue: Math.round(takeoutRevenue * 100) / 100,
      phoneCount,
      phoneRevenue: Math.round(phoneRevenue * 100) / 100,
      deliveryCount,
      deliveryRevenue: Math.round(deliveryRevenue * 100) / 100,
      deliveryDriverFeeTotal,
      otherTypeCount,
      dineInScanCount,
      dineInCashierCount,
      takeoutScanCount: takeoutCount,
      takeoutCashierCount: takeoutCount,
      refundedCount,
      refundedAmount: Math.round(refundedAmount * 100) / 100,
      topItems,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/vat-pdf?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD — VAT worksheet PDF (by tax categories)
router.get(
  '/vat-pdf',
  authMiddleware,
  requirePermission('report:view'),
  requireFeature(FeatureKeys.AdminReportsVatExportAction),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate || typeof startDate !== 'string' || typeof endDate !== 'string') {
      throw createAppError('VALIDATION_ERROR', 'startDate and endDate are required (YYYY-MM-DD)');
    }

    const readiness = await checkVatExportReadiness(storeId);
    assertVatExportReady(readiness);

    const { byMonth, storeInfo } = await aggregateVatSalesByMonth(storeId, startDate, endDate);
    const buf = await buildVatReportPdfBuffer(storeInfo, byMonth, `${startDate} - ${endDate}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="vat-report-${startDate}_${endDate}.pdf"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
  },
);

// GET /api/reports/item-options?itemName=xxx&startDate=xxx&endDate=xxx
// Returns paid option stats for a specific menu item
router.get('/item-options', authMiddleware, requirePermission('report:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { Order } = reportModels();
    const { itemName, startDate, endDate } = req.query;
    if (!itemName) throw createAppError('VALIDATION_ERROR', 'itemName is required');

    const filter: Record<string, unknown> = {
      storeId,
      status: { $in: [...REPORT_STATS_ORDER_STATUSES] },
      'items.itemName': itemName,
    };
    const createdUtc = orderCreatedAtFilterUtc(startDate as string | undefined, endDate as string | undefined);
    if (createdUtc) filter.createdAt = createdUtc;

    const ordersRaw = (await Order.find(filter).lean()) as any[];
    const orders = ordersRaw.filter((o) => !statusContainsHide(o.status));

    const optionStats: Record<string, { groupName: string; choiceName: string; extraPrice: number; count: number; revenue: number }> = {};
    let totalSold = 0;
    let withPaidOptions = 0;

    for (const order of orders) {
      for (const item of order.items) {
        if (item.itemName !== itemName) continue;
        if ((item as unknown as { refunded?: boolean }).refunded) continue;
        totalSold += item.quantity;
        let hasPaid = false;
        if (item.selectedOptions && item.selectedOptions.length > 0) {
          for (const opt of item.selectedOptions) {
            if (opt.extraPrice > 0) {
              hasPaid = true;
              const key = `${opt.groupName}|${opt.choiceName}|${opt.extraPrice}`;
              if (!optionStats[key]) optionStats[key] = { groupName: opt.groupName || '', choiceName: opt.choiceName || '', extraPrice: opt.extraPrice, count: 0, revenue: 0 };
              optionStats[key].count += item.quantity;
              optionStats[key].revenue += opt.extraPrice * item.quantity;
            }
          }
        }
        if (hasPaid) withPaidOptions += item.quantity;
      }
    }

    const options = Object.values(optionStats).sort((a, b) => b.revenue - a.revenue);
    const totalOptionRevenue = options.reduce((s, o) => s + o.revenue, 0);

    res.json({ itemName, totalSold, withPaidOptions, totalOptionRevenue, options });
  } catch (err) { next(err); }
});

function segmentReportModels() {
  return getModels() as {
    StoreReportSegmentConfig: mongoose.Model<any>;
    MenuCategory: mongoose.Model<any>;
    MenuItem: mongoose.Model<any>;
    Order: mongoose.Model<any>;
  };
}

async function loadSegmentConfigResponse(storeId: mongoose.Types.ObjectId) {
  const { StoreReportSegmentConfig, MenuCategory } = segmentReportModels();
  const [config, categories] = await Promise.all([
    StoreReportSegmentConfig.findOne({ storeId }).lean(),
    MenuCategory.find({ storeId }).sort({ sortOrder: 1 }).lean(),
  ]);

  const catRows = (categories as { _id: mongoose.Types.ObjectId; translations?: { locale: string; name: string }[] }[]).map((c) => ({
    _id: String(c._id),
    nameZh: c.translations?.find((t) => t.locale === 'zh-CN')?.name ?? c.translations?.[0]?.name ?? '',
    nameEn: c.translations?.find((t) => t.locale === 'en-US')?.name ?? '',
  }));

  return {
    enabled: !!(config as { enabled?: boolean } | null)?.enabled,
    groups: mapSegmentGroupsFromDoc(config as Parameters<typeof mapSegmentGroupsFromDoc>[0]),
    categories: catRows,
  };
}

async function loadEnabledSegmentConfig(storeId: mongoose.Types.ObjectId) {
  const { StoreReportSegmentConfig } = segmentReportModels();
  const doc = await StoreReportSegmentConfig.findOne({ storeId }).lean() as {
    enabled?: boolean;
    groups?: unknown[];
  } | null;
  if (!doc?.enabled) return null;
  const groups = mapSegmentGroupsFromDoc(doc as Parameters<typeof mapSegmentGroupsFromDoc>[0]);
  if (groups.length === 0) return null;
  return { doc, groups };
}

function parseYmd(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createAppError('VALIDATION_ERROR', `${field} 须为 YYYY-MM-DD`);
  }
  return value;
}

async function fetchSegmentOrders(
  storeId: mongoose.Types.ObjectId,
  from: string,
  to: string,
): Promise<unknown[]> {
  const { Order } = segmentReportModels();
  const { start, endExclusive } = queryUtcBoundsForZonedRange(from, to);
  return Order.find({
    storeId,
    status: { $in: REPORT_STATS_ORDER_STATUSES },
    createdAt: { $gte: start, $lt: endExclusive },
  }).lean();
}

async function buildSegmentBreakdownForRange(
  storeId: mongoose.Types.ObjectId,
  groups: ReturnType<typeof mapSegmentGroupsFromDoc>,
  from: string,
  to: string,
  granularity: 'day' | 'hour',
): Promise<SegmentBreakdownResult> {
  const { MenuItem } = segmentReportModels();
  const [orders, items] = await Promise.all([
    fetchSegmentOrders(storeId, from, to),
    MenuItem.find({ storeId }).select('_id categoryId').lean(),
  ]);
  const itemCat = new Map(
    (items as unknown as { _id: mongoose.Types.ObjectId; categoryId: mongoose.Types.ObjectId }[]).map((m) => [
      String(m._id),
      String(m.categoryId),
    ]),
  );
  return computeSegmentBreakdown({
    groups,
    orders: orders as Parameters<typeof computeSegmentBreakdown>[0]['orders'],
    itemCat,
    from,
    to,
    granularity,
  });
}

const segmentFeature = requireFeature(FeatureKeys.AdminReportSegmentsPage);

// GET /api/reports/segment-config — 店铺管理员读取/编辑分组配置
router.get('/segment-config', authMiddleware, requirePermission('report:view'), segmentFeature, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    res.json(await loadSegmentConfigResponse(storeId));
  } catch (err) {
    next(err);
  }
});

// PUT /api/reports/segment-config — 店铺 owner 保存分组配置
router.put('/segment-config', authMiddleware, requirePermission('menu:write'), segmentFeature, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const { StoreReportSegmentConfig, MenuCategory } = segmentReportModels();
    const categories = await MenuCategory.find({ storeId }).select('_id').lean();
    const storeCategoryIds = new Set(categories.map((c) => String((c as { _id: mongoose.Types.ObjectId })._id)));

    let normalized;
    try {
      normalized = validateSegmentConfigPayload(req.body, storeCategoryIds);
    } catch (e) {
      throw createAppError('VALIDATION_ERROR', e instanceof Error ? e.message : '配置无效');
    }

    const doc = await StoreReportSegmentConfig.findOneAndUpdate(
      { storeId },
      {
        $set: {
          enabled: normalized.enabled,
          groups: normalized.groups,
        },
        $setOnInsert: { storeId },
      },
      { upsert: true, new: true },
    ).lean() as { enabled?: boolean; groups?: unknown[] } | null;

    res.json({
      enabled: !!doc?.enabled,
      groups: mapSegmentGroupsFromDoc(doc as Parameters<typeof mapSegmentGroupsFromDoc>[0]),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/segment-breakdown
router.get('/segment-breakdown', authMiddleware, requirePermission('report:view'), segmentFeature, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = requireStoreId(req);
    const config = await loadEnabledSegmentConfig(storeId);
    if (!config) {
      throw createAppError('FORBIDDEN', '品类结构报表未开通');
    }

    const from = parseYmd(req.query.from, 'from');
    const to = parseYmd(req.query.to, 'to');
    if (from > to) {
      throw createAppError('VALIDATION_ERROR', 'from 不能晚于 to');
    }

    const granularity = req.query.granularity === 'hour' ? 'hour' : 'day';

    const primary = await buildSegmentBreakdownForRange(storeId, config.groups, from, to, granularity);

    let compare: SegmentBreakdownResult | null = null;
    const compareFrom = typeof req.query.compareFrom === 'string' ? req.query.compareFrom : '';
    const compareTo = typeof req.query.compareTo === 'string' ? req.query.compareTo : '';
    if (compareFrom && compareTo) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(compareFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(compareTo)) {
        throw createAppError('VALIDATION_ERROR', 'compareFrom/compareTo 须为 YYYY-MM-DD');
      }
      if (compareFrom > compareTo) {
        throw createAppError('VALIDATION_ERROR', 'compareFrom 不能晚于 compareTo');
      }
      compare = await buildSegmentBreakdownForRange(storeId, config.groups, compareFrom, compareTo, granularity);
    }

    res.json({ primary, compare, groups: config.groups });
  } catch (err) {
    next(err);
  }
});

export default router;
