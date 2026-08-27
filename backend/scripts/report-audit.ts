/**
 * 对账：营业报表 GET /api/reports/detailed 相关口径 vs Mongo 原始数据。
 * 用法：cd backend && npx ts-node scripts/report-audit.ts <slug> <startDate> <endDate>
 * 例：npx ts-node scripts/report-audit.ts tasteofhongkong 2026-05-01 2026-05-09
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';
import { orderCreatedAtFilterUtc } from '../src/utils/reportDateRange';
import { aggregateVatSalesByMonth, sumVatBucketTotals } from '../src/utils/vatReportAggregation';
import { bundleAdjustedLineTotals, lineGrossEuro } from '../src/utils/bundleLineAllocation';
import { aggregateDeliveryFeeExclusions } from '../src/utils/reportNetRevenue';

function itemToLineLike(
  item: {
    _id?: unknown;
    quantity: number;
    unitPrice: number;
    selectedOptions?: { extraPrice?: number }[];
    lineKind?: string;
  },
  lineIndex: number,
) {
  const raw = item._id != null ? String(item._id) : '';
  const id = raw && raw !== 'undefined' ? raw : `line-${lineIndex}`;
  return {
    _id: id,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    selectedOptions: item.selectedOptions as { extraPrice?: number }[] | undefined,
    lineKind: item.lineKind,
  };
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  const startDate = process.argv[3];
  const endDate = process.argv[4];
  if (!slug || !startDate || !endDate) {
    console.error('用法: npx ts-node scripts/report-audit.ts <storeSlug> <YYYY-MM-DD> <YYYY-MM-DD>');
    process.exit(1);
  }

  await connectDB();
  const { Store, Order, Checkout } = getModels();

  const store = await Store.findOne({ slug: slug.toLowerCase().trim() }).lean();
  if (!store || !(store as { _id: unknown })._id) {
    console.error(`未找到店铺 slug=${slug}`);
    process.exit(1);
  }
  const storeId = (store as { _id: mongoose.Types.ObjectId })._id;
  const createdUtc = orderCreatedAtFilterUtc(startDate, endDate);

  const allOrders = (await Order.find({
    storeId,
    status: { $in: ['checked_out', 'completed', 'refunded'] },
    ...(createdUtc ? { createdAt: createdUtc } : {}),
  }).lean()) as any[];

  const orderIds = allOrders.map((o) => o._id);
  const checkouts =
    orderIds.length > 0
      ? ((await Checkout.find({ storeId, orderIds: { $in: orderIds } }).lean()) as any[])
      : [];

  const orderCheckoutMap = new Map<string, any>();
  for (const c of checkouts) {
    for (const oid of (c as { orderIds?: mongoose.Types.ObjectId[] }).orderIds || []) {
      orderCheckoutMap.set(oid.toString(), c);
    }
  }

  let grossLedger = 0;
  const countedCheckoutIds = new Set<string>();
  for (const order of allOrders) {
    const checkout = orderCheckoutMap.get(order._id.toString());
    if (!checkout) continue;
    const cid = String(checkout._id);
    if (!countedCheckoutIds.has(cid)) {
      countedCheckoutIds.add(cid);
      grossLedger += Number(checkout.totalAmount) || 0;
    }
  }

  // Refunds (same logic as reports.ts simplified check)
  let refundedAmount = 0;
  for (const order of allOrders) {
    const checkout = orderCheckoutMap.get(order._id.toString());
    const refundedItems = order.items.filter((item: { refunded?: boolean }) => item.refunded);
    if (refundedItems.length === 0) continue;

    const allRefunded =
      order.items.length > 0 && order.items.every((item: { refunded?: boolean }) => item.refunded);
    let amt: number;
    if (allRefunded && checkout) {
      amt = Number(checkout.totalAmount) || 0;
    } else {
      let refundedItemsTotal = 0;
      let allItemsTotal = 0;
      for (const item of order.items) {
        const optExtra = ((item.selectedOptions || []) as { extraPrice?: number }[]).reduce(
          (s, o) => s + (o.extraPrice || 0),
          0,
        );
        const itemAmt = (item.unitPrice + optExtra) * item.quantity;
        allItemsTotal += itemAmt;
        if (item.refunded) refundedItemsTotal += itemAmt;
      }
      const bundleDisc = ((order.appliedBundles || []) as { discount: number }[]).reduce(
        (s, b) => s + b.discount,
        0,
      );
      if (allItemsTotal > 0 && bundleDisc > 0) {
        amt = refundedItemsTotal * (1 - bundleDisc / allItemsTotal);
      } else {
        amt = refundedItemsTotal;
      }
    }
    refundedAmount += amt;
  }

  const netLedger = grossLedger - refundedAmount;

  const deliveryFeeMap = new Map<string, { totalAmount: number; paymentMethod?: string; cashAmount?: number; cardAmount?: number }>();
  for (const [oid, co] of orderCheckoutMap.entries()) {
    deliveryFeeMap.set(oid, {
      totalAmount: Number(co.totalAmount) || 0,
      paymentMethod: co.paymentMethod,
      cashAmount: co.cashAmount,
      cardAmount: co.cardAmount,
    });
  }
  const { total: deliveryFeeExcluded } = aggregateDeliveryFeeExclusions(allOrders, deliveryFeeMap);
  const storeNetLedger = netLedger - deliveryFeeExcluded;

  const { byMonth } = await aggregateVatSalesByMonth(storeId, startDate, endDate);
  const vatTotal = sumVatBucketTotals(byMonth);

  // Buggy type revenue (full checkout per order — multi-order checkout duplicates)
  const activeOrders = allOrders.filter((o: any) => o.status !== 'refunded');
  let naiveTypeSum = 0;
  for (const order of activeOrders) {
    const checkout = orderCheckoutMap.get(order._id.toString());
    const orderItemTotal = order.items.reduce(
      (s: number, i: { unitPrice: number; quantity: number }) => s + i.unitPrice * i.quantity,
      0,
    );
    naiveTypeSum += checkout?.totalAmount ?? orderItemTotal;
  }

  // Multi-order checkouts in range
  const checkoutOrderCount = new Map<string, number>();
  for (const order of activeOrders) {
    const co = orderCheckoutMap.get(order._id.toString());
    if (!co) continue;
    const cid = String(co._id);
    checkoutOrderCount.set(cid, (checkoutOrderCount.get(cid) || 0) + 1);
  }
  const multiOrderCheckouts = [...checkoutOrderCount.entries()].filter(([, n]) => n > 1);

  let ordersWithMissingLineId = 0;
  let ordersWithDupLineId = 0;
  const orderOidList = allOrders.map((o) => o._id);
  const vatCheckouts =
    orderOidList.length > 0
      ? ((await Checkout.find({ storeId, orderIds: { $in: orderOidList } }).lean()) as any[])
      : [];

  const extremeScales: { checkoutId: string; scale: number; grandSum: number; total: number }[] = [];
  for (const order of allOrders) {
    const ids = (order.items || []).map((it: { _id?: unknown }) => String(it?._id ?? ''));
    if (ids.some((id: string) => id === '' || id === 'undefined')) ordersWithMissingLineId++;
    const uniq = new Set(ids.filter(Boolean));
    if (uniq.size !== ids.filter(Boolean).length) ordersWithDupLineId++;
  }

  const allOrderIdsFromCk = [
    ...new Set(
      vatCheckouts.flatMap((c: any) =>
        (c.orderIds || []).map((id: mongoose.Types.ObjectId) => id.toString()),
      ),
    ),
  ].filter((id) => mongoose.isValidObjectId(id));

  const allOrdersForCk =
    allOrderIdsFromCk.length > 0
      ? ((await Order.find({
          storeId,
          _id: { $in: allOrderIdsFromCk.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()) as any[])
      : [];
  const orderByIdCk = new Map(allOrdersForCk.map((o) => [String(o._id), o]));

  for (const c of vatCheckouts) {
    const ordersFull = (c.orderIds || [])
      .map((oid: mongoose.Types.ObjectId) => orderByIdCk.get(oid.toString()))
      .filter(Boolean) as any[];
    let grandSum = 0;
    for (const order of ordersFull) {
      const items = order.items.map((it: Parameters<typeof itemToLineLike>[0], idx: number) => itemToLineLike(it, idx));
      const m = bundleAdjustedLineTotals(items, order.appliedBundles);
      for (const v of m.values()) grandSum += v;
    }
    const total = Number(c.totalAmount) || 0;
    const scale = grandSum > 0 ? total / grandSum : 0;
    if (scale > 1.5 || scale < 0.67) {
      extremeScales.push({ checkoutId: String(c._id), scale, grandSum, total });
    }
  }
  extremeScales.sort((a, b) => b.scale - a.scale);

  console.log('--- 营业报表对账 ---');
  console.log(`店铺: ${slug}  storeId=${storeId}`);
  console.log(`区间(UTC 订单 createdAt): ${startDate} .. ${endDate}`);
  console.log(`订单数(含退款态): ${allOrders.length}  非 refunded 状态订单数: ${activeOrders.length}`);
  console.log(`去重结账笔数: ${countedCheckoutIds.size}`);
  console.log('');
  console.log(`账本 gross（每结账 totalAmount 计一次）: ${grossLedger.toFixed(2)}`);
  console.log(`退款估算 refundedAmount: ${refundedAmount.toFixed(2)}`);
  console.log(`账本 net（gross - refund）: ${netLedger.toFixed(2)}`);
  console.log(`剔除送餐费 deliveryFeeExcluded: ${deliveryFeeExcluded.toFixed(2)}`);
  console.log(`店铺净营业额（gross - refund - 送餐费）: ${storeNetLedger.toFixed(2)}`);
  console.log('');
  console.log(`VAT 桶合计（vat-pdf 用，不含 delivery_fee 行）: ${vatTotal.toFixed(2)}`);
  console.log(`店铺净营业额 与 VAT 桶差: ${(storeNetLedger - vatTotal).toFixed(2)}`);
  console.log('');
  console.log(
    `按类型汇总（当前 API：每笔订单加整单 checkout.totalAmount — 多订单结账会重复）: ${naiveTypeSum.toFixed(2)}`,
  );
  console.log(`与 VAT total 差（类型卡片之和 vs 净营业额）: ${(naiveTypeSum - vatTotal).toFixed(2)}`);
  console.log('');
  console.log(`一单多订单结账（区间内）: ${multiOrderCheckouts.length} 笔`);
  if (multiOrderCheckouts.length > 0 && multiOrderCheckouts.length <= 15) {
    for (const [cid, n] of multiOrderCheckouts) {
      console.log(`  checkout ${cid} 关联订单数=${n}`);
    }
  }
  console.log('');
  console.log('--- VAT scale 诊断（与 aggregateVatSalesByMonth 同源 grandSum）---');
  console.log(`区间内订单含缺失行 _id 的订单数: ${ordersWithMissingLineId}`);
  console.log(`区间内订单含重复行 _id 的订单数: ${ordersWithDupLineId}`);
  console.log(`scale 偏离 >±33% 的结账笔数: ${extremeScales.length}（共 ${vatCheckouts.length} 笔结账）`);
  for (const row of extremeScales.slice(0, 12)) {
    console.log(
      `  checkout=${row.checkoutId} total=${row.total.toFixed(2)} grandSum=${row.grandSum.toFixed(2)} scale=${row.scale.toFixed(4)}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
