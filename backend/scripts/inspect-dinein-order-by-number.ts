/**
 * 按堂食单号 dineInOrderNumber（如 232212 = HHmmss）查询订单，用于排查订单中心展示原因。
 *
 * 用法: npx ts-node scripts/inspect-dinein-order-by-number.ts [dineInOrderNumber]
 * 默认: 232212
 */
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/db';
import { getModels } from '../src/getModels';
import { computeDineInUnsettledPayableEuro, dineInHasUnsettledFoodLineQty } from '../src/utils/orderPayableTotal';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main(): Promise<void> {
  const num = (process.argv[2] || '232212').trim();
  await connectDB();
  const { Order, Checkout } = getModels();
  const rows = await Order.find({ type: 'dine_in', dineInOrderNumber: num })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  if (rows.length === 0) {
    console.log(`未找到 type=dine_in 且 dineInOrderNumber=${JSON.stringify(num)} 的订单（全库最多查 20 条，无则真的没有）。`);
    await mongoose.disconnect();
    return;
  }

  console.log(`命中 ${rows.length} 条（按 createdAt 倒序，最多 20 条）\n`);

  for (const raw of rows) {
    const o = raw as Record<string, unknown>;
    const unsettled = computeDineInUnsettledPayableEuro(o as Parameters<typeof computeDineInUnsettledPayableEuro>[0]);
    const qtyLeft = dineInHasUnsettledFoodLineQty(o as Parameters<typeof dineInHasUnsettledFoodLineQty>[0]);
    const items = (Array.isArray(o.items) ? o.items : []) as Record<string, unknown>[];
    const summary = {
      _id: String(o._id),
      storeId: String(o.storeId),
      dineInOrderNumber: o.dineInOrderNumber,
      tableNumber: o.tableNumber,
      seatNumber: o.seatNumber,
      status: o.status,
      dineInExposedToStaff: o.dineInExposedToStaff,
      dineInGuestLabel: o.dineInGuestLabel,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      items: items.map((it) => ({
        lineKind: it.lineKind,
        menuItemId: it.menuItemId != null ? String(it.menuItemId) : undefined,
        quantity: it.quantity,
        settledQty: it.settledQty,
        unitPrice: it.unitPrice,
        itemName: it.itemName,
        kitchenPrintedQty: it.kitchenPrintedQty,
        selectedOptions: it.selectedOptions,
      })),
      appliedBundles: o.appliedBundles,
      computedUnsettledEuro: unsettled,
      hasUnsettledFoodLineQty: qtyLeft,
    };
    console.log(JSON.stringify(summary, null, 2));
    const oid = new mongoose.Types.ObjectId(String(o._id));
    const checkouts = await Checkout.find({ storeId: o.storeId, orderIds: oid })
      .sort({ checkedOutAt: -1, createdAt: -1 })
      .limit(5)
      .lean()
      .select({ totalAmount: 1, paymentMethod: 1, type: 1, checkedOutAt: 1, createdAt: 1, dineInPartialLineSettlements: 1 });
    console.log(
      'recent checkouts (max 5):',
      checkouts.length ? JSON.stringify(checkouts, null, 2) : 'none',
    );
    console.log('---');
  }

  await new Promise((r) => setTimeout(r, 800));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
